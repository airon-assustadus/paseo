import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { exitPage, lightPage, probePage, spaPage } from "./pages.js";
import type { FixtureListenerName, FixtureRecorder, SafeRequestHeaders } from "./recorder.js";

/**
 * HTTP routes shared by every fixture listener. Each handler is a scenario from the validation
 * catalogue (04-validation §4.2); the mapping lives in fixtures-contract.md. Handlers never open
 * outbound connections: a redirect only emits `Location`, a canary only records the hit.
 */

export interface FixtureLimits {
  echoBodyBytes: number;
  probeReportBytes: number;
  slowMaxBytes: number;
  largeMaxBytes: number;
  uploadMaxBytes: number;
  sseMaxEvents: number;
  rangeBytes: number;
  maxPostTokens: number;
  maxIssuedCookies: number;
  maxHeldPosts: number;
  maxEvents: number;
}

export const DEFAULT_FIXTURE_LIMITS: FixtureLimits = {
  echoBodyBytes: 1024 * 1024,
  probeReportBytes: 64 * 1024,
  slowMaxBytes: 1024 * 1024,
  largeMaxBytes: 256 * 1024 * 1024,
  uploadMaxBytes: 64 * 1024 * 1024,
  sseMaxEvents: 10_000,
  rangeBytes: 1024 * 1024,
  maxPostTokens: 1000,
  maxIssuedCookies: 1000,
  maxHeldPosts: 64,
  maxEvents: 10_000,
};

export interface FixtureState {
  readonly recorder: FixtureRecorder;
  readonly limits: FixtureLimits;
  /** Origins the pages may reference: every listener of this fixture plus the caller's peers. */
  readonly allowedOrigins: Set<string>;
  readonly issuedCookieValues: Set<string>;
  readonly postCounts: Map<string, number>;
  /** POST responses retained behind the `hold=1` barrier until `releaseHeldPosts`. */
  readonly heldPosts: HeldPost[];
}

export interface HeldPost {
  token: string;
  nonce: string;
  listener: FixtureListenerName;
  count: number;
  res: ServerResponse;
  released: boolean;
}

/** Answers every held POST for `token`; returns how many were released, delivered or not. */
export function releaseHeldPosts(state: FixtureState, token: string): number {
  const matching = state.heldPosts.filter((held) => held.token === token);
  for (const held of matching) {
    state.heldPosts.splice(state.heldPosts.indexOf(held), 1);
    held.released = true;
    const delivered = !held.res.destroyed && !held.res.writableEnded;
    if (delivered) sendJson(held.res, 200, { token, count: held.count, held: true });
    state.recorder.record({
      kind: "post.released",
      listener: held.listener,
      nonce: held.nonce,
      token,
      delivered,
    });
  }
  return matching.length;
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  nonce: string;
  listener: FixtureListenerName;
  secure: boolean;
  origin: string;
  state: FixtureState;
}

export interface RequestListenerOptions {
  listener: FixtureListenerName;
  secure: boolean;
  origin(): string;
  state: FixtureState;
  canaryOnly: boolean;
}

export class FixtureRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "FixtureRequestError";
  }
}

const NONCE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PATTERN_PERIOD = 251;
const CHUNK_BYTES = 64 * 1024;
const PATTERN_BASE = Buffer.from(
  Array.from({ length: CHUNK_BYTES + PATTERN_PERIOD }, (_, index) => index % PATTERN_PERIOD),
);
/** Hosts the redirect fixture may point at: the policy must refuse them, so it must see them. */
const SYNTHETIC_REDIRECT_HOSTS = new Set([
  "169.254.169.254",
  "fe80::1",
  "100.100.100.200",
  "64:ff9b::a9fe:a9fe",
  "localhost",
  "127.0.0.1",
  "::1",
]);

export function resolveNonce(req: IncomingMessage, url: URL): string {
  const header = req.headers["x-fixture-nonce"];
  const candidate = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("n");
  if (candidate === null || candidate === undefined) return randomUUID();
  if (!NONCE_PATTERN.test(candidate)) throw new FixtureRequestError(400, "invalid_nonce");
  return candidate;
}

