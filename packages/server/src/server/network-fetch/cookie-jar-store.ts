import { isWithinTarget } from "./allowlist.js";
import { applyCookieBatch, selectCookieHeader } from "./cookie-jar.js";
import {
  assertCookieTime,
  assertHostCookie,
  cookieDomainMatches,
  cookieSourceUrl,
  CookieJarError,
  HOST_COOKIE_LIMITS,
  HOST_COOKIE_PROFILE,
  type CookiePolicyPorts,
  type HostCookie,
  type ParsedCookieCandidate,
} from "./cookie-policy.js";
import type { NetworkFetchDestinationRecord } from "./network-fetch-state-store.js";

export interface CookieJarPartition {
  authority: NetworkFetchDestinationRecord;
  generation: string;
  clearedEpoch: string | null;
  cookies: HostCookie[];
}

export interface CookieJarSnapshot {
  version: 1;
  profile: typeof HOST_COOKIE_PROFILE;
  serverId: string;
  revision: string;
  timeFloor: number;
  partitions: CookieJarPartition[];
}

export interface CookieJarCommitPort {
  currentRevision(): string;
  commit(expectedRevision: string, nextSnapshot: CookieJarSnapshot): void;
}

export interface CookieJarLease {
  readonly principalId: string;
  readonly serverId: string;
  readonly destinationId: string;
  readonly authorityEpoch: NetworkFetchDestinationRecord["authorityEpoch"];
  readonly url: string;
}

export type CookieJarClearRequest = Omit<CookieJarLease, "url">;

function assertCounter(value: string): void {
  if (!/^(0|[1-9]\d{0,127})$/.test(value)) throw new CookieJarError("invalid_cookie_state");
}

function increment(value: string): string {
  assertCounter(value);
  const next = (BigInt(value) + 1n).toString();
  assertCounter(next);
  return next;
}

function cloneSnapshot(snapshot: CookieJarSnapshot): CookieJarSnapshot {
  return {
    ...snapshot,
    partitions: snapshot.partitions.map((partition) => ({
      ...partition,
      authority: { ...partition.authority },
      cookies: partition.cookies.map((cookie) => ({ ...cookie })),
    })),
  };
}

function assertPartitionAuthority(partition: CookieJarPartition): void {
  const { authority, cookies } = partition;
  assertCounter(authority.authorityEpoch);
  assertCounter(partition.generation);
  const origin = cookieSourceUrl(authority.origin);
  if (
    !authority.principalId ||
    !authority.destinationId ||
    origin.origin !== authority.origin ||
    !authority.pathPrefix.startsWith("/") ||
    authority.authorityEpoch === "0" ||
    (authority.cleanupRequiredEpoch !== null &&
      authority.cleanupRequiredEpoch !== authority.authorityEpoch) ||
    (authority.cleanupRequiredEpoch !== null && cookies.length > 0) ||
    (authority.state !== "active" && authority.cleanupRequiredEpoch === null) ||
    (partition.clearedEpoch !== null && partition.clearedEpoch !== authority.authorityEpoch)
  ) {
    throw new CookieJarError("invalid_cookie_state");
  }
  if (
    authority.cleanupRequestBaseEpoch !== null &&
    (authority.cleanupRequiredEpoch === null ||
      increment(authority.cleanupRequestBaseEpoch) !== authority.authorityEpoch)
  ) {
    throw new CookieJarError("invalid_cookie_state");
  }
}

function assertPartition(partition: CookieJarPartition, policy: CookiePolicyPorts): void {
  assertPartitionAuthority(partition);
  const { authority, cookies } = partition;
  const origin = cookieSourceUrl(authority.origin);
  const seen = new Set<string>();
  const hostname = origin.hostname.replace(/^\[|\]$/g, "");
  for (const cookie of cookies) {
    assertHostCookie(cookie);
    const key = JSON.stringify([cookie.name, cookie.domain, cookie.path]);
    if (
      seen.has(key) ||
      !cookieDomainMatches(hostname, cookie.domain) ||
      (!cookie.hostOnly && policy.isPublicSuffix(cookie.domain) !== false) ||
      (cookie.hostOnly && cookie.domain !== hostname) ||
      origin.protocol !== "https:"
    ) {
      throw new CookieJarError("invalid_cookie_state");
    }
    seen.add(key);
  }
}

