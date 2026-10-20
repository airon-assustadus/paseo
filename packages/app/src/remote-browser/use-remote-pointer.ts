import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type { View } from "react-native";
import {
  Gesture,
  PointerType,
  type GestureTouchEvent,
  type GestureType,
} from "react-native-gesture-handler";
import type { RemoteBrowserInputEvent } from "@getpaseo/client";
import {
  createPointerTranslator,
  type RemoteBrowserMouseButton,
  type RemoteBrowserMousePhase,
} from "./pointer";
import { useWheel } from "./use-wheel";
import type { Point } from "./viewport";

function changedPoint(event: GestureTouchEvent): Point {
  return { x: event.changedTouches[0]?.x ?? 0, y: event.changedTouches[0]?.y ?? 0 };
}

/**
 * Turns the pane's manual gesture into page input: touches travel as touch events so Chromium's
 * gesture recognizer scrolls and taps; a mouse travels as mouse events so a drag selects instead of
 * scrolling; wheel ticks scroll the page. Events are batched once per animation frame.
 */
export function useRemotePointer(input: {
  surfaceRef: RefObject<View | null>;
  dispatch: (events: RemoteBrowserInputEvent[]) => void;
  inputEnabled: boolean;
  /** Pane-local point to page CSS pixels; null while no frame has been placed. */
  toPage: (point: Point) => Point | null;
  /** Runs on every touch down, before any input: focus the pane and commit pending typing. */
  onPointerDown: () => void;
  onFocusPane?: () => void;
}): GestureType {
  const { surfaceRef, dispatch, inputEnabled, toPage, onPointerDown, onFocusPane } = input;
  const translator = useMemo(() => createPointerTranslator({ sink: dispatch }), [dispatch]);
  const flushHandle = useRef<number | null>(null);
  const scheduleFlush = useCallback(() => {
    if (flushHandle.current !== null) {
      return;
    }
    flushHandle.current = requestAnimationFrame(() => {
      flushHandle.current = null;
      translator.flush();
    });
  }, [translator]);
  useEffect(
    () => () => {
      if (flushHandle.current !== null) cancelAnimationFrame(flushHandle.current);
    },
    [],
  );

  const touchPoints = useCallback(
    (event: GestureTouchEvent) =>
      event.allTouches.flatMap((touch) => {
        const point = toPage({ x: touch.x, y: touch.y });
        return point ? [{ id: touch.id % 10, x: point.x, y: point.y }] : [];
      }),
    [toPage],
  );

  const mouse = useCallback(
    (
      event: GestureTouchEvent,
      phase: RemoteBrowserMousePhase,
      button: RemoteBrowserMouseButton,
    ) => {
      const point = toPage(changedPoint(event));
      if (!point) return;
      translator.mouse({
        phase,
        x: point.x,
        y: point.y,
        button,
        clickCount: phase === "move" ? 0 : 1,
      });
    },
    [toPage, translator],
  );

  const gesture = useMemo(
    () =>
      Gesture.Manual()
        .runOnJS(true)
        .onTouchesDown((event) => {
          onFocusPane?.();
          if (!inputEnabled) return;
          onPointerDown();
          if (event.pointerType === PointerType.MOUSE) {
            // Chromium needs the hover position before the press lands on the right element.
            mouse(event, "move", "none");
            mouse(event, "down", "left");
          } else {
            const points = touchPoints(event);
            if (points.length > 0) translator.touch("start", points);
          }
          scheduleFlush();
        })
        .onTouchesMove((event) => {
          if (!inputEnabled) return;
          if (event.pointerType === PointerType.MOUSE) {
            mouse(event, "move", "left");
          } else {
            const points = touchPoints(event);
            if (points.length > 0) translator.touch("move", points);
          }
          scheduleFlush();
        })
        .onTouchesUp((event) => {
          if (!inputEnabled) return;
          if (event.pointerType === PointerType.MOUSE) {
            mouse(event, "up", "left");
          } else {
            translator.touch(event.numberOfTouches === 0 ? "end" : "move", touchPoints(event));
          }
          scheduleFlush();
        })
        .onTouchesCancelled(() => {
          if (!inputEnabled) return;
          translator.touch("cancel", []);
          scheduleFlush();
        }),
    [inputEnabled, mouse, onFocusPane, onPointerDown, scheduleFlush, touchPoints, translator],
  );

  useWheel(
    surfaceRef,
    useCallback(
      ({ x, y, deltaX, deltaY }) => {
        if (!inputEnabled) return;
        const point = toPage({ x, y });
        if (!point) return;
        translator.wheel({ x: point.x, y: point.y, deltaX, deltaY });
        scheduleFlush();
      },
      [inputEnabled, scheduleFlush, toPage, translator],
    ),
  );

  return gesture;
}