/** Bytes `offset..offset+length` of the deterministic body pattern `byte[i] = i % 251`. */
export function patternChunk(offset: number, length: number): Buffer {
  const start = offset % PATTERN_PERIOD;
  return PATTERN_BASE.subarray(start, start + length);
}

export function createRequestListener(options: RequestListenerOptions): RequestListener {
  return function onRequest(req, res) {
    const url = new URL(req.url ?? "/", options.origin());
    let nonce: string;
    try {
      nonce = resolveNonce(req, url);
    } catch (error) {
      if (error instanceof FixtureRequestError) {
        sendJson(res, error.status, { error: error.code });
        return;
      }
      throw error;
    }
    const context: RouteContext = {
      req,
      res,
      url,
      nonce,
      listener: options.listener,
      secure: options.secure,
      origin: options.origin(),
      state: options.state,
    };
    recordRequest(context);
    res.setHeader("x-fixture-nonce", nonce);
    res.setHeader("cache-control", "no-store");
    dispatch(context, options.canaryOnly ? CANARY_ROUTES : ROUTES);
  };
}

interface Route {
  method: "GET" | "POST" | "ANY";
  pattern: RegExp;
  handle(context: RouteContext, match: RegExpExecArray): void;
}

function dispatch(context: RouteContext, routes: readonly Route[]): void {
  const { url, req, res } = context;
  const matched = routes
    .map((route) => ({ route, match: route.pattern.exec(url.pathname) }))
    .find((entry) => entry.match !== null);
  if (!matched || !matched.match) {
    sendJson(res, 404, { error: "not_found", path: url.pathname });
    return;
  }
  const method = req.method ?? "GET";
  if (matched.route.method !== "ANY" && matched.route.method !== method) {
    res.setHeader("allow", matched.route.method);
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  matched.route.handle(context, matched.match);
}

function recordRequest(context: RouteContext): void {
  const { req } = context;
  const headerNames = [
    ...new Set(req.rawHeaders.filter((_, index) => index % 2 === 0).map((h) => h.toLowerCase())),
  ].sort();
  context.state.recorder.record({
    kind: "request",
    listener: context.listener,
    nonce: context.nonce,
    method: req.method ?? "GET",
    path: context.url.pathname,
    remoteAddress: req.socket.remoteAddress ?? "",
    headerNames,
    cookieNames: parseCookieNames(req.headers.cookie),
    headers: safeHeaders(req),
  });
}

function safeHeaders(req: IncomingMessage): SafeRequestHeaders {
  const single = (name: string): string | null => {
    const value = req.headers[name];
    return (Array.isArray(value) ? value[0] : value) ?? null;
  };
  return {
    host: single("host"),
    origin: single("origin"),
    referer: single("referer"),
    userAgent: single("user-agent"),
    secFetchSite: single("sec-fetch-site"),
    secFetchMode: single("sec-fetch-mode"),
    secFetchDest: single("sec-fetch-dest"),
  };
}

function parseCookies(header: string | undefined): Array<{ name: string; value: string }> {
  if (!header) return [];
  return header
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const separator = pair.indexOf("=");
      return separator === -1
        ? { name: pair, value: "" }
        : { name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1).trim() };
    });
}

function parseCookieNames(header: string | undefined): string[] {
  return parseCookies(header).map((cookie) => cookie.name);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
  });
  res.end(payload);
}

function sendHtml(context: RouteContext, html: string): void {
  const payload = Buffer.from(html, "utf8");
  context.res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": payload.length,
  });
  context.res.end(payload);
}

function integerParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return Math.min(Math.max(fallback, min), max);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new FixtureRequestError(400, `invalid_${name}`);
  }
  return parsed;
}

type BodyOutcome =
  | { status: "complete"; body: Buffer }
  | { status: "too_large"; bytesReceived: number }
  | { status: "aborted"; bytesReceived: number };

function readBody(req: IncomingMessage, limit: number): Promise<BodyOutcome> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const settle = (outcome: BodyOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit) {
        req.pause();
        settle({ status: "too_large", bytesReceived: received });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => settle({ status: "complete", body: Buffer.concat(chunks) }));
    req.on("close", () => settle({ status: "aborted", bytesReceived: received }));
    req.on("error", () => settle({ status: "aborted", bytesReceived: received }));
  });
}

