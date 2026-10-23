import { NetworkFetchRpcError } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  NetworkFetchConfigurationSchema,
  NetworkFetchDescriptorSchema,
  type NetworkFetchConfiguration,
  type NetworkFetchDescriptor,
} from "@getpaseo/protocol/network-fetch/rpc-schemas";
import { attachWebProxyBroker, type WebProxyBroker, type WebProxyBrokerState } from "./broker.web";
import { createDaemonFetchChannel } from "./daemon-fetch-channel.web";
import {
  openNetworkFetchTransport,
  type NetworkFetchTransport,
  type NetworkFetchTransportClosedReason,
} from "./network-fetch-transport";
import {
  createWebProxyProductPersistence,
  WebProxyProductPersistenceError,
  type WebProxyProductPersistence,
  type WebProxyProductRecord,
} from "./product-persistence.web";
import {
  createWebProxyProductRegistry,
  type WebProxyProductRegistry,
} from "./product-registry.web";
import { createCapability, resolveDestinationUrl, type WebProxyCapability } from "./request-policy";
import type {
  WebProxyProductController,
  WebProxyProductErrorCode,
  WebProxyProductSnapshot,
  WebProxyProductViewIdentity,
} from "./product-types";

export type WebProxyProductConfiguration = NetworkFetchConfiguration;

export type WebProxyProductClient = Pick<
  DaemonClient,
  | "isNetworkFetchSupported"
  | "getConnectionState"
  | "getLastServerInfoMessage"
  | "resolveNetworkFetchDestination"
  | "reconcileNetworkFetchDestination"
  | "requestNetworkFetchCleanup"
  | "openNetworkFetch"
>;

export interface WebProxyProductResources {
  persistence: WebProxyProductPersistence;
  registry: WebProxyProductRegistry;
}

export interface WebProxyProductControllerOptions {
  client: WebProxyProductClient;
  container: HTMLElement;
  view: WebProxyProductViewIdentity;
  enabled?: boolean;
  configuration: WebProxyProductConfiguration | null;
  persistence?: WebProxyProductPersistence;
  registry?: WebProxyProductRegistry;
}

let sharedResources: WebProxyProductResources | null = null;

export function getWebProxyProductResources(): WebProxyProductResources {
  if (sharedResources === null) {
    sharedResources = {
      persistence: createWebProxyProductPersistence(),
      registry: createWebProxyProductRegistry(),
    };
  }
  return sharedResources;
}

class ProductError extends Error {
  constructor(readonly code: WebProxyProductErrorCode) {
    super(`Web proxy product: ${code}`);
  }
}

function errorCode(error: unknown): WebProxyProductErrorCode {
  if (error instanceof ProductError || error instanceof NetworkFetchRpcError) return error.code;
  if (error instanceof WebProxyProductPersistenceError) return "persistence_unavailable";
  return "protocol_error";
}

function initialSnapshot(): WebProxyProductSnapshot {
  return {
    phase: "unavailable",
    url: null,
    title: null,
    canNavigate: false,
    canReload: false,
    canGoBack: false,
    canGoForward: false,
    canResume: false,
    canRequestClear: false,
    error: null,
    cleanup: { status: "unknown", requiredEpoch: null },
  };
}

