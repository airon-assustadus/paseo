import type {
  NetworkFetchChannel,
  NetworkFetchChannelHandlers,
  NetworkFetchOutboundFrame,
} from "../network-fetch-transport";

// Test-only WebSocket channel between the control page and the bridge host
// (adapter-contract.md §5). It authenticates, encodes and bounds frames; the adapter validates
// their meaning. Proves nothing about E2EE, the relay or a device.

export const BRIDGE_SUBPROTOCOL = "paseo-web-proxy-bridge.v1";

// Sizes are UTF-8 bytes, as the host's maxPayload counts them. Inbound limits are checked
// before any JSON parsing.
export const BRIDGE_CHANNEL_LIMITS = {
  maxFrameBytes: 65_536,
  maxReadyBytes: 16_384,
  maxEventsResultBytes: 32_768,
  maxEventsPerPage: 128,
  maxBufferedBytes: 1_048_576,
  maxServerNames: 16,
  // The lab host's own ceilings (bridge-host.ts, routes.ts): the core accepts a longer TTL,
  // the bridge host closes a session that asks for more (BF-3).
  maxSessionTtlMs: 300_000,
  maxHeldPosts: 64,
} as const;

// The recorder's kinds as the host accepts them (bridge-host.ts FIXTURE_EVENT_KINDS). Mirrored,
// not imported: the app does not depend on the server package.
export const FIXTURE_EVENT_KINDS = [
  "request",
  "canary.hit",
  "slow.closed",
  "large.closed",
  "upload.finished",
  "sse.closed",
  "ws.opened",
  "ws.closed",
  "redirect.landing",
  "probe.report",
  "post.count",
  "post.arrived",
  "post.released",
  "post.abandoned",
] as const;

export type FixtureEventKind = (typeof FIXTURE_EVENT_KINDS)[number];

// The fixture's POST token, as the host validates it before releasing held responses.
const POST_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

// Client close codes: a browser WebSocket only accepts 1000 and 3000–4999.
const CLOSE_NORMAL = 1000;
const CLOSE_VIOLATION = 4008;
const CLOSE_OVERFLOW = 4013;

// bridge-backend-plan.md §1, frozen as D-CH-3. The CA is the run's synthetic test authority;
// a PEM that is not exactly one certificate (a private key, for one) is refused.
export interface BridgeFixtureInfo {
  http: { origin: string };
  https: { origin: string; caPem: string; serverNames: string[] } | null;
  httpsVariants: { wrongHost: string; expired: string; selfSigned: string } | null;
  canary: { origin: string } | null;
}

export interface FixtureEventsPage {
  events: unknown[];
  next: number;
  more: boolean;
  dropped: number;
}

export interface HarnessStats {
  requestId: number;
  delivered: number;
  credited: number;
  active: number;
}

export interface BridgeHarness {
  fixture: BridgeFixtureInfo;
  events(query: { kind?: FixtureEventKind; after?: number }): Promise<FixtureEventsPage>;
  stats(requestId: number): Promise<HarnessStats>;
  // How many held POST responses for `token` the fixture released.
  release(token: string): Promise<number>;
}

export interface BridgeConnection {
  channel: NetworkFetchChannel;
  harness: BridgeHarness;
}

export interface BridgeSocketHandlers {
  open(): void;
  message(data: unknown): void;
  close(): void;
  error(): void;
}

// The part of a WebSocket the channel uses; tests drive a fake of it.
export interface BridgeSocket {
  protocol(): string;
  bufferedAmount(): number;
  send(data: string): void;
  close(code: number): void;
  observe(handlers: BridgeSocketHandlers): void;
}

export interface OpenBridgeChannelOptions {
  url: string;
  token: string;
  readyTimeoutMs: number;
  createSocket?: (url: string) => BridgeSocket;
}

export type BridgeChannelFailure = "timeout" | "closed" | "violation" | "overflow" | "subprotocol";

export class BridgeChannelError extends Error {
  constructor(readonly failure: BridgeChannelFailure) {
    super(`Bridge channel failed: ${failure}`);
    this.name = "BridgeChannelError";
  }
}

export class BridgeChannelUsageError extends Error {
  constructor(readonly problem: "listen_twice" | "query_pending" | "invalid_query") {
    super(`Bridge channel misused: ${problem}`);
    this.name = "BridgeChannelUsageError";
  }
}

const DOMAIN_FRAMES = new Set([
  "session.opened",
  "session.open_failed",
  "head",
  "body",
  "end",
  "fail",
  "uploadCredit",
  "cancelled",
  "closed",
  "protocol_error",
]);

