import {
  NetworkTunnelError,
  type NetworkTunnelLimits,
  type NetworkTunnelStream,
  type NetworkTunnelStreamHandlers,
  type NetworkTunnelTarget,
} from "@getpaseo/client";
import { TunnelCloseReason } from "@getpaseo/protocol/binary-frames/index";
import { describe, expect, it, vi } from "vitest";
import {
  BRIDGE_CHANNEL_LIMITS,
  BRIDGE_SUBPROTOCOL,
  type BridgeSocketHandlers,
} from "./bridge-channel";
import {
  adoptLengthPrefixedCodec,
  createTunnelBridgeSocket,
  TUNNEL_CODEC_VECTOR,
  TunnelCodecShapeError,
  TunnelSocketError,
  type TunnelFrameCodec,
  type TunnelFrameReader,
} from "./tunnel-socket";

// A window smaller than one maximum frame (D-R2-5): only reachable here, with a controlled stream.
const SMALL_WINDOW: NetworkTunnelLimits = {
  initialWindowBytes: 32_768,
  maxDataBytes: 65_536,
  maxStreams: 4,
  connectTimeoutMs: 10_000,
};
const TARGET: NetworkTunnelTarget = { host: "127.0.0.1", port: 4300 };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// A deliberately different wire format from the server's: one UTF-8 line per frame, ended by
// "\n" (serialized JSON never contains a raw newline). The socket's credit, queue and lifecycle
// logic is what these tests exercise; the real length-prefixed codec is not reimplemented here,
// and parity with it is proved where it is loaded for real (the R2 probe and browser proof).
const LINE_END = 0x0a;
const OVERHEAD = 1;

class LineReader implements TunnelFrameReader {
  private pending: number[] = [];
  poisoned = false;

  constructor(private readonly onFrame: (text: string) => void) {}

  push(chunk: Uint8Array): number {
    if (this.poisoned) throw new Error("poisoned");
    for (const byte of chunk) {
      if (byte !== LINE_END) {
        this.pending.push(byte);
        continue;
      }
      if (this.pending.length === 0) {
        this.poisoned = true;
        throw new Error("empty_line");
      }
      const text = decoder.decode(Uint8Array.from(this.pending));
      this.pending = [];
      try {
        this.onFrame(text);
      } catch (error) {
        this.poisoned = true;
        throw error;
      }
    }
    return chunk.length;
  }
}

function encodeLine(text: string): Uint8Array {
  if (text.length === 0 || text.includes("\n")) throw new Error("invalid_line");
  return encoder.encode(`${text}\n`);
}

const lineCodec: TunnelFrameCodec = {
  encode: encodeLine,
  createReader: (onFrame) => new LineReader(onFrame),
};

// What the real NetworkTunnelStreamImpl does (packages/client/src/network-tunnel.ts:255-375),
// without the wire: the same state gate, size and credit checks, the same thrown codes, consume
// validated against bytes received and not yet consumed, close single and synchronous.
class FakeStream implements NetworkTunnelStream {
  readonly streamId = "stream-1";
  readonly writes: Uint8Array[] = [];
  readonly consumed: number[] = [];
  readonly closeReasons: number[] = [];
  readonly handlerErrors: { error: unknown; handler: string }[] = [];
  // Records, in order, what the socket did to the stream, so tests can assert ordering.
  readonly trace: string[] = [];
  state: "connecting" | "connected" | "closed" = "connecting";
  outgoingCredit = 0;
  incomingCredit: number;
  writeFailure: Error | null = null;
  consumeFailure: Error | null = null;
  onWrite: ((chunk: Uint8Array) => void) | null = null;

  constructor(
    private readonly limits: NetworkTunnelLimits,
    readonly handlers: NetworkTunnelStreamHandlers,
  ) {
    this.incomingCredit = limits.initialWindowBytes;
  }

  write(data: Uint8Array): void {
    if (this.state === "closed") return;
    this.requireConnected("write");
    if (data.length === 0 || data.length > this.limits.maxDataBytes) {
      throw new NetworkTunnelError("max_data_exceeded", "Tunnel data size");
    }
    if (data.length > this.outgoingCredit) {
      throw new NetworkTunnelError("no_credit", "Tunnel stream has insufficient write credit");
    }
    if (this.writeFailure !== null) throw this.writeFailure;
    this.outgoingCredit -= data.length;
    this.writes.push(data.slice());
    this.trace.push(`write:${data.length}`);
    this.onWrite?.(data);
  }

