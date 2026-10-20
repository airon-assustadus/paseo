import http from "node:http";
import { BlockList, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type pino from "pino";
import { TunnelCloseReason } from "@getpaseo/protocol/binary-frames/index";
import { dialTarget, type TunnelDial, type TunnelLookup } from "../network-tunnel/dial-target.js";
import {
  closeReasonForError,
  normalizeAddress,
  type ResolvedTunnelAddress,
  type TunnelHost,
} from "../network-tunnel/target-policy.js";

type CloseReason = (typeof TunnelCloseReason)[keyof typeof TunnelCloseReason];

/** Addresses that reach this host's own loopback listeners, the remote-browser proxies among them. */
const LOCAL_LOOPBACK = new BlockList();
LOCAL_LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOCAL_LOOPBACK.addAddress("0.0.0.0", "ipv4");
LOCAL_LOOPBACK.addAddress("::1", "ipv6");
LOCAL_LOOPBACK.addAddress("::", "ipv6");

export function reachesLocalListener(address: ResolvedTunnelAddress): boolean {
  const normalized = normalizeAddress(address.address);
  return LOCAL_LOOPBACK.check(normalized.address, normalized.family === 4 ? "ipv4" : "ipv6");
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface EgressProxyOptions {
  logger: pino.Logger;
  maxConnections: number;
  maxHeadBytes: number;
  headTimeoutMs: number;
  connectTimeoutMs: number;
  /** Ports of every active remote-browser proxy listener; dialing one would loop. */
  deniedLocalPorts: () => ReadonlySet<number>;
  lookup?: TunnelLookup;
  dial?: TunnelDial;
  /** Refuses every target without resolving or dialing (the browser process's own traffic). */
  refuseAll?: boolean;
}

export interface EgressProxyMetrics {
  connections: number;
  refused: number;
  bytesUp: number;
  bytesDown: number;
  /** Request shapes seen, for evidence of how the browser talks to the proxy. */
  connects: number;
  plainRequests: number;
  upgrades: Record<string, number>;
}

/** Recent dial decisions, kept in memory only (never logged above debug), for evidence. */
export interface EgressDial {
  kind: "connect" | "http" | "upgrade";
  host: string;
  port: number;
  outcome: "approved" | CloseReason;
}

export interface EgressFailure {
  host: string;
  port: number;
  reason: CloseReason;
  at: number;
}

const MAX_REMEMBERED_FAILURES = 64;
const MAX_REMEMBERED_DIALS = 64;
const DOMAIN_LABEL = /^[a-zA-Z0-9_-]{1,63}$/;

function describeHost(host: string): TunnelHost | null {
  const literal = host.replace(/^\[(.*)\]$/, "$1");
  if (isIP(literal)) return { kind: "literal", address: normalizeAddress(literal) };
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (name.length === 0 || name.length > 253) return null;
  return name.split(".").every((label) => DOMAIN_LABEL.test(label))
    ? { kind: "name", hostname: host }
    : null;
}

function parseAuthority(authority: string): { host: string; port: number } | null {
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):(\d{1,5})$/.exec(authority);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1], port };
}

function statusForReason(reason: CloseReason): number {
  if (reason === TunnelCloseReason.PolicyDenied) return 403;
  if (reason === TunnelCloseReason.Timeout) return 504;
  return 502;
}

/**
 * HTTP proxy on 127.0.0.1 for one remote browser. Every connection the browser makes, loopback
 * included, arrives here: CONNECT for HTTPS and wss://, absolute-form requests for plain HTTP,
 * and an absolute-form GET with `Upgrade: websocket` when a client sends ws:// that way.
 * Each one resolves on this host, passes the tunnel's target policy and dials the approved IP.
 * No credential is required: the proxy grants nothing a local process could not reach directly.
 */
export class RemoteBrowserEgressProxy {
  private readonly server: http.Server;
  private readonly sockets = new Set<Duplex>();
  private readonly cancel = new AbortController();
  private readonly failures: EgressFailure[] = [];
  private readonly dials: EgressDial[] = [];
  private readonly servedSockets = new WeakSet<Duplex>();
  private readonly options: EgressProxyOptions;
  private listeningPort: number | null = null;
  readonly metrics: EgressProxyMetrics = {
    connections: 0,
    refused: 0,
    bytesUp: 0,
    bytesDown: 0,
    connects: 0,
    plainRequests: 0,
    upgrades: {},
  };

