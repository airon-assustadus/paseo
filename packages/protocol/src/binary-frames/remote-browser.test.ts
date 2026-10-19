import { describe, expect, it } from "vitest";
import { decodeBinaryFrame } from "./demux.js";
import {
  decodeRemoteBrowserFrame,
  encodeRemoteBrowserFrame,
  RemoteBrowserImageFormat,
  RemoteBrowserOpcode,
  type RemoteBrowserBinaryFrame,
} from "./remote-browser.js";

const subscriptionId = "11111111-1111-4111-8111-111111111111";
const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const frame: RemoteBrowserBinaryFrame = {
  opcode: RemoteBrowserOpcode.Frame,
  subscriptionId,
  generation: 3,
  seq: 41,
  cssWidth: 390,
  cssHeight: 844,
  imageWidth: 780,
  imageHeight: 1688,
  format: RemoteBrowserImageFormat.Jpeg,
  image,
};
const ack: RemoteBrowserBinaryFrame = {
  opcode: RemoteBrowserOpcode.FrameAck,
  subscriptionId,
  generation: 3,
  seq: 41,
};

describe("remote browser binary frames", () => {
  it.each([frame, ack])("round-trips opcode $opcode", (input) => {
    expect(decodeRemoteBrowserFrame(encodeRemoteBrowserFrame(input))).toEqual(input);
  });

  it("is routed by the shared demux", () => {
    expect(decodeBinaryFrame(encodeRemoteBrowserFrame(frame))).toEqual({
      kind: "remote_browser",
      frame,
    });
    expect(decodeBinaryFrame(encodeRemoteBrowserFrame(ack))).toEqual({
      kind: "remote_browser",
      frame: ack,
    });
  });

  it("rejects malformed frames", () => {
    const encoded = encodeRemoteBrowserFrame(frame);
    const zeroGeneration = encoded.slice();
    new DataView(zeroGeneration.buffer).setUint32(2 + subscriptionId.length, 0);
    const unknownFormat = encoded.slice();
    unknownFormat[2 + subscriptionId.length + 16] = 9;
    const zeroWidth = encoded.slice();
    new DataView(zeroWidth.buffer).setUint16(2 + subscriptionId.length + 12, 0);
    const ackWithBody = new Uint8Array([...encodeRemoteBrowserFrame(ack), 0]);
    const badUtf8 = encoded.slice();
    badUtf8[2] = 0xff;
    for (const bytes of [
      encoded.subarray(0, 2 + subscriptionId.length + 17),
      zeroGeneration,
      unknownFormat,
      zeroWidth,
      ackWithBody,
      badUtf8,
      new Uint8Array([RemoteBrowserOpcode.Frame, 0, 0, 0, 0, 1, 0, 0, 0, 1]),
    ]) {
      expect(decodeRemoteBrowserFrame(bytes)).toBeNull();
    }
  });

  it("refuses to encode out-of-range fields", () => {
    expect(() => encodeRemoteBrowserFrame({ ...frame, generation: 0 })).toThrow(RangeError);
    expect(() => encodeRemoteBrowserFrame({ ...frame, seq: -1 })).toThrow(RangeError);
    expect(() => encodeRemoteBrowserFrame({ ...frame, imageWidth: 0x10000 })).toThrow(RangeError);
    expect(() => encodeRemoteBrowserFrame({ ...frame, image: new Uint8Array() })).toThrow(
      RangeError,
    );
    expect(() => encodeRemoteBrowserFrame({ ...frame, subscriptionId: "" })).toThrow(RangeError);
  });
});
