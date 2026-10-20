import { randomBytes, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { TunnelLookup } from "../../network-tunnel/dial-target.js";
import { parseTrustedTarget, type AllowlistStore, type TrustedAllowlist } from "../allowlist.js";
import {
  NetworkFetchOpenError,
  NetworkFetchProtocolError,
  type NetworkFetchErrorCode,
  type NetworkFetchOpenFailure,
  type NetworkFetchProtocolViolation,
} from "../errors.js";
import type {
  NetworkFetchLimits,
  NetworkFetchMethod,
  NetworkFetchRequest,
  NetworkFetchRequestBody,
  NetworkFetchResponseHead,
} from "../exchange.js";
import type { HeaderList } from "../headers.js";
import {
  DEFAULT_NETWORK_FETCH_LIMITS,
  openNetworkFetchSession,
  type NetworkFetchClosedReason,
  type NetworkFetchSession,
  type NetworkFetchSink,
  type RequestRelease,
} from "../session.js";
import {
  encodeLengthPrefixed,
  LENGTH_PREFIX_BYTES,
  LengthPrefixedError,
  LengthPrefixedReader,
  MAX_LENGTH_PREFIXED_FRAME_BYTES,
} from "./length-prefixed.js";
import type { FixtureEvent, FixtureEventKind, FixtureRecorder } from "./recorder.js";
import type { FixtureLimits } from "./routes.js";
import { startWebProxyFixture, type WebProxyFixture } from "./web-proxy-fixture.js";

/**
 * Loopback host for the L-bridge experiment: a WebSocket listener that speaks the bridge frames of
 * `adapter-contract.md` §5 in front of one `NetworkFetchSession` per connection, a static listener
 * that serves the bundled shell on the `wp-a`/`wp-b.localhost` origins, and the web proxy fixture as
 * the only reachable destination. It receives the shell as strings and never reads the app. Nothing
 * here is wired into the daemon; the Vitest command that starts it is the only caller outside tests.
 *
 * For the relay experiment (L-relay) the same frames travel over a plain TCP listener with a u32
 * length prefix, which is what the network tunnel delivers at its destination. Both listeners feed
 * one connection state machine; only the byte framing differs.
 */

export const BRIDGE_SUBPROTOCOL = "paseo-web-proxy-bridge.v1";
export const BRIDGE_MAX_PAYLOAD_BYTES = MAX_LENGTH_PREFIXED_FRAME_BYTES;
export const BRIDGE_MAX_CONNECTIONS = 4;
export const BRIDGE_MAX_UNAUTHENTICATED = 2;
export const BRIDGE_HELLO_TIMEOUT_MS = 2_000;
export const BRIDGE_MAX_OUTBOUND_BYTES = 1_048_576;
export const BRIDGE_EVENTS_PAGE_SIZE = 128;
export const BRIDGE_EVENTS_FRAME_BYTES = 32_768;
export const BRIDGE_RELEASE_WAIT_MS = 2_000;
export const BRIDGE_ALLOWLIST_ID = "bridge";
export const BRIDGE_SHELL_HOSTS = ["wp-a.localhost", "wp-b.localhost"] as const;

/** Session ceilings of the harness; `session.open.limits` and `options.limits` can only lower them. */
export const BRIDGE_HARNESS_LIMITS: NetworkFetchLimits = {
  ...DEFAULT_NETWORK_FETCH_LIMITS,
  initialWindowBytes: 65_536,
  maxChunkBytes: 16_384,
  maxConcurrentRequests: 8,
  maxRequestHeadBytes: 16_384,
  maxResponseHeadBytes: 16_384,
  maxRequestBodyBytes: 1_048_576,
  maxRedirects: 0,
};

const MAX_TTL_MS = 300_000;
const MAX_SCOPE_CHARS = 2_048;
const MAX_URL_CHARS = 8_192;
const MAX_METHOD_CHARS = 8;
const MAX_HEADER_NAME_CHARS = 256;
const MAX_HELLO_TOKEN_CHARS = 43;
const TOKEN_BYTES = 32;
const HELLO_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const POST_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const METHODS: ReadonlySet<string> = new Set<NetworkFetchMethod>([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const LIMIT_KEYS: Record<keyof NetworkFetchLimits, true> = {
  initialWindowBytes: true,
  maxChunkBytes: true,
  maxConcurrentRequests: true,
  connectTimeoutMs: true,
  maxRequestHeadBytes: true,
  maxResponseHeadBytes: true,
  responseHeadTimeoutMs: true,
  maxRequestBodyBytes: true,
  maxResponseBodyBytes: true,
  maxRedirects: true,
};
const FIXTURE_EVENT_KINDS = [
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
] as const satisfies readonly FixtureEventKind[];
type UnlistedFixtureEventKind = Exclude<FixtureEventKind, (typeof FIXTURE_EVENT_KINDS)[number]>;
// Fails to compile when the recorder gains a kind this list does not know.
const everyFixtureEventKindListed: UnlistedFixtureEventKind extends never ? true : false = true;
void everyFixtureEventKindListed;

export interface BridgeShell {
  /** ESM bundle of the shell bootstrap, served at `/__paseo/bootstrap.js`. */
  bootstrapJs: string;
  /** Service worker bundle, served at `/__paseo/sw.js` with `Service-Worker-Allowed: /`. */
  workerJs: string;
  /** Full bootstrap document; when absent the host serves a minimal one that loads the bootstrap. */
  bootstrapHtml?: string;
}

export type BridgeHostStep = "static" | "fixture" | "ws" | "tcp";

/** Knobs for `bridge-host.test.ts` only; the Vitest command never accepts or forwards them. */
export interface BridgeHostHarnessOptions {
  helloTimeoutMs?: number;
  maxOutboundBytes?: number;
  lookup?: TunnelLookup;
  /** Extra allowlist targets, for destinations that need a name lookup. */
  extraAllowlistTargets?: readonly string[];
  fixtureLimits?: Partial<FixtureLimits>;
  /** Throws at the start of that step, after the previous ones opened: proves partial cleanup. */
  failStep?: BridgeHostStep;
}

export interface StartBridgeHostOptions {
  shell: BridgeShell;
  /** Full origin of the test page; `new URL(o).origin === o`. */
  allowedOrigin: string;
  /** Lowers `BRIDGE_HARNESS_LIMITS`; a value above the harness is a usage error. */
  limits?: Partial<NetworkFetchLimits>;
  harness?: BridgeHostHarnessOptions;
  /** Also opens the length-prefixed TCP listener the tunnel can reach (L-relay). Default: off. */
  tcp?: boolean;
}

export interface BridgeTcpInfo {
  /** Loopback port; the tunnel's `Open` names it as the destination. */
  port: number;
}

export interface BridgeFixtureOrigin {
  origin: string;
}

export interface BridgeFixtureTlsInfo {
  origin: string;
  caPem: string;
  serverNames: string[];
}

export interface BridgeFixtureTlsVariants {
  wrongHost: string;
  expired: string;
  selfSigned: string;
}

/** The public part of the fixture: what `harness.ready` carries to the test page. */
export interface BridgeFixtureInfo {
  http: BridgeFixtureOrigin;
  https: BridgeFixtureTlsInfo | null;
  httpsVariants: BridgeFixtureTlsVariants | null;
  canary: BridgeFixtureOrigin | null;
}

export interface BridgeShellInfo {
  listenerPort: number;
  origins: { a: string; b: string };
}

export interface BridgeHostInfo {
  url: string;
  /** 32 random bytes, base64url; handed only to the test page by the command's return value. */
  token: string;
  allowedOrigin: string;
  fixture: BridgeFixtureInfo;
  shell: BridgeShellInfo;
  /** Node-side only until the command owner projects it; `null` when `tcp` was not requested. */
  tcp: BridgeTcpInfo | null;
}

export interface BridgeHostStats {
  /** Sockets accepted on either listener. */
  connections: number;
  authenticatedConnections: number;
  sessionsOpened: number;
  fixtureQueries: number;
  activeSockets: number;
  /** TCP peers that hung up in the middle of a frame; the partial bytes were never a frame. */
  truncatedFrames: number;
}

export interface BridgeHost extends BridgeHostInfo {
  readonly stats: BridgeHostStats;
  /** Node-side handle for the host's own tests; never serialized to the page. */
  readonly backend: WebProxyFixture;
  /** Replays the next `request` frame once, so a test can watch the core refuse it. */
  duplicateNextRequest(): void;
  close(): Promise<void>;
}

export class BridgeHostStartError extends Error {
  constructor(
    public readonly step: BridgeHostStep,
    /** Ports the earlier steps had opened; all closed again before this error is thrown. */
    public readonly closedPorts: readonly number[],
    cause: unknown,
  ) {
    super(`Bridge host could not open its ${step} step`, { cause });
    this.name = "BridgeHostStartError";
  }
}

export interface BridgeScope {
  origin: string;
  pathPrefix: string;
}

export interface BridgeRequestStats {
  requestId: number;
  delivered: number;
  credited: number;
  active: number;
}

export interface BridgeEventsPage {
  events: Array<FixtureEvent | TruncatedFixtureEvent>;
  /** Absolute position right after the last event returned; pass it back as `after`. */
  next: number;
  more: boolean;
  /** Events the recorder evicted; an `after` below it restarts at the oldest retained event. */
  dropped: number;
}

/** Stands in for an event that alone would not fit the frame, so the cursor never stalls. */
export interface TruncatedFixtureEvent {
  kind: FixtureEventKind;
  at: number;
  listener: FixtureEvent["listener"];
  nonce: string;
  truncated: true;
}

export type BridgeOutboundFrame =
  | { type: "harness.ready"; fixture: BridgeFixtureInfo }
  | { type: "session.opened"; limits: NetworkFetchLimits }
  | { type: "session.open_failed"; code: NetworkFetchOpenFailure }
  | { type: "head"; requestId: number; head: NetworkFetchResponseHead }
  | { type: "body"; requestId: number; data: string }
  | { type: "end"; requestId: number }
  | { type: "fail"; requestId: number; code: NetworkFetchErrorCode }
  | { type: "uploadCredit"; requestId: number; bytes: number }
  | { type: "cancelled"; requestId: number; dnsPending: boolean }
  | { type: "closed"; reason: NetworkFetchClosedReason }
  | { type: "protocol_error"; violation: NetworkFetchProtocolViolation }
  | ({ type: "fixture.events.result" } & BridgeEventsPage)
  | { type: "fixture.release.result"; token: string; released: number }
  | ({ type: "harness.stats.result" } & BridgeRequestStats);

type InboundFrame =
  | { type: "harness.hello"; token: string }
  | { type: "session.open"; scope: BridgeScope; ttlMs: number; limits: Partial<NetworkFetchLimits> }
  | { type: "request"; request: NetworkFetchRequest }
  | { type: "body"; requestId: number; data: Uint8Array }
  | { type: "endBody"; requestId: number }
  | { type: "cancel"; requestId: number }
  | { type: "grantCredit"; requestId: number; bytes: number }
  | { type: "close" }
  | { type: "fixture.events"; kind: FixtureEventKind | null; after: number }
  | { type: "fixture.release"; token: string }
  | { type: "harness.stats"; requestId: number };

interface FrameLimits {
  maxRequestHeadBytes: number;
  maxChunkBytes: number;
}

type ConnectionState = "upgraded" | "authenticated" | "open" | "closed";

/** WebSocket close codes the host uses; on TCP they only pick between `end()` and `destroy()`. */
type BridgeCloseCode = 1000 | 1001 | 1003 | 1008 | 1013;

interface BridgeTransportEvents {
  text(text: string): void;
  /** A binary WebSocket frame; TCP never raises it. */
  binary(): void;
  /** The length-prefixed reader refused the bytes; TCP only. */
  malformed(): void;
  /** The peer hung up with part of a frame buffered; TCP only. */
  truncated(): void;
  close(): void;
}

/** What a connection needs from its socket; the frame logic never sees `ws` or `net` directly. */
interface BridgeTransport {
  readonly kind: "ws" | "tcp";
  start(events: BridgeTransportEvents): void;
  isOpen(): boolean;
  isClosed(): boolean;
  bufferedBytes(): number;
  /** Bytes one frame adds to the outbound queue, including any framing. */
  outboundBytes(payload: string): number;
  send(payload: string): void;
  close(code: BridgeCloseCode): void;
  destroy(): void;
  readonly closed: Promise<void>;
}

interface BridgeRuntime {
  token: Buffer;
  allowlists: AllowlistStore;
  limits: NetworkFetchLimits;
  protectedPorts: ReadonlySet<number>;
  tlsCa: readonly string[] | null;
  lookup: TunnelLookup | undefined;
  helloTimeoutMs: number;
  maxOutboundBytes: number;
  fixtureInfo: BridgeFixtureInfo;
  backend: WebProxyFixture;
  counters: {
    connections: number;
    authenticated: number;
    sessionsOpened: number;
    fixtureQueries: number;
    truncatedFrames: number;
  };
  duplicateArmed: boolean;
  releaseUnauthenticated(): void;
  forget(connection: BridgeConnection): void;
}

interface BridgeConnection {
  shutdown(): Promise<void>;
}

export function startBridgeHost(options: StartBridgeHostOptions): Promise<BridgeHost> {
  if (new URL(options.allowedOrigin).origin !== options.allowedOrigin) {
    throw new RangeError("allowedOrigin must be a full origin (scheme, host, port)");
  }
  const limits = lowerLimits(BRIDGE_HARNESS_LIMITS, options.limits ?? {});
  if (limits === null) {
    throw new RangeError("limits may only lower the bridge harness limits");
  }
  return openBridgeHost(options, limits);
}

async function openBridgeHost(
  options: StartBridgeHostOptions,
  limits: NetworkFetchLimits,
): Promise<BridgeHost> {
  const harness = options.harness ?? {};
  const opened: OpenedResources = { static: null, backend: null, ws: null, tcp: null };
  const connections = new Set<BridgeConnection>();
  let closing: Promise<void> | null = null;

  function listeners(): ManagedServer[] {
    return [opened.ws, opened.tcp, opened.static].filter(
      (server): server is ManagedServer => server !== null,
    );
  }

  function closeEverything(): Promise<void> {
    closing ??= (async () => {
      const serversClosed = listeners().map(stopAccepting);
      await Promise.all([...connections].map((connection) => connection.shutdown()));
      for (const server of listeners()) {
        for (const socket of server.sockets) socket.destroy();
      }
      await opened.backend?.close();
      await Promise.all(serversClosed);
    })();
    return closing;
  }

  let step: BridgeHostStep = "static";
  try {
    failIfRequested(harness, "static");
    const staticServer = http.createServer();
    opened.static = await listen(staticServer);
    const shellInfo = describeShell(opened.static.port);
    attachStaticRoutes(staticServer, options, shellInfo);

    step = "fixture";
    failIfRequested(harness, "fixture");
    opened.backend = await startWebProxyFixture({
      tls: true,
      canary: true,
      peerOrigins: [shellInfo.origins.a, shellInfo.origins.b],
      limits: harness.fixtureLimits,
    });

    step = "ws";
    failIfRequested(harness, "ws");
    const wsServer = http.createServer();
    opened.ws = await listen(wsServer);

    if (options.tcp === true) {
      step = "tcp";
      failIfRequested(harness, "tcp");
      opened.tcp = await listen(net.createServer({ allowHalfOpen: false }));
    }
    const tcpInfo = opened.tcp === null ? null : { port: opened.tcp.port };

    const backend = opened.backend;
    const fixtureInfo = describeFixture(backend);
    const token = randomBytes(TOKEN_BYTES);
    const counters = {
      connections: 0,
      authenticated: 0,
      sessionsOpened: 0,
      fixtureQueries: 0,
      truncatedFrames: 0,
    };
    let unauthenticated = 0;
    // One answer for both listeners: the socket caps are shared, not per listener.
    function canAccept(): boolean {
      if (closing !== null) return false;
      if (connections.size >= BRIDGE_MAX_CONNECTIONS) return false;
      return unauthenticated < BRIDGE_MAX_UNAUTHENTICATED;
    }
    const runtime: BridgeRuntime = {
      token,
      allowlists: bridgeAllowlists(backend, harness.extraAllowlistTargets ?? []),
      limits,
      protectedPorts: new Set(listeners().map((server) => server.port)),
      tlsCa: backend.https ? [backend.https.caPem] : null,
      lookup: harness.lookup,
      helloTimeoutMs: harness.helloTimeoutMs ?? BRIDGE_HELLO_TIMEOUT_MS,
      maxOutboundBytes: harness.maxOutboundBytes ?? BRIDGE_MAX_OUTBOUND_BYTES,
      fixtureInfo,
      backend,
      counters,
      duplicateArmed: false,
      releaseUnauthenticated: () => {
        unauthenticated -= 1;
      },
      forget: (connection) => {
        connections.delete(connection);
      },
    };
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: BRIDGE_MAX_PAYLOAD_BYTES,
      handleProtocols: (protocols) =>
        protocols.has(BRIDGE_SUBPROTOCOL) ? BRIDGE_SUBPROTOCOL : false,
    });
    const wsPort = opened.ws.port;
    const wsHosts = new Set([`127.0.0.1:${wsPort}`, `localhost:${wsPort}`]);
    wsServer.on("request", answerPlainHttp);
    wsServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const refusal = upgradeRefusal(req, wsHosts, options.allowedOrigin);
      if (refusal !== null) {
        refuse(socket, refusal);
        return;
      }
      if (!canAccept()) {
        refuse(socket, 503);
        return;
      }
      unauthenticated += 1;
      wss.handleUpgrade(req, socket, head, (ws) => {
        counters.connections += 1;
        connections.add(attachConnection(webSocketTransport(ws), runtime));
      });
    });
    opened.tcp?.server.on("connection", (socket: Socket) => {
      // No handshake to answer on TCP: a socket past the caps is dropped before any byte is read.
      if (!canAccept()) {
        socket.destroy();
        return;
      }
      unauthenticated += 1;
      counters.connections += 1;
      connections.add(attachConnection(tcpTransport(socket), runtime));
    });

    return {
      url: `ws://127.0.0.1:${wsPort}/bridge`,
      token: token.toString("base64url"),
      allowedOrigin: options.allowedOrigin,
      fixture: fixtureInfo,
      shell: shellInfo,
      tcp: tcpInfo,
      backend,
      get stats(): BridgeHostStats {
        return {
          connections: counters.connections,
          authenticatedConnections: counters.authenticated,
          sessionsOpened: counters.sessionsOpened,
          fixtureQueries: counters.fixtureQueries,
          activeSockets: connections.size,
          truncatedFrames: counters.truncatedFrames,
        };
      },
      duplicateNextRequest: () => {
        runtime.duplicateArmed = true;
      },
      close: closeEverything,
    };
  } catch (error) {
    const ports = openedPorts(opened);
    await closeEverything();
    throw new BridgeHostStartError(step, ports, error);
  }
}

