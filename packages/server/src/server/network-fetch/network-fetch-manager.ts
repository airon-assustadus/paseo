import type {
  NetworkFetchCleanupPending,
  NetworkFetchDescriptor,
  NetworkFetchOpenRequest,
  NetworkFetchReconciliation,
  NetworkFetchRpcFailure,
  NetworkFetchScope,
} from "@getpaseo/protocol/network-fetch/rpc-schemas";
import { coversTarget, parseTrustedTarget, type TrustedAllowlist } from "./allowlist.js";
import {
  publicNetworkFetchConfiguration,
  type ResolvedNetworkFetchConfiguration,
} from "./configuration.js";
import {
  NetworkFetchDurabilityError,
  NetworkFetchStateStore,
  nextNetworkFetchEpoch,
  type NetworkFetchDestinationRecord,
} from "./network-fetch-state-store.js";
import {
  openNetworkFetchSession,
  type NetworkFetchClosedReason,
  type NetworkFetchSession,
  type NetworkFetchSink,
  type OpenNetworkFetchSessionOptions,
} from "./session.js";

export class NetworkFetchControlError extends Error {
  constructor(readonly code: NetworkFetchRpcFailure["code"]) {
    super(code);
    this.name = "NetworkFetchControlError";
  }
}

interface ManagedSession {
  principalId: string;
  destinationId: string;
  core: NetworkFetchSession;
}

interface ManagerOptions {
  configuration: ResolvedNetworkFetchConfiguration;
  store: NetworkFetchStateStore;
  protectedLocalPorts(): ReadonlySet<number>;
  lookup?: OpenNetworkFetchSessionOptions["lookup"];
  dial?: OpenNetworkFetchSessionOptions["dial"];
  reportTeardownFailure?(): void;
}

interface OpenOptions {
  principalId: string;
  request: NetworkFetchOpenRequest;
  sink: NetworkFetchSink;
  isAuthorized(): boolean;
}

