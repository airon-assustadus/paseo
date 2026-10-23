export interface SurfaceBounds {
  left: number;
  top: number;
  width: number;
  height: number;
  clipLeft: number;
  clipTop: number;
  clipRight: number;
  clipBottom: number;
}

function clips(overflow: string): boolean {
  return (
    overflow === "hidden" || overflow === "clip" || overflow === "auto" || overflow === "scroll"
  );
}

export function measureSurface(anchor: HTMLElement): SurfaceBounds | null {
  if (!anchor.isConnected) return null;
  const rect = anchor.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  let clipLeft = Math.max(left, rect.left);
  let clipTop = Math.max(top, rect.top);
  let clipRight = Math.min(left + (viewport?.width ?? window.innerWidth), rect.right);
  let clipBottom = Math.min(top + (viewport?.height ?? window.innerHeight), rect.bottom);
  for (let node: HTMLElement | null = anchor; node !== null; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (style.visibility !== "visible" || style.display === "none") return null;
    const bounds = node.getBoundingClientRect();
    if (clips(style.overflowX)) {
      clipLeft = Math.max(clipLeft, bounds.left + node.clientLeft);
      clipRight = Math.min(clipRight, bounds.left + node.clientLeft + node.clientWidth);
    }
    if (clips(style.overflowY)) {
      clipTop = Math.max(clipTop, bounds.top + node.clientTop);
      clipBottom = Math.min(clipBottom, bounds.top + node.clientTop + node.clientHeight);
    }
  }
  clipLeft = Math.ceil(clipLeft);
  clipTop = Math.ceil(clipTop);
  clipRight = Math.floor(clipRight);
  clipBottom = Math.floor(clipBottom);
  if (clipRight <= clipLeft || clipBottom <= clipTop) return null;
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    clipLeft,
    clipTop,
    clipRight,
    clipBottom,
  };
}

export function placeSurface(input: {
  window: HTMLElement;
  container: HTMLElement;
  bounds: SurfaceBounds;
}): void {
  const { window: clipWindow, container, bounds } = input;
  Object.assign(clipWindow.style, {
    left: `${bounds.clipLeft}px`,
    top: `${bounds.clipTop}px`,
    width: `${bounds.clipRight - bounds.clipLeft}px`,
    height: `${bounds.clipBottom - bounds.clipTop}px`,
  });
  Object.assign(container.style, {
    left: `${bounds.left - bounds.clipLeft}px`,
    top: `${bounds.top - bounds.clipTop}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
  });
}