function guarded(handler: (context: RouteContext, match: RegExpExecArray) => void) {
  return (context: RouteContext, match: RegExpExecArray) => {
    try {
      handler(context, match);
    } catch (error) {
      if (error instanceof FixtureRequestError) {
        sendJson(context.res, error.status, { error: error.code });
        return;
      }
      throw error;
    }
  };
}

function requireAllowedOrigin(context: RouteContext, name: string): string {
  const raw = context.url.searchParams.get(name);
  if (raw === null) throw new FixtureRequestError(400, `missing_${name}`);
  let origin: string;
  try {
    origin = new URL(raw).origin;
  } catch {
    throw new FixtureRequestError(400, `invalid_${name}`);
  }
  if (origin !== raw || !context.state.allowedOrigins.has(origin)) {
    throw new FixtureRequestError(400, `${name}_not_allowed`);
  }
  return origin;
}

function serveLight(context: RouteContext): void {
  sendHtml(context, lightPage({ nonce: context.nonce, origin: context.origin }));
}

function serveSpa(context: RouteContext): void {
  sendHtml(context, spaPage({ nonce: context.nonce, origin: context.origin }));
}

const serveProbe = guarded((context) => {
  const peer = requireAllowedOrigin(context, "peer");
  sendHtml(context, probePage({ nonce: context.nonce, origin: context.origin, peer }));
});

const serveExit = guarded((context) => {
  const decoy = requireAllowedOrigin(context, "decoy");
  const token = context.url.searchParams.get("token") ?? "exit";
  if (!TOKEN_PATTERN.test(token)) throw new FixtureRequestError(400, "invalid_token");
  sendHtml(context, exitPage({ nonce: context.nonce, origin: context.origin, decoy, token }));
});

function allowCrossOrigin(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, x-fixture-nonce");
}

