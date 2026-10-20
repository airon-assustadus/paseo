import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
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
  options: { maxBytesPerDirection?: number } = {},
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

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

describe("ws tap", () => {
  it("forwards both directions with path and opcode, classifies the handshake, and reports only counts", async () => {
    const target = await echoServer();
    const tap = await tapFor(target.port);
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
