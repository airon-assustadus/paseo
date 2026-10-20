/* eslint-disable max-nested-callbacks */
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ResolvedTunnelAddress } from "../../network-tunnel/target-policy.js";
import {
  BRIDGE_HARNESS_LIMITS,
  BRIDGE_SUBPROTOCOL,
  BridgeHostStartError,
  pageEvents,
  startBridgeHost,
  type BridgeHost,
  type BridgeOutboundFrame,
  type StartBridgeHostOptions,
} from "./bridge-host.js";
import { encodeLengthPrefixed, LengthPrefixedReader } from "./length-prefixed.js";
import { FixtureRecorder, type FixtureEvent } from "./recorder.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

const ALLOWED_ORIGIN = "http://localhost:4173";
const SHELL = { bootstrapJs: "// bootstrap bundle", workerJs: "// worker bundle" };
const HELLO_TIMEOUT_MS = 200;
const WAIT_MS = 10_000;

async function startHost(overrides: Partial<StartBridgeHostOptions> = {}): Promise<BridgeHost> {
  const host = await startBridgeHost({
    shell: SHELL,
    allowedOrigin: ALLOWED_ORIGIN,
    ...overrides,
    harness: { helloTimeoutMs: HELLO_TIMEOUT_MS, ...overrides.harness },
  });
  closers.push(() => host.close());
  return host;
}

interface Closure {
  code: number;
  reason: string;
}

type FrameType = BridgeOutboundFrame["type"];
type FrameOf<T extends FrameType> = Extract<BridgeOutboundFrame, { type: T }>;

interface FrameQueue {
  /** Frames received and not yet taken, in arrival order. */
  pending: BridgeOutboundFrame[];
  push(text: string): void;
  take<T extends FrameType>(type: T): Promise<FrameOf<T>>;
  /** The next pending frame that names `requestId`, in arrival order. */
  takeFor(requestId: number): Promise<BridgeOutboundFrame>;
}

interface Client extends FrameQueue {
  ws: WebSocket;
  send(frame: unknown): void;
  sendRaw(data: string | Buffer): void;
  closed: Promise<Closure>;
}

interface TcpClient extends FrameQueue {
  socket: net.Socket;
  send(frame: unknown): void;
  sendRaw(bytes: Uint8Array): void;
  /** The host sent FIN: a graceful end, as opposed to a dropped socket. */
  ended: Promise<void>;
  closed: Promise<void>;
}

function frameQueue(): FrameQueue {
  const pending: BridgeOutboundFrame[] = [];
  const waiters = new Set<() => void>();
  function takeWhere(
    label: string,
    accept: (frame: BridgeOutboundFrame) => boolean,
  ): Promise<BridgeOutboundFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`No ${label} frame; pending: ${JSON.stringify(pending)}`));
      }, WAIT_MS);
      function check(): void {
        const index = pending.findIndex(accept);
        if (index === -1) return;
        const [frame] = pending.splice(index, 1);
        clearTimeout(timer);
        waiters.delete(check);
        resolve(frame);
      }
      waiters.add(check);
      check();
    });
  }
  async function take<T extends FrameType>(type: T): Promise<FrameOf<T>> {
    const frame = await takeWhere(`"${type}"`, (candidate) => candidate.type === type);
    if (!isFrameOf(frame, type)) throw new Error("Frame type changed under the cursor");
    return frame;
  }
  return {
    pending,
    push: (text) => {
      const frame: unknown = JSON.parse(text);
      if (!isOutboundFrame(frame)) throw new Error(`Host sent a non-frame: ${text}`);
      pending.push(frame);
      for (const waiter of waiters) waiter();
    },
    take,
    takeFor: (requestId) =>
      takeWhere(`request ${requestId}`, (candidate) => namesRequest(candidate, requestId)),
  };
}

function isFrameOf<T extends FrameType>(frame: BridgeOutboundFrame, type: T): frame is FrameOf<T> {
  return frame.type === type;
}

/** The host's output is the subject under test; `toEqual` assertions check the shapes. */
function isOutboundFrame(value: unknown): value is BridgeOutboundFrame {
  return typeof value === "object" && value !== null && "type" in value;
}

function namesRequest(frame: BridgeOutboundFrame, requestId: number): boolean {
  return "requestId" in frame && frame.requestId === requestId;
}

interface ConnectOptions {
  origin?: string;
  hostHeader?: string;
  protocols?: string[];
  path?: string;
}

function wsUrl(host: BridgeHost, path = "/bridge"): string {
  return host.url.replace("/bridge", path);
}

function openSocket(host: BridgeHost, options: ConnectOptions = {}): WebSocket {
  const headers: Record<string, string> = {};
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.hostHeader !== undefined) headers.host = options.hostHeader;
  return new WebSocket(wsUrl(host, options.path), options.protocols ?? [], { headers });
}

function connect(host: BridgeHost, options: ConnectOptions = {}): Promise<Client> {
  const ws = openSocket(host, options);
  const queue = frameQueue();
  const closed = new Promise<Closure>((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
  });
  ws.on("error", () => undefined);
  ws.on("message", (data) => {
    queue.push(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  });
  const client: Client = {
    ...queue,
    ws,
    send: (frame) => ws.send(JSON.stringify(frame)),
    sendRaw: (data) => ws.send(data),
    closed,
  };
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(client));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) =>
      reject(new Error(`Upgrade refused with ${res.statusCode}`)),
    );
  });
}

function tcpPort(host: BridgeHost): number {
  if (host.tcp === null) throw new Error("The host was started without its TCP listener");
  return host.tcp.port;
}

interface TcpConnectOptions {
  /** Keep our half open after the host's FIN, like a peer that never answers the close. */
  allowHalfOpen?: boolean;
}

function connectTcp(host: BridgeHost, options: TcpConnectOptions = {}): Promise<TcpClient> {
  const socket = net.connect({
    host: "127.0.0.1",
    port: tcpPort(host),
    allowHalfOpen: options.allowHalfOpen ?? false,
  });
  const queue = frameQueue();
  const reader = new LengthPrefixedReader({ onFrame: (text) => queue.push(text) });
  socket.on("data", (chunk: Buffer) => reader.push(chunk));
  socket.on("error", () => undefined);
  const ended = new Promise<void>((resolve) => socket.once("end", () => resolve()));
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  const client: TcpClient = {
    ...queue,
    socket,
    send: (frame) => {
      socket.write(encodeLengthPrefixed(JSON.stringify(frame)));
    },
    sendRaw: (bytes) => {
      socket.write(bytes);
    },
    ended,
    closed,
  };
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(client));
    socket.once("error", reject);
  });
}

/** A hand-built prefix, for bytes the encoder refuses to produce. */
function prefixed(declaredLength: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(declaredLength);
  return Buffer.concat([prefix, payload]);
}

async function authenticateTcp(host: BridgeHost): Promise<TcpClient> {
  const client = await connectTcp(host);
  client.send({ type: "harness.hello", token: host.token });
  await client.take("harness.ready");
  return client;
}

async function openTcpSession(host: BridgeHost): Promise<TcpClient> {
  const client = await authenticateTcp(host);
  client.send({
    type: "session.open",
    scope: { origin: host.fixture.http.origin, pathPrefix: "/" },
    ttlMs: 60_000,
  });
  await client.take("session.opened");
  return client;
}

