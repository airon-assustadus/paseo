/* eslint-disable max-nested-callbacks */
import { randomBytes } from "node:crypto";
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

interface BridgeStream {
  send(frame: Record<string, unknown>): void;
  next<T extends BridgeOutboundFrame["type"]>(
    type: T,
    predicate?: (frame: Extract<BridgeOutboundFrame, { type: T }>) => boolean,
  ): Promise<Extract<BridgeOutboundFrame, { type: T }>>;
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
      let bodies = 0;
      const counting = (frame: BridgeOutboundFrame) => {
        if (frame.type === "body" && frame.requestId === 1) bodies += 1;
      };
      watchFrames(stream, counting);

      stream.send(requestFrame(1, `${host.fixture.http.origin}/large?bytes=1048576&n=${nonce}`));
      await stream.next("head", (frame) => frame.requestId === 1);
      const atWindow = await statsWhen(stream, 1, (stats) => stats.delivered === WINDOW_BYTES);
      expect(atWindow.credited).toBe(0);
      expect(bodies).toBe(WINDOW_BYTES / CHUNK_BYTES);

      stream.send({ type: "grantCredit", requestId: 1, bytes: CHUNK_BYTES });
      const afterGrant = await statsWhen(
        stream,
        1,
        (stats) => stats.delivered === WINDOW_BYTES + CHUNK_BYTES,
      );
      expect(afterGrant.credited).toBe(CHUNK_BYTES);
      expect(bodies).toBe(WINDOW_BYTES / CHUNK_BYTES + 1);
      const still = await statsWhen(stream, 1, () => true);
      expect(still.delivered).toBe(WINDOW_BYTES + CHUNK_BYTES);

      stream.send({ type: "cancel", requestId: 1 });
      await stream.next("cancelled", (frame) => frame.requestId === 1);
      logEvidence("R1-3", { ...relayEvidence(), bodies });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "accepts a frame at the ceiling and drops the connection one byte above it (R1-4)",
    async () => {
      const { host, stream } = await openBridge();
      const atCeiling = requestFrame(1, `${host.fixture.http.origin}/api/echo?n=r1-4-ok`, {
        headers: [["Accept", "x".repeat(ceilingPadding())]],
      });
      stream.send(atCeiling);
      const outcome = await Promise.race([
        stream.next("head", (frame) => frame.requestId === 1).then(() => "head" as const),
        stream.next("fail", (frame) => frame.requestId === 1).then((f) => f.code),
      ]);
      expect(["head", "request_head_too_large"]).toContain(outcome);

      const { stream: second } = await openBridge(host);
      const closing = second.closed;
      second.send(
        requestFrame(1, `${host.fixture.http.origin}/api/echo?n=r1-4-big`, {
          headers: [["Accept", "x".repeat(ceilingPadding() + 1)]],
        }),
      );
      await closing;
      expect(second.frames().some((frame) => frame.type === "head")).toBe(false);
      expect(host.backend.events.ofKind("request").map((e) => e.nonce)).not.toContain("r1-4-big");
      logEvidence("R1-4", relayEvidence());
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

async function openBridge(
  existingHost?: BridgeHost,
  options: { reuseDaemon?: TestPaseoDaemon } = {},
): Promise<OpenedBridge> {
  const host = existingHost ?? (await startHost());
  const daemon = options.reuseDaemon ?? (await startDaemon());
  const offer = await offerFor(daemon);
  const client = await connectClient(offer);
  const tunnel = await client.openNetworkTunnel();
  closers.push(() => tunnel.close());
  if (host.tcp === null) throw new Error("Bridge host started without its TCP listener");
  const stream = await openBridgeStream(tunnel, host.tcp.port);
  stream.send({ type: "harness.hello", token: host.token });
  await stream.next("harness.ready");
  stream.send({
    type: "session.open",
    scope: { origin: host.fixture.http.origin, pathPrefix: "/" },
    ttlMs: 60_000,
  });
  await stream.next("session.opened");
  return { host, daemon, client, tunnel, stream };
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
  const daemon = await createTestPaseoDaemon({
    listen: "127.0.0.1",
    mcpEnabled: false,
    relayEnabled: true,
    relayEndpoint: `127.0.0.1:${daemonTap.port}`,
    relayUseTls: false,
    relayPublicUseTls: false,
  });
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
      await client.fetchAgents();
      closers.push(() => client.close().catch(() => undefined));
      return client;
    } catch (error) {
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
  return new Promise((resolve, reject) => {
    const frames: BridgeOutboundFrame[] = [];
    const waiters = new Set<() => void>();
    const listeners = new Set<(frame: BridgeOutboundFrame) => void>();
    let resolveClosed: (reason: number) => void = () => undefined;
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
      send: (frame) => stream.write(encodeLengthPrefixed(JSON.stringify(frame))),
      next: (type, predicate = () => true) =>
        new Promise((settle) => {
          const check = () => {
            const match = frames.find(
              (frame): frame is Extract<BridgeOutboundFrame, { type: typeof type }> =>
                frame.type === type && predicate(frame as never),
            );
            if (!match) return;
            waiters.delete(check);
            frames.splice(frames.indexOf(match), 1);
            settle(match);
          };
          waiters.add(check);
          check();
        }),
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
          resolveClosed(reason);
          reject(new Error(`Tunnel stream closed before connecting (reason ${reason})`));
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
    const frame = await Promise.race([
      stream.next("body", (f) => f.requestId === requestId),
      stream.next("end", (f) => f.requestId === requestId),
    ]);
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
