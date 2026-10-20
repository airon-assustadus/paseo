import type { RemoteBrowserInputEvent } from "@getpaseo/client";
import {
  REMOTE_BROWSER_MAX_INPUT_EVENTS,
  REMOTE_BROWSER_MAX_WHEEL_DELTA,
} from "@getpaseo/protocol/remote-browser/rpc-schemas";

type RemoteBrowserTouchEvent = Extract<RemoteBrowserInputEvent, { kind: "touch" }>;
type RemoteBrowserMouseEvent = Extract<RemoteBrowserInputEvent, { kind: "mouse" }>;
export type RemoteBrowserTouchPhase = RemoteBrowserTouchEvent["phase"];
export type RemoteBrowserTouchPoint = RemoteBrowserTouchEvent["points"][number];
export type RemoteBrowserMousePhase = RemoteBrowserMouseEvent["phase"];
export type RemoteBrowserMouseButton = RemoteBrowserMouseEvent["button"];

export const INPUT_EVENTS_PER_BATCH = REMOTE_BROWSER_MAX_INPUT_EVENTS;
export const WHEEL_DELTA_LIMIT = REMOTE_BROWSER_MAX_WHEEL_DELTA;

export interface PointerTranslator {
  touch(phase: RemoteBrowserTouchPhase, points: RemoteBrowserTouchPoint[]): void;
  mouse(input: {
    phase: RemoteBrowserMousePhase;
    x: number;
    y: number;
    button: RemoteBrowserMouseButton;
    clickCount: number;
    modifiers?: number;
  }): void;
  wheel(input: { x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }): void;
  /** Hand every pending event to the sink in schema-sized batches. */
  flush(): void;
  pendingCount(): number;
}

function clampDelta(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-WHEEL_DELTA_LIMIT, Math.min(WHEEL_DELTA_LIMIT, Math.round(value)));
}

function samePointIds(left: RemoteBrowserTouchPoint[], right: RemoteBrowserTouchPoint[]): boolean {
  return left.length === right.length && left.every((point, index) => point.id === right[index].id);
}

/**
 * Buffers pointer events between flushes (the pane flushes once per animation frame) and keeps the
 * buffer small: consecutive moves of the same pointers collapse to the latest one, consecutive wheel
 * ticks at one position add up. Starts, ends and cancels are never collapsed, so a tap stays a tap.
 */
export function createPointerTranslator(input: {
  sink: (events: RemoteBrowserInputEvent[]) => void;
  maxEventsPerBatch?: number;
}): PointerTranslator {
  const maxEventsPerBatch = input.maxEventsPerBatch ?? INPUT_EVENTS_PER_BATCH;
  const pending: RemoteBrowserInputEvent[] = [];

  function last(): RemoteBrowserInputEvent | undefined {
    return pending[pending.length - 1];
  }

  return {
    touch(phase, points) {
      const previous = last();
      if (
        phase === "move" &&
        previous?.kind === "touch" &&
        previous.phase === "move" &&
        samePointIds(previous.points, points)
      ) {
        pending[pending.length - 1] = { kind: "touch", phase, points };
        return;
      }
      pending.push({ kind: "touch", phase, points });
    },
    mouse({ phase, x, y, button, clickCount, modifiers = 0 }) {
      const previous = last();
      const event: RemoteBrowserInputEvent = {
        kind: "mouse",
        phase,
        x,
        y,
        button,
        clickCount,
        modifiers,
      };
      if (phase === "move" && previous?.kind === "mouse" && previous.phase === "move") {
        pending[pending.length - 1] = event;
        return;
      }
      pending.push(event);
    },
    wheel({ x, y, deltaX, deltaY, modifiers = 0 }) {
      const previous = last();
      if (
        previous?.kind === "wheel" &&
        previous.x === x &&
        previous.y === y &&
        previous.modifiers === modifiers
      ) {
        pending[pending.length - 1] = {
          kind: "wheel",
          x,
          y,
          deltaX: clampDelta(previous.deltaX + deltaX),
          deltaY: clampDelta(previous.deltaY + deltaY),
          modifiers,
        };
        return;
      }
      pending.push({
        kind: "wheel",
        x,
        y,
        deltaX: clampDelta(deltaX),
        deltaY: clampDelta(deltaY),
        modifiers,
      });
    },
    flush() {
      if (pending.length === 0) {
        return;
      }
      const events = pending.splice(0);
      for (let start = 0; start < events.length; start += maxEventsPerBatch) {
        input.sink(events.slice(start, start + maxEventsPerBatch));
      }
    },
    pendingCount() {
      return pending.length;
    },
  };
}