function openedPorts(opened: OpenedResources): number[] {
  const servers = [opened.static, opened.ws, opened.tcp].flatMap((server) =>
    server ? [server.port] : [],
  );
  if (opened.backend === null) return servers;
  const { http: plain, https, httpsVariants, canary } = opened.backend;
  const listeners = [
    plain,
    https,
    httpsVariants?.wrongHost,
    httpsVariants?.expired,
    httpsVariants?.selfSigned,
    canary,
  ];
  const fixture = listeners.flatMap((listener) => (listener ? [listener.port] : []));
  return [...servers, ...fixture];
}

function failIfRequested(harness: BridgeHostHarnessOptions, step: BridgeHostStep): void {
  if (harness.failStep === step) throw new Error(`Injected failure at step ${step}`);
}

interface ManagedServer {
  server: net.Server;
  port: number;
  sockets: Set<Socket>;
}

/** What `startBridgeHost` has opened so far, in opening order, so a failure can close it. */
interface OpenedResources {
  static: ManagedServer | null;
  backend: WebProxyFixture | null;
  ws: ManagedServer | null;
  tcp: ManagedServer | null;
}

async function listen(server: net.Server): Promise<ManagedServer> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Listener has no TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
  return { server, port, sockets };
}

/** Stops accepting at once; the returned promise settles when the last socket is gone. */
function stopAccepting(managed: ManagedServer): Promise<void> {
  return new Promise((resolve) => managed.server.close(() => resolve()));
}

