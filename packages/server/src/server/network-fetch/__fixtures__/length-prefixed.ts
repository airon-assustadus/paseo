/**
 * Length-prefixed framing for the bridge frames over a byte stream (adapter contract §5.5): a u32
 * big-endian length followed by that many UTF-8 bytes of JSON text.
 *
 * The reader owns one fixed buffer of prefix + maximum frame bytes and never concatenates input
 * chunks or collects frames: every byte of a pushed chunk is either parsed into a frame delivered
 * synchronously to `onFrame` or copied into that buffer before `push` returns. The caller may then
 * return the whole chunk as credit to the tunnel, whatever the tunnel window is, because nothing it
 * handed over is still pending outside the bounded buffer.
 */

export const LENGTH_PREFIX_BYTES = 4;
export const MAX_LENGTH_PREFIXED_FRAME_BYTES = 65_536;
export const MAX_LENGTH_PREFIXED_PARTIAL_BYTES =
  MAX_LENGTH_PREFIXED_FRAME_BYTES + LENGTH_PREFIX_BYTES;

export type LengthPrefixedViolation =
  | "zero_length"
  | "frame_too_large"
  | "invalid_utf8"
  | "poisoned";

export class LengthPrefixedError extends Error {
  constructor(
    readonly violation: LengthPrefixedViolation,
    readonly declaredLength: number | null,
  ) {
    super(`Length-prefixed frame violation: ${violation}`);
    this.name = "LengthPrefixedError";
  }
}

export interface LengthPrefixedReaderOptions {
  /** Ceiling per frame; the partial buffer is this plus the prefix, allocated once. */
  maxFrameBytes?: number;
  /** Receives each complete frame, in order, synchronously inside `push`. A throw poisons the reader. */
  onFrame(text: string): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function encodeLengthPrefixed(
  text: string,
  maxFrameBytes = MAX_LENGTH_PREFIXED_FRAME_BYTES,
): Uint8Array {
  const payload = encoder.encode(text);
  if (payload.length === 0) throw new LengthPrefixedError("zero_length", 0);
  if (payload.length > maxFrameBytes) {
    throw new LengthPrefixedError("frame_too_large", payload.length);
  }
  const frame = new Uint8Array(LENGTH_PREFIX_BYTES + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length, false);
  frame.set(payload, LENGTH_PREFIX_BYTES);
  return frame;
}

export class LengthPrefixedReader {
  private readonly maxFrameBytes: number;
  private readonly onFrame: (text: string) => void;
  private readonly partial: Uint8Array;
  private readonly header: DataView;
  private offset = 0;
  private declared: number | null = null;
  private delivered = 0;
  private poisonedBy: LengthPrefixedViolation | null = null;

  constructor(options: LengthPrefixedReaderOptions) {
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_LENGTH_PREFIXED_FRAME_BYTES;
    this.onFrame = options.onFrame;
    this.partial = new Uint8Array(LENGTH_PREFIX_BYTES + this.maxFrameBytes);
    this.header = new DataView(this.partial.buffer, 0, LENGTH_PREFIX_BYTES);
  }

  /** Bytes currently held back, waiting for the rest of a prefix or a frame. */
  get buffered(): number {
    return this.offset;
  }

  get framesDelivered(): number {
    return this.delivered;
  }

  get poisoned(): boolean {
    return this.poisonedBy !== null;
  }

  /** Accepts every byte of `chunk` and returns `chunk.length`, the amount the caller may credit back. */
  push(chunk: Uint8Array): number {
    if (this.poisonedBy !== null) throw new LengthPrefixedError("poisoned", this.declared);
    let position = 0;
    while (position < chunk.length) {
      if (this.declared === null) {
        position = this.readPrefix(chunk, position);
        continue;
      }
      const needed = LENGTH_PREFIX_BYTES + this.declared - this.offset;
      const take = Math.min(needed, chunk.length - position);
      this.partial.set(chunk.subarray(position, position + take), this.offset);
      this.offset += take;
      position += take;
      if (take === needed) this.deliver();
    }
    return chunk.length;
  }

  private readPrefix(chunk: Uint8Array, position: number): number {
    const take = Math.min(LENGTH_PREFIX_BYTES - this.offset, chunk.length - position);
    this.partial.set(chunk.subarray(position, position + take), this.offset);
    this.offset += take;
    if (this.offset < LENGTH_PREFIX_BYTES) return position + take;
    const declared = this.header.getUint32(0, false);
    // Validated before any payload byte is copied, so an oversized claim allocates nothing.
    if (declared === 0) this.fail("zero_length", declared);
    if (declared > this.maxFrameBytes) this.fail("frame_too_large", declared);
    this.declared = declared;
    return position + take;
  }

  private deliver(): void {
    const payload = this.partial.subarray(LENGTH_PREFIX_BYTES, this.offset);
    let text: string;
    try {
      text = decoder.decode(payload);
    } catch {
      this.fail("invalid_utf8", this.declared);
    }
    this.offset = 0;
    this.declared = null;
    this.delivered += 1;
    try {
      this.onFrame(text);
    } catch (error) {
      this.poisonedBy = "poisoned";
      throw error;
    }
  }

  private fail(violation: LengthPrefixedViolation, declared: number | null): never {
    this.poisonedBy = violation;
    throw new LengthPrefixedError(violation, declared);
  }
}
