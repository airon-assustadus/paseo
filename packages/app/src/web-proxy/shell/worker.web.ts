import {
  isBridgeMethod,
  parseControlMessage,
  type BridgeErrorCode,
  type BridgeErrorReason,
  type BridgeHeaders,
  type BridgeRequestMode,
  type ControlMessage,
  type ResponseHeadMessage,
} from "../bridge-messages";
import {
  createClientBinding,
  type BindingRefusal,
  type BindingRoute,
  type ShellClients,
  type ShellMessageInput,
} from "./client-binding.web";
import type { ShellDropCause, ShellFetchMessage, ShellRequestMessage } from "./relay-messages";

export interface ShellWorkerConfig {
  controlOrigin: string;
  // Served by the static shell host (bootstrap, worker). Checked before mountPath.
  shellPathPrefix: string;
  bootstrapPath: string;
  // Where a bootstrap points its app frame with a ticket; must be inside the worker's scope.
  enterPath: string;
  // Content path prefix that maps 1:1 onto the destination's root. "/" in a deployment.
  mountPath: string;
  headTimeoutMs: number;
  idleChunkTimeoutMs: number;
  maxRequestBodyBytes: number;
  ticketTtlMs: number;
  formationTtlMs: number;
  resyncTimeoutMs: number;
}

export interface ShellFetchInput {
  request: Request;
  clientId: string;
  resultingClientId: string;
}

export interface ShellWorker {
  fetch(input: ShellFetchInput): ShellFetchDecision;
  message(input: ShellMessageInput): void;
}

export type ShellFetchDecision =
  | { kind: "network" }
  | { kind: "respond"; response: Promise<Response> };

export type ShellFailureCode =
  | "session_unavailable"
  | "client_not_admitted"
  | "client_limit"
  | "ticket_rejected"
  | "session_revoked"
  | "bridge_timeout"
  | "bridge_error"
  | "body_too_large"
  | "method_not_allowed"
  | "embedding_refused";

export class ShellBridgeTimeoutError extends Error {
  constructor() {
    super("Web proxy bridge stopped sending the response body");
    this.name = "ShellBridgeTimeoutError";
  }
}

export class ShellBridgeClosedError extends Error {
  constructor(
    readonly code: ShellFailureCode | BridgeErrorCode,
    readonly reason: BridgeErrorReason | null = null,
  ) {
    super(`Web proxy bridge ended the response: ${code}`);
    this.name = "ShellBridgeClosedError";
  }
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function failureResponse(
  status: number,
  code: ShellFailureCode | BridgeErrorCode,
  reason: BridgeErrorReason | null = null,
): Response {
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-paseo-web-proxy-error": code,
  });
  if (reason !== null) headers.set("x-paseo-web-proxy-reason", reason);
  const detail = reason === null ? code : `${code} (${reason})`;
  return new Response(`Paseo web proxy: ${detail}\n`, { status, headers });
}

// Mitigation only: self-navigation, WebRTC and prefetch are outside what CSP governs.
// frame-ancestors admits exactly the chain control (C) → bootstrap (K) → app (K): every
// ancestor must match, so a foreign page anywhere above the app blocks it.
function shellPolicy(controlOrigin: string): string {
  return [
    "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `frame-ancestors 'self' ${controlOrigin}`,
  ].join("; ");
}

async function readBody(
  request: Request,
  limit: number,
): Promise<ArrayBuffer | null | "too_large"> {
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return "too_large";
    }
    parts.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return body.buffer;
}

interface BodyQueue {
  chunks: ArrayBuffer[];
  ended: boolean;
  failure: Error | null;
  wake: (() => void) | null;
}

// Pull-driven: credit goes back to the broker only as the page consumes bytes, so the queue
// here never exceeds the broker's window.
function createBodyStream(input: {
  port: MessagePort;
  queue: BodyQueue;
  idleChunkTimeoutMs: number;
}): ReadableStream<Uint8Array> {
  const { port, queue } = input;

  function post(message: ShellRequestMessage): void {
    port.postMessage(message);
  }

  function waitForData(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        queue.wake = null;
        reject(new ShellBridgeTimeoutError());
      }, input.idleChunkTimeoutMs);
      queue.wake = () => {
        clearTimeout(timer);
        queue.wake = null;
        resolve();
      };
    });
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (queue.chunks.length === 0 && !queue.ended && queue.failure === null) {
        try {
          await waitForData();
        } catch (error) {
          post({ type: "paseo.shell.cancel" });
          port.close();
          throw error;
        }
      }
      const chunk = queue.chunks.shift();
      if (chunk !== undefined) {
        controller.enqueue(new Uint8Array(chunk));
        post({ type: "paseo.shell.ack", bytes: chunk.byteLength });
        return;
      }
      port.close();
      if (queue.failure !== null) throw queue.failure;
      controller.close();
    },
    cancel() {
      post({ type: "paseo.shell.cancel" });
      port.close();
    },
  });
}

