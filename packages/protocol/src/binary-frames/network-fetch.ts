import { z } from "zod";
import {
  NETWORK_FETCH_MAX_CHUNK_BYTES,
  NETWORK_FETCH_MAX_FETCH_ID,
  NETWORK_FETCH_MAX_METADATA_BYTES,
} from "../network-fetch/rpc-schemas.js";

export const NetworkFetchOpcode = {
  Request: 0x40,
  Body: 0x41,
  End: 0x42,
  Cancel: 0x43,
  Credit: 0x44,
  Head: 0x45,
  Fail: 0x46,
  Cancelled: 0x47,
} as const;
export type NetworkFetchOpcode = (typeof NetworkFetchOpcode)[keyof typeof NetworkFetchOpcode];
const HeadersSchema = z.array(z.tuple([z.string().min(1).max(256), z.string()]));
export const NetworkFetchRequestMetadataSchema = z.strictObject({
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  url: z.string().min(1).max(8192),
  headers: HeadersSchema,
  redirect: z.literal("manual"),
  body: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({
      kind: z.literal("stream"),
      length: z.number().int().min(0).max(67108864).nullable(),
    }),
  ]),
});
export const NetworkFetchResponseHeadSchema = z.strictObject({
  status: z.number().int().min(100).max(599),
  statusText: z.string().max(1024),
  headers: HeadersSchema,
  url: z.string().min(1).max(8192),
  redirected: z.boolean(),
  redirect: z.strictObject({ location: z.string().max(8192), allowed: z.boolean() }).nullable(),
  setCookieDropped: z.number().int().nonnegative(),
  droppedRequestHeaders: z.array(z.string().max(256)),
});
export const NetworkFetchFailureSchema = z.strictObject({
  code: z.enum([
    "invalid_request",
    "not_allowlisted",
    "credentials_unsupported",
    "request_head_too_large",
    "request_body_too_large",
    "stream_limit",
    "policy_denied",
    "self_target_denied",
    "host_not_found",
    "connection_refused",
    "network_unreachable",
    "timeout",
    "tls_certificate_invalid",
    "tls_hostname_mismatch",
    "tls_error",
    "redirect_not_allowlisted",
    "redirect_limit",
    "redirect_body_unreplayable",
    "redirect_error_mode",
    "response_head_too_large",
    "response_body_too_large",
    "unsupported_encoding",
    "credit_exceeded",
    "upstream_error",
  ]),
  message: z.string().max(1024),
});
const CancelledSchema = z.strictObject({ dnsPending: z.boolean() });
export type NetworkFetchRequestMetadata = z.infer<typeof NetworkFetchRequestMetadataSchema>;
export type NetworkFetchResponseHead = z.infer<typeof NetworkFetchResponseHeadSchema>;
export type NetworkFetchFailure = z.infer<typeof NetworkFetchFailureSchema>;
export type NetworkFetchErrorCode = NetworkFetchFailure["code"];
export type NetworkFetchBinaryFrame = { subscriptionId: string; fetchId: number } & (
  | { opcode: typeof NetworkFetchOpcode.Request; request: NetworkFetchRequestMetadata }
  | { opcode: typeof NetworkFetchOpcode.Body; data: Uint8Array }
  | { opcode: typeof NetworkFetchOpcode.End }
  | { opcode: typeof NetworkFetchOpcode.Cancel }
  | { opcode: typeof NetworkFetchOpcode.Credit; bytes: number }
  | { opcode: typeof NetworkFetchOpcode.Head; head: NetworkFetchResponseHead }
  | { opcode: typeof NetworkFetchOpcode.Fail; failure: NetworkFetchFailure }
  | { opcode: typeof NetworkFetchOpcode.Cancelled; dnsPending: boolean }
);
export type NetworkFetchClientFrame = Exclude<
  NetworkFetchBinaryFrame,
  { opcode: 0x45 | 0x46 | 0x47 }
