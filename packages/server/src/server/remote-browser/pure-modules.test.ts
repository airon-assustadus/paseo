import { describe, expect, it } from "vitest";
import {
  REMOTE_BROWSER_MAX_STATE_BYTES,
  type RemoteBrowserState,
} from "@getpaseo/protocol/remote-browser/rpc-schemas";
import { SessionOutboundMessageSchema } from "../messages.js";
import { RemoteBrowserInputError, mapInputEvent } from "./input-mapping.js";
import { buildStateMessage, truncateText } from "./state-budget.js";
import { jpegDimensions, screencastSize, withinRaster } from "./frame-geometry.js";

const viewport = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true };
const ceiling = { maxImageEdge: 1920, maxImagePixels: 4194304 };

describe("input mapping", () => {
  it("maps touch, mouse, wheel, text and composition to closed CDP commands", () => {
    expect(
      mapInputEvent({ kind: "touch", phase: "start", points: [{ id: 0, x: 10, y: 20 }] }, viewport),
    ).toEqual([
      {
        method: "Input.dispatchTouchEvent",
        params: { type: "touchStart", touchPoints: [{ x: 10, y: 20, id: 0 }] },
      },
    ]);
    expect(mapInputEvent({ kind: "touch", phase: "end", points: [] }, viewport)[0].params).toEqual({
      type: "touchEnd",
      touchPoints: [],
    });
    expect(
      mapInputEvent(
        { kind: "mouse", phase: "down", x: 5, y: 6, button: "left", clickCount: 1, modifiers: 0 },
        viewport,
      )[0].params,
    ).toMatchObject({ type: "mousePressed", button: "left", clickCount: 1 });
    expect(
      mapInputEvent(
        { kind: "wheel", x: 1, y: 1, deltaX: 0, deltaY: 120, modifiers: 0 },
        viewport,
      )[0].params,
    ).toMatchObject({ type: "mouseWheel", deltaY: 120 });
    expect(mapInputEvent({ kind: "text", text: "olá" }, viewport)).toEqual([
      { method: "Input.insertText", params: { text: "olá" } },
    ]);
    expect(
      mapInputEvent(
        { kind: "composition", text: "ol", selectionStart: 2, selectionEnd: 2 },
        viewport,
      ),
    ).toEqual([
      {
        method: "Input.imeSetComposition",
        params: { text: "ol", selectionStart: 2, selectionEnd: 2 },
      },
    ]);
  });

  it("maps keys with text only when no shortcut modifier is held", () => {
    const enter = mapInputEvent(
      { kind: "key", phase: "press", key: "Enter", modifiers: 0 },
      viewport,
    );
    expect(enter.map((command) => command.params.type)).toEqual(["keyDown", "keyUp"]);
    expect(enter[0].params).toMatchObject({ text: "\r", windowsVirtualKeyCode: 13 });
    const ctrlA = mapInputEvent({ kind: "key", phase: "down", key: "a", modifiers: 2 }, viewport);
    expect(ctrlA[0].params).toMatchObject({ type: "rawKeyDown", code: "KeyA", modifiers: 2 });
    expect(ctrlA[0].params).not.toHaveProperty("text");
    expect(
      mapInputEvent({ kind: "key", phase: "down", key: "ç", modifiers: 0 }, viewport)[0].params,
    ).toMatchObject({ type: "keyDown", text: "ç" });
  });

  it.each([
    ["outside the viewport", { kind: "touch", phase: "move", points: [{ id: 0, x: 391, y: 1 }] }],
    ["a touch start without points", { kind: "touch", phase: "start", points: [] }],
    ["a multi-character key", { kind: "key", phase: "press", key: "F12", modifiers: 0 }],
    ["a control character key", { kind: "key", phase: "press", key: "\u0007", modifiers: 0 }],
    [
      "a composition selection past the text",
      { kind: "composition", text: "a", selectionStart: 2, selectionEnd: 2 },
    ],
    [
      "a reversed composition selection",
      { kind: "composition", text: "ab", selectionStart: 2, selectionEnd: 1 },
    ],
  ] as const)("rejects %s", (_name, event) => {
    expect(() => mapInputEvent(event, viewport)).toThrow(RemoteBrowserInputError);
  });
});

