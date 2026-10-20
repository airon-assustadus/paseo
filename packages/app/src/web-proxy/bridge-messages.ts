// K3 v1: messages between the control origin (broker) and the content origin (shell).
// Shared by both sides, so it stays free of DOM globals and package imports: the shell is
// served as static code on the content origin.

export const BRIDGE_VERSION = 1;

export type BridgeMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
export type BridgeRequestMode = "navigate" | "subresource";
export type BridgeErrorCode =
  | "invalid_request"
  | "body_too_large"
  | "too_many_requests"
  | "redirect_blocked"
  | "path_not_allowed"
  | "transport_error";
// Why the transport failed, from a closed list (adapter-contract.md §3.2). Nothing else about the
// upstream failure (message, URL, headers, body) ever reaches the content.
export type BridgeErrorReason =
  | "credentials_unsupported"
  | "not_allowed"
  | "unreachable"
  | "timeout"
  | "tls_error"
  | "limit"
  | "transport_closed"
  | "upstream_error";
export type BridgeRevokeReason =
  | "frame_navigated"
  | "disposed"
  | "protocol_error"
  | "port_closed"
  | "transport_closed";
export type BridgeHeaders = Array<[string, string]>;

export interface BridgeLimits {
  windowBytes: number;
  maxChunkBytes: number;
  maxConcurrentRequests: number;
  maxRequestBodyBytes: number;
  maxHeaderBytes: number;
}

// Magnitudes follow the network tunnel contract (initial window, data frame, streams).
// They are spike hypotheses to calibrate on a physical device, not an approved budget.
export const DEFAULT_BRIDGE_LIMITS: BridgeLimits = {
  windowBytes: 262144,
  maxChunkBytes: 65536,
  maxConcurrentRequests: 64,
  maxRequestBodyBytes: 1048576,
  maxHeaderBytes: 16384,
};

export interface HelloMessage {
  type: "paseo.web.hello";
  v: 1;
}

export interface PortGrantMessage {
  type: "paseo.web.port";
  v: 1;
  generation: number;
  limits: BridgeLimits;
}

export interface RequestMessage {
  type: "paseo.web.request";
  v: 1;
  generation: number;
  requestId: number;
  method: BridgeMethod;
  path: string;
  headers: BridgeHeaders;
  body: ArrayBuffer | null;
  mode: BridgeRequestMode;
}

export interface AckMessage {
  type: "paseo.web.ack";
  v: 1;
  generation: number;
  requestId: number;
  bytes: number;
}

export interface CancelMessage {
  type: "paseo.web.cancel";
  v: 1;
  generation: number;
  requestId: number;
}

export type ContentMessage = RequestMessage | AckMessage | CancelMessage;

export interface ResponseHeadMessage {
  type: "paseo.web.response.head";
  v: 1;
  generation: number;
  requestId: number;
  status: number;
  statusText: string;
  headers: BridgeHeaders;
}

export interface ResponseChunkMessage {
  type: "paseo.web.response.chunk";
  v: 1;
  generation: number;
  requestId: number;
  chunk: ArrayBuffer;
}

export interface ResponseEndMessage {
  type: "paseo.web.response.end";
  v: 1;
  generation: number;
  requestId: number;
}

export interface ResponseErrorMessage {
  type: "paseo.web.response.error";
  v: 1;
  generation: number;
  requestId: number;
  code: BridgeErrorCode;
  reason?: BridgeErrorReason;
}

export interface RevokeMessage {
  type: "paseo.web.revoke";
  v: 1;
  generation: number;
  reason: BridgeRevokeReason;
}

export type ControlMessage =
  | ResponseHeadMessage
  | ResponseChunkMessage
  | ResponseEndMessage
  | ResponseErrorMessage
  | RevokeMessage;

const METHODS: readonly BridgeMethod[] = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];
const MODES: readonly BridgeRequestMode[] = ["navigate", "subresource"];
const ERROR_CODES: readonly BridgeErrorCode[] = [
  "invalid_request",
  "body_too_large",
  "too_many_requests",
  "redirect_blocked",
  "path_not_allowed",
  "transport_error",
];
const ERROR_REASONS: readonly BridgeErrorReason[] = [
  "credentials_unsupported",
  "not_allowed",
  "unreachable",
  "timeout",
  "tls_error",
  "limit",
  "transport_closed",
  "upstream_error",
];
const REVOKE_REASONS: readonly BridgeRevokeReason[] = [
  "frame_navigated",
  "disposed",
  "protocol_error",
  "port_closed",
  "transport_closed",
];
const MAX_REQUEST_ID = 2 ** 31 - 1;
const MAX_PATH_LENGTH = 8192;
const MAX_STATUS_TEXT_LENGTH = 512;
// RFC 9110 token for names; values exclude CR, LF and NUL so nothing can split a header.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => key in record);
}

