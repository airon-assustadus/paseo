import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkFetchRpcError, type NetworkFetch } from "@getpaseo/client";
import {
  NETWORK_FETCH_LIMITS,
  type NetworkFetchDescriptor,
} from "@getpaseo/protocol/network-fetch/rpc-schemas";
import { NetworkFetchRegistry } from "../../../client/src/network-fetch";
import type {
  WebProxyBroker,
  WebProxyBrokerOptions,
  WebProxyBrokerState,
  WebProxyNavigationSnapshot,
} from "./broker.web";
import type { NavigationOutcome, NavigationState } from "./navigation-messages";
import {
  createWebProxyProductController,
  type WebProxyProductClient,
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
let automaticNavigation = true;
let brokerAttached = deferred<ReturnType<typeof makeBroker>>();

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
  let navigation: WebProxyNavigationSnapshot = { ready: false, operations: [], document: null };
  let nextDocument = 1;
  function emitNavigation(next: WebProxyNavigationSnapshot): void {
    navigation = next;
    options.onNavigationState?.(next);
  }
  function ready(): void {
    emitNavigation({
      ...navigation,
      ready: true,
      operations: ["navigate", "reload", "back", "forward"],
    });
  }
  function commit(url: string, overrides: Partial<NavigationState> = {}): NavigationOutcome {
    const target = new URL(url);
    const document: NavigationState = {
      url: `${descriptor.contentOrigin}${target.pathname}${target.search}${target.hash}`,
      title: "Observed document",
      documentId: `document-${nextDocument}`,
      entryKey: `entry-${nextDocument}`,
      commit: { kind: "network", requestId: nextDocument++ },
      canReload: true,
      canGoBack: false,
      canGoForward: false,
      ...overrides,
    };
    emitNavigation({ ...navigation, document });
    return {
      status: "committed",
      operationId: nextDocument,
      documentId: document.documentId,
      entryKey: document.entryKey,
      commit: document.commit,
    };
  }
  const navigate = vi.fn(
    async ({ url }: { url: string }): Promise<NavigationOutcome> => commit(url),
  );
  const reload = vi.fn(async (): Promise<NavigationOutcome> => commit(navigation.document!.url));
  const goBack = vi.fn(
    async (): Promise<NavigationOutcome> => ({
      status: "failed",
      operationId: nextDocument++,
      reason: "unsupported",
    }),
  );
  const goForward = vi.fn(
    async (): Promise<NavigationOutcome> => ({
      status: "failed",
      operationId: nextDocument++,
      reason: "unsupported",
    }),
  );
  const instance: WebProxyBroker = {
    getNavigationState: () => navigation,
    navigate,
    reload,
    goBack,
    goForward,
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
  return {
    instance,
    dispose,
    purge,
    frame,
    activate: () => emit(granted(1)),
    emit,
    ready,
    emitNavigation,
    commit,
    navigate,
    reload,
    goBack,
    goForward,
  };
}

beforeEach(() => {
  automaticNavigation = true;
  brokerAttached = deferred<ReturnType<typeof makeBroker>>();
  attach.mockReset();
  attach.mockImplementation((options: WebProxyBrokerOptions) => {
    lastBroker = makeBroker(options);
    const attached = lastBroker;
    brokerAttached.resolve(attached);
    if (automaticNavigation)
      queueMicrotask(() => {
        attached.activate();
        attached.ready();
      });
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
  const statusListeners = new Set<Parameters<WebProxyProductClient["subscribeRawMessages"]>[0]>();
  const connectionListeners = new Set<
    Parameters<WebProxyProductClient["subscribeConnectionStatus"]>[0]
  >();
  const client = {
    isNetworkFetchSupported: vi.fn(() => true),
    getConnectionState: vi.fn(
      (): ReturnType<WebProxyProductClient["getConnectionState"]> => ({ status: "connected" }),
    ),
    subscribeRawMessages: vi.fn(
      (listener: Parameters<WebProxyProductClient["subscribeRawMessages"]>[0]) => {
        statusListeners.add(listener);
        return () => {
          statusListeners.delete(listener);
        };
      },
    ),
    subscribeConnectionStatus: vi.fn(
      (listener: Parameters<WebProxyProductClient["subscribeConnectionStatus"]>[0]) => {
        connectionListeners.add(listener);
        listener(client.getConnectionState());
        return () => {
          connectionListeners.delete(listener);
        };
      },
    ),
    getLastServerInfoMessage: vi.fn(
      (): ReturnType<WebProxyProductClient["getLastServerInfoMessage"]> =>
        ({
          status: "server_info",
          serverId: "host",
          hostname: null,
          version: null,
          networkFetchConfiguration: configuration,
        }) as const,
    ),
    resolveNetworkFetchDestination: vi.fn(async () => descriptor),
    reconcileNetworkFetchDestination: vi.fn(
      async (): ReturnType<WebProxyProductClient["reconcileNetworkFetchDestination"]> => ({
        descriptor,
        state: "active" as const,
        cleanupRequiredEpoch: null,
      }),
    ),
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
  function emitServerInfo(): void {
    const payload = client.getLastServerInfoMessage();
    if (payload === null) throw new Error("Missing test server info");
    for (const listener of statusListeners) listener({ type: "status", payload });
  }
  return {
    client,
    options,
    controller,
    persistence,
    registry,
    wire,
    handles,
    closeOwner,
    emitServerInfo,
    statusListeners,
    connectionListeners,
  };
}

function deferred<Value>() {
  let resolve = (_value: Value) => {};
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const authorityChanges = ["removed", "replaced", "unsupported"] as const;

function changeAuthority(
  context: ReturnType<typeof setup>,
  change: (typeof authorityChanges)[number],
): void {
  if (change === "unsupported") context.client.isNetworkFetchSupported.mockReturnValue(false);
  else
    context.client.getLastServerInfoMessage.mockReturnValue({
      status: "server_info",
      serverId: "host",
      hostname: null,
      version: null,
      ...(change === "replaced"
        ? { networkFetchConfiguration: { ...configuration, assetVersion: "version-two" } }
        : {}),
    });
}

function restoreAuthority(context: ReturnType<typeof setup>): void {
  context.client.isNetworkFetchSupported.mockReturnValue(true);
  context.client.getLastServerInfoMessage.mockReturnValue({
    status: "server_info",
    serverId: "host",
    hostname: null,
    version: null,
    networkFetchConfiguration: configuration,
  });
  context.emitServerInfo();
}

describe("product controller", () => {
  it("waits for navigation readiness and the initial command outcome rather than lifecycle grant", async () => {
    const context = setup();
    automaticNavigation = false;
    const completed = vi.fn();
    const opening = context.controller
      .open("https://upstream.example/path?test=value#section")
      .then(completed);
    const retained = await brokerAttached.promise;
    const result = deferred<NavigationOutcome>();
    retained.navigate.mockReturnValue(result.promise);
    retained.activate();
    await Promise.resolve();
    expect(retained.navigate).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    expect(context.controller.getSnapshot()).toMatchObject({
      url: null,
      title: null,
      canNavigate: false,
    });
    retained.ready();
    await Promise.resolve();
    expect(retained.navigate).toHaveBeenCalledExactlyOnceWith({
      url: "https://upstream.example/path?test=value#section",
    });
    expect(completed).not.toHaveBeenCalled();
    expect(context.controller.getSnapshot().url).toBeNull();
    const committed = retained.commit("https://upstream.example/path?test=value#section");
    expect(completed).not.toHaveBeenCalled();
    result.resolve(committed);
    await opening;
    expect(context.controller.getSnapshot()).toMatchObject({
      url: "https://upstream.example/path?test=value#section",
      canNavigate: true,
      error: null,
    });
    expect(attach.mock.calls[0][0].navigation).toEqual({
      assetVersion: configuration.assetVersion,
    });
  });

  it("retains observed metadata while navigating and refuses a concurrent command without replay", async () => {
    const context = setup();
    await context.controller.open("https://upstream.example/first");
    const retained = lastBroker;
    const outcome = deferred<NavigationOutcome>();
    retained.navigate.mockReturnValueOnce(outcome.promise);
    const completed = vi.fn();
    const navigating = context.controller
      .navigate("https://upstream.example/second")
      .then(completed);
    expect(context.controller.getSnapshot()).toMatchObject({
      url: "https://upstream.example/first",
      canNavigate: false,
      canReload: false,
    });
    await context.controller.reload();
    expect(context.controller.getSnapshot().error).toEqual({ code: "limit_exceeded" });
    expect(retained.reload).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    outcome.resolve(retained.commit("https://upstream.example/second", { title: "Second" }));
    await navigating;
    expect(context.controller.getSnapshot()).toMatchObject({
      url: "https://upstream.example/second",
      title: "Second",
      canNavigate: true,
      error: null,
    });
    expect(retained.navigate).toHaveBeenCalledTimes(2);
    expect(context.client.resolveNetworkFetchDestination).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("uses K reload and traversal operations with observed history flags and no synthetic URL stack", async () => {
    const context = setup();
    await context.controller.open("https://upstream.example/first");
    const retained = lastBroker;
    await context.controller.goBack();
    expect(retained.goBack).not.toHaveBeenCalled();
    retained.commit("https://upstream.example/second", { canGoBack: true });
    expect(context.controller.getSnapshot().canGoBack).toBe(true);
    retained.goBack.mockImplementationOnce(async () =>
      retained.commit("https://upstream.example/first", {
        canGoForward: true,
        commit: { kind: "bfcache" },
      }),
    );
    await context.controller.goBack();
    expect(context.controller.getSnapshot()).toMatchObject({
      url: "https://upstream.example/first",
      canGoBack: false,
      canGoForward: true,
    });
    retained.goForward.mockImplementationOnce(async () =>
      retained.commit("https://upstream.example/second#hash", {
        canGoBack: true,
        commit: { kind: "same_document" },
      }),
    );
    await context.controller.goForward();
    await context.controller.reload();
    expect(retained.goBack).toHaveBeenCalledOnce();
    expect(retained.goForward).toHaveBeenCalledOnce();
    expect(retained.reload).toHaveBeenCalledOnce();
    expect(retained.navigate).toHaveBeenCalledOnce();
    expect(context.controller.getSnapshot().url).toBe("https://upstream.example/second#hash");
  });

  it.each([
    "https://untrusted.example/page",
    `${descriptor.contentOrigin}/__paseo/bootstrap.html`,
    `${descriptor.contentOrigin}/%5f%5fpaseo/worker.js`,
    `https://name:secret@${destinationId}.content.example/page`,
  ])("rejects untrusted document URL %s without publishing it as D", async (url) => {
    const context = setup();
    await context.controller.open("https://upstream.example/confirmed");
    const retained = lastBroker;
    retained.emitNavigation({
      ...retained.instance.getNavigationState(),
      document: { ...retained.instance.getNavigationState().document!, url },
    });
    expect(context.controller.getSnapshot()).toMatchObject({
      url: "https://upstream.example/confirmed",
      canNavigate: false,
      error: { code: "protocol_error" },
    });
    expect(context.client.requestNetworkFetchCleanup).not.toHaveBeenCalled();
  });

  it("rejects an outcome that does not identify the observed document and maps failed results", async () => {
    const context = setup();
    await context.controller.open("https://upstream.example/confirmed");
    lastBroker.navigate.mockResolvedValueOnce({
      status: "committed",
      operationId: 2,
      documentId: "unobserved",
      entryKey: "unobserved",
      commit: { kind: "network", requestId: 2 },
    });
    await context.controller.navigate("https://upstream.example/unobserved");
    expect(context.controller.getSnapshot()).toMatchObject({
      url: "https://upstream.example/confirmed",
      error: { code: "protocol_error" },
    });
    lastBroker.reload.mockResolvedValueOnce({
      status: "failed",
      operationId: 3,
      reason: "unsafe_replay",
    });
    await context.controller.reload();
    expect(context.controller.getSnapshot()).toMatchObject({
      url: "https://upstream.example/confirmed",
      error: { code: "navigation_unavailable" },
    });
    expect(lastBroker.reload).toHaveBeenCalledOnce();
  });

  it.each(["close", "cleanup", "configuration", "loss"] as const)(
    "ignores a late navigation result after %s without replay",
    async (cause) => {
      const context = setup();
      await context.controller.open("https://upstream.example/confirmed");
      const retained = lastBroker;
      const outcome = deferred<NavigationOutcome>();
      retained.navigate.mockReturnValueOnce(outcome.promise);
      const navigating = context.controller.navigate("https://upstream.example/late");
      if (cause === "close") context.controller.closeView();
      if (cause === "cleanup") await context.controller.requestClear();
      if (cause === "configuration") {
        changeAuthority(context, "removed");
        context.emitServerInfo();
      }
      if (cause === "loss") context.wire.disconnected();
      const expected = context.controller.getSnapshot();
      outcome.resolve(retained.commit("https://upstream.example/late"));
      await navigating;
      expect(context.controller.getSnapshot()).toEqual(expected);
      expect(context.controller.getSnapshot()).toMatchObject({
        url: "https://upstream.example/confirmed",
        canNavigate: false,
      });
      if (cause === "loss") {
        await context.controller.resume();
        expect(retained.navigate).toHaveBeenCalledTimes(2);
        expect(retained.purge).not.toHaveBeenCalled();
      }
    },
  );

  it("revalidates configuration when a navigation result arrives before its observer callback", async () => {
    const context = setup();
    await context.controller.open("https://upstream.example/confirmed");
    const retained = lastBroker;
    retained.reload.mockImplementationOnce(async () => {
      changeAuthority(context, "removed");
      return { status: "failed", operationId: 2, reason: "timeout" };
    });
    await context.controller.reload();
    expect(context.controller.getSnapshot()).toMatchObject({
      phase: "unavailable",
      canNavigate: false,
    });
    expect(retained.frame.inert).toBe(true);
    expect(retained.dispose).toHaveBeenCalledOnce();
  });

  it("does a fresh resolution for an explicit target outside the current destination", async () => {
    const context = setup();
    await context.controller.open("https://upstream.example/confirmed");
    const retained = lastBroker;
    context.client.resolveNetworkFetchDestination.mockRejectedValueOnce(
      new Error("Not allowlisted"),
    );
    await context.controller.navigate("https://another.example/path");
    expect(context.client.resolveNetworkFetchDestination).toHaveBeenLastCalledWith({
      origin: "https://another.example",
      pathPrefix: "/",
    });
    expect(retained.navigate).toHaveBeenCalledOnce();
    expect(retained.dispose).toHaveBeenCalledOnce();
  });

  it.each(authorityChanges)(
    "invalidates admitted owner synchronously on %s authority before mounting",
    async (change) => {
      const context = setup();
      const admitted = deferred<void>();
      const release = deferred<void>();
      const originalOpen = context.client.openNetworkFetch.getMockImplementation();
      if (originalOpen === undefined) throw new Error("Missing test implementation");
      context.client.openNetworkFetch.mockImplementation(async () => {
        const handle = await originalOpen();
        admitted.resolve();
        await release.promise;
        return handle;
      });
      const opening = context.controller.open("https://upstream.example/");
      await admitted.promise;
      changeAuthority(context, change);
      context.emitServerInfo();
      expect(context.controller.getSnapshot().phase).toBe("unavailable");
      restoreAuthority(context);
      release.resolve();
      await opening;
      expect(context.handles[0].ended).toBe("closed");
      expect(attach).not.toHaveBeenCalled();
      expect(context.controller.getSnapshot().phase).toBe("unavailable");
    },
  );

  it.each(authorityChanges)(
    "fences %s authority between mount and hello without waiting for UI teardown",
    async (change) => {
      const context = setup();
      automaticNavigation = false;
      const opening = context.controller.open("https://upstream.example/");
      const retained = await brokerAttached.promise;
      changeAuthority(context, change);
      context.emitServerInfo();
      expect(retained.frame.inert).toBe(true);
      expect(retained.dispose).toHaveBeenCalledOnce();
      expect(context.handles[0].ended).toBe("closed");
      expect(context.controller.getSnapshot().phase).toBe("unavailable");
      restoreAuthority(context);
      retained.activate();
      await opening;
      expect(context.controller.getSnapshot().phase).toBe("unavailable");
      expect(retained.purge).not.toHaveBeenCalled();
      expect(context.client.requestNetworkFetchCleanup).not.toHaveBeenCalled();
    },
  );

  it.each(authorityChanges)(
    "invalidates %s authority while awaiting resume ACK and rejects late grant",
    async (change) => {
      const context = setup();
      await context.controller.open("https://upstream.example/");
      const retained = lastBroker;
      retained.activate();
      context.wire.closed(context.handles[0].subscriptionId, "expired");
      const entered = deferred<void>();
      const acknowledgement = deferred<Awaited<ReturnType<WebProxyBroker["resume"]>>>();
      retained.instance.resume = vi.fn(() => {
        entered.resolve();
        return acknowledgement.promise;
      });
      const resuming = context.controller.resume();
      await entered.promise;
      changeAuthority(context, change);
      context.emitServerInfo();
      expect(retained.frame.inert).toBe(true);
      expect(retained.dispose).toHaveBeenCalledOnce();
      expect(context.handles[1].ended).toBe("closed");
      expect(context.controller.getSnapshot().phase).toBe("unavailable");
      restoreAuthority(context);
      retained.activate();
      acknowledgement.resolve({
        kind: "resumed",
        previous: 1,
        generation: 2,
        documentPreserved: true,
      });
      await resuming;
      expect(retained.frame.inert).toBe(true);
      expect(context.controller.getSnapshot().phase).toBe("unavailable");
      expect(retained.purge).not.toHaveBeenCalled();
    },
  );

  it("revalidates grant even before a status observer is notified", async () => {
    const context = setup();
    automaticNavigation = false;
    const opening = context.controller.open("https://upstream.example/");
    const retained = await brokerAttached.promise;
    changeAuthority(context, "removed");
    retained.activate();
    await opening;
    expect(context.controller.getSnapshot().phase).toBe("unavailable");
    expect(retained.frame.inert).toBe(true);
    expect(retained.dispose).toHaveBeenCalledOnce();
    expect(context.handles[0].ended).toBe("closed");
  });

  it("revalidates authenticated configuration after resume ACK before releasing inert", async () => {
    const context = setup();
    await context.controller.open("https://upstream.example/");
    const retained = lastBroker;
    retained.activate();
    context.wire.closed(context.handles[0].subscriptionId, "expired");
    retained.instance.resume = vi.fn(async () => {
      changeAuthority(context, "removed");
      return { kind: "resumed", previous: 1, generation: 2, documentPreserved: true } as const;
    });
    await context.controller.resume();
    expect(context.controller.getSnapshot().phase).toBe("unavailable");
    expect(retained.frame.inert).toBe(true);
    expect(retained.dispose).toHaveBeenCalledOnce();
    expect(context.handles[1].ended).toBe("closed");
  });

  it("unsubscribes on Stop and rearms observers on the next open", async () => {
    const context = setup();
    await context.controller.open("https://upstream.example/");
    expect(context.statusListeners.size).toBe(1);
    expect(context.connectionListeners.size).toBe(1);
    context.controller.stop();
    expect(context.statusListeners.size).toBe(0);
    expect(context.connectionListeners.size).toBe(0);
    changeAuthority(context, "removed");
    context.emitServerInfo();
    expect(context.controller.getSnapshot().phase).toBe("closed");
    restoreAuthority(context);
    await context.controller.open("https://upstream.example/");
    expect(context.statusListeners.size).toBe(1);
    expect(context.connectionListeners.size).toBe(1);
    changeAuthority(context, "unsupported");
    context.emitServerInfo();
    expect(context.controller.getSnapshot().phase).toBe("unavailable");
    expect(context.handles[1].ended).toBe("closed");
  });

  it("preserves the view on synchronous connection loss and ignores unchanged server info", async () => {
    const context = setup();
    await context.controller.open("https://upstream.example/");
    const retained = lastBroker;
    retained.activate();
    context.emitServerInfo();
    expect(context.controller.getSnapshot().phase).toBe("active");
    expect(context.handles[0].ended).toBeNull();
    context.client.getConnectionState.mockReturnValue({ status: "disconnected" });
    for (const listener of context.connectionListeners)
      listener(context.client.getConnectionState());
    expect(context.controller.getSnapshot()).toMatchObject({ phase: "suspended", canResume: true });
    expect(retained.frame.inert).toBe(true);
    expect(retained.dispose).not.toHaveBeenCalled();
    expect(retained.purge).not.toHaveBeenCalled();
    expect(context.handles[0].ended).toBe("closed");
    context.client.getConnectionState.mockReturnValue({ status: "connected" });
    for (const listener of context.connectionListeners)
      listener(context.client.getConnectionState());
    expect(context.controller.getSnapshot().phase).toBe("suspended");
    await context.controller.resume();
    expect(context.controller.getSnapshot().phase).toBe("active");
    expect(retained.frame.inert).toBe(false);
    expect(retained.dispose).not.toHaveBeenCalled();
  });

  it.each(authorityChanges)(
    "fences an active view synchronously when authority is %s",
    async (change) => {
      const context = setup();
      await context.controller.open("https://upstream.example/");
      const retained = lastBroker;
      retained.activate();
      changeAuthority(context, change);
      context.emitServerInfo();
      expect(context.controller.getSnapshot().phase).toBe("unavailable");
      expect(retained.frame.inert).toBe(true);
      expect(retained.dispose).toHaveBeenCalledOnce();
      expect(context.handles[0].ended).toBe("closed");
      expect(retained.purge).not.toHaveBeenCalled();
      expect(context.client.requestNetworkFetchCleanup).not.toHaveBeenCalled();
    },
  );

  it("refuses missing or stale authenticated configuration and another selected host", async () => {
    const context = setup();
    const missing = createWebProxyProductController({ ...context.options, configuration: null });
    await missing.open("https://upstream.example/");
    const wrongHost = createWebProxyProductController({
      ...context.options,
      view: { ...context.options.view, serverId: "other-host" },
    });
    await wrongHost.open("https://upstream.example/");
    context.client.getLastServerInfoMessage.mockReturnValue({
      status: "server_info",
      serverId: "host",
      hostname: null,
      version: null,
    });
    await context.controller.open("https://upstream.example/");
    expect(missing.getSnapshot().error).toEqual({ code: "invalid_configuration" });
    expect(wrongHost.getSnapshot().error).toEqual({ code: "invalid_configuration" });
    expect(context.controller.getSnapshot().error).toEqual({ code: "invalid_configuration" });
    expect(context.client.resolveNetworkFetchDestination).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it("does not call the SDK when the host capability is absent", async () => {
    const context = setup();
    context.client.isNetworkFetchSupported.mockReturnValue(false);
    await context.controller.open("https://upstream.example/");
    expect(context.controller.getSnapshot().error).toEqual({ code: "unsupported_capability" });
    expect(context.client.resolveNetworkFetchDestination).not.toHaveBeenCalled();
  });

  it("rejects a content origin or asset version inconsistent with the authenticated configuration", async () => {
    const context = setup();
    context.client.resolveNetworkFetchDestination.mockResolvedValue({
      ...descriptor,
      contentOrigin: location.origin,
    });
    await context.controller.open("https://upstream.example/");
    expect(context.controller.getSnapshot().error).toEqual({ code: "invalid_configuration" });
    context.client.resolveNetworkFetchDestination.mockResolvedValue({
      ...descriptor,
      assetVersion: "other-assets",
    });
    await context.controller.open("https://upstream.example/");
    expect(context.controller.getSnapshot().error).toEqual({ code: "invalid_configuration" });
    expect(context.client.openNetworkFetch).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it("rejects content under the control hostname", async () => {
    const context = setup();
    const overlapping = { ...configuration, dedicatedContentDomain: location.hostname };
    context.client.getLastServerInfoMessage.mockReturnValue({
      status: "server_info",
      serverId: "host",
      hostname: null,
      version: null,
      networkFetchConfiguration: overlapping,
    });
    context.client.resolveNetworkFetchDestination.mockResolvedValue({
      ...descriptor,
      contentOrigin: `https://${destinationId}.${location.hostname}`,
    });
    const controller = createWebProxyProductController({
      ...context.options,
      configuration: overlapping,
    });
    await controller.open("https://upstream.example/");
    expect(controller.getSnapshot().error).toEqual({ code: "invalid_configuration" });
    expect(context.client.openNetworkFetch).not.toHaveBeenCalled();
  });

  it.each([Infinity, NaN, 0, 2147483648])(
    "rejects nonfinite or out-of-range TTL %s",
    async (ttlMs) => {
      const context = setup();
      const controller = createWebProxyProductController({
        ...context.options,
        configuration: { ...configuration, ttlMs },
      });
      await controller.open("https://upstream.example/");
      expect(controller.getSnapshot().error).toEqual({ code: "invalid_configuration" });
      expect(context.client.resolveNetworkFetchDestination).not.toHaveBeenCalled();
    },
  );

  it("does not mount when host configuration changes during admission", async () => {
    const context = setup();
    const originalOpen = context.client.openNetworkFetch.getMockImplementation();
    if (originalOpen === undefined) throw new Error("Missing test implementation");
    context.client.openNetworkFetch.mockImplementation(async () => {
      const handle = await originalOpen();
      context.client.getLastServerInfoMessage.mockReturnValue({
        status: "server_info",
        serverId: "host",
        hostname: null,
        version: null,
      });
      return handle;
    });
    await context.controller.open("https://upstream.example/");
    expect(context.controller.getSnapshot().error).toEqual({ code: "invalid_configuration" });
    expect(context.handles[0].ended).toBe("closed");
    expect(attach).not.toHaveBeenCalled();
  });

  it("persists a cleanup fence when the host refuses open after a successful reconciliation", async () => {
    const context = setup();
    context.client.openNetworkFetch.mockRejectedValue(
      new NetworkFetchRpcError("open", "cleanup_pending"),
    );
    await context.controller.open("https://upstream.example/");
    expect(context.controller.getSnapshot()).toMatchObject({
      phase: "cleanup_pending",
      cleanup: { status: "pending_local" },
    });
    expect(await context.persistence.read({ serverId: "host", destinationId })).toMatchObject({
      status: "cleanup_pending",
    });
    expect(attach).not.toHaveBeenCalled();
  });

  it("persists revocation delivered in the same turn as open", async () => {
    const context = setup();
    const originalOpen = context.client.openNetworkFetch.getMockImplementation();
    if (originalOpen === undefined) throw new Error("Missing test implementation");
    context.client.openNetworkFetch.mockImplementation(async () => {
      const handle = await originalOpen();
      context.wire.closed(handle.subscriptionId, "revoked");
      return handle;
    });
    await context.controller.open("https://upstream.example/");
    expect(context.controller.getSnapshot().phase).toBe("cleanup_pending");
    expect(await context.persistence.read({ serverId: "host", destinationId })).toMatchObject({
      status: "cleanup_pending",
    });
    expect(attach).not.toHaveBeenCalled();
  });

  it("reconciles a conflicting cleanup epoch without silently issuing a new request", async () => {
    const context = setup();
    await context.controller.open("https://upstream.example/");
    context.client.requestNetworkFetchCleanup.mockRejectedValue(
      new NetworkFetchRpcError("request_cleanup", "epoch_conflict"),
    );
    context.client.reconcileNetworkFetchDestination.mockResolvedValue({
      descriptor: { ...descriptor, authorityEpoch: "7", cleanupRequiredEpoch: "7" },
      state: "revoked",
      cleanupRequiredEpoch: "7",
    });
    await context.controller.requestClear();
    expect(context.client.requestNetworkFetchCleanup).toHaveBeenCalledExactlyOnceWith({
      destinationId,
      expectedAuthorityEpoch: "5",
    });
    expect(context.client.reconcileNetworkFetchDestination).toHaveBeenCalledTimes(2);
    expect(context.controller.getSnapshot()).toMatchObject({
      phase: "cleanup_pending",
      cleanup: { status: "pending_host", requiredEpoch: "7" },
    });
    expect(await context.persistence.read({ serverId: "host", destinationId })).toMatchObject({
      authorityEpoch: "7",
      cleanupRequestBaseEpoch: "5",
      status: "cleanup_pending",
    });
  });

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

  it("reconciles before navigating the initial URL and publishes only observed metadata", async () => {
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
      url: "https://upstream.example/path?private=value",
      title: "Observed document",
      canNavigate: true,
      canReload: true,
      canGoBack: false,
      canGoForward: false,
      error: null,
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
