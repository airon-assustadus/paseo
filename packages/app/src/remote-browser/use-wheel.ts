import type { RefObject } from "react";
import type { View } from "react-native";

export interface WheelInput {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
}

/** Mouse wheels exist on web only; native touch scrolls through the gesture path. */
export function useWheel(
  _ref: RefObject<View | null>,
  _onWheel: (input: WheelInput) => void,
): void {}
