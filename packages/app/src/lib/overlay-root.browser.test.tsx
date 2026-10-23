import React, { type RefCallback } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasActiveWebOverlay,
  subscribeWebOverlayState,
  useWebOverlayRegistration,
} from "./overlay-root";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function OverlayHarness({ active, showScope }: { active: boolean; showScope: boolean }) {
  const setScope = useWebOverlayRegistration({ active, layer: 20, onKeyDown: () => false });
  return showScope ? (
    <div data-testid="scope" ref={setScope as RefCallback<HTMLDivElement>} tabIndex={-1}>
      <input data-testid="overlay-input" />
    </div>
  ) : null;
}

describe("useWebOverlayRegistration in the browser", () => {
  let root: Root;
  let container: HTMLDivElement;
  let opener: HTMLButtonElement;

  beforeEach(() => {
    container = document.createElement("div");
    opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.append(opener, container);
    root = createRoot(container);
    opener.focus();
  });

  afterEach(() => {
    root.unmount();
    document.body.replaceChildren();
  });

  it("preserves canonical registration when an observer throws", () => {
    const deferredErrors: Array<() => void> = [];
    const microtasks = vi
      .spyOn(globalThis, "queueMicrotask")
      .mockImplementation((callback) => deferredErrors.push(callback));
    const removeFault = subscribeWebOverlayState(() => {
      throw new Error("overlay observer");
    });
    const observed = vi.fn();
    const removeObserver = subscribeWebOverlayState(observed);
    try {
      flushSync(() => root.render(<OverlayHarness active showScope />));
      expect(hasActiveWebOverlay()).toBe(true);
      expect(observed).toHaveBeenCalled();
      expect(
        deferredErrors.some((callback) => {
          try {
            callback();
            return false;
          } catch {
            return true;
          }
        }),
      ).toBe(true);
    } finally {
      removeFault();
      removeObserver();
      microtasks.mockRestore();
    }
    flushSync(() => root.render(null));
    expect(hasActiveWebOverlay()).toBe(false);
  });

  async function renderHarness(active: boolean, showScope: boolean): Promise<void> {
    flushSync(() => {
      root.render(<OverlayHarness active={active} showScope={showScope} />);
    });
    await nextFrame();
  }

  it("skips focus restoration for active scope detach but restores focus when closing", async () => {
    await renderHarness(true, true);

    const input = document.querySelector<HTMLInputElement>('[data-testid="overlay-input"]');
    expect(input).toBeTruthy();
    input?.focus();
    await nextFrame();
    expect(document.activeElement).not.toBe(opener);

    const originalFocus = opener.focus.bind(opener);
    let openerFocusCalls = 0;
    opener.focus = () => {
      openerFocusCalls += 1;
      originalFocus();
    };

    await renderHarness(true, false);

    expect(openerFocusCalls).toBe(0);

    await renderHarness(false, false);

    expect(openerFocusCalls).toBe(1);
  });

  it("publishes the interaction fence synchronously and stops notifying after unsubscribe", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeWebOverlayState(() => seen.push(hasActiveWebOverlay()));
    flushSync(() => root.render(<OverlayHarness active showScope />));
    expect(seen.at(-1)).toBe(true);
    flushSync(() => root.render(<OverlayHarness active={false} showScope />));
    expect(seen.at(-1)).toBe(false);
    unsubscribe();
    unsubscribe();
    const count = seen.length;
    flushSync(() => root.render(<OverlayHarness active showScope />));
    expect(seen).toHaveLength(count);
  });

  it("keeps the fence while a nested registered overlay remains", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeWebOverlayState(() => seen.push(hasActiveWebOverlay()));
    flushSync(() =>
      root.render(
        <>
          <OverlayHarness active showScope />
          <OverlayHarness active showScope />
        </>,
      ),
    );
    expect(seen.at(-1)).toBe(true);
    flushSync(() =>
      root.render(
        <>
          <OverlayHarness active={false} showScope />
          <OverlayHarness active showScope />
        </>,
      ),
    );
    expect(seen.at(-1)).toBe(true);
    flushSync(() => root.render(null));
    expect(seen.at(-1)).toBe(false);
    unsubscribe();
  });
});