function describeShell(port: number): BridgeShellInfo {
  return {
    listenerPort: port,
    origins: {
      a: `http://${BRIDGE_SHELL_HOSTS[0]}:${port}`,
      b: `http://${BRIDGE_SHELL_HOSTS[1]}:${port}`,
    },
  };
}

function describeFixture(backend: WebProxyFixture): BridgeFixtureInfo {
  const https = backend.https
    ? {
        origin: backend.https.origin,
        caPem: backend.https.caPem,
        serverNames: [...backend.https.serverNames],
      }
    : null;
  const httpsVariants = backend.httpsVariants
    ? {
        wrongHost: backend.httpsVariants.wrongHost.origin,
        expired: backend.httpsVariants.expired.origin,
        selfSigned: backend.httpsVariants.selfSigned.origin,
      }
    : null;
  return {
    http: { origin: backend.http.origin },
    https,
    httpsVariants,
    canary: backend.canary ? { origin: backend.canary.origin } : null,
  };
}

function bridgeAllowlists(backend: WebProxyFixture, extra: readonly string[]): AllowlistStore {
  const listeners = [
    backend.http,
    backend.https,
    backend.httpsVariants?.wrongHost,
    backend.httpsVariants?.expired,
    backend.httpsVariants?.selfSigned,
    backend.canary,
  ];
  const origins = listeners.flatMap((listener) => (listener ? [listener.origin] : []));
  const allowlist: TrustedAllowlist = {
    id: BRIDGE_ALLOWLIST_ID,
    revision: 1,
    targets: [...origins, ...extra].map((origin) =>
      parseTrustedTarget({ origin, pathPrefix: "/" }),
    ),
  };
  return { get: (id) => (id === allowlist.id ? allowlist : null) };
}

