import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRIDGE_LIMITS,
  parseContentMessage,
  parseControlMessage,
  parseHello,
  parsePortGrant,
  InvalidBridgeLimitsError,
  validateBridgeLimits,
} from "./bridge-messages";

const request = {
  type: "paseo.web.request",
  v: 1,
  generation: 1,
  requestId: 1,
  method: "GET",
  path: "/",
  headers: [["accept", "text/html"]],
  body: null,
  mode: "navigate",
};

describe("parseContentMessage", () => {
  it("accepts a well-formed request", () => {
    expect(parseContentMessage(request, DEFAULT_BRIDGE_LIMITS)).toEqual(request);
  });

  it.each([
    ["an extra field", { ...request, destination: "http://elsewhere.invalid" }],
    ["another version", { ...request, v: 2 }],
    ["generation zero", { ...request, generation: 0 }],
    ["a fractional requestId", { ...request, requestId: 1.5 }],
    ["an unknown method", { ...request, method: "CONNECT" }],
    ["an unknown mode", { ...request, mode: "worker" }],
    ["a header with CRLF", { ...request, headers: [["x", "a\r\nb: c"]] }],
    ["a header name with a space", { ...request, headers: [["x y", "1"]] }],
    ["headers over the limit", { ...request, headers: [["x", "a".repeat(16384)]] }],
    ["a string body", { ...request, body: "text" }],
    [
      "an ack of zero bytes",
      { type: "paseo.web.ack", v: 1, generation: 1, requestId: 1, bytes: 0 },
    ],
    [
      "an ack above the window",
      { type: "paseo.web.ack", v: 1, generation: 1, requestId: 1, bytes: 262145 },
    ],
    ["an unknown type", { type: "paseo.web.label", v: 1, generation: 1, requestId: 1 }],
    ["a non-object", "paseo.web.request"],
  ])("rejects %s", (_label, message) => {
    expect(parseContentMessage(message, DEFAULT_BRIDGE_LIMITS)).toBeNull();
  });
});

describe("parseControlMessage", () => {
  it("rejects a head with an unconstructible status", () => {
    expect(
      parseControlMessage({
        type: "paseo.web.response.head",
        v: 1,
        generation: 1,
        requestId: 1,
        status: 101,
        statusText: "",
        headers: [],
      }),
    ).toBeNull();
  });

  it("rejects an unknown revoke reason", () => {
    expect(
      parseControlMessage({ type: "paseo.web.revoke", v: 1, generation: 1, reason: "other" }),
    ).toBeNull();
  });
});

describe("handshake messages", () => {
  it("accepts only the exact hello", () => {
    expect(parseHello({ type: "paseo.web.hello", v: 1 })).toEqual({
      type: "paseo.web.hello",
      v: 1,
    });
    expect(parseHello({ type: "paseo.web.hello", v: 1, nonce: "x" })).toBeNull();
  });

  it("rejects a grant whose chunk exceeds its window", () => {
    expect(
      parsePortGrant({
        type: "paseo.web.port",
        v: 1,
        generation: 1,
        limits: { ...DEFAULT_BRIDGE_LIMITS, maxChunkBytes: DEFAULT_BRIDGE_LIMITS.windowBytes + 1 },
      }),
    ).toBeNull();
  });
});

describe("validateBridgeLimits", () => {
  it("accepts the smallest workable limits", () => {
    const smallest = {
      windowBytes: 1,
      maxChunkBytes: 1,
      maxConcurrentRequests: 1,
      maxRequestBodyBytes: 1,
      maxHeaderBytes: 1,
    };
    expect(validateBridgeLimits(smallest)).toEqual(smallest);
  });

  it.each([
    ["NaN", { windowBytes: Number.NaN }],
    ["Infinity", { maxRequestBodyBytes: Number.POSITIVE_INFINITY }],
    ["a negative value", { maxHeaderBytes: -1 }],
    ["a fraction", { maxConcurrentRequests: 1.5 }],
    ["zero concurrency", { maxConcurrentRequests: 0 }],
    ["a zero upload limit", { maxRequestBodyBytes: 0 }],
    ["a window smaller than a chunk", { windowBytes: 1024, maxChunkBytes: 2048 }],
  ])("rejects %s", (_label, override) => {
    expect(() => validateBridgeLimits({ ...DEFAULT_BRIDGE_LIMITS, ...override })).toThrow(
      InvalidBridgeLimitsError,
    );
  });
});