export function isBridgeMethod(value: unknown): value is BridgeMethod {
  return isOneOf(value, METHODS);
}

function isPositiveInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.some((candidate) => candidate === value);
}

function isHeaderPair(value: unknown): value is [string, string] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [name, headerValue] = value;
  return (
    typeof name === "string" &&
    typeof headerValue === "string" &&
    HEADER_NAME.test(name) &&
    HEADER_VALUE.test(headerValue)
  );
}

export function parseHeaders(value: unknown, maxHeaderBytes: number): BridgeHeaders | null {
  if (!Array.isArray(value)) return null;
  const headers: BridgeHeaders = [];
  let bytes = 0;
  for (const entry of value) {
    if (!isHeaderPair(entry)) return null;
    bytes += entry[0].length + entry[1].length;
    if (bytes > maxHeaderBytes) return null;
    headers.push([entry[0], entry[1]]);
  }
  return headers;
}

function isEnvelope(record: Record<string, unknown>, type: string): boolean {
  return (
    record.type === type &&
    record.v === BRIDGE_VERSION &&
    isPositiveInteger(record.generation, Number.MAX_SAFE_INTEGER)
  );
}

function isRequestEnvelope(record: Record<string, unknown>, type: string): boolean {
  return isEnvelope(record, type) && isPositiveInteger(record.requestId, MAX_REQUEST_ID);
}

export function parseHello(data: unknown): HelloMessage | null {
  if (!isRecord(data) || !hasExactKeys(data, ["type", "v"])) return null;
  if (data.type !== "paseo.web.hello" || data.v !== BRIDGE_VERSION) return null;
  return { type: "paseo.web.hello", v: 1 };
}

function parseLimits(value: unknown): BridgeLimits | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(DEFAULT_BRIDGE_LIMITS);
  if (!hasExactKeys(value, keys)) return null;
  const { windowBytes, maxChunkBytes, maxConcurrentRequests, maxRequestBodyBytes, maxHeaderBytes } =
    value;
  const max = Number.MAX_SAFE_INTEGER;
  if (
    !isPositiveInteger(windowBytes, max) ||
    !isPositiveInteger(maxChunkBytes, windowBytes) ||
    !isPositiveInteger(maxConcurrentRequests, max) ||
    !isPositiveInteger(maxRequestBodyBytes, max) ||
    !isPositiveInteger(maxHeaderBytes, max)
  ) {
    return null;
  }
  return { windowBytes, maxChunkBytes, maxConcurrentRequests, maxRequestBodyBytes, maxHeaderBytes };
}

export class InvalidBridgeLimitsError extends Error {
  constructor() {
    super(
      "Invalid bridge limits: every field must be a positive safe integer and " +
        "maxChunkBytes must fit in windowBytes",
    );
    this.name = "InvalidBridgeLimitsError";
  }
}

// A chunk larger than the window could never be sent: the stream would wait for credit forever.
export function validateBridgeLimits(limits: BridgeLimits): BridgeLimits {
  const parsed = parseLimits(limits);
  if (parsed === null) throw new InvalidBridgeLimitsError();
  return parsed;
}

export function parsePortGrant(data: unknown): PortGrantMessage | null {
  if (!isRecord(data) || !hasExactKeys(data, ["type", "v", "generation", "limits"])) return null;
  if (!isEnvelope(data, "paseo.web.port")) return null;
  const limits = parseLimits(data.limits);
  if (!limits || typeof data.generation !== "number") return null;
  return { type: "paseo.web.port", v: 1, generation: data.generation, limits };
}

const REQUEST_KEYS = [
  "type",
  "v",
  "generation",
  "requestId",
  "method",
  "path",
  "headers",
  "body",
  "mode",
];

function parseRequest(data: Record<string, unknown>, limits: BridgeLimits): RequestMessage | null {
  if (!hasExactKeys(data, REQUEST_KEYS) || !isRequestEnvelope(data, "paseo.web.request")) {
    return null;
  }
  const { generation, requestId, method, path, body, mode } = data;
  if (typeof generation !== "number" || typeof requestId !== "number") return null;
  if (!isOneOf(method, METHODS) || !isOneOf(mode, MODES)) return null;
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_LENGTH) return null;
  if (body !== null && !(body instanceof ArrayBuffer)) return null;
  const headers = parseHeaders(data.headers, limits.maxHeaderBytes);
  if (!headers) return null;
  return {
    type: "paseo.web.request",
    v: 1,
    generation,
    requestId,
    method,
    path,
    headers,
    body,
    mode,
  };
}