  constructor(options: EgressProxyOptions) {
    this.options = options;
    this.server = http.createServer({
      maxHeaderSize: options.maxHeadBytes,
      headersTimeout: options.headTimeoutMs,
      requestTimeout: 0,
    });
    this.server.maxConnections = options.maxConnections;
    this.server.on("connection", (socket: Socket) => this.track(socket));
    this.server.on("connect", (request, socket, head) => {
      void this.handleConnect(request, socket, head);
    });
    this.server.on("request", (request, response) => {
      void this.handleRequest(request, response);
    });
    this.server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });
    this.server.on("clientError", (_error, socket) => {
      socket.destroy();
    });
    this.server.on("drop", () => {
      this.metrics.refused += 1;
    });
  }

  get port(): number {
    if (this.listeningPort === null) throw new Error("Egress proxy is not listening");
    return this.listeningPort;
  }

  get openConnections(): number {
    return this.sockets.size;
  }

  get recentDials(): readonly EgressDial[] {
    return this.dials;
  }

  /** Most recent failure for a host:port, used to explain a failed main-frame load. */
  failureFor(host: string, port: number): EgressFailure | null {
    for (let index = this.failures.length - 1; index >= 0; index -= 1) {
      const failure = this.failures[index];
      if (failure.host === host && failure.port === port) return failure;
    }
    return null;
  }

  /** Most recent failure at or after `since`: a redirect's failing target is not the URL asked for. */
  latestFailureSince(since: number): EgressFailure | null {
    const last = this.failures[this.failures.length - 1];
    return last && last.at >= since ? last : null;
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        this.server.off("error", reject);
        const address = this.server.address();
        if (typeof address !== "object" || address === null) {
          reject(new Error("Egress proxy has no address"));
          return;
        }
        this.listeningPort = address.port;
        resolve(address.port);
      });
    });
  }

  async close(): Promise<void> {
    this.cancel.abort();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  private track(socket: Duplex): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  private remember(host: string, port: number, reason: CloseReason): void {
    this.failures.push({ host, port, reason, at: Date.now() });
    if (this.failures.length > MAX_REMEMBERED_FAILURES) this.failures.shift();
  }

  private recordDial(dial: EgressDial): void {
    this.dials.push(dial);
    if (this.dials.length > MAX_REMEMBERED_DIALS) this.dials.shift();
  }

  private async open(host: string, port: number, kind: EgressDial["kind"]): Promise<Socket> {
    try {
      const socket = await this.dialPolicy(host, port);
      this.recordDial({ kind, host, port, outcome: "approved" });
      return socket;
    } catch (error) {
      this.recordDial({ kind, host, port, outcome: reasonOf(error) });
      throw error;
    }
  }

  private async dialPolicy(host: string, port: number): Promise<Socket> {
    if (this.options.refuseAll) throw new EgressRefusal(TunnelCloseReason.PolicyDenied);
    const described = describeHost(host);
    if (!described) throw new EgressRefusal(TunnelCloseReason.GeneralError);
    const denied = this.options.deniedLocalPorts();
    const socket = await dialTarget({
      host: described,
      port,
      deadline: Date.now() + this.options.connectTimeoutMs,
      signal: this.cancel.signal,
      lookup: this.options.lookup,
      dial: this.options.dial,
      isDenied: (address, targetPort) => denied.has(targetPort) && reachesLocalListener(address),
    });
    this.track(socket);
    this.metrics.connections += 1;
    return socket;
  }

  private async handleConnect(
    request: http.IncomingMessage,
    client: Duplex,
    head: Buffer,
  ): Promise<void> {
    this.metrics.connects += 1;
    const target = parseAuthority(request.url ?? "");
    if (!target) {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    let upstream: Socket;
    try {
      upstream = await this.open(target.host, target.port, "connect");
    } catch (error) {
      const reason = reasonOf(error);
      this.remember(target.host, target.port, reason);
      this.options.logger.debug({ port: target.port, reason }, "Remote browser CONNECT refused");
      client.end(`HTTP/1.1 ${statusForReason(reason)} Proxy Refused\r\nConnection: close\r\n\r\n`);
      return;
    }
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) {
      this.metrics.bytesUp += head.length;
      upstream.write(head);
    }
    this.splice(client, upstream);
  }

  /** Raw byte relay with backpressure; either side closing tears down both. */
  private splice(client: Duplex, upstream: Socket): void {
    upstream.on("data", (chunk: Buffer) => {
      this.metrics.bytesDown += chunk.length;
    });
    client.on("data", (chunk: Buffer) => {
      this.metrics.bytesUp += chunk.length;
    });
    upstream.pipe(client);
    client.pipe(upstream);
    const teardown = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.once("error", teardown);
    client.once("error", teardown);
    upstream.once("close", teardown);
    client.once("close", teardown);
  }

  private async handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    response.shouldKeepAlive = false;
    // One request per client connection: a pipelined request never reaches an origin, even
    // though each one would pass the policy and header stripping on its own.
    if (this.servedSockets.has(request.socket)) {
      // Left unanswered: the first response carries Connection: close and ends the socket.
      request.resume();
      return;
    }
    this.servedSockets.add(request.socket);
    this.metrics.plainRequests += 1;
    let url: URL;
    try {
      url = new URL(request.url ?? "");
    } catch {
      response.writeHead(400, { Connection: "close" }).end();
      return;
    }
    // Plain HTTP only; HTTPS uses CONNECT and upgrades arrive through handleUpgrade.
    if (url.protocol !== "http:") {
      response.writeHead(400, { Connection: "close" }).end();
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    let socket: Socket;
    try {
      socket = await this.open(url.hostname, port, "http");
    } catch (error) {
      const reason = reasonOf(error);
      this.remember(url.hostname, port, reason);
      response.writeHead(statusForReason(reason), { Connection: "close" }).end();
      return;
    }
    // The browser aborted (navigation stopped, tab closed) while we were dialing.
    if (request.socket.destroyed) {
      socket.destroy();
      return;
    }
    const headers = forwardedHeaders(request.rawHeaders);
    headers.Connection = "close";
    const upstream = http.request({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers,
      setHost: false,
      // Without `agent`, Node uses createConnection; `agent: false` would dial host:port itself.
      createConnection: () => socket,
    });
    upstream.on("response", (upstreamResponse) => {
      const responseHeaders: string[] = [];
      for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
        const name = upstreamResponse.rawHeaders[index];
        if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
        responseHeaders.push(name, upstreamResponse.rawHeaders[index + 1]);
      }
      responseHeaders.push("Connection", "close");
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.on("data", (chunk: Buffer) => {
        this.metrics.bytesDown += chunk.length;
      });
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502, { Connection: "close" });
      response.end();
      socket.destroy();
    });
    request.on("data", (chunk: Buffer) => {
      this.metrics.bytesUp += chunk.length;
    });
    // A browser that gives up on the response must not leave the origin connection open.
    response.once("close", () => {
      if (response.writableFinished) return;
      upstream.destroy();
      socket.destroy();
    });
    request.pipe(upstream);
  }

  private async handleUpgrade(
    request: http.IncomingMessage,
    client: Duplex,
    head: Buffer,
  ): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url ?? "");
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    this.metrics.upgrades[url.protocol] = (this.metrics.upgrades[url.protocol] ?? 0) + 1;
    // Absolute form with either scheme spelling; the origin is plain TCP in both cases.
    const plainScheme = url.protocol === "http:" || url.protocol === "ws:";
    if (!plainScheme || request.headers.upgrade?.toLowerCase() !== "websocket") {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    let upstream: Socket;
    try {
      upstream = await this.open(url.hostname, port, "upgrade");
    } catch (error) {
      const reason = reasonOf(error);
      this.remember(url.hostname, port, reason);
      client.end(`HTTP/1.1 ${statusForReason(reason)} Proxy Refused\r\nConnection: close\r\n\r\n`);
      return;
    }
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    // Origin-form request line; proxy headers stripped, the WebSocket handshake headers kept.
    const lines = [`GET ${url.pathname}${url.search} HTTP/1.1`];
    const headers = forwardedHeaders(request.rawHeaders);
    for (const [name, value] of Object.entries(headers)) {
      for (const item of [value].flat()) lines.push(`${name}: ${String(item)}`);
    }
    lines.push("Connection: Upgrade", "Upgrade: websocket");
    const handshake = Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
    this.metrics.bytesUp += handshake.length + head.length;
    upstream.write(handshake);
    if (head.length > 0) upstream.write(head);
    this.splice(client, upstream);
  }
}

function forwardedHeaders(rawHeaders: readonly string[]): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    const existing = headers[name];
    const value = rawHeaders[index + 1];
    headers[name] = existing === undefined ? value : [...[existing].flat().map(String), value];
  }
  return headers;
}

class EgressRefusal extends Error {
  constructor(readonly reason: CloseReason) {
    super("Egress target refused");
    this.name = "EgressRefusal";
  }
}

function reasonOf(error: unknown): CloseReason {
  return error instanceof EgressRefusal ? error.reason : closeReasonForError(error);
}
