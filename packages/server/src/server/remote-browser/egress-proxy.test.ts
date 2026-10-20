/* eslint-disable max-nested-callbacks */
import http from "node:http";
import net from "node:net";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { RemoteBrowserEgressProxy } from "./egress-proxy.js";
import type { ResolvedTunnelAddress } from "../network-tunnel/target-policy.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        if ("closeAllConnections" in server) (server as http.Server).closeAllConnections();
      }),
  );
  return (server.address() as net.AddressInfo).port;
}

async function startProxy(
  options: {
    lookup?: (host: string) => Promise<ResolvedTunnelAddress[]>;
    maxConnections?: number;
  } = {},
) {
  const deniedPorts = new Set<number>();
  const proxy = new RemoteBrowserEgressProxy({
    logger: pino({ level: "silent" }),
    maxConnections: options.maxConnections ?? 16,
    maxHeadBytes: 16 * 1024,
    headTimeoutMs: 2000,
    connectTimeoutMs: 2000,
    deniedLocalPorts: () => deniedPorts,
    ...(options.lookup ? { lookup: options.lookup } : {}),
  });
  const port = await proxy.listen();
  deniedPorts.add(port);
  closers.push(() => proxy.close());
  return { proxy, port, deniedPorts };
}

/** Sends a raw request to the proxy and collects everything until the proxy closes. */
function rawExchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
    });
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
    socket.write(payload);
  });
}