/** Re-checks a host counter on every turn of the event loop until it holds, without a sleep. */
function untilStats(
  host: BridgeHost,
  holds: (current: BridgeHost["stats"]) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + WAIT_MS;
    function check(): void {
      if (holds(host.stats)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Stats never matched: ${JSON.stringify(host.stats)}`));
        return;
      }
      setImmediate(check);
    }
    check();
  });
}

/** The HTTP status the host answers before any 101, for a handshake it refuses. */
function refusedUpgrade(host: BridgeHost, options: ConnectOptions = {}): Promise<number> {
  const ws = openSocket(host, options);
  ws.on("error", () => undefined);
  return new Promise((resolve, reject) => {
    ws.once("unexpected-response", (req, res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    ws.once("open", () => reject(new Error("Upgrade was accepted")));
  });
}

async function authenticate(host: BridgeHost, options: ConnectOptions = {}): Promise<Client> {
  const client = await connect(host, options);
  client.send({ type: "harness.hello", token: host.token });
  await client.take("harness.ready");
  return client;
}

interface SessionOptions {
  origin?: string;
  limits?: Record<string, number>;
}

async function openSession(host: BridgeHost, options: SessionOptions = {}): Promise<Client> {
  const client = await authenticate(host);
  client.send({
    type: "session.open",
    scope: { origin: options.origin ?? host.fixture.http.origin, pathPrefix: "/" },
    ttlMs: 60_000,
    ...(options.limits ? { limits: options.limits } : {}),
  });
  await client.take("session.opened");
  return client;
}

interface RequestOptions {
  requestId: number;
  method?: string;
  url: string;
  headers?: [string, string][];
  body?: { kind: "none" } | { kind: "stream"; length: number | null };
}

function requestFrame(options: RequestOptions): Record<string, unknown> {
  return {
    type: "request",
    requestId: options.requestId,
    method: options.method ?? "GET",
    url: options.url,
    headers: options.headers ?? [],
    redirect: "manual",
    body: options.body ?? { kind: "none" },
  };
}

/** Takes `body` frames until exactly `bytes` decoded bytes arrived; the core never overshoots. */
async function drainBody(client: Client, requestId: number, bytes: number): Promise<void> {
  let received = 0;
  while (received < bytes) {
    const frame = await client.take("body");
    expect(frame.requestId).toBe(requestId);
    received += Buffer.from(frame.data, "base64").byteLength;
  }
  expect(received).toBe(bytes);
}

interface FrameSender extends FrameQueue {
  send(frame: unknown): void;
}

/** Takes every frame of one request up to `end`, granting credit for each body chunk. */
async function readToEnd(client: FrameSender, requestId: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (;;) {
    const frame = await client.takeFor(requestId);
    if (frame.type === "end") return Buffer.concat(chunks);
    if (frame.type === "head" || frame.type === "uploadCredit") continue;
    if (frame.type !== "body") throw new Error(`Unexpected ${frame.type} for ${requestId}`);
    const chunk = Buffer.from(frame.data, "base64");
    chunks.push(chunk);
    client.send({ type: "grantCredit", requestId, bytes: chunk.byteLength });
  }
}

function pendingOfType(client: FrameQueue, type: FrameType): BridgeOutboundFrame[] {
  return client.pending.filter((frame) => frame.type === type);
}

function requireTls(host: BridgeHost): { origin: string; expired: string } {
  if (host.fixture.https === null || host.fixture.httpsVariants === null) {
    throw new Error("The bridge fixture always opens TLS listeners");
  }
  return { origin: host.fixture.https.origin, expired: host.fixture.httpsVariants.expired };
}

async function stats(client: Client, requestId: number): Promise<FrameOf<"harness.stats.result">> {
  client.send({ type: "harness.stats", requestId });
  return client.take("harness.stats.result");
}

interface StaticResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface StaticRequest {
  port: number;
  path: string;
  method?: string;
  hostHeader: string;
}

function fetchStatic(request: StaticRequest): Promise<StaticResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: request.port,
        path: request.path,
        method: request.method ?? "GET",
        headers: { host: request.hostHeader },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function connectionRefused(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "unknown"));
    socket.on("connect", () => {
      socket.destroy();
      reject(new Error(`Port ${port} still accepts connections`));
    });
  });
}

/** Writes raw bytes to a port and returns everything the server answered before closing. */
function rawExchange(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", () => undefined);
    socket.on("connect", () => {
      socket.write(request);
    });
    socket.once("error", reject);
  });
}

/** Writes a raw upgrade request and reports whether the server answered before closing. */
function rawUpgrade(port: number, hostHeader: string): Promise<string> {
  return rawExchange(
    port,
    `GET /__paseo/bootstrap.js HTTP/1.1\r\nHost: ${hostHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
}

/** An upgrade request the `ws` library aborts itself, before the host's callback runs. */
function abortedUpgrade(host: BridgeHost, method = "GET", key = ""): Promise<string> {
  const port = Number(new URL(host.url).port);
  const keyLine = key === "" ? "" : `Sec-WebSocket-Key: ${key}\r\n`;
  return rawExchange(
    port,
    `${method} /bridge HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${keyLine}Sec-WebSocket-Version: 13\r\n\r\n`,
  );
}

interface RawSocket {
  socket: net.Socket;
  closed: Promise<void>;
}

/** A TCP connection that sends nothing: a seat on the listener and nothing else. */
function rawSocket(port: number): Promise<RawSocket> {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve({ socket, closed }));
    socket.once("error", reject);
  });
}

/** The listener accepted the socket and dropped it before any handshake could happen. */
async function droppedUpgrade(host: BridgeHost): Promise<void> {
  const ws = openSocket(host);
  ws.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    ws.once("error", () => resolve());
    ws.once("open", () => reject(new Error("Upgrade was accepted")));
    ws.once("unexpected-response", (_req, res) =>
      reject(new Error(`Upgrade answered with ${res.statusCode}`)),
    );
  });
}

function shellHost(host: BridgeHost): string {
  return `wp-a.localhost:${host.shell.listenerPort}`;
}

