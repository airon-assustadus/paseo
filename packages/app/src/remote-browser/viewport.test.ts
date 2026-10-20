import { describe, expect, it } from "vitest";
import {
  mapPointToPage,
  placeFrame,
  requestViewport,
  VIEWPORT_MAX_EDGE,
  VIEWPORT_MAX_SCALE,
  VIEWPORT_MIN_EDGE,
} from "./viewport";

describe("requestViewport", () => {
  it("rounds the box, clamps edges and caps the device scale", () => {
    expect(
      requestViewport({
        box: { width: 393.4, height: 5000 },
        devicePixelRatio: 2.75,
        mobile: true,
        touch: true,
      }),
    ).toEqual({
      width: 393,
      height: VIEWPORT_MAX_EDGE,
      deviceScaleFactor: VIEWPORT_MAX_SCALE,
      mobile: true,
      touch: true,
    });
    expect(
      requestViewport({
        box: { width: 120, height: 150 },
        devicePixelRatio: 0.5,
        mobile: false,
        touch: false,
      }),
    ).toEqual({
      width: VIEWPORT_MIN_EDGE,
      height: VIEWPORT_MIN_EDGE,
      deviceScaleFactor: 1,
      mobile: false,
      touch: false,
    });
  });

  it("refuses a hidden box so a retained panel never resizes the page to the minimum", () => {
    expect(
      requestViewport({
        box: { width: 0, height: 0 },
        devicePixelRatio: 2,
        mobile: true,
        touch: true,
      }),
    ).toBeNull();
    expect(
      requestViewport({
        box: { width: 300, height: -1 },
        devicePixelRatio: 2,
        mobile: true,
        touch: true,
      }),
    ).toBeNull();
  });
});

describe("placeFrame and mapPointToPage", () => {
  it("fills the box when the frame matches it and maps corners to the viewport extremes", () => {
    const placement = placeFrame({ width: 400, height: 800 }, { width: 400, height: 800 });
    expect(placement).toEqual({ x: 0, y: 0, width: 400, height: 800 });
    const content = { width: 400, height: 800 };
    const viewport = { width: 400, height: 800 };
    expect(mapPointToPage({ point: { x: 0, y: 0 }, placement, content, viewport })).toEqual({
      x: 0,
      y: 0,
    });
    expect(mapPointToPage({ point: { x: 400, y: 800 }, placement, content, viewport })).toEqual({
      x: 400,
      y: 800,
    });
    expect(mapPointToPage({ point: { x: 100.333, y: 250 }, placement, content, viewport })).toEqual(
      {
        x: 100.33,
        y: 250,
      },
    );
  });

  it("keeps the previous frame's aspect ratio after a resize and ignores taps outside it", () => {
    const content = { width: 400, height: 800 };
    const placement = placeFrame(content, { width: 300, height: 800 });
    expect(placement).toEqual({ x: 0, y: 0, width: 300, height: 600 });
    const viewport = { width: 300, height: 800 };
    expect(mapPointToPage({ point: { x: 150, y: 300 }, placement, content, viewport })).toEqual({
      x: 200,
      y: 400,
    });
    expect(mapPointToPage({ point: { x: 150, y: 700 }, placement, content, viewport })).toBeNull();
  });

  it("clamps to the viewport the daemon enforces when the frame is larger than it", () => {
    const content = { width: 400, height: 800 };
    const placement = placeFrame(content, { width: 400, height: 800 });
    const viewport = { width: 300, height: 600 };
    expect(mapPointToPage({ point: { x: 390, y: 790 }, placement, content, viewport })).toEqual({
      x: 300,
      y: 600,
    });
  });

  it("returns null for a frame that has not been drawn yet", () => {
    const placement = placeFrame({ width: 0, height: 0 }, { width: 400, height: 800 });
    expect(placement.width).toBe(0);
    expect(
      mapPointToPage({
        point: { x: 10, y: 10 },
        placement,
        content: { width: 0, height: 0 },
        viewport: { width: 400, height: 800 },
      }),
    ).toBeNull();
  });
});