function probeReport(context: RouteContext): void {
  const { req, res, state } = context;
  allowCrossOrigin(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  void readBody(req, state.limits.probeReportBytes).then((outcome) =>
    finishProbeReport(context, outcome),
  );
}

function finishProbeReport(context: RouteContext, outcome: BodyOutcome): void {
  const { req, res, state } = context;
  if (outcome.status === "too_large") {
    sendJson(res, 413, { error: "too_large", limit: state.limits.probeReportBytes });
    req.destroy();
    return;
  }
  if (outcome.status === "aborted") return;
  let report: unknown;
  try {
    report = JSON.parse(outcome.body.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }
  state.recorder.record({
    kind: "probe.report",
    listener: context.listener,
    nonce: context.nonce,
    report,
  });
  res.writeHead(204).end();
}

function canaryHit(context: RouteContext, match: RegExpExecArray): void {
  const { req, res, state } = context;
  allowCrossOrigin(res);
  const headers = safeHeaders(req);
  state.recorder.record({
    kind: "canary.hit",
    listener: context.listener,
    nonce: context.nonce,
    token: match[1],
    vector: context.url.searchParams.get("v"),
    method: req.method ?? "GET",
    remoteAddress: req.socket.remoteAddress ?? "",
    userAgent: headers.userAgent,
    origin: headers.origin,
    referer: headers.referer,
  });
  req.resume();
  req.on("end", () => res.writeHead(204).end());
}

function echo(context: RouteContext): void {
  const { req, url, state } = context;
  const query: Record<string, string[]> = {};
  for (const [key, value] of url.searchParams) (query[key] ??= []).push(value);
  const headerNames = [
    ...new Set(req.rawHeaders.filter((_, index) => index % 2 === 0).map((h) => h.toLowerCase())),
  ].sort();
  void readBody(req, state.limits.echoBodyBytes).then((outcome) =>
    finishEcho(context, query, headerNames, outcome),
  );
}

function finishEcho(
  context: RouteContext,
  query: Record<string, string[]>,
  headerNames: string[],
  outcome: BodyOutcome,
): void {
  const { req, res, url, state } = context;
  if (outcome.status === "too_large") {
    sendJson(res, 413, { error: "too_large", limit: state.limits.echoBodyBytes });
    req.destroy();
    return;
  }
  if (outcome.status === "aborted") return;
  sendJson(res, 200, {
    method: req.method ?? "GET",
    path: url.pathname,
    query,
    headerNames,
    cookieNames: parseCookieNames(req.headers.cookie),
    headers: safeHeaders(req),
    contentType: req.headers["content-type"] ?? null,
    bodyBytes: outcome.body.length,
    body: outcome.body.length > 0 ? outcome.body.toString("utf8") : null,
    nonce: context.nonce,
    secure: context.secure,
    listener: context.listener,
  });
}

const SESSION_COOKIE = "fixture_sess";
const PLAIN_COOKIE = "fixture_plain";
const HOST_COOKIE = "__Host-fixture";

function cookieSet(context: RouteContext): void {
  const { res, state, secure } = context;
  const issue = () => {
    const value = randomBytes(16).toString("hex");
    state.issuedCookieValues.add(value);
    // Oldest first: a long-running fixture forgets stale values instead of growing without bound.
    while (state.issuedCookieValues.size > state.limits.maxIssuedCookies) {
      const oldest = state.issuedCookieValues.values().next().value;
      if (oldest === undefined) break;
      state.issuedCookieValues.delete(oldest);
    }
    return value;
  };
  const secureFlag = secure ? "; Secure" : "";
  const cookies = [
    `${SESSION_COOKIE}=${issue()}; Path=/; HttpOnly; SameSite=Lax${secureFlag}`,
    `${PLAIN_COOKIE}=${issue()}; Path=/; SameSite=Lax${secureFlag}`,
  ];
  if (secure) cookies.push(`${HOST_COOKIE}=${issue()}; Path=/; Secure; SameSite=Lax`);
  res.setHeader("set-cookie", cookies);
  sendJson(res, 200, {
    issued: cookies.map((cookie) => cookie.slice(0, cookie.indexOf("="))),
    secure,
  });
}

function cookieRead(context: RouteContext): void {
  const cookies = parseCookies(context.req.headers.cookie);
  const recognized = cookies
    .filter((cookie) => context.state.issuedCookieValues.has(cookie.value))
    .map((cookie) => cookie.name);
  sendJson(context.res, 200, {
    names: cookies.map((cookie) => cookie.name),
    recognized,
    unknown: cookies.map((cookie) => cookie.name).filter((name) => !recognized.includes(name)),
  });
}

function cookieClear(context: RouteContext): void {
  const expire = "; Path=/; Max-Age=0; SameSite=Lax";
  context.res.setHeader("set-cookie", [
    `${SESSION_COOKIE}=${expire}; HttpOnly${context.secure ? "; Secure" : ""}`,
    `${PLAIN_COOKIE}=${expire}${context.secure ? "; Secure" : ""}`,
    `${HOST_COOKIE}=${expire}; Secure`,
  ]);
  sendJson(context.res, 200, { cleared: [SESSION_COOKIE, PLAIN_COOKIE, HOST_COOKIE] });
}

function withNonce(path: string, nonce: string): string {
  return `${path}?n=${encodeURIComponent(nonce)}`;
}

function redirectTo(context: RouteContext, status: number, location: string): void {
  context.req.resume();
  const payload = Buffer.from(`redirect ${status} -> ${location}\n`);
  context.res.writeHead(status, {
    location,
    "content-type": "text/plain; charset=utf-8",
    "content-length": payload.length,
  });
  context.res.end(payload);
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function resolveRedirectTarget(context: RouteContext): string {
  const to = context.url.searchParams.get("to");
  if (to === null) return withNonce("/redirect/landing", context.nonce);
  if (hasControlCharacters(to)) throw new FixtureRequestError(400, "invalid_to");
  if (to.startsWith("/") && !to.startsWith("//")) return to;
  let parsed: URL;
  try {
    parsed = new URL(to);
  } catch {
    throw new FixtureRequestError(400, "invalid_to");
  }
  const hostname = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  const permitted =
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    (SYNTHETIC_REDIRECT_HOSTS.has(hostname) || context.state.allowedOrigins.has(parsed.origin));
  if (!permitted) throw new FixtureRequestError(400, "to_not_allowed");
  return to;
}

const redirectWithCode = guarded((context, match) => {
  redirectTo(context, Number.parseInt(match[1], 10), resolveRedirectTarget(context));
});

function redirectLoop(context: RouteContext): void {
  redirectTo(context, 302, withNonce("/redirect/loop", context.nonce));
}

function redirectChain(context: RouteContext, match: RegExpExecArray): void {
  const remaining = Number.parseInt(match[1], 10);
  const next = remaining <= 1 ? "/redirect/landing" : `/redirect/chain/${remaining - 1}`;
  redirectTo(context, 302, withNonce(next, context.nonce));
}

function redirectLanding(context: RouteContext): void {
  const { req, res } = context;
  let bodyBytes = 0;
  req.on("data", (chunk: Buffer) => {
    bodyBytes += chunk.length;
  });
  req.on("end", () => {
    context.state.recorder.record({
      kind: "redirect.landing",
      listener: context.listener,
      nonce: context.nonce,
      method: req.method ?? "GET",
      bodyBytes,
    });
    sendJson(res, 200, { landed: true, method: req.method ?? "GET", bodyBytes });
  });
}

const slowBody = guarded((context) => {
  const { url, res, state } = context;
  const bytes = integerParam(url, "bytes", 4096, 1, state.limits.slowMaxBytes);
  const chunk = integerParam(url, "chunk", 64, 1, bytes);
  const intervalMs = integerParam(url, "intervalMs", 25, 1, 10_000);
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes });
  let sent = 0;
  const timer = setInterval(() => {
    if (res.destroyed) return;
    const length = Math.min(chunk, bytes - sent);
    res.write(patternChunk(sent, length));
    sent += length;
    if (sent >= bytes) {
      clearInterval(timer);
      res.end();
    }
  }, intervalMs);
  res.on("close", () => {
    clearInterval(timer);
    state.recorder.record({
      kind: "slow.closed",
      listener: context.listener,
      nonce: context.nonce,
      completed: sent >= bytes && res.writableFinished,
      bytesSent: sent,
    });
  });
});

const largeBody = guarded((context) => {
  const { url, res, state } = context;
  const bytes = integerParam(url, "bytes", 8 * 1024 * 1024, 1, state.limits.largeMaxBytes);
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": bytes,
    "content-disposition": `attachment; filename="fixture-${bytes}.bin"`,
  });
  let offset = 0;
  let maxBuffered = 0;
  const pump = () => {
    while (offset < bytes && !res.destroyed) {
      const length = Math.min(CHUNK_BYTES, bytes - offset);
      const writable = res.write(patternChunk(offset, length));
      offset += length;
      maxBuffered = Math.max(maxBuffered, res.writableLength);
      if (!writable) {
        res.once("drain", pump);
        return;
      }
    }
    if (!res.destroyed) res.end();
  };
  res.on("close", () => {
    state.recorder.record({
      kind: "large.closed",
      listener: context.listener,
      nonce: context.nonce,
      completed: offset >= bytes && res.writableFinished,
      bytesSent: offset,
      maxBuffered,
    });
  });
  pump();
});