  consume(bytes: number): void {
    if (this.state === "closed") return;
    this.requireConnected("consume");
    const consumable = this.limits.initialWindowBytes - this.incomingCredit;
    if (!Number.isInteger(bytes) || bytes <= 0 || bytes > consumable) {
      throw new NetworkTunnelError("invalid_consumption", "Tunnel consumption");
    }
    if (this.consumeFailure !== null) throw this.consumeFailure;
    this.incomingCredit += bytes;
    this.consumed.push(bytes);
    this.trace.push(`consume:${bytes}`);
  }

  close(reason: number = TunnelCloseReason.Ok): void {
    if (this.state === "closed") return;
    this.closeReasons.push(reason);
    this.trace.push(`close:${reason}`);
    this.finish(reason);
  }

  // Drivers: what the daemon would cause through the wire.
  connect(): void {
    this.state = "connected";
    this.outgoingCredit = this.limits.initialWindowBytes;
    this.notify(() => this.handlers.onConnected(), "onConnected");
  }

  deliver(data: Uint8Array): void {
    expect(this.state).toBe("connected");
    expect(data.length).toBeLessThanOrEqual(this.incomingCredit);
    this.incomingCredit -= data.length;
    this.notify(() => this.handlers.onData(data), "onData");
  }

  grant(credit: number): void {
    expect(this.state).toBe("connected");
    expect(credit).toBeLessThanOrEqual(this.limits.initialWindowBytes - this.outgoingCredit);
    this.outgoingCredit += credit;
    this.notify(() => this.handlers.onCredit(credit), "onCredit");
  }

  remoteClose(reason: number): void {
    if (this.state === "closed") return;
    this.finish(reason);
  }

  private requireConnected(operation: string): void {
    if (this.state !== "connected") {
      throw new NetworkTunnelError("invalid_state", `Cannot ${operation} before connect`);
    }
  }

  private finish(reason: number): void {
    this.state = "closed";
    this.notify(() => this.handlers.onClose(reason), "onClose");
  }

  private notify(callback: () => void, handler: string): void {
    try {
      callback();
    } catch (error) {
      this.handlerErrors.push({ error, handler });
    }
  }
}

function createFakeTunnel(limits: NetworkTunnelLimits) {
  const streams: FakeStream[] = [];
  const tunnel = {
    limits,
    openStream(target: NetworkTunnelTarget, handlers: NetworkTunnelStreamHandlers): FakeStream {
      expect(target).toEqual(TARGET);
      const stream = new FakeStream(limits, handlers);
      streams.push(stream);
      return stream;
    },
  };
  return { tunnel, stream: () => streams[0] };
}

function createHandlers(overrides: Partial<BridgeSocketHandlers> = {}) {
  const calls: string[] = [];
  const handlers: BridgeSocketHandlers = {
    open: vi.fn(() => calls.push("open")),
    message: vi.fn((data: unknown) => calls.push(`message:${String(data).length}`)),
    close: vi.fn(() => calls.push("close")),
    error: vi.fn(() => calls.push("error")),
    ...overrides,
  };
  return { handlers, calls };
}