type HarnessResultType =
  | "fixture.events.result"
  | "harness.stats.result"
  | "fixture.release.result";

const HARNESS_RESULTS: readonly HarnessResultType[] = [
  "fixture.events.result",
  "harness.stats.result",
  "fixture.release.result",
];

function isHarnessResultType(value: unknown): value is HarnessResultType {
  return HARNESS_RESULTS.some((type) => type === value);
}

interface PendingQuery {
  resolve(frame: Record<string, unknown>): void;
  reject(error: Error): void;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => key in record);
}

function parseFrame(data: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return isRecord(parsed) && typeof parsed.type === "string" ? parsed : null;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// RFC 4648 §4 with padding, and only the canonical spelling of each byte sequence.
export function decodeBase64(data: string, maxBytes: number): Uint8Array | null {
  if (!BASE64.test(data) || data.length % 4 !== 0) return null;
  const binary = atob(data);
  if (binary.length === 0 || binary.length > maxBytes) return null;
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return encodeBase64(bytes) === data ? bytes : null;
}

const CERTIFICATE_PEM =
  /^-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/=]{1,64}\n)+-----END CERTIFICATE-----\n?$/;
const SERVER_NAME = /^[A-Za-z0-9.:-]{1,253}$/;

// An exact origin with the expected scheme: no path, no trailing slash, nothing to normalize.
function readOrigin(value: unknown, protocol: "http:" | "https:"): string | null {
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === protocol && url.origin === value ? value : null;
}

function readListener(value: unknown, protocol: "http:" | "https:"): { origin: string } | null {
  if (!isRecord(value) || !hasKeys(value, ["origin"])) return null;
  const origin = readOrigin(value.origin, protocol);
  return origin === null ? null : { origin };
}

function readServerNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > BRIDGE_CHANNEL_LIMITS.maxServerNames) return null;
  const names: string[] = [];
  for (const name of value) {
    if (typeof name !== "string" || !SERVER_NAME.test(name)) return null;
    names.push(name);
  }
  return names;
}

function readTlsListener(value: unknown): BridgeFixtureInfo["https"] {
  if (!isRecord(value) || !hasKeys(value, ["origin", "caPem", "serverNames"])) return null;
  const origin = readOrigin(value.origin, "https:");
  const serverNames = readServerNames(value.serverNames);
  const { caPem } = value;
  if (origin === null || serverNames === null) return null;
  if (typeof caPem !== "string" || !CERTIFICATE_PEM.test(caPem)) return null;
  return { origin, caPem, serverNames };
}

function readVariants(value: unknown): BridgeFixtureInfo["httpsVariants"] {
  if (!isRecord(value) || !hasKeys(value, ["wrongHost", "expired", "selfSigned"])) return null;
  const wrongHost = readOrigin(value.wrongHost, "https:");
  const expired = readOrigin(value.expired, "https:");
  const selfSigned = readOrigin(value.selfSigned, "https:");
  if (wrongHost === null || expired === null || selfSigned === null) return null;
  return { wrongHost, expired, selfSigned };
}

// null where the fixture said null; undefined where the value was malformed.
function readNullable<T>(value: unknown, read: (input: unknown) => T | null): T | null | undefined {
  if (value === null) return null;
  return read(value) ?? undefined;
}

function readFixture(frame: Record<string, unknown>): BridgeFixtureInfo | null {
  if (!hasKeys(frame, ["type", "fixture"]) || !isRecord(frame.fixture)) return null;
  const { fixture } = frame;
  if (!hasKeys(fixture, ["http", "https", "httpsVariants", "canary"])) return null;
  const http = readListener(fixture.http, "http:");
  const https = readNullable(fixture.https, readTlsListener);
  const httpsVariants = readNullable(fixture.httpsVariants, readVariants);
  const canary = readNullable(fixture.canary, (value) => readListener(value, "http:"));
  if (http === null || https === undefined || httpsVariants === undefined || canary === undefined) {
    return null;
  }
  return { http, https, httpsVariants, canary };
}

function encodeFrame(frame: NetworkFetchOutboundFrame): string {
  if (frame.type !== "body") return JSON.stringify(frame);
  const { requestId, data } = frame;
  return JSON.stringify({ type: "body", requestId, data: encodeBase64(data) });
}

