import {
  isBridgeMethod,
  parseControlMessage,
  type BridgeErrorCode,
  type BridgeHeaders,
  type BridgeRequestMode,
  type ControlMessage,
  type ResponseHeadMessage,
} from "../bridge-messages";
import type { ShellFetchMessage, ShellRequestMessage } from "./relay-messages";

export interface ShellWorkerConfig {
  controlOrigin: string;
  // Served by the static shell host (bootstrap, worker). Checked before mountPath.
  shellPathPrefix: string;
  bootstrapPath: string;
  // Content path prefix that maps 1:1 onto the destination's root. "/" in a deployment.
  mountPath: string;
  headTimeoutMs: number;
  idleChunkTimeoutMs: number;
  maxRequestBodyBytes: number;
}

export interface ShellWindowClient {
  url: string;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

export interface ShellClients {
  matchAll(options: {
    type: "window";
    includeUncontrolled: boolean;
  }): Promise<ReadonlyArray<ShellWindowClient>>;
}

export type ShellFetchDecision =
  | { kind: "network" }
  | { kind: "respond"; response: Promise<Response> };

export type ShellFailureCode =
  | "session_unavailable"
  | "session_ambiguous"
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
  constructor(readonly code: ShellFailureCode | BridgeErrorCode) {
    super(`Web proxy bridge ended the response: ${code}`);
    this.name = "ShellBridgeClosedError";
  }
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function failureResponse(status: number, code: ShellFailureCode | BridgeErrorCode): Response {
  return new Response(`Paseo web proxy: ${code}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-paseo-web-proxy-error": code,
    },
  });
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

  function fail(status: number, code: ShellFailureCode | BridgeErrorCode): void {
    settle(failureResponse(status, code), "done");
  }

  function failBody(code: ShellFailureCode | BridgeErrorCode): void {
    queue.failure = new ShellBridgeClosedError(code);
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
      failBody(message.code);
    } else {
      failBody("bridge_error");
    }
  }

  function onHeadPhaseMessage(message: ControlMessage): void {
    if (message.type === "paseo.web.response.head") onHead(message);
    else if (message.type === "paseo.web.revoke") fail(502, "session_revoked");
    else if (message.type === "paseo.web.response.error") fail(502, message.code);
    else fail(502, "bridge_error");
  }

  headTimer = setTimeout(() => {
    // The bootstrap is gone, frozen or the broker stalled: say so instead of hanging.
    headTimer = null;
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

async function proxy(input: {
  request: Request;
  url: URL;
  config: ShellWorkerConfig;
  clients: ShellClients;
}): Promise<Response> {
  const { request, url, config } = input;
  const method = request.method;
  if (!isBridgeMethod(method)) return failureResponse(405, "method_not_allowed");
  const body = await readBody(request, config.maxRequestBodyBytes);
  if (body === "too_large") return failureResponse(413, "body_too_large");
  const windows = await input.clients.matchAll({ type: "window", includeUncontrolled: true });
  const bootstraps = windows.filter(
    (client) => new URL(client.url).pathname === config.bootstrapPath,
  );
  const bootstrap = bootstraps[0];
  if (bootstrap === undefined) return failureResponse(503, "session_unavailable");
  if (bootstraps.length > 1) return failureResponse(503, "session_ambiguous");

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
  const response = awaitResponse({ port: channel.port1, method, mode, config });
  bootstrap.postMessage(message, transfer);
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
  const numbers = ["headTimeoutMs", "idleChunkTimeoutMs", "maxRequestBodyBytes"] as const;
  for (const field of numbers) {
    if (!isPositiveInteger(config[field])) throw new InvalidShellWorkerConfigError(field);
  }
  for (const field of ["shellPathPrefix", "mountPath"] as const) {
    if (!isDirectoryPath(config[field])) throw new InvalidShellWorkerConfigError(field);
  }
  if (!config.bootstrapPath.startsWith(config.shellPathPrefix)) {
    throw new InvalidShellWorkerConfigError("bootstrapPath");
  }
  if (
    !URL.canParse(config.controlOrigin) ||
    new URL(config.controlOrigin).origin !== config.controlOrigin
  ) {
    throw new InvalidShellWorkerConfigError("controlOrigin");
  }
  return config;
}

// Holds no state between events, so a worker the browser stopped and restarted serves the
// next request exactly like the previous instance would.
export function createShellFetchHandler(input: {
  config: ShellWorkerConfig;
  clients: ShellClients;
  origin: string;
}): (request: Request) => ShellFetchDecision {
  const config = validateShellWorkerConfig(input.config);
  const { clients, origin } = input;
  return (request) => {
    const url = new URL(request.url);
    // Nothing leaves the phone directly: other origins get a network error.
    if (url.origin !== origin)
      return { kind: "respond", response: Promise.resolve(Response.error()) };
    if (url.pathname.startsWith(config.shellPathPrefix)) return { kind: "network" };
    if (!url.pathname.startsWith(config.mountPath)) {
      return { kind: "respond", response: Promise.resolve(Response.error()) };
    }
    return { kind: "respond", response: proxy({ request, url, config, clients }) };
  };
}

interface ShellFetchEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
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
  const handle = createShellFetchHandler({
    config,
    clients: scope.clients,
    origin: scope.location.origin,
  });
  scope.addEventListener("install", (event) => event.waitUntil(scope.skipWaiting()));
  scope.addEventListener("fetch", (event) => {
    const decision = handle(event.request);
    if (decision.kind === "respond") event.respondWith(decision.response);
  });
}
