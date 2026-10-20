import { NetworkFetchError } from "./errors.js";

export type HeaderList = [string, string][];

/** Request headers a page may set and that carry no ambient authority. Everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "if-unmodified-since",
  "pragma",
  "range",
  "user-agent",
  "x-requested-with",
]);

/** No cookie jar exists in this proof, so credentials are refused instead of silently dropped. */
const CREDENTIAL_HEADERS = new Set(["cookie", "authorization", "proxy-authorization"]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Response headers that would let the phone's browser store state or learn the real destination
 * outside the proxy: cookies, HSTS and pinning, alternative services, and reporting endpoints.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "alt-svc",
  "strict-transport-security",
  "public-key-pins",
  "public-key-pins-report-only",
  "report-to",
  "nel",
  "expect-ct",
]);

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface UpstreamHeadInput {
  method: string;
  url: URL;
  headers: HeaderList;
  /** Sent as `Origin` on unsafe methods; `null` when the initiator is not a target origin. */
  origin: string | null;
  bodyLength: number | null;
  hasBody: boolean;
}

export interface UpstreamHead {
  /** Flat `[name, value, …]` list, the form `http.request` keeps duplicates in. */
  rawHeaders: string[];
  droppedRequestHeaders: string[];
  headBytes: number;
}

export function buildUpstreamHead(input: UpstreamHeadInput): UpstreamHead {
  const rawHeaders: string[] = [];
  const dropped = new Set<string>();
  for (const [name, value] of input.headers) {
    if (!HEADER_NAME.test(name) || hasLineBreakOrNul(value)) {
      throw new NetworkFetchError("invalid_request", "Request header is malformed");
    }
    const lower = name.toLowerCase();
    if (CREDENTIAL_HEADERS.has(lower)) {
      throw new NetworkFetchError(
        "credentials_unsupported",
        "Cookie and Authorization headers are not supported",
      );
    }
    if (FORWARDED_REQUEST_HEADERS.has(lower)) rawHeaders.push(name, value);
    else dropped.add(lower);
  }
  rawHeaders.push("Host", input.url.host, "Accept-Encoding", "identity", "Connection", "close");
  if (!SAFE_METHODS.has(input.method)) rawHeaders.push("Origin", input.origin ?? "null");
  if (input.bodyLength !== null) rawHeaders.push("Content-Length", String(input.bodyLength));
  else if (!input.hasBody && !SAFE_METHODS.has(input.method))
    rawHeaders.push("Content-Length", "0");

  const requestLine = input.method.length + input.url.pathname.length + input.url.search.length;
  let headBytes = requestLine + 12;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    headBytes += rawHeaders[index].length + rawHeaders[index + 1].length + 4;
  }
  return { rawHeaders, droppedRequestHeaders: [...dropped], headBytes };
}

export interface FilteredResponseHeaders {
  headers: HeaderList;
  setCookieDropped: number;
}

export function filterResponseHeaders(
  rawHeaders: readonly string[],
  options: { decoded: boolean },
): FilteredResponseHeaders {
  const connectionTokens = new Set<string>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() !== "connection") continue;
    for (const token of rawHeaders[index + 1].split(",")) {
      connectionTokens.add(token.trim().toLowerCase());
    }
  }
  const headers: HeaderList = [];
  let setCookieDropped = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const lower = name.toLowerCase();
    if (lower === "set-cookie") setCookieDropped += 1;
    const isTransportHeader = HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower);
    const isRewrittenByDecode =
      options.decoded && (lower === "content-encoding" || lower === "content-length");
    if (isTransportHeader || STRIPPED_RESPONSE_HEADERS.has(lower) || isRewrittenByDecode) continue;
    headers.push([name, rawHeaders[index + 1]]);
  }
  return { headers, setCookieDropped };
}

function hasLineBreakOrNul(value: string): boolean {
  return value.includes("\r") || value.includes("\n") || value.includes("\u0000");
}
