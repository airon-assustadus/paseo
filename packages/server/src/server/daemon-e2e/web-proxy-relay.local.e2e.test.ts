/* eslint-disable max-nested-callbacks */
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import {
  parseConnectionOfferFromUrl,
  type ConnectionOffer,
} from "@getpaseo/protocol/connection-offer";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import type { NetworkTunnel, NetworkTunnelStream } from "@getpaseo/client";
import {
  BRIDGE_HARNESS_LIMITS,
  startBridgeHost,
  type BridgeHost,
  type BridgeOutboundFrame,
} from "../network-fetch/__fixtures__/bridge-host.js";
import {
  encodeLengthPrefixed,
  LengthPrefixedReader,
} from "../network-fetch/__fixtures__/length-prefixed.js";
import { generateLocalPairingOffer } from "../pairing-offer.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import {
  startLocalWranglerRelay,
  type LocalWranglerRelay,
} from "../test-utils/local-wrangler-relay.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { startWsTap, type WsTap } from "../test-utils/ws-tap.js";

/**
 * L-relay, stage R1 (relay-spike-execution-plan.md §5, §10): the bridge frames travel over the
 * existing authenticated transport — DaemonClient with E2EE → local relay → isolated daemon →
 * network tunnel → the bridge host's length-prefixed TCP listener → NetworkFetchSession → fixture.
 *
 * The relay is the in-repo Cloudflare worker run locally with wrangler: a legacy, undeployed
 * implementation (docs/architecture.md). What is proven here is the client/daemon transport and
 * its E2EE around that relay, not the hosted Elixir relay, not a device, not site isolation.
 * Pairing material is generated locally in a temporary PASEO_HOME; nothing real is paired.
 */

const nodeMajor = Number((process.versions.node ?? "0").split(".")[0] ?? "0");
// wrangler's local runtime is not supported on Node 25 yet; the skip is visible, not silent.
const relaySuite = nodeMajor < 25 ? describe : describe.skip;
const SUITE_NAME =
  nodeMajor < 25
    ? "web proxy bridge over the local relay (R1)"
    : `web proxy bridge over the local relay (R1) — skipped: wrangler needs Node < 25, found ${nodeMajor}`;

const SHELL = { bootstrapJs: "// bootstrap bundle (unused on TCP)", workerJs: "// worker bundle" };
const TEST_TIMEOUT_MS = 120_000;
const WINDOW_BYTES = BRIDGE_HARNESS_LIMITS.initialWindowBytes;
const CHUNK_BYTES = BRIDGE_HARNESS_LIMITS.maxChunkBytes;

interface Evidence {
  relayConnections: { client: number; daemon: number };
  tapOverflow: { client: unknown; daemon: unknown };
  [key: string]: unknown;
}

type FrameOf<T extends BridgeOutboundFrame["type"]> = Extract<BridgeOutboundFrame, { type: T }>;

interface BridgeStream {
  send(frame: Record<string, unknown>): void;
  /** Raw bytes, for frames the encoder refuses to build; still split by the tunnel data limit. */
  sendRaw(bytes: Uint8Array): void;
  /** One waiter for one of `types`; never race two `next` calls, a losing waiter would steal frames. */
  nextOf<T extends BridgeOutboundFrame["type"]>(
    types: readonly T[],
    predicate?: (frame: FrameOf<T>) => boolean,
  ): Promise<FrameOf<T>>;
  next<T extends BridgeOutboundFrame["type"]>(
    type: T,
    predicate?: (frame: FrameOf<T>) => boolean,
  ): Promise<FrameOf<T>>;
  frames(): readonly BridgeOutboundFrame[];
  readonly closed: Promise<number>;
  close(): void;
}

let relay: LocalWranglerRelay;
let clientTap: WsTap;
let daemonTap: WsTap;
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

