import { describe, expect, it } from "vitest";
import {
  CookieJarStore,
  createCookieJarSnapshot,
  type CookieJarCommitPort,
  type CookieJarLease,
  type CookieJarSnapshot,
} from "./cookie-jar-store.js";
import type { ParsedCookieCandidate } from "./cookie-policy.js";
import type { NetworkFetchDestinationRecord } from "./network-fetch-state-store.js";

function authority(
  destinationId: string,
  principalId = "principal-a",
  origin = "https://app.example.test",
): NetworkFetchDestinationRecord {
  return {
    destinationId,
    principalId,
    origin,
    pathPrefix: "/",
    allowlistId: "policy",
    allowlistRevision: 1,
    authorityEpoch: "1",
    cleanupRequiredEpoch: null,
    cleanupRequestBaseEpoch: null,
    state: "active",
    contentOrigin: `https://${destinationId}.content.test`,
    assetVersion: "v1",
  };
}

class MemoryCommitPort implements CookieJarCommitPort {
  commits = 0;
  failBeforeWrite = false;
  failAfterWrite = false;
  beforeCommit?: (snapshot: CookieJarSnapshot) => void;

  constructor(public saved: CookieJarSnapshot) {}

  currentRevision(): string {
    return this.saved.revision;
  }

  commit(expectedRevision: string, snapshot: CookieJarSnapshot): void {
    if (this.failBeforeWrite || this.saved.revision !== expectedRevision)
      throw new Error("Commit refused");
    this.beforeCommit?.(snapshot);
    this.saved = structuredClone(snapshot);
    this.commits += 1;
    if (this.failAfterWrite) throw new Error("Durability unknown");
  }
}

const firstId = "a".repeat(52);
const secondId = "b".repeat(52);
const foreignId = "c".repeat(52);
const policy = { isPublicSuffix: () => false };
const isActive = () => true;
const candidate: ParsedCookieCandidate = {
  name: "session",
  value: "synthetic",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "none",
  partitioned: false,
  sourceBytes: 80,
};

function fixture() {
  const snapshot = createCookieJarSnapshot(
    "host-a",
    [
      authority(firstId),
      authority(secondId, "principal-a", "https://second.test"),
      authority(foreignId, "principal-b"),
    ],
    10000,
  );
  const storage = new MemoryCommitPort(snapshot);
  let now = 10000;
  const store = new CookieJarStore(snapshot, storage, policy, () => now);
  function request(destinationId = firstId): CookieJarLease {
    const record = snapshot.partitions.find(
      (entry) => entry.authority.destinationId === destinationId,
    )!.authority;
    return {
      principalId: record.principalId,
      serverId: "host-a",
      destinationId,
      authorityEpoch: "1",
      url: `${record.origin}/login`,
    };
  }
  function lease(destinationId = firstId) {
    return store.bindLease(request(destinationId), () => true, true);
  }
  return {
    store,
    storage,
    snapshot,
    request,
    lease,
    setTime: (time: number) => {
      now = time;
    },
  };
}

