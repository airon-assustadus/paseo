import { useEffect, type RefObject } from "react";
import type { View } from "react-native";
import type { WheelInput } from "./use-wheel";

export type { WheelInput } from "./use-wheel";

/** Forwards mouse wheel ticks on the surface as page-relative deltas; the page scrolls, not the pane. */
export function useWheel(ref: RefObject<View | null>, onWheel: (input: WheelInput) => void): void {
  useEffect(() => {
    const node: unknown = ref.current;
    if (!(node instanceof HTMLElement)) {
      return;
    }
    const listener = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = node.getBoundingClientRect();
      onWheel({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      });
    };
    node.addEventListener("wheel", listener, { passive: false });
    return () => node.removeEventListener("wheel", listener);
  }, [onWheel, ref]);
}
