import { describe, expect, it } from "vitest";
import { createFramePipeline } from "./frames";
import type { RemoteBrowserFrame } from "@getpaseo/client";

function frame(seq: number, generation = 1): RemoteBrowserFrame {
  return {
    subscriptionId: "sub",
    generation,
    seq,
    cssWidth: 400,
    cssHeight: 800,
    imageWidth: 800,
    imageHeight: 1600,
    mimeType: "image/jpeg",
    bytes: new Uint8Array([seq]),
  };
}

function harness(generation = 1) {
  const presented: number[] = [];
  const acked: number[] = [];
  const pipeline = createFramePipeline({
    generation,
    present: (next) => presented.push(next.seq),
    ack: (next) => acked.push(next.seq),
  });
  return { pipeline, presented, acked };
}

describe("frame pipeline", () => {
  it("acks a frame only after it was painted, then presents the next one", () => {
    const { pipeline, presented, acked } = harness();
    const first = frame(1);
    pipeline.receive(first);
    expect(presented).toEqual([1]);
    expect(acked).toEqual([]);
    pipeline.painted(first);
    expect(acked).toEqual([1]);
    expect(pipeline.queuedCount()).toBe(0);
  });

  it("paints and acks both in-flight frames in order when the second arrives before the first paint", () => {
    const { pipeline, presented, acked } = harness();
    const first = frame(1);
    const second = frame(2);
    pipeline.receive(first);
    pipeline.receive(second);
    expect(presented).toEqual([1]);
    expect(pipeline.queuedCount()).toBe(2);
    pipeline.painted(first);
    expect(acked).toEqual([1]);
    expect(presented).toEqual([1, 2]);
    pipeline.painted(second);
    expect(acked).toEqual([1, 2]);
    expect(pipeline.queuedCount()).toBe(0);
  });

  it("never strands credit across a long session with frames arriving two at a time", () => {
    const { pipeline, presented, acked } = harness();
    const inFlight: RemoteBrowserFrame[] = [];
    let seq = 0;
    for (let round = 0; round < 500; round += 1) {
      while (inFlight.length < 2) {
        const next = frame(++seq);
        inFlight.push(next);
        pipeline.receive(next);
      }
      // The daemon only sends again once an ack arrives: paint the oldest.
      const oldest = inFlight.shift()!;
      pipeline.painted(oldest);
    }
    while (inFlight.length > 0) {
      pipeline.painted(inFlight.shift()!);
    }
    expect(acked).toHaveLength(seq);
    expect(acked).toEqual(presented);
    expect(acked).toEqual(Array.from({ length: seq }, (_, index) => index + 1));
    expect(pipeline.queuedCount()).toBe(0);
  });

  it("ignores paint reports for frames it is not presenting", () => {
    const { pipeline, acked } = harness();
    const first = frame(1);
    const second = frame(2);
    pipeline.receive(first);
    pipeline.receive(second);
    pipeline.painted(second);
    pipeline.painted(frame(1));
    expect(acked).toEqual([]);
    pipeline.painted(first);
    expect(acked).toEqual([1]);
  });

  it("drops frames from another generation without acking them", () => {
    const { pipeline, presented, acked } = harness(3);
    pipeline.receive(frame(1, 2));
    pipeline.receive(frame(9, 3));
    expect(presented).toEqual([9]);
    pipeline.painted(frame(1, 2));
    expect(acked).toEqual([]);
  });

  it("holds frames while paused and paints them in order when resumed", () => {
    const { pipeline, presented, acked } = harness();
    pipeline.setPaused(true);
    const first = frame(1);
    const second = frame(2);
    pipeline.receive(first);
    pipeline.receive(second);
    expect(presented).toEqual([]);
    expect(pipeline.queuedCount()).toBe(2);
    pipeline.setPaused(false);
    expect(presented).toEqual([1]);
    pipeline.painted(first);
    expect(presented).toEqual([1, 2]);
    pipeline.painted(second);
    expect(acked).toEqual([1, 2]);
  });

  it("finishes the frame being painted when paused mid-paint and holds the rest", () => {
    const { pipeline, presented, acked } = harness();
    const first = frame(1);
    pipeline.receive(first);
    pipeline.receive(frame(2));
    pipeline.setPaused(true);
    pipeline.painted(first);
    expect(acked).toEqual([1]);
    expect(presented).toEqual([1]);
    pipeline.setPaused(false);
    expect(presented).toEqual([1, 2]);
  });

  it("forgets everything on dispose and stays inert afterwards", () => {
    const { pipeline, presented, acked } = harness();
    const first = frame(1);
    pipeline.receive(first);
    pipeline.receive(frame(2));
    pipeline.dispose();
    expect(pipeline.queuedCount()).toBe(0);
    pipeline.painted(first);
    pipeline.receive(frame(3));
    pipeline.setPaused(false);
    expect(presented).toEqual([1]);
    expect(acked).toEqual([]);
  });
});
