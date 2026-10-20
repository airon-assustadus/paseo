import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

/**
 * A WebSocket-level tap in front of a local relay: what the relay sees, message by message. A TCP
 * tap would only see masked client frames (RFC 6455), so byte searches there prove nothing.
 * Payloads stay in memory up to a cap per direction and are never logged or written; tests read
 * counts, hashes and booleans. Reaching a cap closes that connection and marks `overflow`, so a
 * proof that outgrew the tap fails instead of silently losing bytes.
 */

export type WsTapDirection = "toTarget" | "fromTarget";

export interface WsTapOptions {
  targetPort: number;
  targetHost?: string;
  maxBytesPerDirection?: number;
  maxMessages?: number;
}

export interface WsTapMessage {
  direction: WsTapDirection;
  opcode: "text" | "binary";
  bytes: number;
  /** Set for the only frames the relay protocol sends in clear: the key exchange. */
  plaintextHandshake: "e2ee_hello" | "e2ee_ready" | null;
}

export interface WsTapOverflow {
  direction: WsTapDirection;
  limit: number;
}

export interface WsTapSummary {
  connections: number;
  /** Pairs still open; zero after every downstream and upstream closed. */
  openPairs: number;
  messages: number;
  bytes: Record<WsTapDirection, number>;
  sha256: Record<WsTapDirection, string>;
  overflow: WsTapOverflow | null;
}

export interface WsTap {
  port: number;
  messages(): readonly WsTapMessage[];
  contains(needle: string | Uint8Array): Record<WsTapDirection, boolean>;
  summary(): WsTapSummary;
  close(): Promise<void>;
}

export class WsTapOverflowError extends Error {
  constructor(readonly overflow: WsTapOverflow) {
    super(`WebSocket tap exceeded its ${overflow.direction} limit of ${overflow.limit} bytes`);
    this.name = "WsTapOverflowError";
  }
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_MESSAGES = 10_000;
const CLOSE_TOO_BIG = 1009;
const CLOSE_GOING_AWAY = 1001;

interface Pair {
  downstream: WebSocket;
  upstream: WebSocket;
  /** Messages received before the upstream handshake completed; dropped if the pair closes first. */
  queued: Array<{ data: Buffer; isBinary: boolean }>;
  closed: boolean;
}

function assertCap(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

/** `close()` is only legal on an open socket; a connecting one is aborted with `terminate()`. */
function shutDown(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
  else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
}

export async function startWsTap(options: WsTapOptions): Promise<WsTap> {
  const targetHost = options.targetHost ?? "127.0.0.1";
  const maxBytes = options.maxBytesPerDirection ?? DEFAULT_MAX_BYTES;
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  // Validated before any listener exists: NaN or Infinity must not disable a cap.
  assertCap("maxBytesPerDirection", maxBytes);
  assertCap("maxMessages", maxMessages);
  assertCap("targetPort", options.targetPort);
  const captured: Record<WsTapDirection, Buffer[]> = { toTarget: [], fromTarget: [] };
  const bytes: Record<WsTapDirection, number> = { toTarget: 0, fromTarget: 0 };
  const messages: WsTapMessage[] = [];
  const pairs = new Set<Pair>();
  let connections = 0;
  let overflow: WsTapOverflow | null = null;

  const server = http.createServer((_request, response) => {
    response.writeHead(426, { connection: "close" }).end();
  });
  // The library refuses a single message above the cap before `message` fires; that refusal is
  // surfaced as an overflow too, so a proof never loses bytes silently.
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxBytes });

  function closePair(pair: Pair, code: number, reason: string): void {
    if (pair.closed) return;
    pair.closed = true;
    pair.queued.length = 0;
    pairs.delete(pair);
    shutDown(pair.downstream, code, reason);
    shutDown(pair.upstream, code, reason);
  }

  function markOverflow(direction: WsTapDirection, limit: number, pair: Pair): void {
    overflow ??= { direction, limit };
    closePair(pair, CLOSE_TOO_BIG, "tap limit");
  }

