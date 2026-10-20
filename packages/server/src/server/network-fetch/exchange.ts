import http from "node:http";
import { isIP, type Socket } from "node:net";
import { pipeline, type Readable } from "node:stream";
import tls from "node:tls";
import zlib from "node:zlib";
import { TunnelCloseReason } from "@getpaseo/protocol/binary-frames/index";
import { dialTarget, type TunnelDial, type TunnelLookup } from "../network-tunnel/dial-target.js";
import {
  closeReasonForError,
  normalizeAddress,
  type TunnelHost,
} from "../network-tunnel/target-policy.js";
import { findAllowedTarget, parseRequestUrl, type TrustedAllowlist } from "./allowlist.js";
import {
  NetworkFetchError,
  NetworkFetchProtocolError,
  type NetworkFetchErrorCode,
} from "./errors.js";
import { buildUpstreamHead, filterResponseHeaders, type HeaderList } from "./headers.js";
import { reachesThisHost } from "./local-target.js";

export type NetworkFetchMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
export type NetworkFetchRedirectMode = "follow" | "manual" | "error";
export type NetworkFetchRequestBody = { kind: "none" } | { kind: "stream"; length: number | null };

export interface NetworkFetchRequest {
  /** Strictly increasing within a session; a repeated or older id is a replay. */
  requestId: number;
  method: NetworkFetchMethod;
  url: string;
  headers: HeaderList;
  /** The document origin the trusted broker bound this request to; never a page claim. */
  initiatorOrigin: string | null;
  redirect: NetworkFetchRedirectMode;
  body: NetworkFetchRequestBody;
}

export interface NetworkFetchRedirect {
  location: string;
  /** Whether the session may follow it; widening the allowlist needs the trusted control. */
  allowed: boolean;
}

export interface NetworkFetchResponseHead {
  status: number;
  statusText: string;
  headers: HeaderList;
  url: string;
  redirected: boolean;
  redirect: NetworkFetchRedirect | null;
  setCookieDropped: number;
  droppedRequestHeaders: string[];
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

export interface ExchangeEvents {
  head(head: NetworkFetchResponseHead): void;
  body(chunk: Uint8Array): void;
  end(): void;
  fail(error: NetworkFetchError): void;
  uploadCredit(bytes: number): void;
}

export interface ExchangeEnvironment {
  /** The session's allowlist; throws when the session stopped being current. */
  allowlist(): TrustedAllowlist;
  protectedLocalPorts(): ReadonlySet<number>;
  localAddresses(): readonly string[];
  lookup?: TunnelLookup;
  dial?: TunnelDial;
  /** Trusted roots; `null` keeps Node's bundled CA store. Validation is never disabled. */
  tlsCa: readonly string[] | null;
  limits: NetworkFetchLimits;
}

interface Hop {
  url: URL;
  method: NetworkFetchMethod;
  headers: HeaderList;
  origin: string | null;
  body: NetworkFetchRequestBody;
}

const METHODS = new Set<string>(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REQUEST_BODY_HEADERS = new Set([
  "content-encoding",
  "content-language",
  "content-location",
  "content-type",
]);
const TLS_CERTIFICATE_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const DIAL_ERROR_CODES: Partial<Record<number, NetworkFetchErrorCode>> = {
  [TunnelCloseReason.PolicyDenied]: "policy_denied",
  [TunnelCloseReason.HostNotFound]: "host_not_found",
  [TunnelCloseReason.ConnectionRefused]: "connection_refused",
  [TunnelCloseReason.NetworkUnreachable]: "network_unreachable",
  [TunnelCloseReason.Timeout]: "timeout",
};

/** Checks what can be refused before any network work, so the caller learns synchronously. */
export function validateRequest(request: NetworkFetchRequest, limits: NetworkFetchLimits): URL {
  if (!METHODS.has(request.method)) {
    throw new NetworkFetchError("invalid_request", "Request method is not supported");
  }
  const url = parseRequestUrl(request.url);
  const declared = request.body.kind === "stream" ? request.body.length : null;
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) {
    throw new NetworkFetchError("invalid_request", "Request body length is invalid");
  }
  if (declared !== null && declared > limits.maxRequestBodyBytes) {
    throw new NetworkFetchError("request_body_too_large", "Request body exceeds the limit");
  }
  if (request.body.kind === "stream" && (request.method === "GET" || request.method === "HEAD")) {
    throw new NetworkFetchError("invalid_request", "GET and HEAD requests cannot have a body");
  }
  return url;
}

/**
 * One request through the host network: every hop is matched against the allowlist and dialed
 * through the tunnel's target policy, TLS is validated, and the response streams under a credit
 * window. Nothing is emitted after the exchange settles or is cancelled.
 */
export class FetchExchange {
  private readonly abort = new AbortController();
  private settled = false;
  private request: http.ClientRequest | null = null;
  private socket: Socket | null = null;
  private body: Readable | null = null;
  private droppedRequestHeaders: string[] = [];