// The destination's own policy stays in force; when it forbids being framed it would also
// forbid the chain above, so the page is refused with a reason instead of a blank frame.
function refusesEmbedding(headers: Headers): boolean {
  if (headers.has("x-frame-options")) return true;
  const policies = headers.get("content-security-policy");
  if (policies === null) return false;
  const directives = policies.split(/[,;]/).map((directive) => directive.trim().split(/\s+/));
  return directives.some(
    ([name, ...sources]) =>
      name?.toLowerCase() === "frame-ancestors" && !(sources.length === 1 && sources[0] === "*"),
  );
}

function mapLocation(headers: Headers, mountPath: string): void {
  const location = headers.get("location");
  if (location?.startsWith("/")) headers.set("location", `${mountPath}${location.slice(1)}`);
}

function awaitResponse(input: {
  port: MessagePort;
  method: string;
  mode: BridgeRequestMode;
  // A navigation on a binding armed when it started: losing its head keeps the document.
  isProtected: boolean;
  config: ShellWorkerConfig;
}): Promise<Response> {
  const { port, config } = input;
  const queue: BodyQueue = { chunks: [], ended: false, failure: null, wake: null };
  let phase: "head" | "body" | "done" = "head";
  let headTimer: ReturnType<typeof setTimeout> | null = null;

  const { promise, resolve } = Promise.withResolvers<Response>();

  // The only place the response settles: either a head or a failure, never both.
  function settle(response: Response, next: "body" | "done"): void {
    if (headTimer !== null) clearTimeout(headTimer);
    headTimer = null;
    phase = next;
    if (next === "done") port.close();
    resolve(response);
  }

  function fail(
    status: number,
    code: ShellFailureCode | BridgeErrorCode,
    reason: BridgeErrorReason | null = null,
  ): void {
    settle(failureResponse(status, code, reason), "done");
  }

  function failBody(
    code: ShellFailureCode | BridgeErrorCode,
    reason: BridgeErrorReason | null = null,
  ): void {
    queue.failure = new ShellBridgeClosedError(code, reason);
    queue.wake?.();
  }

  function onHead(message: ResponseHeadMessage): void {
    const headers = new Headers(message.headers);
    if (input.mode === "navigate" && refusesEmbedding(headers)) {
      port.postMessage({ type: "paseo.shell.cancel" } satisfies ShellRequestMessage);
      settle(failureResponse(502, "embedding_refused"), "done");
      return;
    }
    mapLocation(headers, config.mountPath);
    headers.append("content-security-policy", shellPolicy(config.controlOrigin));
    headers.set("x-dns-prefetch-control", "off");
    headers.set("origin-agent-cluster", "?1");
    const init = { status: message.status, statusText: message.statusText, headers };
    const hasNoBody = input.method === "HEAD" || NULL_BODY_STATUSES.has(message.status);
    if (hasNoBody) {
      // Nothing will read a body: release the host request instead of leaving it in flight.
      port.postMessage({ type: "paseo.shell.cancel" } satisfies ShellRequestMessage);
      settle(new Response(null, init), "done");
      return;
    }
    const { idleChunkTimeoutMs } = config;
    settle(new Response(createBodyStream({ port, queue, idleChunkTimeoutMs }), init), "body");
  }

  function onBodyMessage(message: ControlMessage): void {
    if (message.type === "paseo.web.response.chunk") {
      queue.chunks.push(message.chunk);
      queue.wake?.();
    } else if (message.type === "paseo.web.response.end") {
      queue.ended = true;
      queue.wake?.();
    } else if (message.type === "paseo.web.revoke") {
      failBody("session_revoked");
    } else if (message.type === "paseo.web.response.error") {
      failBody(message.code, message.reason ?? null);
    } else {
      failBody("bridge_error");
    }
  }

  // A 204 aborts the navigation and the frame keeps its document; the bootstrap tells the control
  // that the result is unknown. Nothing is replayed.
  function drop(cause: ShellDropCause): void {
    port.postMessage({ type: "paseo.shell.request.dropped", cause } satisfies ShellRequestMessage);
    settle(new Response(null, { status: 204 }), "done");
  }

  function onHeadPhaseMessage(message: ControlMessage): void {
    if (message.type === "paseo.web.response.head") onHead(message);
    else if (message.type === "paseo.web.revoke") fail(502, "session_revoked");
    else if (message.type === "paseo.web.response.error") {
      if (input.isProtected && message.reason === "transport_closed") drop("transport_closed");
      else fail(502, message.code, message.reason ?? null);
    } else fail(502, "bridge_error");
  }

  headTimer = setTimeout(() => {
    // The bootstrap is gone, frozen or the broker stalled: say so instead of hanging.
    headTimer = null;
    if (input.isProtected) {
      drop("head_timeout");
      return;
    }
    port.postMessage({ type: "paseo.shell.cancel" } satisfies ShellRequestMessage);
    fail(504, "bridge_timeout");
  }, config.headTimeoutMs);

  port.addEventListener("message", (event) => {
    if (phase === "done") return;
    const message = parseControlMessage(event.data);
    if (phase === "body") {
      if (message === null) failBody("bridge_error");
      else onBodyMessage(message);
      return;
    }
    if (message === null) fail(502, "bridge_error");
    else onHeadPhaseMessage(message);
  });
  port.start();
  return promise;
}

