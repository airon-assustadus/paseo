import type { BridgeHeaders } from "./bridge-messages";

// Issued by trusted control code from one target of the host's allowlist (origin and path
// prefix). The content never names the destination: requests carry only a path, resolved here.
// contentOrigin identifies the channel (event.origin of the frame); it is never sent upstream.
export interface WebProxyCapability {
  contentOrigin: string;
  destinationOrigin: string;
  // "/" or a path ending in "/"; requests and redirects outside it are refused.
  pathPrefix: string;
}

export class InvalidCapabilityError extends Error {
  constructor(readonly field: keyof WebProxyCapability) {
    super(`Invalid web proxy capability: ${field}`);
    this.name = "InvalidCapabilityError";
  }
}

function isExactHttpOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  const isHttp = url.protocol === "http:" || url.protocol === "https:";
  return isHttp && url.origin === value;
}

const ENCODED_SEPARATOR = /%(2f|5c)/i;

// The prefix must already be in the form URL parsing produces, so a comparison on the
// normalized request path is exact.
function isCanonicalPathPrefix(prefix: string): boolean {
  if (!prefix.startsWith("/") || !prefix.endsWith("/") || prefix.startsWith("//")) return false;
  if (prefix.includes("%") || prefix.includes("\\")) return false;
  return new URL(prefix, "http://prefix.invalid").pathname === prefix;
}

export function createCapability(capability: WebProxyCapability): WebProxyCapability {
  if (!isExactHttpOrigin(capability.contentOrigin)) {
    throw new InvalidCapabilityError("contentOrigin");
  }
  if (!isExactHttpOrigin(capability.destinationOrigin)) {
    throw new InvalidCapabilityError("destinationOrigin");
  }
  if (!isCanonicalPathPrefix(capability.pathPrefix)) {
    throw new InvalidCapabilityError("pathPrefix");
  }
  return {
    contentOrigin: capability.contentOrigin,
    destinationOrigin: capability.destinationOrigin,
    pathPrefix: capability.pathPrefix,
  };
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export type DestinationUrlResult =
  | { kind: "ok"; url: URL }
  | { kind: "invalid" }
  | { kind: "path_not_allowed" };

function isInsidePrefix(url: URL, capability: WebProxyCapability): boolean {
  if (capability.pathPrefix === "/") return true;
  // Encoded separators could be decoded upstream into a path outside the prefix.
  return url.pathname.startsWith(capability.pathPrefix) && !ENCODED_SEPARATOR.test(url.pathname);
}

export function resolveDestinationUrl(
  capability: WebProxyCapability,
  path: string,
): DestinationUrlResult {
  // "//host" and "\\host" are scheme-relative to URL parsers; neither may pick the origin.
  const isRootPath = path.startsWith("/") && !path.startsWith("//");
  if (!isRootPath || path.includes("\\") || hasControlCharacter(path)) return { kind: "invalid" };
  const url = new URL(path, capability.destinationOrigin);
  if (url.origin !== capability.destinationOrigin) return { kind: "invalid" };
  url.hash = "";
  // Checked after parsing, so dot segments (also "%2e%2e") are already resolved.
  if (!isInsidePrefix(url, capability)) return { kind: "path_not_allowed" };
  return { kind: "ok", url };
}

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
];

// Identity, cookies and fetch metadata come from the capability and the host's jar, never from
// headers the content chose.
const DROPPED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP,
  "host",
  "cookie",
  "cookie2",
  "origin",
  "referer",
]);

// Cookies stay in the host's jar; HSTS, Alt-Svc, NEL and Report-To would teach the phone's
// browser to contact the destination directly.
const DROPPED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP,
  "set-cookie",
  "set-cookie2",
  "strict-transport-security",
  "alt-svc",
  "public-key-pins",
  "public-key-pins-report-only",
  "report-to",
  "nel",
  "clear-site-data",
  "location",
]);

function isDroppedRequestHeader(name: string): boolean {
  return DROPPED_REQUEST_HEADERS.has(name) || name.startsWith("sec-") || name.startsWith("proxy-");
}

export function filterRequestHeaders(headers: BridgeHeaders): BridgeHeaders {
  const kept: BridgeHeaders = [];
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (!isDroppedRequestHeader(name)) kept.push([name, value]);
  }
  return kept;
}

export type ResponseHeadersResult =
  | { kind: "pass"; headers: BridgeHeaders }
  | { kind: "redirect_blocked" };

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function mapLocation(input: {
  location: string;
  requestUrl: URL;
  capability: WebProxyCapability;
}): string | null {
  if (!URL.canParse(input.location, input.requestUrl)) return null;
  const target = new URL(input.location, input.requestUrl);
  const { capability } = input;
  // A path starting with "//" would read as scheme-relative once it is a Location again.
  if (target.origin !== capability.destinationOrigin || target.pathname.startsWith("//")) {
    return null;
  }
  if (!isInsidePrefix(target, capability)) return null;
  return `${target.pathname}${target.search}${target.hash}`;
}

// A Location inside the capability becomes a path, so the browser follows it on the content
// origin and the next hop is a new request checked here again. Any other target would widen
// the capability and needs a decision on the control side.
export function filterResponseHeaders(input: {
  status: number;
  headers: BridgeHeaders;
  requestUrl: URL;
  capability: WebProxyCapability;
}): ResponseHeadersResult {
  const kept: BridgeHeaders = [];
  let location: string | null = null;
  for (const [rawName, value] of input.headers) {
    const name = rawName.toLowerCase();
    if (name === "location") location = value;
    if (!DROPPED_RESPONSE_HEADERS.has(name) && !name.startsWith("proxy-")) {
      kept.push([name, value]);
    }
  }
  if (location === null) return { kind: "pass", headers: kept };
  if (!REDIRECT_STATUSES.has(input.status)) return { kind: "pass", headers: kept };
  const mapped = mapLocation({
    location,
    requestUrl: input.requestUrl,
    capability: input.capability,
  });
  if (mapped === null) return { kind: "redirect_blocked" };
  kept.push(["location", mapped]);
  return { kind: "pass", headers: kept };
}
