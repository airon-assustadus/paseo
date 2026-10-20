import { createElement, useEffect, useMemo, useRef, type CSSProperties } from "react";
import type { FrameViewProps } from "./frame-view-props";

/** Draws or reports false; a throwing canvas (lost context, tainted source) is a failed paint. */
function drawInto(
  canvas: HTMLCanvasElement,
  source: CanvasImageSource,
  width: number,
  height: number,
): boolean {
  try {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return false;
    }
    context.drawImage(source, 0, 0);
    return true;
  } catch {
    return false;
  }
}

async function drawBitmap(
  canvas: HTMLCanvasElement,
  blob: Blob,
  signal: { cancelled: boolean },
): Promise<boolean> {
  let decoded: ImageBitmap;
  try {
    decoded = await createImageBitmap(blob);
  } catch {
    return false;
  }
  try {
    return signal.cancelled ? false : drawInto(canvas, decoded, decoded.width, decoded.height);
  } finally {
    decoded.close();
  }
}

/** Fallback for browsers without `createImageBitmap`: an object URL that is revoked either way. */
function drawImageElement(
  canvas: HTMLCanvasElement,
  blob: Blob,
  signal: { cancelled: boolean },
  report: (drawn: boolean) => void,
): () => void {
  const objectUrl = URL.createObjectURL(blob);
  const image = new window.Image();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    URL.revokeObjectURL(objectUrl);
    image.removeEventListener("load", onLoad);
    image.removeEventListener("error", onError);
    image.src = "";
  };
  function onLoad() {
    const drawn = signal.cancelled
      ? false
      : drawInto(canvas, image, image.naturalWidth, image.naturalHeight);
    release();
    if (!signal.cancelled) report(drawn);
  }
  function onError() {
    release();
    if (!signal.cancelled) report(false);
  }
  image.addEventListener("load", onLoad);
  image.addEventListener("error", onError);
  image.src = objectUrl;
  return release;
}

/**
 * Web presenter: decodes each JPEG into a canvas and reports the paint on the next animation frame
 * after the draw. A decode or draw failure is reported as such, never as a paint, and nothing is
 * kept once drawn: bitmaps are closed and object URLs revoked.
 */
export function FrameView({
  frame,
  placement,
  accessibilityLabel,
  onPainted,
  onPresentationFailed,
}: FrameViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!frame) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      onPresentationFailed(frame);
      return;
    }
    const signal = { cancelled: false };
    let paintHandle = 0;
    const report = (drawn: boolean) => {
      if (signal.cancelled) return;
      if (!drawn) {
        onPresentationFailed(frame);
        return;
      }
      paintHandle = requestAnimationFrame(() => {
        if (!signal.cancelled) onPainted(frame);
      });
    };
    const blob = new Blob([new Uint8Array(frame.bytes)], { type: frame.mimeType });
    let release = () => {};
    if (typeof createImageBitmap === "function") {
      void drawBitmap(canvas, blob, signal).then(report);
    } else {
      release = drawImageElement(canvas, blob, signal, report);
    }
    return () => {
      signal.cancelled = true;
      cancelAnimationFrame(paintHandle);
      release();
    };
  }, [frame, onPainted, onPresentationFailed]);

  const style = useMemo<CSSProperties>(
    () => ({
      position: "absolute",
      left: placement.x,
      top: placement.y,
      width: placement.width,
      height: placement.height,
      display: frame ? "block" : "none",
      touchAction: "none",
      userSelect: "none",
    }),
    [frame, placement.height, placement.width, placement.x, placement.y],
  );

  return createElement("canvas", {
    ref: canvasRef,
    role: "img",
    "aria-label": accessibilityLabel,
    "data-testid": "remote-browser-frame",
    style,
  });
}
