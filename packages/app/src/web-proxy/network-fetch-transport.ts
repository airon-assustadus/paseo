import type { BridgeErrorReason, BridgeHeaders, BridgeMethod } from "./bridge-messages";
import type { WebProxyCapability } from "./request-policy";
import {
  WebProxyTransportError,
  type WebProxyTransport,
  type WebProxyTransportRequest,
  type WebProxyTransportResponse,
} from "./transport";

// Adapter from the broker's WebProxyTransport to a NetworkFetchSession on the host, reached
// through a channel. The channel owns the wire (authentication, JSON, base64); this module owns
// the session semantics: request ids, credit, cancellation, redirects and the closed error lists.
// Server types are mirrored, not imported: the app never depends on the server package.

export interface NetworkFetchScope {
  origin: string;
  pathPrefix: string;
}

export interface NetworkFetchLimits {
  initialWindowBytes: number;
  maxChunkBytes: number;
  maxConcurrentRequests: number;
  connectTimeoutMs: number;
  maxRequestHeadBytes: number;
  maxResponseHeadBytes: number;
  responseHeadTimeoutMs: number;
  maxRequestBodyBytes: number;
  maxResponseBodyBytes: number;
  maxRedirects: number;
}

// The core's domain: a zero body or redirect limit is a policy, a zero window never progresses.
const LIMIT_MINIMUMS: Record<keyof NetworkFetchLimits, number> = {
  initialWindowBytes: 1,
  maxChunkBytes: 1,
  maxConcurrentRequests: 1,
  connectTimeoutMs: 1,
  maxRequestHeadBytes: 1,
  maxResponseHeadBytes: 1,
  responseHeadTimeoutMs: 1,
  maxRequestBodyBytes: 0,
  maxResponseBodyBytes: 0,
  maxRedirects: 0,
};

const LIMIT_KEYS: readonly (keyof NetworkFetchLimits)[] = [
  "initialWindowBytes",
  "maxChunkBytes",
  "maxConcurrentRequests",
  "connectTimeoutMs",
  "maxRequestHeadBytes",
  "maxResponseHeadBytes",
  "responseHeadTimeoutMs",
  "maxRequestBodyBytes",
  "maxResponseBodyBytes",
  "maxRedirects",
];

// The session TTL shares the core's ceiling: setTimeout fires at once above it.
const MAX_TTL_MS = 2 ** 31 - 1;

// Bounds of the request frame itself (adapter-contract.md §5.4), in the units the host checks:
// string length of the URL and header names, and name.length + value.length summed against the
// session's maxRequestHeadBytes. The host closes the whole connection on a frame beyond them, so a
// request that would cross them fails alone, here, before it takes an id.
const MAX_REQUEST_URL_CHARS = 8_192;
const MAX_REQUEST_HEADER_NAME_CHARS = 256;

function fitsRequestFrame(input: WebProxyTransportRequest, maxRequestHeadBytes: number): boolean {
  if (input.url.length > MAX_REQUEST_URL_CHARS) return false;
  let headBytes = 0;
  for (const [name, value] of input.headers) {
    if (name.length > MAX_REQUEST_HEADER_NAME_CHARS) return false;
    headBytes += name.length + value.length;
  }
  return headBytes <= maxRequestHeadBytes;
}

export type NetworkFetchErrorCode =
  | "invalid_request"
  | "not_allowlisted"
  | "credentials_unsupported"
  | "request_head_too_large"
  | "request_body_too_large"
  | "stream_limit"
  | "policy_denied"
  | "self_target_denied"
  | "host_not_found"
  | "connection_refused"
  | "network_unreachable"
  | "timeout"
  | "tls_certificate_invalid"
  | "tls_hostname_mismatch"
  | "tls_error"
  | "redirect_not_allowlisted"
  | "redirect_limit"
  | "redirect_body_unreplayable"
  | "redirect_error_mode"
  | "response_head_too_large"
  | "response_body_too_large"
  | "unsupported_encoding"
  | "credit_exceeded"
  | "upstream_error";

