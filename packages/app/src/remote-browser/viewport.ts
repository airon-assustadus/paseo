import type { RemoteBrowserViewport } from "@getpaseo/client";
import {
  REMOTE_BROWSER_VIEWPORT_MAX,
  REMOTE_BROWSER_VIEWPORT_MIN,
} from "@getpaseo/protocol/remote-browser/rpc-schemas";

export interface BoxSize {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export const VIEWPORT_MIN_EDGE = REMOTE_BROWSER_VIEWPORT_MIN;
export const VIEWPORT_MAX_EDGE = REMOTE_BROWSER_VIEWPORT_MAX;
// Frames default to a 2x pixel-ratio cap on the daemon, so asking for a higher device scale only
// costs bandwidth without sharper frames.
export const VIEWPORT_MAX_SCALE = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The viewport to request for a pane box. `null` while the box has no positive size: a hidden
 * retained panel measures zero and must not resize the remote page to the minimum edge.
 */
export function requestViewport(input: {
  box: BoxSize;
  devicePixelRatio: number;
  mobile: boolean;
  touch: boolean;
}): RemoteBrowserViewport | null {
  const { box } = input;
  if (!(box.width > 0 && box.height > 0)) {
    return null;
  }
  const scale = Number.isFinite(input.devicePixelRatio) ? input.devicePixelRatio : 1;
  return {
    width: clamp(Math.round(box.width), VIEWPORT_MIN_EDGE, VIEWPORT_MAX_EDGE),
    height: clamp(Math.round(box.height), VIEWPORT_MIN_EDGE, VIEWPORT_MAX_EDGE),
    deviceScaleFactor: clamp(Math.round(scale * 100) / 100, 1, VIEWPORT_MAX_SCALE),
    mobile: input.mobile,
    touch: input.touch,
  };
}

export function viewportsEqual(left: RemoteBrowserViewport, right: RemoteBrowserViewport): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.deviceScaleFactor === right.deviceScaleFactor &&
    left.mobile === right.mobile &&
    left.touch === right.touch
  );
}

/**
 * Where a frame of `content` CSS size is drawn inside `box`: contain-fit, top-left anchored. A
 * frame that matches the box fills it; after a resize the previous frame keeps its aspect ratio
 * until the next one arrives instead of stretching.
 */
export function placeFrame(content: BoxSize, box: BoxSize): Rect {
  if (!(content.width > 0 && content.height > 0 && box.width > 0 && box.height > 0)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.min(box.width / content.width, box.height / content.height);
  return {
    x: 0,
    y: 0,
    width: content.width * scale,
    height: content.height * scale,
  };
}

/**
 * A pane-local point as remote CSS px, or `null` outside the drawn frame. The result is clamped
 * to the page viewport the daemon currently enforces, which can differ from the frame's size for
 * the frames that straddle a resize.
 */
export function mapPointToPage(input: {
  point: Point;
  placement: Rect;
  content: BoxSize;
  viewport: BoxSize;
}): Point | null {
  const { point, placement, content, viewport } = input;
  if (placement.width <= 0 || placement.height <= 0) {
    return null;
  }
  const localX = point.x - placement.x;
  const localY = point.y - placement.y;
  if (localX < 0 || localY < 0 || localX > placement.width || localY > placement.height) {
    return null;
  }
  const x = (localX / placement.width) * content.width;
  const y = (localY / placement.height) * content.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return {
    x: Math.round(clamp(x, 0, viewport.width) * 100) / 100,
    y: Math.round(clamp(y, 0, viewport.height) * 100) / 100,
  };
}
