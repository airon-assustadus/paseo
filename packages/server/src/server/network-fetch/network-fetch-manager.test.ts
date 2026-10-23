import { afterEach, describe, expect, it } from "vitest";
import type { NetworkFetchOpenRequest } from "@getpaseo/protocol/network-fetch/rpc-schemas";
import { resolveNetworkFetchConfiguration } from "./configuration.js";
import { NetworkFetchManager } from "./network-fetch-manager.js";
import {
  NetworkFetchStateStore,
  type NetworkFetchStateStorage,
} from "./network-fetch-state-store.js";
import type { NetworkFetchSink } from "./session.js";

class MemoryStorage implements NetworkFetchStateStorage {
  data: string | null = null;
  fail = false;
  beforeWrite?: () => void;
  read() {
    return this.data;
  }
  write(data: string) {
    this.beforeWrite?.();
    if (this.fail) throw new Error("Disk failure");
    this.data = data;
  }
}

const managers: NetworkFetchManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) {
    if (manager.available) await manager.close();
  }
});

function fixture(storage = new MemoryStorage(), revision = 1) {
  const configuration = resolveNetworkFetchConfiguration({
    enabled: true,
    dedicatedContentDomain: "content.example.test",
    controlOrigin: "https://control.example.test",
    assetVersion: "v1",
    bootstrapPath: "/bootstrap.html",
    pathPrefix: "/",
    ttlMs: 60_000,
    handshakeTimeoutMs: 10_000,
    allowlists: [
      { id: "local", revision, targets: [{ origin: "https://target.test", pathPrefix: "/" }] },
    ],
  })!;
  const store = new NetworkFetchStateStore(storage, "host-a");
  const manager = new NetworkFetchManager({
    configuration,
    store,
    protectedLocalPorts: () => new Set(),
    lookup: async () => [],
  });
  managers.push(manager);
  const descriptor = manager.resolve("principal-a", {
    origin: "https://target.test",
    pathPrefix: "/",
  });
  const request: NetworkFetchOpenRequest = {
    type: "network.fetch.open.request",
    requestId: "open",
    destinationId: descriptor.destinationId,
    expectedAuthorityEpoch: descriptor.authorityEpoch,
    allowlistRevision: descriptor.allowlistRevision,
    scope: { origin: descriptor.origin, pathPrefix: "/" },
    ttlMs: 60_000,
  };
  const reasons: string[] = [];
  const failures: string[] = [];
  const sink: NetworkFetchSink = {
    head() {},
    body() {},
    end() {},
    uploadCredit() {},
    fail(_id, failure) {
      failures.push(failure.code);
    },
    closed(reason) {
      reasons.push(reason);
    },
  };
  function open(principalId = "principal-a") {
    return manager.open({ principalId, request, sink, isAuthorized: () => true }).core;
  }
  return { manager, store, storage, descriptor, request, open, sink, reasons, failures };
}