// Failures reach the broker only as WebProxyTransportError: its message is fixed per reason, so
// nothing from the upstream or the core reaches the content.
const REASON_BY_CODE: Record<NetworkFetchErrorCode, BridgeErrorReason> = {
  invalid_request: "upstream_error",
  not_allowlisted: "not_allowed",
  credentials_unsupported: "credentials_unsupported",
  request_head_too_large: "limit",
  request_body_too_large: "limit",
  stream_limit: "limit",
  policy_denied: "not_allowed",
  self_target_denied: "not_allowed",
  host_not_found: "unreachable",
  connection_refused: "unreachable",
  network_unreachable: "unreachable",
  timeout: "timeout",
  tls_certificate_invalid: "tls_error",
  tls_hostname_mismatch: "tls_error",
  tls_error: "tls_error",
  redirect_not_allowlisted: "not_allowed",
  redirect_limit: "upstream_error",
  redirect_body_unreplayable: "upstream_error",
  redirect_error_mode: "upstream_error",
  response_head_too_large: "limit",
  response_body_too_large: "limit",
  unsupported_encoding: "upstream_error",
  credit_exceeded: "limit",
  upstream_error: "upstream_error",
};

export type NetworkFetchOpenFailure =
  | "permission_denied"
  | "allowlist_not_found"
  | "revision_conflict"
  | "invalid_configuration"
  | "scope_not_allowlisted";

const OPEN_FAILURES: readonly NetworkFetchOpenFailure[] = [
  "permission_denied",
  "allowlist_not_found",
  "revision_conflict",
  "invalid_configuration",
  "scope_not_allowlisted",
];

export type NetworkFetchHostClosedReason = "closed" | "revoked" | "expired" | "allowlist_changed";

const HOST_CLOSED_REASONS: readonly NetworkFetchHostClosedReason[] = [
  "closed",
  "revoked",
  "expired",
  "allowlist_changed",
];

// "closed" is also a local close() and "expired" the local deadline: same meaning as the core's.
export type NetworkFetchTransportClosedReason =
  | NetworkFetchHostClosedReason
  | "channel_lost"
  | "protocol_error";

export type NetworkFetchProtocolViolation =
  | "replayed"
  | "unknown_request"
  | "session_closed"
  | "body_not_expected"
  | "credit_overflow";

const PROTOCOL_VIOLATIONS: readonly NetworkFetchProtocolViolation[] = [
  "replayed",
  "unknown_request",
  "session_closed",
  "body_not_expected",
  "credit_overflow",
];

export class NetworkFetchOpenFailedError extends Error {
  constructor(readonly code: NetworkFetchOpenFailure) {
    super(`Network fetch session refused: ${code}`);
    this.name = "NetworkFetchOpenFailedError";
  }
}

export type NetworkFetchRequestBody = { kind: "none" } | { kind: "stream"; length: number };

export interface SessionOpenFrame {
  type: "session.open";
  scope: NetworkFetchScope;
  ttlMs: number;
  limits: Partial<NetworkFetchLimits>;
}

export interface RequestFrame {
  type: "request";
  requestId: number;
  method: BridgeMethod;
  url: string;
  headers: BridgeHeaders;
  redirect: "manual";
  body: NetworkFetchRequestBody;
}

export interface BodyFrame {
  type: "body";
  requestId: number;
  data: Uint8Array;
}

export interface RequestControlFrame {
  type: "endBody" | "cancel";
  requestId: number;
}

export interface GrantCreditFrame {
  type: "grantCredit";
  requestId: number;
  bytes: number;
}

export interface CloseFrame {
  type: "close";
}

export type NetworkFetchOutboundFrame =
  | SessionOpenFrame
  | RequestFrame
  | BodyFrame
  | RequestControlFrame
  | GrantCreditFrame
  | CloseFrame;

export interface NetworkFetchChannelHandlers {
  // A decoded frame: `body.data` is a Uint8Array. Everything else is validated here.
  frame(data: unknown): void;
  lost(): void;
}

