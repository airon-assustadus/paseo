export const RemoteBrowserOpcode = {
  Frame: 0x30,
  FrameAck: 0x31,
} as const;

export type RemoteBrowserOpcode = (typeof RemoteBrowserOpcode)[keyof typeof RemoteBrowserOpcode];

export const RemoteBrowserImageFormat = {
  Jpeg: 1,
} as const;

export type RemoteBrowserImageFormat =
  (typeof RemoteBrowserImageFormat)[keyof typeof RemoteBrowserImageFormat];

interface RemoteBrowserFrameIdentity {
  subscriptionId: string;
  generation: number;
  seq: number;
}

export type RemoteBrowserBinaryFrame = RemoteBrowserFrameIdentity &
  (
    | {
        opcode: typeof RemoteBrowserOpcode.Frame;
        cssWidth: number;
        cssHeight: number;
        imageWidth: number;
        imageHeight: number;
        format: RemoteBrowserImageFormat;
        image: Uint8Array;
      }
    | { opcode: typeof RemoteBrowserOpcode.FrameAck }
  );

const FRAME_HEADER_BYTES = 4 + 4 + 2 + 2 + 2 + 2 + 1;
const ACK_BODY_BYTES = 4 + 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function encodeSubscriptionId(id: string): Uint8Array {
  const bytes = encoder.encode(id);
  if (bytes.length === 0 || bytes.length > 255 || decoder.decode(bytes) !== id) {
    throw new RangeError("Remote browser subscription IDs must contain 1–255 bytes of valid UTF-8");
  }
  return bytes;
}

function isUint32(value: number, min: number): boolean {
  return Number.isInteger(value) && value >= min && value <= 0xffffffff;
}

function isDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 0xffff;
}

function isImageFormat(value: number): value is RemoteBrowserImageFormat {
  return value === RemoteBrowserImageFormat.Jpeg;
}

export function encodeRemoteBrowserFrame(frame: RemoteBrowserBinaryFrame): Uint8Array {
  const subscriptionId = encodeSubscriptionId(frame.subscriptionId);
  if (!isUint32(frame.generation, 1)) throw new RangeError("Invalid remote browser generation");
  if (!isUint32(frame.seq, 0)) throw new RangeError("Invalid remote browser frame sequence");
  const headerOffset = 2 + subscriptionId.length;
  let bytes: Uint8Array;
  switch (frame.opcode) {
    case RemoteBrowserOpcode.Frame: {
      const dimensions = [frame.cssWidth, frame.cssHeight, frame.imageWidth, frame.imageHeight];
      if (!dimensions.every(isDimension)) throw new RangeError("Invalid remote browser frame size");
      if (!isImageFormat(frame.format)) throw new RangeError("Unknown remote browser image format");
      if (frame.image.length === 0) throw new RangeError("Empty remote browser frame");
      bytes = new Uint8Array(headerOffset + FRAME_HEADER_BYTES + frame.image.length);
      const view = new DataView(bytes.buffer);
      view.setUint32(headerOffset, frame.generation);
      view.setUint32(headerOffset + 4, frame.seq);
      view.setUint16(headerOffset + 8, frame.cssWidth);
      view.setUint16(headerOffset + 10, frame.cssHeight);
      view.setUint16(headerOffset + 12, frame.imageWidth);
      view.setUint16(headerOffset + 14, frame.imageHeight);
      bytes[headerOffset + 16] = frame.format;
      bytes.set(frame.image, headerOffset + FRAME_HEADER_BYTES);
      break;
    }
    case RemoteBrowserOpcode.FrameAck: {
      bytes = new Uint8Array(headerOffset + ACK_BODY_BYTES);
      const view = new DataView(bytes.buffer);
      view.setUint32(headerOffset, frame.generation);
      view.setUint32(headerOffset + 4, frame.seq);
      break;
    }
    default:
      throw new RangeError("Unknown remote browser opcode");
  }
  bytes[0] = frame.opcode;
  bytes[1] = subscriptionId.length;
  bytes.set(subscriptionId, 2);
  return bytes;
}

export function decodeRemoteBrowserFrame(bytes: Uint8Array): RemoteBrowserBinaryFrame | null {
  if (bytes.length < 3) return null;
  const subscriptionLength = bytes[1];
  const headerOffset = 2 + subscriptionLength;
  if (subscriptionLength === 0 || headerOffset + ACK_BODY_BYTES > bytes.length) return null;
  let subscriptionId: string;
  try {
    subscriptionId = decoder.decode(bytes.subarray(2, headerOffset));
  } catch (error) {
    // Fatal TextDecoder rejects malformed UTF-8 at the network boundary.
    if (error instanceof TypeError) return null;
    throw error;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const generation = view.getUint32(headerOffset);
  const seq = view.getUint32(headerOffset + 4);
  if (generation === 0) return null;
  const identity = { subscriptionId, generation, seq };
  switch (bytes[0]) {
    case RemoteBrowserOpcode.Frame: {
      if (bytes.length <= headerOffset + FRAME_HEADER_BYTES) return null;
      const cssWidth = view.getUint16(headerOffset + 8);
      const cssHeight = view.getUint16(headerOffset + 10);
      const imageWidth = view.getUint16(headerOffset + 12);
      const imageHeight = view.getUint16(headerOffset + 14);
      const format = bytes[headerOffset + 16];
      if (![cssWidth, cssHeight, imageWidth, imageHeight].every(isDimension)) return null;
      if (!isImageFormat(format)) return null;
      return {
        ...identity,
        opcode: RemoteBrowserOpcode.Frame,
        cssWidth,
        cssHeight,
        imageWidth,
        imageHeight,
        format,
        image: bytes.subarray(headerOffset + FRAME_HEADER_BYTES),
      };
    }
    case RemoteBrowserOpcode.FrameAck:
      return bytes.length === headerOffset + ACK_BODY_BYTES
        ? { ...identity, opcode: RemoteBrowserOpcode.FrameAck }
        : null;
    default:
      return null;
  }
}
