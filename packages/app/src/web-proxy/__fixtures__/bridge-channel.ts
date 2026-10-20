import type { BridgeHeaders, BridgeMethod } from "../bridge-messages";

// Test-only WebSocket channel between the control page and the bridge host
// (adapter-contract.md §5). It authenticates, encodes and bounds frames; the adapter validates
// their meaning. Proves nothing about E2EE, the relay or a device.

export const BRIDGE_SUBPROTOCOL = "paseo-web-proxy-bridge.v1";

export const BRIDGE_CHANNEL_LIMITS = {
  // Inbound: checked before any JSON parsing. The host's frames are ASCII JSON.
  maxFrameChars: 65_536,
  // Outbound: the host's maxPayload counts bytes.
  maxFrameBytes: 65_536,
  maxReadyChars: 16_384,
  maxBufferedBytes: 1_048_576,
  maxEventsPerPage: 128,
} as const;

// Client close codes: a browser WebSocket only accepts 1000 and 3000–4999.
const CLOSE_NORMAL = 1000;
const CLOSE_VIOLATION = 4008;
const CLOSE_OVERFLOW = 4013;

// Structural copy of the adapter's channel types (adapter-implementation-plan.md §1), declared
// here until both modules share a branch.
export interface NetworkFetchScope {
  origin: string;
  pathPrefix: string;
}

export type NetworkFetchRequestBody = { kind: "none" } | { kind: "stream"; length: number | null };

export type BridgeOutboundFrame =
  | {
      type: "session.open";
      scope: NetworkFetchScope;
      ttlMs: number;
      limits: Readonly<Record<string, number>> | null;
    }
  | {
      type: "request";
      requestId: number;
      method: BridgeMethod;
      url: string;
      headers: BridgeHeaders;
      redirect: "manual";
      body: NetworkFetchRequestBody;
    }
  | { type: "body"; requestId: number; data: Uint8Array }
  | { type: "endBody" | "cancel"; requestId: number }
  | { type: "grantCredit"; requestId: number; bytes: number }
  | { type: "close" };

export interface NetworkFetchChannelHandlers {
  frame(data: unknown): void;
  lost(): void;
}

export interface NetworkFetchChannel {
  // Never throws; a no-op once the channel is closed or lost.
  send(frame: BridgeOutboundFrame): void;
  listen(handlers: NetworkFetchChannelHandlers): void;
  close(): void;
}

export interface BridgeFixtureInfo {
  httpOrigin: string;
  // The rest of harness.ready's fixture description, as received.
  listeners: Readonly<Record<string, unknown>>;
}

export interface FixtureEventsPage {
  events: unknown[];
  next: number;
  more: boolean;
  dropped: number | null;
}

export interface HarnessStats {
  requestId: number;
  delivered: number;
  credited: number;
  active: number;
}

export interface BridgeHarness {
  fixture: BridgeFixtureInfo;
  events(query: { kind?: string; after?: number }): Promise<FixtureEventsPage>;
  stats(requestId: number): Promise<HarnessStats>;
  release(token: string): Promise<boolean>;
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
  constructor(readonly problem: "listen_twice" | "query_pending") {
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

function readFixture(frame: Record<string, unknown>): BridgeFixtureInfo | null {
  if (!hasKeys(frame, ["type", "fixture"]) || !isRecord(frame.fixture)) return null;
  const { http } = frame.fixture;
  if (!isRecord(http) || typeof http.origin !== "string" || !URL.canParse(http.origin)) {
    return null;
  }
  return { httpOrigin: http.origin, listeners: frame.fixture };
}

function encodeFrame(frame: BridgeOutboundFrame): string {
  if (frame.type === "body") {
    const { requestId, data } = frame;
    return JSON.stringify({ type: "body", requestId, data: encodeBase64(data) });
  }
  if (frame.type === "session.open" && frame.limits === null) {
    const { type, scope, ttlMs } = frame;
    return JSON.stringify({ type, scope, ttlMs });
  }
  return JSON.stringify(frame);
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
      // The socket started closing under us; its close event may not have arrived yet.
      if (!(error instanceof DOMException)) throw error;
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
      state === "ready" ? BRIDGE_CHANNEL_LIMITS.maxFrameChars : BRIDGE_CHANNEL_LIMITS.maxReadyChars;
    const frame = data.length > limit ? null : parseFrame(data);
    if (frame === null) {
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
        const frame = await query("fixture.events.result", { type: "fixture.events", ...input });
        const { events, next, more, dropped } = frame;
        // `dropped` comes from the host plan (D-HOST-7); the contract table does not list it.
        const keys = ["type", "events", "next", "more"];
        if (!hasKeys(frame, "dropped" in frame ? [...keys, "dropped"] : keys)) return invalid();
        if (!Array.isArray(events) || events.length > BRIDGE_CHANNEL_LIMITS.maxEventsPerPage) {
          return invalid();
        }
        if (!isCount(next) || typeof more !== "boolean") return invalid();
        if (dropped === undefined) return { events, next, more, dropped: null };
        if (!isCount(dropped)) return invalid();
        return { events, next, more, dropped };
      },
      async stats(requestId) {
        const frame = await query("harness.stats.result", { type: "harness.stats", requestId });
        const { delivered, credited, active } = frame;
        const keys = ["type", "requestId", "delivered", "credited", "active"];
        if (!hasKeys(frame, keys) || frame.requestId !== requestId) return invalid();
        if (!isCount(delivered) || !isCount(credited) || !isCount(active)) return invalid();
        return { requestId, delivered, credited, active };
      },
      async release(fixtureToken) {
        const frame = await query("fixture.release.result", {
          type: "fixture.release",
          token: fixtureToken,
        });
        const { released } = frame;
        if (!hasKeys(frame, ["type", "released"]) || typeof released !== "boolean")
          return invalid();
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
