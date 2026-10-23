import { afterEach, describe, expect, it } from "vitest";
import { NetworkFetchOpcode } from "@getpaseo/protocol/binary-frames/network-fetch";
import type {
  NetworkFetchOpenRequest,
  NetworkFetchRequestCleanupRequest,
} from "@getpaseo/protocol/network-fetch/rpc-schemas";
import type { SessionOutboundMessage } from "../messages.js";
import { SessionDelivery } from "../session/owned-subscriptions/index.js";
import { resolveNetworkFetchConfiguration } from "./configuration.js";
import { NetworkFetchManager } from "./network-fetch-manager.js";
import { NetworkFetchProductSession, NETWORK_FETCH_FAMILY } from "./network-fetch-session.js";
import {
  NetworkFetchStateStore,
  type NetworkFetchStateStorage,
} from "./network-fetch-state-store.js";

class MemoryStorage implements NetworkFetchStateStorage {
  data: string | null = null;
  beforeWrite?: () => void;
  read() {
    return this.data;
  }
  write(data: string) {
    this.beforeWrite?.();
    this.data = data;
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function fixture(principalId: string | null = "principal-a") {
  const storage = new MemoryStorage();
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
      { id: "local", revision: 1, targets: [{ origin: "https://target.test", pathPrefix: "/" }] },
    ],
  })!;
  const manager = new NetworkFetchManager({
    configuration,
    store: new NetworkFetchStateStore(storage, "host-a"),
    protectedLocalPorts: () => new Set(),
  });
  const messages: Array<{ source: object; message: SessionOutboundMessage }> = [];
  const delivery = new SessionDelivery((source, message) => messages.push({ source, message }));
  const first = {};
  const second = {};
  delivery.attach(first, true);
  delivery.attach(second, true);
  let allowed = true;
  let capable = true;
  const session = new NetworkFetchProductSession(
    {
      principalId,
      emit: (message) => {
        if (!delivery.reply(message)) throw new Error("Unowned reply");
      },
      begin: (stop) => delivery.begin(NETWORK_FETCH_FAMILY, undefined, stop),
      currentSource: () => delivery.currentSource,
      requestSignal: () => delivery.requestSignal,
      supportsFetch: (source) => capable && delivery.isModern(source),
      allowsNetworkProxy: () => allowed,
      reportReleaseFailure: () => {
        throw new Error("Release failed");
      },
    },
    manager,
  );
  const descriptor = manager.resolve("principal-a", {
    origin: "https://target.test",
    pathPrefix: "/",
  });
  const openRequest: NetworkFetchOpenRequest = {
    type: "network.fetch.open.request",
    requestId: "open",
    destinationId: descriptor.destinationId,
    expectedAuthorityEpoch: descriptor.authorityEpoch,
    allowlistRevision: 1,
    scope: { origin: descriptor.origin, pathPrefix: "/" },
    ttlMs: 60_000,
  };
  const clearRequest: NetworkFetchRequestCleanupRequest = {
    type: "network.fetch.request_cleanup.request",
    requestId: "cleanup",
    destinationId: descriptor.destinationId,
    expectedAuthorityEpoch: "1",
  };
  const request = (message: Parameters<typeof session.handle>[0], source = first) =>
    delivery.request(source, message, () => session.handle(message));
  cleanup.push(async () => {
    await delivery.close();
    await manager.close();
  });
  async function open(source = first) {
    await request(openRequest, source);
    const response = messages.at(-1)?.message;
    if (response?.type !== "network.fetch.open.response" || !response.payload.ok)
      throw new Error("Open failed");
    return response.payload.subscriptionId;
  }
  return {
    manager,
    storage,
    delivery,
    messages,
    session,
    first,
    second,
    descriptor,
    openRequest,
    clearRequest,
    request,
    open,
    deny: () => {
      allowed = false;
    },
    incapable: () => {
      capable = false;
    },
  };
}

describe("owned network fetch product session", () => {
  it("requires the authenticated principal, permission and capability independently", async () => {
    const absent = fixture(null);
    await absent.request(absent.clearRequest);
    expect(absent.messages.at(-1)?.message).toMatchObject({
      payload: { ok: false, error: { code: "permission_denied" } },
    });
    const denied = fixture();
    denied.deny();
    await denied.request(denied.clearRequest);
    expect(denied.messages.at(-1)?.message).toMatchObject({
      payload: { ok: false, error: { code: "permission_denied" } },
    });
    const incapable = fixture();
    incapable.incapable();
    await incapable.request(incapable.clearRequest);
    expect(incapable.messages.at(-1)?.message).toMatchObject({
      payload: { ok: false, error: { code: "unsupported_capability" } },
    });
  });

  it("routes cleanup replies to their source after closing all owners", async () => {
    const harness = fixture();
    await harness.open(harness.first);
    await harness.open(harness.second);
    await harness.request(harness.clearRequest, harness.second);
    const closed = harness.messages.filter(
      ({ message }) => message.type === "network.fetch.closed.update",
    );
    expect(closed.map(({ source }) => source)).toEqual([harness.first, harness.second]);
    expect(harness.messages.at(-1)).toMatchObject({
      source: harness.second,
      message: {
        type: "network.fetch.request_cleanup.response",
        payload: { ok: true, status: "cleanup_pending" },
      },
    });
    await harness.delivery.releaseFamily(NETWORK_FETCH_FAMILY);
    expect(harness.delivery.registrationCount).toBe(0);
  });

  it("preserves an accepted mutation when the requesting source disappears during the write", async () => {
    const harness = fixture();
    harness.storage.beforeWrite = () => {
      void harness.delivery.detach(harness.first);
    };
    await harness.request(harness.clearRequest);
    harness.storage.beforeWrite = undefined;
    expect(harness.messages).toEqual([]);
    expect(
      harness.manager.reconcile("principal-a", harness.descriptor.destinationId)
        .cleanupRequiredEpoch,
    ).toBe("2");
    await harness.request(harness.clearRequest, harness.second);
    expect(harness.messages.at(-1)?.message).toMatchObject({
      payload: { ok: true, authorityEpoch: "2" },
    });
  });

  it("refuses foreign binary frames before the core and makes owner close idempotent", async () => {
    const harness = fixture();
    const subscriptionId = await harness.open();
    await expect(
      harness.session.handleFrame(
        { opcode: NetworkFetchOpcode.Cancel, subscriptionId, fetchId: 1 },
        harness.second,
      ),
    ).rejects.toThrow("Unknown owned");
    const close = {
      type: "network.fetch.close.request" as const,
      requestId: "close",
      subscriptionId,
    };
    await harness.request(close, harness.second);
    expect(harness.messages.at(-1)?.message).toMatchObject({
      payload: { ok: false, error: { code: "permission_denied" } },
    });
    await harness.request(close);
    await harness.request(close);
    expect(harness.messages.at(-1)?.message).toMatchObject({
      payload: { ok: true, subscriptionId },
    });
    expect(
      harness.manager.reconcile("principal-a", harness.descriptor.destinationId)
        .cleanupRequiredEpoch,
    ).toBeNull();
  });

  it("disconnect closes only that view and preserves identity state", async () => {
    const harness = fixture();
    await harness.open();
    await harness.open(harness.second);
    await harness.delivery.detach(harness.first);
    expect(harness.delivery.sourceRegistrationCount(harness.second)).toBe(1);
    expect(
      harness.manager.reconcile("principal-a", harness.descriptor.destinationId)
        .cleanupRequiredEpoch,
    ).toBeNull();
  });
});