  private uploadOpen: boolean;
  private uploadEnded = false;
  private uploadQueue: Buffer[] = [];
  private uploadOutstanding = 0;
  private uploadTotal = 0;

  private responseCredit: number;
  private responseUnacked = 0;
  private responseTotal = 0;
  private responseQueue: Buffer[] = [];
  private responseEnded = false;

  constructor(
    private readonly input: NetworkFetchRequest,
    private readonly url: URL,
    private readonly env: ExchangeEnvironment,
    private readonly events: ExchangeEvents,
  ) {
    this.uploadOpen = input.body.kind === "stream";
    this.responseCredit = env.limits.initialWindowBytes;
  }

  start(): void {
    void this.run().catch((error: unknown) => this.failWith(error));
  }

  writeBody(chunk: Uint8Array): void {
    if (this.input.body.kind !== "stream" || this.uploadEnded) {
      throw new NetworkFetchProtocolError("body_not_expected", "Request does not accept a body");
    }
    if (this.settled || !this.uploadOpen) return;
    const { limits } = this.env;
    if (chunk.byteLength > limits.maxChunkBytes) {
      this.failWith(new NetworkFetchError("invalid_request", "Body chunk exceeds the chunk limit"));
      return;
    }
    if (this.uploadOutstanding + chunk.byteLength > limits.initialWindowBytes) {
      this.failWith(new NetworkFetchError("credit_exceeded", "Body exceeds the granted credit"));
      return;
    }
    this.uploadTotal += chunk.byteLength;
    const declared = this.input.body.length;
    if (this.uploadTotal > (declared ?? limits.maxRequestBodyBytes)) {
      const code = declared === null ? "request_body_too_large" : "invalid_request";
      this.failWith(new NetworkFetchError(code, "Body exceeds its declared or allowed size"));
      return;
    }
    this.uploadOutstanding += chunk.byteLength;
    this.uploadQueue.push(Buffer.from(chunk));
    this.flushUpload();
  }

  endBody(): void {
    if (this.input.body.kind !== "stream" || this.uploadEnded) {
      throw new NetworkFetchProtocolError("body_not_expected", "Request does not accept a body");
    }
    this.uploadEnded = true;
    if (this.settled || !this.uploadOpen) return;
    const declared = this.input.body.length;
    if (declared !== null && this.uploadTotal !== declared) {
      this.failWith(new NetworkFetchError("invalid_request", "Body is shorter than declared"));
      return;
    }
    this.flushUpload();
  }

  /** Credit for response bytes the final consumer wrote; more than was sent is a violation. */
  grantCredit(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.responseUnacked) {
      throw new NetworkFetchProtocolError("credit_overflow", "Credit exceeds bytes delivered");
    }
    this.responseUnacked -= bytes;
    this.responseCredit += bytes;
    this.flushResponse();
  }

  cancel(): void {
    if (this.settled) return;
    this.settled = true;
    this.teardown();
  }

