import { commands, page } from "vitest/browser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { NetworkTunnel, NetworkTunnelStream } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import {
  openBridgeChannel,
  type BridgeConnection,
  type BridgeHarness,
  type FixtureEventKind,
} from "@/web-proxy/__fixtures__/bridge-channel";
import {
  adoptLengthPrefixedCodec,
  createTunnelBridgeSocket,
  type TunnelBridgeSocket,
  type TunnelBridgeSocketOptions,
  type TunnelFrameCodec,
} from "@/web-proxy/__fixtures__/tunnel-socket";
import {
  DEFAULT_BRIDGE_LIMITS,
  type BridgeLimits,
  type RequestMessage,
} from "@/web-proxy/bridge-messages";
import { attachWebProxyBroker, type WebProxyBroker } from "@/web-proxy/broker.web";
import {
  openNetworkFetchTransport,
  type NetworkFetchTransport,
  type NetworkFetchTransportClosedReason,
} from "@/web-proxy/network-fetch-transport";
import { startPortSession } from "@/web-proxy/port-session.web";
import type { WebProxyCapability } from "@/web-proxy/request-policy";
import type { WebProxyTransport } from "@/web-proxy/transport";
import type {
  WebProxyRelayHostTotals,
  WebProxyRelayInfo,
  WebProxyRelayLegEvidence,
} from "../vitest.web-proxy-bridge";

// L-relay, stage R2 (relay-r2-browser-plan.md): the real shell, broker, adapter and bridge channel in
// this page (C), carried by the tunnel socket over an E2EE DaemonClient → local relay → isolated
// daemon → network tunnel → the bridge host's TCP listener → core → fixture.
//
// The relay is the in-repo Cloudflare worker under `wrangler dev --local`: a legacy local relay, not
// the production relay. Not proven here: the Elixir relay, Android, Brave, a separate domain, site
// isolation, a tunnel window smaller than a frame (unit-tested in tunnel-socket.test.ts), exactly-once
// delivery, K's isolation from the Vitest server (RV-10), or backpressure from K through the relay:
// the core holding its window while the content does not read is proven by the L-bridge test (direct
// WebSocket) and by R1-3 (Node over the relay), separately, not here.
//
// Run only through evidence/relay-r2/run-relay-r2.sh; e2e/ is outside every versioned suite.
// Connection authority (relay endpoint, serverId, daemon key, host token) stays in this page's
// variables: never in a frame, URL, postMessage, console, assertion diff or meta.

declare module "vitest" {
  interface TaskMeta {
    r2?: Record<string, number | boolean>;
  }
}