function copyHeaders(headers: Headers): BridgeHeaders {
  const copied: BridgeHeaders = [];
  headers.forEach((value, name) => copied.push([name, value]));
  return copied;
}

function refusalResponse(code: BindingRefusal): Response {
  // A document outside the chain (top-level, other origin, unknown frame type) gets a network
  // error, like a request to another origin; known-but-refused clients get an explicit page.
  if (code === "foreign_client") return Response.error();
  if (code === "session_unavailable") return failureResponse(503, code);
  return failureResponse(403, code);
}

async function proxy(input: {
  fetch: ShellFetchInput;
  url: URL;
  config: ShellWorkerConfig;
  route: (fetch: ShellFetchInput) => Promise<BindingRoute>;
}): Promise<Response> {
  const { url, config } = input;
  const { request } = input.fetch;
  const route = await input.route(input.fetch);
  if (route.kind === "refused") return refusalResponse(route.code);
  const method = request.method;
  if (!isBridgeMethod(method)) return failureResponse(405, "method_not_allowed");
  const body = await readBody(request, config.maxRequestBodyBytes);
  if (body === "too_large") return failureResponse(413, "body_too_large");

  const channel = new MessageChannel();
  const mode = request.mode === "navigate" ? "navigate" : "subresource";
  const message: ShellFetchMessage = {
    type: "paseo.shell.fetch",
    request: {
      method,
      path: `/${url.pathname.slice(config.mountPath.length)}${url.search}`,
      headers: copyHeaders(request.headers),
      body,
      mode,
    },
  };
  const transfer: Transferable[] = body === null ? [channel.port2] : [channel.port2, body];
  const isProtected = mode === "navigate" && route.armed;
  const response = awaitResponse({ port: channel.port1, method, mode, isProtected, config });
  route.port.postMessage(message, transfer);
  return response;
}