function wrapWebSocket(socket: WebSocket): BridgeSocket {
  socket.binaryType = "arraybuffer";
  return {
    protocol: () => socket.protocol,
    bufferedAmount: () => socket.bufferedAmount,
    send: (data) => socket.send(data),
    close: (code) => socket.close(code),
    observe(handlers) {
      socket.addEventListener("open", () => handlers.open());
      socket.addEventListener("message", (event) => handlers.message(event.data));
      socket.addEventListener("close", () => handlers.close());
      socket.addEventListener("error", () => handlers.error());
    },
  };
}

function createWebSocket(url: string): BridgeSocket {
  return wrapWebSocket(new WebSocket(url, [BRIDGE_SUBPROTOCOL]));
}

// Resolves once the host answered the hello with harness.ready. The token is sent once, in the
// hello, and is kept nowhere else: not in the result, an error or the URL.
export function openBridgeChannel(options: OpenBridgeChannelOptions): Promise<BridgeConnection> {
  const socket = (options.createSocket ?? createWebSocket)(options.url);
  const opened = Promise.withResolvers<BridgeConnection>();
  const pending = new Map<HarnessResultType, PendingQuery>();
  const encoder = new TextEncoder();
  let state: "connecting" | "authenticating" | "ready" | "closed" = "connecting";
  let handlers: NetworkFetchChannelHandlers | null = null;
  let lostBeforeListen = false;
  let maxChunkBytes: number | null = null;
  let token: string | null = options.token;

  const readyTimer = setTimeout(() => fail("timeout"), options.readyTimeoutMs);

  function shutdown(code: number, failure: BridgeChannelFailure): boolean {
    if (state === "closed") return false;
    state = "closed";
    token = null;
    clearTimeout(readyTimer);
    socket.close(code);
    for (const waiting of pending.values()) waiting.reject(new BridgeChannelError(failure));
    pending.clear();
    return true;
  }

  // Before ready the open fails; after it the adapter hears lost() exactly once.
  function fail(failure: BridgeChannelFailure, code = CLOSE_VIOLATION): void {
    const wasReady = state === "ready";
    if (!shutdown(code, failure)) return;
    if (!wasReady) {
      opened.reject(new BridgeChannelError(failure));
      return;
    }
    if (handlers === null) lostBeforeListen = true;
    else handlers.lost();
  }

  function transmit(payload: string): void {
    if (state !== "ready") return;
    const bytes = encoder.encode(payload).byteLength;
    const tooLarge = bytes > BRIDGE_CHANNEL_LIMITS.maxFrameBytes;
    if (tooLarge || socket.bufferedAmount() + bytes > BRIDGE_CHANNEL_LIMITS.maxBufferedBytes) {
      fail("overflow", CLOSE_OVERFLOW);
      return;
    }
    try {
      socket.send(payload);
    } catch (error) {
      // The one failure a socket reports by throwing (InvalidStateError: not open). Anything
      // else is a bug and must surface.
      const isSocketState = error instanceof DOMException && error.name === "InvalidStateError";
      if (!isSocketState) throw error;
      fail("closed", CLOSE_NORMAL);
    }
  }

  function query(type: HarnessResultType, frame: object): Promise<Record<string, unknown>> {
    if (state !== "ready") return Promise.reject(new BridgeChannelError("closed"));
    if (pending.has(type)) return Promise.reject(new BridgeChannelUsageError("query_pending"));
    const result = Promise.withResolvers<Record<string, unknown>>();
    pending.set(type, result);
    transmit(JSON.stringify(frame));
    return result.promise;
  }

  function settleQuery(type: HarnessResultType, frame: Record<string, unknown>): void {
    const waiting = pending.get(type);
    if (waiting === undefined) {
      fail("violation");
      return;
    }
    pending.delete(type);
    waiting.resolve(frame);
  }

  function deliver(frame: Record<string, unknown>): void {
    if (handlers === null) {
      fail("violation");
      return;
    }
    if (frame.type === "session.opened") {
      const limits = isRecord(frame.limits) ? frame.limits.maxChunkBytes : null;
      maxChunkBytes = isCount(limits) && limits > 0 ? limits : null;
    }
    if (frame.type !== "body") {
      handlers.frame(frame);
      return;
    }
    const data =
      typeof frame.data === "string" && maxChunkBytes !== null
        ? decodeBase64(frame.data, maxChunkBytes)
        : null;
    if (data === null) {
      fail("violation");
      return;
    }
    handlers.frame({ ...frame, data });
  }

  function onReady(frame: Record<string, unknown>): void {
    const fixture = frame.type === "harness.ready" ? readFixture(frame) : null;
    if (fixture === null) {
      fail("violation");
      return;
    }
    state = "ready";
    clearTimeout(readyTimer);
    opened.resolve({ channel, harness: createHarness(fixture) });
  }

  function onMessage(data: unknown): void {
    if (state === "closed" || state === "connecting") return;
    if (typeof data !== "string") {
      fail("violation");
      return;
    }
    const limit =
      state === "ready" ? BRIDGE_CHANNEL_LIMITS.maxFrameBytes : BRIDGE_CHANNEL_LIMITS.maxReadyBytes;
    // A string never has more characters than UTF-8 bytes: the cheap test goes first.
    const bytes = data.length > limit ? limit + 1 : encoder.encode(data).byteLength;
    const frame = bytes > limit ? null : parseFrame(data);
    if (frame === null) {
      fail("violation");
      return;
    }
    if (
      frame.type === "fixture.events.result" &&
      bytes > BRIDGE_CHANNEL_LIMITS.maxEventsResultBytes
    ) {
      fail("violation");
      return;
    }
    if (state === "authenticating") {
      onReady(frame);
      return;
    }
    if (DOMAIN_FRAMES.has(String(frame.type))) {
      deliver(frame);
      return;
    }
    if (isHarnessResultType(frame.type)) settleQuery(frame.type, frame);
    else fail("violation");
  }

  const channel: NetworkFetchChannel = {
    send(frame) {
      transmit(encodeFrame(frame));
    },
    listen(next) {
      if (handlers !== null) throw new BridgeChannelUsageError("listen_twice");
      handlers = next;
      if (lostBeforeListen) queueMicrotask(() => next.lost());
    },
    close() {
      shutdown(CLOSE_NORMAL, "closed");
    },
  };

  function createHarness(fixture: BridgeFixtureInfo): BridgeHarness {
    function invalid(): never {
      fail("violation");
      throw new BridgeChannelError("violation");
    }
    return {
      fixture,
      async events(input) {
        // Refused here, without a frame: the host would end the whole session for it (BF-4).
        const isKindValid = input.kind === undefined || FIXTURE_EVENT_KINDS.includes(input.kind);
        if (!isKindValid || (input.after !== undefined && !isCount(input.after))) {
          throw new BridgeChannelUsageError("invalid_query");
        }
        const frame = await query("fixture.events.result", { type: "fixture.events", ...input });
        const { events, next, more, dropped } = frame;
        if (!hasKeys(frame, ["type", "events", "next", "more", "dropped"])) return invalid();
        if (!Array.isArray(events) || events.length > BRIDGE_CHANNEL_LIMITS.maxEventsPerPage) {
          return invalid();
        }
        if (!isCount(next) || !isCount(dropped) || typeof more !== "boolean") return invalid();
        // Absolute cursor (D-HOST-7): the page starts at max(after, dropped) and next points just
        // past the last event it returned, so it never moves back.
        const start = Math.max(input.after ?? 0, dropped);
        if (next < start + events.length) return invalid();
        return { events, next, more, dropped };
      },
      async stats(requestId) {
        if (!isCount(requestId) || requestId === 0)
          throw new BridgeChannelUsageError("invalid_query");
        const frame = await query("harness.stats.result", { type: "harness.stats", requestId });
        const { delivered, credited, active } = frame;
        const keys = ["type", "requestId", "delivered", "credited", "active"];
        if (!hasKeys(frame, keys) || frame.requestId !== requestId) return invalid();
        if (!isCount(delivered) || !isCount(credited) || !isCount(active)) return invalid();
        return { requestId, delivered, credited, active };
      },
      async release(fixtureToken) {
        if (!POST_TOKEN.test(fixtureToken)) throw new BridgeChannelUsageError("invalid_query");
        const frame = await query("fixture.release.result", {
          type: "fixture.release",
          token: fixtureToken,
        });
        const { released } = frame;
        // The answer must name the token this query asked about; one release query is pending
        // at a time, so any other token is a host fault (BF-1).
        if (!hasKeys(frame, ["type", "token", "released"]) || frame.token !== fixtureToken) {
          return invalid();
        }
        if (!isCount(released) || released > BRIDGE_CHANNEL_LIMITS.maxHeldPosts) return invalid();
        return released;
      },
    };
  }

  socket.observe({
    open() {
      if (state !== "connecting" || token === null) return;
      if (socket.protocol() !== BRIDGE_SUBPROTOCOL) {
        fail("subprotocol");
        return;
      }
      state = "authenticating";
      socket.send(JSON.stringify({ type: "harness.hello", token }));
      token = null;
    },
    message: onMessage,
    close: () => fail("closed", CLOSE_NORMAL),
    error: () => fail("closed", CLOSE_NORMAL),
  });

  return opened.promise;
}