  private async run(): Promise<void> {
    let hop: Hop = {
      url: this.url,
      method: this.input.method,
      headers: this.input.headers,
      origin: this.input.initiatorOrigin,
      body: this.input.body,
    };
    for (let redirects = 0; ; redirects += 1) {
      const allowlist = this.env.allowlist();
      if (!findAllowedTarget(allowlist, hop.url)) {
        const code = redirects === 0 ? "not_allowlisted" : "redirect_not_allowlisted";
        throw new NetworkFetchError(code, "Target is outside the session allowlist");
      }
      const response = await this.send(hop, redirects === 0);
      const location = redirectLocation(response, hop.url);
      if (!location || this.input.redirect === "manual") {
        const redirect = location
          ? { location: location.href, allowed: findAllowedTarget(allowlist, location) !== null }
          : null;
        this.deliver({ response, url: hop.url, redirected: redirects > 0, redirect });
        return;
      }
      if (this.input.redirect === "error") {
        throw new NetworkFetchError("redirect_error_mode", "Redirect refused by redirect mode");
      }
      if (redirects + 1 > this.env.limits.maxRedirects) {
        throw new NetworkFetchError("redirect_limit", "Too many redirects");
      }
      response.destroy();
      this.releaseHop();
      hop = nextHop(hop, location, response.statusCode ?? 0);
    }
  }

  private async send(hop: Hop, isFirstHop: boolean): Promise<http.IncomingMessage> {
    const head = buildUpstreamHead({
      method: hop.method,
      url: hop.url,
      headers: hop.headers,
      origin: hop.origin,
      bodyLength: hop.body.kind === "stream" ? hop.body.length : null,
      hasBody: hop.body.kind === "stream",
    });
    if (isFirstHop) this.droppedRequestHeaders = head.droppedRequestHeaders;
    if (head.headBytes > this.env.limits.maxRequestHeadBytes) {
      throw new NetworkFetchError("request_head_too_large", "Request head exceeds the limit");
    }
    const socket = await this.connect(hop.url);
    if (this.settled) {
      socket.destroy();
      throw new NetworkFetchError("upstream_error", "Exchange settled while connecting");
    }
    this.socket = socket;
    const request = http.request({
      method: hop.method,
      path: `${hop.url.pathname}${hop.url.search}`,
      headers: head.rawHeaders,
      setHost: false,
      maxHeaderSize: this.env.limits.maxResponseHeadBytes,
      // Without `agent`, Node uses createConnection; `agent: false` would dial host:port itself.
      createConnection: () => socket,
    });
    this.request = request;
    const response = awaitResponse(request, this.env.limits.responseHeadTimeoutMs);
    if (hop.body.kind === "stream" && this.uploadOpen) this.flushUpload();
    else request.end();
    return response;
  }

  private async connect(url: URL): Promise<Socket> {
    const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
    const host: TunnelHost = isIP(hostname)
      ? { kind: "literal", address: normalizeAddress(hostname) }
      : { kind: "name", hostname };
    const port = url.port ? Number(url.port) : defaultPort(url);
    const deadline = Date.now() + this.env.limits.connectTimeoutMs;
    const protectedPorts = this.env.protectedLocalPorts();
    let isSelfTarget = false;
    let socket: Socket;
    try {
      socket = await dialTarget({
        host,
        port,
        deadline,
        signal: this.abort.signal,
        lookup: this.env.lookup,
        dial: this.env.dial,
        isDenied: (address, targetPort) => {
          const denied =
            protectedPorts.has(targetPort) && reachesThisHost(address, this.env.localAddresses());
          isSelfTarget ||= denied;
          return denied;
        },
      });
    } catch (error) {
      if (isSelfTarget) {
        throw new NetworkFetchError("self_target_denied", "Target is a protected local listener");
      }
      throw dialError(error);
    }
    if (url.protocol !== "https:") return socket;
    return this.secure({ socket, hostname, deadline });
  }