export class InvalidShellWorkerConfigError extends Error {
  constructor(readonly field: keyof ShellWorkerConfig) {
    super(`Invalid shell worker config: ${field}`);
    this.name = "InvalidShellWorkerConfigError";
  }
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isDirectoryPath(value: string): boolean {
  return value.startsWith("/") && value.endsWith("/") && !value.startsWith("//");
}

// Zero, NaN or fractional values would turn every timer into an instant failure or a hang.
function validateShellWorkerConfig(config: ShellWorkerConfig): ShellWorkerConfig {
  const numbers = [
    "headTimeoutMs",
    "idleChunkTimeoutMs",
    "maxRequestBodyBytes",
    "ticketTtlMs",
    "formationTtlMs",
    "resyncTimeoutMs",
  ] as const;
  for (const field of numbers) {
    if (!isPositiveInteger(config[field])) throw new InvalidShellWorkerConfigError(field);
  }
  for (const field of ["shellPathPrefix", "mountPath"] as const) {
    if (!isDirectoryPath(config[field])) throw new InvalidShellWorkerConfigError(field);
  }
  if (!config.bootstrapPath.startsWith(config.shellPathPrefix)) {
    throw new InvalidShellWorkerConfigError("bootstrapPath");
  }
  const isEnterInScope =
    config.enterPath.startsWith(config.shellPathPrefix) ||
    config.enterPath.startsWith(config.mountPath);
  if (!isEnterInScope || config.enterPath === config.bootstrapPath) {
    throw new InvalidShellWorkerConfigError("enterPath");
  }
  if (
    !URL.canParse(config.controlOrigin) ||
    new URL(config.controlOrigin).origin !== config.controlOrigin
  ) {
    throw new InvalidShellWorkerConfigError("controlOrigin");
  }
  return config;
}

// The binding registry is the only state, and it is rebuilt from the live bootstraps when the
// browser restarts the worker; responses themselves carry nothing between events.
export function createShellWorker(input: {
  config: ShellWorkerConfig;
  clients: ShellClients;
  origin: string;
  now?: () => number;
}): ShellWorker {
  const config = validateShellWorkerConfig(input.config);
  const { origin } = input;
  const binding = createClientBinding({
    config: {
      origin,
      bootstrapPath: config.bootstrapPath,
      shellPathPrefix: config.shellPathPrefix,
      mountPath: config.mountPath,
      ticketTtlMs: config.ticketTtlMs,
      formationTtlMs: config.formationTtlMs,
      resyncTimeoutMs: config.resyncTimeoutMs,
    },
    clients: input.clients,
    now: input.now ?? Date.now,
  });

  function route(fetch: ShellFetchInput): Promise<BindingRoute> {
    if (fetch.request.mode === "navigate") return binding.routeNavigation(fetch);
    return binding.routeSubresource(fetch.clientId);
  }

  async function enter(fetch: ShellFetchInput, url: URL): Promise<Response> {
    const isNestedNavigation =
      fetch.request.mode === "navigate" && fetch.request.destination !== "document";
    const entered =
      isNestedNavigation && (await binding.enter({ ...fetch, ticket: url.searchParams.get("t") }));
    if (!entered) return failureResponse(403, "ticket_rejected");
    // Same-origin redirect: the next hop keeps resultingClientId and finds its reservation.
    return Response.redirect(`${origin}${config.mountPath}`, 302);
  }

  function respond(response: Promise<Response>): ShellFetchDecision {
    return { kind: "respond", response };
  }

  return {
    message: (message) => binding.handleMessage(message),
    fetch(fetch) {
      const url = new URL(fetch.request.url);
      // Nothing leaves the phone directly: other origins get a network error.
      if (url.origin !== origin) return respond(Promise.resolve(Response.error()));
      if (url.pathname === config.enterPath) return respond(enter(fetch, url));
      if (url.pathname.startsWith(config.shellPathPrefix)) return { kind: "network" };
      if (!url.pathname.startsWith(config.mountPath)) {
        return respond(Promise.resolve(Response.error()));
      }
      // A top-level document under the mount point is never part of a session.
      if (fetch.request.destination === "document") {
        return respond(Promise.resolve(Response.error()));
      }
      return respond(proxy({ fetch, url, config, route }));
    },
  };
}

interface ShellFetchEvent {
  request: Request;
  clientId: string;
  resultingClientId: string;
  respondWith(response: Promise<Response>): void;
}

interface ShellExtendableMessageEvent {
  data: unknown;
  source: { id: string } | null;
  ports: ReadonlyArray<MessagePort>;
}

interface ShellExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

interface ShellWorkerScope {
  location: { origin: string };
  clients: ShellClients;
  skipWaiting(): Promise<void>;
  addEventListener(type: "install", listener: (event: ShellExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: ShellFetchEvent) => void): void;
  addEventListener(type: "message", listener: (event: ShellExtendableMessageEvent) => void): void;
}

export class ShellWorkerScopeError extends Error {
  constructor() {
    super("installShellWorker must run in a service worker global scope");
    this.name = "ShellWorkerScopeError";
  }
}

function isShellWorkerScope(value: unknown): value is ShellWorkerScope {
  return (
    typeof value === "object" &&
    value !== null &&
    "clients" in value &&
    "skipWaiting" in value &&
    "registration" in value
  );
}

export function installShellWorker(scope: unknown, config: ShellWorkerConfig): void {
  if (!isShellWorkerScope(scope)) throw new ShellWorkerScopeError();
  const worker = createShellWorker({
    config,
    clients: scope.clients,
    origin: scope.location.origin,
  });
  scope.addEventListener("install", (event) => event.waitUntil(scope.skipWaiting()));
  scope.addEventListener("message", (event) => {
    const sourceId = event.source === null ? null : event.source.id;
    worker.message({ data: event.data, sourceId, ports: event.ports });
  });
  scope.addEventListener("fetch", (event) => {
    const decision = worker.fetch({
      request: event.request,
      clientId: event.clientId,
      resultingClientId: event.resultingClientId,
    });
    if (decision.kind === "respond") event.respondWith(decision.response);
  });
}