describe("startBridgeHost", () => {
  it("validates its options before opening anything", () => {
    expect(() => startBridgeHost({ shell: SHELL, allowedOrigin: "not an origin" })).toThrow(
      TypeError,
    );
    expect(() => startBridgeHost({ shell: SHELL, allowedOrigin: "localhost:4173" })).toThrow(
      RangeError,
    );
    expect(() =>
      startBridgeHost({ shell: SHELL, allowedOrigin: "http://localhost:4173/" }),
    ).toThrow(RangeError);
    expect(() =>
      startBridgeHost({
        shell: SHELL,
        allowedOrigin: ALLOWED_ORIGIN,
        limits: { maxChunkBytes: BRIDGE_HARNESS_LIMITS.maxChunkBytes + 1 },
      }),
    ).toThrow(RangeError);
  });

  it("closes what it opened when a later step fails", async () => {
    const attempt = startBridgeHost({
      shell: SHELL,
      allowedOrigin: ALLOWED_ORIGIN,
      harness: { failStep: "ws" },
    });
    await expect(attempt).rejects.toBeInstanceOf(BridgeHostStartError);
    const error = await attempt.catch((caught: unknown) => caught);
    if (!(error instanceof BridgeHostStartError)) throw new Error("Expected a start error");
    expect(error.step).toBe("ws");
    // The static listener plus the fixture's http, https, three TLS variants and canary.
    expect(error.closedPorts).toHaveLength(7);
    for (const port of error.closedPorts) {
      expect(await connectionRefused(port)).toBe("ECONNREFUSED");
    }
  });

  it("describes the fixture, the shell origins and a base64url token", async () => {
    const host = await startHost();
    expect(host.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/bridge$/);
    expect(host.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(host.allowedOrigin).toBe(ALLOWED_ORIGIN);
    expect(host.fixture.http.origin).toBe(host.backend.http.origin);
    expect(host.fixture.https?.caPem).toBe(host.backend.https?.caPem);
    expect(host.fixture.httpsVariants?.expired).toBe(host.backend.httpsVariants?.expired.origin);
    expect(host.fixture.canary?.origin).toBe(host.backend.canary?.origin);
    expect(host.shell.origins).toEqual({
      a: `http://wp-a.localhost:${host.shell.listenerPort}`,
      b: `http://wp-b.localhost:${host.shell.listenerPort}`,
    });
    expect(host.stats).toEqual({
      connections: 0,
      authenticatedConnections: 0,
      sessionsOpened: 0,
      fixtureQueries: 0,
      activeSockets: 0,
      rawSockets: 0,
      truncatedFrames: 0,
    });
    expect(host.tcp).toBeNull();
  });
});

describe("upgrade", () => {
  it("refuses the wrong path, Host, Origin, version offer and subprotocol before any 101", async () => {
    const host = await startHost();
    const port = new URL(host.url).port;
    expect(await refusedUpgrade(host, { path: "/other" })).toBe(404);
    expect(await refusedUpgrade(host, { hostHeader: `wp-a.localhost:${port}` })).toBe(403);
    expect(await refusedUpgrade(host, { hostHeader: "127.0.0.1:1" })).toBe(403);
    expect(await refusedUpgrade(host, { origin: host.shell.origins.a })).toBe(403);
    expect(await refusedUpgrade(host, { origin: "http://localhost:4174" })).toBe(403);
    expect(await refusedUpgrade(host, { origin: "https://localhost:4173" })).toBe(403);
    expect(await refusedUpgrade(host, { origin: "null" })).toBe(403);
    expect(await refusedUpgrade(host, { protocols: ["other.v1"] })).toBe(403);
    expect(await refusedUpgrade(host, { protocols: [BRIDGE_SUBPROTOCOL, "other.v1"] })).toBe(403);
    expect(host.stats.connections).toBe(0);
  });

  it("accepts the allowed origin, a missing origin, localhost Host and the exact subprotocol", async () => {
    const host = await startHost();
    const port = new URL(host.url).port;
    const plain = await connect(host);
    const withOrigin = await connect(host, {
      origin: ALLOWED_ORIGIN,
      hostHeader: `localhost:${port}`,
    });
    plain.ws.close();
    withOrigin.ws.close();
    await Promise.all([plain.closed, withOrigin.closed]);
    const negotiated = await connect(host, { protocols: [BRIDGE_SUBPROTOCOL] });
    expect(negotiated.ws.protocol).toBe(BRIDGE_SUBPROTOCOL);
    negotiated.ws.close();
    await negotiated.closed;
    expect(host.stats.connections).toBe(3);
    expect(host.stats.activeSockets).toBe(0);
  });

  it("answers plain HTTP with 426 on /bridge and 404 elsewhere", async () => {
    const host = await startHost();
    const port = Number(new URL(host.url).port);
    const bridge = await fetchStatic({ port, path: "/bridge", hostHeader: `127.0.0.1:${port}` });
    expect(bridge.status).toBe(426);
    expect(bridge.body).toBe("");
    const other = await fetchStatic({
      port,
      path: "/__paseo/sw.js",
      hostHeader: `127.0.0.1:${port}`,
    });
    expect(other.status).toBe(404);
  });

  it("caps unauthenticated sockets at two and all sockets at four", async () => {
    const host = await startHost({ harness: { helloTimeoutMs: WAIT_MS } });
    const first = await connect(host);
    const second = await connect(host);
    expect(await refusedUpgrade(host)).toBe(503);
    first.send({ type: "harness.hello", token: host.token });
    await first.take("harness.ready");
    const third = await connect(host);
    third.send({ type: "harness.hello", token: host.token });
    await third.take("harness.ready");
    const fourth = await connect(host);
    expect(host.stats.activeSockets).toBe(4);
    expect(host.stats.rawSockets).toBe(4);
    await droppedUpgrade(host);
    for (const client of [first, second, third, fourth]) client.ws.close();
    await Promise.all([first.closed, second.closed, third.closed, fourth.closed]);
    expect(host.stats.sessionsOpened).toBe(0);
  });

  it("recovers from handshakes that ws aborts before the host is called back", async () => {
    const host = await startHost({ tcp: true });
    expect(await abortedUpgrade(host)).toMatch(/^HTTP\/1\.1 400 /);
    expect(await abortedUpgrade(host)).toMatch(/^HTTP\/1\.1 400 /);
    expect(await abortedUpgrade(host, "POST", "dGhlIHNhbXBsZSBub25jZQ==")).toMatch(
      /^HTTP\/1\.1 405 /,
    );
    await untilStats(host, (current) => current.rawSockets === 0);
    const ws = await authenticate(host);
    const tcp = await authenticateTcp(host);
    const extra = await authenticate(host);
    expect(host.stats).toMatchObject({
      connections: 3,
      authenticatedConnections: 3,
      activeSockets: 3,
      rawSockets: 3,
    });
    ws.ws.close();
    extra.ws.close();
    tcp.socket.end();
    await Promise.all([ws.closed, extra.closed, tcp.closed]);
  });

  it("caps raw sockets on the bridge listener and drops the idle ones at the deadline", async () => {
    const host = await startHost({ tcp: true });
    const port = Number(new URL(host.url).port);
    const idle = await Promise.all([
      rawSocket(port),
      rawSocket(port),
      rawSocket(port),
      rawSocket(port),
    ]);
    await untilStats(host, (current) => current.rawSockets === 4);
    const fifth = await rawSocket(port);
    await fifth.closed;
    const tcpDropped = await connectTcp(host);
    await tcpDropped.closed;
    expect(tcpDropped.pending).toEqual([]);
    expect(host.stats.connections).toBe(0);
    // The host, not the peers, ends the idle sockets once the hello deadline passes.
    await Promise.all(idle.map((raw) => raw.closed));
    await untilStats(host, (current) => current.rawSockets === 0);
    const client = await authenticate(host);
    client.ws.close();
    await client.closed;
  });

  it("closes a plain HTTP socket instead of keeping it alive on a seat", async () => {
    const host = await startHost();
    const port = Number(new URL(host.url).port);
    const answer = await rawExchange(
      port,
      `GET /bridge HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`,
    );
    expect(answer).toMatch(/^HTTP\/1\.1 426 /);
    expect(answer.toLowerCase()).toContain("connection: close");
    await untilStats(host, (current) => current.rawSockets === 0);
  });
});

describe("authentication", () => {
  it("closes with 1008 when no hello arrives in time", async () => {
    const host = await startHost();
    const client = await connect(host);
    expect(await client.closed).toEqual({ code: 1008, reason: "" });
    expect(host.stats.authenticatedConnections).toBe(0);
  });

  it("closes with 1008 on a wrong, short, long or malformed token and on frames before hello", async () => {
    const host = await startHost({ harness: { helloTimeoutMs: WAIT_MS } });
    const wrongToken = `${host.token.slice(0, 42)}${host.token.endsWith("A") ? "B" : "A"}`;
    const attempts: unknown[] = [
      { type: "harness.hello", token: wrongToken },
      { type: "harness.hello", token: host.token.slice(0, 42) },
      { type: "harness.hello", token: `${host.token}A` },
      { type: "harness.hello", token: `${host.token.slice(0, 42)}+` },
      { type: "harness.hello", token: host.token, extra: 1 },
      {
        type: "session.open",
        scope: { origin: host.fixture.http.origin, pathPrefix: "/" },
        ttlMs: 1000,
      },
      { type: "fixture.events" },
      { type: "fixture.release", token: "t" },
      { type: "close" },
      "not an object",
      "{not json",
    ];
    for (const attempt of attempts) {
      const client = await connect(host);
      if (typeof attempt === "string") client.sendRaw(attempt);
      else client.send(attempt);
      expect(await client.closed).toEqual({ code: 1008, reason: "" });
    }
    const binary = await connect(host);
    binary.sendRaw(Buffer.from("{}"));
    expect(await binary.closed).toEqual({ code: 1003, reason: "" });
    expect(host.stats).toMatchObject({
      authenticatedConnections: 0,
      sessionsOpened: 0,
      fixtureQueries: 0,
    });
  });

  it("answers a valid hello with harness.ready and refuses a second hello", async () => {
    const host = await startHost();
    const client = await connect(host);
    client.send({ type: "harness.hello", token: host.token });
    const ready = await client.take("harness.ready");
    expect(ready.fixture).toEqual(host.fixture);
    expect(host.stats.authenticatedConnections).toBe(1);
    client.send({ type: "harness.hello", token: host.token });
    expect(await client.closed).toEqual({ code: 1008, reason: "" });
  });

  it("frees the unauthenticated slot once a socket authenticates or closes", async () => {
    const host = await startHost({ harness: { helloTimeoutMs: WAIT_MS } });
    const first = await connect(host);
    const second = await connect(host);
    first.send({ type: "harness.hello", token: host.token });
    await first.take("harness.ready");
    const third = await connect(host);
    second.ws.close();
    await second.closed;
    const fourth = await connect(host);
    expect(await refusedUpgrade(host)).toBe(503);
    for (const client of [first, third, fourth]) client.ws.close();
    await Promise.all([first.closed, third.closed, fourth.closed]);
  });
});

describe("session", () => {
  it("refuses a scope outside the allowlist and limits above the harness", async () => {
    const host = await startHost();
    const client = await authenticate(host);
    client.send({
      type: "session.open",
      scope: { origin: "http://example.test", pathPrefix: "/" },
      ttlMs: 1000,
    });
    expect(await client.take("session.open_failed")).toEqual({
      type: "session.open_failed",
      code: "scope_not_allowlisted",
    });
    expect(host.stats.sessionsOpened).toBe(1);
    client.send({
      type: "session.open",
      scope: { origin: host.fixture.http.origin, pathPrefix: "/" },
      ttlMs: 1000,
      limits: { maxChunkBytes: BRIDGE_HARNESS_LIMITS.maxChunkBytes + 1 },
    });
    expect(await client.take("session.open_failed")).toEqual({
      type: "session.open_failed",
      code: "invalid_configuration",
    });
    expect(host.stats.sessionsOpened).toBe(1);
    client.send({
      type: "session.open",
      scope: { origin: host.fixture.http.origin, pathPrefix: "/" },
      ttlMs: 1000,
      limits: { maxChunkBytes: 8192 },
    });
    const opened = await client.take("session.opened");
    expect(opened.limits).toEqual({ ...BRIDGE_HARNESS_LIMITS, maxChunkBytes: 8192 });
    expect(host.stats.sessionsOpened).toBe(2);
    client.send({
      type: "session.open",
      scope: { origin: host.fixture.http.origin, pathPrefix: "/" },
      ttlMs: 1000,
    });
    expect(await client.closed).toEqual({ code: 1008, reason: "" });
  });

  it("rejects malformed session.open frames with 1008 before calling the core", async () => {
    const host = await startHost();
    const scope = { origin: host.fixture.http.origin, pathPrefix: "/" };
    const attempts = [
      { type: "session.open", scope, ttlMs: 0 },
      { type: "session.open", scope, ttlMs: 300_001 },
      { type: "session.open", scope, ttlMs: 1.5 },
      { type: "session.open", scope },
      { type: "session.open", scope: { origin: scope.origin }, ttlMs: 1 },
      { type: "session.open", scope, ttlMs: 1, limits: { unknown: 1 } },
      { type: "session.open", scope, ttlMs: 1, limits: { maxChunkBytes: -1 } },
      { type: "session.open", scope: { ...scope, origin: "a".repeat(2049) }, ttlMs: 1 },
    ];
    for (const attempt of attempts) {
      const client = await authenticate(host);
      client.send(attempt);
      expect(await client.closed).toEqual({ code: 1008, reason: "" });
    }
    expect(host.stats.sessionsOpened).toBe(0);
  });

  it("lowers options.limits for every session and refuses a second session.open", async () => {
    const host = await startHost({ limits: { maxConcurrentRequests: 2 } });
    const client = await openSession(host);
    client.send({
      type: "session.open",
      scope: { origin: host.fixture.http.origin, pathPrefix: "/" },
      ttlMs: 1000,
    });
    expect(await client.closed).toEqual({ code: 1008, reason: "" });
    const again = await authenticate(host);
    again.send({
      type: "session.open",
      scope: { origin: host.fixture.http.origin, pathPrefix: "/" },
      ttlMs: 1000,
      limits: { maxConcurrentRequests: 3 },
    });
    expect((await again.take("session.open_failed")).code).toBe("invalid_configuration");
  });

  it("closes the socket with 1000 after the close frame and the closed frame", async () => {
    const host = await startHost();
    const client = await openSession(host);
    client.send({ type: "close" });
    expect(await client.take("closed")).toEqual({ type: "closed", reason: "closed" });
    expect(await client.closed).toEqual({ code: 1000, reason: "" });
    const authenticatedOnly = await authenticate(host);
    authenticatedOnly.send({ type: "close" });
    expect(await authenticatedOnly.closed).toEqual({ code: 1000, reason: "" });
    expect(authenticatedOnly.pending).toEqual([]);
  });
});

describe("requests", () => {
  it("streams a plain and a TLS fixture page and records the nonce", async () => {
    const host = await startHost();
    const client = await openSession(host);
    client.send(requestFrame({ requestId: 1, url: `${host.fixture.http.origin}/?n=bridge-plain` }));
    const head = await client.take("head");
    expect(head.requestId).toBe(1);
    expect(head.head.status).toBe(200);
    expect(head.head.redirect).toBeNull();
    const body = await readToEnd(client, 1);
    expect(body.toString("utf8")).toContain("bridge-plain");
    expect(client.pending).toEqual([]);
    expect(host.backend.events.ofKind("request").map((event) => event.nonce)).toEqual([
      "bridge-plain",
    ]);

    const tlsOrigins = requireTls(host);
    const tls = await openSession(host, { origin: tlsOrigins.origin });
    tls.send(requestFrame({ requestId: 1, url: `${tlsOrigins.origin}/?n=bridge-tls` }));
    expect((await tls.take("head")).head.status).toBe(200);
    await readToEnd(tls, 1);
    const expired = await openSession(host, { origin: tlsOrigins.expired });
    expired.send(requestFrame({ requestId: 1, url: `${tlsOrigins.expired}/` }));
    expect(await expired.take("fail")).toEqual({
      type: "fail",
      requestId: 1,
      code: "tls_certificate_invalid",
    });
  });

  it("lists fixture events through the bridge with a stable cursor", async () => {
    const host = await startHost();
    const client = await openSession(host);
    client.send(requestFrame({ requestId: 1, url: `${host.fixture.http.origin}/?n=events-1` }));
    await readToEnd(client, 1);
    client.send({ type: "fixture.events", kind: "request" });
    const page = await client.take("fixture.events.result");
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ kind: "request", nonce: "events-1", path: "/" });
    expect(page.more).toBe(false);
    expect(page.dropped).toBe(0);
    expect(page.next).toBe(host.backend.events.list().length);
    client.send({ type: "fixture.events", kind: "request", after: page.next });
    const empty = await client.take("fixture.events.result");
    expect(empty.events).toEqual([]);
    expect(empty.next).toBe(page.next);
    expect(host.stats.fixtureQueries).toBe(2);
    client.send({ type: "fixture.events", kind: "nope" });
    expect(await client.closed).toEqual({ code: 1008, reason: "" });
  });

  it("keeps the form limits at the number and closes just above them", async () => {
    const host = await startHost();
    const origin = host.fixture.http.origin;
    const prefix = `${origin}/`;
    const longUrl = `${prefix}${"a".repeat(8192 - prefix.length)}`;
    const headerBudget = BRIDGE_HARNESS_LIMITS.maxRequestHeadBytes;
    const passing: RequestOptions[] = [
      { requestId: 1, url: longUrl },
      { requestId: 2, url: prefix, headers: [["x-a", "b".repeat(headerBudget - 3)]] },
      { requestId: 3, url: prefix, headers: [["a".repeat(256), ""]] },
      { requestId: 4, url: prefix, method: "OPTIONS" },
    ];
    const client = await openSession(host);
    for (const request of passing) {
      client.send(requestFrame(request));
      expect((await stats(client, request.requestId)).requestId).toBe(request.requestId);
    }
    const failing: unknown[] = [
      requestFrame({ requestId: 10, url: `${longUrl}a` }),
      requestFrame({
        requestId: 10,
        url: prefix,
        headers: [["x-a", "b".repeat(headerBudget - 2)]],
      }),
      requestFrame({ requestId: 10, url: prefix, headers: [["a".repeat(257), ""]] }),
      requestFrame({ requestId: 10, url: prefix, method: "PROPFIND" }),
      requestFrame({ requestId: 10, url: prefix, method: "GETGETGETG" }),
      { ...requestFrame({ requestId: 10, url: prefix }), redirect: "follow" },
      { ...requestFrame({ requestId: 10, url: prefix }), body: { kind: "stream" } },
      { ...requestFrame({ requestId: 10, url: prefix }), body: { kind: "stream", length: -1 } },
      { ...requestFrame({ requestId: 10, url: prefix }), extra: true },
      { ...requestFrame({ requestId: 0, url: prefix }) },
      { ...requestFrame({ requestId: 10, url: prefix }), headers: [["x", "y", "z"]] },
      { type: "body", requestId: 1, data: "" },
      { type: "body", requestId: 1, data: "abc" },
      { type: "body", requestId: 1, data: "YQ=A" },
      { type: "body", requestId: 1, data: "YR==" },
      { type: "body", requestId: 1, data: Buffer.alloc(16_385).toString("base64") },
      { type: "grantCredit", requestId: 1, bytes: 0 },
      { type: "harness.stats", requestId: 1, extra: 1 },
      { type: "fixture.release", token: "a".repeat(65) },
      { type: "fixture.release", token: "bad token" },
      { type: "unknown" },
      { type: 1 },
      [],
    ];
    for (const attempt of failing) {
      const victim = await openSession(host);
      victim.send(attempt);
      expect(await victim.closed).toEqual({ code: 1008, reason: "" });
    }
  });

  it("accepts a 64 KiB text frame and lets ws refuse one byte more", async () => {
    const host = await startHost();
    const client = await openSession(host);
    client.sendRaw(`"${"a".repeat(65_534)}"`);
    expect(await client.closed).toEqual({ code: 1008, reason: "" });
    const oversized = await openSession(host);
    oversized.sendRaw(`"${"a".repeat(65_535)}"`);
    expect((await oversized.closed).code).toBe(1009);
  });

  it("holds the response window until credit arrives, one chunk per grant", async () => {
    const host = await startHost();
    const client = await openSession(host);
    const window = BRIDGE_HARNESS_LIMITS.initialWindowBytes;
    client.send(
      requestFrame({
        requestId: 1,
        url: `${host.fixture.http.origin}/large?bytes=4194304&n=large-1`,
      }),
    );
    expect((await client.take("head")).head.status).toBe(200);
    await drainBody(client, 1, window);
    expect(await stats(client, 1)).toEqual({
      type: "harness.stats.result",
      requestId: 1,
      delivered: window,
      credited: 0,
      active: 1,
    });
    expect(pendingOfType(client, "body")).toEqual([]);
    client.send({ type: "grantCredit", requestId: 1, bytes: 16_384 });
    await drainBody(client, 1, 16_384);
    expect(await stats(client, 1)).toEqual({
      type: "harness.stats.result",
      requestId: 1,
      delivered: window + 16_384,
      credited: 16_384,
      active: 1,
    });
    expect(pendingOfType(client, "body")).toEqual([]);
    client.send({ type: "grantCredit", requestId: 1, bytes: window + 1 });
    expect(await client.take("protocol_error")).toEqual({
      type: "protocol_error",
      violation: "credit_overflow",
    });
    expect(await client.closed).toEqual({ code: 1008, reason: "" });
    await host.backend.events.waitFor("large.closed", (event) => event.nonce === "large-1");
  });

  it("uploads a body only in base64 chunks within the limits", async () => {
    const host = await startHost();
    const client = await openSession(host);
    const payload = Buffer.from("bridge upload body");
    client.send(
      requestFrame({
        requestId: 1,
        method: "POST",
        url: `${host.fixture.http.origin}/post/upload-1?n=upload-1`,
        body: { kind: "stream", length: payload.byteLength },
      }),
    );
    client.send({ type: "body", requestId: 1, data: payload.toString("base64") });
    client.send({ type: "endBody", requestId: 1 });
    expect(await client.take("uploadCredit")).toEqual({
      type: "uploadCredit",
      requestId: 1,
      bytes: payload.byteLength,
    });
    expect((await client.take("head")).head.status).toBe(200);
    await readToEnd(client, 1);
    expect(host.backend.postCount("upload-1")).toBe(1);
    client.send({ type: "body", requestId: 1, data: payload.toString("base64") });
    expect(await stats(client, 1)).toMatchObject({ delivered: 0, credited: 0, active: 0 });
    client.send({ type: "body", requestId: 7, data: payload.toString("base64") });
    expect(await client.take("protocol_error")).toEqual({
      type: "protocol_error",
      violation: "unknown_request",
    });
    expect(await client.closed).toEqual({ code: 1008, reason: "" });
  });

  it("closes with 1013 when a frame would exceed the outbound budget", async () => {
    const host = await startHost({ harness: { maxOutboundBytes: 5_120 } });
    const client = await openSession(host);
    client.send(
      requestFrame({
        requestId: 1,
        // 32 MiB cannot sit in loopback socket buffers, so the fixture sees an unfinished response.
        url: `${host.fixture.http.origin}/large?bytes=33554432&n=large-2`,
      }),
    );
    expect((await client.take("head")).head.status).toBe(200);
    expect(await client.closed).toEqual({ code: 1013, reason: "" });
    const closed = await host.backend.events.waitFor("large.closed", (e) => e.nonce === "large-2");
    expect(closed.completed).toBe(false);
  });
});

