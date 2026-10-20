import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HiddenInputSnapshot } from "./keyboard";
import { KeyboardInput } from "./keyboard-input";
import type { KeyboardInputHandle } from "./keyboard-input-props";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * The hidden web input with a real DOM: keys pressed while the local IME composes (candidate
 * navigation, Enter to accept) belong to the IME and must never reach the page, and preventing
 * them would cancel the composition. Only the key pressed after compositionend is the page's.
 */

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mountInput() {
  const onKey = vi.fn<(key: string, modifiers: number) => boolean>(() => true);
  const onSnapshot = vi.fn<(snapshot: HiddenInputSnapshot) => void>();
  const onFocusChange = vi.fn<(focused: boolean) => void>();
  const handle = React.createRef<KeyboardInputHandle>();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <KeyboardInput
        ref={handle}
        privacy="plain"
        inputMode="text"
        enterKeyHint="enter"
        onSnapshot={onSnapshot}
        onKey={onKey}
        onFocusChange={onFocusChange}
      />,
    ),
  );
  mounted.push({ root, container });
  const node = container.querySelector<HTMLTextAreaElement>(
    '[data-testid="remote-browser-keyboard-input"]',
  );
  if (!node) throw new Error("hidden input is not mounted");

  const keydown = (key: string, init: { isComposing?: boolean; keyCode?: number } = {}) => {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      isComposing: init.isComposing ?? false,
      keyCode: init.keyCode ?? 0,
    });
    act(() => {
      node.dispatchEvent(event);
    });
    return event;
  };
  const composition = (type: "compositionstart" | "compositionend", data = "") =>
    act(() => {
      node.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
    });
  return { onKey, onSnapshot, node, keydown, composition };
}

describe("remote browser hidden input and IME composition", () => {
  it("lets the IME keep the accepting Enter and sends only the Enter pressed afterwards", () => {
    const input = mountInput();

    input.composition("compositionstart");
    input.node.value = "한";
    const accept = input.keydown("Enter", { isComposing: true, keyCode: 229 });
    expect(accept.defaultPrevented).toBe(false);
    input.composition("compositionend", "한");
    expect(input.onKey).not.toHaveBeenCalled();

    const submit = input.keydown("Enter");
    expect(input.onKey).toHaveBeenCalledTimes(1);
    expect(input.onKey).toHaveBeenCalledWith("Enter", 0);
    expect(submit.defaultPrevented).toBe(true);
  });

  it("keeps candidate navigation and deletion inside the IME", () => {
    const input = mountInput();

    input.composition("compositionstart");
    for (const key of ["ArrowDown", "ArrowUp", "Backspace", "ArrowLeft"]) {
      const event = input.keydown(key, { isComposing: true, keyCode: 229 });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(input.onKey).not.toHaveBeenCalled();

    // A browser that drops the composing flag on a key still has the element's own events.
    const flagless = input.keydown("Enter");
    expect(flagless.defaultPrevented).toBe(false);
    expect(input.onKey).not.toHaveBeenCalled();

    input.composition("compositionend", "字");
    input.keydown("Backspace");
    expect(input.onKey).toHaveBeenCalledTimes(1);
    expect(input.onKey).toHaveBeenCalledWith("Backspace", 0);
  });
});