// Delivers frames in order. `send` after the channel is gone is a no-op, never a throw.
export interface NetworkFetchChannel {
  send(frame: NetworkFetchOutboundFrame): void;
  listen(handlers: NetworkFetchChannelHandlers): void;
  close(): void;
}

export interface OpenNetworkFetchTransportOptions {
  channel: NetworkFetchChannel;
  // The same capability the broker serves: its destination and prefix are the session scope.
  capability: WebProxyCapability;
  ttlMs: number;
  limits: Partial<NetworkFetchLimits>;
  onClosed(reason: NetworkFetchTransportClosedReason): void;
}

export interface NetworkFetchTransport extends WebProxyTransport {
  readonly limits: NetworkFetchLimits;
  // Releases every request at once; it never waits on the channel.
  close(): void;
}

interface ResponseRedirect {
  location: string;
  allowed: boolean;
}

interface ResponseHead {
  status: number;
  statusText: string;
  headers: BridgeHeaders;
  redirect: ResponseRedirect | null;
}

type InboundFrame =
  | { type: "session.opened"; limits: NetworkFetchLimits }
  | { type: "session.open_failed"; code: NetworkFetchOpenFailure }
  | { type: "head"; requestId: number; head: ResponseHead }
  | { type: "body"; requestId: number; data: Uint8Array }
  | { type: "end"; requestId: number }
  | { type: "fail"; requestId: number; code: NetworkFetchErrorCode }
  | { type: "uploadCredit"; requestId: number; bytes: number }
  | { type: "cancelled"; requestId: number; dnsPending: boolean }
  | { type: "closed"; reason: NetworkFetchHostClosedReason }
  | { type: "protocol_error"; violation: NetworkFetchProtocolViolation };

type RequestEventFrame = Extract<InboundFrame, { requestId: number }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 1;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some((candidate) => candidate === value);
}

function isErrorCode(value: unknown): value is NetworkFetchErrorCode {
  return typeof value === "string" && Object.hasOwn(REASON_BY_CODE, value);
}

function parseHeaderList(value: unknown): BridgeHeaders | null {
  if (!Array.isArray(value)) return null;
  const headers: BridgeHeaders = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [name, headerValue] = entry;
    if (typeof name !== "string" || typeof headerValue !== "string") return null;
    headers.push([name, headerValue]);
  }
  return headers;
}

function parseRedirect(value: unknown): ResponseRedirect | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { location, allowed } = value;
  if (typeof location !== "string" || typeof allowed !== "boolean") return undefined;
  return { location, allowed };
}

function parseHead(value: unknown): ResponseHead | null {
  if (!isRecord(value)) return null;
  const { status, statusText } = value;
  const headers = parseHeaderList(value.headers);
  const redirect = parseRedirect(value.redirect);
  const hasStatus = Number.isSafeInteger(status) && typeof status === "number";
  if (!hasStatus || typeof statusText !== "string" || headers === null) return null;
  if (redirect === undefined) return null;
  return { status, statusText, headers, redirect };
}

function parseLimits(value: unknown): NetworkFetchLimits | null {
  if (!isRecord(value)) return null;
  const limits: Partial<NetworkFetchLimits> = {};
  for (const key of LIMIT_KEYS) {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field)) return null;
    if (field < LIMIT_MINIMUMS[key]) return null;
    limits[key] = field;
  }
  return isCompleteLimits(limits) ? limits : null;
}

function isCompleteLimits(limits: Partial<NetworkFetchLimits>): limits is NetworkFetchLimits {
  return LIMIT_KEYS.every((key) => limits[key] !== undefined);
}

function isRequestedLimitsValid(limits: Partial<NetworkFetchLimits>): boolean {
  return LIMIT_KEYS.every((key) => {
    const value = limits[key];
    return value === undefined || (Number.isSafeInteger(value) && value >= LIMIT_MINIMUMS[key]);
  });
}