const SLOW = { timeout: 20_000, interval: 100 };
// The relay restart and the reconnection that follows it (RV-9 stack deadlines: 90 s + 30 s).
const RECOVERY = { timeout: 60_000, interval: 200 };
// First command call starts wrangler and the daemon; above the stack's own deadlines (RV-13).
const START_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 120_000;
const RESTART_TEST_TIMEOUT_MS = 240_000;
const CONNECT_DEADLINE_MS = 60_000;
const BOOTSTRAP_PATH = "/__paseo/bootstrap.html";
const HARNESS_K3_LIMITS: BridgeLimits = {
  ...DEFAULT_BRIDGE_LIMITS,
  windowBytes: 65_536,
  maxChunkBytes: 16_384,
  maxConcurrentRequests: 6,
};
const SESSION_TTL_MS = 60_000;
// The fixture's http.createServer keeps Node's default maxHeaderSize; the margin leaves room for the
// request line and the headers the core adds (host, origin, connection).
const FIXTURE_HEADER_BLOCK_BYTES = 16_384;
const FIXTURE_HEADER_MARGIN_BYTES = 4_096;
// RV-14: the only module URL the page imports.
const CODEC_MODULE_URL =
  /^\/@fs\/[^?#]+\/packages\/server\/src\/server\/network-fetch\/__fixtures__\/length-prefixed\.ts$/;

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Always 17 characters, inside the evidence command's /^[A-Za-z0-9_-]{8,64}$/.
function createNonce(): string {
  const words = Array.from(crypto.getRandomValues(new Uint32Array(2)), (word) =>
    word.toString(16).padStart(8, "0"),
  );
  return `n${words.join("")}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------------
// Stack, codec and run-wide counters

interface Relay {
  info: WebProxyRelayInfo;
  codec: TunnelFrameCodec;
}

let relayPromise: Promise<Relay> | null = null;

function relay(): Promise<Relay> {
  relayPromise ??= loadRelay();
  return relayPromise;
}

// E7-1: the projection carries no direct bridge WebSocket. Answers a boolean, never the value.
function hasDirectBridgeUrl(value: unknown): boolean {
  if (typeof value === "string") return /^wss?:\/\//i.test(value);
  if (Array.isArray(value)) return value.some(hasDirectBridgeUrl);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => key === "url" || hasDirectBridgeUrl(entry));
}

// Vectors the socket's adoption does not cover (reviewer I-1): two frames fed byte by byte, one
// with 2-byte UTF-8, and a zero-length prefix that poisons the reader for good. Literal bytes, so the
// app keeps no encoder of the format: "ação" (6 bytes) then "{}".
const TWO_FRAMES = [0, 0, 0, 6, 0x61, 0xc3, 0xa7, 0xc3, 0xa3, 0x6f, 0, 0, 0, 2, 0x7b, 0x7d];

function expectCodecVectors(codec: TunnelFrameCodec): void {
  const texts = ["ação", "{}"];
  const decoded: string[] = [];
  const reader = codec.createReader((text) => decoded.push(text));
  for (const byte of TWO_FRAMES) expect(reader.push(Uint8Array.of(byte))).toBe(1);
  expect(decoded).toEqual(texts);
  const poisoned = codec.createReader(() => undefined);
  expect(() => poisoned.push(Uint8Array.of(0, 0, 0, 0))).toThrow();
  expect(() => poisoned.push(Uint8Array.of(0, 0, 0, 2, 0x7b, 0x7d))).toThrow();
}

async function loadRelay(): Promise<Relay> {
  const info = await commands.webProxyRelayBridge();
  expect(hasDirectBridgeUrl(info)).toBe(false);
  expect(CODEC_MODULE_URL.test(info.codecModuleUrl)).toBe(true);
  const module: unknown = await import(/* @vite-ignore */ info.codecModuleUrl);
  const codec = adoptLengthPrefixedCodec(module);
  expectCodecVectors(codec);
  return { info, codec };
}

// E7-3: what C opened over the tunnel during this run. One stack per run, shared by every case, so
// the totals are kept for the whole file and compared with the host's cumulative counters.
const openedByC = { channels: 0, sessions: 0 };

// Every authenticated connection and session the host saw is one C opened through the tunnel. The
// host counts both listeners together; the equality excludes extra connections, it does not label one.
async function expectHostMatchesC(): Promise<WebProxyRelayHostTotals> {
  const { host } = await commands.webProxyRelayEvidence(createNonce());
  expect({
    authenticated: host.authenticatedConnections,
    sessions: host.sessionsOpened,
  }).toEqual({ authenticated: openedByC.channels, sessions: openedByC.sessions });
  expect(host.connections).toBeGreaterThanOrEqual(host.authenticatedConnections);
  return host;
}

// ---------------------------------------------------------------------------------------------
// Instrumentation local to the test: counts only, around the real codec and the real stream.

interface FrameMeter {
  outFrames: number;
  maxOutFrameBytes: number;
  inFrames: number;
  // UTF-8 bytes of the largest inbound frame's text, without the codec's own framing.
  maxInPayloadBytes: number;
  writes: number;
  maxWriteBytes: number;
}

function createMeter(): FrameMeter {
  return {
    outFrames: 0,
    maxOutFrameBytes: 0,
    inFrames: 0,
    maxInPayloadBytes: 0,
    writes: 0,
    maxWriteBytes: 0,
  };
}

function meteredCodec(codec: TunnelFrameCodec, meter: FrameMeter): TunnelFrameCodec {
  return {
    encode: (text) => {
      const bytes = codec.encode(text);
      meter.outFrames += 1;
      meter.maxOutFrameBytes = Math.max(meter.maxOutFrameBytes, bytes.length);
      return bytes;
    },
    createReader: (onFrame) =>
      codec.createReader((text) => {
        meter.inFrames += 1;
        meter.maxInPayloadBytes = Math.max(meter.maxInPayloadBytes, encoder.encode(text).length);
        onFrame(text);
      }),
  };
}

function meteredTunnel(
  tunnel: NetworkTunnel,
  meter: FrameMeter,
): TunnelBridgeSocketOptions["tunnel"] {
  return {
    limits: tunnel.limits,
    openStream: (target, handlers) => {
      const stream = tunnel.openStream(target, handlers);
      const metered: NetworkTunnelStream = {
        streamId: stream.streamId,
        write: (data) => {
          meter.writes += 1;
          meter.maxWriteBytes = Math.max(meter.maxWriteBytes, data.length);
          stream.write(data);
        },
        consume: (bytes) => stream.consume(bytes),
        close: (reason) => stream.close(reason),
      };
      return metered;
    },
  };
}

// The broker's transport: forwards to the current adapter, so broker.reopen() can use the one
// opened after a loss without replacing the broker, and counts the body bytes C hands to K.
interface DelegatingTransport extends WebProxyTransport {
  use(transport: WebProxyTransport): void;
  bodyBytes(): number;
}

function createDelegatingTransport(initial: WebProxyTransport): DelegatingTransport {
  let current = initial;
  let bytes = 0;
  return {
    use: (transport) => {
      current = transport;
    },
    bodyBytes: () => bytes,
    async request(request, signal) {
      const response = await current.request(request, signal);
      if (response.body === null) return response;
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      return { ...response, body: response.body.pipeThrough(counter) };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Connections opened by C

interface RelayConnection {
  client: DaemonClient;
  tunnel: NetworkTunnel;
  socket: TunnelBridgeSocket;
  connection: BridgeConnection;
  transport: NetworkFetchTransport;
  capability: WebProxyCapability;
  closedReasons: NetworkFetchTransportClosedReason[];
  meter: FrameMeter;
}

// Reverse-order teardown of what a case opened: broker, transport, channel, tunnel, client.
const cleanups: Array<() => unknown> = [];
const sockets: TunnelBridgeSocket[] = [];
let clientCounter = 0;

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    // Best effort: a case that lost its relay leaves already-closed handles behind. The final case
    // closes its own handles explicitly and asserts that each close succeeds.
    await Promise.resolve()
      .then(() => cleanup?.())
      .catch(() => undefined);
  }
});

/** Connection attempts are bounded and never carry a request; a failure keeps only a count. */
async function connectClient(info: WebProxyRelayInfo): Promise<DaemonClient> {
  const deadline = Date.now() + CONNECT_DEADLINE_MS;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    clientCounter += 1;
    const client = new DaemonClient({
      url: buildRelayWebSocketUrl({
        endpoint: info.relay.endpoint,
        useTls: false,
        serverId: info.daemon.serverId,
        role: "client",
      }),
      clientId: `clid_r2_browser_${clientCounter}`,
      clientType: "browser",
      connectTimeoutMs: 15_000,
      capabilities: { [CLIENT_CAPS.networkTunnel]: true, [CLIENT_CAPS.ownedSubscriptions]: true },
      e2ee: { enabled: true, daemonPublicKeyB64: info.daemon.daemonPublicKeyB64 },
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      return client;
    } catch {
      // The error can carry the relay URL, which holds the serverId: it is dropped, not rethrown.
      await client.close().catch(() => undefined);
      if (Date.now() >= deadline) {
        throw new Error(`relay client did not connect after ${attempts} attempts`);
      }
      await delay(1_000);
    }
  }
}

async function openRelayConnection(
  onClosed: (reason: NetworkFetchTransportClosedReason) => void = () => undefined,
): Promise<RelayConnection> {
  const { info, codec } = await relay();
  const meter = createMeter();
  const client = await connectClient(info);
  cleanups.push(() => client.close());
  const tunnel = await client.openNetworkTunnel();
  cleanups.push(() => tunnel.close());
  let socket: TunnelBridgeSocket | null = null;
  const connection = await openBridgeChannel({
    // Symbolic: the channel hands it to createSocket, which ignores it.
    url: "tunnel://bridge",
    token: info.bridge.token,
    readyTimeoutMs: 15_000,
    createSocket: () => {
      socket = createTunnelBridgeSocket({
        tunnel: meteredTunnel(tunnel, meter),
        target: { host: "127.0.0.1", port: info.bridge.tcpPort },
        codec: meteredCodec(codec, meter),
      });
      sockets.push(socket);
      return socket;
    },
  });
  cleanups.push(() => connection.channel.close());
  openedByC.channels += 1;
  if (socket === null) throw new Error("the channel opened without a tunnel socket");
  // The command and the authenticated hello describe the same fixture.
  expect(connection.harness.fixture).toEqual(info.bridge.fixture);
  const capability: WebProxyCapability = {
    contentOrigin: info.bridge.shell.origins.a,
    destinationOrigin: connection.harness.fixture.http.origin,
    pathPrefix: "/",
  };
  const closedReasons: NetworkFetchTransportClosedReason[] = [];
  const transport = await openNetworkFetchTransport({
    channel: connection.channel,
    capability,
    ttlMs: SESSION_TTL_MS,
    limits: {},
    onClosed: (reason) => {
      closedReasons.push(reason);
      onClosed(reason);
    },
  });
  cleanups.push(() => transport.close());
  openedByC.sessions += 1;
  return { client, tunnel, socket, connection, transport, capability, closedReasons, meter };
}

// ---------------------------------------------------------------------------------------------
// Fixture events (E7-6: every page used has dropped = 0)

interface RequestEventView {
  method: string;
  path: string;
  nonce: string;
  origin: string | null;
  referer: string | null;
  cookieNames: unknown;
}

function asRequestEvent(event: unknown): RequestEventView | null {
  if (!isRecord(event) || event.kind !== "request" || !isRecord(event.headers)) return null;
  const { method, path, nonce, cookieNames } = event;
  const { origin, referer } = event.headers;
  if (typeof method !== "string" || typeof path !== "string" || typeof nonce !== "string") {
    return null;
  }
  const originValue = typeof origin === "string" ? origin : null;
  const refererValue = typeof referer === "string" ? referer : null;
  return { method, path, nonce, origin: originValue, referer: refererValue, cookieNames };
}

function isTruncated(event: unknown): boolean {
  return isRecord(event) && event.truncated === true;
}

// Every page read for a count must be whole: nothing evicted (dropped) and no event replaced by
// the host's truncated stand-in, which carries no method, path or token and would slip past the
// filters below (BD-1).
async function eventsOf(harness: BridgeHarness, kind: FixtureEventKind): Promise<unknown[]> {
  const events: unknown[] = [];
  let after = 0;
  for (;;) {
    const result = await harness.events({ kind, after });
    expect(result.dropped).toBe(0);
    expect(result.events.filter(isTruncated)).toHaveLength(0);
    events.push(...result.events);
    if (!result.more) return events;
    after = result.next;
  }
}

async function requestEvents(harness: BridgeHarness): Promise<RequestEventView[]> {
  const views = (await eventsOf(harness, "request")).map(asRequestEvent);
  return views.filter((view): view is RequestEventView => view !== null);
}

function waitForRequest(
  harness: BridgeHarness,
  matches: (event: RequestEventView) => boolean,
): Promise<RequestEventView> {
  return vi.waitFor(async () => {
    const found = (await requestEvents(harness)).find(matches);
    if (found === undefined) throw new Error("request not recorded yet");
    return found;
  }, SLOW);
}

function withToken(events: unknown[], token: string): Record<string, unknown>[] {
  return events.filter((event): event is Record<string, unknown> => {
    return isRecord(event) && event.token === token;
  });
}

// ---------------------------------------------------------------------------------------------
// K3 driven directly: the broker's port session without the SW

interface K3Content {
  send(message: unknown): void;
  next(timeout?: { timeout: number; interval: number }): Promise<unknown>;
  received: unknown[];
}

function openK3(transport: WebProxyTransport, capability: WebProxyCapability): K3Content {
  const channel = new MessageChannel();
  startPortSession({
    port: channel.port1,
    generation: 1,
    capability,
    limits: HARNESS_K3_LIMITS,
    transport,
    onRevoked: () => {},
    onRedirectBlocked: () => {},
  });
  const received: unknown[] = [];
  let cursor = 0;
  channel.port2.addEventListener("message", (event) => received.push(event.data));
  channel.port2.start();
  cleanups.push(() => channel.port2.close());
  return {
    received,
    send: (message) => channel.port2.postMessage(message, []),
    next: (timeout = SLOW) =>
      vi.waitFor(() => {
        const message = received[cursor];
        if (message === undefined) throw new Error("no K3 message yet");
        cursor += 1;
        return message;
      }, timeout),
  };
}

function k3Request(
  requestId: number,
  path: string,
  headers: [string, string][] = [],
): RequestMessage {
  return {
    type: "paseo.web.request",
    v: 1,
    generation: 1,
    requestId,
    method: "GET",
    path,
    headers,
    body: null,
    mode: "subresource",
  };
}

function k3Post(requestId: number, path: string, body: string): RequestMessage {
  return {
    ...k3Request(requestId, path),
    method: "POST",
    headers: [["content-type", "text/plain; charset=utf-8"]],
    body: encoder.encode(body).buffer,
  };
}

function typeOf(message: unknown): unknown {
  return isRecord(message) ? message.type : null;
}

async function readK3Body(content: K3Content, requestId: number): Promise<string> {
  const parts: Uint8Array[] = [];
  for (;;) {
    const message = await content.next();
    if (typeOf(message) === "paseo.web.response.end") break;
    if (!isRecord(message) || !(message.chunk instanceof ArrayBuffer)) {
      throw new Error(`unexpected K3 message type ${String(typeOf(message))}`);
    }
    parts.push(new Uint8Array(message.chunk));
    const bytes = message.chunk.byteLength;
    content.send({ type: "paseo.web.ack", v: 1, generation: 1, requestId, bytes });
  }
  const decoder = new TextDecoder();
  return parts.map((part) => decoder.decode(part, { stream: true })).join("") + decoder.decode();
}

// ---------------------------------------------------------------------------------------------
// DOM through the broker

// Root documents already seen in this run: the host is shared, so a case finds its own by novelty.
const seenRoots = new Set<string>();

function mountContainer(): HTMLDivElement {
  const element = document.createElement("div");
  const sizing = document.createElement("style");
  sizing.textContent = "iframe { width: 800px; height: 600px; }";
  element.append(sizing);
  document.body.append(element);
  cleanups.push(() => element.remove());
  return element;
}

function attachBroker(connection: RelayConnection, transport: DelegatingTransport): WebProxyBroker {
  const broker = attachWebProxyBroker({
    capability: connection.capability,
    transport,
    container: mountContainer(),
    bootstrapPath: BOOTSTRAP_PATH,
    handshakeTimeoutMs: 15_000,
    limits: HARNESS_K3_LIMITS,
  });
  cleanups.push(() => broker.dispose());
  return broker;
}

function appFrame(broker: WebProxyBroker) {
  const frame = broker.getFrame();
  if (frame === null) throw new Error("broker lost its frame");
  const shell = page.frameLocator(page.elementLocator(frame));
  return page.frameLocator(shell.getByTestId("paseo-web-proxy-app"));
}

// Waits for a granted generation, then proves the new root document is DOM in the content frame:
// its nonce and the content origin K (written by the page's own script from location.origin).
// Provider-side reads; a frame that cannot be read fails the case, there is no fallback.
async function expectRootDom(
  broker: WebProxyBroker,
  harness: BridgeHarness,
  contentOrigin: string,
  minGeneration = 0,
): Promise<string> {
  await vi.waitFor(() => {
    const state = broker.getState();
    expect(state.status).toBe("granted");
    expect(state.generation).toBeGreaterThan(minGeneration);
  }, RECOVERY);
  const root = await waitForRequest(
    harness,
    (event) => event.method === "GET" && event.path === "/" && !seenRoots.has(event.nonce),
  );
  seenRoots.add(root.nonce);
  const app = appFrame(broker);
  await app.getByText(root.nonce, { exact: true }).click();
  await app.getByText(contentOrigin, { exact: true }).click();
  return root.nonce;
}

const NOT_SEEN = { toTarget: false, fromTarget: false };

function expectNoPlaintextMarkers(leg: WebProxyRelayLegEvidence): void {
  expect(leg.contains).toEqual({ nonce: NOT_SEEN, token: NOT_SEEN, hello: NOT_SEEN });
}

function isHandshakePairs(handshake: readonly string[]): boolean {
  return (
    handshake.length >= 2 &&
    handshake.length % 2 === 0 &&
    handshake.every((name, index) => name === (index % 2 === 0 ? "e2ee_hello" : "e2ee_ready"))
  );
}

// ---------------------------------------------------------------------------------------------

// Set by the restart case, re-read by the final case (RV-8 step 7).
let heldToken: string | null = null;

describe("web proxy over the local legacy relay (R2)", () => {
  beforeAll(async () => {
    await relay();
  }, START_TIMEOUT_MS);

  it(
    "renders the fixture as DOM through the relay, carried encrypted on the client leg (R2-1, R2-2)",
    async ({ task }) => {
      const connection = await openRelayConnection();
      const transport = createDelegatingTransport(connection.transport);
      const before = await commands.webProxyRelayEvidence(createNonce());
      const bodyBefore = transport.bodyBytes();

      const broker = attachBroker(connection, transport);
      const nonce = await expectRootDom(
        broker,
        connection.connection.harness,
        connection.capability.contentOrigin,
      );

      const after = await commands.webProxyRelayEvidence(nonce);
      const bodyBytes = transport.bodyBytes() - bodyBefore;
      const messages = after.clientLeg.messages - before.clientLeg.messages;
      const fromRelay = after.clientLeg.bytes.fromTarget - before.clientLeg.bytes.fromTarget;
      // E7-4: new relay traffic on the client leg around the DOM load, at least as large as the body
      // C handed to the content in that window, with no capture overflow on either read.
      expect(bodyBytes).toBeGreaterThan(0);
      expect(messages).toBeGreaterThan(0);
      expect(fromRelay).toBeGreaterThanOrEqual(bodyBytes);
      expect([
        before.clientLeg.overflow,
        after.clientLeg.overflow,
        before.daemonLeg.overflow,
        after.daemonLeg.overflow,
      ]).toEqual([null, null, null, null]);

      // R2-2, labelled per leg. Client leg: only the key exchange in clear, then E2EE frames; the
      // nonce, the token and the hello never in clear. Daemon leg: the same markers absent.
      expect(isHandshakePairs(after.clientLeg.handshake)).toBe(true);
      expect(after.clientLeg.nonHandshakeMessages).toBeGreaterThan(0);
      expectNoPlaintextMarkers(after.clientLeg);
      expectNoPlaintextMarkers(after.daemonLeg);

      const host = await expectHostMatchesC();
      task.meta.r2 = {
        bodyBytes,
        clientLegMessagesDelta: messages,
        clientLegFromRelayBytesDelta: fromRelay,
        hostAuthenticated: host.authenticatedConnections,
        hostSessions: host.sessionsOpened,
      };
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "posts the page's form through the relay with the destination as Origin (R2-3)",
    async () => {
      const connection = await openRelayConnection();
      const { harness } = connection.connection;
      const broker = attachBroker(connection, createDelegatingTransport(connection.transport));
      const nonce = await expectRootDom(broker, harness, connection.capability.contentOrigin);

      await appFrame(broker).getByRole("button", { name: "POST" }).click();
      const post = await waitForRequest(
        harness,
        (event) => event.method === "POST" && event.path === "/api/echo" && event.nonce === nonce,
      );
      expect(post.origin).toBe(connection.capability.destinationOrigin);
      expect(post.referer).toBeNull();
      expect(post.cookieNames).toEqual([]);
      expect(connection.closedReasons).toEqual([]);
      await expectHostMatchesC();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "carries large valid frames both ways intact over the default tunnel window (R2-4)",
    async ({ task }) => {
      const connection = await openRelayConnection();
      const content = openK3(connection.transport, connection.capability);
      const nonce = createNonce();

      // Outbound: a request frame whose header of quotes doubles under JSON escaping. Below the K3
      // header budget and the session's head limit, and below the fixture's HTTP server, which keeps
      // Node's default 16 KiB for the whole header block (request line and the core's own headers
      // included), so no side refuses it.
      const headBudget = Math.min(
        HARNESS_K3_LIMITS.maxHeaderBytes,
        connection.transport.limits.maxRequestHeadBytes,
        FIXTURE_HEADER_BLOCK_BYTES,
      );
      const pad = '"'.repeat(headBudget - FIXTURE_HEADER_MARGIN_BYTES);
      content.send(k3Request(1, `/api/echo?n=${nonce}`, [["x-pad", pad]]));
      expect(await content.next()).toMatchObject({ type: "paseo.web.response.head", status: 200 });
      const echoed: unknown = JSON.parse(await readK3Body(content, 1));
      expect(isRecord(echoed) && Array.isArray(echoed.headerNames)).toBe(true);
      expect((echoed as { headerNames: unknown[] }).headerNames).toContain("x-pad");
      expect(connection.meter.maxOutFrameBytes).toBeGreaterThanOrEqual(2 * pad.length);

      // Inbound: a multi-byte UTF-8 body echoed back as several body frames, compared whole.
      const body = "ação-".repeat(8_192);
      content.send(k3Post(2, `/api/echo?n=${nonce}`, body));
      expect(await content.next()).toMatchObject({ type: "paseo.web.response.head", status: 200 });
      const posted: unknown = JSON.parse(await readK3Body(content, 2));
      expect(isRecord(posted) && posted.body === body).toBe(true);

      expect(connection.socket.failure()).toBeNull();
      expect(connection.closedReasons).toEqual([]);
      const { limits } = connection.tunnel;
      task.meta.r2 = {
        tunnelInitialWindowBytes: limits.initialWindowBytes,
        tunnelMaxDataBytes: limits.maxDataBytes,
        maxOutFrameBytes: connection.meter.maxOutFrameBytes,
        maxInPayloadBytes: connection.meter.maxInPayloadBytes,
        outFrames: connection.meter.outFrames,
        inFrames: connection.meter.inFrames,
        writes: connection.meter.writes,
        maxWriteBytes: connection.meter.maxWriteBytes,
        outFrameAboveMaxData: connection.meter.maxOutFrameBytes > limits.maxDataBytes,
        bodyUtf8Bytes: encoder.encode(body).length,
      };
      await expectHostMatchesC();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "cancels a slow response through the relay and keeps serving the session (R2-5)",
    async () => {
      const connection = await openRelayConnection();
      const { harness } = connection.connection;
      const content = openK3(connection.transport, connection.capability);
      const nonce = createNonce();

      content.send(k3Request(1, `/slow?bytes=262144&chunk=1024&intervalMs=50&n=${nonce}`));
      expect(await content.next()).toMatchObject({ type: "paseo.web.response.head", status: 200 });
      content.send({ type: "paseo.web.cancel", v: 1, generation: 1, requestId: 1 });
      await vi.waitFor(async () => {
        const closed = await eventsOf(harness, "slow.closed");
        expect(closed).toContainEqual(expect.objectContaining({ nonce, completed: false }));
      }, SLOW);
      await vi.waitFor(async () => expect((await harness.stats(1)).active).toBe(0), SLOW);

      // The reservation was released: the same session serves the next request.
      content.send(k3Request(2, `/api/echo?n=${nonce}`));
      await vi.waitFor(() => {
        expect(content.received).toContainEqual(
          expect.objectContaining({ type: "paseo.web.response.head", requestId: 2, status: 200 }),
        );
      }, SLOW);
      expect(connection.closedReasons).toEqual([]);
      await expectHostMatchesC();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports the relay loss as transport_closed and never resends the held POST (R2-6)",
    async ({ task }) => {
      let broker: WebProxyBroker | null = null;
      const first = await openRelayConnection((reason) => {
        if (reason === "channel_lost") broker?.revoke("transport_closed");
      });
      const transport = createDelegatingTransport(first.transport);
      broker = attachBroker(first, transport);
      await expectRootDom(broker, first.connection.harness, first.capability.contentOrigin);
      const lostGeneration = broker.getState().generation;

      // 1. A POST the fixture holds: it arrived, its outcome is unknown to the page.
      const content = openK3(first.transport, first.capability);
      const token = createNonce();
      content.send(k3Post(1, `/post/${token}?hold=1&n=${token}`, "held body"));
      await vi.waitFor(async () => {
        const arrived = withToken(await eventsOf(first.connection.harness, "post.arrived"), token);
        expect(arrived).toContainEqual(expect.objectContaining({ token, held: true }));
      }, SLOW);

      // 2. The relay goes away under the open tunnel.
      await commands.webProxyRelayRestart();

      // 3. The page sees the loss explicitly; the adapter rejects, it does not retry.
      expect(await content.next(RECOVERY)).toMatchObject({
        type: "paseo.web.response.error",
        requestId: 1,
        reason: "transport_closed",
      });
      await vi.waitFor(() => {
        expect(first.closedReasons).toContain("channel_lost");
        expect(broker?.getState()).toMatchObject({ status: "revoked", reason: "transport_closed" });
      }, RECOVERY);

      // 4. Explicit reopening: new client, tunnel, channel and adapter, then a new generation.
      const second = await openRelayConnection();
      transport.use(second.transport);
      broker.reopen();

      // 5. Sentinel first: the new generation renders a new root document, recorded by the fixture.
      const { harness } = second.connection;
      await expectRootDom(broker, harness, second.capability.contentOrigin, lostGeneration);

      // 6. Only then the absences, over complete pages with nothing dropped.
      const posts = (await requestEvents(harness)).filter(
        (event) => event.method === "POST" && event.path === `/post/${token}`,
      );
      expect(posts).toHaveLength(1);
      expect(withToken(await eventsOf(harness, "post.arrived"), token)).toHaveLength(1);
      const counted = withToken(await eventsOf(harness, "post.count"), token);
      expect(counted).toEqual([expect.objectContaining({ token, count: 1 })]);

      // 7. Exactly one held response to release, and its old exchange is gone.
      expect(await harness.release(token)).toBe(1);
      await vi.waitFor(async () => {
        const released = withToken(await eventsOf(harness, "post.released"), token);
        expect(released).toEqual([expect.objectContaining({ token, delivered: false })]);
      }, SLOW);
      const abandoned = withToken(await eventsOf(harness, "post.abandoned"), token);

      expect(second.closedReasons).toEqual([]);
      const host = await expectHostMatchesC();
      heldToken = token;
      task.meta.r2 = {
        lostGeneration,
        reopenedGeneration: broker.getState().generation,
        postAbandonedRecorded: abandoned.length,
        hostAuthenticated: host.authenticatedConnections,
        hostSessions: host.sessionsOpened,
      };
    },
    RESTART_TEST_TIMEOUT_MS,
  );

  it(
    "re-reads the held POST once more and closes every handle it opened (R2-7)",
    async ({ task }) => {
      if (heldToken === null) throw new Error("the restart case did not record its held POST");
      const token = heldToken;
      const connection = await openRelayConnection();
      const { harness } = connection.connection;

      // RV-8 step 7: the window observed extends to the end of the file; still one arrival.
      const posts = (await requestEvents(harness)).filter(
        (event) => event.method === "POST" && event.path === `/post/${token}`,
      );
      expect(posts).toHaveLength(1);
      expect(withToken(await eventsOf(harness, "post.arrived"), token)).toHaveLength(1);
      expect(withToken(await eventsOf(harness, "post.count"), token)).toHaveLength(1);
      expect(await harness.release(token)).toBe(0);
      const host = await expectHostMatchesC();

      // Explicit teardown of this case's handles, in order; each close must succeed.
      cleanups.length = 0;
      connection.transport.close();
      connection.connection.channel.close();
      await vi.waitFor(() => expect(connection.socket.state()).toBe("closed"), SLOW);
      expect(connection.socket.failure()).toBeNull();
      await connection.tunnel.close();
      await connection.client.close();
      expect(sockets.every((socket) => socket.state() === "closed")).toBe(true);

      task.meta.r2 = {
        socketsOpened: sockets.length,
        hostAuthenticated: host.authenticatedConnections,
        hostSessions: host.sessionsOpened,
        hostConnections: host.connections,
      };
    },
    TEST_TIMEOUT_MS,
  );
});