function parseRange(
  header: string | undefined,
  total: number,
): [number, number] | null | "invalid" {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return "invalid";
  if (match[1] === "") {
    const suffix = Number.parseInt(match[2], 10);
    return suffix === 0 ? "invalid" : [Math.max(total - suffix, 0), total - 1];
  }
  const start = Number.parseInt(match[1], 10);
  const end = match[2] === "" ? total - 1 : Math.min(Number.parseInt(match[2], 10), total - 1);
  return start > end || start >= total ? "invalid" : [start, end];
}

function rangeBody(context: RouteContext): void {
  const { req, res, state } = context;
  const total = state.limits.rangeBytes;
  const range = parseRange(req.headers.range, total);
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("etag", '"fixture-range-v1"');
  if (range === "invalid") {
    res.writeHead(416, { "content-range": `bytes */${total}` }).end();
    return;
  }
  const [start, end] = range ?? [0, total - 1];
  const length = end - start + 1;
  const headers: Record<string, string | number> = {
    "content-type": "application/octet-stream",
    "content-length": length,
  };
  if (range) headers["content-range"] = `bytes ${start}-${end}/${total}`;
  res.writeHead(range ? 206 : 200, headers);
  const body = Buffer.alloc(length);
  for (let offset = 0; offset < length; offset += CHUNK_BYTES) {
    const step = Math.min(CHUNK_BYTES, length - offset);
    patternChunk(start + offset, step).copy(body, offset);
  }
  res.end(body);
}

