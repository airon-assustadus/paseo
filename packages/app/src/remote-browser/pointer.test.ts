import { describe, expect, it } from "vitest";
import type { RemoteBrowserInputEvent } from "@getpaseo/client";
import { createPointerTranslator, INPUT_EVENTS_PER_BATCH, WHEEL_DELTA_LIMIT } from "./pointer";

function harness(maxEventsPerBatch?: number) {
  const batches: RemoteBrowserInputEvent[][] = [];
  const translator = createPointerTranslator({
    sink: (events) => batches.push(events),
    maxEventsPerBatch,
  });
  return { translator, batches };
}

describe("pointer translator", () => {
  it("keeps a tap as start and end in order", () => {
    const { translator, batches } = harness();
    translator.touch("start", [{ id: 0, x: 10, y: 20 }]);
    translator.touch("end", []);
    expect(translator.pendingCount()).toBe(2);
    translator.flush();
    expect(batches).toEqual([
      [
        { kind: "touch", phase: "start", points: [{ id: 0, x: 10, y: 20 }] },
        { kind: "touch", phase: "end", points: [] },
      ],
    ]);
    translator.flush();
    expect(batches).toHaveLength(1);
  });

  it("collapses consecutive touch moves of the same pointers to the latest one", () => {
    const { translator, batches } = harness();
    translator.touch("start", [{ id: 0, x: 0, y: 0 }]);
    for (let step = 1; step <= 30; step += 1) {
      translator.touch("move", [{ id: 0, x: step, y: step * 2 }]);
    }
    translator.touch("move", [
      { id: 0, x: 31, y: 62 },
      { id: 1, x: 5, y: 5 },
    ]);
    translator.touch("end", []);
    translator.flush();
    expect(batches[0].map((event) => (event.kind === "touch" ? event.phase : event.kind))).toEqual([
      "start",
      "move",
      "move",
      "end",
    ]);
    expect(batches[0][1]).toEqual({
      kind: "touch",
      phase: "move",
      points: [{ id: 0, x: 30, y: 60 }],
    });
  });

  it("collapses mouse moves but keeps down and up", () => {
    const { translator, batches } = harness();
    translator.mouse({ phase: "move", x: 1, y: 1, button: "none", clickCount: 0 });
    translator.mouse({ phase: "move", x: 2, y: 2, button: "none", clickCount: 0 });
    translator.mouse({ phase: "down", x: 2, y: 2, button: "left", clickCount: 1 });
    translator.mouse({ phase: "up", x: 2, y: 2, button: "left", clickCount: 1 });
    translator.flush();
    expect(batches[0]).toEqual([
      { kind: "mouse", phase: "move", x: 2, y: 2, button: "none", clickCount: 0, modifiers: 0 },
      { kind: "mouse", phase: "down", x: 2, y: 2, button: "left", clickCount: 1, modifiers: 0 },
      { kind: "mouse", phase: "up", x: 2, y: 2, button: "left", clickCount: 1, modifiers: 0 },
    ]);
  });

  it("adds up wheel ticks at one position and clamps them to the schema limit", () => {
    const { translator, batches } = harness();
    translator.wheel({ x: 10, y: 10, deltaX: 0, deltaY: 120.4 });
    translator.wheel({ x: 10, y: 10, deltaX: 0, deltaY: 80 });
    translator.wheel({ x: 10, y: 10, deltaX: 0, deltaY: WHEEL_DELTA_LIMIT });
    translator.wheel({ x: 11, y: 10, deltaX: Number.NaN, deltaY: -40 });
    translator.flush();
    expect(batches[0]).toEqual([
      { kind: "wheel", x: 10, y: 10, deltaX: 0, deltaY: WHEEL_DELTA_LIMIT, modifiers: 0 },
      { kind: "wheel", x: 11, y: 10, deltaX: 0, deltaY: -40, modifiers: 0 },
    ]);
  });

  it("splits a flush into schema-sized batches", () => {
    const { translator, batches } = harness();
    for (let step = 0; step < INPUT_EVENTS_PER_BATCH + 3; step += 1) {
      translator.touch("start", [{ id: step % 10, x: step, y: step }]);
    }
    translator.flush();
    expect(batches.map((batch) => batch.length)).toEqual([INPUT_EVENTS_PER_BATCH, 3]);
  });

  it("honours a smaller batch size", () => {
    const { translator, batches } = harness(2);
    translator.touch("start", [{ id: 0, x: 0, y: 0 }]);
    translator.touch("end", []);
    translator.touch("start", [{ id: 0, x: 1, y: 1 }]);
    translator.flush();
    expect(batches.map((batch) => batch.length)).toEqual([2, 1]);
  });
});
