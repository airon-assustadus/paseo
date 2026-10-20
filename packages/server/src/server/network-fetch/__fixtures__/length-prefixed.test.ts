import { describe, expect, it } from "vitest";
import {
  encodeLengthPrefixed,
  LENGTH_PREFIX_BYTES,
  LengthPrefixedError,
  LengthPrefixedReader,
  MAX_LENGTH_PREFIXED_FRAME_BYTES,
  MAX_LENGTH_PREFIXED_PARTIAL_BYTES,
} from "./length-prefixed.js";

function reader(maxFrameBytes?: number) {
  const frames: string[] = [];
  const instance = new LengthPrefixedReader({
    maxFrameBytes,
    onFrame: (text) => frames.push(text),
  });
  return { frames, reader: instance };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function prefixOnly(length: number): Uint8Array {
  const bytes = new Uint8Array(LENGTH_PREFIX_BYTES);
  new DataView(bytes.buffer).setUint32(0, length, false);
  return bytes;
}

describe("length-prefixed codec", () => {
  it("round-trips the smallest and the largest legal frames", () => {
    const { frames, reader: target } = reader();
    const largest = "x".repeat(MAX_LENGTH_PREFIXED_FRAME_BYTES);
    expect(target.push(encodeLengthPrefixed("a"))).toBe(5);
    expect(target.push(encodeLengthPrefixed(largest))).toBe(MAX_LENGTH_PREFIXED_PARTIAL_BYTES);
    expect(frames).toEqual(["a", largest]);
    expect(target.buffered).toBe(0);
    expect(target.framesDelivered).toBe(2);
  });

  it("refuses to encode an empty or oversized frame, counting UTF-8 bytes", () => {
    expect(() => encodeLengthPrefixed("")).toThrow(
      expect.objectContaining({ violation: "zero_length" }),
    );
    expect(() => encodeLengthPrefixed("x".repeat(MAX_LENGTH_PREFIXED_FRAME_BYTES + 1))).toThrow(
      expect.objectContaining({ violation: "frame_too_large" }),
    );
    expect(() => encodeLengthPrefixed("é".repeat(32_769))).toThrow(LengthPrefixedError);
    expect(encodeLengthPrefixed("é".repeat(32_768)).length).toBe(LENGTH_PREFIX_BYTES + 65_536);
  });

  it("delivers many frames from one chunk without any aggregate cap", () => {
    const { frames, reader: target } = reader();
    const parts = Array.from({ length: 12 }, (_, index) =>
      encodeLengthPrefixed("f".repeat(8_000) + String(index)),
    );
    const chunk = concat(parts);
    expect(chunk.length).toBeGreaterThan(MAX_LENGTH_PREFIXED_PARTIAL_BYTES);
    expect(target.push(chunk)).toBe(chunk.length);
    expect(frames.map((frame) => frame.slice(8_000))).toEqual(
      Array.from({ length: 12 }, (_, index) => String(index)),
    );
    expect(target.buffered).toBe(0);
  });

  it("reassembles a prefix and a payload fragmented one byte at a time and credits each byte", () => {
    const { frames, reader: target } = reader();
    const encoded = encodeLengthPrefixed(JSON.stringify({ type: "harness.hello", token: "t" }));
    let credited = 0;
    for (const byte of encoded) {
      credited += target.push(Uint8Array.of(byte));
      expect(target.buffered).toBeLessThanOrEqual(MAX_LENGTH_PREFIXED_PARTIAL_BYTES);
    }
    expect(credited).toBe(encoded.length);
    expect(frames).toEqual([JSON.stringify({ type: "harness.hello", token: "t" })]);
    expect(target.buffered).toBe(0);
  });

  it("accepts a chunk that ends inside a frame and never holds more than prefix plus frame", () => {
    const { frames, reader: target } = reader();
    const encoded = encodeLengthPrefixed("y".repeat(MAX_LENGTH_PREFIXED_FRAME_BYTES));
    const head = encoded.subarray(0, 40_000);
    const tail = encoded.subarray(40_000);
    expect(target.push(head)).toBe(40_000);
    expect(target.buffered).toBe(40_000);
    expect(frames).toEqual([]);
    expect(target.push(concat([tail, encodeLengthPrefixed("z")]))).toBe(tail.length + 5);
    expect(target.buffered).toBe(0);
    expect(frames.map((frame) => frame.length)).toEqual([MAX_LENGTH_PREFIXED_FRAME_BYTES, 1]);
  });

  it("rejects a zero or oversized declared length as soon as the prefix is complete, before any payload", () => {
    const zero = reader();
    expect(() => zero.reader.push(prefixOnly(0))).toThrow(
      expect.objectContaining({ violation: "zero_length", declaredLength: 0 }),
    );
    const large = reader();
    const prefix = prefixOnly(MAX_LENGTH_PREFIXED_FRAME_BYTES + 1);
    expect(() => large.reader.push(prefix.subarray(0, 3))).not.toThrow();
    expect(() => large.reader.push(prefix.subarray(3))).toThrow(
      expect.objectContaining({
        violation: "frame_too_large",
        declaredLength: MAX_LENGTH_PREFIXED_FRAME_BYTES + 1,
      }),
    );
    expect(large.reader.poisoned).toBe(true);
    expect(() => large.reader.push(Uint8Array.of(1))).toThrow(
      expect.objectContaining({ violation: "poisoned" }),
    );
    const huge = reader();
    expect(() => huge.reader.push(prefixOnly(0xffff_ffff))).toThrow(
      expect.objectContaining({ violation: "frame_too_large" }),
    );
  });

  it("honours a smaller per-reader ceiling", () => {
    const { frames, reader: target } = reader(16);
    expect(target.push(encodeLengthPrefixed("0123456789abcdef"))).toBe(20);
    expect(frames).toEqual(["0123456789abcdef"]);
    expect(() => target.push(encodeLengthPrefixed("0123456789abcdefg"))).toThrow(
      expect.objectContaining({ violation: "frame_too_large", declaredLength: 17 }),
    );
  });

  it("rejects invalid UTF-8 payloads", () => {
    const { reader: target } = reader();
    const bytes = concat([prefixOnly(2), Uint8Array.of(0xc3, 0x28)]);
    expect(() => target.push(bytes)).toThrow(
      expect.objectContaining({ violation: "invalid_utf8" }),
    );
    expect(target.poisoned).toBe(true);
  });

  it("propagates a consumer failure and stops delivering afterwards", () => {
    let calls = 0;
    const target = new LengthPrefixedReader({
      onFrame: () => {
        calls += 1;
        throw new Error("consumer refused");
      },
    });
    const two = concat([encodeLengthPrefixed("one"), encodeLengthPrefixed("two")]);
    expect(() => target.push(two)).toThrow("consumer refused");
    expect(calls).toBe(1);
    expect(target.poisoned).toBe(true);
    expect(() => target.push(encodeLengthPrefixed("three"))).toThrow(
      expect.objectContaining({ violation: "poisoned" }),
    );
  });
});