describe("replay and unknown results", () => {
  it("refuses a replayed request without touching the first one", async () => {
    const host = await startHost();
    const client = await openSession(host);
    const payload = Buffer.from("once");
    host.duplicateNextRequest();
    client.send(
      requestFrame({
        requestId: 1,
        method: "POST",
        url: `${host.fixture.http.origin}/post/replay-1?hold=1&n=replay-1`,
        body: { kind: "stream", length: payload.byteLength },
      }),
    );
    expect(await client.take("protocol_error")).toEqual({
      type: "protocol_error",
      violation: "replayed",
    });
    client.send({ type: "body", requestId: 1, data: payload.toString("base64") });
    client.send({ type: "endBody", requestId: 1 });
    await host.backend.events.waitFor("post.count", (event) => event.token === "replay-1");
    expect(pendingOfType(client, "head")).toEqual([]);
    client.send({ type: "fixture.release", token: "replay-1" });
    expect(await client.take("fixture.release.result")).toEqual({
      type: "fixture.release.result",
      token: "replay-1",
      released: 1,
    });
    expect((await client.take("head")).head.status).toBe(200);
    await readToEnd(client, 1);
    const arrivals = host.backend.events
      .ofKind("post.arrived")
      .filter((e) => e.token === "replay-1");
    expect(arrivals).toHaveLength(1);
    expect(host.backend.postCount("replay-1")).toBe(1);

    client.send(
      requestFrame({
        requestId: 2,
        method: "POST",
        url: `${host.fixture.http.origin}/post/control-1?n=control-a`,
        body: { kind: "none" },
      }),
    );
    client.send(
      requestFrame({
        requestId: 3,
        method: "POST",
        url: `${host.fixture.http.origin}/post/control-1?n=control-b`,
        body: { kind: "none" },
      }),
    );
    await readToEnd(client, 2);
    await readToEnd(client, 3);
    expect(host.backend.postCount("control-1")).toBe(2);
  });

  it("never retries a POST whose result the page could not see", async () => {
    const host = await startHost();
    const client = await openSession(host);
    client.send(
      requestFrame({
        requestId: 1,
        method: "POST",
        url: `${host.fixture.http.origin}/post/unknown-1?hold=1&n=unknown-1`,
        body: { kind: "none" },
      }),
    );
    await host.backend.events.waitFor("post.count", (event) => event.token === "unknown-1");
    client.ws.close();
    await client.closed;
    await host.backend.events.waitFor("post.abandoned", (event) => event.token === "unknown-1");
    const again = await openSession(host);
    again.send({ type: "fixture.events", kind: "request" });
    const page = await again.take("fixture.events.result");
    const posts = page.events.filter(
      (event) => event.kind === "request" && "path" in event && event.path === "/post/unknown-1",
    );
    expect(posts).toHaveLength(1);
    expect(host.backend.postCount("unknown-1")).toBe(1);
    expect(host.backend.releasePost("unknown-1")).toBe(1);
  });
});