function assertSnapshot(snapshot: CookieJarSnapshot, policy: CookiePolicyPorts): void {
  if (snapshot.version !== 1 || snapshot.profile !== HOST_COOKIE_PROFILE || !snapshot.serverId) {
    throw new CookieJarError("invalid_cookie_state");
  }
  assertCounter(snapshot.revision);
  assertCookieTime(snapshot.timeFloor);
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  let total = 0;
  let bytes = 0;
  for (const partition of snapshot.partitions) {
    assertPartition(partition, policy);
    const { destinationId, principalId } = partition.authority;
    if (seen.has(destinationId)) throw new CookieJarError("invalid_cookie_state");
    seen.add(destinationId);
    const count = (counts.get(principalId) ?? 0) + partition.cookies.length;
    counts.set(principalId, count);
    total += partition.cookies.length;
    bytes += Buffer.byteLength(JSON.stringify(partition.cookies));
    if (
      partition.cookies.length > HOST_COOKIE_LIMITS.destinationCookies ||
      count > HOST_COOKIE_LIMITS.principalCookies
    ) {
      throw new CookieJarError("cookie_jar_limit");
    }
  }
  if (
    snapshot.partitions.length > 10000 ||
    total > HOST_COOKIE_LIMITS.daemonCookies ||
    bytes > HOST_COOKIE_LIMITS.jarBytes ||
    Buffer.byteLength(JSON.stringify(snapshot)) > HOST_COOKIE_LIMITS.snapshotBytes
  ) {
    throw new CookieJarError("cookie_jar_limit");
  }
}

export function createCookieJarSnapshot(
  serverId: string,
  authorities: readonly NetworkFetchDestinationRecord[],
  now: number,
): CookieJarSnapshot {
  const snapshot: CookieJarSnapshot = {
    version: 1,
    profile: HOST_COOKIE_PROFILE,
    serverId,
    revision: "0",
    timeFloor: now,
    partitions: authorities.map((authority) => ({
      authority: { ...authority },
      generation: "0",
      clearedEpoch: null,
      cookies: [],
    })),
  };
  assertSnapshot(snapshot, { isPublicSuffix: () => null });
  return snapshot;
}

export class CookieJarStore {
  private state: CookieJarSnapshot;
  private available = true;
  private writing = false;
  private observedTime: number;
  private readonly leases = new Map<
    CookieJarLease,
    { isActive(): boolean; credentialsAllowed: boolean }
  >();

  constructor(
    snapshot: CookieJarSnapshot,
    private readonly storage: CookieJarCommitPort,
    private readonly policy: CookiePolicyPorts,
    private readonly now: () => number,
  ) {
    assertSnapshot(snapshot, policy);
    this.state = cloneSnapshot(snapshot);
    this.observedTime = snapshot.timeFloor;
  }

  get isAvailable(): boolean {
    return this.available && !this.writing;
  }

  snapshotForPersistence(): CookieJarSnapshot {
    this.assertAvailable();
    return cloneSnapshot(this.state);
  }

  bindLease(
    input: CookieJarLease,
    isActive: () => boolean,
    credentialsAllowed = false,
  ): CookieJarLease {
    this.assertAvailable();
    if (this.leases.size >= 64) throw new CookieJarError("cookie_jar_limit");
    const partition = this.partition(input);
    this.assertActivePartition(partition, input.authorityEpoch);
    const url = cookieSourceUrl(input.url);
    if (!isWithinTarget(partition.authority, url) || !isActive())
      throw new CookieJarError("cookie_partition_denied");
    const lease = Object.freeze({ ...input, url: url.href });
    this.leases.set(lease, { isActive, credentialsAllowed });
    return lease;
  }

  releaseLease(lease: CookieJarLease): void {
    this.leases.delete(lease);
  }

  selectHeader(lease: CookieJarLease): string {
    const partition = this.activePartition(lease);
    const now = this.time();
    return this.leases.get(lease)?.credentialsAllowed
      ? selectCookieHeader(partition.cookies, lease.url, now)
      : "";
  }

  applyResponse(
    lease: CookieJarLease,
    candidates: readonly ParsedCookieCandidate[],
  ): { rejected: number } {
    const partition = this.activePartition(lease);
    if (candidates.length > HOST_COOKIE_LIMITS.responseCookies)
      throw new CookieJarError("cookie_jar_limit");
    if (!this.leases.get(lease)?.credentialsAllowed) return { rejected: candidates.length };
    const now = this.time();
    const batch = applyCookieBatch(
      partition.cookies,
      candidates,
      { url: lease.url, now },
      this.policy,
    );
    this.activePartition(lease);
    if (JSON.stringify(batch.cookies) === JSON.stringify(partition.cookies))
      return { rejected: batch.rejected };
    const next = cloneSnapshot(this.state);
    const nextPartition = next.partitions.find(
      (entry) => entry.authority.destinationId === lease.destinationId,
    )!;
    nextPartition.cookies = batch.cookies;
    this.commit(next, now);
    return { rejected: batch.rejected };
  }