const upload = guarded((context) => {
  const { req, res, url, state } = context;
  const limit = integerParam(
    url,
    "limit",
    state.limits.uploadMaxBytes,
    1,
    state.limits.uploadMaxBytes,
  );
  const rejectEarly = url.searchParams.get("mode") === "early";
  const hash = createHash("sha256");
  let received = 0;
  let rejected = false;
  let recorded = false;
  const finish = (completed: boolean) => {
    if (recorded) return;
    recorded = true;
    state.recorder.record({
      kind: "upload.finished",
      listener: context.listener,
      nonce: context.nonce,
      completed,
      bytesReceived: received,
      rejected: rejected ? "too_large" : null,
    });
  };
  req.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (rejected) {
      // Draining past the limit lets a client finish writing and read the 413 instead of a reset.
      if (received > state.limits.uploadMaxBytes) req.destroy();
      return;
    }
    if (received > limit) {
      rejected = true;
      sendJson(res, 413, { error: "too_large", limit });
      if (rejectEarly) req.destroy();
      return;
    }
    hash.update(chunk);
  });
  req.on("end", () => {
    if (!rejected) sendJson(res, 200, { bytesReceived: received, sha256: hash.digest("hex") });
    finish(!rejected);
  });
  req.on("close", () => finish(false));
});

function postCounter(context: RouteContext, match: RegExpExecArray): void {
  const { req, res, state } = context;
  const token = match[1];
  if (req.method === "GET") {
    sendJson(res, 200, { token, count: state.postCounts.get(token) ?? 0 });
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("allow", "GET, POST");
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (!state.postCounts.has(token)) {
    if (state.postCounts.size >= state.limits.maxPostTokens) {
      sendJson(res, 429, { error: "too_many_tokens", limit: state.limits.maxPostTokens });
      return;
    }
    // Reserve the slot on arrival: two slow POSTs for different tokens must not both pass the cap.
    state.postCounts.set(token, 0);
  }
  const hold = context.url.searchParams.get("hold") === "1";
  if (hold && state.heldPosts.length >= state.limits.maxHeldPosts) {
    sendJson(res, 429, { error: "too_many_held", limit: state.limits.maxHeldPosts });
    return;
  }
  state.recorder.record({
    kind: "post.arrived",
    listener: context.listener,
    nonce: context.nonce,
    token,
    held: hold,
  });
  req.resume();
  req.on("end", () => {
    const count = (state.postCounts.get(token) ?? 0) + 1;
    state.postCounts.set(token, count);
    state.recorder.record({
      kind: "post.count",
      listener: context.listener,
      nonce: context.nonce,
      token,
      count,
    });
    if (!hold) {
      sendJson(res, 200, { token, count });
      return;
    }
    holdPost(context, token, count);
  });
}

function holdPost(context: RouteContext, token: string, count: number): void {
  const { res, state } = context;
  const held: HeldPost = {
    token,
    nonce: context.nonce,
    listener: context.listener,
    count,
    res,
    released: false,
  };
  state.heldPosts.push(held);
  res.on("close", () => {
    if (held.released) return;
    state.recorder.record({
      kind: "post.abandoned",
      listener: context.listener,
      nonce: context.nonce,
      token,
    });
  });
}

const REPEATED_HEADERS: ReadonlyArray<[string, string[]]> = [
  ["vary", ["Accept-Encoding", "Origin"]],
  ["link", ["</a.css>; rel=preload; as=style", "</b.js>; rel=preload; as=script"]],
  ["cache-control", ["no-store", "private"]],
];

function setRepeatedHeaders(res: ServerResponse): void {
  for (const [name, values] of REPEATED_HEADERS) res.setHeader(name, values);
}

/** Two `Location` lines: the parser keeps the first, so a proxy must not pick the last. */
function duplicateLocation(context: RouteContext): void {
  const landing = withNonce("/redirect/landing", context.nonce);
  context.res.setHeader("location", [`${landing}&which=first`, `${landing}&which=second`]);
  setRepeatedHeaders(context.res);
  const payload = Buffer.from("duplicate location\n");
  context.res.writeHead(302, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": payload.length,
  });
  context.res.end(payload);
}