describe("cancel", () => {
  it("emits cancelled only after the upstream socket closed", async () => {
    const host = await startHost();
    const client = await openSession(host);
    client.send(
      requestFrame({
        requestId: 1,
        url: `${host.fixture.http.origin}/slow?bytes=1048576&chunk=1024&intervalMs=5&n=slow-1`,
      }),
    );
    expect((await client.take("head")).head.status).toBe(200);
    await client.take("body");
    client.send({ type: "cancel", requestId: 1 });
    expect(await client.take("cancelled")).toEqual({
      type: "cancelled",
      requestId: 1,
      dnsPending: false,
    });
    const closed = await host.backend.events.waitFor("slow.closed", (e) => e.nonce === "slow-1");
    expect(closed.completed).toBe(false);
    // Chunks that arrived before the cancel stay pending; nothing may follow `cancelled`.
    const pendingBefore = client.pending.length;
    expect(await stats(client, 1)).toMatchObject({ active: 0 });
    expect(client.pending.length).toBe(pendingBefore);
  });

  it("reports a lookup still in flight and stays silent for a late id", async () => {
    let answer: ((addresses: ResolvedTunnelAddress[]) => void) | null = null;
    let markStarted: ((hostname: string) => void) | null = null;
    const lookupStarted = new Promise<string>((resolve) => {
      markStarted = resolve;
    });
    const host = await startHost({
      harness: {
        lookup: (hostname) => {
          markStarted?.(hostname);
          return new Promise((resolve) => {
            answer = resolve;
          });
        },
        extraAllowlistTargets: ["http://pending.test"],
      },
    });
    closers.push(async () => answer?.([{ address: "127.0.0.1", family: 4 }]));
    const client = await openSession(host, { origin: "http://pending.test" });
    client.send(requestFrame({ requestId: 1, url: "http://pending.test/" }));
    // A cancel that lands before the resolver is called leaves nothing pending, by design.
    expect(await lookupStarted).toBe("pending.test");
    client.send({ type: "cancel", requestId: 1 });
    expect(await client.take("cancelled")).toEqual({
      type: "cancelled",
      requestId: 1,
      dnsPending: true,
    });
    client.send({ type: "cancel", requestId: 1 });
    expect(await stats(client, 1)).toMatchObject({ active: 0 });
    expect(client.pending).toEqual([]);
    client.send({ type: "cancel", requestId: 2 });
    expect(await client.take("protocol_error")).toEqual({
      type: "protocol_error",
      violation: "unknown_request",
    });
    expect(await client.closed).toEqual({ code: 1008, reason: "" });
  });
});

