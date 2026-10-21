import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startWsTap, type WsTap } from "./ws-tap.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

async function echoServer(): Promise<{ port: number; paths: string[] }> {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const paths: string[] = [];
  wss.on("connection", (socket, request) => {
    paths.push(request.url ?? "");
    socket.send(JSON.stringify({ type: "e2ee_ready", publicKey: "pk" }));
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, paths };
}

async function tapFor(
  port: number,
  options: { maxBytesPerDirection?: number; captureClosures?: boolean } = {},
): Promise<WsTap> {
  const tap = await startWsTap({ targetPort: port, ...options });
  closers.push(() => tap.close());
  return tap;
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve) =>
    socket.once("message", (data, isBinary) =>
      resolve({ data: Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), isBinary }),
    ),
  );
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function socketClosed(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

describe("ws tap", () => {
  it("records the original peer close before forwarding, without reason or duplicate cleanup", async () => {
    const target = await echoServer();
    const tap = await tapFor(target.port, { captureClosures: true });
    const socket = await connect(`ws://127.0.0.1:${tap.port}/`);
    const closeResult = closed(socket);
    socket.close(4001, "sentinel-private-reason");
    await closeResult;
    await vi.waitFor(() => expect(tap.closures().events).toHaveLength(1));
    expect(tap.closures().events[0]).toMatchObject({
      connection: 1,
      source: "downstream",
      originalCode: 4001,
      forwardedCode: 4001,
    });
    const snapshot = tap.closures();
    expect(JSON.stringify(snapshot)).not.toContain("sentinel");
    snapshot.events[0]!.originalCode = 999;
    expect(tap.closures().events[0]!.originalCode).toBe(4001);
    await tap.close();
    expect(tap.closures().events).toHaveLength(1);
  });

  it("keeps abnormal peer closure distinct from a local stop", async () => {
    const target = await echoServer();
    const tap = await tapFor(target.port, { captureClosures: true });
    const socket = await connect(`ws://127.0.0.1:${tap.port}/`);
    const closeResult = closed(socket);
    socket.terminate();
    await closeResult;
    await vi.waitFor(() => expect(tap.closures().events).toHaveLength(1));
    expect(tap.closures().events[0]).toMatchObject({
      source: "downstream",
      originalCode: 1006,
      forwardedCode: 1000,
    });
    const second = await connect(`ws://127.0.0.1:${tap.port}/`);
    const secondClosed = closed(second);
    await tap.close();
    await secondClosed;
    expect(tap.closures().events[1]).toMatchObject({
      connection: 2,
      source: "tap_stop",
      originalCode: null,
      forwardedCode: null,
    });
  });

  it("forwards both directions with path and opcode, classifies the handshake, and reports only counts", async () => {
    const target = await echoServer();
    const tap = await tapFor(target.port);
    expect(tap.closures()).toEqual({ enabled: false, dropped: 0, events: [] });
    const socket = await connect(`ws://127.0.0.1:${tap.port}/relay?serverId=abc&role=client`);
    closers.push(async () => socket.terminate());

    const ready = await nextMessage(socket);
    expect(JSON.parse(ready.data.toString("utf8"))).toMatchObject({ type: "e2ee_ready" });
    socket.send(JSON.stringify({ type: "e2ee_hello", publicKey: "client" }));
    expect((await nextMessage(socket)).isBinary).toBe(false);
    socket.send(Buffer.from("opaque-ciphertext-nonce-123"), { binary: true });
    const echoed = await nextMessage(socket);
    expect(echoed.isBinary).toBe(true);
    expect(echoed.data.toString("utf8")).toBe("opaque-ciphertext-nonce-123");

    expect(target.paths).toEqual(["/relay?serverId=abc&role=client"]);
    expect(tap.messages().map((m) => [m.direction, m.opcode, m.plaintextHandshake])).toEqual([
      ["fromTarget", "text", "e2ee_ready"],
      ["toTarget", "text", "e2ee_hello"],
      ["fromTarget", "text", "e2ee_hello"],
      ["toTarget", "binary", null],
      ["fromTarget", "binary", null],
    ]);
    expect(tap.contains("nonce-123")).toEqual({ toTarget: true, fromTarget: true });
    expect(tap.contains("never-sent")).toEqual({ toTarget: false, fromTarget: false });
    const summary = tap.summary();
    expect(summary.connections).toBe(1);
    expect(summary.overflow).toBeNull();
    expect(summary.bytes.toTarget).toBe(
      Buffer.byteLength(JSON.stringify({ type: "e2ee_hello", publicKey: "client" })) + 27,
    );
    expect(summary.sha256.toTarget).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(summary)).not.toContain("nonce-123");
  });

  it("fails loudly instead of truncating when a direction exceeds its cap", async () => {
    const target = await echoServer();
    const tap = await tapFor(target.port, { maxBytesPerDirection: 100 });
    const socket = await connect(`ws://127.0.0.1:${tap.port}/relay`);
    closers.push(async () => socket.terminate());
    await nextMessage(socket);
    socket.send(Buffer.alloc(60, 1), { binary: true });
    await nextMessage(socket);
    const closing = closed(socket);
    socket.send(Buffer.alloc(60, 2), { binary: true });

    expect(await closing).toBe(1009);
    expect(tap.summary().overflow).toEqual({ direction: "toTarget", limit: 100 });
    expect(tap.summary().bytes.toTarget).toBe(60);
  });

  it("records an overflow when a single message is refused before it is delivered (RT-1)", async () => {
    const target = await echoServer();
    const tap = await tapFor(target.port, { maxBytesPerDirection: 100 });
    const socket = await connect(`ws://127.0.0.1:${tap.port}/relay`);
    closers.push(async () => socket.terminate());
    await nextMessage(socket);
    const closing = closed(socket);
    socket.send(Buffer.alloc(150, 3), { binary: true });

    expect(await closing).toBe(1009);
    expect(tap.summary().overflow).toEqual({ direction: "toTarget", limit: 100 });
    expect(tap.summary().bytes.toTarget).toBe(0);
    expect(tap.summary().openPairs).toBe(0);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["fraction", 10.5],
  ])("refuses a %s cap before listening (RT-1)", async (_name, cap) => {
    await expect(startWsTap({ targetPort: 9, maxBytesPerDirection: cap })).rejects.toThrow(
      RangeError,
    );
    await expect(startWsTap({ targetPort: 9, maxMessages: cap })).rejects.toThrow(RangeError);
  });

  it("aborts a connecting upstream and drops the queue when the downstream leaves first (RT-2)", async () => {
    let markHeld: (socket: net.Socket) => void = () => undefined;
    const held = new Promise<net.Socket>((resolve) => {
      markHeld = resolve;
    });
    // Accepts TCP, discards what arrives and never answers the WebSocket handshake, so the
    // upstream stays CONNECTING; reading is what lets the peer's FIN surface as `close`.
    const silent = net.createServer((socket) => {
      socket.resume();
      markHeld(socket);
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    closers.push(() => closeServer(silent));
    const tap = await tapFor((silent.address() as AddressInfo).port);
    const socket = await connect(`ws://127.0.0.1:${tap.port}/relay`);
    socket.send(Buffer.from("queued-before-upstream-open"), { binary: true });
    const upstreamSocket = await held;
    const upstreamClosed = socketClosed(upstreamSocket);
    expect(tap.summary().openPairs).toBe(1);

    socket.close(1000, "leaving");
    await upstreamClosed;

    expect(tap.summary().openPairs).toBe(0);
    expect(tap.summary().messages).toBe(1);
    expect(tap.contains("queued-before-upstream-open").toTarget).toBe(true);
    expect(upstreamSocket.destroyed).toBe(true);
  });

  it("closes its listener and pairs on close", async () => {
    const target = await echoServer();
    const tap = await startWsTap({ targetPort: target.port });
    const socket = await connect(`ws://127.0.0.1:${tap.port}/relay`);
    const closing = closed(socket);
    await tap.close();
    await closing;
    await expect(connect(`ws://127.0.0.1:${tap.port}/relay`)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
  });
});