// The host may only lower what was asked for, and every chunk must fit the window.
function isAgreedLimits(agreed: NetworkFetchLimits, requested: Partial<NetworkFetchLimits>) {
  const lowered = LIMIT_KEYS.every((key) => {
    const ceiling = requested[key];
    return ceiling === undefined || agreed[key] <= ceiling;
  });
  return lowered && agreed.maxChunkBytes <= agreed.initialWindowBytes;
}

function parseRequestEvent(type: string, value: Record<string, unknown>): RequestEventFrame | null {
  const { requestId } = value;
  if (!isPositiveInteger(requestId)) return null;
  switch (type) {
    case "head": {
      const head = parseHead(value.head);
      return head ? { type, requestId, head } : null;
    }
    case "body":
      return value.data instanceof Uint8Array ? { type, requestId, data: value.data } : null;
    case "end":
      return { type, requestId };
    case "fail":
      return isErrorCode(value.code) ? { type, requestId, code: value.code } : null;
    case "uploadCredit":
      return isPositiveInteger(value.bytes) ? { type, requestId, bytes: value.bytes } : null;
    case "cancelled":
      return typeof value.dnsPending === "boolean"
        ? { type, requestId, dnsPending: value.dnsPending }
        : null;
    default:
      return null;
  }
}

function parseInboundFrame(value: unknown): InboundFrame | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "session.opened": {
      const limits = parseLimits(value.limits);
      return limits ? { type: value.type, limits } : null;
    }
    case "session.open_failed":
      return isOneOf(OPEN_FAILURES, value.code) ? { type: value.type, code: value.code } : null;
    case "closed":
      return isOneOf(HOST_CLOSED_REASONS, value.reason)
        ? { type: value.type, reason: value.reason }
        : null;
    case "protocol_error":
      return isOneOf(PROTOCOL_VIOLATIONS, value.violation)
        ? { type: value.type, violation: value.violation }
        : null;
    default:
      return parseRequestEvent(value.type, value);
  }
}

function originOf(url: string): string | null {
  return URL.canParse(url) ? new URL(url).origin : null;
}

// One Location at most: the core's decision when the redirect stays in scope, none otherwise.
function withRedirectLocation(head: ResponseHead): BridgeHeaders {
  const headers: BridgeHeaders = [];
  let locationIndex: number | null = null;
  for (const [name, value] of head.headers) {
    if (name.toLowerCase() !== "location") {
      headers.push([name, value]);
      continue;
    }
    locationIndex ??= headers.length;
  }
  if (head.redirect !== null) {
    headers.splice(locationIndex ?? headers.length, 0, ["location", head.redirect.location]);
  }
  return headers;
}

interface PendingUpload {
  body: Uint8Array;
  offset: number;
  // Sent bytes the core has not credited back yet; bounded by the initial window.
  unreturned: number;
  ended: boolean;
}

interface PendingRequest {
  id: number;
  phase: "awaiting_head" | "streaming";
  cancelSent: boolean;
  released: boolean;
  // What the request ends with once cancelled: the abort reason or a blocked redirect.
  cancelError: unknown;
  resolveHead(response: WebProxyTransportResponse): void;
  rejectHead(error: unknown): void;
  markReleased(): void;
  releasedPromise: Promise<void>;
  upload: PendingUpload | null;
  queue: Uint8Array[];
  // Response bytes received and not yet credited back to the core.
  outstanding: number;
  stream: ReadableStreamDefaultController<Uint8Array> | null;
  streamState: "open" | "ended" | "done";
  wakePull: (() => void) | null;
}