describe("static shell listener", () => {
  it("serves the three shell paths with exact headers on the wp-a and wp-b hosts", async () => {
    const html = "<!doctype html><title>custom</title>";
    const host = await startHost({ shell: { ...SHELL, bootstrapHtml: html } });
    const port = host.shell.listenerPort;
    const page = await fetchStatic({
      port,
      path: "/__paseo/bootstrap.html",
      hostHeader: shellHost(host),
    });
    expect(page.status).toBe(200);
    expect(page.body).toBe(html);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["content-security-policy"]).toBe(`frame-ancestors ${ALLOWED_ORIGIN}`);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["content-length"]).toBe(String(Buffer.byteLength(html)));
    const bootstrap = await fetchStatic({
      port,
      path: "/__paseo/bootstrap.js?v=1",
      hostHeader: `wp-b.localhost:${port}`,
    });
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body).toBe(SHELL.bootstrapJs);
    expect(bootstrap.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(bootstrap.headers["cache-control"]).toBe("no-store");
    expect(bootstrap.headers["service-worker-allowed"]).toBeUndefined();
    const worker = await fetchStatic({ port, path: "/__paseo/sw.js", hostHeader: shellHost(host) });
    expect(worker.body).toBe(SHELL.workerJs);
    expect(worker.headers["service-worker-allowed"]).toBe("/");
    const head = await fetchStatic({
      port,
      path: "/__paseo/sw.js",
      method: "HEAD",
      hostHeader: shellHost(host),
    });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(SHELL.workerJs)));
  });

  it("serves a minimal bootstrap document when none is given", async () => {
    const host = await startHost();
    const page = await fetchStatic({
      port: host.shell.listenerPort,
      path: "/__paseo/bootstrap.html",
      hostHeader: shellHost(host),
    });
    expect(page.body).toBe(
      '<!doctype html>\n<meta charset="utf-8">\n<script type="module" src="/__paseo/bootstrap.js"></script>\n',
    );
  });

  it("refuses other paths, hosts, methods and upgrades", async () => {
    const host = await startHost();
    const port = host.shell.listenerPort;
    const hostHeader = shellHost(host);
    expect((await fetchStatic({ port, path: "/", hostHeader })).status).toBe(404);
    expect((await fetchStatic({ port, path: "/__paseo/x", hostHeader })).status).toBe(404);
    expect(
      (await fetchStatic({ port, path: "/__paseo/sw.js", hostHeader: `127.0.0.1:${port}` })).status,
    ).toBe(404);
    expect(
      (await fetchStatic({ port, path: "/__paseo/sw.js", hostHeader: "wp-a.localhost:1" })).status,
    ).toBe(404);
    const post = await fetchStatic({ port, path: "/__paseo/sw.js", method: "POST", hostHeader });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
    expect(await rawUpgrade(port, hostHeader)).toBe("");
  });
});

