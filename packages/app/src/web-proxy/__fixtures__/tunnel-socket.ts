import type {
  NetworkTunnel,
  NetworkTunnelStream,
  NetworkTunnelStreamHandlers,
  NetworkTunnelTarget,
} from "@getpaseo/client";
import { TunnelCloseReason } from "@getpaseo/protocol/binary-frames/index";
import {
  BRIDGE_CHANNEL_LIMITS,
  BRIDGE_SUBPROTOCOL,
  type BridgeSocket,
  type BridgeSocketHandlers,
} from "./bridge-channel";

// Test-only BridgeSocket over a NetworkTunnelStream (tunnel-socket-contract.md). The bridge frames
// the channel sends travel as length-prefixed bytes to the host's TCP listener through the daemon
// tunnel. The channel still authenticates, bounds and parses frames; this module only carries them,
// mirrors the tunnel's write credit and keeps the lifecycle single-shot. It holds no endpoint, key
// or token: the tunnel it receives is already authenticated. Proves nothing about a device.

// The codec is injected (D-R2-1): the app never imports the server's length-prefixed module and
// keeps no copy of it. This is the shape the socket needs from it.
export interface TunnelFrameReader {
  push(chunk: Uint8Array): number;
}

export interface TunnelFrameCodec {
  encode(text: string): Uint8Array;
  createReader(onFrame: (text: string) => void): TunnelFrameReader;
}

// u32 big-endian length, then the UTF-8 text. The page checks the loaded module against this
// before trusting it.
export const TUNNEL_CODEC_VECTOR = {
  text: "{}",
  bytes: [0, 0, 0, 2, 0x7b, 0x7d],
} as const;

const LENGTH_PREFIX_BYTES = 4;

export type TunnelCodecProblem =
  | "encode_missing"
  | "reader_missing"
  | "vector_mismatch"
  | "roundtrip_mismatch";

export class TunnelCodecShapeError extends Error {
  constructor(readonly problem: TunnelCodecProblem) {
    super(`Tunnel codec rejected: ${problem}`);
    this.name = "TunnelCodecShapeError";
  }
}