describe("pure cookie jar authority transactions", () => {
  it("defaults to omit for both outgoing and incoming cookies unless H explicitly opts in", () => {
    const { store, storage, request, lease } = fixture();
    store.applyResponse(lease(), [candidate]);
    const omitted = store.bindLease(request(), () => true);
    expect(store.selectHeader(omitted)).toBe("");
    expect(store.applyResponse(omitted, [{ ...candidate, value: "must-not-write" }])).toEqual({
      rejected: 1,
    });
    expect(storage.commits).toBe(1);
    expect(store.selectHeader(lease())).toBe("session=synthetic");
  });

  it("commits response cookies together with unchanged authority in one snapshot", () => {
    const { store, storage, lease } = fixture();
    const owned = lease();
    store.applyResponse(owned, [candidate]);
    expect(storage.commits).toBe(1);
    expect(storage.saved.revision).toBe("1");
    expect(storage.saved.partitions[0].authority.authorityEpoch).toBe("1");
    expect(store.selectHeader(owned)).toBe("session=synthetic");
  });

  it("commits aggregate clear once for every destination, including offline records", () => {
    const { store, storage, lease, request } = fixture();
    const first = lease();
    store.applyResponse(first, [candidate]);
    store.applyResponse(lease(secondId), [candidate]);
    store.applyResponse(lease(foreignId), [{ ...candidate, value: "foreign" }]);
    const before = storage.commits;
    storage.beforeCommit = (next) => {
      expect(store.isAvailable).toBe(false);
      expect(() => store.selectHeader(first)).toThrow("cookie_jar_unavailable");
      expect(
        next.partitions.slice(0, 2).map((entry) => entry.authority.cleanupRequiredEpoch),
      ).toEqual(["2", "2"]);
      expect(next.partitions.slice(0, 2).map((entry) => entry.cookies)).toEqual([[], []]);
    };
    store.clearPrincipalHost("principal-a", "host-a");
    expect(storage.commits).toBe(before + 1);
    expect(storage.saved.partitions[2].cookies[0].value).toBe("foreign");
    expect(() => store.applyResponse(first, [candidate])).toThrow("cookie_epoch_conflict");
    store.clearMany([request(), request(secondId)]);
    expect(storage.commits).toBe(before + 1);
  });

  it("validates all clear epochs before committing any destination", () => {
    const { store, storage, request } = fixture();
    expect(() =>
      store.clearMany([request(), { ...request(secondId), authorityEpoch: "99" }]),
    ).toThrow("cookie_epoch_conflict");
    expect(storage.commits).toBe(0);
    expect(store.snapshotForPersistence().partitions[0].authority.authorityEpoch).toBe("1");
  });

  it("deduplicates the base epoch durably and never clears cleanup pending", () => {
    const { store, storage, request } = fixture();
    store.clearMany([request(), request()]);
    const restarted = new CookieJarStore(storage.saved, storage, policy, () => 10000);
    restarted.clearMany([request(), { ...request(), authorityEpoch: "2" }]);
    expect(storage.commits).toBe(1);
    expect(storage.saved.partitions[0]).toMatchObject({
      generation: "1",
      clearedEpoch: "2",
      authority: { authorityEpoch: "2", cleanupRequiredEpoch: "2", cleanupRequestBaseEpoch: "1" },
    });
    expect(() => restarted.bindLease({ ...request(), authorityEpoch: "2" }, isActive)).toThrow(
      "cookie_partition_denied",
    );
  });

  it("denies foreign principal, host, URL, forged lease and released owner", () => {
    const { store, request } = fixture();
    expect(() => store.bindLease({ ...request(), principalId: "principal-b" }, isActive)).toThrow(
      "cookie_partition_denied",
    );
    expect(() => store.bindLease({ ...request(), serverId: "host-b" }, isActive)).toThrow(
      "cookie_partition_denied",
    );
    expect(() => store.bindLease({ ...request(), url: "https://second.test/" }, isActive)).toThrow(
      "cookie_partition_denied",
    );
    expect(() => store.clearMany([{ ...request(), principalId: "principal-b" }])).toThrow(
      "cookie_partition_denied",
    );
    const owned = store.bindLease(request(), () => true);
    expect(() => store.selectHeader({ ...owned })).toThrow("cookie_partition_denied");
    store.releaseLease(owned);
    expect(() => store.applyResponse(owned, [candidate])).toThrow("cookie_partition_denied");
  });

  it("does not share cookies across destinations or principals", () => {
    const { store, lease } = fixture();
    const first = lease();
    store.applyResponse(first, [candidate]);
    expect(store.selectHeader(first)).toBe("session=synthetic");
    expect(store.selectHeader(lease(secondId))).toBe("");
    expect(store.selectHeader(lease(foreignId))).toBe("");
  });

  it("rechecks owner authority before accepting any later response", () => {
    const { store, request, storage } = fixture();
    let active = true;
    const owned = store.bindLease(request(), () => active);
    active = false;
    expect(() => store.selectHeader(owned)).toThrow("cookie_partition_denied");
    expect(() => store.applyResponse(owned, [candidate])).toThrow("cookie_partition_denied");
    expect(storage.commits).toBe(0);
  });

  it("remains fenced after a failed write instead of acknowledging RAM-only clear", () => {
    const { store, storage, lease, request } = fixture();
    const owned = lease();
    store.applyResponse(owned, [candidate]);
    storage.failBeforeWrite = true;
    expect(() => store.clearMany([request()])).toThrow("cookie_jar_unavailable");
    expect(storage.saved.partitions[0].authority.authorityEpoch).toBe("1");
    storage.failBeforeWrite = false;
    expect(() => store.selectHeader(owned)).toThrow("cookie_jar_unavailable");
    expect(() => store.snapshotForPersistence()).toThrow("cookie_jar_unavailable");
    expect(() => store.clearMany([request()])).toThrow("cookie_jar_unavailable");
  });

  it("does not claim success if the write committed but confirmation failed", () => {
    const { store, storage, request } = fixture();
    storage.failAfterWrite = true;
    expect(() => store.clearMany([request()])).toThrow("cookie_jar_unavailable");
    expect(store.isAvailable).toBe(false);
    const recovered = new CookieJarStore(storage.saved, storage, policy, () => 10000);
    expect(recovered.snapshotForPersistence().partitions[0].authority.cleanupRequiredEpoch).toBe(
      "2",
    );
    expect(() => recovered.bindLease({ ...request(), authorityEpoch: "2" }, isActive)).toThrow(
      "cookie_partition_denied",
    );
  });

  it("rejects a stale compare-and-swap writer without overwriting another commit", () => {
    const { store, storage, snapshot, request, lease } = fixture();
    const competing = new CookieJarStore(snapshot, storage, policy, () => 10000);
    store.applyResponse(lease(), [candidate]);
    expect(() => competing.clearMany([request()])).toThrow("cookie_jar_unavailable");
    expect(storage.saved.partitions[0].cookies).toHaveLength(1);
    expect(competing.isAvailable).toBe(false);
  });

  it("rejects stale credential reads after another transaction cleared authority", () => {
    const { store, storage, request, lease } = fixture();
    const owned = lease();
    store.applyResponse(owned, [candidate]);
    const other = new CookieJarStore(storage.saved, storage, policy, () => 10000);
    other.clearMany([request()]);
    expect(() => store.selectHeader(owned)).toThrow("cookie_jar_unavailable");
    expect(store.isAvailable).toBe(false);
  });

  it("keeps input and exported snapshots from mutating private state", () => {
    const { store, snapshot } = fixture();
    snapshot.partitions[0].authority.principalId = "modified";
    const copy = store.snapshotForPersistence();
    copy.partitions[0].authority.authorityEpoch = "99";
    expect(store.snapshotForPersistence().partitions[0].authority).toMatchObject({
      principalId: "principal-a",
      authorityEpoch: "1",
    });
  });

  it("fences time rollback and cannot be silently re-enabled by clock recovery", () => {
    const { store, lease, setTime } = fixture();
    const owned = lease();
    setTime(9999);
    expect(() => store.selectHeader(owned)).toThrow("cookie_jar_unavailable");
    setTime(10001);
    expect(() => store.selectHeader(owned)).toThrow("cookie_jar_unavailable");
  });

  it("bounds live leases and releases slots idempotently", () => {
    const { store, lease } = fixture();
    const leases = Array.from({ length: 64 }, () => lease());
    expect(() => lease()).toThrow("cookie_jar_limit");
    store.releaseLease(leases[0]);
    store.releaseLease(leases[0]);
    expect(() => lease()).not.toThrow();
    expect(() => lease()).toThrow("cookie_jar_limit");
  });
});