export function openNetworkFetchTransport(
  options: OpenNetworkFetchTransportOptions,
): Promise<NetworkFetchTransport> {
  const { channel, capability, ttlMs } = options;
  const requestedLimits = options.limits;
  const isTtlValid = Number.isSafeInteger(ttlMs) && ttlMs >= 1 && ttlMs <= MAX_TTL_MS;
  if (!isTtlValid || !isRequestedLimitsValid(requestedLimits)) {
    return Promise.reject(new NetworkFetchOpenFailedError("invalid_configuration"));
  }
  const scope: NetworkFetchScope = {
    origin: capability.destinationOrigin,
    pathPrefix: capability.pathPrefix,
  };

  let state: "opening" | "open" | "closed" = "opening";
  let limits: NetworkFetchLimits | null = null;
  let lastRequestId = 0;
  const active = new Map<number, PendingRequest>();
  // Ids released by end/fail after a cancel left: the host may still answer with one cancelled.
  const lateCancels: number[] = [];
  let resolveOpen: (transport: NetworkFetchTransport) => void = () => {};
  let rejectOpen: (error: unknown) => void = () => {};
  const opened = new Promise<NetworkFetchTransport>((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  const deadline = setTimeout(() => shutdown({ reason: "expired", notifyHost: true }), ttlMs);

  function agreedLimits(): NetworkFetchLimits {
    if (limits === null) throw new Error("Network fetch session is not open");
    return limits;
  }

  function settleStream(entry: PendingRequest, error: unknown): void {
    if (entry.streamState !== "open") return;
    entry.queue.length = 0;
    entry.streamState = "done";
    entry.stream?.error(error);
    entry.wakePull?.();
  }

  function release(entry: PendingRequest, error: unknown): void {
    if (entry.released) return;
    entry.released = true;
    active.delete(entry.id);
    entry.upload = null;
    if (entry.phase === "awaiting_head") entry.rejectHead(entry.cancelError ?? error);
    else if (error !== null) settleStream(entry, error);
    entry.markReleased();
  }

  function rememberLateCancel(id: number): void {
    lateCancels.push(id);
    if (lateCancels.length > agreedLimits().maxConcurrentRequests) lateCancels.shift();
  }

  function cancel(entry: PendingRequest, cancelError: unknown): void {
    if (entry.released || entry.cancelSent) return;
    entry.cancelSent = true;
    entry.cancelError = cancelError;
    entry.upload = null;
    entry.queue.length = 0;
    channel.send({ type: "cancel", requestId: entry.id });
  }

  function pumpUpload(entry: PendingRequest): void {
    const upload = entry.upload;
    if (upload === null || upload.ended) return;
    const { initialWindowBytes, maxChunkBytes } = agreedLimits();
    while (upload.offset < upload.body.byteLength) {
      const credit = initialWindowBytes - upload.unreturned;
      if (credit === 0) return;
      const remaining = upload.body.byteLength - upload.offset;
      const size = Math.min(maxChunkBytes, credit, remaining);
      const data = upload.body.slice(upload.offset, upload.offset + size);
      upload.offset += size;
      upload.unreturned += size;
      channel.send({ type: "body", requestId: entry.id, data });
    }
    upload.ended = true;
    channel.send({ type: "endBody", requestId: entry.id });
  }

  function pull(
    entry: PendingRequest,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> | undefined {
    const chunk = entry.queue.shift();
    if (chunk) {
      controller.enqueue(chunk);
      // Credit returns only once the chunk has left the adapter, never for a finished request.
      if (!entry.released) {
        entry.outstanding -= chunk.byteLength;
        channel.send({ type: "grantCredit", requestId: entry.id, bytes: chunk.byteLength });
      }
      return undefined;
    }
    if (entry.streamState === "ended") {
      entry.streamState = "done";
      controller.close();
      return undefined;
    }
    if (entry.streamState === "done") return undefined;
    return new Promise<void>((resolve) => {
      entry.wakePull = resolve;
    }).then(() => {
      entry.wakePull = null;
      return pull(entry, controller);
    });
  }

  function deliverHead(entry: PendingRequest, head: ResponseHead): void {
    entry.phase = "streaming";
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          entry.stream = controller;
        },
        pull(controller) {
          return pull(entry, controller);
        },
        cancel() {
          cancel(entry, null);
          entry.streamState = "done";
          entry.queue.length = 0;
          return entry.releasedPromise;
        },
      },
      { highWaterMark: 0 },
    );
    entry.resolveHead({
      status: head.status,
      statusText: head.statusText,
      headers: withRedirectLocation(head),
      body,
    });
  }

  function onHead(entry: PendingRequest, head: ResponseHead): boolean {
    if (entry.cancelSent) return true;
    if (entry.phase !== "awaiting_head") return false;
    if (head.redirect?.allowed === false) {
      // The core refused a redirect outside the session scope; the 3xx is never delivered.
      cancel(entry, new WebProxyTransportError("not_allowed", "redirect_blocked"));
      return true;
    }
    deliverHead(entry, head);
    return true;
  }

  function onBody(entry: PendingRequest, data: Uint8Array): boolean {
    if (entry.cancelSent) return true;
    const { initialWindowBytes, maxChunkBytes } = agreedLimits();
    const fits = data.byteLength >= 1 && data.byteLength <= maxChunkBytes;
    const withinCredit = entry.outstanding + data.byteLength <= initialWindowBytes;
    if (entry.phase !== "streaming" || !fits || !withinCredit) return false;
    entry.outstanding += data.byteLength;
    if (entry.streamState !== "open") return true;
    entry.queue.push(data);
    entry.wakePull?.();
    return true;
  }

  function onUploadCredit(entry: PendingRequest, bytes: number): boolean {
    if (entry.cancelSent) return true;
    const upload = entry.upload;
    if (upload === null || bytes > upload.unreturned) return false;
    upload.unreturned -= bytes;
    pumpUpload(entry);
    return true;
  }

  function cancelledError(entry: PendingRequest): unknown {
    return entry.cancelError ?? new WebProxyTransportError("transport_closed");
  }

  function onEnd(entry: PendingRequest): boolean {
    if (entry.cancelSent) {
      rememberLateCancel(entry.id);
      release(entry, cancelledError(entry));
      return true;
    }
    if (entry.phase !== "streaming") return false;
    if (entry.streamState === "open") {
      entry.streamState = "ended";
      entry.wakePull?.();
    }
    release(entry, null);
    return true;
  }

  function onFail(entry: PendingRequest, code: NetworkFetchErrorCode): void {
    if (entry.cancelSent) rememberLateCancel(entry.id);
    release(entry, new WebProxyTransportError(REASON_BY_CODE[code]));
  }

  // Without a cancel from the adapter, the host dropped the request on its own.
  function onCancelled(entry: PendingRequest): void {
    const error = entry.cancelSent
      ? cancelledError(entry)
      : new WebProxyTransportError("transport_closed");
    release(entry, error);
  }

  function onLateFrame(frame: RequestEventFrame): boolean {
    const index = lateCancels.indexOf(frame.requestId);
    if (frame.type !== "cancelled" || index === -1) return false;
    lateCancels.splice(index, 1);
    return true;
  }

  function onRequestEvent(frame: RequestEventFrame): boolean {
    const entry = active.get(frame.requestId);
    if (!entry) return onLateFrame(frame);
    switch (frame.type) {
      case "head":
        return onHead(entry, frame.head);
      case "body":
        return onBody(entry, frame.data);
      case "uploadCredit":
        return onUploadCredit(entry, frame.bytes);
      case "end":
        return onEnd(entry);
      case "fail":
        onFail(entry, frame.code);
        return true;
      case "cancelled":
        onCancelled(entry);
        return true;
    }
  }

  function onOpened(agreed: NetworkFetchLimits): boolean {
    if (!isAgreedLimits(agreed, requestedLimits)) return false;
    limits = agreed;
    state = "open";
    resolveOpen(transport);
    return true;
  }

  function onFrame(data: unknown): void {
    if (state === "closed") return;
    const frame = parseInboundFrame(data);
    const accepted = frame !== null && handle(frame);
    if (!accepted) shutdown({ reason: "protocol_error", notifyHost: true });
  }

  function handle(frame: InboundFrame): boolean {
    if (frame.type === "closed") {
      shutdown({ reason: frame.reason, notifyHost: false });
      return true;
    }
    if (state === "opening") {
      if (frame.type === "session.opened") return onOpened(frame.limits);
      if (frame.type !== "session.open_failed") return false;
      rejectOpen(new NetworkFetchOpenFailedError(frame.code));
      shutdown({ reason: "closed", notifyHost: false });
      return true;
    }
    if (frame.type === "session.opened" || frame.type === "session.open_failed") return false;
    // A replay refusal names a duplicate the adapter never sent; the first request is untouched.
    if (frame.type === "protocol_error") return frame.violation === "replayed";
    return onRequestEvent(frame);
  }

  function shutdown(input: {
    reason: NetworkFetchTransportClosedReason;
    notifyHost: boolean;
  }): void {
    if (state === "closed") return;
    const wasOpen = state === "open";
    state = "closed";
    clearTimeout(deadline);
    if (input.notifyHost) channel.send({ type: "close" });
    const error = new WebProxyTransportError("transport_closed");
    // release() deletes the visited entry, which Map iteration allows.
    for (const entry of active.values()) release(entry, error);
    channel.close();
    if (wasOpen) options.onClosed(input.reason);
    else rejectOpen(error);
  }

  async function request(
    input: WebProxyTransportRequest,
    signal: AbortSignal,
  ): Promise<WebProxyTransportResponse> {
    if (state !== "open") throw new WebProxyTransportError("transport_closed");
    signal.throwIfAborted();
    const agreed = agreedLimits();
    const isInScope =
      input.initiator.boundOrigin === scope.origin && originOf(input.url) === scope.origin;
    if (!isInScope) throw new WebProxyTransportError("not_allowed");
    const bodyLength = input.body?.byteLength ?? 0;
    const isOverLimit =
      !fitsRequestFrame(input, agreed.maxRequestHeadBytes) ||
      bodyLength > agreed.maxRequestBodyBytes ||
      active.size >= agreed.maxConcurrentRequests ||
      lastRequestId >= Number.MAX_SAFE_INTEGER;
    if (isOverLimit) throw new WebProxyTransportError("limit");

    lastRequestId += 1;
    let resolveHead: (response: WebProxyTransportResponse) => void = () => {};
    let rejectHead: (error: unknown) => void = () => {};
    const headPromise = new Promise<WebProxyTransportResponse>((resolve, reject) => {
      resolveHead = resolve;
      rejectHead = reject;
    });
    let markReleased: () => void = () => {};
    const releasedPromise = new Promise<void>((resolve) => {
      markReleased = resolve;
    });
    const entry: PendingRequest = {
      id: lastRequestId,
      phase: "awaiting_head",
      cancelSent: false,
      released: false,
      cancelError: null,
      resolveHead,
      rejectHead,
      markReleased,
      releasedPromise,
      upload: null,
      queue: [],
      outstanding: 0,
      stream: null,
      streamState: "open",
      wakePull: null,
    };
    active.set(entry.id, entry);
    const body: NetworkFetchRequestBody =
      bodyLength === 0 ? { kind: "none" } : { kind: "stream", length: bodyLength };
    channel.send({
      type: "request",
      requestId: entry.id,
      method: input.method,
      url: input.url,
      headers: input.headers,
      redirect: "manual",
      body,
    });
    const onAbort = () => cancel(entry, signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void entry.releasedPromise.then(() => signal.removeEventListener("abort", onAbort));
    if (input.body !== null && bodyLength > 0) {
      entry.upload = { body: input.body, offset: 0, unreturned: 0, ended: false };
      pumpUpload(entry);
    }
    return headPromise;
  }

  const transport: NetworkFetchTransport = {
    get limits() {
      return agreedLimits();
    },
    request,
    close() {
      shutdown({ reason: "closed", notifyHost: true });
    },
  };

  channel.listen({
    frame: onFrame,
    lost: () => shutdown({ reason: "channel_lost", notifyHost: false }),
  });
  channel.send({ type: "session.open", scope, ttlMs, limits: requestedLimits });
  return opened;
}