export function createWebProxyProductController(
  options: WebProxyProductControllerOptions,
): WebProxyProductController {
  const client = options.client;
  const persistence = options.persistence ?? getWebProxyProductResources().persistence;
  const registry = options.registry ?? getWebProxyProductResources().registry;
  const listeners = new Set<() => void>();
  let snapshot = initialSnapshot();
  let generation = 0;
  let brokerVersion = 0;
  let descriptor: NetworkFetchDescriptor | null = null;
  let record: WebProxyProductRecord | null = null;
  let broker: WebProxyBroker | null = null;
  let transport: NetworkFetchTransport | null = null;
  let releaseView = () => {};
  let clearing: Promise<void> | null = null;
  let persistenceFailed = false;

  function publish(change: Partial<WebProxyProductSnapshot>): void {
    snapshot = { ...snapshot, ...change };
    for (const listener of listeners) listener();
  }

  function requireConfiguration(): NetworkFetchConfiguration {
    if (options.enabled !== true) throw new ProductError("disabled");
    if (client.getConnectionState().status !== "connected") throw new ProductError("channel_lost");
    if (!client.isNetworkFetchSupported()) throw new ProductError("unsupported_capability");
    const info = client.getLastServerInfoMessage();
    if (info?.serverId !== options.view.serverId) throw new ProductError("invalid_configuration");
    const supplied = NetworkFetchConfigurationSchema.safeParse(options.configuration);
    const current = NetworkFetchConfigurationSchema.safeParse(info.networkFetchConfiguration);
    if (!supplied.success || !current.success) throw new ProductError("invalid_configuration");
    if (JSON.stringify(supplied.data) !== JSON.stringify(current.data)) {
      throw new ProductError("invalid_configuration");
    }
    const configuration = supplied.data;
    const path = configuration.bootstrapPath;
    const invalidPath = !path.startsWith("/") || path.startsWith("//") || /[\\\s?#]/.test(path);
    if (invalidPath) throw new ProductError("invalid_configuration");
    return configuration;
  }

  function validateDescriptor(
    candidate: NetworkFetchDescriptor,
    configuration: NetworkFetchConfiguration,
  ): WebProxyCapability {
    const parsed = NetworkFetchDescriptorSchema.safeParse(candidate);
    if (!parsed.success) throw new ProductError("protocol_error");
    const control = new URL(options.container.ownerDocument.location.href);
    const expectedOrigin = `https://${candidate.destinationId}.${configuration.dedicatedContentDomain}`;
    const content = new URL(candidate.contentOrigin);
    const sameSiteSuffix =
      content.hostname.split(".").slice(-2).join(".") ===
      control.hostname.split(".").slice(-2).join(".");
    const overlappingDomain =
      content.hostname.endsWith(`.${control.hostname}`) ||
      control.hostname === configuration.dedicatedContentDomain ||
      control.hostname.endsWith(`.${configuration.dedicatedContentDomain}`);
    const invalidContent =
      content.origin !== expectedOrigin ||
      candidate.contentOrigin !== content.origin ||
      content.origin === control.origin ||
      sameSiteSuffix ||
      overlappingDomain ||
      candidate.assetVersion !== configuration.assetVersion;
    if (invalidContent) throw new ProductError("invalid_configuration");
    if (new URL(configuration.bootstrapPath, content.origin).origin !== content.origin) {
      throw new ProductError("invalid_configuration");
    }
    return createCapability({
      contentOrigin: content.origin,
      destinationOrigin: candidate.origin,
      pathPrefix: candidate.pathPrefix,
    });
  }

  function asRecord(current: NetworkFetchDescriptor): WebProxyProductRecord {
    return {
      version: 1,
      serverId: options.view.serverId,
      destinationId: current.destinationId,
      authorityEpoch: current.authorityEpoch,
      cleanupRequiredEpoch: current.cleanupRequiredEpoch,
      cleanupRequestBaseEpoch: null,
      status: current.cleanupRequiredEpoch === null ? "observed" : "cleanup_pending",
      assetVersion: current.assetVersion,
    };
  }

  function publishRecord(stored: WebProxyProductRecord): void {
    const pending = stored.status === "cleanup_pending";
    let status: WebProxyProductSnapshot["cleanup"]["status"] = "not_requested";
    if (pending) status = stored.cleanupRequiredEpoch === null ? "pending_local" : "pending_host";
    publish({ cleanup: { status, requiredEpoch: stored.cleanupRequiredEpoch } });
  }

  function detach(): void {
    brokerVersion += 1;
    const previousTransport = transport;
    const previousBroker = broker;
    transport = null;
    broker = null;
    previousTransport?.close();
    previousBroker?.dispose();
  }

  function report(error: unknown): void {
    const code = errorCode(error);
    if (
      code === "cleanup_pending" &&
      descriptor !== null &&
      !registry.isFenced({
        serverId: options.view.serverId,
        destinationId: descriptor.destinationId,
      })
    ) {
      fence(descriptor);
    }
    if (code === "persistence_unavailable") {
      persistenceFailed = true;
      if (
        descriptor !== null &&
        !registry.isFenced({
          serverId: options.view.serverId,
          destinationId: descriptor.destinationId,
        })
      ) {
        fence(descriptor);
      }
    }
    const cleanupPending =
      snapshot.cleanup.status === "pending_local" || snapshot.cleanup.status === "pending_host";
    let phase: WebProxyProductSnapshot["phase"] = "blocked";
    if (cleanupPending) phase = "cleanup_pending";
    else if (
      code === "disabled" ||
      code === "unsupported_capability" ||
      code === "invalid_configuration"
    ) {
      phase = "unavailable";
    }
    publish({ phase, error: { code }, canResume: false });
  }

  function persistFence(current: NetworkFetchDescriptor): void {
    void persistence
      .merge({ ...asRecord(current), status: "cleanup_pending" })
      .then((stored) => {
        if (descriptor?.destinationId === current.destinationId) {
          record = stored;
          publishRecord(stored);
        }
        return stored;
      })
      .catch((error: unknown) => {
        if (descriptor?.destinationId === current.destinationId) report(error);
      });
  }

  function bind(current: NetworkFetchDescriptor): void {
    releaseView();
    releaseView = registry.register({
      view: options.view,
      destinationId: current.destinationId,
      invalidate(event) {
        generation += 1;
        if (event.reason === "cleanup_pending") {
          detach();
          publish({
            phase: "cleanup_pending",
            canResume: false,
            error: { code: "cleanup_pending" },
            cleanup: { status: "pending_local", requiredEpoch: snapshot.cleanup.requiredEpoch },
          });
          persistFence(current);
        } else suspend("channel_lost");
      },
    });
  }

  function fence(current: NetworkFetchDescriptor): void {
    registry.invalidate({
      version: 1,
      serverId: options.view.serverId,
      destinationId: current.destinationId,
      reason: "cleanup_pending",
    });
  }

  function suspend(reason: "channel_lost" | "expired"): void {
    generation += 1;
    const previous = transport;
    transport = null;
    previous?.close();
    const suspended = broker?.suspend(reason) ?? false;
    const frame = broker?.getFrame();
    if (frame) frame.inert = true;
    publish({ phase: "suspended", error: { code: reason }, canResume: suspended });
  }

  function onTransportClosed(reason: NetworkFetchTransportClosedReason): void {
    if (reason === "channel_lost" || reason === "expired") {
      suspend(reason);
      return;
    }
    if (reason === "revoked" || reason === "allowlist_changed") {
      if (descriptor !== null) fence(descriptor);
      return;
    }
    generation += 1;
    detach();
    publish({
      phase: "closed",
      canResume: false,
      error: reason === "protocol_error" ? { code: "protocol_error" } : null,
    });
  }

  async function reconcile(
    current: NetworkFetchDescriptor,
    configuration: NetworkFetchConfiguration,
    ticket: number,
  ): Promise<NetworkFetchDescriptor | null> {
    const key = { serverId: options.view.serverId, destinationId: current.destinationId };
    const stored = await persistence.read(key);
    if (ticket !== generation) return null;
    record = stored;
    if (stored !== null) publishRecord(stored);
    const knownEpoch = stored?.authorityEpoch ?? current.authorityEpoch;
    const result = await client.reconcileNetworkFetchDestination({
      destinationId: current.destinationId,
      knownEpoch,
    });
    if (ticket !== generation) return null;
    requireConfiguration();
    validateDescriptor(result.descriptor, configuration);
    const matches =
      result.descriptor.destinationId === current.destinationId &&
      result.descriptor.origin === current.origin &&
      result.descriptor.pathPrefix === current.pathPrefix;
    if (!matches) throw new ProductError("protocol_error");
    if (BigInt(result.descriptor.authorityEpoch) < BigInt(knownEpoch))
      throw new ProductError("epoch_conflict");
    const pending =
      result.state !== "active" ||
      result.cleanupRequiredEpoch !== null ||
      stored?.status === "cleanup_pending" ||
      registry.isFenced(key);
    const next = asRecord(result.descriptor);
    record = await persistence.merge({
      ...next,
      status: pending ? "cleanup_pending" : next.status,
    });
    if (ticket !== generation) return null;
    descriptor = result.descriptor;
    publishRecord(record);
    if (record.status === "cleanup_pending") {
      fence(result.descriptor);
      report(new ProductError("cleanup_pending"));
      return null;
    }
    if (persistenceFailed) throw new ProductError("persistence_unavailable");
    return result.descriptor;
  }

  async function openTransport(
    current: NetworkFetchDescriptor,
    ticket: number,
  ): Promise<NetworkFetchTransport | null> {
    const configuration = requireConfiguration();
    const capability = validateDescriptor(current, configuration);
    let admissionError: WebProxyProductErrorCode | null = null;
    let earlyClose: NetworkFetchTransportClosedReason | null = null;
    let ready = false;
    const channel = createDaemonFetchChannel({
      client,
      descriptor: current,
      onError(code) {
        admissionError = code;
      },
    });
    try {
      const opened = await openNetworkFetchTransport({
        channel,
        capability,
        ttlMs: configuration.ttlMs,
        limits: {},
        onClosed(reason) {
          if (!ready) earlyClose = reason;
          else if (ticket === generation) onTransportClosed(reason);
        },
      });
      if (ticket !== generation) {
        opened.close();
        return null;
      }
      if (earlyClose !== null) {
        opened.close();
        throw new ProductError(admissionError ?? "channel_lost");
      }
      requireConfiguration();
      ready = true;
      return opened;
    } catch (error) {
      channel.close();
      const revoked = earlyClose === "revoked" || earlyClose === "allowlist_changed";
      if (revoked && ticket === generation) {
        fence(current);
        throw new ProductError("cleanup_pending");
      }
      if (admissionError !== null) throw new ProductError(admissionError);
      if (earlyClose === "expired") throw new ProductError("expired");
      throw error;
    }
  }

  function onBrokerState(state: WebProxyBrokerState, version: number): void {
    if (version !== brokerVersion) return;
    if (state.status === "granted") {
      publish({ phase: "active", error: { code: "navigation_unavailable" }, canResume: false });
    } else if (state.status === "failed" || state.status === "revoked") {
      generation += 1;
      detach();
      report(new ProductError("protocol_error"));
    }
  }

  async function open(url: string): Promise<void> {
    generation += 1;
    const ticket = generation;
    detach();
    releaseView();
    publish({ phase: "opening", error: null, canResume: false });
    try {
      const configuration = requireConfiguration();
      if (persistenceFailed) throw new ProductError("persistence_unavailable");
      if (url.length > 8192 || !URL.canParse(url)) throw new ProductError("invalid_url");
      const target = new URL(url);
      const validTarget =
        (target.protocol === "http:" || target.protocol === "https:") &&
        !target.username &&
        !target.password;
      if (!validTarget) throw new ProductError("invalid_url");
      const resolved = await client.resolveNetworkFetchDestination({
        origin: target.origin,
        pathPrefix: configuration.pathPrefix,
      });
      if (ticket !== generation) return;
      const capability = validateDescriptor(resolved, configuration);
      if (resolved.origin !== target.origin || resolved.pathPrefix !== configuration.pathPrefix) {
        throw new ProductError("protocol_error");
      }
      if (resolveDestinationUrl(capability, target.pathname + target.search).kind !== "ok") {
        throw new ProductError("scope_not_allowlisted");
      }
      descriptor = resolved;
      record = null;
      bind(resolved);
      publish({ canRequestClear: true });
      const reconciled = await reconcile(resolved, configuration, ticket);
      if (reconciled === null || ticket !== generation) return;
      const opened = await openTransport(reconciled, ticket);
      if (opened === null || ticket !== generation) return;
      transport = opened;
      requireConfiguration();
      const version = ++brokerVersion;
      broker = attachWebProxyBroker({
        capability: validateDescriptor(reconciled, configuration),
        transport: opened,
        container: options.container,
        bootstrapPath: configuration.bootstrapPath,
        handshakeTimeoutMs: configuration.handshakeTimeoutMs,
        onStateChange: (state) => onBrokerState(state, version),
      });
    } catch (error) {
      if (ticket !== generation) return;
      generation += 1;
      detach();
      report(error);
    }
  }

  async function resume(): Promise<void> {
    if (broker === null || descriptor === null || broker.getState().status !== "suspended") {
      report(new ProductError("resume_failed"));
      return;
    }
    generation += 1;
    const ticket = generation;
    const retained = broker;
    const previousDescriptor = descriptor;
    publish({ phase: "opening", canResume: false, error: null });
    try {
      const configuration = requireConfiguration();
      const reconciled = await reconcile(previousDescriptor, configuration, ticket);
      if (reconciled === null || ticket !== generation) return;
      const compatible =
        reconciled.contentOrigin === previousDescriptor.contentOrigin &&
        reconciled.assetVersion === previousDescriptor.assetVersion;
      if (!compatible) throw new ProductError("invalid_configuration");
      const opened = await openTransport(reconciled, ticket);
      if (opened === null || ticket !== generation) return;
      transport = opened;
      const result = await retained.resume({ transport: opened });
      if (ticket !== generation) return;
      if (result.kind !== "resumed") throw new ProductError("resume_failed");
      const frame = retained.getFrame();
      if (frame) frame.inert = false;
      publish({ phase: "active", error: { code: "navigation_unavailable" }, canResume: false });
    } catch (error) {
      if (ticket !== generation) return;
      generation += 1;
      const previous = transport;
      transport = null;
      previous?.close();
      report(error);
    }
  }

  async function clear(): Promise<void> {
    const current = descriptor;
    if (current === null) {
      report(new ProductError("identity_unavailable"));
      return;
    }
    generation += 1;
    detach();
    fence(current);
    publish({
      phase: "cleanup_pending",
      canResume: false,
      error: null,
      cleanup: { status: "pending_local", requiredEpoch: snapshot.cleanup.requiredEpoch },
    });
    try {
      const stored = await persistence.merge({
        ...asRecord(current),
        status: "cleanup_pending",
        cleanupRequestBaseEpoch: record?.cleanupRequestBaseEpoch ?? current.authorityEpoch,
      });
      if (descriptor?.destinationId === current.destinationId) {
        record = stored;
        publishRecord(stored);
      }
      const expectedAuthorityEpoch = stored.cleanupRequestBaseEpoch;
      if (expectedAuthorityEpoch === null) throw new ProductError("persistence_unavailable");
      const result = await client.requestNetworkFetchCleanup({
        destinationId: current.destinationId,
        expectedAuthorityEpoch,
      });
      const pending = await persistence.merge({
        ...stored,
        authorityEpoch: result.authorityEpoch,
        cleanupRequiredEpoch: result.cleanupRequiredEpoch,
      });
      if (descriptor?.destinationId === current.destinationId) {
        descriptor = {
          ...current,
          authorityEpoch: result.authorityEpoch,
          cleanupRequiredEpoch: result.cleanupRequiredEpoch,
        };
        record = pending;
        publishRecord(pending);
        publish({ phase: "cleanup_pending", error: null });
      }
    } catch (error) {
      if (error instanceof NetworkFetchRpcError && error.code === "epoch_conflict") {
        try {
          const result = await client.reconcileNetworkFetchDestination({
            destinationId: current.destinationId,
            knownEpoch: current.authorityEpoch,
          });
          const pending = await persistence.merge({
            ...asRecord(result.descriptor),
            status: "cleanup_pending",
          });
          if (descriptor?.destinationId === current.destinationId) {
            descriptor = result.descriptor;
            record = pending;
            publishRecord(pending);
          }
        } catch (reconciliationError) {
          if (descriptor?.destinationId === current.destinationId) report(reconciliationError);
          return;
        }
      }
      if (descriptor?.destinationId === current.destinationId) report(error);
    }
  }

  function closeView(): void {
    generation += 1;
    detach();
    releaseView();
    publish({ phase: "closed", canResume: false });
  }

  function navigationUnavailable(): Promise<void> {
    publish({ error: { code: "navigation_unavailable" } });
    return Promise.resolve();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    open,
    navigate: navigationUnavailable,
    reload: navigationUnavailable,
    goBack: navigationUnavailable,
    goForward: navigationUnavailable,
    stop: closeView,
    closeView,
    resume,
    requestClear() {
      if (clearing !== null) return clearing;
      clearing = clear().finally(() => {
        clearing = null;
      });
      return clearing;
    },
  };
}