function openSocket(limits = SMALL_WINDOW, overrides: Partial<BridgeSocketHandlers> = {}) {
  const { tunnel, stream } = createFakeTunnel(limits);
  const socket = createTunnelBridgeSocket({ tunnel, target: TARGET, codec: lineCodec });
  const { handlers, calls } = createHandlers(overrides);
  socket.observe(handlers);
  stream().connect();
  return { socket, stream: stream(), handlers, calls };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function decodeFrames(bytes: Uint8Array): string[] {
  const frames: string[] = [];
  new LineReader((text) => frames.push(text)).push(bytes);
  return frames;
}

// A JSON text whose UTF-8 size is exactly `bytes`.
function textOfBytes(bytes: number): string {
  const text = JSON.stringify({ pad: "x".repeat(bytes - 10) });
  expect(encoder.encode(text).byteLength).toBe(bytes);
  return text;
}

// A JSON text of exactly `bytes` UTF-8 bytes with about half as many characters, so a count by
// characters would pass where a count by bytes must refuse.
function multibyteTextOfBytes(bytes: number): string {
  const text = JSON.stringify({ pad: "é".repeat((bytes - 10) / 2) });
  expect(encoder.encode(text).byteLength).toBe(bytes);
  expect(text.length).toBeLessThan(bytes / 2 + 10);
  return text;
}

describe("tunnel bridge socket lifecycle", () => {
  it("opens the stream at creation and reports open once the stream connects", () => {
    const { tunnel, stream } = createFakeTunnel(SMALL_WINDOW);
    const socket = createTunnelBridgeSocket({ tunnel, target: TARGET, codec: lineCodec });
    expect(stream()).toBeDefined();
    expect(socket.streamId).toBe("stream-1");
    expect(socket.state()).toBe("connecting");
    expect(socket.outgoingCredit()).toBe(0);
    expect(socket.protocol()).toBe(BRIDGE_SUBPROTOCOL);

    const { handlers, calls } = createHandlers();
    socket.observe(handlers);
    expect(calls).toEqual([]);
    stream().connect();
    expect(calls).toEqual(["open"]);
    expect(socket.state()).toBe("open");
    expect(socket.outgoingCredit()).toBe(SMALL_WINDOW.initialWindowBytes);
    expect(stream().handlerErrors).toEqual([]);
  });

  it("writes a hello sent from open() in the same turn as the connect, with initial credit", () => {
    const { tunnel, stream } = createFakeTunnel(SMALL_WINDOW);
    const socket = createTunnelBridgeSocket({ tunnel, target: TARGET, codec: lineCodec });
    const hello = '{"type":"harness.hello","token":"SyntheticTokenForUnitTestsOnly"}';
    const { handlers } = createHandlers({ open: () => socket.send(hello) });
    socket.observe(handlers);
    expect(stream().writes).toEqual([]);
    stream().connect();
    // Written inside onConnected: the mirrored credit was already the initial window.
    expect(stream().trace).toEqual([`write:${hello.length + OVERHEAD}`]);
    expect(stream().writes).toEqual([encodeLine(hello)]);
    expect(socket.outgoingCredit()).toBe(SMALL_WINDOW.initialWindowBytes - hello.length - OVERHEAD);
    expect(socket.outgoingCredit()).toBe(stream().outgoingCredit);
    expect(socket.bufferedAmount()).toBe(0);
    expect(stream().handlerErrors).toEqual([]);
  });

  it("replays open in a microtask when observed after the stream connected", async () => {
    const { tunnel, stream } = createFakeTunnel(SMALL_WINDOW);
    const socket = createTunnelBridgeSocket({ tunnel, target: TARGET, codec: lineCodec });
    stream().connect();
    const { handlers, calls } = createHandlers();
    socket.observe(handlers);
    expect(calls).toEqual([]);
    await Promise.resolve();
    expect(calls).toEqual(["open"]);
  });

  it("replays the close in a microtask when observed after the stream closed", async () => {
    const { tunnel, stream } = createFakeTunnel(SMALL_WINDOW);
    const socket = createTunnelBridgeSocket({ tunnel, target: TARGET, codec: lineCodec });
    stream().connect();
    stream().remoteClose(TunnelCloseReason.ProtocolError);
    const { handlers, calls } = createHandlers();
    socket.observe(handlers);
    await Promise.resolve();
    expect(calls).toEqual(["error", "close"]);
  });

  it("closes locally once: normal code maps to Ok and the queue is discarded", () => {
    const { socket, stream, calls } = openSocket();
    socket.send(textOfBytes(40_000));
    expect(socket.bufferedAmount()).toBeGreaterThan(0);
    socket.close(1000);
    socket.close(1000);
    expect(stream.closeReasons).toEqual([TunnelCloseReason.Ok]);
    expect(calls).toEqual(["open", "close"]);
    expect(socket.state()).toBe("closed");
    expect(socket.bufferedAmount()).toBe(0);
    expect(socket.failure()).toBeNull();
    socket.send("{}");
    expect(stream.writes).toHaveLength(1);
  });

  it("maps a violation close code to ProtocolError", () => {
    const { socket, stream } = openSocket();
    socket.close(4008);
    expect(stream.closeReasons).toEqual([TunnelCloseReason.ProtocolError]);
  });

  it("reports a clean remote close once without closing the stream again", () => {
    const { socket, stream, calls } = openSocket();
    socket.send(textOfBytes(40_000));
    stream.remoteClose(TunnelCloseReason.Ok);
    stream.remoteClose(TunnelCloseReason.Ok);
    expect(calls).toEqual(["open", "close"]);
    expect(stream.closeReasons).toEqual([]);
    expect(socket.bufferedAmount()).toBe(0);
    expect(socket.failure()).toBeNull();
    socket.close(1000);
    expect(calls).toEqual(["open", "close"]);
  });

  it("reports an abnormal remote close as error then close", () => {
    const { socket, stream, calls } = openSocket();
    stream.remoteClose(TunnelCloseReason.ProtocolError);
    expect(calls).toEqual(["open", "error", "close"]);
    expect(socket.failure()?.reason).toBe("remote_close");
  });
});

describe("tunnel bridge socket credit and fragmentation", () => {
  it("writes a small frame at once and decrements the mirrored credit", () => {
    const { socket, stream } = openSocket();
    const text = '{"type":"harness.hello"}';
    socket.send(text);
    expect(stream.writes).toEqual([encodeLine(text)]);
    expect(socket.outgoingCredit()).toBe(SMALL_WINDOW.initialWindowBytes - text.length - OVERHEAD);
    expect(socket.outgoingCredit()).toBe(stream.outgoingCredit);
    expect(socket.bufferedAmount()).toBe(0);
  });

  it("sends a frame larger than the window in credit-sized slices, waiting for credit", () => {
    const { socket, stream } = openSocket();
    const text = textOfBytes(41_000);
    const frame = encodeLine(text);
    socket.send(text);

    expect(stream.writes.map((chunk) => chunk.length)).toEqual([32_768]);
    expect(socket.outgoingCredit()).toBe(0);
    expect(socket.bufferedAmount()).toBe(frame.length - 32_768);
    expect(socket.state()).toBe("open");

    stream.grant(10_000);
    expect(stream.writes.map((chunk) => chunk.length)).toEqual([32_768, 8_233]);
    expect(socket.bufferedAmount()).toBe(0);
    expect(socket.outgoingCredit()).toBe(10_000 - 8_233);
    expect(concat(stream.writes)).toEqual(frame);
    expect(stream.handlerErrors).toEqual([]);
  });

  it("bounds each slice by maxDataBytes when credit exceeds it", () => {
    const limits = { ...SMALL_WINDOW, initialWindowBytes: 4_096, maxDataBytes: 1_024 };
    const { socket, stream } = openSocket(limits);
    const text = textOfBytes(3_000 - OVERHEAD);
    socket.send(text);
    expect(stream.writes.map((chunk) => chunk.length)).toEqual([1_024, 1_024, 952]);
    expect(socket.outgoingCredit()).toBe(4_096 - 3_000);
    expect(concat(stream.writes)).toEqual(encodeLine(text));
  });

  it("keeps frames in order across partial credit", () => {
    const limits = { ...SMALL_WINDOW, initialWindowBytes: 100, maxDataBytes: 60 };
    const { socket, stream } = openSocket(limits);
    const first = textOfBytes(80);
    const second = textOfBytes(70);
    socket.send(first);
    socket.send(second);
    expect(socket.bufferedAmount()).toBe(81 + 71 - 100);
    stream.grant(100);
    expect(socket.bufferedAmount()).toBe(0);
    expect(decodeFrames(concat(stream.writes))).toEqual([first, second]);
    expect(stream.writes.map((chunk) => chunk.length)).toEqual([60, 21, 19, 52]);
  });

  it("queues a frame sent before the stream connects and writes it on connect", () => {
    const { tunnel, stream } = createFakeTunnel(SMALL_WINDOW);
    const socket = createTunnelBridgeSocket({ tunnel, target: TARGET, codec: lineCodec });
    const { handlers, calls } = createHandlers();
    socket.observe(handlers);
    socket.send("{}");
    expect(socket.bufferedAmount()).toBe(2 + OVERHEAD);
    expect(stream().writes).toEqual([]);
    stream().connect();
    expect(calls).toEqual(["open"]);
    expect(stream().writes).toEqual([encodeLine("{}")]);
    expect(socket.bufferedAmount()).toBe(0);
  });

  it("continues the outer drain when credit arrives synchronously inside write", () => {
    const limits = { ...SMALL_WINDOW, initialWindowBytes: 1_000, maxDataBytes: 400 };
    const { socket, stream } = openSocket(limits);
    // A loopback peer that returns every byte it reads as credit, from inside write.
    stream.onWrite = (chunk) => stream.grant(chunk.length);
    const text = textOfBytes(2_500 - OVERHEAD);
    socket.send(text);
    expect(stream.writes.map((chunk) => chunk.length)).toEqual([400, 400, 400, 400, 400, 400, 100]);
    expect(concat(stream.writes)).toEqual(encodeLine(text));
    expect(socket.bufferedAmount()).toBe(0);
    expect(socket.outgoingCredit()).toBe(1_000);
    expect(stream.handlerErrors).toEqual([]);
  });

  it("fails closed on overflow using the channel's own arithmetic", () => {
    const limits = { ...SMALL_WINDOW, initialWindowBytes: 1, maxDataBytes: 1 };
    const { socket, stream, calls } = openSocket(limits);
    const half = textOfBytes(BRIDGE_CHANNEL_LIMITS.maxBufferedBytes / 2);
    socket.send(half);
    // One byte of the first frame went out with the initial credit.
    expect(socket.bufferedAmount()).toBe(half.length + OVERHEAD - 1);
    // Exactly what the channel would accept: bufferedAmount + payload bytes equals the ceiling.
    const fill = textOfBytes(BRIDGE_CHANNEL_LIMITS.maxBufferedBytes - socket.bufferedAmount());
    socket.send(fill);
    expect(socket.state()).toBe("open");
    socket.send("{}");
    expect(socket.state()).toBe("closed");
    expect(socket.failure()?.reason).toBe("overflow");
    expect(socket.bufferedAmount()).toBe(0);
    expect(stream.closeReasons).toEqual([TunnelCloseReason.ProtocolError]);
    expect(calls).toEqual(["open", "error", "close"]);
  });

  it("counts the payload in UTF-8 bytes, not characters, when checking overflow", () => {
    const limits = { ...SMALL_WINDOW, initialWindowBytes: 1, maxDataBytes: 1 };
    const { socket } = openSocket(limits);
    const room = BRIDGE_CHANNEL_LIMITS.maxBufferedBytes / 2;
    socket.send(textOfBytes(room));
    expect(socket.bufferedAmount()).toBe(room + OVERHEAD - 1);
    // Fewer characters than the room left, but more bytes.
    socket.send(multibyteTextOfBytes(room + 2));
    expect(socket.failure()?.reason).toBe("overflow");
  });

  it("fails closed when the codec refuses a frame, without throwing into the channel", () => {
    const { socket, stream, calls } = openSocket();
    expect(() => socket.send("")).not.toThrow();
    expect(socket.failure()?.reason).toBe("encode_failed");
    expect(socket.failure()?.cause).toBeInstanceOf(Error);
    expect(stream.closeReasons).toEqual([TunnelCloseReason.ProtocolError]);
    expect(calls).toEqual(["open", "error", "close"]);
  });

  it("fails closed when the stream rejects a write the mirror allowed", () => {
    const { socket, stream, calls } = openSocket();
    stream.writeFailure = new NetworkTunnelError("no_credit", "mirror drift");
    expect(() => socket.send("{}")).not.toThrow();
    expect(socket.failure()?.reason).toBe("stream_failed");
    expect(socket.failure()?.cause).toBe(stream.writeFailure);
    expect(calls).toEqual(["open", "error", "close"]);
    expect(stream.handlerErrors).toEqual([]);
  });

  it("rethrows a write failure raised inside the credit callback so the client logs it", () => {
    const limits = { ...SMALL_WINDOW, initialWindowBytes: 2, maxDataBytes: 2 };
    const { socket, stream } = openSocket(limits);
    socket.send("{}");
    expect(socket.bufferedAmount()).toBe(2 + OVERHEAD - 2);
    stream.writeFailure = new Error("transport gone");
    stream.grant(2);
    expect(socket.failure()?.reason).toBe("stream_failed");
    expect(stream.handlerErrors).toHaveLength(1);
    expect(stream.handlerErrors[0].handler).toBe("onCredit");
    expect(stream.handlerErrors[0].error).toBe(socket.failure());
  });

  it("fails closed when the open handler throws", () => {
    const boom = new Error("channel bug on open");
    const { socket, stream, calls } = openSocket(SMALL_WINDOW, {
      open: () => {
        throw boom;
      },
    });
    expect(socket.failure()?.reason).toBe("handler_failed");
    expect(socket.failure()?.cause).toBe(boom);
    expect(calls).toEqual(["error", "close"]);
    expect(stream.handlerErrors.map((entry) => entry.handler)).toEqual(["onConnected"]);
  });

  it("fails closed on an invalid credit grant", () => {
    const { socket, stream, calls } = openSocket();
    socket.send("{}");
    // Straight to the handlers, bypassing the fake's own validation, as a daemon bug or a
    // hostile peer would.
    stream.handlers.onCredit(2 + OVERHEAD);
    expect(socket.outgoingCredit()).toBe(SMALL_WINDOW.initialWindowBytes);
    expect(() => stream.handlers.onCredit(1)).toThrow(TunnelSocketError);
    expect(socket.failure()?.reason).toBe("credit_violation");
    expect(calls).toEqual(["open", "error", "close"]);
    expect(stream.closeReasons).toEqual([TunnelCloseReason.ProtocolError]);
  });
});

describe("tunnel bridge socket receive path", () => {
  it("delivers a frame split across chunks and credits each chunk after the parse", () => {
    const { socket, stream, handlers } = openSocket();
    const text = textOfBytes(5_000);
    const frame = encodeLine(text);
    stream.deliver(frame.subarray(0, 3));
    expect(handlers.message).not.toHaveBeenCalled();
    expect(stream.consumed).toEqual([3]);
    stream.deliver(frame.subarray(3, 2_000));
    expect(handlers.message).not.toHaveBeenCalled();
    stream.deliver(frame.subarray(2_000));
    expect(handlers.message).toHaveBeenCalledWith(text);
    expect(stream.consumed).toEqual([3, 1_997, frame.length - 2_000]);
    expect(stream.trace.at(-1)).toBe(`consume:${frame.length - 2_000}`);
    expect(socket.state()).toBe("open");
    expect(stream.incomingCredit).toBe(SMALL_WINDOW.initialWindowBytes);
  });

  it("delivers two frames from one chunk in order with one consume", () => {
    const { stream, handlers, calls } = openSocket();
    const chunk = concat([encodeLine('{"a":1}'), encodeLine('{"b":22}')]);
    stream.deliver(chunk);
    expect(handlers.message).toHaveBeenNthCalledWith(1, '{"a":1}');
    expect(handlers.message).toHaveBeenNthCalledWith(2, '{"b":22}');
    expect(calls).toEqual(["open", "message:7", "message:8"]);
    expect(stream.consumed).toEqual([chunk.length]);
  });

  it("fails closed on a reader violation and rethrows it to the client log", () => {
    const { socket, stream, handlers, calls } = openSocket();
    stream.deliver(Uint8Array.from([LINE_END, 0x7b]));
    expect(handlers.message).not.toHaveBeenCalled();
    expect(socket.failure()?.reason).toBe("frame_violation");
    expect(socket.failure()?.cause).toMatchObject({ message: "empty_line" });
    expect(stream.consumed).toEqual([]);
    expect(stream.closeReasons).toEqual([TunnelCloseReason.ProtocolError]);
    expect(calls).toEqual(["open", "error", "close"]);
    expect(stream.handlerErrors.map((entry) => entry.handler)).toEqual(["onData"]);
    expect(stream.handlerErrors[0].error).toBe(socket.failure());
  });

  it("fails closed when the message handler throws", () => {
    const boom = new Error("channel bug");
    const { socket, stream, calls } = openSocket(SMALL_WINDOW, {
      message: () => {
        throw boom;
      },
    });
    stream.deliver(encodeLine("{}"));
    expect(socket.failure()?.reason).toBe("handler_failed");
    expect(socket.failure()?.cause).toBe(boom);
    expect(stream.consumed).toEqual([]);
    expect(calls).toEqual(["open", "error", "close"]);
    expect(stream.handlerErrors).toHaveLength(1);
  });

  it("stops delivering once a handler closed the socket mid-chunk", () => {
    const delivered: string[] = [];
    let socketRef: ReturnType<typeof createTunnelBridgeSocket> | null = null;
    const { socket, stream, calls } = openSocket(SMALL_WINDOW, {
      message: (data) => {
        delivered.push(String(data));
        socketRef?.close(1000);
      },
    });
    socketRef = socket;
    stream.deliver(concat([encodeLine('{"a":1}'), encodeLine('{"b":2}')]));
    expect(delivered).toEqual(['{"a":1}']);
    expect(stream.consumed).toEqual([]);
    expect(stream.closeReasons).toEqual([TunnelCloseReason.Ok]);
    expect(calls).toEqual(["open", "close"]);
    expect(stream.handlerErrors).toEqual([]);
  });

  it("lets a handler send a reply from inside the message callback", () => {
    let socketRef: ReturnType<typeof createTunnelBridgeSocket> | null = null;
    const { socket, stream } = openSocket(SMALL_WINDOW, {
      message: () => socketRef?.send('{"type":"grantCredit"}'),
    });
    socketRef = socket;
    const inbound = encodeLine('{"type":"head"}');
    stream.deliver(inbound);
    expect(stream.writes).toEqual([encodeLine('{"type":"grantCredit"}')]);
    expect(stream.trace).toEqual([`write:${22 + OVERHEAD}`, `consume:${inbound.length}`]);
  });

  it("fails closed when the stream rejects the consume", () => {
    const { socket, stream, handlers, calls } = openSocket();
    stream.consumeFailure = new NetworkTunnelError("invalid_consumption", "accounting drift");
    stream.deliver(encodeLine("{}"));
    expect(handlers.message).toHaveBeenCalledWith("{}");
    expect(socket.failure()?.reason).toBe("stream_failed");
    expect(socket.failure()?.cause).toBe(stream.consumeFailure);
    expect(calls).toEqual(["open", "message:2", "error", "close"]);
    expect(stream.handlerErrors.map((entry) => entry.handler)).toEqual(["onData"]);
  });

  it("ignores data after the socket closed", () => {
    const { socket, stream, handlers } = openSocket();
    socket.close(1000);
    stream.state = "connected";
    stream.deliver(encodeLine("{}"));
    expect(handlers.message).not.toHaveBeenCalled();
    expect(stream.consumed).toEqual([]);
  });
});

describe("adoptLengthPrefixedCodec", () => {
  const vector = Uint8Array.from(TUNNEL_CODEC_VECTOR.bytes);

  // A stub that knows only the fixed vector: it is not a parser and proves nothing about the
  // real module. Parity with the real codec is checked where that module is actually loaded.
  function encodeVectorOnly(text: string): Uint8Array {
    if (text !== TUNNEL_CODEC_VECTOR.text) throw new Error("stub knows only the vector");
    return vector.slice();
  }

  class VectorOnlyReader {
    constructor(private readonly options: { onFrame(text: string): void }) {}
    push(chunk: Uint8Array): number {
      if (chunk.length !== vector.length || chunk.some((byte, index) => byte !== vector[index])) {
        throw new Error("stub knows only the vector");
      }
      this.options.onFrame(TUNNEL_CODEC_VECTOR.text);
      return chunk.length;
    }
  }

  const stubModule = {
    encodeLengthPrefixed: encodeVectorOnly,
    LengthPrefixedReader: VectorOnlyReader,
  };

  function problemOf(module: unknown): string {
    try {
      adoptLengthPrefixedCodec(module);
    } catch (error) {
      expect(error).toBeInstanceOf(TunnelCodecShapeError);
      return (error as TunnelCodecShapeError).problem;
    }
    throw new Error("codec was adopted");
  }

  it("adopts a module whose shape, vector and round trip match", () => {
    const codec = adoptLengthPrefixedCodec(stubModule);
    expect(codec.encode(TUNNEL_CODEC_VECTOR.text)).toEqual(vector);
    const frames: string[] = [];
    expect(codec.createReader((text) => frames.push(text)).push(vector)).toBe(vector.length);
    expect(frames).toEqual([TUNNEL_CODEC_VECTOR.text]);
  });

  it.each([
    ["encode_missing", { LengthPrefixedReader: VectorOnlyReader }],
    ["encode_missing", null],
    ["reader_missing", { encodeLengthPrefixed: encodeVectorOnly }],
    [
      "vector_mismatch",
      { ...stubModule, encodeLengthPrefixed: (text: string) => encoder.encode(text) },
    ],
    [
      "roundtrip_mismatch",
      {
        ...stubModule,
        LengthPrefixedReader: class {
          push(chunk: Uint8Array): number {
            return chunk.length;
          }
        },
      },
    ],
  ])("rejects %s", (problem, module) => {
    expect(problemOf(module)).toBe(problem);
  });
});