/** `null` when any value is not a safe integer within the ceiling's domain or exceeds it. */
function lowerLimits(
  ceiling: NetworkFetchLimits,
  requested: Partial<NetworkFetchLimits>,
): NetworkFetchLimits | null {
  const lowered = { ...ceiling };
  for (const key of Object.keys(requested)) {
    if (!isLimitKey(key)) return null;
    const value = requested[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0 || value > ceiling[key]) return null;
    lowered[key] = value;
  }
  return lowered;
}

function isLimitKey(key: string): key is keyof NetworkFetchLimits {
  return Object.hasOwn(LIMIT_KEYS, key);
}

interface StaticAsset {
  body: Buffer;
  headers: Record<string, string>;
}

function attachStaticRoutes(
  server: http.Server,
  options: StartBridgeHostOptions,
  shell: BridgeShellInfo,
): void {
  const html =
    options.shell.bootstrapHtml ??
    '<!doctype html>\n<meta charset="utf-8">\n<script type="module" src="/__paseo/bootstrap.js"></script>\n';
  const assets = new Map<string, StaticAsset>([
    [
      "/__paseo/bootstrap.html",
      {
        body: Buffer.from(html, "utf8"),
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `frame-ancestors ${options.allowedOrigin}`,
          "cache-control": "no-store",
        },
      },
    ],
    [
      "/__paseo/bootstrap.js",
      {
        body: Buffer.from(options.shell.bootstrapJs, "utf8"),
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      },
    ],
    [
      "/__paseo/sw.js",
      {
        body: Buffer.from(options.shell.workerJs, "utf8"),
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
          "service-worker-allowed": "/",
        },
      },
    ],
  ]);
  const hosts = new Set(BRIDGE_SHELL_HOSTS.map((host) => `${host}:${shell.listenerPort}`));
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "content-length": "0" });
      res.end();
      return;
    }
    const asset = hosts.has(req.headers.host ?? "") ? assets.get(pathOf(req)) : undefined;
    if (asset === undefined) {
      res.writeHead(404, { "content-length": "0" });
      res.end();
      return;
    }
    res.writeHead(200, { ...asset.headers, "content-length": String(asset.body.byteLength) });
    res.end(req.method === "HEAD" ? undefined : asset.body);
  });
  server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => socket.destroy());
}

