import type { RemoteBrowserViewport } from "@getpaseo/protocol/remote-browser/rpc-schemas";

export interface RasterCeiling {
  maxImageEdge: number;
  maxImagePixels: number;
}

export interface ScreencastSize {
  scale: number;
  maxWidth: number;
  maxHeight: number;
}

export const MIN_OVERSIZE_FACTOR = 0.5;
export const OVERSIZE_FACTOR_STEP = 0.75;

/**
 * Image size for the screencast. The ceiling applies whatever the viewport and pixel ratio ask
 * for; `reduction` (≤ 1, after oversized frames) multiplies the clamped scale, so it only shrinks.
 */
export function screencastSize(input: {
  viewport: RemoteBrowserViewport;
  maxPixelRatio: number;
  ceiling: RasterCeiling;
  reduction: number;
}): ScreencastSize {
  const { width, height, deviceScaleFactor } = input.viewport;
  const clamped = Math.min(
    deviceScaleFactor,
    input.maxPixelRatio,
    input.ceiling.maxImageEdge / Math.max(width, height),
    Math.sqrt(input.ceiling.maxImagePixels / (width * height)),
  );
  const scale = clamped * Math.min(1, Math.max(MIN_OVERSIZE_FACTOR, input.reduction));
  return {
    scale,
    maxWidth: Math.max(1, Math.floor(width * scale)),
    maxHeight: Math.max(1, Math.floor(height * scale)),
  };
}

export function withinRaster(
  image: { width: number; height: number },
  ceiling: RasterCeiling,
): boolean {
  return (
    image.width <= ceiling.maxImageEdge &&
    image.height <= ceiling.maxImageEdge &&
    image.width * image.height <= ceiling.maxImagePixels
  );
}

/** JPEG SOF0/SOF2 dimensions; null when the bytes are not a baseline/progressive JPEG. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (marker >= 0xc0 && marker <= 0xc3) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}