  private secure(input: { socket: Socket; hostname: string; deadline: number }): Promise<Socket> {
    const { socket, hostname, deadline } = input;
    return new Promise<Socket>((resolve, reject) => {
      const secured = tls.connect({
        socket,
        // Identity is checked against `host`; left unset, Node checks against "localhost".
        host: hostname,
        servername: isIP(hostname) ? undefined : hostname,
        ca: this.env.tlsCa ? [...this.env.tlsCa] : undefined,
        ALPNProtocols: ["http/1.1"],
        rejectUnauthorized: true,
      });
      this.socket = secured;
      const settle = (outcome: { error: NetworkFetchError } | null) => {
        clearTimeout(timer);
        secured.removeListener("secureConnect", onSecure);
        secured.removeListener("error", onError);
        this.abort.signal.removeEventListener("abort", onAbort);
        if (outcome === null) {
          resolve(secured);
          return;
        }
        secured.destroy();
        reject(outcome.error);
      };
      const onSecure = () => settle(null);
      const onError = (error: Error) => settle({ error: tlsError(error) });
      const onAbort = () =>
        settle({ error: new NetworkFetchError("upstream_error", "Exchange cancelled") });
      const timer = setTimeout(
        () => settle({ error: new NetworkFetchError("timeout", "TLS handshake timed out") }),
        Math.max(1, deadline - Date.now()),
      );
      secured.once("secureConnect", onSecure);
      secured.once("error", onError);
      this.abort.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private deliver(input: {
    response: http.IncomingMessage;
    url: URL;
    redirected: boolean;
    redirect: NetworkFetchRedirect | null;
  }): void {
    const { response } = input;
    const decoder = decoderFor(response.headers["content-encoding"]);
    const body: Readable = decoder ?? response;
    if (decoder) {
      pipeline(response, decoder, (error) => {
        if (error) this.failWith(new NetworkFetchError("upstream_error", "Response body failed"));
      });
    }
    this.body = body;
    const filtered = filterResponseHeaders(response.rawHeaders, { decoded: decoder !== null });
    this.events.head({
      status: response.statusCode ?? 0,
      statusText: response.statusMessage ?? "",
      headers: filtered.headers,
      url: input.url.href,
      redirected: input.redirected,
      redirect: input.redirect,
      setCookieDropped: filtered.setCookieDropped,
      droppedRequestHeaders: this.droppedRequestHeaders,
    });
    body.on("data", (chunk: Buffer) => this.receiveResponse(chunk));
    body.once("end", () => {
      this.responseEnded = true;
      this.flushResponse();
    });
    body.on("error", () => {
      this.failWith(new NetworkFetchError("upstream_error", "Response body failed"));
    });
    body.once("close", () => {
      if (!this.responseEnded) {
        this.failWith(new NetworkFetchError("upstream_error", "Response ended early"));
      }
    });
  }

  private receiveResponse(chunk: Buffer): void {
    if (this.settled) return;
    this.responseTotal += chunk.length;
    if (this.responseTotal > this.env.limits.maxResponseBodyBytes) {
      this.failWith(new NetworkFetchError("response_body_too_large", "Response exceeds the limit"));
      return;
    }
    const { maxChunkBytes } = this.env.limits;
    for (let offset = 0; offset < chunk.length; offset += maxChunkBytes) {
      this.responseQueue.push(chunk.subarray(offset, offset + maxChunkBytes));
    }
    this.flushResponse();
  }

  /** Sends what the credit allows; otherwise holds at most one read chunk and pauses the source. */
  private flushResponse(): void {
    while (!this.settled && this.responseQueue.length > 0 && this.responseCredit > 0) {
      const next = this.responseQueue[0];
      const piece =
        next.length <= this.responseCredit ? next : next.subarray(0, this.responseCredit);
      if (piece === next) this.responseQueue.shift();
      else this.responseQueue[0] = next.subarray(piece.length);
      this.responseCredit -= piece.length;
      this.responseUnacked += piece.length;
      this.events.body(piece);
    }
    if (this.settled) return;
    if (this.responseQueue.length > 0) {
      this.body?.pause();
      return;
    }
    if (this.responseEnded) {
      this.settled = true;
      this.teardown();
      this.events.end();
      return;
    }
    this.body?.resume();
  }

  /** Credit goes back only after the upstream socket accepted the bytes, never on receipt. */
  private flushUpload(): void {
    const request = this.request;
    if (!request) return;
    for (const chunk of this.uploadQueue.splice(0)) {
      request.write(chunk, () => {
        this.uploadOutstanding -= chunk.length;
        if (!this.settled && this.uploadOpen) this.events.uploadCredit(chunk.length);
      });
    }
    if (this.uploadEnded) request.end();
  }

  private releaseHop(): void {
    this.uploadOpen = false;
    this.uploadQueue = [];
    this.request?.destroy();
    this.socket?.destroy();
    this.request = null;
    this.socket = null;
  }

  private failWith(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.teardown();
    this.events.fail(toFetchError(error));
  }

  private teardown(): void {
    this.abort.abort();
    this.uploadQueue = [];
    this.responseQueue = [];
    this.body?.destroy();
    this.request?.destroy();
    this.socket?.destroy();
  }
}

/** The head timeout starts once the body is written: a slow upload is not a slow server. */
function awaitResponse(
  request: http.ClientRequest,
  timeoutMs: number,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let responded = false;
    request.once("finish", () => {
      // A server may answer before reading the whole body.
      if (responded) return;
      timer = setTimeout(() => {
        reject(new NetworkFetchError("timeout", "Response head timed out"));
        request.destroy();
      }, timeoutMs);
    });
    request.once("response", (response) => {
      responded = true;
      clearTimeout(timer);
      resolve(response);
    });
    // Kept after settling: destroying a request without a response emits a late error.
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(
        errorCode(error) === "HPE_HEADER_OVERFLOW"
          ? new NetworkFetchError("response_head_too_large", "Response head exceeds the limit")
          : new NetworkFetchError("upstream_error", "Upstream request failed"),
      );
    });
  });
}