function pathOf(req: IncomingMessage): string {
  const target = req.url ?? "";
  const query = target.indexOf("?");
  return query === -1 ? target : target.slice(0, query);
}

function answerPlainHttp(req: IncomingMessage, res: ServerResponse): void {
  const status = pathOf(req) === "/bridge" ? 426 : 404;
  const headers: Record<string, string> = { "content-length": "0" };
  if (status === 426) headers.upgrade = "websocket";
  res.writeHead(status, headers);
  res.end();
}

type RefusalStatus = 403 | 404 | 426 | 503;

const REFUSAL_REASONS: Record<RefusalStatus, string> = {
  403: "Forbidden",
  404: "Not Found",
  426: "Upgrade Required",
  503: "Service Unavailable",
};

function upgradeRefusal(
  req: IncomingMessage,
  hosts: ReadonlySet<string>,
  allowedOrigin: string,
): RefusalStatus | null {
  if (pathOf(req) !== "/bridge") return 404;
  if (!hosts.has(req.headers.host ?? "")) return 403;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== allowedOrigin) return 403;
  if (req.headers["sec-websocket-version"] !== "13") return 403;
  const protocols = offeredProtocols(req.headers["sec-websocket-protocol"]);
  const protocolAccepted =
    protocols.length === 0 || (protocols.length === 1 && protocols[0] === BRIDGE_SUBPROTOCOL);
  if (!protocolAccepted) return 403;
  return null;
}

function offeredProtocols(header: string | string[] | undefined): string[] {
  if (header === undefined) return [];
  const joined = Array.isArray(header) ? header.join(",") : header;
  return joined
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol.length > 0);
}