describe("fixture event pages", () => {
  function recordMany(recorder: FixtureRecorder, count: number, prefix: string): void {
    for (let index = 0; index < count; index += 1) {
      recorder.record({
        kind: "post.count",
        listener: "http",
        nonce: `${prefix}-${index}`,
        token: prefix,
        count: index,
      });
    }
  }

  function collect(recorder: FixtureRecorder, kind: FixtureEvent["kind"] | null): FixtureEvent[] {
    const events: Array<FixtureEvent | { truncated: true }> = [];
    let after = 0;
    let pages = 0;
    for (;;) {
      const page = pageEvents(recorder, kind, after);
      pages += 1;
      events.push(...page.events);
      if (!page.more) break;
      expect(page.next).toBeGreaterThan(after);
      after = page.next;
      if (pages > 1000) throw new Error("Cursor never finished");
    }
    return events.filter((event): event is FixtureEvent => !("truncated" in event));
  }

  it("pages past 128 events without skipping or repeating", () => {
    const recorder = new FixtureRecorder(10_000);
    recordMany(recorder, 300, "page");
    const first = pageEvents(recorder, null, 0);
    expect(first.events).toHaveLength(128);
    expect(first.next).toBe(128);
    expect(first.more).toBe(true);
    expect(collect(recorder, null)).toEqual([...recorder.list()]);
  });

  it("filters by kind, advances past skipped events and bounds the frame bytes", () => {
    const recorder = new FixtureRecorder(10_000);
    recordMany(recorder, 5, "before");
    for (let index = 0; index < 10; index += 1) {
      recorder.record({
        kind: "probe.report",
        listener: "http",
        nonce: `report-${index}`,
        report: "r".repeat(10_000),
      });
    }
    recordMany(recorder, 5, "after");
    const posts = pageEvents(recorder, "post.count", 0);
    expect(posts.events).toHaveLength(10);
    expect(posts.more).toBe(false);
    expect(posts.next).toBe(20);
    const reports = pageEvents(recorder, "probe.report", 0);
    expect(reports.events).toHaveLength(3);
    expect(reports.next).toBe(8);
    expect(reports.more).toBe(true);
    const frame = JSON.stringify({ type: "fixture.events.result", ...reports });
    expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(32_768);
    const second = pageEvents(recorder, "probe.report", reports.next);
    expect(second.events[0]).toMatchObject({ nonce: "report-3" });
    expect(collect(recorder, "probe.report").map((event) => event.nonce)).toEqual(
      Array.from({ length: 10 }, (_, index) => `report-${index}`),
    );
  });

  it("replaces an event that cannot fit on its own and keeps moving", () => {
    const recorder = new FixtureRecorder(10_000);
    recorder.record({
      kind: "probe.report",
      listener: "http",
      nonce: "huge",
      report: "x".repeat(40_000),
    });
    recordMany(recorder, 1, "tail");
    const page = pageEvents(recorder, null, 0);
    expect(page.events[0]).toEqual({
      kind: "probe.report",
      at: recorder.list()[0].at,
      listener: "http",
      nonce: "huge",
      truncated: true,
    });
    expect(page.events).toHaveLength(2);
    expect(page.next).toBe(2);
    expect(page.more).toBe(false);
  });

  it("restarts at the oldest retained event after an eviction and reports it", () => {
    const recorder = new FixtureRecorder(50);
    recordMany(recorder, 80, "evict");
    expect(recorder.dropped).toBe(30);
    const stale = pageEvents(recorder, null, 10);
    expect(stale.dropped).toBe(30);
    expect(stale.events[0]).toMatchObject({ nonce: "evict-30" });
    expect(stale.next).toBe(80);
    expect(stale.more).toBe(false);
    const beyond = pageEvents(recorder, null, 80);
    expect(beyond).toEqual({ events: [], next: 80, more: false, dropped: 30 });
    const partial = pageEvents(recorder, null, 75);
    expect(partial.events.map((event) => event.nonce)).toEqual([
      "evict-75",
      "evict-76",
      "evict-77",
      "evict-78",
      "evict-79",
    ]);
  });
});

describe("close", () => {
  it("shuts sessions, sockets, the fixture and both listeners, once", async () => {
    const host = await startHost();
    const client = await openSession(host);
    client.send(
      requestFrame({
        requestId: 1,
        url: `${host.fixture.http.origin}/sse?count=1000&intervalMs=5&n=sse-1`,
      }),
    );
    expect((await client.take("head")).head.status).toBe(200);
    const idle = await authenticate(host);
    const first = host.close();
    expect(host.close()).toBe(first);
    await first;
    expect(await client.take("closed")).toEqual({ type: "closed", reason: "closed" });
    expect(await client.closed).toEqual({ code: 1001, reason: "" });
    expect(await idle.closed).toEqual({ code: 1001, reason: "" });
    const sse = host.backend.events.ofKind("sse.closed").find((event) => event.nonce === "sse-1");
    expect(sse?.completed).toBe(false);
    const ports = [Number(new URL(host.url).port), host.shell.listenerPort, host.backend.http.port];
    for (const port of ports) expect(await connectionRefused(port)).toBe("ECONNREFUSED");
    expect(host.stats.activeSockets).toBe(0);
    await host.close();
  });
});

