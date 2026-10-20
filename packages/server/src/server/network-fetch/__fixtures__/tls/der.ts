/**
 * The subset of DER needed to emit an X.509 v3 certificate. Only definite lengths and the tags the
 * certificate builder uses; no parsing. Node can read certificates but cannot create them, and the
 * fixture must not depend on an `openssl` binary (the unit suite runs on Windows CI).
 */

const TAG_BOOLEAN = 0x01;
const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
const TAG_UTF8_STRING = 0x0c;
const TAG_IA5_STRING = 0x16;
const TAG_UTC_TIME = 0x17;
const TAG_SEQUENCE = 0x30;
const TAG_SET = 0x31;
const CLASS_CONTEXT = 0x80;
const FORM_CONSTRUCTED = 0x20;

export function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

export function sequence(...parts: Buffer[]): Buffer {
  return tlv(TAG_SEQUENCE, Buffer.concat(parts));
}

export function set(...parts: Buffer[]): Buffer {
  return tlv(TAG_SET, Buffer.concat(parts));
}

export function boolean(value: boolean): Buffer {
  return tlv(TAG_BOOLEAN, Buffer.from([value ? 0xff : 0x00]));
}

/** Unsigned big-endian magnitude; a leading zero keeps the DER value positive. */
export function unsignedInteger(magnitude: Buffer | number): Buffer {
  let bytes =
    typeof magnitude === "number"
      ? Buffer.from(magnitude.toString(16).padStart(2, "0"), "hex")
      : magnitude;
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  bytes = bytes.subarray(start);
  if (bytes.length === 0) bytes = Buffer.from([0]);
  if ((bytes[0] & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(TAG_INTEGER, bytes);
}

export function bitString(bits: Buffer, unusedBits = 0): Buffer {
  return tlv(TAG_BIT_STRING, Buffer.concat([Buffer.from([unusedBits]), bits]));
}

export function octetString(bytes: Buffer): Buffer {
  return tlv(TAG_OCTET_STRING, bytes);
}

export function objectIdentifier(dotted: string): Buffer {
  const arcs = dotted.split(".").map((arc) => Number.parseInt(arc, 10));
  const body: number[] = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) body.push(...base128(arc));
  return tlv(TAG_OID, Buffer.from(body));
}

function base128(value: number): number[] {
  const out = [value & 0x7f];
  let remaining = Math.floor(value / 128);
  while (remaining > 0) {
    out.unshift((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  return out;
}

export function utf8String(value: string): Buffer {
  return tlv(TAG_UTF8_STRING, Buffer.from(value, "utf8"));
}

export function ia5String(value: string): Buffer {
  return tlv(TAG_IA5_STRING, Buffer.from(value, "ascii"));
}

/** UTCTime covers 1950–2049, which is all the fixture ever needs for synthetic validity windows. */
export function utcTime(date: Date): Buffer {
  const pad = (n: number) => n.toString().padStart(2, "0");
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  return tlv(TAG_UTC_TIME, Buffer.from(text, "ascii"));
}

/** `[n] EXPLICIT` wrapper around an already encoded element. */
export function explicit(tagNumber: number, inner: Buffer): Buffer {
  return tlv(CLASS_CONTEXT | FORM_CONSTRUCTED | tagNumber, inner);
}

/** `[n] IMPLICIT` primitive: the context tag replaces the inner type tag. */
export function implicitPrimitive(tagNumber: number, content: Buffer): Buffer {
  return tlv(CLASS_CONTEXT | tagNumber, content);
}

export function toPem(label: string, der: Buffer): string {
  const base64 = der.toString("base64");
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