function connectThrough(
  port: number,
  authority: string,
): Promise<{ status: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      resolve({ status: head.slice(0, head.indexOf("\r\n")), socket });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

describe("RemoteBrowserEgressProxy", () => {
  it("tunnels CONNECT to an approved loopback service and counts bytes", async () => {
    const echo = net.createServer((socket) => socket.pipe(socket));
    const echoPort = await listen(echo);
    const { proxy, port } = await startProxy();
    const { status, socket } = await connectThrough(port, `127.0.0.1:${echoPort}`);
    expect(status).toBe("HTTP/1.1 200 Connection Established");
    const echoed = await new Promise<string>((resolve) => {
      socket.once("data", (chunk) => resolve(chunk.toString()));
      socket.write("ping");
    });
    expect(echoed).toBe("ping");
    socket.destroy();
    expect(proxy.metrics.connections).toBe(1);
    expect(proxy.metrics.bytesUp).toBeGreaterThanOrEqual(4);
  });

  it.each([
    ["cloud metadata", "169.254.169.254:80"],
    ["link-local IPv6", "[fe80::1]:80"],
    ["IPv4-mapped metadata", "[::ffff:169.254.169.254]:80"],
    ["NAT64 metadata", "[64:ff9b::a9fe:a9fe]:80"],
  ])("refuses %s with 403 and records the reason", async (_name, authority) => {
    const { proxy, port } = await startProxy();
    const { status, socket } = await connectThrough(port, authority);
    socket.destroy();
    expect(status).toMatch(/^HTTP\/1\.1 403/);
    expect(proxy.metrics.connections).toBe(0);
    const host = authority.slice(0, authority.lastIndexOf(":"));
    expect(proxy.failureFor(host, 80)?.reason).toBe(2);
  });

  it("refuses names whose answers include a denied address (no rebinding)", async () => {
    const answers: ResolvedTunnelAddress[][] = [
      [
        { address: "127.0.0.1", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    ];
    const { port } = await startProxy({ lookup: async () => answers.shift() ?? [] });
    const { status, socket } = await connectThrough(port, "rebind.example:80");
    socket.destroy();
    expect(status).toMatch(/^HTTP\/1\.1 403/);
  });

  it("refuses every active remote-browser proxy listener as a target", async () => {
    const { port, deniedPorts } = await startProxy();
    const other = net.createServer();
    const otherPort = await listen(other);
    deniedPorts.add(otherPort);
    for (const authority of [
      `127.0.0.1:${port}`,
      `localhost:${otherPort}`,
      `[::ffff:127.0.0.1]:${port}`,
      `0.0.0.0:${otherPort}`,
    ]) {
      const { status, socket } = await connectThrough(port, authority);
      socket.destroy();
      expect(status).toMatch(/^HTTP\/1\.1 403/);
    }
  });

  it("forwards plain HTTP without proxy headers and closes after one response", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const origin = http.createServer((request, response) => {
      seen.push(request.headers);
      response.writeHead(200, { "Content-Type": "text/plain", "Keep-Alive": "timeout=5" });
      response.end(`hello ${request.url}`);
    });
    const originPort = await listen(origin);
    const { port } = await startProxy();
    const reply = await rawExchange(
      port,
      `GET http://127.0.0.1:${originPort}/a?b=1 HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nProxy-Authorization: Basic c2VjcmV0\r\nProxy-Connection: keep-alive\r\nX-Kept: yes\r\n\r\n` +
        `GET http://127.0.0.1:${originPort}/second HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Basic c2VjcmV0\r\n\r\n`,
    );
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
    expect(reply).toContain("hello /a?b=1");
    expect(reply).not.toContain("/second");
    expect(reply.toLowerCase()).toContain("connection: close");
    expect(reply.toLowerCase()).not.toContain("keep-alive: timeout");
    expect(seen).toHaveLength(1);
    expect(seen[0]["proxy-authorization"]).toBeUndefined();
    expect(seen[0]["proxy-connection"]).toBeUndefined();
    expect(seen[0]["x-kept"]).toBe("yes");
  });

  it("does not forward a request that follows a 1xx on the same connection", async () => {
    const seen: string[] = [];
    const origin = http.createServer((request, response) => {
      seen.push(request.url ?? "");
      response.writeEarlyHints({ link: "</style.css>; rel=preload" });
      response.end("done");
    });
    const originPort = await listen(origin);
    const { port } = await startProxy();
    const reply = await rawExchange(
      port,
      `GET http://127.0.0.1:${originPort}/first HTTP/1.1\r\nHost: a\r\n\r\nGET http://127.0.0.1:${originPort}/smuggled HTTP/1.1\r\nHost: a\r\nProxy-Authorization: Basic eA==\r\n\r\n`,
    );
    expect(reply).toContain("done");
    expect(seen).toEqual(["/first"]);
  });

  it.each([
    ["https in absolute form", "GET https://127.0.0.1/ HTTP/1.1\r\nHost: x\r\n\r\n"],
    [
      "a non-WebSocket upgrade",
      "GET http://127.0.0.1:1/ HTTP/1.1\r\nHost: x\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\n",
    ],
    ["origin-form requests", "GET / HTTP/1.1\r\nHost: x\r\n\r\n"],
    ["a malformed CONNECT authority", "CONNECT nohost HTTP/1.1\r\nHost: x\r\n\r\n"],
  ])("rejects %s", async (_name, payload) => {
    const { proxy, port } = await startProxy();
    const reply = await rawExchange(port, payload);
    expect(reply).toMatch(/^HTTP\/1\.1 400/);
    expect(proxy.metrics.connections).toBe(0);
  });

  it("rejects oversized request heads", async () => {
    const { port } = await startProxy();
    const reply = await rawExchange(
      port,
      `GET http://127.0.0.1:1/ HTTP/1.1\r\nHost: x\r\nX-Big: ${"a".repeat(32 * 1024)}\r\n\r\n`,
    );
    expect(reply).toMatch(/^HTTP\/1\.1 431|^$/);
  });

  it("caps concurrent client connections and destroys everything on close", async () => {
    const echo = net.createServer((socket) => socket.pipe(socket));
    const echoPort = await listen(echo);
    const { proxy, port } = await startProxy({ maxConnections: 1 });
    const first = await connectThrough(port, `127.0.0.1:${echoPort}`);
    const refused = await rawExchange(port, `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\n\r\n`);
    expect(refused).toBe("");
    expect(proxy.metrics.refused).toBeGreaterThanOrEqual(1);
    const closed = new Promise<void>((resolve) => first.socket.once("close", () => resolve()));
    await proxy.close();
    await closed;
    expect(proxy.openConnections).toBe(0);
  });

  it("relays ws:// sent as an absolute-form GET Upgrade, without proxy headers", async () => {
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    const seenHeaders: http.IncomingHttpHeaders[] = [];
    wss.on("connection", (socket, request) => {
      seenHeaders.push(request.headers);
      socket.on("message", (data) => socket.send(`echo:${data.toString()}`));
    });
    const originPort = await listen(httpServer);
    closers.push(async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
    });
    const { proxy, port } = await startProxy();
    // Absolute-form GET with Upgrade; the real-Chromium E2E records which form Chromium uses.
    const socket = net.connect(port, "127.0.0.1");
    let received = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
    });
    socket.write(
      `GET http://127.0.0.1:${originPort}/chat?x=1 HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nProxy-Authorization: Basic c2VjcmV0\r\n\r\n`,
    );
    await vi.waitFor(() => expect(received.toString("latin1")).toContain("\r\n\r\n"));
    expect(received.toString("latin1")).toMatch(/^HTTP\/1\.1 101/);
    const headEnd = received.indexOf("\r\n\r\n") + 4;
    received = received.subarray(headEnd);
    const mask = [1, 2, 3, 4];
    const payload = Buffer.from("hi");
    socket.write(
      Buffer.from([
        0x81,
        0x80 | payload.length,
        ...mask,
        ...payload.map((byte, index) => byte ^ mask[index % 4]),
      ]),
    );
    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(2 + "echo:hi".length));
    const echoed = received.subarray(2, 2 + received[1]).toString();
    socket.destroy();
    expect(echoed).toBe("echo:hi");
    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0]["proxy-authorization"]).toBeUndefined();
    expect(proxy.metrics.connections).toBe(1);
  });

  it("refuses a WebSocket upgrade to a denied target", async () => {
    const { port } = await startProxy();
    const reply = await rawExchange(
      port,
      "GET http://169.254.169.254/ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    expect(reply).toMatch(/^HTTP\/1\.1 403/);
  });

  it("tears down the origin connection when the browser aborts a pending response", async () => {
    const pending: http.ServerResponse[] = [];
    const origin = http.createServer((_request, response) => {
      pending.push(response);
    });
    const originPort = await listen(origin);
    const originSockets = new Set<net.Socket>();
    origin.on("connection", (socket) => {
      originSockets.add(socket);
      socket.on("close", () => originSockets.delete(socket));
    });
    const { proxy, port } = await startProxy();
    const client = net.connect(port, "127.0.0.1");
    client.write(`GET http://127.0.0.1:${originPort}/slow HTTP/1.1\r\nHost: a\r\n\r\n`);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(proxy.openConnections).toBe(2);
    client.destroy();
    await vi.waitFor(() => {
      expect(proxy.openConnections).toBe(0);
      expect(originSockets.size).toBe(0);
    });
  });
});