const state: RemoteBrowserState = {
  url: "http://localhost:3000/",
  title: "",
  canGoBack: false,
  canGoForward: false,
  loading: false,
  error: null,
  focusedEditable: null,
  viewport,
  visible: true,
  notice: null,
};
const ids = {
  subscriptionId: "11111111-1111-4111-8111-111111111111",
  browserId: "22222222-2222-4222-8222-222222222222",
  generation: 1,
};

describe("state budget", () => {
  it("never splits a surrogate pair", () => {
    expect(truncateText("a😀", 2)).toBe("a");
    expect(truncateText("abc", 2)).toBe("ab");
  });

  it.each([
    ["control characters", "\u0001".repeat(5000)],
    ["quotes and backslashes", '"\\'.repeat(5000)],
    ["astral characters", "😀".repeat(5000)],
  ])("keeps escape-heavy %s within the serialized budget and the schema", (_name, title) => {
    const message = buildStateMessage({
      ...ids,
      state: {
        ...state,
        url: `http://x/${"\u0002".repeat(9000)}`,
        title,
        error: { code: "failed", url: "\u0003".repeat(9000), message: "\u0004".repeat(2000) },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(message), "utf8")).toBeLessThanOrEqual(
      REMOTE_BROWSER_MAX_STATE_BYTES,
    );
    expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(true);
    expect(message.payload.state.title.length).toBeGreaterThan(0);
  });

  it("leaves ordinary state untouched", () => {
    expect(buildStateMessage({ ...ids, state }).payload.state).toEqual(state);
  });

  it("keeps focus identity and composing while bounding hint strings", () => {
    const focused = {
      ...state,
      focusedEditable: {
        inputMode: "x".repeat(100),
        inputType: "text",
        enterKeyHint: "",
        focusId: 9,
        composing: true,
      },
    };
    expect(buildStateMessage({ ...ids, state: focused }).payload.state.focusedEditable).toEqual({
      inputMode: "x".repeat(32),
      inputType: "text",
      enterKeyHint: "",
      focusId: 9,
      composing: true,
    });
  });
});

describe("frame geometry", () => {
  it("caps the raster independently of viewport and pixel ratio", () => {
    const huge = screencastSize({
      viewport: { ...viewport, width: 4096, height: 4096, deviceScaleFactor: 4 },
      maxPixelRatio: 3,
      ceiling,
      reduction: 1,
    });
    expect(huge.maxWidth).toBeLessThanOrEqual(1920);
    expect(huge.maxWidth * huge.maxHeight).toBeLessThanOrEqual(4194304);
    const phone = screencastSize({ viewport, maxPixelRatio: 2, ceiling, reduction: 1 });
    expect(phone).toEqual({ scale: 2, maxWidth: 780, maxHeight: 1688 });
  });

  it("only shrinks when the oversize reduction applies, down to its floor", () => {
    const base = screencastSize({ viewport, maxPixelRatio: 2, ceiling, reduction: 1 });
    const reduced = screencastSize({ viewport, maxPixelRatio: 2, ceiling, reduction: 0.75 });
    const floor = screencastSize({ viewport, maxPixelRatio: 2, ceiling, reduction: 0.1 });
    const above = screencastSize({ viewport, maxPixelRatio: 2, ceiling, reduction: 2 });
    expect(reduced.scale).toBeCloseTo(base.scale * 0.75);
    expect(floor.scale).toBeCloseTo(base.scale * 0.5);
    expect(above.scale).toBe(base.scale);
  });

  it("checks raster bounds and reads JPEG dimensions", () => {
    expect(withinRaster({ width: 1920, height: 1080 }, ceiling)).toBe(true);
    expect(withinRaster({ width: 1921, height: 10 }, ceiling)).toBe(false);
    expect(withinRaster({ width: 1920, height: 1920 }, { ...ceiling, maxImagePixels: 100 })).toBe(
      false,
    );
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x06, 0x98,
      0x03, 0x0c, 0x03, 0x01, 0x22, 0x00,
    ]);
    expect(jpegDimensions(jpeg)).toEqual({ width: 780, height: 1688 });
    expect(jpegDimensions(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});