  function record(direction: WsTapDirection, data: Buffer, isBinary: boolean, pair: Pair): boolean {
    if (overflow || pair.closed) return false;
    if (bytes[direction] + data.length > maxBytes) {
      markOverflow(direction, maxBytes, pair);
      return false;
    }
    if (messages.length >= maxMessages) {
      markOverflow(direction, maxMessages, pair);
      return false;
    }
    bytes[direction] += data.length;
    captured[direction].push(Buffer.from(data));
    messages.push({
      direction,
      opcode: isBinary ? "binary" : "text",
      bytes: data.length,
      plaintextHandshake: isBinary ? null : handshakeType(data),
    });
    return true;
  }

  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (downstream) => {
      connections += 1;
      const protocols = request.headers["sec-websocket-protocol"];
      const upstream = new WebSocket(
        `ws://${targetHost}:${options.targetPort}${request.url ?? "/"}`,
        protocols ? protocols.split(",").map((value) => value.trim()) : [],
        { maxPayload: maxBytes },
      );
      const pair: Pair = { downstream, upstream, queued: [], closed: false };
      pairs.add(pair);
      downstream.on("message", (data, isBinary) => {
        const buffer = toBuffer(data);
        if (!record("toTarget", buffer, isBinary, pair)) return;
        if (upstream.readyState === WebSocket.OPEN) upstream.send(buffer, { binary: isBinary });
        else pair.queued.push({ data: buffer, isBinary });
      });
      upstream.on("open", () => {
        // The downstream may have gone while the handshake was pending: nothing is flushed then.
        if (pair.closed) {
          upstream.terminate();
          return;
        }
        for (const item of pair.queued.splice(0)) {
          upstream.send(item.data, { binary: item.isBinary });
        }
      });
      upstream.on("message", (data, isBinary) => {
        const buffer = toBuffer(data);
        if (!record("fromTarget", buffer, isBinary, pair)) return;
        if (downstream.readyState === WebSocket.OPEN) downstream.send(buffer, { binary: isBinary });
      });
      const onClose = (code: number, reason: Buffer) =>
        closePair(pair, portableCode(code), reason.toString("utf8"));
      downstream.on("close", onClose);
      upstream.on("close", onClose);
      const onError = (direction: WsTapDirection) => (error: Error) => {
        if (isPayloadTooLarge(error)) markOverflow(direction, maxBytes, pair);
        else closePair(pair, CLOSE_GOING_AWAY, "tap peer error");
      };
      downstream.on("error", onError("toTarget"));
      upstream.on("error", onError("fromTarget"));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    messages: () => messages,
    contains(needle) {
      const bytesNeedle =
        typeof needle === "string" ? Buffer.from(needle, "utf8") : Buffer.from(needle);
      return {
        toTarget: captured.toTarget.some((chunk) => chunk.includes(bytesNeedle)),
        fromTarget: captured.fromTarget.some((chunk) => chunk.includes(bytesNeedle)),
      };
    },
    summary: () => ({
      connections,
      openPairs: pairs.size,
      messages: messages.length,
      bytes: { ...bytes },
      sha256: {
        toTarget: digest(captured.toTarget),
        fromTarget: digest(captured.fromTarget),
      },
      overflow,
    }),
    async close() {
      for (const pair of Array.from(pairs)) {
        pair.closed = true;
        pair.queued.length = 0;
        pair.downstream.terminate();
        pair.upstream.terminate();
      }
      pairs.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function isPayloadTooLarge(error: Error): boolean {
  return "code" in error && error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
}

function handshakeType(data: Buffer): WsTapMessage["plaintextHandshake"] {
  if (data.length > 4096 || data[0] !== 0x7b) return null;
  try {
    const parsed: unknown = JSON.parse(data.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) return null;
    const type = (parsed as { type: unknown }).type;
    return type === "e2ee_hello" || type === "e2ee_ready" ? type : null;
  } catch {
    return null;
  }
}

/** A close code the `ws` library refuses to send (1005, 1006, 1015) becomes a normal close. */
function portableCode(code: number): number {
  return code === 1005 || code === 1006 || code === 1015 ? 1000 : code;
}

function digest(chunks: Buffer[]): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}