function redirectLocation(response: http.IncomingMessage, base: URL): URL | null {
  const location = response.headers.location;
  if (!REDIRECT_STATUSES.has(response.statusCode ?? 0) || location === undefined) return null;
  try {
    return parseRequestUrl(new URL(location, base).href);
  } catch {
    throw new NetworkFetchError("upstream_error", "Redirect location is invalid");
  }
}

/** Fetch Standard method rewrites; a streamed body cannot be replayed to a new hop. */
function nextHop(hop: Hop, location: URL, status: number): Hop {
  const becomesGet =
    ((status === 301 || status === 302) && hop.method === "POST") ||
    (status === 303 && hop.method !== "GET" && hop.method !== "HEAD");
  if (!becomesGet && hop.body.kind === "stream") {
    throw new NetworkFetchError("redirect_body_unreplayable", "Redirect would replay the body");
  }
  const origin = location.origin === hop.url.origin ? hop.origin : null;
  if (!becomesGet) return { ...hop, url: location, origin };
  const headers = hop.headers.filter(([name]) => !REQUEST_BODY_HEADERS.has(name.toLowerCase()));
  return { url: location, method: "GET", headers, origin, body: { kind: "none" } };
}

function decoderFor(
  header: string | undefined,
): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  const encoding = (header ?? "").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") return null;
  if (encoding === "gzip" || encoding === "x-gzip") return zlib.createGunzip();
  if (encoding === "deflate") return zlib.createInflate();
  if (encoding === "br") return zlib.createBrotliDecompress();
  throw new NetworkFetchError("unsupported_encoding", "Response content encoding is unsupported");
}

function defaultPort(url: URL): number {
  return url.protocol === "https:" ? 443 : 80;
}

function dialError(error: unknown): NetworkFetchError {
  const code = DIAL_ERROR_CODES[closeReasonForError(error)] ?? "upstream_error";
  return new NetworkFetchError(code, "Could not connect to the target");
}

function tlsError(error: Error): NetworkFetchError {
  const code = errorCode(error);
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return new NetworkFetchError("tls_hostname_mismatch", "Certificate does not match the host");
  }
  if (TLS_CERTIFICATE_CODES.has(code)) {
    return new NetworkFetchError("tls_certificate_invalid", "Certificate is not trusted");
  }
  return new NetworkFetchError("tls_error", "TLS handshake failed");
}

function errorCode(error: Error): string {
  return "code" in error && typeof error.code === "string" ? error.code : "";
}

function toFetchError(error: unknown): NetworkFetchError {
  if (error instanceof NetworkFetchError) return error;
  return new NetworkFetchError("upstream_error", "Upstream request failed");
}