  clearMany(requests: readonly CookieJarClearRequest[]): void {
    this.assertAvailable();
    if (requests.length > 10000) throw new CookieJarError("cookie_jar_limit");
    const selected = new Map<string, CookieJarPartition>();
    for (const request of requests) {
      const partition = this.partition(request);
      const record = partition.authority;
      const duplicate =
        record.cleanupRequiredEpoch !== null &&
        (record.authorityEpoch === request.authorityEpoch ||
          record.cleanupRequestBaseEpoch === request.authorityEpoch);
      if (record.authorityEpoch !== request.authorityEpoch && !duplicate)
        throw new CookieJarError("cookie_epoch_conflict");
      selected.set(record.destinationId, partition);
    }
    const next = cloneSnapshot(this.state);
    let changed = false;
    for (const partition of next.partitions) {
      if (!selected.has(partition.authority.destinationId)) continue;
      changed = this.clearPartition(partition) || changed;
    }
    if (changed) this.commit(next, this.time());
  }

  clearPrincipalHost(principalId: string, serverId: string): void {
    this.assertAvailable();
    if (!principalId || serverId !== this.state.serverId)
      throw new CookieJarError("cookie_partition_denied");
    this.clearMany(
      this.state.partitions
        .filter((partition) => partition.authority.principalId === principalId)
        .map(({ authority }) => ({
          principalId,
          serverId,
          destinationId: authority.destinationId,
          authorityEpoch: authority.authorityEpoch,
        })),
    );
  }

  private clearPartition(partition: CookieJarPartition): boolean {
    const record = partition.authority;
    if (record.cleanupRequiredEpoch !== null && partition.clearedEpoch === record.authorityEpoch)
      return false;
    if (record.cleanupRequiredEpoch === null) {
      const epoch = increment(record.authorityEpoch);
      partition.authority = {
        ...record,
        authorityEpoch: epoch,
        cleanupRequiredEpoch: epoch,
        cleanupRequestBaseEpoch: record.authorityEpoch,
      };
    }
    partition.cookies = [];
    partition.generation = increment(partition.generation);
    partition.clearedEpoch = partition.authority.authorityEpoch;
    return true;
  }

  private partition(input: CookieJarClearRequest): CookieJarPartition {
    if (input.serverId !== this.state.serverId) throw new CookieJarError("cookie_partition_denied");
    const partition = this.state.partitions.find(
      (entry) => entry.authority.destinationId === input.destinationId,
    );
    if (!partition || partition.authority.principalId !== input.principalId)
      throw new CookieJarError("cookie_partition_denied");
    return partition;
  }

  private assertActivePartition(partition: CookieJarPartition, epoch: string): void {
    const record = partition.authority;
    if (record.authorityEpoch !== epoch) throw new CookieJarError("cookie_epoch_conflict");
    if (record.state !== "active" || record.cleanupRequiredEpoch !== null)
      throw new CookieJarError("cookie_partition_denied");
  }

  private activePartition(lease: CookieJarLease): CookieJarPartition {
    this.assertAvailable();
    const binding = this.leases.get(lease);
    if (!binding || !binding.isActive()) throw new CookieJarError("cookie_partition_denied");
    const partition = this.partition(lease);
    this.assertActivePartition(partition, lease.authorityEpoch);
    return partition;
  }

  private time(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < this.observedTime) {
      this.available = false;
      throw new CookieJarError("cookie_jar_unavailable");
    }
    this.observedTime = now;
    return now;
  }

  private assertAvailable(): void {
    if (!this.isAvailable) throw new CookieJarError("cookie_jar_unavailable");
    try {
      if (this.storage.currentRevision() !== this.state.revision)
        throw new CookieJarError("cookie_jar_unavailable");
    } catch {
      this.available = false;
      throw new CookieJarError("cookie_jar_unavailable");
    }
  }

  private commit(next: CookieJarSnapshot, now: number): void {
    next.revision = increment(this.state.revision);
    next.timeFloor = now;
    assertSnapshot(next, this.policy);
    this.writing = true;
    try {
      this.storage.commit(this.state.revision, cloneSnapshot(next));
      this.state = next;
    } catch {
      this.available = false;
      throw new CookieJarError("cookie_jar_unavailable");
    } finally {
      this.writing = false;
    }
  }
}
