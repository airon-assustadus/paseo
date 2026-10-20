import type { RemoteBrowserInputEvent } from "@getpaseo/client";
import {
  REMOTE_BROWSER_MAX_COMPOSITION_LENGTH,
  REMOTE_BROWSER_MAX_TEXT_LENGTH,
  REMOTE_BROWSER_NAMED_KEYS,
  type RemoteBrowserNamedKey,
} from "@getpaseo/protocol/remote-browser/rpc-schemas";

// A composition longer than this is committed as text instead; it stays well under the schema
// ceiling so one autocorrect or emoji picker insertion cannot push it over.
export const COMMIT_THRESHOLD = Math.floor(REMOTE_BROWSER_MAX_COMPOSITION_LENGTH * 0.78);
export const TEXT_CHUNK_LENGTH = REMOTE_BROWSER_MAX_TEXT_LENGTH;

export const KEY_MODIFIER_ALT = 1;
export const KEY_MODIFIER_CTRL = 2;
export const KEY_MODIFIER_META = 4;
export const KEY_MODIFIER_SHIFT = 8;

export interface HiddenInputSnapshot {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

export interface KeyboardChange {
  events: RemoteBrowserInputEvent[];
  /** The hidden input must be emptied: its text is now committed on the remote page. */
  shouldClear: boolean;
}

export interface KeyboardModel {
  /** Text or caret changed in the hidden input. */
  receiveSnapshot(snapshot: HiddenInputSnapshot): KeyboardChange;
  /** A key event from the hidden input (`onKeyPress` on native, `keydown` on web). */
  receiveKey(key: string, modifiers?: number): KeyboardChange;
  /** Commit the uncommitted text, if any. Idempotent: a second call sends nothing. */
  commit(): KeyboardChange;
  /** Drop the uncommitted text without touching the page (focus moved; Chromium committed on blur). */
  reset(): void;
  /** After a re-attach while the page still composes: replace the composing region with the same text. */
  resync(): RemoteBrowserInputEvent[];
  hasUncommittedText(): boolean;
  /**
   * The page's current `focusedEditable.focusId`, stamped on every text and composition event so the
   * daemon refuses them once focus has moved to another field (`focus_changed`).
   */
  setFocusId(focusId: number | null): void;
}

const NO_CHANGE: KeyboardChange = { events: [], shouldClear: false };
const NAMED_KEYS = new Set<string>(REMOTE_BROWSER_NAMED_KEYS);

function isNamedKey(key: string): key is RemoteBrowserNamedKey {
  return NAMED_KEYS.has(key);
}

function isPrintable(key: string): boolean {
  return Array.from(key).length === 1 && key !== "\n" && key !== "\r";
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Fixed-length chunks that never split a surrogate pair. A chunk holds at least two code units so
 * moving a high surrogate to the next chunk always leaves progress.
 */
export function splitTextChunks(text: string, maxLength = TEXT_CHUNK_LENGTH): string[] {
  const chunkLength = Number.isFinite(maxLength)
    ? Math.max(2, Math.floor(maxLength))
    : TEXT_CHUNK_LENGTH;
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + chunkLength);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
      end -= 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function clampSelection(value: number, length: number): number {
  if (!Number.isFinite(value)) {
    return length;
  }
  return Math.min(length, Math.max(0, Math.trunc(value)));
}

function keyPress(key: string, modifiers: number): RemoteBrowserInputEvent {
  return { kind: "key", phase: "press", key, modifiers };
}

function textEvents(text: string, focusId: number | null): RemoteBrowserInputEvent[] {
  return splitTextChunks(text).map((chunk) =>
    focusId === null ? { kind: "text", text: chunk } : { kind: "text", text: chunk, focusId },
  );
}

/**
 * The hidden input's whole uncommitted text is the page's IME composition. Each change replaces the
 * composing region atomically with the new text and caret, so mid-word autocorrect, CJK syllable
 * rewrites, combining marks and emoji never need caret arithmetic or per-code-unit Backspace on the
 * remote page. Named keys, taps and focus changes commit it first; long text (pastes) is committed in
 * schema-sized chunks. Backspace is sent as a key only when nothing is composing, so it deletes
 * committed page text one press at a time, exactly as a local keyboard would.
 */
export function createKeyboardModel(): KeyboardModel {
  let shadow: HiddenInputSnapshot = { text: "", selectionStart: 0, selectionEnd: 0 };
  let composing = false;
  let focusId: number | null = null;
  // Enter on a multiline hidden input echoes "\n" into the text after the key event.
  let expectedEcho: string | null = null;

  function commitShadow(): RemoteBrowserInputEvent[] {
    const text = shadow.text;
    shadow = { text: "", selectionStart: 0, selectionEnd: 0 };
    composing = false;
    if (text.length === 0) {
      return [];
    }
    return textEvents(text, focusId);
  }

  function compositionEvent(next: HiddenInputSnapshot): RemoteBrowserInputEvent {
    const base = {
      kind: "composition" as const,
      text: next.text,
      selectionStart: clampSelection(next.selectionStart, next.text.length),
      selectionEnd: clampSelection(next.selectionEnd, next.text.length),
    };
    return focusId === null ? base : { ...base, focusId };
  }

  function composeShadow(next: HiddenInputSnapshot): RemoteBrowserInputEvent {
    shadow = next;
    composing = next.text.length > 0;
    return compositionEvent(next);
  }

  function receiveSnapshot(raw: HiddenInputSnapshot): KeyboardChange {
    if (expectedEcho !== null) {
      const echo = expectedEcho;
      expectedEcho = null;
      if (raw.text === echo) {
        return { events: [], shouldClear: true };
      }
    }
    if (
      raw.text === shadow.text &&
      raw.selectionStart === shadow.selectionStart &&
      raw.selectionEnd === shadow.selectionEnd
    ) {
      return NO_CHANGE;
    }
    if (/[\r\n]/.test(raw.text)) {
      // A line break only arrives here from a paste (or an Enter whose key event never fired).
      // Commit it as text: `Input.insertText` keeps the newlines, and only a real Enter key may
      // submit a form.
      return { events: commitShadowWith(raw.text), shouldClear: true };
    }
    if (raw.text.length === 0) {
      const wasComposing = composing;
      shadow = { text: "", selectionStart: 0, selectionEnd: 0 };
      composing = false;
      return wasComposing ? { events: [compositionEvent(shadow)], shouldClear: false } : NO_CHANGE;
    }
    if (raw.text.length > COMMIT_THRESHOLD) {
      return { events: commitShadowWith(raw.text), shouldClear: true };
    }
    return { events: [composeShadow(raw)], shouldClear: false };
  }

  function commitShadowWith(text: string): RemoteBrowserInputEvent[] {
    shadow = { text, selectionStart: text.length, selectionEnd: text.length };
    return commitShadow();
  }

  function receiveKey(key: string, modifiers = 0): KeyboardChange {
    const hasShortcutModifier = (modifiers & (KEY_MODIFIER_CTRL | KEY_MODIFIER_META)) !== 0;
    if (key === "Enter") {
      expectedEcho = `${shadow.text}\n`;
      const events = [...commitShadow(), keyPress("Enter", modifiers)];
      return { events, shouldClear: true };
    }
    if (key === "Backspace" || key === "Delete") {
      if (composing) {
        return NO_CHANGE;
      }
      return { events: [keyPress(key, modifiers)], shouldClear: false };
    }
    if (isNamedKey(key)) {
      const committed = commitShadow();
      return {
        events: [...committed, keyPress(key, modifiers)],
        shouldClear: committed.length > 0,
      };
    }
    if (hasShortcutModifier && isPrintable(key)) {
      const committed = commitShadow();
      return {
        events: [...committed, keyPress(key, modifiers)],
        shouldClear: committed.length > 0,
      };
    }
    return NO_CHANGE;
  }

  return {
    receiveSnapshot,
    receiveKey,
    commit() {
      const events = commitShadow();
      return { events, shouldClear: events.length > 0 };
    },
    reset() {
      shadow = { text: "", selectionStart: 0, selectionEnd: 0 };
      composing = false;
      expectedEcho = null;
    },
    resync() {
      if (!composing) {
        return [];
      }
      return [composeShadow(shadow)];
    },
    hasUncommittedText() {
      return composing;
    },
    setFocusId(next) {
      focusId = next;
    },
  };
}