relaySuite(SUITE_NAME, () => {
  beforeAll(async () => {
    relay = await startLocalWranglerRelay({ startupTimeoutMs: 90_000 });
    clientTap = await startWsTap({ targetPort: relay.port });
    daemonTap = await startWsTap({ targetPort: relay.port });
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await clientTap?.close();
    await daemonTap?.close();
    await relay?.stop();
  });

  it(
    "carries a GET to the fixture through relay, tunnel and TCP bridge, leaving no plaintext at the relay (R1-1, R1-2)",
    async () => {
      const { host, stream } = await openBridge();
      const nonce = `r1-${randomBytes(8).toString("hex")}`;
      const marker = `marker-${randomBytes(8).toString("hex")}`;

      stream.send(requestFrame(1, `${host.fixture.http.origin}/?n=${nonce}&m=${marker}`));
      const head = await stream.next("head", (frame) => frame.requestId === 1);
      expect(head.head.status).toBe(200);
      const body = await collectBody(stream, 1);
      expect(body).toContain(`data-nonce="${nonce}"`);
      expect(host.backend.events.ofKind("request").map((event) => event.nonce)).toEqual([nonce]);

      const evidence = relayEvidence();
      expect(evidence.relayConnections.client).toBeGreaterThanOrEqual(1);
      expect(evidence.relayConnections.daemon).toBeGreaterThanOrEqual(1);
      expect(evidence.tapOverflow).toEqual({ client: null, daemon: null });
      // Auxiliary controls, not a cryptographic audit: the nonce and marker crossed both relay
      // legs only inside ciphertext, and the only cleartext frames are the key exchange.
      expect(clientTap.contains(nonce)).toEqual({ toTarget: false, fromTarget: false });
      expect(daemonTap.contains(nonce)).toEqual({ toTarget: false, fromTarget: false });
      expect(clientTap.contains(marker)).toEqual({ toTarget: false, fromTarget: false });
      expect(clientTap.contains('"harness.hello"')).toEqual({ toTarget: false, fromTarget: false });
      const handshakes = clientTap
        .messages()
        .filter((message) => message.plaintextHandshake !== null)
        .map((message) => message.plaintextHandshake);
      expect(handshakes).toEqual(["e2ee_hello", "e2ee_ready"]);
      // Pending (R1-C1): decrypting the captured ciphertext with a wrong key is not attempted here,
      // because the tap keeps payloads out of reach by design. The controls above are not a
      // cryptographic audit; they show the request went through the authenticated path and that
      // the markers never crossed the relay in clear.
      const ciphertextMessages = clientTap
        .messages()
        .filter((message) => message.plaintextHandshake === null).length;
      expect(ciphertextMessages).toBeGreaterThan(0);
      logEvidence("R1-1/R1-2", {
        ...evidence,
        handshakes,
        ciphertextMessages,
        bodyBytes: body.length,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "composes the tunnel window with the bridge credit on a large download (R1-3)",
    async () => {
      const { host, stream } = await openBridge();
      const nonce = `r1-3-${randomBytes(6).toString("hex")}`;
      // Bytes, not frame counts: the core slices the last piece at the window boundary, so the
      // window can arrive as five frames; the invariant is the byte total.
      let bodies = 0;
      let bodyBytes = 0;
      const counting = (frame: BridgeOutboundFrame) => {
        if (frame.type !== "body" || frame.requestId !== 1) return;
        bodies += 1;
        bodyBytes += Buffer.from(frame.data, "base64").byteLength;
      };
      watchFrames(stream, counting);

      stream.send(requestFrame(1, `${host.fixture.http.origin}/large?bytes=1048576&n=${nonce}`));
      await stream.next("head", (frame) => frame.requestId === 1);
      const atWindow = await statsWhen(stream, 1, (stats) => stats.delivered === WINDOW_BYTES);
      expect(atWindow.credited).toBe(0);
      await stream.nextOf(["body"], () => bodyBytes >= WINDOW_BYTES).catch(() => undefined);
      expect(bodyBytes).toBe(WINDOW_BYTES);
      const framesAtWindow = bodies;

      stream.send({ type: "grantCredit", requestId: 1, bytes: CHUNK_BYTES });
      const afterGrant = await statsWhen(
        stream,
        1,
        (stats) => stats.delivered === WINDOW_BYTES + CHUNK_BYTES,
      );
      expect(afterGrant.credited).toBe(CHUNK_BYTES);
      await stream
        .nextOf(["body"], () => bodyBytes >= WINDOW_BYTES + CHUNK_BYTES)
        .catch(() => undefined);
      expect(bodyBytes).toBe(WINDOW_BYTES + CHUNK_BYTES);
      expect(bodies).toBeGreaterThan(framesAtWindow);
      const still = await statsWhen(stream, 1, () => true);
      expect(still.delivered).toBe(WINDOW_BYTES + CHUNK_BYTES);

      stream.send({ type: "cancel", requestId: 1 });
      await stream.next("cancelled", (frame) => frame.requestId === 1);
      logEvidence("R1-3", { ...relayEvidence(), bodies, bodyBytes });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "drops only the connection that sent an oversized frame and keeps serving the host (R1-4)",
    async () => {
      // No legal request reaches the 65 536-byte ceiling: the host refuses a header sum above
      // 16 KiB at the frame boundary, so acceptance at the ceiling is proven by the codec and the
      // host's own TCP tests. Through the tunnel the relevant facts are isolation and continuity.
      const { host, stream } = await openBridge();
      const { stream: second } = await openBridge(host);
      const closing = second.closed;
      second.sendRaw(
        rawFrame(
          JSON.stringify(
            requestFrame(1, `${host.fixture.http.origin}/api/echo?n=r1-4-big`, {
              headers: [["Accept", "x".repeat(ceilingPadding() + 1)]],
            }),
          ),
        ),
      );
      await closing;
      expect(second.frames().some((frame) => frame.type === "head")).toBe(false);
      expect(host.backend.events.ofKind("request").map((e) => e.nonce)).not.toContain("r1-4-big");

      stream.send(requestFrame(1, `${host.fixture.http.origin}/api/echo?n=r1-4-ok`));
      const head = await stream.next("head", (frame) => frame.requestId === 1);
      expect(head.head.status).toBe(200);
      await collectBody(stream, 1);
      expect(host.backend.events.ofKind("request").map((e) => e.nonce)).toContain("r1-4-ok");
      logEvidence("R1-4", { ...relayEvidence(), activeSockets: host.stats.activeSockets });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a replayed request frame after the first POST took effect (R1-5)",
    async () => {
      const { host, stream } = await openBridge();
      const token = `replay-${randomBytes(4).toString("hex")}`;
      host.duplicateNextRequest();
      stream.send(
        requestFrame(1, `${host.fixture.http.origin}/post/${token}?hold=1&n=${token}`, {
          method: "POST",
          body: { kind: "stream", length: 0 },
        }),
      );
      stream.send({ type: "endBody", requestId: 1 });
      await host.backend.events.waitFor("post.arrived", (e) => e.token === token, 30_000);
      const violation = await stream.next("protocol_error");
      expect(violation.violation).toBe("replayed");
      await host.backend.events.waitFor("post.count", (e) => e.token === token, 30_000);
      stream.send({ type: "fixture.release", token });
      const released = await stream.next("fixture.release.result", (f) => f.token === token);
      expect(released.released).toBe(1);
      await stream.next("end", (frame) => frame.requestId === 1);
      expect(host.backend.postCount(token)).toBe(1);
      expect(
        host.backend.events.ofKind("post.arrived").filter((e) => e.token === token),
      ).toHaveLength(1);
      logEvidence("R1-5", relayEvidence());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never repeats a POST whose result was lost when the relay restarted (R1-6)",
    async () => {
      const first = await openBridge();
      const host = first.host;
      const token = `unknown-${randomBytes(4).toString("hex")}`;
      first.stream.send(
        requestFrame(1, `${host.fixture.http.origin}/post/${token}?hold=1&n=${token}`, {
          method: "POST",
          body: { kind: "stream", length: 0 },
        }),
      );
      first.stream.send({ type: "endBody", requestId: 1 });
      await host.backend.events.waitFor("post.count", (e) => e.token === token, 30_000);

      await relay.restart();
      // The tunnel loses its transport and the host, seeing the TCP peer go, cancels the exchange.
      // This harness drives frames directly: it proves a single effect on the path exercised, not
      // the retry behaviour of the app adapter, which has its own tests.
      await first.stream.closed;
      await host.backend.events.waitFor("post.abandoned", (e) => e.token === token, 30_000);

      const second = await openBridge(host, { reuseDaemon: first.daemon });
      second.stream.send({ type: "fixture.release", token });
      const released = await second.stream.next("fixture.release.result", (f) => f.token === token);
      expect(released.released).toBe(1);
      expect(host.backend.postCount(token)).toBe(1);
      expect(
        host.backend.events.ofKind("post.arrived").filter((e) => e.token === token),
      ).toHaveLength(1);
      expect(
        await host.backend.events.waitFor("post.released", (e) => e.token === token, 30_000),
      ).toMatchObject({ delivered: false });
      logEvidence("R1-6", relayEvidence());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "cancels a slow response through the tunnel and reports the release (R1-7)",
    async () => {
      const { host, stream } = await openBridge();
      const nonce = `r1-7-${randomBytes(4).toString("hex")}`;
      stream.send(
        requestFrame(
          1,
          `${host.fixture.http.origin}/slow?bytes=65536&chunk=1024&intervalMs=50&n=${nonce}`,
        ),
      );
      await stream.next("body", (frame) => frame.requestId === 1);
      stream.send({ type: "cancel", requestId: 1 });
      const cancelled = await stream.next("cancelled", (frame) => frame.requestId === 1);
      expect(cancelled.dnsPending).toBe(false);
      const closed = await host.backend.events.waitFor(
        "slow.closed",
        (e) => e.nonce === nonce,
        30_000,
      );
      expect(closed.completed).toBe(false);
      logEvidence("R1-7", relayEvidence());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "tears everything down: host, client, daemon and taps refuse afterwards (R1-8)",
    async () => {
      const { host, stream, client, daemon } = await openBridge();
      stream.send({ type: "close" });
      await stream.next("closed");
      await stream.closed;
      await host.close();
      await client.close();
      await daemon.close();
      expect(host.stats.activeSockets).toBe(0);
      expect(relay.exited).toBe(false);
      logEvidence("R1-8", relayEvidence());
    },
    TEST_TIMEOUT_MS,
  );
});

interface OpenedBridge {
  host: BridgeHost;
  daemon: TestPaseoDaemon;
  client: DaemonClient;
  tunnel: NetworkTunnel;
  stream: BridgeStream;
}

const startedAt = Date.now();
function mark(step: string, detail: Record<string, unknown> = {}): void {
  // Timeline of the harness steps; values are counts and labels only.
  // eslint-disable-next-line no-console
  console.info(`[relay-r1] +${Date.now() - startedAt}ms ${step} ${JSON.stringify(detail)}`);
}

async function openBridge(
  existingHost?: BridgeHost,
  options: { reuseDaemon?: TestPaseoDaemon } = {},
): Promise<OpenedBridge> {
  const host = existingHost ?? (await startHost());
  mark("host ready", { tcp: host.tcp !== null });
  const daemon = options.reuseDaemon ?? (await startDaemon());
  mark("daemon started");
  await waitForRelayRegistration(daemon);
  mark("daemon relay control connected");
  const offer = await offerFor(daemon);
  mark("offer parsed");
  const client = await connectClient(offer);
  mark("client connected through relay");
  const tunnel = await client.openNetworkTunnel();
  mark("tunnel opened");
  closers.push(() => tunnel.close());
  if (host.tcp === null) throw new Error("Bridge host started without its TCP listener");
  const stream = await openBridgeStream(tunnel, host.tcp.port);
  mark("tcp stream connected");
  stream.send({ type: "harness.hello", token: host.token });
  await stream.next("harness.ready");
  mark("harness ready");
  stream.send({
    type: "session.open",
    scope: { origin: host.fixture.http.origin, pathPrefix: "/" },
    ttlMs: 60_000,
  });
  await stream.next("session.opened");
  mark("session opened");
  return { host, daemon, client, tunnel, stream };
}

const daemonLogs = new WeakMap<TestPaseoDaemon, string[]>();

/** The daemon registers with the relay asynchronously after start; a client before that cannot be routed. */
async function waitForRelayRegistration(daemon: TestPaseoDaemon): Promise<void> {
  const lines = daemonLogs.get(daemon) ?? [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (lines.some((line) => line.includes("relay_control_connected"))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const relayEvents = lines
    .filter((line) => line.includes("relay_"))
    .map((line) => line.match(/"event":"([a-z_]+)"/)?.[1] ?? "?")
    .slice(-10);
  throw new Error(
    `Daemon did not register with the relay; recent relay events: ${relayEvents.join(",")}`,
  );
}

async function startHost(): Promise<BridgeHost> {
  const host = await startBridgeHost({
    shell: SHELL,
    allowedOrigin: "http://127.0.0.1:1",
    tcp: true,
  });
  closers.push(() => host.close());
  return host;
}

async function startDaemon(): Promise<TestPaseoDaemon> {
  const lines: string[] = [];
  const logger = pino(
    { level: "debug" },
    new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString("utf8"));
        callback();
      },
    }),
  );
  const daemon = await createTestPaseoDaemon({
    logger,
    listen: "127.0.0.1",
    mcpEnabled: false,
    relayEnabled: true,
    relayEndpoint: `127.0.0.1:${daemonTap.port}`,
    relayUseTls: false,
    relayPublicUseTls: false,
  });
  daemonLogs.set(daemon, lines);
  closers.push(() => daemon.close());
  return daemon;
}

async function offerFor(daemon: TestPaseoDaemon): Promise<ConnectionOffer> {
  const pairing = await generateLocalPairingOffer({
    paseoHome: daemon.paseoHome,
    relayEnabled: true,
    relayEndpoint: `127.0.0.1:${daemonTap.port}`,
    relayPublicEndpoint: `127.0.0.1:${clientTap.port}`,
    relayUseTls: false,
    relayPublicUseTls: false,
    appBaseUrl: "https://app.paseo.sh",
    includeQr: false,
  });
  if (!pairing.url) throw new Error("Local pairing did not produce a relay offer");
  const offer = parseConnectionOfferFromUrl(pairing.url);
  if (!offer) throw new Error("Local pairing offer did not parse");
  return offer;
}

/** Connection attempts are bounded harness retries; no request is ever resent by them. */
async function connectClient(offer: ConnectionOffer): Promise<DaemonClient> {
  const deadline = Date.now() + 60_000;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const client = new DaemonClient({
      url: buildRelayWebSocketUrl({
        endpoint: offer.relay.endpoint,
        useTls: false,
        serverId: offer.serverId,
        role: "client",
      }),
      clientType: "cli",
      connectTimeoutMs: 15_000,
      capabilities: { [CLIENT_CAPS.networkTunnel]: true, [CLIENT_CAPS.ownedSubscriptions]: true },
      e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      mark("client websocket+e2ee connected", { attempts });
      await client.fetchAgents();
      closers.push(() => client.close().catch(() => undefined));
      return client;
    } catch (error) {
      mark("client connect attempt failed", {
        attempts,
        error: error instanceof Error ? error.name : "unknown",
      });
      await client.close().catch(() => undefined);
      if (Date.now() >= deadline) {
        throw new Error(`Relay client could not connect after ${attempts} attempts`, {
          cause: error,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

function openBridgeStream(tunnel: NetworkTunnel, port: number): Promise<BridgeStream> {
  return new Promise((resolve, rejectOpen) => {
    const frames: BridgeOutboundFrame[] = [];
    const waiters = new Set<() => void>();
    const listeners = new Set<(frame: BridgeOutboundFrame) => void>();
    let resolveClosed: (reason: number) => void = () => undefined;
    let streamClosedReason: number | null = null;
    const closed = new Promise<number>((settle) => {
      resolveClosed = settle;
    });
    let stream: NetworkTunnelStream;
    const reader = new LengthPrefixedReader({
      onFrame: (text) => {
        const frame = JSON.parse(text) as BridgeOutboundFrame;
        frames.push(frame);
        for (const listener of listeners) listener(frame);
        for (const waiter of waiters) waiter();
      },
    });
    const handle: BridgeStream = {
      // A bridge frame of up to 65 540 bytes crosses the tunnel as more than one Data frame; the
      // reader on the other side reassembles by the length prefix, never by Data boundaries.
      send: (frame) => handle.sendRaw(encodeLengthPrefixed(JSON.stringify(frame))),
      sendRaw: (bytes) => {
        const step = tunnel.limits.maxDataBytes;
        for (let offset = 0; offset < bytes.length; offset += step) {
          stream.write(bytes.subarray(offset, offset + step));
        }
      },
      nextOf: (types, predicate = () => true) =>
        new Promise((settle, fail) => {
          const wanted = new Set<string>(types);
          // A frame that ends the exchange or the session while something else is awaited is a
          // failure with a reason, never a silent timeout.
          const check = () => {
            const match = frames.find(
              (frame): frame is FrameOf<(typeof types)[number]> =>
                wanted.has(frame.type) && predicate(frame as never),
            );
            if (match) {
              waiters.delete(check);
              frames.splice(frames.indexOf(match), 1);
              settle(match);
              return;
            }
            const terminal = frames.find(
              (frame) =>
                frame.type === "protocol_error" ||
                (frame.type === "fail" && !wanted.has("fail")) ||
                (frame.type === "closed" && !wanted.has("closed")),
            );
            if (terminal || streamClosedReason !== null) {
              waiters.delete(check);
              fail(
                new Error(
                  `Waiting for ${types.join("|")}; got ${JSON.stringify(terminal ?? { streamClosed: streamClosedReason })}; seen ${frames.map((f) => f.type).join(",")}`,
                ),
              );
            }
          };
          waiters.add(check);
          check();
        }),
      next: (type, predicate) => handle.nextOf([type], predicate),
      frames: () => frames,
      closed,
      close: () => stream.close(),
    };
    streamListeners.set(handle, listeners);
    stream = tunnel.openStream(
      { host: "127.0.0.1", port },
      {
        onConnected: () => resolve(handle),
        onData: (data) => {
          // Every byte is parsed or held in the reader's bounded buffer before credit goes back.
          const accepted = reader.push(data);
          stream.consume(accepted);
        },
        onCredit: () => undefined,
        onClose: (reason) => {
          streamClosedReason = reason;
          resolveClosed(reason);
          for (const waiter of waiters) waiter();
          rejectOpen(new Error(`Tunnel stream closed before connecting (reason ${reason})`));
        },
      },
    );
  });
}

const streamListeners = new WeakMap<BridgeStream, Set<(frame: BridgeOutboundFrame) => void>>();

function watchFrames(stream: BridgeStream, listener: (frame: BridgeOutboundFrame) => void): void {
  streamListeners.get(stream)?.add(listener);
}

function requestFrame(
  requestId: number,
  url: string,
  extra: Partial<{
    method: string;
    headers: Array<[string, string]>;
    body: { kind: "none" } | { kind: "stream"; length: number | null };
  }> = {},
): Record<string, unknown> {
  return {
    type: "request",
    requestId,
    method: extra.method ?? "GET",
    url,
    headers: extra.headers ?? [],
    redirect: "manual",
    body: extra.body ?? { kind: "none" },
  };
}

async function collectBody(stream: BridgeStream, requestId: number): Promise<string> {
  const chunks: Buffer[] = [];
  for (;;) {
    const frame = await stream.nextOf(["body", "end"], (f) => f.requestId === requestId);
    if (frame.type === "end") break;
    const bytes = Buffer.from(frame.data, "base64");
    chunks.push(bytes);
    stream.send({ type: "grantCredit", requestId, bytes: bytes.length });
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function statsWhen(
  stream: BridgeStream,
  requestId: number,
  predicate: (stats: { delivered: number; credited: number; active: number }) => boolean,
): Promise<{ delivered: number; credited: number; active: number }> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    stream.send({ type: "harness.stats", requestId });
    const stats = await stream.next("harness.stats.result", (f) => f.requestId === requestId);
    if (predicate(stats)) return stats;
    if (Date.now() >= deadline) throw new Error(`stats never matched: ${JSON.stringify(stats)}`);
  }
}

/** A length-prefixed frame built by hand, so an oversized payload can be sent to the receiver. */
function rawFrame(text: string): Uint8Array {
  const payload = Buffer.from(text, "utf8");
  const frame = new Uint8Array(4 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length, false);
  frame.set(payload, 4);
  return frame;
}

/** Bytes of `Accept` that put the serialized request frame exactly at the 65 536-byte ceiling. */
function ceilingPadding(): number {
  const probe = JSON.stringify(
    requestFrame(1, "http://127.0.0.1:65535/api/echo?n=r1-4-big", {
      headers: [["Accept", ""]],
    }),
  );
  return 65_536 - Buffer.byteLength(probe);
}

function relayEvidence(): Evidence {
  return {
    relayConnections: {
      client: clientTap.summary().connections,
      daemon: daemonTap.summary().connections,
    },
    tapOverflow: { client: clientTap.summary().overflow, daemon: daemonTap.summary().overflow },
    bytes: { client: clientTap.summary().bytes, daemon: daemonTap.summary().bytes },
    sha256: { client: clientTap.summary().sha256, daemon: daemonTap.summary().sha256 },
  };
}

function logEvidence(label: string, evidence: Record<string, unknown>): void {
  // Sanitized by construction: counts, hashes and booleans only.
  // eslint-disable-next-line no-console
  console.info(`[relay-r1] ${label} ${JSON.stringify(evidence)}`);
}
