import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkFetchRpcError, type NetworkFetch } from "@getpaseo/client";
import {
  NETWORK_FETCH_LIMITS,
  type NetworkFetchDescriptor,
} from "@getpaseo/protocol/network-fetch/rpc-schemas";
import { NetworkFetchRegistry } from "../../../client/src/network-fetch";
import type { WebProxyBroker, WebProxyBrokerOptions, WebProxyBrokerState } from "./broker.web";
import {
  createWebProxyProductController,
  type WebProxyProductConfiguration,
} from "./product-controller.web";
import {
  createWebProxyProductPersistence,
  WebProxyProductPersistenceError,
} from "./product-persistence.web";
import { createWebProxyProductRegistry } from "./product-registry.web";

const attach = vi.hoisted(() => vi.fn());
vi.mock("./broker.web", () => ({ attachWebProxyBroker: attach }));

const configuration: WebProxyProductConfiguration = {
  dedicatedContentDomain: "content.example",
  assetVersion: "version-one",
  bootstrapPath: "/bootstrap.html",
  pathPrefix: "/",
  ttlMs: 60_000,
  handshakeTimeoutMs: 1000,
};
const destinationId = "a".repeat(52);
const descriptor: NetworkFetchDescriptor = {
  destinationId,
  origin: "https://upstream.example",
  pathPrefix: "/",
  allowlistRevision: 1,
  authorityEpoch: "5",
  cleanupRequiredEpoch: null,
  contentOrigin: `https://${destinationId}.content.example`,
  assetVersion: "version-one",
};
const teardowns: Array<() => Promise<void>> = [];
let lastBroker: ReturnType<typeof makeBroker>;

function granted(generation: number): WebProxyBrokerState {
  return {
    status: "granted",
    generation,
    lifecycle: "ready",
    workerArmed: true,
    purgeCapable: true,
    navigationDrops: { head_timeout: 0, transport_closed: 0, suspended: 0 },
  };
}

function makeBroker(options: WebProxyBrokerOptions) {
  let state: WebProxyBrokerState = granted(1);
  const frame = document.createElement("iframe");
  const dispose = vi.fn(() => frame.remove());
  const purge = vi.fn(
    async (input: { op: string }) => ({ kind: "unsupported", op: input.op, sent: false }) as const,
  );
  function emit(next: WebProxyBrokerState): void {
    state = next;
    options.onStateChange?.(next);
  }
  const instance: WebProxyBroker = {
    getState: () => state,
    getFrame: () => frame,
    dispose,
    purge,
    revoke: () => dispose(),
    reopen: () => emit(granted(state.generation + 1)),
    suspend(reason) {
      emit({
        status: "suspended",
        generation: state.generation,
        reason,
        lifecycle: "ready",
        workerArmed: true,
        purgeCapable: true,
        navigationDrops: { head_timeout: 0, transport_closed: 0, suspended: 0 },
        documentKept: true,
        lastResumeFailure: null,
      });
      return true;
    },
    async resume() {
      const previous = state.generation;
      emit(granted(previous + 1));
      return { kind: "resumed", previous, generation: previous + 1, documentPreserved: true };
    },
  };
  return { instance, dispose, purge, frame, activate: () => emit(granted(1)), emit };
}

beforeEach(() => {
  attach.mockReset();
  attach.mockImplementation((options: WebProxyBrokerOptions) => {
    lastBroker = makeBroker(options);
    return lastBroker.instance;
  });
});

afterEach(async () => {
  for (const teardown of teardowns.splice(0)) await teardown();
});