function repeatedHeaders(context: RouteContext): void {
  setRepeatedHeaders(context.res);
  const payload = Buffer.from("repeated headers\n");
  context.res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": payload.length,
  });
  context.res.end(payload);
}

const serverSentEvents = guarded((context) => {
  const { req, res, url, state } = context;
  const count = integerParam(url, "count", 5, 1, state.limits.sseMaxEvents);
  const intervalMs = integerParam(url, "intervalMs", 100, 1, 10_000);
  const lastEventId = req.headers["last-event-id"];
  const resumedAfter =
    typeof lastEventId === "string" && /^\d{1,9}$/.test(lastEventId)
      ? Number.parseInt(lastEventId, 10)
      : null;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 1000\n\n");
  let seq = resumedAfter ?? 0;
  let eventsSent = 0;
  const timer = setInterval(() => {
    if (res.destroyed) return;
    seq += 1;
    eventsSent += 1;
    res.write(
      `id: ${seq}\nevent: tick\ndata: ${JSON.stringify({ seq, nonce: context.nonce })}\n\n`,
    );
    if (eventsSent >= count) {
      clearInterval(timer);
      res.end();
    }
  }, intervalMs);
  res.on("close", () => {
    clearInterval(timer);
    state.recorder.record({
      kind: "sse.closed",
      listener: context.listener,
      nonce: context.nonce,
      completed: eventsSent >= count && res.writableFinished,
      eventsSent,
      resumedAfter,
    });
  });
});

// Route tables sit after the handlers they reference so module evaluation never hits the TDZ.
const CANARY_ROUTES: readonly Route[] = [
  { method: "ANY", pattern: /^\/canary\/([A-Za-z0-9_-]{1,64})$/, handle: canaryHit },
];

const ROUTES: readonly Route[] = [
  ...CANARY_ROUTES,
  { method: "GET", pattern: /^\/$/, handle: serveLight },
  { method: "GET", pattern: /^\/spa(?:\/.*)?$/, handle: serveSpa },
  { method: "GET", pattern: /^\/probe$/, handle: serveProbe },
  { method: "ANY", pattern: /^\/probe\/report$/, handle: probeReport },
  { method: "GET", pattern: /^\/exit$/, handle: serveExit },
  { method: "ANY", pattern: /^\/api\/echo$/, handle: echo },
  { method: "GET", pattern: /^\/cookie\/set$/, handle: cookieSet },
  { method: "GET", pattern: /^\/cookie\/read$/, handle: cookieRead },
  { method: "GET", pattern: /^\/cookie\/clear$/, handle: cookieClear },
  { method: "ANY", pattern: /^\/redirect\/(301|302|303|307|308)$/, handle: redirectWithCode },
  { method: "ANY", pattern: /^\/redirect\/loop$/, handle: redirectLoop },
  { method: "ANY", pattern: /^\/redirect\/chain\/(\d{1,3})$/, handle: redirectChain },
  { method: "ANY", pattern: /^\/redirect\/landing$/, handle: redirectLanding },
  { method: "GET", pattern: /^\/slow$/, handle: slowBody },
  { method: "GET", pattern: /^\/large$/, handle: largeBody },
  { method: "GET", pattern: /^\/range$/, handle: rangeBody },
  { method: "POST", pattern: /^\/upload$/, handle: upload },
  { method: "ANY", pattern: /^\/post\/([A-Za-z0-9_-]{1,64})$/, handle: postCounter },
  { method: "GET", pattern: /^\/headers\/duplicate$/, handle: duplicateLocation },
  { method: "GET", pattern: /^\/headers\/repeated$/, handle: repeatedHeaders },
  { method: "GET", pattern: /^\/sse$/, handle: serverSentEvents },
];