export function parseContentMessage(data: unknown, limits: BridgeLimits): ContentMessage | null {
  if (!isRecord(data)) return null;
  if (data.type === "paseo.web.request") return parseRequest(data, limits);
  const { generation, requestId } = data;
  if (typeof generation !== "number" || typeof requestId !== "number") return null;
  if (data.type === "paseo.web.cancel") {
    if (!hasExactKeys(data, ["type", "v", "generation", "requestId"])) return null;
    if (!isRequestEnvelope(data, "paseo.web.cancel")) return null;
    return { type: "paseo.web.cancel", v: 1, generation, requestId };
  }
  if (data.type === "paseo.web.ack") {
    if (!hasExactKeys(data, ["type", "v", "generation", "requestId", "bytes"])) return null;
    if (!isRequestEnvelope(data, "paseo.web.ack")) return null;
    if (!isPositiveInteger(data.bytes, limits.windowBytes)) return null;
    return { type: "paseo.web.ack", v: 1, generation, requestId, bytes: data.bytes };
  }
  return null;
}

function parseResponseHead(data: Record<string, unknown>): ResponseHeadMessage | null {
  const keys = ["type", "v", "generation", "requestId", "status", "statusText", "headers"];
  if (!hasExactKeys(data, keys) || !isRequestEnvelope(data, "paseo.web.response.head")) {
    return null;
  }
  const { generation, requestId, status, statusText } = data;
  if (typeof generation !== "number" || typeof requestId !== "number") return null;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) {
    return null;
  }
  if (typeof statusText !== "string" || statusText.length > MAX_STATUS_TEXT_LENGTH) return null;
  const headers = parseHeaders(data.headers, Number.MAX_SAFE_INTEGER);
  if (!headers) return null;
  return {
    type: "paseo.web.response.head",
    v: 1,
    generation,
    requestId,
    status,
    statusText,
    headers,
  };
}

function parseResponseError(data: Record<string, unknown>): ResponseErrorMessage | null {
  const keys = ["type", "v", "generation", "requestId", "code"];
  const hasReason = "reason" in data;
  if (!hasExactKeys(data, hasReason ? [...keys, "reason"] : keys)) return null;
  if (!isRequestEnvelope(data, "paseo.web.response.error")) return null;
  const { generation, requestId, code, reason } = data;
  if (typeof generation !== "number" || typeof requestId !== "number") return null;
  if (!isOneOf(code, ERROR_CODES)) return null;
  const message: ResponseErrorMessage = {
    type: "paseo.web.response.error",
    v: 1,
    generation,
    requestId,
    code,
  };
  if (!hasReason) return message;
  if (!isOneOf(reason, ERROR_REASONS)) return null;
  return { ...message, reason };
}

export function parseControlMessage(data: unknown): ControlMessage | null {
  if (!isRecord(data)) return null;
  const { generation, requestId } = data;
  if (typeof generation !== "number") return null;
  if (data.type === "paseo.web.revoke") {
    if (!hasExactKeys(data, ["type", "v", "generation", "reason"])) return null;
    if (!isEnvelope(data, "paseo.web.revoke") || !isOneOf(data.reason, REVOKE_REASONS)) {
      return null;
    }
    return { type: "paseo.web.revoke", v: 1, generation, reason: data.reason };
  }
  if (typeof requestId !== "number") return null;
  if (data.type === "paseo.web.response.head") return parseResponseHead(data);
  if (data.type === "paseo.web.response.chunk") {
    if (!hasExactKeys(data, ["type", "v", "generation", "requestId", "chunk"])) return null;
    if (!isRequestEnvelope(data, "paseo.web.response.chunk")) return null;
    if (!(data.chunk instanceof ArrayBuffer)) return null;
    return { type: "paseo.web.response.chunk", v: 1, generation, requestId, chunk: data.chunk };
  }
  if (data.type === "paseo.web.response.end") {
    if (!hasExactKeys(data, ["type", "v", "generation", "requestId"])) return null;
    if (!isRequestEnvelope(data, "paseo.web.response.end")) return null;
    return { type: "paseo.web.response.end", v: 1, generation, requestId };
  }
  if (data.type === "paseo.web.response.error") return parseResponseError(data);
  return null;
}