describe("tcp", () => {
  it("stays off by default, opens a loopback port on request and closes it on a later failure", async () => {
    const host = await startHost({ tcp: true });
    expect(tcpPort(host)).toBeGreaterThan(0);
    const attempt = startBridgeHost({
      shell: SHELL,
      allowedOrigin: ALLOWED_ORIGIN,
      tcp: true,
      harness: { failStep: "tcp" },
    });
    const error = await attempt.catch((caught: unknown) => caught);
    if (!(error instanceof BridgeHostStartError)) throw new Error("Expected a start error");
    expect(error.step).toBe("tcp");
    expect(error.closedPorts).toHaveLength(8);
    for (const port of error.closedPorts) {
      expect(await connectionRefused(port)).toBe("ECONNREFUSED");
    }
  });

  it("authenticates with the same token and streams a fixture page through the prefix", async () => {
    const host = await startHost({ tcp: true });
    const client = await connectTcp(host);
    client.send({ type: "harness.hello", token: host.token });
    const ready = await client.take("harness.ready");
    expect(ready.fixture).toEqual(host.fixture);
    expect(host.stats).toMatchObject({
      connections: 1,
      authenticatedConnections: 1,
      activeSockets: 1,
    });
    client.send({
      type: "session.open",
      scope: { origin: host.fixture.http.origin, pathPrefix: "/" },
      ttlMs: 60_000,
      limits: { maxChunkBytes: 8192 },
    });
    const opened = await client.take("session.opened");
    expect(opened.limits).toEqual({ ...BRIDGE_HARNESS_LIMITS, maxChunkBytes: 8192 });
    client.send(requestFrame({ requestId: 1, url: `${host.fixture.http.origin}/?n=tcp-1` }));
    expect((await client.take("head")).head.status).toBe(200);
    const body = await readToEnd(client, 1);
    expect(body.toString("utf8")).toContain("tcp-1");
    expect(host.backend.events.ofKind("request").map((event) => event.nonce)).toEqual(["tcp-1"]);
    expect(client.pending).toEqual([]);
  });

  it("drops the socket without a frame on a bad token, a silent peer or a bad prefix", async () => {
    const host = await startHost({ tcp: true });
    const wrongToken = `${host.token.slice(0, 42)}${host.token.endsWith("A") ? "B" : "A"}`;
    const bad = await connectTcp(host);
    bad.send({ type: "harness.hello", token: wrongToken });
    await bad.closed;
    const silent = await connectTcp(host);
    await silent.closed;
    const zero = await connectTcp(host);
    zero.sendRaw(prefixed(0));
    await zero.closed;
    const oversized = await connectTcp(host);
    oversized.sendRaw(prefixed(65_537));
    await oversized.closed;
    const text = await connectTcp(host);
    text.sendRaw(prefixed(65_536, Buffer.from(`"${"a".repeat(65_534)}"`)));
    await text.closed;
    for (const client of [bad, silent, zero, oversized, text]) expect(client.pending).toEqual([]);
    expect(host.stats).toMatchObject({
      connections: 5,
      authenticatedConnections: 0,
      sessionsOpened: 0,
      activeSockets: 0,
      truncatedFrames: 0,
    });
  });

  it("reassembles a frame written byte by byte and two frames written at once", async () => {
    const host = await startHost({ tcp: true });
    const client = await connectTcp(host);
    const hello = encodeLengthPrefixed(
      JSON.stringify({ type: "harness.hello", token: host.token }),
    );
    for (const byte of hello) client.sendRaw(Uint8Array.of(byte));
    await client.take("harness.ready");
    const open = encodeLengthPrefixed(
      JSON.stringify({
        type: "session.open",
        scope: { origin: host.fixture.http.origin, pathPrefix: "/" },
        ttlMs: 60_000,
      }),
    );
    const events = encodeLengthPrefixed(JSON.stringify({ type: "fixture.events" }));
    client.sendRaw(Buffer.concat([open, events]));
    await client.take("session.opened");
    expect(await client.take("fixture.events.result")).toMatchObject({ events: [], more: false });
    expect(host.stats.fixtureQueries).toBe(1);
  });

  it("ignores the rest of a chunk once a frame closed the connection", async () => {
    const host = await startHost({ tcp: true });
    const events = encodeLengthPrefixed(JSON.stringify({ type: "fixture.events" }));

    const graceful = await openTcpSession(host);
    graceful.sendRaw(
      Buffer.concat([encodeLengthPrefixed(JSON.stringify({ type: "close" })), events]),
    );
    expect(await graceful.take("closed")).toEqual({ type: "closed", reason: "closed" });
    await graceful.ended;
    await graceful.closed;

    const malformed = await openTcpSession(host);
    malformed.sendRaw(Buffer.concat([encodeLengthPrefixed('{"type":"nope"}'), events]));
    await malformed.closed;

    const violated = await openTcpSession(host);
    violated.sendRaw(
      Buffer.concat([
        encodeLengthPrefixed(JSON.stringify({ type: "body", requestId: 7, data: "YQ==" })),
        events,
      ]),
    );
    expect(await violated.take("protocol_error")).toEqual({
      type: "protocol_error",
      violation: "unknown_request",
    });
    await violated.closed;

    for (const client of [graceful, malformed, violated]) expect(client.pending).toEqual([]);
    expect(host.stats.fixtureQueries).toBe(0);
    expect(host.stats.activeSockets).toBe(0);
  });

  it("counts a peer that hangs up inside a frame as truncated and never acts on it", async () => {
    const host = await startHost({ tcp: true, harness: { helloTimeoutMs: WAIT_MS } });
    const hello = JSON.stringify({ type: "harness.hello", token: host.token });
    const midFrame = await connectTcp(host);
    midFrame.sendRaw(prefixed(Buffer.byteLength(hello), Buffer.from(hello).subarray(0, 10)));
    midFrame.socket.end();
    await midFrame.closed;
    await untilStats(host, (current) => current.truncatedFrames === 1);
    const midPrefix = await connectTcp(host);
    midPrefix.sendRaw(Buffer.from([0, 0]));
    midPrefix.socket.end();
    await midPrefix.closed;
    await untilStats(host, (current) => current.truncatedFrames === 2);
    const clean = await connectTcp(host);
    clean.socket.end();
    await clean.closed;
    await untilStats(host, (current) => current.activeSockets === 0);
    expect(host.stats).toMatchObject({
      truncatedFrames: 2,
      authenticatedConnections: 0,
      sessionsOpened: 0,
    });
  });

  it("shares the unauthenticated and total socket caps with the WebSocket listener", async () => {
    const host = await startHost({ tcp: true, harness: { helloTimeoutMs: WAIT_MS } });
    const wsFirst = await connect(host);
    const wsSecond = await connect(host);
    const tcpRefused = await connectTcp(host);
    await tcpRefused.closed;
    expect(tcpRefused.pending).toEqual([]);

    wsFirst.send({ type: "harness.hello", token: host.token });
    await wsFirst.take("harness.ready");
    const tcpFirst = await connectTcp(host);
    await untilStats(host, (current) => current.activeSockets === 3);
    expect(await refusedUpgrade(host)).toBe(503);

    wsSecond.send({ type: "harness.hello", token: host.token });
    await wsSecond.take("harness.ready");
    tcpFirst.send({ type: "harness.hello", token: host.token });
    await tcpFirst.take("harness.ready");
    const tcpSecond = await authenticateTcp(host);
    await untilStats(host, (current) => current.activeSockets === 4 && current.rawSockets === 4);
    await droppedUpgrade(host);
    const tcpFifth = await connectTcp(host);
    await tcpFifth.closed;
    expect(tcpFifth.pending).toEqual([]);

    tcpSecond.socket.end();
    await tcpSecond.closed;
    await untilStats(host, (current) => current.activeSockets === 3 && current.rawSockets === 3);
    const wsFourth = await connect(host);
    wsFourth.send({ type: "harness.hello", token: host.token });
    await wsFourth.take("harness.ready");

    for (const client of [wsFirst, wsSecond, wsFourth]) client.ws.close();
    tcpFirst.socket.end();
    await Promise.all([wsFirst.closed, wsSecond.closed, wsFourth.closed, tcpFirst.closed]);
    expect(host.stats.sessionsOpened).toBe(0);
  });

  it("drops a half-open peer at the close deadline and frees its seat", async () => {
    const host = await startHost({ tcp: true, harness: { closeTimeoutMs: 200 } });
    const stubborn = await connectTcp(host, { allowHalfOpen: true });
    stubborn.send({ type: "harness.hello", token: host.token });
    await stubborn.take("harness.ready");
    stubborn.send({
      type: "session.open",
      scope: { origin: host.fixture.http.origin, pathPrefix: "/" },
      ttlMs: 60_000,
    });
    await stubborn.take("session.opened");
    stubborn.send({ type: "close" });
    expect(await stubborn.take("closed")).toEqual({ type: "closed", reason: "closed" });
    await stubborn.ended;
    expect(stubborn.socket.destroyed).toBe(false);
    // Our half stays open on purpose; only the host can tell that its side is gone.
    await untilStats(host, (current) => current.activeSockets === 0 && current.rawSockets === 0);
    expect(stubborn.socket.destroyed).toBe(false);
    stubborn.socket.destroy();
    const next = await authenticateTcp(host);
    next.socket.end();
    await next.closed;

    const violator = await connectTcp(host, { allowHalfOpen: true });
    violator.send({ type: "harness.hello", token: host.token });
    await violator.take("harness.ready");
    violator.send({ type: "fixture.events", kind: "nope" });
    await violator.ended;
    await untilStats(host, (current) => current.rawSockets === 0);
    expect(violator.pending).toEqual([]);
    violator.socket.destroy();
  });

  it("ends with FIN after the closed frame and drops the socket on a violation", async () => {
    const host = await startHost({ tcp: true });
    const graceful = await openTcpSession(host);
    graceful.send({ type: "close" });
    expect(await graceful.take("closed")).toEqual({ type: "closed", reason: "closed" });
    await graceful.ended;
    await graceful.closed;
    const authenticatedOnly = await authenticateTcp(host);
    authenticatedOnly.send({ type: "close" });
    await authenticatedOnly.ended;
    await authenticatedOnly.closed;
    expect(authenticatedOnly.pending).toEqual([]);
    const violated = await openTcpSession(host);
    violated.send({ type: "grantCredit", requestId: 3, bytes: 1 });
    expect(await violated.take("protocol_error")).toEqual({
      type: "protocol_error",
      violation: "unknown_request",
    });
    await violated.closed;
    expect(violated.pending).toEqual([]);
  });

  it("drops the socket when a frame would exceed the outbound budget", async () => {
    const host = await startHost({ tcp: true, harness: { maxOutboundBytes: 5_120 } });
    const client = await openTcpSession(host);
    client.send(
      requestFrame({
        requestId: 1,
        url: `${host.fixture.http.origin}/large?bytes=33554432&n=tcp-large`,
      }),
    );
    expect((await client.take("head")).head.status).toBe(200);
    await client.closed;
    expect(pendingOfType(client, "closed")).toEqual([]);
    const closed = await host.backend.events.waitFor(
      "large.closed",
      (e) => e.nonce === "tcp-large",
    );
    expect(closed.completed).toBe(false);
  });

  it("closes TCP sessions with the host and refuses the port afterwards", async () => {
    const host = await startHost({ tcp: true });
    const client = await openTcpSession(host);
    client.send(
      requestFrame({
        requestId: 1,
        url: `${host.fixture.http.origin}/sse?count=1000&intervalMs=5&n=tcp-sse`,
      }),
    );
    expect((await client.take("head")).head.status).toBe(200);
    const port = tcpPort(host);
    await host.close();
    expect(await client.take("closed")).toEqual({ type: "closed", reason: "closed" });
    await client.ended;
    await client.closed;
    expect(await connectionRefused(port)).toBe("ECONNREFUSED");
    const sse = host.backend.events.ofKind("sse.closed").find((event) => event.nonce === "tcp-sse");
    expect(sse?.completed).toBe(false);
    expect(host.stats.activeSockets).toBe(0);
  });
});
