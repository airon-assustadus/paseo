import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMutable } from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { usePanelStore } from "@/stores/panel-store";
import { createMobilePanelMotionState } from "./model";
import { createMobileSurfacePresentation } from "./surface-presentation.web";

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const dispose of teardowns.splice(0)) dispose();
});

function setup() {
  usePanelStore.setState({ mobilePanel: { target: "agent", revision: 100 } });
  const position = makeMutable(0);
  const motionState = makeMutable(
    createMobilePanelMotionState(usePanelStore.getState().mobilePanel),
  );
  const source = createMobileSurfacePresentation({ position, motionState });
  return { position, motionState, source };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe("web surface presentation fence", () => {
  it("keeps canonical motion and later observers alive when an observer throws", () => {
    const { source, position } = setup();
    const errors: VoidFunction[] = [];
    const schedule = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      errors.push(callback);
    });
    const observed = vi.fn();
    const failure = new Error("presentation observer failed");
    const unsubscribeFailure = source.subscribe(() => {
      throw failure;
    });
    const unsubscribeObserver = source.subscribe(observed);
    try {
      position.value = 1;
      expect(position.value).toBe(1);
      expect(source.getSnapshot()).toBe(true);
      expect(observed).toHaveBeenCalledOnce();
      usePanelStore.setState({ mobilePanel: { target: "agent-list", revision: 101 } });
      expect(usePanelStore.getState().mobilePanel.target).toBe("agent-list");
      expect(observed).toHaveBeenCalledTimes(2);
      expect(errors).toHaveLength(2);
      for (const report of errors) expect(report).toThrow(failure);
    } finally {
      unsubscribeFailure();
      unsubscribeObserver();
      schedule.mockRestore();
    }
  });

  for (const schedulingFirst of [true, false]) {
    it(`fences in the same turn before scheduled motion, scheduling subscriber first=${schedulingFirst}`, async () => {
      const { source } = setup();
      const surface = document.createElement("div");
      let moving = false;
      let fencedAtMovement = false;
      function move() {
        moving = true;
        fencedAtMovement = surface.inert;
      }
      function subscribeScheduling() {
        return usePanelStore.subscribe(() => {
          scheduleOnUI(move);
        });
      }
      function subscribeFence() {
        return source.subscribe(() => {
          surface.inert = source.getSnapshot();
        });
      }
      const subscribeFirst = schedulingFirst ? subscribeScheduling : subscribeFence;
      const subscribeSecond = schedulingFirst ? subscribeFence : subscribeScheduling;
      teardowns.push(subscribeFirst(), subscribeSecond());
      usePanelStore.setState({ mobilePanel: { target: "agent-list", revision: 101 } });
      expect(surface.inert).toBe(true);
      expect(moving).toBe(false);
      await nextFrame();
      await nextFrame();
      expect(moving).toBe(true);
      expect(fencedAtMovement).toBe(true);
    });
  }

  it("blocks at gesture start and does not release at a stale or displaced center", () => {
    const { source, position, motionState } = setup();
    const seen: boolean[] = [];
    teardowns.push(source.subscribe(() => seen.push(source.getSnapshot())));
    expect(source.getSnapshot()).toBe(false);
    motionState.value = { ...motionState.value, gesture: { startedRevision: 100 } };
    expect(seen.at(-1)).toBe(true);
    position.value = 0.001;
    motionState.value = { ...motionState.value, gesture: null };
    expect(source.getSnapshot()).toBe(true);
    position.value = 0;
    expect(source.getSnapshot()).toBe(false);
    usePanelStore.setState({ mobilePanel: { target: "agent", revision: 102 } });
    expect(source.getSnapshot()).toBe(true);
    motionState.value = createMobilePanelMotionState(usePanelStore.getState().mobilePanel);
    expect(seen.at(-1)).toBe(false);
  });
});
