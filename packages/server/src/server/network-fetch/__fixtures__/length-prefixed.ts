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

/** A ceiling outside 1..65 536 or not an integer (NaN, Infinity, fractions) is a configuration error. */
function assertFrameCeiling(maxFrameBytes: number): void {
  if (
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes < 1 ||
    maxFrameBytes > MAX_LENGTH_PREFIXED_FRAME_BYTES
  ) {
    throw new RangeError(
      `maxFrameBytes must be an integer from 1 to ${MAX_LENGTH_PREFIXED_FRAME_BYTES}`,
    );
  }
}

/** UTF-8 length without allocating; stops counting once `limit` is exceeded. */
function utf8Length(text: string, limit: number): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // A surrogate pair is one 4-byte code point; a lone surrogate encodes as U+FFFD (3 bytes).
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

export function encodeLengthPrefixed(
  text: string,
  maxFrameBytes = MAX_LENGTH_PREFIXED_FRAME_BYTES,
): Uint8Array {
  assertFrameCeiling(maxFrameBytes);
  if (text.length === 0) throw new LengthPrefixedError("zero_length", 0);
  // UTF-8 never needs fewer bytes than UTF-16 code units, so this rejects before any counting.
  if (text.length > maxFrameBytes) throw new LengthPrefixedError("frame_too_large", null);
  const length = utf8Length(text, maxFrameBytes);
  if (length > maxFrameBytes) throw new LengthPrefixedError("frame_too_large", length);
  const frame = new Uint8Array(LENGTH_PREFIX_BYTES + length);
  new DataView(frame.buffer).setUint32(0, length, false);
  const written = encoder.encodeInto(text, frame.subarray(LENGTH_PREFIX_BYTES)).written;
  if (written !== length) throw new LengthPrefixedError("frame_too_large", written);
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
    const maxFrameBytes = options.maxFrameBytes ?? MAX_LENGTH_PREFIXED_FRAME_BYTES;
    // Checked before the buffer exists: a bad ceiling must not allocate anything.
    assertFrameCeiling(maxFrameBytes);
    this.maxFrameBytes = maxFrameBytes;
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
