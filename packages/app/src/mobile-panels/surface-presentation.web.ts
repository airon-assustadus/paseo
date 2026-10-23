import { useMemo } from "react";
import type { SharedValue } from "react-native-reanimated";
import { usePanelStore } from "@/stores/panel-store";
import type { MobilePanelMotionState } from "./model";
import { useMobilePanelsRuntime } from "./provider";

interface SurfaceMotion {
  position: SharedValue<number>;
  motionState: SharedValue<MobilePanelMotionState>;
}

export interface MobileSurfacePresentation {
  getSnapshot(): boolean;
  subscribe(listener: () => void): () => void;
}

// Web SharedValue listeners run synchronously in the setter. Negative IDs are
// private to this adapter and do not overlap Reanimated's mapper IDs.
let nextListenerId = -1;

export function createMobileSurfacePresentation({
  position,
  motionState,
}: SurfaceMotion): MobileSurfacePresentation {
  function getSnapshot(): boolean {
    const selection = usePanelStore.getState().mobilePanel;
    const motion = motionState.value;
    const centerRequested = selection.target === "agent";
    const currentRevision = selection.revision === motion.revision;
    const centerSettled = motion.motionTarget === "agent" && motion.settledTarget === "agent";
    return (
      !centerRequested ||
      !currentRevision ||
      !centerSettled ||
      motion.gesture !== null ||
      position.value !== 0
    );
  }

  function subscribe(listener: () => void): () => void {
    const listenerId = nextListenerId--;
    function notify(): void {
      try {
        listener();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
    position.addListener(listenerId, notify);
    motionState.addListener(listenerId, notify);
    const unsubscribeSelection = usePanelStore.subscribe((state, previous) => {
      if (state.mobilePanel !== previous.mobilePanel) notify();
    });
    return () => {
      position.removeListener(listenerId);
      motionState.removeListener(listenerId);
      unsubscribeSelection();
    };
  }

  return { getSnapshot, subscribe };
}

export function useMobileSurfacePresentation(): MobileSurfacePresentation {
  const { position, motionState } = useMobilePanelsRuntime();
  return useMemo(
    () => createMobileSurfacePresentation({ position, motionState }),
    [position, motionState],
  );
}
