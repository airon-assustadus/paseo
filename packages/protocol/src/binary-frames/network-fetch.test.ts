import { describe, expect, it, vi } from "vitest";
import { decodeBinaryFrame } from "./demux.js";
import {
  decodeNetworkFetchFrame, encodeNetworkFetchFrame, NetworkFetchOpcode,
  type NetworkFetchBinaryFrame,
} from "./network-fetch.js";

const identity = { subscriptionId: "owner-è", fetchId: 0x01020304 };
const request = { method: "POST" as const, url: "https://destination.test/path", headers: [] as [string, string][], redirect: "manual" as const, body: { kind: "stream" as const, length: 3 } };
const frames: NetworkFetchBinaryFrame[] = [
  { ...identity, opcode: NetworkFetchOpcode.Request, request },
  { ...identity, opcode: NetworkFetchOpcode.Body, data: new Uint8Array([1, 2, 3]) },
  { ...identity, opcode: NetworkFetchOpcode.End },
  { ...identity, opcode: NetworkFetchOpcode.Cancel },
  { ...identity, opcode: NetworkFetchOpcode.Credit, bytes: 65536 },
  { ...identity, opcode: NetworkFetchOpcode.Head, head: { status: 302, statusText: "Found", headers: [], url: request.url, redirected: false, redirect: { location: "https://other.test/", allowed: false }, setCookieDropped: 2, droppedRequestHeaders: ["x-private"] } },
  { ...identity, opcode: NetworkFetchOpcode.Fail, failure: { code: "policy_denied", message: "Denied" } },
  { ...identity, opcode: NetworkFetchOpcode.Cancelled, dnsPending: true },
];
describe("network fetch binary codec", () => {
  it.each(frames)("roundtrips opcode $opcode with offsets and demux", (frame) => {
    const encoded = encodeNetworkFetchFrame(frame);
    const view = new Uint8Array(encoded.length + 5);
    view.set(encoded, 3);
    expect(decodeNetworkFetchFrame(view.subarray(3, 3 + encoded.length))).toEqual(frame);
    expect(decodeBinaryFrame(encoded)).toEqual({ kind: "network_fetch", frame });
    expect([...encoded.slice(2 + encoded[1], 6 + encoded[1])]).toEqual([1, 2, 3, 4]);
  });
  it("reserves precisely 0x40..0x47 without existing opcode collisions", () => {
    expect(Object.values(NetworkFetchOpcode)).toEqual([0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47]);
  });
  it.each(frames)("rejects truncated envelopes for $opcode", (frame) => {
    const bytes = encodeNetworkFetchFrame(frame);
    for (let length = 0; length < 6 + bytes[1]; length++) expect(decodeNetworkFetchFrame(bytes.subarray(0, length))).toBeNull();
  });
  it("rejects invalid UTF-8, empty and oversized IDs and nonpositive fetch IDs", () => {
    const frame = frames[2];
    for (const subscriptionId of ["", "a".repeat(256), "é".repeat(128), "\ud800"]) expect(() => encodeNetworkFetchFrame({ ...frame, subscriptionId })).toThrow();
    const bytes = encodeNetworkFetchFrame(frame);
    bytes[2] = 0xff;
    expect(decodeNetworkFetchFrame(bytes)).toBeNull();
    for (const fetchId of [0, -1, 1.5, 0x100000000, NaN]) expect(() => encodeNetworkFetchFrame({ ...frame, fetchId })).toThrow();
    const zero = encodeNetworkFetchFrame(frame);
    zero.fill(0, 2 + zero[1], 6 + zero[1]);
    expect(decodeNetworkFetchFrame(zero)).toBeNull();
  });
  it("rejects trailing bytes on fixed payloads and zero credit", () => {
    for (const frame of [frames[2], frames[3], frames[4]]) {
      const bytes = encodeNetworkFetchFrame(frame);
      expect(decodeNetworkFetchFrame(new Uint8Array([...bytes, 0]))).toBeNull();
    }
    const bytes = encodeNetworkFetchFrame(frames[4]);
    bytes.fill(0, bytes.length - 4);
    expect(decodeNetworkFetchFrame(bytes)).toBeNull();
  });
  it("rejects direction violations", () => {
    for (const frame of frames) {
      const clientAllowed = frame.opcode <= NetworkFetchOpcode.Credit;
      const serverAllowed = frame.opcode !== NetworkFetchOpcode.Request && frame.opcode !== NetworkFetchOpcode.Cancel;
      const bytes = encodeNetworkFetchFrame(frame);
      expect(decodeNetworkFetchFrame(bytes, "client_to_host") !== null).toBe(clientAllowed);
      expect(decodeNetworkFetchFrame(bytes, "host_to_client") !== null).toBe(serverAllowed);
    }
  });
  it("limits metadata before JSON parse and rejects unknown metadata fields", () => {
    const header = encodeNetworkFetchFrame(frames[2]);
    header[0] = NetworkFetchOpcode.Request;
    const bytes = new Uint8Array(header.length + 65537);
    bytes.set(header);
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(decodeNetworkFetchFrame(bytes)).toBeNull();
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
    for (const invalid of [{ ...request, fetchId: 1 }, { ...request, redirect: "follow" }, { ...request, url: "a".repeat(8193) }, { ...request, headers: [["a".repeat(257), "v"]] }]) {
      const payload = new TextEncoder().encode(JSON.stringify(invalid));
      expect(decodeNetworkFetchFrame(new Uint8Array([...header, ...payload]))).toBeNull();
    }
    expect(decodeNetworkFetchFrame(new Uint8Array([...header, 0xff]))).toBeNull();
  });
  it("enforces body limits without accepting an empty chunk", () => {
    expect(() => encodeNetworkFetchFrame({ ...identity, opcode: NetworkFetchOpcode.Body, data: new Uint8Array(65537) })).toThrow();
    expect(() => encodeNetworkFetchFrame({ ...identity, opcode: NetworkFetchOpcode.Body, data: new Uint8Array() })).toThrow();
    expect(decodeNetworkFetchFrame(encodeNetworkFetchFrame({ ...identity, opcode: NetworkFetchOpcode.Body, data: new Uint8Array(65536) }))).not.toBeNull();
  });
});