function setup() {
  const databaseName = crypto.randomUUID();
  const persistence = createWebProxyProductPersistence({ databaseName });
  const registry = createWebProxyProductRegistry({ channel: null });
  const handles: NetworkFetch[] = [];
  const closeOwner = vi.fn(async () => {});
  const wire = new NetworkFetchRegistry({ send() {}, close: closeOwner, handlerError() {} });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = {
    isNetworkFetchSupported: vi.fn(() => true),
    getConnectionState: vi.fn(() => ({ status: "connected" }) as const),
    getLastServerInfoMessage: vi.fn(
      () =>
        ({
          status: "server_info",
          serverId: "host",
          hostname: null,
          version: null,
          networkFetchConfiguration: configuration,
        }) as const,
    ),
    resolveNetworkFetchDestination: vi.fn(async () => descriptor),
    reconcileNetworkFetchDestination: vi.fn(async () => ({
      descriptor,
      state: "active" as const,
      cleanupRequiredEpoch: null,
    })),
    requestNetworkFetchCleanup: vi.fn(async () => ({
      destinationId,
      authorityEpoch: "6",
      cleanupRequiredEpoch: "6",
      status: "cleanup_pending" as const,
    })),
    openNetworkFetch: vi.fn(async () => {
      const handle = wire.open({
        subscriptionId: `subscription-${handles.length}`,
        descriptor,
        limits: NETWORK_FETCH_LIMITS,
      });
      handles.push(handle);
      return handle;
    }),
  };
  const options = {
    client,
    container,
    view: { serverId: "host", browserId: "browser", workspaceId: "workspace" },
    enabled: true,
    configuration,
    persistence,
    registry,
  };
  const controller = createWebProxyProductController(options);
  teardowns.push(async () => {
    controller.closeView();
    wire.disconnected();
    registry.dispose();
    persistence.close();
    container.remove();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.addEventListener("success", () => resolve());
      request.addEventListener("error", () => reject(request.error));
    });
  });
  return { client, options, controller, persistence, registry, wire, handles, closeOwner };
}

