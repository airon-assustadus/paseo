import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRIDGE_LIMITS,
  createLifecycleToken,
  isLifecycleToken,
  parseContentMessage,
  parseControlMessage,
  parseHello,
  parseLifecycleOffer,
  parseLifecycleToBroker,
  parseLifecycleToShell,
  parsePortGrant,
  parseResumed,
  suspendedReply,
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
  const error = {
    type: "paseo.web.response.error",
    v: 1,
    generation: 1,
    requestId: 1,
    code: "transport_error",
  };

  it("accepts an error with or without a reason from the closed list", () => {
    expect(parseControlMessage(error)).toEqual(error);
    expect(parseControlMessage({ ...error, reason: "tls_error" })).toEqual({
      ...error,
      reason: "tls_error",
    });
  });

  it.each([
    ["an unknown reason", { ...error, reason: "dial 10.0.0.5 refused" }],
    ["a non-string reason", { ...error, reason: 1 }],
    ["an undefined reason key", { ...error, reason: undefined }],
    ["a message field", { ...error, reason: "timeout", message: "socket hang up" }],
  ])("rejects an error with %s", (_label, message) => {
    expect(parseControlMessage(message)).toBeNull();
  });

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

describe("v1 golden forms stay byte-identical", () => {
  it("parses the exact hello, grant, request and control messages it parsed before", () => {
    const hello = { type: "paseo.web.hello", v: 1 };
    const grant = { type: "paseo.web.port", v: 1, generation: 3, limits: DEFAULT_BRIDGE_LIMITS };
    expect(parseHello(hello)).toEqual(hello);
    expect(parsePortGrant(grant)).toEqual(grant);
    expect(parseContentMessage(request, DEFAULT_BRIDGE_LIMITS)).toEqual(request);
    const head = {
      type: "paseo.web.response.head",
      v: 1,
      generation: 1,
      requestId: 1,
      status: 200,
      statusText: "OK",
      headers: [],
    };
    expect(parseControlMessage(head)).toEqual(head);
    expect(parseHello({ ...hello, capabilities: ["lifecycle"] })).toBeNull();
    expect(parsePortGrant({ ...grant, lifecycle: true })).toBeNull();
  });
});

describe("lifecycle messages", () => {
  const token = "AAAAAAAAAAAAAAAAAAAAAA";
  const offer = { type: "paseo.web.lifecycle.offer", v: 1, generation: 2, offer: token };
  const suspend = { type: "paseo.web.suspend", v: 1, generation: 2, reason: "channel_lost" };
  const ready = { type: "paseo.web.lifecycle.ready", v: 1, generation: 2, offer: token };
  const resume = {
    type: "paseo.web.resume",
    v: 1,
    previous: 2,
    generation: 3,
    limits: DEFAULT_BRIDGE_LIMITS,
  };
  const resumed = {
    type: "paseo.web.resumed",
    v: 1,
    previous: 2,
    generation: 3,
    documentKept: true,
  };
  const toBroker = [
    { type: "paseo.web.lifecycle.accept", v: 1, generation: 2, offer: token },
    { type: "paseo.web.lifecycle.state", v: 1, workerArmed: false },
    { type: "paseo.web.suspended", v: 1, generation: 2, documentKept: false },
    {
      type: "paseo.web.navigation.dropped",
      v: 1,
      generation: 2,
      requestId: 7,
      cause: "head_timeout",
    },
  ];

  it("creates tokens in the ticket format", () => {
    const created = createLifecycleToken();
    expect(isLifecycleToken(created)).toBe(true);
    expect(created).toHaveLength(22);
    expect(isLifecycleToken(`${token}=`)).toBe(false);
  });

  it("accepts each exact message on its own parser only", () => {
    expect(parseLifecycleOffer(offer)).toEqual(offer);
    expect(parseLifecycleToShell(ready)).toEqual(ready);
    expect(parseLifecycleToBroker(ready)).toBeNull();
    expect(parseControlMessage(ready)).toBeNull();
    expect(parseLifecycleToShell(suspend)).toEqual(suspend);
    expect(parseLifecycleToShell(resume)).toEqual(resume);
    expect(parseResumed(resumed)).toEqual(resumed);
    for (const message of toBroker) expect(parseLifecycleToBroker(message)).toEqual(message);
    expect(parseLifecycleToBroker(suspend)).toBeNull();
    expect(parseLifecycleToShell(resumed)).toBeNull();
    expect(parseContentMessage(resumed, DEFAULT_BRIDGE_LIMITS)).toBeNull();
    expect(parseControlMessage(offer)).toBeNull();
  });

  it.each([
    ["an extra key", parseLifecycleOffer, { ...offer, url: "https://x.invalid" }],
    ["a short offer", parseLifecycleOffer, { ...offer, offer: "abc" }],
    ["another version", parseLifecycleOffer, { ...offer, v: 2 }],
    ["ready with another version", parseLifecycleToShell, { ...ready, v: 2 }],
    ["ready with generation zero", parseLifecycleToShell, { ...ready, generation: 0 }],
    ["ready with another field", parseLifecycleToShell, { ...ready, capabilities: [] }],
    ["ready with a short token", parseLifecycleToShell, { ...ready, offer: "abc" }],
    ["ready without offer", parseLifecycleToShell, { type: ready.type, v: 1, generation: 2 }],
    ["an unknown reason", parseLifecycleToShell, { ...suspend, reason: "revoked" }],
    ["generation zero", parseLifecycleToShell, { ...suspend, generation: 0 }],
    ["a generation not above previous", parseLifecycleToShell, { ...resume, generation: 2 }],
    [
      "limits whose chunk exceeds the window",
      parseLifecycleToShell,
      {
        ...resume,
        limits: { ...DEFAULT_BRIDGE_LIMITS, maxChunkBytes: DEFAULT_BRIDGE_LIMITS.windowBytes + 1 },
      },
    ],
    ["a resumed without documentKept", parseResumed, { ...resumed, documentKept: undefined }],
    ["a resumed going backwards", parseResumed, { ...resumed, previous: 4 }],
    ["an unknown drop cause", parseLifecycleToBroker, { ...toBroker[3], cause: "revoked" }],
    [
      "a drop with requestId above the limit",
      parseLifecycleToBroker,
      {
        ...toBroker[3],
        requestId: 2 ** 31,
      },
    ],
    ["a state with a string flag", parseLifecycleToBroker, { ...toBroker[1], workerArmed: "yes" }],
  ])("rejects %s", (_label, parse, value) => {
    expect((parse as (data: unknown) => unknown)(value)).toBeNull();
  });

  it("builds suspended replies the current v1 parser already accepts", () => {
    const navigation = suspendedReply("navigate", 9, 4);
    expect(navigation).toEqual({
      type: "paseo.web.response.head",
      v: 1,
      generation: 4,
      requestId: 9,
      status: 204,
      statusText: "",
      headers: [],
    });
    expect(parseControlMessage(navigation)).toEqual(navigation);
    const subresource = suspendedReply("subresource", 10, 4);
    expect(subresource).toEqual({
      type: "paseo.web.response.error",
      v: 1,
      generation: 4,
      requestId: 10,
      code: "transport_error",
      reason: "transport_closed",
    });
    expect(parseControlMessage(subresource)).toEqual(subresource);
  });
});