function refuse(socket: Duplex, status: RefusalStatus): void {
  socket.write(
    `HTTP/1.1 ${status} ${REFUSAL_REASONS[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function attachConnection(transport: BridgeTransport, runtime: BridgeRuntime): BridgeConnection {
  let state: ConnectionState = "upgraded";
  let session: NetworkFetchSession | null = null;
  let hostClosing = false;
  let holdsUnauthenticatedSlot = true;
  const delivered = new Map<number, number>();
  const credited = new Map<number, number>();
  let helloTimer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => terminate(1008),
    runtime.helloTimeoutMs,
  );

  const sink: NetworkFetchSink = {
    head: (requestId, head) => {
      send({ type: "head", requestId, head });
    },
    body: (requestId, chunk) => {
      const data = Buffer.from(chunk).toString("base64");
      if (send({ type: "body", requestId, data })) {
        delivered.set(requestId, (delivered.get(requestId) ?? 0) + chunk.byteLength);
      }
    },
    end: (requestId) => {
      send({ type: "end", requestId });
      forgetRequest(requestId);
    },
    fail: (requestId, failure) => {
      send({ type: "fail", requestId, code: failure.code });
      forgetRequest(requestId);
    },
    uploadCredit: (requestId, bytes) => {
      send({ type: "uploadCredit", requestId, bytes });
    },
    closed: (reason) => {
      if (state === "closed") return;
      state = "closed";
      forgetAllRequests();
      write({ type: "closed", reason });
      transport.close(hostClosing ? 1001 : 1000);
    },
  };

  transport.start({
    text: onText,
    binary: () => terminate(1003),
    malformed: () => terminate(1008),
    truncated: () => {
      runtime.counters.truncatedFrames += 1;
      terminate(1008);
    },
    close: () => {
      clearHelloTimer();
      releaseUnauthenticatedSlot();
      state = "closed";
      forgetAllRequests();
      session?.close();
      runtime.forget(connection);
    },
  });

  function clearHelloTimer(): void {
    if (helloTimer === null) return;
    clearTimeout(helloTimer);
    helloTimer = null;
  }

  /** The slot is held from the upgrade until authentication or the end of the socket, once. */
  function releaseUnauthenticatedSlot(): void {
    if (!holdsUnauthenticatedSlot) return;
    holdsUnauthenticatedSlot = false;
    runtime.releaseUnauthenticated();
  }

  function forgetRequest(requestId: number): void {
    delivered.delete(requestId);
    credited.delete(requestId);
  }

  function forgetAllRequests(): void {
    delivered.clear();
    credited.clear();
  }

  /** Closes the connection and its session; a second call is a no-op. */
  function terminate(code: 1003 | 1008 | 1013): void {
    if (state === "closed") return;
    state = "closed";
    clearHelloTimer();
    releaseUnauthenticatedSlot();
    forgetAllRequests();
    transport.close(code);
    session?.close();
  }

  function send(frame: BridgeOutboundFrame): boolean {
    if (state === "closed") return false;
    return write(frame);
  }

  function write(frame: BridgeOutboundFrame): boolean {
    if (!transport.isOpen()) return false;
    const payload = JSON.stringify(frame);
    if (transport.bufferedBytes() + transport.outboundBytes(payload) > runtime.maxOutboundBytes) {
      terminate(1013);
      return false;
    }
    transport.send(payload);
    return true;
  }

  function onText(text: string): void {
    if (state === "closed") return;
    const frame = parseFrame(text, session?.limits ?? runtime.limits);
    if (frame === null) {
      terminate(1008);
      return;
    }
    switch (frame.type) {
      case "harness.hello":
        hello(frame.token);
        return;
      case "session.open":
        openSession(frame.scope, frame.ttlMs, frame.limits);
        return;
      case "request":
        dispatchRequest(frame.request);
        return;
      case "body":
        withOpenSession((open) => open.writeBody(frame.requestId, frame.data));
        return;
      case "endBody":
        withOpenSession((open) => open.endBody(frame.requestId));
        return;
      case "cancel":
        cancel(frame.requestId);
        return;
      case "grantCredit":
        withOpenSession((open) => {
          open.grantCredit(frame.requestId, frame.bytes);
          const counted = credited.get(frame.requestId);
          // A late id is accepted silently by the core; it has no counter to keep.
          if (counted !== undefined) credited.set(frame.requestId, counted + frame.bytes);
        });
        return;
      case "close":
        closeByRequest();
        return;
      case "fixture.events":
        listEvents(frame.kind, frame.after);
        return;
      case "fixture.release":
        releasePost(frame.token);
        return;
      case "harness.stats":
        reportStats(frame.requestId);
        return;
    }
  }

  function hello(token: string): void {
    if (state !== "upgraded" || !tokenMatches(runtime.token, token)) {
      terminate(1008);
      return;
    }
    state = "authenticated";
    clearHelloTimer();
    releaseUnauthenticatedSlot();
    runtime.counters.authenticated += 1;
    send({ type: "harness.ready", fixture: runtime.fixtureInfo });
  }

  function openSession(
    scope: BridgeScope,
    ttlMs: number,
    requested: Partial<NetworkFetchLimits>,
  ): void {
    if (state !== "authenticated") {
      terminate(1008);
      return;
    }
    const limits = lowerLimits(runtime.limits, requested);
    if (limits === null) {
      send({ type: "session.open_failed", code: "invalid_configuration" });
      return;
    }
    runtime.counters.sessionsOpened += 1;
    try {
      session = openNetworkFetchSession({
        allowlists: runtime.allowlists,
        allowlistRef: { id: BRIDGE_ALLOWLIST_ID, revision: 1 },
        scope,
        ttlMs,
        limits,
        isAuthorized: () => state !== "closed" && transport.isOpen(),
        protectedLocalPorts: () => runtime.protectedPorts,
        lookup: runtime.lookup,
        tlsCa: runtime.tlsCa,
        sink,
      });
    } catch (error) {
      if (!(error instanceof NetworkFetchOpenError)) throw error;
      send({ type: "session.open_failed", code: error.code });
      return;
    }
    state = "open";
    send({ type: "session.opened", limits: session.limits });
  }

  /** Runs one session call in `open`; the core's protocol errors become frames (AD-4). */
  function withOpenSession(operation: (open: NetworkFetchSession) => void): void {
    if (state !== "open" || session === null) {
      terminate(1008);
      return;
    }
    try {
      operation(session);
    } catch (error) {
      reportProtocolError(error);
    }
  }

  function reportProtocolError(error: unknown): void {
    if (!(error instanceof NetworkFetchProtocolError)) throw error;
    send({ type: "protocol_error", violation: error.violation });
    // Only a replay leaves the first request and the session untouched; the rest ends the connection.
    if (error.violation !== "replayed") terminate(1008);
  }

  function dispatchRequest(request: NetworkFetchRequest): void {
    const replay = runtime.duplicateArmed;
    runtime.duplicateArmed = false;
    withOpenSession((open) => {
      const fresh = !delivered.has(request.requestId);
      if (fresh) {
        delivered.set(request.requestId, 0);
        credited.set(request.requestId, 0);
      }
      try {
        open.request(request);
      } catch (error) {
        if (fresh) forgetRequest(request.requestId);
        throw error;
      }
    });
    if (replay) withOpenSession((open) => open.request(request));
  }

  function cancel(requestId: number): void {
    withOpenSession((open) => {
      const release = open.cancel(requestId);
      forgetRequest(requestId);
      // `null` is a late id whose end or fail already reached the page: nothing more to say.
      if (release === null) return;
      void announceCancelled(requestId, release);
    });
  }

  /** `cancelled` follows the core's release, never the frame; after `closed` nothing follows. */
  async function announceCancelled(
    requestId: number,
    release: Promise<RequestRelease>,
  ): Promise<void> {
    const { dnsPending } = await release;
    if (state === "open") send({ type: "cancelled", requestId, dnsPending });
  }

  function closeByRequest(): void {
    if (state === "upgraded") {
      terminate(1008);
      return;
    }
    if (session !== null) {
      session.close();
      return;
    }
    state = "closed";
    transport.close(1000);
  }

  function listEvents(kind: FixtureEventKind | null, after: number): void {
    if (state === "upgraded") {
      terminate(1008);
      return;
    }
    runtime.counters.fixtureQueries += 1;
    const page = pageEvents(runtime.backend.events, kind, after);
    send({ type: "fixture.events.result", ...page });
  }

  function releasePost(token: string): void {
    if (state === "upgraded") {
      terminate(1008);
      return;
    }
    const released = runtime.backend.releasePost(token);
    send({ type: "fixture.release.result", token, released });
  }

  function reportStats(requestId: number): void {
    if (state !== "open" || session === null) {
      terminate(1008);
      return;
    }
    send({
      type: "harness.stats.result",
      requestId,
      delivered: delivered.get(requestId) ?? 0,
      credited: credited.get(requestId) ?? 0,
      active: session.activeRequests,
    });
  }

  async function shutdown(): Promise<void> {
    hostClosing = true;
    if (session !== null) {
      const open = session;
      open.close();
      await withTimeout(open.released(), BRIDGE_RELEASE_WAIT_MS);
    }
    if (state !== "closed") {
      state = "closed";
      clearHelloTimer();
      transport.close(1001);
    }
    await withTimeout(transport.closed, BRIDGE_RELEASE_WAIT_MS);
    if (!transport.isClosed()) {
      transport.destroy();
      await transport.closed;
    }
  }

  const connection: BridgeConnection = { shutdown };
  return connection;
}

function webSocketTransport(ws: WebSocket): BridgeTransport {
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  return {
    kind: "ws",
    start: (events) => {
      ws.on("message", (data, isBinary) => {
        if (isBinary) events.binary();
        else events.text(rawText(data));
      });
      ws.on("error", () => undefined);
      ws.once("close", () => events.close());
    },
    isOpen: () => ws.readyState === WebSocket.OPEN,
    isClosed: () => ws.readyState === WebSocket.CLOSED,
    bufferedBytes: () => ws.bufferedAmount,
    outboundBytes: (payload) => Buffer.byteLength(payload),
    send: (payload) => ws.send(payload),
    close: (code) => ws.close(code),
    destroy: () => ws.terminate(),
    closed,
  };
}

/**
 * The tunnel delivers plain TCP at its destination, so frames travel with the u32 prefix of
 * `length-prefixed.ts`. TCP carries no close code: a graceful end sends FIN after the last frame and
 * a violation drops the socket, which the peer can only tell apart by the missing `closed` frame.
 */
function tcpTransport(socket: Socket): BridgeTransport {
  let finished = false;
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  function finish(): void {
    finished = true;
  }
  return {
    kind: "tcp",
    start: (events) => {
      const reader = new LengthPrefixedReader({
        maxFrameBytes: BRIDGE_MAX_PAYLOAD_BYTES,
        // A frame that closed the connection must silence the rest of its chunk.
        onFrame: (text) => {
          if (!finished) events.text(text);
        },
      });
      socket.on("data", (chunk: Buffer) => {
        if (finished) return;
        try {
          reader.push(chunk);
        } catch (error) {
          if (!(error instanceof LengthPrefixedError)) throw error;
          events.malformed();
        }
      });
      socket.on("end", () => {
        if (finished || reader.buffered === 0) return;
        events.truncated();
      });
      socket.on("error", () => undefined);
      socket.once("close", () => {
        finished = true;
        events.close();
      });
    },
    isOpen: () => !finished && socket.writable,
    isClosed: () => socket.closed,
    bufferedBytes: () => socket.writableLength,
    outboundBytes: (payload) => LENGTH_PREFIX_BYTES + Buffer.byteLength(payload),
    // Every outbound frame stays under the frame ceiling by the session limits (§5.4 of the contract).
    send: (payload) => {
      socket.write(encodeLengthPrefixed(payload, BRIDGE_MAX_PAYLOAD_BYTES));
    },
    close: (code) => {
      finish();
      if (code === 1000 || code === 1001) {
        socket.end();
        return;
      }
      if (code === 1013) {
        // The queue is what overflowed; there is nothing worth flushing to a peer that stalled.
        socket.destroy();
        return;
      }
      // Let a `protocol_error` already queued reach the peer, then stop reading from it.
      socket.end(() => socket.destroy());
    },
    destroy: () => {
      finish();
      socket.destroy();
    },
    closed,
  };
}

/** Resolves when `promise` settles either way, or after `ms`; never rejects. */
async function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  const settled = promise.then(
    () => undefined,
    () => undefined,
  );
  try {
    await Promise.race([settled, expiry]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function rawText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/** Always compares 32 bytes so a malformed token costs the same as a wrong one. */
function tokenMatches(expected: Buffer, candidate: string): boolean {
  const wellFormed = HELLO_TOKEN_PATTERN.test(candidate);
  const decoded = wellFormed ? Buffer.from(candidate, "base64url") : Buffer.alloc(TOKEN_BYTES);
  const comparable = decoded.byteLength === TOKEN_BYTES ? decoded : Buffer.alloc(TOKEN_BYTES);
  const equal = timingSafeEqual(expected, comparable);
  return equal && wellFormed && decoded.byteLength === TOKEN_BYTES;
}

export function pageEvents(
  recorder: FixtureRecorder,
  kind: FixtureEventKind | null,
  after: number,
): BridgeEventsPage {
  // Both reads happen in the same tick: an eviction between them would shift every position.
  const dropped = recorder.dropped;
  const list = recorder.list();
  const envelope = Buffer.byteLength(
    JSON.stringify({
      type: "fixture.events.result",
      events: [],
      next: Number.MAX_SAFE_INTEGER,
      more: true,
      dropped: Number.MAX_SAFE_INTEGER,
    }),
  );
  const events: BridgeEventsPage["events"] = [];
  let next = Math.max(after, dropped);
  let more = false;
  let size = envelope;
  for (let index = next - dropped; index < list.length; index += 1) {
    const event = list[index];
    const position = dropped + index + 1;
    if (kind !== null && event.kind !== kind) {
      next = position;
      continue;
    }
    if (events.length >= BRIDGE_EVENTS_PAGE_SIZE) {
      more = true;
      break;
    }
    const serialized = JSON.stringify(event);
    const cost = Buffer.byteLength(serialized) + 1;
    if (size + cost <= BRIDGE_EVENTS_FRAME_BYTES) {
      events.push(event);
      size += cost;
      next = position;
      continue;
    }
    if (events.length > 0) {
      more = true;
      break;
    }
    const stub = truncate(event);
    events.push(stub);
    size += Buffer.byteLength(JSON.stringify(stub)) + 1;
    next = position;
  }
  return { events, next, more, dropped };
}

function truncate(event: FixtureEvent): TruncatedFixtureEvent {
  return {
    kind: event.kind,
    at: event.at,
    listener: event.listener,
    nonce: event.nonce,
    truncated: true,
  };
}

function parseFrame(text: string, limits: FrameLimits): InboundFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
  switch (parsed.type) {
    case "harness.hello":
      return parseHello(parsed);
    case "session.open":
      return parseSessionOpen(parsed);
    case "request":
      return parseRequest(parsed, limits.maxRequestHeadBytes);
    case "body":
      return parseBody(parsed, limits.maxChunkBytes);
    case "endBody":
    case "cancel":
    case "harness.stats":
      return parseRequestIdOnly(parsed, parsed.type);
    case "grantCredit":
      return parseGrantCredit(parsed);
    case "close":
      return hasExactKeys(parsed, ["type"]) ? { type: "close" } : null;
    case "fixture.events":
      return parseFixtureEvents(parsed);
    case "fixture.release":
      return parseFixtureRelease(parsed);
    default:
      return null;
  }
}

function parseHello(frame: Record<string, unknown>): InboundFrame | null {
  if (!hasExactKeys(frame, ["type", "token"])) return null;
  if (!isString(frame.token, MAX_HELLO_TOKEN_CHARS)) return null;
  return { type: "harness.hello", token: frame.token };
}

function parseSessionOpen(frame: Record<string, unknown>): InboundFrame | null {
  if (!hasExactKeys(frame, ["type", "scope", "ttlMs"], ["limits"])) return null;
  const scope = frame.scope;
  if (!isRecord(scope) || !hasExactKeys(scope, ["origin", "pathPrefix"])) return null;
  if (!isString(scope.origin, MAX_SCOPE_CHARS) || !isString(scope.pathPrefix, MAX_SCOPE_CHARS)) {
    return null;
  }
  if (!isInteger(frame.ttlMs, 1, MAX_TTL_MS)) return null;
  const limits = frame.limits === undefined ? {} : parseLimits(frame.limits);
  if (limits === null) return null;
  return {
    type: "session.open",
    scope: { origin: scope.origin, pathPrefix: scope.pathPrefix },
    ttlMs: frame.ttlMs,
    limits,
  };
}

/** Shape only: the ceiling comparison happens against the connection's effective limits. */
function parseLimits(value: unknown): Partial<NetworkFetchLimits> | null {
  if (!isRecord(value)) return null;
  const limits: Partial<NetworkFetchLimits> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isLimitKey(key) || !isInteger(raw, 0, Number.MAX_SAFE_INTEGER)) return null;
    limits[key] = raw;
  }
  return limits;
}

function parseRequest(frame: Record<string, unknown>, maxHeadBytes: number): InboundFrame | null {
  const keys = ["type", "requestId", "method", "url", "headers", "redirect", "body"];
  if (!hasExactKeys(frame, keys)) return null;
  if (!isInteger(frame.requestId, 1, Number.MAX_SAFE_INTEGER)) return null;
  if (!isString(frame.method, MAX_METHOD_CHARS) || !isMethod(frame.method)) return null;
  if (!isString(frame.url, MAX_URL_CHARS)) return null;
  const headers = parseHeaders(frame.headers, maxHeadBytes);
  if (headers === null) return null;
  if (frame.redirect !== "manual") return null;
  const body = parseRequestBody(frame.body);
  if (body === null) return null;
  return {
    type: "request",
    request: {
      requestId: frame.requestId,
      method: frame.method,
      url: frame.url,
      headers,
      redirect: "manual",
      body,
    },
  };
}

function isMethod(value: string): value is NetworkFetchMethod {
  return METHODS.has(value);
}

function parseHeaders(value: unknown, maxHeadBytes: number): HeaderList | null {
  if (!Array.isArray(value)) return null;
  const headers: HeaderList = [];
  let total = 0;
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [name, headerValue] = entry;
    if (!isString(name, MAX_HEADER_NAME_CHARS) || typeof headerValue !== "string") return null;
    total += name.length + headerValue.length;
    if (total > maxHeadBytes) return null;
    headers.push([name, headerValue]);
  }
  return headers;
}

function parseRequestBody(value: unknown): NetworkFetchRequestBody | null {
  if (!isRecord(value)) return null;
  if (value.kind === "none") return hasExactKeys(value, ["kind"]) ? { kind: "none" } : null;
  if (value.kind !== "stream" || !hasExactKeys(value, ["kind", "length"])) return null;
  const { length } = value;
  if (length === null) return { kind: "stream", length: null };
  if (!isInteger(length, 0, Number.MAX_SAFE_INTEGER)) return null;
  return { kind: "stream", length };
}

function parseBody(frame: Record<string, unknown>, maxChunkBytes: number): InboundFrame | null {
  if (!hasExactKeys(frame, ["type", "requestId", "data"])) return null;
  if (!isInteger(frame.requestId, 1, Number.MAX_SAFE_INTEGER)) return null;
  const { data } = frame;
  if (typeof data !== "string" || !BASE64_PATTERN.test(data) || data.length % 4 !== 0) return null;
  const decoded = Buffer.from(data, "base64");
  if (decoded.toString("base64") !== data) return null;
  if (decoded.byteLength < 1 || decoded.byteLength > maxChunkBytes) return null;
  return { type: "body", requestId: frame.requestId, data: decoded };
}

function parseRequestIdOnly(
  frame: Record<string, unknown>,
  type: "endBody" | "cancel" | "harness.stats",
): InboundFrame | null {
  if (!hasExactKeys(frame, ["type", "requestId"])) return null;
  if (!isInteger(frame.requestId, 1, Number.MAX_SAFE_INTEGER)) return null;
  return { type, requestId: frame.requestId };
}

function parseGrantCredit(frame: Record<string, unknown>): InboundFrame | null {
  if (!hasExactKeys(frame, ["type", "requestId", "bytes"])) return null;
  if (!isInteger(frame.requestId, 1, Number.MAX_SAFE_INTEGER)) return null;
  if (!isInteger(frame.bytes, 1, Number.MAX_SAFE_INTEGER)) return null;
  return { type: "grantCredit", requestId: frame.requestId, bytes: frame.bytes };
}

function parseFixtureEvents(frame: Record<string, unknown>): InboundFrame | null {
  if (!hasExactKeys(frame, ["type"], ["kind", "after"])) return null;
  const kind = frame.kind === undefined ? null : frame.kind;
  if (kind !== null && !isFixtureEventKind(kind)) return null;
  const after = frame.after === undefined ? 0 : frame.after;
  if (!isInteger(after, 0, Number.MAX_SAFE_INTEGER)) return null;
  return { type: "fixture.events", kind, after };
}

function isFixtureEventKind(value: unknown): value is FixtureEventKind {
  return typeof value === "string" && FIXTURE_EVENT_KINDS.some((kind) => kind === value);
}

function parseFixtureRelease(frame: Record<string, unknown>): InboundFrame | null {
  if (!hasExactKeys(frame, ["type", "token"])) return null;
  if (typeof frame.token !== "string" || !POST_TOKEN_PATTERN.test(frame.token)) return null;
  return { type: "fixture.release", token: frame.token };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(record);
  const allKnown = keys.every((key) => required.includes(key) || optional.includes(key));
  const allRequired = required.every((key) => Object.hasOwn(record, key));
  return allKnown && allRequired;
}

function isString(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.length <= maxChars;
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