>;
export type NetworkFetchServerFrame = Exclude<NetworkFetchBinaryFrame, { opcode: 0x40 | 0x43 }>;
export type NetworkFetchDirection = "client_to_host" | "host_to_client";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function uint32(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= NETWORK_FETCH_MAX_FETCH_ID;
}
function permitted(opcode: number, direction?: NetworkFetchDirection): boolean {
  if (opcode < NetworkFetchOpcode.Request || opcode > NetworkFetchOpcode.Cancelled) return false;
  if (direction === "client_to_host") return opcode <= NetworkFetchOpcode.Credit;
  if (direction === "host_to_client")
    return opcode !== NetworkFetchOpcode.Request && opcode !== NetworkFetchOpcode.Cancel;
  return true;
}
function metadata(schema: z.ZodType, value: unknown): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(schema.parse(value)));
  if (bytes.byteLength > NETWORK_FETCH_MAX_METADATA_BYTES)
    throw new RangeError("Network fetch metadata exceeds the wire limit");
  return bytes;
}
export function encodeNetworkFetchFrame(
  frame: NetworkFetchBinaryFrame,
  direction?: NetworkFetchDirection,
): Uint8Array {
  const subscription = encoder.encode(frame.subscriptionId);
  if (
    !subscription.length ||
    subscription.length > 255 ||
    decoder.decode(subscription) !== frame.subscriptionId ||
    !uint32(frame.fetchId) ||
    !permitted(frame.opcode, direction)
  ) {
    throw new RangeError("Invalid network fetch frame identity or direction");
  }
  let payload: Uint8Array;
  switch (frame.opcode) {
    case NetworkFetchOpcode.Request:
      payload = metadata(NetworkFetchRequestMetadataSchema, frame.request);
      break;
    case NetworkFetchOpcode.Body:
      if (!frame.data.byteLength || frame.data.byteLength > NETWORK_FETCH_MAX_CHUNK_BYTES)
        throw new RangeError("Invalid network fetch body size");
      payload = frame.data;
      break;
    case NetworkFetchOpcode.End:
    case NetworkFetchOpcode.Cancel:
      payload = new Uint8Array();
      break;
    case NetworkFetchOpcode.Credit:
      if (!uint32(frame.bytes)) throw new RangeError("Invalid network fetch credit");
      payload = new Uint8Array(4);
      new DataView(payload.buffer).setUint32(0, frame.bytes, false);
      break;
    case NetworkFetchOpcode.Head:
      payload = metadata(NetworkFetchResponseHeadSchema, frame.head);
      break;
    case NetworkFetchOpcode.Fail:
      payload = metadata(NetworkFetchFailureSchema, frame.failure);
      break;
    case NetworkFetchOpcode.Cancelled:
      payload = metadata(CancelledSchema, { dnsPending: frame.dnsPending });
      break;
  }
  const bytes = new Uint8Array(6 + subscription.length + payload.length);
  bytes[0] = frame.opcode;
  bytes[1] = subscription.length;
  bytes.set(subscription, 2);
  new DataView(bytes.buffer).setUint32(2 + subscription.length, frame.fetchId, false);
  bytes.set(payload, 6 + subscription.length);
  return bytes;
}
export function decodeNetworkFetchFrame(
  bytes: Uint8Array,
  direction?: NetworkFetchDirection,
): NetworkFetchBinaryFrame | null {
  const opcode = bytes[0];
  const idLength = bytes[1];
  if (!permitted(opcode, direction) || !idLength || bytes.length < 6 + idLength) return null;
  try {
    const subscriptionId = decoder.decode(bytes.subarray(2, 2 + idLength));
    const fetchId = new DataView(bytes.buffer, bytes.byteOffset + 2 + idLength, 4).getUint32(
      0,
      false,
    );
    if (!uint32(fetchId)) return null;
    const identity = { subscriptionId, fetchId };
    const payload = bytes.subarray(6 + idLength);
    switch (opcode) {
      case NetworkFetchOpcode.Body:
        return payload.length > 0 && payload.length <= NETWORK_FETCH_MAX_CHUNK_BYTES
          ? { ...identity, opcode, data: payload }
          : null;
      case NetworkFetchOpcode.End:
      case NetworkFetchOpcode.Cancel:
        return payload.length === 0 ? { ...identity, opcode } : null;
      case NetworkFetchOpcode.Credit: {
        if (payload.length !== 4) return null;
        const credit = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, false);
        return uint32(credit) ? { ...identity, opcode, bytes: credit } : null;
      }
    }
    if (!payload.length || payload.length > NETWORK_FETCH_MAX_METADATA_BYTES) return null;
    const value: unknown = JSON.parse(decoder.decode(payload));
    switch (opcode) {
      case NetworkFetchOpcode.Request:
        return { ...identity, opcode, request: NetworkFetchRequestMetadataSchema.parse(value) };
      case NetworkFetchOpcode.Head:
        return { ...identity, opcode, head: NetworkFetchResponseHeadSchema.parse(value) };
      case NetworkFetchOpcode.Fail:
        return { ...identity, opcode, failure: NetworkFetchFailureSchema.parse(value) };
      case NetworkFetchOpcode.Cancelled:
        return { ...identity, opcode, ...CancelledSchema.parse(value) };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
