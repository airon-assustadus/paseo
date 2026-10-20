import {
  REMOTE_BROWSER_NAMED_KEYS,
  type RemoteBrowserInputEvent,
  type RemoteBrowserNamedKey,
  type RemoteBrowserViewport,
} from "@getpaseo/protocol/remote-browser/rpc-schemas";

export interface CdpCommand {
  method: string;
  params: Record<string, unknown>;
}

interface NamedKeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<RemoteBrowserNamedKey, NamedKeyDefinition> = {
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

const MODIFIER_TEXT_SUPPRESSING = 1 | 2 | 4; // Alt, Ctrl, Meta: shortcuts produce no text.

export class RemoteBrowserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteBrowserInputError";
  }
}

function isNamedKey(key: string): key is RemoteBrowserNamedKey {
  return (REMOTE_BROWSER_NAMED_KEYS as readonly string[]).includes(key);
}

function keyDefinition(key: string): NamedKeyDefinition {
  if (isNamedKey(key)) return NAMED_KEYS[key];
  const codePoints = [...key];
  if (codePoints.length !== 1 || /\p{C}/u.test(key)) {
    throw new RemoteBrowserInputError("Key must be a named key or one printable character");
  }
  const upper = key.toUpperCase();
  if (/^[A-Z]$/.test(upper))
    return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
  if (/^[0-9]$/.test(key))
    return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
  return { key, code: "", keyCode: 0, text: key };
}

function assertInside(x: number, y: number, viewport: RemoteBrowserViewport): void {
  if (x > viewport.width || y > viewport.height) {
    throw new RemoteBrowserInputError("Coordinates are outside the viewport");
  }
}

const MOUSE_TYPES = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" } as const;
const TOUCH_TYPES = {
  start: "touchStart",
  move: "touchMove",
  end: "touchEnd",
  cancel: "touchCancel",
} as const;

/**
 * Maps one validated input event to the CDP commands that perform it. The set is closed: there is
 * no path from client input to script evaluation.
 */
export function mapInputEvent(
  event: RemoteBrowserInputEvent,
  viewport: RemoteBrowserViewport,
): CdpCommand[] {
  switch (event.kind) {
    case "touch": {
      for (const point of event.points) assertInside(point.x, point.y, viewport);
      if ((event.phase === "start" || event.phase === "move") && event.points.length === 0) {
        throw new RemoteBrowserInputError("Touch start and move need at least one point");
      }
      return [
        {
          method: "Input.dispatchTouchEvent",
          params: {
            type: TOUCH_TYPES[event.phase],
            touchPoints: event.points.map((point) => ({ x: point.x, y: point.y, id: point.id })),
          },
        },
      ];
    }
    case "mouse":
      assertInside(event.x, event.y, viewport);
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type: MOUSE_TYPES[event.phase],
            x: event.x,
            y: event.y,
            button: event.button,
            clickCount: event.clickCount,
            modifiers: event.modifiers,
          },
        },
      ];
    case "wheel":
      assertInside(event.x, event.y, viewport);
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type: "mouseWheel",
            x: event.x,
            y: event.y,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            modifiers: event.modifiers,
          },
        },
      ];
    case "key": {
      const definition = keyDefinition(event.key);
      const text =
        (event.modifiers & MODIFIER_TEXT_SUPPRESSING) === 0 ? definition.text : undefined;
      const base = {
        key: definition.key,
        code: definition.code,
        windowsVirtualKeyCode: definition.keyCode,
        nativeVirtualKeyCode: definition.keyCode,
        modifiers: event.modifiers,
      };
      const down: CdpCommand = {
        method: "Input.dispatchKeyEvent",
        params: text
          ? { ...base, type: "keyDown", text, unmodifiedText: text }
          : { ...base, type: "rawKeyDown" },
      };
      const up: CdpCommand = {
        method: "Input.dispatchKeyEvent",
        params: { ...base, type: "keyUp" },
      };
      if (event.phase === "down") return [down];
      if (event.phase === "up") return [up];
      return [down, up];
    }
    case "text":
      return [{ method: "Input.insertText", params: { text: event.text } }];
    case "composition": {
      const length = event.text.length;
      if (event.selectionStart > length || event.selectionEnd > length) {
        throw new RemoteBrowserInputError("Composition selection is outside the text");
      }
      if (event.selectionStart > event.selectionEnd) {
        throw new RemoteBrowserInputError("Composition selection is reversed");
      }
      return [
        {
          method: "Input.imeSetComposition",
          params: {
            text: event.text,
            selectionStart: event.selectionStart,
            selectionEnd: event.selectionEnd,
          },
        },
      ];
    }
  }
}