describe("daemon network fetch authority", () => {
  it("cleans up without an owner and deduplicates the durable base epoch", async () => {
    const { manager, descriptor, storage } = fixture();
    const cleanup = () => manager.requestCleanup("principal-a", descriptor.destinationId, "1");
    const results = await Promise.all([
      Promise.resolve().then(cleanup),
      Promise.resolve().then(cleanup),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].authorityEpoch).toBe("2");
    expect(manager.requestCleanup("principal-a", descriptor.destinationId, "2")).toEqual(
      results[0],
    );
    await manager.close();
    const restarted = fixture(storage);
    expect(restarted.manager.requestCleanup("principal-a", descriptor.destinationId, "1")).toEqual(
      results[0],
    );
    expect(() => restarted.open()).toThrow("cleanup_pending");
  });

  it("cancels every view before the first persistence operation", () => {
    const { manager, descriptor, storage, open, reasons } = fixture();
    const first = open();
    const second = open();
    storage.beforeWrite = () => {
      expect(first.isOpen).toBe(false);
      expect(second.isOpen).toBe(false);
      expect(reasons).toEqual(["revoked", "revoked"]);
    };
    manager.requestCleanup("principal-a", descriptor.destinationId, "1");
    storage.beforeWrite = undefined;
    expect(() => open()).toThrow("epoch_conflict");
  });

  it("rejects stale epochs and foreign identities without mutating authority", () => {
    const { manager, descriptor } = fixture();
    expect(() => manager.requestCleanup("principal-a", descriptor.destinationId, "0")).toThrow(
      "epoch_conflict",
    );
    expect(() => manager.requestCleanup("other", descriptor.destinationId, "1")).toThrow(
      "permission_denied",
    );
    expect(() => manager.reconcile("other", descriptor.destinationId)).toThrow("permission_denied");
    expect(() => manager.reconcile("principal-a", "unknown")).toThrow("permission_denied");
    expect(
      manager.reconcile("principal-a", descriptor.destinationId).descriptor.authorityEpoch,
    ).toBe("1");
  });

  it("revokes offline identities and does not clear pending cleanup on regrant", () => {
    const { manager, descriptor } = fixture();
    manager.requestCleanup("principal-a", descriptor.destinationId, "1");
    manager.updatePrincipalPermissions("principal-a", false);
    expect(() => manager.reconcile("principal-a", descriptor.destinationId)).toThrow(
      "permission_denied",
    );
    manager.updatePrincipalPermissions("principal-a", true);
    const state = manager.reconcile("principal-a", descriptor.destinationId);
    expect(state.cleanupRequiredEpoch).toBe("4");
    expect(state.state).toBe("active");
    expect(() => manager.requestCleanup("principal-a", descriptor.destinationId, "1")).toThrow(
      "epoch_conflict",
    );
  });

  it("keeps a global fence after failed persistence and recovers it after crash", () => {
    const { manager, descriptor, storage, open } = fixture();
    const core = open();
    storage.fail = true;
    expect(() => manager.requestCleanup("principal-a", descriptor.destinationId, "1")).toThrow(
      "durability_unavailable",
    );
    expect(core.isOpen).toBe(false);
    expect(() => manager.requestCleanup("principal-a", descriptor.destinationId, "1")).toThrow(
      "durability_unavailable",
    );
    expect(() => open()).toThrow("durability_unavailable");
    storage.fail = false;
    const restarted = fixture(storage);
    expect(restarted.descriptor.cleanupRequiredEpoch).toBe("2");
    expect(() => restarted.open()).toThrow("cleanup_pending");
  });

  it("restricts subscription count across sessions of the same principal", () => {
    const { open } = fixture();
    for (let index = 0; index < 4; index += 1) open();
    expect(() => open()).toThrow("limit_exceeded");
  });

  it("uses a finite exchange pool shared by all subscriptions", async () => {
    const { open, failures } = fixture();
    const first = open();
    const second = open();
    for (let requestId = 1; requestId <= 64; requestId += 1)
      first.request({
        requestId,
        method: "GET",
        url: "https://target.test/",
        headers: [],
        redirect: "manual",
        body: { kind: "none" },
      });
    second.request({
      requestId: 1,
      method: "GET",
      url: "https://target.test/",
      headers: [],
      redirect: "manual",
      body: { kind: "none" },
    });
    expect(failures).toEqual(["stream_limit"]);
    first.close();
    second.close();
    await Promise.all([first.released(), second.released()]);
  });

  it("fences changed allowlist revisions on startup", async () => {
    const first = fixture();
    await first.manager.close();
    const restarted = fixture(first.storage, 2);
    expect(restarted.descriptor.cleanupRequiredEpoch).not.toBeNull();
    expect(() => restarted.open()).toThrow("cleanup_pending");
  });

  it("fences configuration reload before persistence and retains removal across restart", async () => {
    const { manager, store, storage, descriptor, open } = fixture();
    const first = open();
    const second = open();
    storage.beforeWrite = () => {
      expect(first.isOpen).toBe(false);
      expect(second.isOpen).toBe(false);
      expect(manager.available).toBe(false);
    };
    manager.invalidateConfiguration();
    storage.beforeWrite = undefined;
    expect(store.get(descriptor.destinationId)).toMatchObject({
      state: "removed",
      authorityEpoch: "2",
      cleanupRequiredEpoch: "2",
    });
    expect(() => open()).toThrow("durability_unavailable");
    await manager.close();
    const restarted = fixture(storage);
    expect(restarted.manager.reconcile("principal-a", descriptor.destinationId)).toMatchObject({
      state: "removed",
      cleanupRequiredEpoch: "2",
    });
    expect(() => restarted.open()).toThrow("cleanup_pending");
  });

  it("does not advertise availability or clear the dirty marker after reload write failure", async () => {
    const { manager, storage, open } = fixture();
    const core = open();
    storage.fail = true;
    expect(() => manager.invalidateConfiguration()).toThrow("durability_unavailable");
    expect(core.isOpen).toBe(false);
    expect(manager.available).toBe(false);
    storage.fail = false;
    await expect(manager.close()).rejects.toThrow("durable state is unavailable");
    const restarted = fixture(storage);
    expect(restarted.descriptor.cleanupRequiredEpoch).toBe("2");
    expect(() => restarted.open()).toThrow("cleanup_pending");
  });
});
