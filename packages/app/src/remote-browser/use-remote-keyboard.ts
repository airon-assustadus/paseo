import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { RemoteBrowserInputEvent, RemoteBrowserState } from "@getpaseo/client";
import { isNative } from "@/constants/platform";
import { createKeyboardModel, type HiddenInputSnapshot } from "./keyboard";
import type { KeyboardInputHandle } from "./keyboard-input-props";

type FocusedEditable = NonNullable<RemoteBrowserState["focusedEditable"]>;

/**
 * Identifies the page field the keyboard is typing into. Daemons that report a focus identity make
 * every focus move visible, even between two fields of the same type; older ones only let us key on
 * the field's shape.
 */
export function focusedEditableKey(focusedEditable: FocusedEditable | null): string | null {
  if (!focusedEditable) {
    return null;
  }
  if (focusedEditable.focusId !== undefined) {
    return `id:${focusedEditable.focusId}`;
  }
  return `${focusedEditable.inputMode}\u0000${focusedEditable.inputType}\u0000${focusedEditable.enterKeyHint}`;
}

export interface RemoteKeyboard {
  keyboardRef: RefObject<KeyboardInputHandle | null>;
  /** The hidden input has focus: the soft keyboard is up on phones. */
  keyboardFocused: boolean;
  /** Send whatever is still composing as committed text (a tap or a named key is about to follow). */
  commitKeyboard: () => void;
  handleSnapshot: (snapshot: HiddenInputSnapshot) => void;
  handleKey: (key: string, modifiers: number) => boolean;
  handleKeyboardFocus: (focused: boolean) => void;
  toggleKeyboard: () => void;
}

/**
 * Owns the hidden input and the composition shadow for one pane. The shadow follows the page's
 * focused field: a focus move discards it (Chromium committed on blur, and text must never replay
 * into a different field), a new attachment re-syncs it only while the page still composes.
 */
export function useRemoteKeyboard(input: {
  dispatch: (events: RemoteBrowserInputEvent[]) => void;
  inputEnabled: boolean;
  focusedEditable: FocusedEditable | null;
  attachmentEpoch: number;
}): RemoteKeyboard {
  const { dispatch, inputEnabled, focusedEditable, attachmentEpoch } = input;
  const keyboardRef = useRef<KeyboardInputHandle | null>(null);
  const keyboardModel = useMemo(() => createKeyboardModel(), []);
  const [keyboardFocused, setKeyboardFocused] = useState(false);

  const applyChange = useCallback(
    (change: { events: RemoteBrowserInputEvent[]; shouldClear: boolean }) => {
      dispatch(change.events);
      if (change.shouldClear) keyboardRef.current?.clear();
    },
    [dispatch],
  );

  const commitKeyboard = useCallback(() => {
    applyChange(keyboardModel.commit());
  }, [applyChange, keyboardModel]);

  useEffect(() => {
    if (!inputEnabled) {
      keyboardRef.current?.blur();
    }
  }, [inputEnabled]);

  const focusId = focusedEditable?.focusId ?? null;
  const focusKey = focusedEditableKey(focusedEditable);
  useEffect(() => {
    keyboardModel.setFocusId(focusId);
  }, [focusId, keyboardModel]);
  useEffect(() => {
    keyboardModel.reset();
    keyboardRef.current?.clear();
    if (focusKey !== null) {
      keyboardRef.current?.focus();
    } else if (isNative) {
      keyboardRef.current?.blur();
    }
  }, [focusKey, keyboardModel]);

  const pageComposing = focusedEditable?.composing;
  useEffect(() => {
    if (attachmentEpoch === 0) {
      return;
    }
    const stillComposing = pageComposing ?? focusKey !== null;
    if (keyboardModel.hasUncommittedText() && stillComposing) {
      dispatch(keyboardModel.resync());
    } else {
      keyboardModel.reset();
      keyboardRef.current?.clear();
    }
    // Only a new attachment should re-sync; focus changes are handled above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentEpoch]);

  const handleSnapshot = useCallback(
    (hidden: HiddenInputSnapshot) => {
      if (!inputEnabled) return;
      applyChange(keyboardModel.receiveSnapshot(hidden));
    },
    [applyChange, inputEnabled, keyboardModel],
  );
  const handleKey = useCallback(
    (key: string, modifiers: number) => {
      if (!inputEnabled) return false;
      const change = keyboardModel.receiveKey(key, modifiers);
      applyChange(change);
      return change.events.length > 0;
    },
    [applyChange, inputEnabled, keyboardModel],
  );
  const handleKeyboardFocus = useCallback(
    (focused: boolean) => {
      setKeyboardFocused(focused);
      if (!focused) commitKeyboard();
    },
    [commitKeyboard],
  );
  const toggleKeyboard = useCallback(() => {
    if (keyboardRef.current?.isFocused()) keyboardRef.current.blur();
    else keyboardRef.current?.focus();
  }, []);

  return {
    keyboardRef,
    keyboardFocused,
    commitKeyboard,
    handleSnapshot,
    handleKey,
    handleKeyboardFocus,
    toggleKeyboard,
  };
}