interface LengthPrefixedModule {
  encodeLengthPrefixed(text: string): Uint8Array;
  LengthPrefixedReader: new (options: { onFrame(text: string): void }) => TunnelFrameReader;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasLengthPrefixedShape(value: unknown): value is LengthPrefixedModule {
  return (
    isRecord(value) &&
    typeof value.encodeLengthPrefixed === "function" &&
    typeof value.LengthPrefixedReader === "function"
  );
}

function sameBytes(actual: Uint8Array, expected: readonly number[]): boolean {
  return (
    actual.length === expected.length && expected.every((byte, index) => actual[index] === byte)
  );
}

// Adopts the server's codec module as the page loaded it (`await import(codecModuleUrl)`). Shape,
// the fixed vector and a round trip are checked before any byte from the peer reaches it; a
// mismatch is a failure, not a fallback.
export function adoptLengthPrefixedCodec(module: unknown): TunnelFrameCodec {
  if (!isRecord(module) || typeof module.encodeLengthPrefixed !== "function") {
    throw new TunnelCodecShapeError("encode_missing");
  }
  if (!hasLengthPrefixedShape(module)) throw new TunnelCodecShapeError("reader_missing");
  const codec: TunnelFrameCodec = {
    encode: (text) => module.encodeLengthPrefixed(text),
    createReader: (onFrame) => new module.LengthPrefixedReader({ onFrame }),
  };
  const encoded = codec.encode(TUNNEL_CODEC_VECTOR.text);
  if (!(encoded instanceof Uint8Array) || !sameBytes(encoded, TUNNEL_CODEC_VECTOR.bytes)) {
    throw new TunnelCodecShapeError("vector_mismatch");
  }
  const decoded: string[] = [];
  const reader = codec.createReader((text) => decoded.push(text));
  const credited = reader.push(Uint8Array.from(TUNNEL_CODEC_VECTOR.bytes));
  const roundTripped =
    credited === TUNNEL_CODEC_VECTOR.bytes.length &&
    decoded.length === 1 &&
    decoded[0] === TUNNEL_CODEC_VECTOR.text;
  if (!roundTripped) throw new TunnelCodecShapeError("roundtrip_mismatch");
  return codec;
}

export type TunnelSocketFailureReason =
  | "frame_violation"
  | "handler_failed"
  | "credit_violation"
  | "overflow"
  | "encode_failed"
  | "stream_failed"
  | "remote_close";

export class TunnelSocketError extends Error {
  constructor(
    readonly reason: TunnelSocketFailureReason,
    options?: { cause: unknown },
  ) {
    super(`Tunnel socket failed: ${reason}`, options);
    this.name = "TunnelSocketError";
  }
}

export interface TunnelBridgeSocketOptions {
  // The real NetworkTunnel from openNetworkTunnel(); the unit test passes a controlled one.
  tunnel: Pick<NetworkTunnel, "limits" | "openStream">;
  target: NetworkTunnelTarget;
  codec: TunnelFrameCodec;
}

export type TunnelBridgeSocketState = "connecting" | "open" | "closed";

export interface TunnelBridgeSocket extends BridgeSocket {
  readonly streamId: string;
  state(): TunnelBridgeSocketState;
  // The write credit this socket believes the stream has; the stream does not expose its own.
  outgoingCredit(): number;
  // null after a clean close, local or remote.
  failure(): TunnelSocketError | null;
}

// The client's close codes the channel uses (bridge-channel.ts): 1000 is the only clean one.
const CLOSE_NORMAL = 1000;

interface QueuedFrame {
  bytes: Uint8Array;
  offset: number;
}

// Opens the stream at creation, as `new WebSocket(url)` connects when constructed; openStream's
// own errors propagate and leave no socket behind.
export function createTunnelBridgeSocket(options: TunnelBridgeSocketOptions): TunnelBridgeSocket {
  const { tunnel, codec } = options;
  const { initialWindowBytes, maxDataBytes } = tunnel.limits;
  const queue: QueuedFrame[] = [];
  let buffered = 0;
  let credit = 0;
  let state: TunnelBridgeSocketState = "connecting";
  let failure: TunnelSocketError | null = null;
  let handlers: BridgeSocketHandlers | null = null;
  let draining = false;
  // Set by the frame callback when the channel's handler threw, so onData can tell a handler
  // failure from a reader violation: both surface as one exception out of push.
  let handlerError: { cause: unknown } | null = null;
  let stream: NetworkTunnelStream | null = null;

  function discardQueue(): void {
    queue.length = 0;
    buffered = 0;
  }

  // Notifies the channel exactly once, after the state is already closed, so anything the
  // channel does in response (close, send) is a no-op here.
  function notifyClosed(): void {
    if (handlers === null) return;
    if (failure !== null) handlers.error();
    handlers.close();
  }

  function fail(reason: TunnelSocketFailureReason, cause?: unknown): void {
    if (state === "closed") return;
    state = "closed";
    failure = new TunnelSocketError(reason, cause === undefined ? undefined : { cause });
    discardQueue();
    try {
      stream?.close(TunnelCloseReason.ProtocolError);
    } finally {
      notifyClosed();
    }
  }

  // Runs a tunnel callback; a failure it recorded is rethrown afterwards so the client's
  // handlerError logs it. Only throwing would leave the stream open: the tunnel catches it.
  function inCallback(run: () => void): void {
    const before = failure;
    run();
    if (failure !== before && failure !== null) throw failure;
  }

  function drain(): void {
    if (draining || stream === null) return;
    draining = true;
    try {
      while (queue.length > 0 && credit > 0) {
        // A nested callback inside write (a synchronous close) can end the socket mid-loop.
        if (state !== "open") break;
        const head = queue[0];
        const remaining = head.bytes.length - head.offset;
        const size = Math.min(maxDataBytes, credit, remaining);
        const chunk = head.bytes.subarray(head.offset, head.offset + size);
        // Mirrors what the stream does on a successful write; a throw below closes the socket.
        credit -= size;
        stream.write(chunk);
        head.offset += size;
        buffered -= size;
        if (head.offset === head.bytes.length) queue.shift();
      }
    } catch (error) {
      fail("stream_failed", error);
    } finally {
      draining = false;
    }
  }

  function onFrame(text: string): void {
    // A handler earlier in this chunk may have closed the socket; the reader still delivers.
    if (state !== "open" || handlers === null) return;
    try {
      handlers.message(text);
    } catch (error) {
      handlerError = { cause: error };
      throw error;
    }
  }

  // Read through a function: the assignment happens inside the reader's callback, which the
  // type checker cannot see from onData.
  function takeHandlerError(): { cause: unknown } | null {
    const failed = handlerError;
    handlerError = null;
    return failed;
  }

  const reader = codec.createReader(onFrame);

  const streamHandlers: NetworkTunnelStreamHandlers = {
    onConnected() {
      inCallback(() => {
        if (state !== "connecting") return;
        state = "open";
        credit = initialWindowBytes;
        try {
          handlers?.open();
        } catch (error) {
          fail("handler_failed", error);
          return;
        }
        drain();
      });
    },
    onData(data) {
      inCallback(() => {
        if (state !== "open") return;
        handlerError = null;
        let pushError: { cause: unknown } | null = null;
        try {
          reader.push(data);
        } catch (error) {
          pushError = { cause: error };
        }
        const failed = takeHandlerError();
        if (failed !== null) {
          fail("handler_failed", failed.cause);
          return;
        }
        if (pushError !== null) {
          fail("frame_violation", pushError.cause);
          return;
        }
        // Credit goes back after the parse: every byte is either delivered or in the reader's
        // bounded buffer. The stream ignores consume once closed.
        if (state !== "open") return;
        try {
          stream?.consume(data.length);
        } catch (error) {
          fail("stream_failed", error);
        }
      });
    },
    onCredit(granted) {
      inCallback(() => {
        if (state !== "open") return;
        const valid =
          Number.isSafeInteger(granted) && granted >= 1 && credit + granted <= initialWindowBytes;
        if (!valid) {
          fail("credit_violation");
          return;
        }
        credit += granted;
        drain();
      });
    },
    onClose(reason) {
      if (state === "closed") return;
      state = "closed";
      if (reason !== TunnelCloseReason.Ok) failure = new TunnelSocketError("remote_close");
      discardQueue();
      notifyClosed();
    },
  };

  stream = tunnel.openStream(options.target, streamHandlers);
  const { streamId } = stream;

  return {
    streamId,
    state: () => state,
    outgoingCredit: () => credit,
    failure: () => failure,
    bufferedAmount: () => buffered,
    // The host's TCP listener only speaks bridge v1 and TCP negotiates no subprotocol.
    protocol: () => BRIDGE_SUBPROTOCOL,
    send(data) {
      if (state === "closed") return;
      let encoded: Uint8Array;
      try {
        encoded = codec.encode(data);
      } catch (error) {
        fail("encode_failed", error);
        return;
      }
      // The channel's own rule (bridge-channel.ts transmit): buffered bytes plus the payload's
      // UTF-8 bytes. Same arithmetic here so the two never disagree; the queue therefore holds
      // at most maxBufferedBytes plus one length prefix.
      const payloadBytes = encoded.length - LENGTH_PREFIX_BYTES;
      if (buffered + payloadBytes > BRIDGE_CHANNEL_LIMITS.maxBufferedBytes) {
        fail("overflow");
        return;
      }
      queue.push({ bytes: encoded, offset: 0 });
      buffered += encoded.length;
      drain();
    },
    close(code) {
      if (state === "closed") return;
      state = "closed";
      discardQueue();
      const reason = code === CLOSE_NORMAL ? TunnelCloseReason.Ok : TunnelCloseReason.ProtocolError;
      // The real stream calls onClose synchronously from close(); the state above makes that a
      // no-op, so the channel hears close() once, below.
      try {
        stream?.close(reason);
      } finally {
        notifyClosed();
      }
    },
    observe(next) {
      handlers = next;
      if (state === "connecting") return;
      // Already past the event the channel waits for: replay it off the stack, like a
      // WebSocket fires events asynchronously.
      const current = state;
      queueMicrotask(() => {
        if (handlers !== next) return;
        if (current === "open" && state === "open") next.open();
        else if (current === "closed") notifyClosed();
      });
    },
  };
}
