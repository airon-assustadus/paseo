import type { TextInputProps } from "react-native";
import type { RemoteBrowserState } from "@getpaseo/client";
import type { HiddenInputSnapshot } from "./keyboard";

/**
 * What the hidden input tells the device keyboard about the page's field.
 * - `password`: the page says the field is a password: secure entry, no suggestions, no autofill.
 * - `unknown`: the page reported no field. That is the keyboard toggle on a page without a known
 *   focus, and also any field inside a cross-origin iframe (out-of-process frames give no focus
 *   hint; typing still reaches them). The field may be a password, so it gets the same secure
 *   entry; the cost is single-line input without IME suggestions in those frames.
 * - `plain`: a known non-password field; the keyboard behaves as for any text.
 *
 * Secure entry is the only mode whose effect is known on every platform. `autoCorrect={false}`
 * alone only drops suggestions on Android (`TYPE_TEXT_FLAG_NO_SUGGESTIONS`); it does not promise
 * that the keyboard learns nothing.
 */
export type HiddenInputPrivacy = "password" | "unknown" | "plain";

export function resolveInputPrivacy(
  focusedEditable: RemoteBrowserState["focusedEditable"],
): HiddenInputPrivacy {
  if (!focusedEditable) {
    return "unknown";
  }
  return focusedEditable.inputType === "password" ? "password" : "plain";
}

export interface KeyboardInputHandle {
  focus(): void;
  blur(): void;
  /** Empty the hidden buffer after a commit so the next keystroke starts a fresh composition. */
  clear(): void;
  isFocused(): boolean;
}

export interface KeyboardInputProps {
  privacy: HiddenInputPrivacy;
  inputMode: string | null;
  enterKeyHint: string | null;
  onSnapshot: (snapshot: HiddenInputSnapshot) => void;
  /** Returns true when the key was consumed, so web can stop the browser's own handling. */
  onKey: (key: string, modifiers: number) => boolean;
  onFocusChange: (focused: boolean) => void;
}

const INPUT_MODES = new Set<NonNullable<TextInputProps["inputMode"]>>([
  "none",
  "text",
  "decimal",
  "numeric",
  "tel",
  "search",
  "email",
  "url",
]);

const ENTER_KEY_HINTS = new Set<NonNullable<TextInputProps["enterKeyHint"]>>([
  "enter",
  "done",
  "go",
  "next",
  "previous",
  "search",
  "send",
]);

function isInputMode(value: string): value is NonNullable<TextInputProps["inputMode"]> {
  return (INPUT_MODES as Set<string>).has(value);
}

function isEnterKeyHint(value: string): value is NonNullable<TextInputProps["enterKeyHint"]> {
  return (ENTER_KEY_HINTS as Set<string>).has(value);
}

/** The page's `inputmode` hint as React Native's prop, or `text` when it is not one we know. */
export function resolveInputMode(value: string | null): NonNullable<TextInputProps["inputMode"]> {
  return value && isInputMode(value) ? value : "text";
}

export function resolveEnterKeyHint(value: string | null): TextInputProps["enterKeyHint"] {
  return value && isEnterKeyHint(value) ? value : undefined;
}