describe("product controller", () => {
  it("is disabled by default and sends no RPC", async () => {
    const context = setup();
    const { enabled: _enabled, ...options } = context.options;
    const controller = createWebProxyProductController(options);
    await controller.open("https://upstream.example/");
    expect(controller.getSnapshot()).toMatchObject({
      phase: "unavailable",
      error: { code: "disabled" },
    });
    expect(context.client.resolveNetworkFetchDestination).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it.each([
    "//other.example/path",
    "/\\other.example/path",
    "/path?query",
    "/path#fragment",
    "/ path",
  ])("rejects unsafe bootstrap path %s", async (bootstrapPath) => {
    const context = setup();
    const controller = createWebProxyProductController({
      ...context.options,
      configuration: { ...configuration, bootstrapPath },
    });
    await controller.open("https://upstream.example/");
    expect(controller.getSnapshot()).toMatchObject({
      phase: "unavailable",
      error: { code: "invalid_configuration" },
    });
    expect(context.client.resolveNetworkFetchDestination).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it("reconciles before open and leaves navigation metadata unconfirmed", async () => {
    const context = setup();
    await context.controller.open("https://upstream.example/path?private=value");
    lastBroker.activate();
    expect(context.client.reconcileNetworkFetchDestination).toHaveBeenCalledExactlyOnceWith({
      destinationId,
      knownEpoch: "5",
    });
    expect(context.client.openNetworkFetch.mock.invocationCallOrder[0]).toBeGreaterThan(
      context.client.reconcileNetworkFetchDestination.mock.invocationCallOrder[0],
    );
    expect(context.controller.getSnapshot()).toMatchObject({
      phase: "active",
      url: null,
      title: null,
      canNavigate: false,
      canReload: false,
      canGoBack: false,
      canGoForward: false,
      error: { code: "navigation_unavailable" },
    });
    expect(await context.persistence.read({ serverId: "host", destinationId })).toEqual({
      version: 1,
      serverId: "host",
      destinationId,
      authorityEpoch: "5",
      cleanupRequiredEpoch: null,
      cleanupRequestBaseEpoch: null,
      status: "observed",
      assetVersion: "version-one",
    });
  });

  it.each(["channel_lost", "expired"] as const)(
    "preserves the view on %s and reconciles before resume",
    async (reason) => {
      const context = setup();
      await context.controller.open("https://upstream.example/");
      lastBroker.activate();
      const retained = lastBroker;
      if (reason === "channel_lost") context.wire.disconnected();
      else context.wire.closed(context.handles[0].subscriptionId, reason);
      expect(context.controller.getSnapshot()).toMatchObject({
        phase: "suspended",
        canResume: true,
        cleanup: { status: "not_requested" },
      });
      expect(retained.dispose).not.toHaveBeenCalled();
      expect(retained.purge).not.toHaveBeenCalled();
      expect(retained.frame.inert).toBe(true);
      await context.controller.resume();
      expect(context.client.reconcileNetworkFetchDestination).toHaveBeenCalledTimes(2);
      expect(context.controller.getSnapshot().phase).toBe("active");
      expect(retained.frame.inert).toBe(false);
      expect(attach).toHaveBeenCalledTimes(1);
      retained.emit({ status: "failed", generation: 3, reason: "handshake_timeout" });
      expect(context.controller.getSnapshot().phase).toBe("blocked");
    },
  );

  it("closes only the current view and permits cleanup without an active owner", async () => {
    const context = setup();
    await context.controller.open("https://upstream.example/");
    const retained = lastBroker;
    context.controller.closeView();
    expect(context.client.requestNetworkFetchCleanup).not.toHaveBeenCalled();
    expect(context.closeOwner).toHaveBeenCalledExactlyOnceWith("subscription-0");
    expect(retained.purge).not.toHaveBeenCalled();
    await context.controller.requestClear();
    expect(context.client.requestNetworkFetchCleanup).toHaveBeenCalledExactlyOnceWith({
      destinationId,
      expectedAuthorityEpoch: "5",
    });
    expect(context.controller.getSnapshot()).toMatchObject({
      phase: "cleanup_pending",
      cleanup: { status: "pending_host", requiredEpoch: "6" },
    });
    expect(retained.purge).not.toHaveBeenCalled();
  });

  it("persists intent before RPC and retains it when the reply is lost", async () => {
    const context = setup();
    await context.controller.open("https://upstream.example/");
    context.client.requestNetworkFetchCleanup.mockImplementation(async () => {
      expect(await context.persistence.read({ serverId: "host", destinationId })).toMatchObject({
        status: "cleanup_pending",
        cleanupRequestBaseEpoch: "5",
      });
      throw new NetworkFetchRpcError("request_cleanup", "channel_lost");
    });
    await context.controller.requestClear();
    expect(context.controller.getSnapshot()).toMatchObject({
      phase: "cleanup_pending",
      error: { code: "channel_lost" },
      cleanup: { status: "pending_local" },
    });
    await context.controller.open("https://upstream.example/");
    expect(context.client.openNetworkFetch).toHaveBeenCalledTimes(1);
    expect(await context.persistence.read({ serverId: "host", destinationId })).toMatchObject({
      status: "cleanup_pending",
      cleanupRequestBaseEpoch: "5",
    });
  });

  it("blocks before grant when persisted cleanup survived a controller restart", async () => {
    const context = setup();
    await context.controller.open("https://upstream.example/");
    await context.controller.requestClear();
    context.controller.closeView();
    const controller = createWebProxyProductController(context.options);
    await controller.open("https://upstream.example/");
    expect(controller.getSnapshot().phase).toBe("cleanup_pending");
    expect(context.client.openNetworkFetch).toHaveBeenCalledTimes(1);
    controller.closeView();
  });

  it("fences all local views on revocation without reporting storage erased", async () => {
    const context = setup();
    const second = createWebProxyProductController({
      ...context.options,
      view: { ...context.options.view, browserId: "second" },
    });
    await context.controller.open("https://upstream.example/");
    await second.open("https://upstream.example/");
    context.wire.closed("subscription-0", "revoked");
    expect(context.controller.getSnapshot().phase).toBe("cleanup_pending");
    expect(second.getSnapshot().phase).toBe("cleanup_pending");
    expect(context.handles[1].ended).toBe("closed");
    await context.persistence.read({ serverId: "host", destinationId });
    expect(await context.persistence.read({ serverId: "host", destinationId })).toMatchObject({
      status: "cleanup_pending",
    });
    second.closeView();
  });

  it("blocks cleanup RPC and reopening if persistence fails", async () => {
    const context = setup();
    await context.controller.open("https://upstream.example/");
    const merge = vi
      .spyOn(context.persistence, "merge")
      .mockRejectedValue(new WebProxyProductPersistenceError());
    await context.controller.requestClear();
    expect(context.client.requestNetworkFetchCleanup).not.toHaveBeenCalled();
    expect(context.controller.getSnapshot()).toMatchObject({
      phase: "cleanup_pending",
      error: { code: "persistence_unavailable" },
    });
    merge.mockRestore();
    await context.controller.open("https://upstream.example/");
    expect(context.client.openNetworkFetch).toHaveBeenCalledTimes(1);
  });

  it("does not mount after close while resolve is pending", async () => {
    const context = setup();
    let finish = (_descriptor: NetworkFetchDescriptor) => {};
    context.client.resolveNetworkFetchDestination.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const opening = context.controller.open("https://upstream.example/");
    context.controller.closeView();
    finish(descriptor);
    await opening;
    expect(context.client.openNetworkFetch).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(context.controller.getSnapshot().phase).toBe("closed");
  });
});
