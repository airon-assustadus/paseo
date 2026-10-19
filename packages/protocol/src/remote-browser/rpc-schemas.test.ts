import { describe, expect, it } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "../messages.js";
import {
  REMOTE_BROWSER_MAX_INPUT_EVENTS,
  REMOTE_BROWSER_MAX_TITLE_LENGTH,
  REMOTE_BROWSER_MAX_URL_LENGTH,
} from "./rpc-schemas.js";

const browserId = "22222222-2222-4222-8222-222222222222";
const subscriptionId = "11111111-1111-4111-8111-111111111111";
const triple = { browserId, subscriptionId, generation: 1 };
const viewport = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true };
const limits = {
  maxFramesInFlight: 2,
  maxFrameBytes: 1048576,
  maxImageEdge: 1920,
  maxImagePixels: 4194304,
  maxInputEventsPerRequest: 64,
  maxInputRequestsPerSecond: 120,
  detachedTimeoutMs: 60000,
  frameAckTimeoutMs: 30000,
};
const state = {
  url: "http://localhost:3000/",
  title: "Dev server",
  canGoBack: false,
  canGoForward: false,
  loading: false,
  error: null,
  focusedEditable: null,
  viewport,
  visible: true,
  notice: null,
};

describe("remote browser RPC schemas", () => {
  it.each([
    { type: "browser.remote.open.request", requestId: "r", viewport },
    {
      type: "browser.remote.open.request",
      requestId: "r",
      viewport,
      url: "https://example.test/",
      frames: { quality: 60, maxPixelRatio: 2 },
    },
    { type: "browser.remote.attach.request", requestId: "r", browserId },
    { type: "browser.remote.detach.request", requestId: "r", ...triple },
    { type: "browser.remote.close.request", requestId: "r", browserId },
    { type: "browser.remote.close.request", requestId: "r", browserId, expectedGeneration: 4 },
    { type: "browser.remote.list.request", requestId: "r" },
    {
      type: "browser.remote.navigate.request",
      requestId: "r",
      ...triple,
      navigation: { kind: "url", url: "http://localhost:3000" },
    },
    {
      type: "browser.remote.navigate.request",
      requestId: "r",
      ...triple,
      navigation: { kind: "back" },
    },
    {
      type: "browser.remote.dispatch_input.request",
      requestId: "r",
      ...triple,
      events: [
        { kind: "touch", phase: "start", points: [{ id: 0, x: 10, y: 20 }] },
        { kind: "touch", phase: "end", points: [] },
        { kind: "mouse", phase: "down", x: 1, y: 2, button: "left", clickCount: 1, modifiers: 0 },
        { kind: "wheel", x: 1, y: 2, deltaX: 0, deltaY: -120, modifiers: 0 },
        { kind: "key", phase: "press", key: "Enter", modifiers: 0 },
        { kind: "text", text: "olá" },
        { kind: "composition", text: "ol", selectionStart: 2, selectionEnd: 2 },
      ],
    },
    { type: "browser.remote.resize.request", requestId: "r", ...triple, viewport },
    { type: "browser.remote.set_visibility.request", requestId: "r", ...triple, visible: false },
  ])("accepts $type through the inbound envelope", (request) => {
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
  });

  it.each([
    [
      "missing generation",
      { type: "browser.remote.detach.request", requestId: "r", browserId, subscriptionId },
    ],
    [
      "zero generation",
      { type: "browser.remote.detach.request", requestId: "r", ...triple, generation: 0 },
    ],
    ["foreign id shape", { type: "browser.remote.close.request", requestId: "r", browserId: "x" }],
    [
      "tiny viewport",
      { type: "browser.remote.open.request", requestId: "r", viewport: { ...viewport, width: 10 } },
    ],
    [
      "huge scale",
      {
        type: "browser.remote.open.request",
        requestId: "r",
        viewport: { ...viewport, deviceScaleFactor: 5 },
      },
    ],
    [
      "long url",
      {
        type: "browser.remote.open.request",
        requestId: "r",
        viewport,
        url: `http://a/${"x".repeat(REMOTE_BROWSER_MAX_URL_LENGTH)}`,
      },
    ],
    [
      "empty batch",
      { type: "browser.remote.dispatch_input.request", requestId: "r", ...triple, events: [] },
    ],
    [
      "oversized batch",
      {
        type: "browser.remote.dispatch_input.request",
        requestId: "r",
        ...triple,
        events: Array.from({ length: REMOTE_BROWSER_MAX_INPUT_EVENTS + 1 }, () => ({
          kind: "text",
          text: "a",
        })),
      },
    ],
    [
      "non-finite coordinate",
      {
        type: "browser.remote.dispatch_input.request",
        requestId: "r",
        ...triple,
        events: [{ kind: "wheel", x: Number.NaN, y: 0, deltaX: 0, deltaY: 0, modifiers: 0 }],
      },
    ],
    [
      "negative coordinate",
      {
        type: "browser.remote.dispatch_input.request",
        requestId: "r",
        ...triple,
        events: [{ kind: "touch", phase: "move", points: [{ id: 0, x: -1, y: 0 }] }],
      },
    ],
    [
      "too many touch points",
      {
        type: "browser.remote.dispatch_input.request",
        requestId: "r",
        ...triple,
        events: [
          {
            kind: "touch",
            phase: "move",
            points: Array.from({ length: 6 }, (_, id) => ({ id, x: 0, y: 0 })),
          },
        ],
      },
    ],
    [
      "eval-like input kind",
      {
        type: "browser.remote.dispatch_input.request",
        requestId: "r",
        ...triple,
        events: [{ kind: "script", source: "1" }],
      },
    ],
    [
      "unknown navigation",
      {
        type: "browser.remote.navigate.request",
        requestId: "r",
        ...triple,
        navigation: { kind: "evaluate", expression: "1" },
      },
    ],
  ])("rejects %s", (_name, request) => {
    expect(SessionInboundMessageSchema.safeParse(request).success).toBe(false);
  });

  it.each([
    {
      type: "browser.remote.open.response",
      payload: { requestId: "r", ok: true, ...triple, limits, state },
    },
    {
      type: "browser.remote.attach.response",
      payload: {
        requestId: "r",
        ok: false,
        error: { code: "not_found", message: "Unknown remote browser" },
      },
    },
    { type: "browser.remote.detach.response", payload: { requestId: "r", ok: true, browserId } },
    {
      type: "browser.remote.close.response",
      payload: {
        requestId: "r",
        ok: false,
        error: { code: "stale_attachment", message: "Newer attachment" },
      },
    },
    {
      type: "browser.remote.list.response",
      payload: {
        requestId: "r",
        ok: true,
        browsers: [{ browserId, url: "", title: "", attached: false, generation: 2, createdAt: 1 }],
      },
    },
    { type: "browser.remote.navigate.response", payload: { requestId: "r", ok: true } },
    {
      type: "browser.remote.dispatch_input.response",
      payload: { requestId: "r", ok: true, dispatched: 3 },
    },
    { type: "browser.remote.resize.response", payload: { requestId: "r", ok: true, viewport } },
    {
      type: "browser.remote.set_visibility.response",
      payload: { requestId: "r", ok: true, visible: false },
    },
    {
      type: "browser.remote.state",
      payload: {
        subscriptionId,
        browserId,
        generation: 1,
        state: {
          ...state,
          error: { code: "policy_denied", url: "http://169.254.169.254/", message: "Denied" },
          focusedEditable: { inputMode: "text", inputType: "email", enterKeyHint: "go" },
          notice: { kind: "download_blocked", at: 5 },
        },
      },
    },
    {
      type: "browser.remote.detached",
      payload: { subscriptionId, browserId, generation: 1, reason: "superseded" },
    },
    {
      type: "browser.remote.closed",
      payload: { subscriptionId, browserId, reason: "memory_limit" },
    },
  ])("accepts $type through the outbound envelope", (message) => {
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  it("accepts codes this version does not know, so newer daemons stay parseable", () => {
    const message = {
      type: "browser.remote.closed",
      payload: { subscriptionId, browserId, reason: "some_future_reason" },
    };
    expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(true);
  });

  it("bounds page-controlled strings", () => {
    const message = {
      type: "browser.remote.state",
      payload: {
        subscriptionId,
        browserId,
        generation: 1,
        state: { ...state, title: "t".repeat(REMOTE_BROWSER_MAX_TITLE_LENGTH + 1) },
      },
    };
    expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(false);
  });

  it("keeps the feature flag optional in server_info", () => {
    const base = { status: "server_info", serverId: "srv" };
    expect(ServerInfoStatusPayloadSchema.safeParse(base).success).toBe(true);
    const parsed = ServerInfoStatusPayloadSchema.parse({
      ...base,
      features: { remoteBrowser: true },
    });
    expect(parsed.features?.remoteBrowser).toBe(true);
  });
});