export class NetworkFetchManager {
  private readonly sessions = new Map<object, ManagedSession>();
  private readonly fenced = new Set<string>();
  private readonly revokedPrincipals = new Set<string>();
  private requests = 0;
  private readonly releases = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly options: ManagerOptions) {
    this.checkPolicies();
  }

  get available(): boolean {
    return !this.stopped && this.options.store.isAvailable;
  }

  get configuration() {
    return publicNetworkFetchConfiguration(this.options.configuration);
  }

  resolve(principalId: string, input: NetworkFetchScope): NetworkFetchDescriptor {
    return this.durable(() => {
      this.assertPrincipal(principalId);
      const scope = parseTrustedTarget(input);
      const allowlist = this.options.configuration.allowlists.find((entry) =>
        coversTarget(entry, scope),
      );
      if (!allowlist) throw new NetworkFetchControlError("scope_not_allowlisted");
      const destinationId = this.options.store.identity(principalId, scope.origin);
      const existing = this.options.store.get(destinationId);
      if (existing) return descriptorFor(existing);
      const target = allowlist.targets.find((entry) => entry.origin === scope.origin)!;
      const record: NetworkFetchDestinationRecord = {
        destinationId,
        principalId,
        origin: target.origin,
        pathPrefix: target.pathPrefix,
        allowlistId: allowlist.id,
        allowlistRevision: allowlist.revision,
        authorityEpoch: "1",
        cleanupRequiredEpoch: null,
        cleanupRequestBaseEpoch: null,
        state: "active",
        contentOrigin: `https://${destinationId}.${this.options.configuration.dedicatedContentDomain}`,
        assetVersion: this.options.configuration.assetVersion,
      };
      this.options.store.put(record);
      return descriptorFor(record);
    });
  }

  reconcile(principalId: string, destinationId: string): NetworkFetchReconciliation {
    return this.durable(() => {
      const record = this.ownedRecord(principalId, destinationId);
      return {
        descriptor: descriptorFor(record),
        state: record.state,
        cleanupRequiredEpoch: record.cleanupRequiredEpoch,
      };
    });
  }

  requestCleanup(
    principalId: string,
    destinationId: string,
    expectedEpoch: string,
  ): NetworkFetchCleanupPending {
    return this.durable(() => {
      const record = this.ownedRecord(principalId, destinationId);
      if (
        record.cleanupRequiredEpoch !== null &&
        (record.authorityEpoch === expectedEpoch ||
          record.cleanupRequestBaseEpoch === expectedEpoch)
      ) {
        return cleanupFor(record);
      }
      if (record.authorityEpoch !== expectedEpoch)
        throw new NetworkFetchControlError("epoch_conflict");
      this.fence(destinationId, "revoked");
      const epoch = nextNetworkFetchEpoch(record.authorityEpoch);
      const next = {
        ...record,
        authorityEpoch: epoch,
        cleanupRequiredEpoch: epoch,
        cleanupRequestBaseEpoch: expectedEpoch,
      };
      this.options.store.put(next);
      return cleanupFor(next);
    });
  }

  open(options: OpenOptions): { core: NetworkFetchSession; descriptor: NetworkFetchDescriptor } {
    return this.durable(() => {
      const { principalId, request, sink } = options;
      if (request.ttlMs > this.options.configuration.ttlMs)
        throw new NetworkFetchControlError("invalid_configuration");
      const record = this.ownedRecord(principalId, request.destinationId);
      if (record.authorityEpoch !== request.expectedAuthorityEpoch)
        throw new NetworkFetchControlError("epoch_conflict");
      if (record.cleanupRequiredEpoch !== null || this.fenced.has(record.destinationId))
        throw new NetworkFetchControlError("cleanup_pending");
      if (record.state !== "active") throw new NetworkFetchControlError("permission_denied");
      if (record.allowlistRevision !== request.allowlistRevision)
        throw new NetworkFetchControlError("revision_conflict");
      const scope = parseTrustedTarget(request.scope);
      if (scope.origin !== record.origin || !scope.pathPrefix.startsWith(record.pathPrefix))
        throw new NetworkFetchControlError("scope_not_allowlisted");
      const owned = [...this.sessions.values()].filter(
        (entry) => entry.principalId === principalId,
      );
      if (owned.length >= 4 || this.sessions.size >= 64)
        throw new NetworkFetchControlError("limit_exceeded");
      const token = {};
      const core: NetworkFetchSession = openNetworkFetchSession({
        allowlists: { get: (id) => this.allowlist(id) },
        allowlistRef: { id: record.allowlistId, revision: record.allowlistRevision },
        scope,
        ttlMs: request.ttlMs,
        limits: request.limits,
        isAuthorized: () =>
          this.available &&
          !this.fenced.has(record.destinationId) &&
          !this.revokedPrincipals.has(principalId) &&
          options.isAuthorized(),
        protectedLocalPorts: this.options.protectedLocalPorts,
        lookup: this.options.lookup,
        dial: this.options.dial,
        acquireRequestSlot: () => this.acquireRequestSlot(),
        sink: {
          ...sink,
          closed: (reason) => {
            this.sessions.delete(token);
            const released = core.released();
            this.releases.add(released);
            void released.then(() => this.releases.delete(released));
            sink.closed(reason);
          },
        },
      });
      this.sessions.set(token, { principalId, destinationId: record.destinationId, core });
      return { core, descriptor: descriptorFor(record) };
    });
  }

  updatePrincipalPermissions(principalId: string, allowed: boolean): void {
    if (allowed) this.revokedPrincipals.delete(principalId);
    else this.revokedPrincipals.add(principalId);
    this.durable(() => {
      const records = this.options.store
        .records()
        .filter((record) => record.principalId === principalId);
      if (!allowed) for (const record of records) this.fence(record.destinationId, "revoked");
      for (const record of records) {
        if ((!allowed && record.state !== "revoked") || (allowed && record.state === "revoked")) {
          this.advance(record, allowed ? "active" : "revoked");
        }
      }
    });
  }

  async close(): Promise<void> {
    this.stopped = true;
    const cores = [...this.sessions.values()].map((entry) => entry.core);
    for (const core of cores) this.stopCore(core, "closed");
    await Promise.all([...this.releases, ...cores.map((core) => core.released())]);
    this.options.store.close();
  }

  invalidateConfiguration(): void {
    this.durable(() => {
      const records = this.options.store.records();
      for (const record of records) this.fence(record.destinationId, "allowlist_changed");
      this.stopped = true;
      for (const record of records) this.advance(record, "removed");
    });
  }

  private ownedRecord(principalId: string, destinationId: string): NetworkFetchDestinationRecord {
    this.assertPrincipal(principalId);
    const record = this.options.store.get(destinationId);
    if (!record || record.principalId !== principalId)
      throw new NetworkFetchControlError("permission_denied");
    return record;
  }

  private assertPrincipal(principalId: string): void {
    if (!principalId || this.revokedPrincipals.has(principalId))
      throw new NetworkFetchControlError("permission_denied");
    if (!this.available) throw new NetworkFetchControlError("durability_unavailable");
  }

  private allowlist(id: string): TrustedAllowlist | null {
    return this.options.configuration.allowlists.find((entry) => entry.id === id) ?? null;
  }

  private acquireRequestSlot(): (() => void) | null {
    if (!this.available || this.requests >= 64) return null;
    this.requests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.requests -= 1;
    };
  }

  private fence(destinationId: string, reason: NetworkFetchClosedReason): void {
    this.fenced.add(destinationId);
    for (const entry of this.sessions.values()) {
      if (entry.destinationId === destinationId) this.stopCore(entry.core, reason);
    }
  }

  private stopCore(core: NetworkFetchSession, reason: NetworkFetchClosedReason): void {
    try {
      if (reason === "closed") core.close();
      else core.revoke(reason);
    } catch {
      this.options.reportTeardownFailure?.();
    }
  }

  private advance(
    record: NetworkFetchDestinationRecord,
    state: NetworkFetchDestinationRecord["state"],
  ): void {
    const epoch = nextNetworkFetchEpoch(record.authorityEpoch);
    this.options.store.put({
      ...record,
      state,
      authorityEpoch: epoch,
      cleanupRequiredEpoch: epoch,
      cleanupRequestBaseEpoch: null,
    });
  }

  private checkPolicies(): void {
    this.durable(() => {
      for (const record of this.options.store.records()) {
        const allowlist = this.allowlist(record.allowlistId);
        const contentOrigin = `https://${record.destinationId}.${this.options.configuration.dedicatedContentDomain}`;
        if (
          !allowlist ||
          allowlist.revision !== record.allowlistRevision ||
          !coversTarget(allowlist, record) ||
          record.contentOrigin !== contentOrigin ||
          record.assetVersion !== this.options.configuration.assetVersion
        ) {
          this.fence(record.destinationId, "allowlist_changed");
          this.advance(record, allowlist ? record.state : "removed");
        }
      }
    });
  }

  private durable<Result>(operation: () => Result): Result {
    try {
      return operation();
    } catch (error) {
      if (!(error instanceof NetworkFetchDurabilityError)) throw error;
      this.stopped = true;
      for (const entry of this.sessions.values()) this.stopCore(entry.core, "revoked");
      throw new NetworkFetchControlError("durability_unavailable");
    }
  }
}

function descriptorFor(record: NetworkFetchDestinationRecord): NetworkFetchDescriptor {
  return {
    destinationId: record.destinationId,
    origin: record.origin,
    pathPrefix: record.pathPrefix,
    allowlistRevision: record.allowlistRevision,
    authorityEpoch: record.authorityEpoch,
    cleanupRequiredEpoch: record.cleanupRequiredEpoch,
    contentOrigin: record.contentOrigin,
    assetVersion: record.assetVersion,
  };
}

function cleanupFor(record: NetworkFetchDestinationRecord): NetworkFetchCleanupPending {
  if (record.cleanupRequiredEpoch === null)
    throw new NetworkFetchControlError("durability_unavailable");
  return {
    destinationId: record.destinationId,
    authorityEpoch: record.authorityEpoch,
    cleanupRequiredEpoch: record.cleanupRequiredEpoch,
    status: "cleanup_pending",
  };
}
