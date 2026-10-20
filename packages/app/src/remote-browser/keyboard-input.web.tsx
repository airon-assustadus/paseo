import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import {
  StyleSheet,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
  type TextInputSelectionChangeEventData,
} from "react-native";
import { useTranslation } from "react-i18next";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import {
  KEY_MODIFIER_ALT,
  KEY_MODIFIER_CTRL,
  KEY_MODIFIER_META,
  KEY_MODIFIER_SHIFT,
} from "./keyboard";
import {
  resolveEnterKeyHint,
  resolveInputMode,
  type KeyboardInputHandle,
  type KeyboardInputProps,
} from "./keyboard-input-props";

/** React Native Web forwards the DOM keydown; the modifier and IME flags are not in the RN type. */
interface WebKeyPressEventData extends TextInputKeyPressEventData {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** Chromium reports keys pressed inside an IME composition with keyCode 229 and `isComposing`. */
function isComposingKey(event: WebKeyPressEventData): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

function modifiersOf(event: WebKeyPressEventData): number {
  return (
    (event.altKey ? KEY_MODIFIER_ALT : 0) |
    (event.ctrlKey ? KEY_MODIFIER_CTRL : 0) |
    (event.metaKey ? KEY_MODIFIER_META : 0) |
    (event.shiftKey ? KEY_MODIFIER_SHIFT : 0)
  );
}

function readSelection(element: unknown): { start: number; end: number } | null {
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
    return null;
  }
  if (element.selectionStart === null || element.selectionEnd === null) {
    return null;
  }
  return { start: element.selectionStart, end: element.selectionEnd };
}

/**
 * The hidden input that owns the keyboard on web (mobile Chrome and desktop browsers). While the
 * local IME composes, the shared editor reports the text at composition end; the committed text
 * then travels as the page's composition (keyboard.ts).
 */
export const KeyboardInput = forwardRef<KeyboardInputHandle, KeyboardInputProps>(
  function KeyboardInput(
    { privacy, inputMode, enterKeyHint, onSnapshot, onKey, onFocusChange },
    ref,
  ) {
    const { t } = useTranslation();
    const inputRef = useRef<EditingTextInputHandle | null>(null);
    const secure = privacy !== "plain";
    const personalized = privacy === "plain";
    const focusedRef = useRef(false);
    // Between compositionstart and compositionend the keys belong to the local IME (candidate
    // selection, accept with Enter); none of them may reach the page. The DOM flag on each key is
    // the primary signal; the listeners cover browsers that drop it on the accepting key.
    const composingRef = useRef(false);

    useEffect(() => {
      const node: unknown = inputRef.current?.getNativeRef();
      if (!(node instanceof HTMLElement)) return;
      const start = () => {
        composingRef.current = true;
      };
      const end = () => {
        composingRef.current = false;
      };
      node.addEventListener("compositionstart", start);
      node.addEventListener("compositionend", end);
      return () => {
        node.removeEventListener("compositionstart", start);
        node.removeEventListener("compositionend", end);
      };
    }, []);

    const publish = useCallback(() => {
      const input = inputRef.current;
      if (!input) return;
      const text = input.getText();
      const selection = readSelection(input.getNativeRef()) ?? {
        start: text.length,
        end: text.length,
      };
      onSnapshot({ text, selectionStart: selection.start, selectionEnd: selection.end });
    }, [onSnapshot]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => inputRef.current?.focus(),
        blur: () => inputRef.current?.blur(),
        clear: () => inputRef.current?.replaceText(""),
        isFocused: () => focusedRef.current,
      }),
      [],
    );

    const handleChangeText = useCallback(() => publish(), [publish]);

    const handleSelectionChange = useCallback(
      (_event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => publish(),
      [publish],
    );

    const handleKeyPress = useCallback(
      (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        const nativeEvent: WebKeyPressEventData = event.nativeEvent;
        if (composingRef.current || isComposingKey(nativeEvent)) {
          // The IME consumes this key; preventing it would cancel the composition.
          return;
        }
        if (onKey(nativeEvent.key, modifiersOf(nativeEvent))) {
          event.preventDefault();
        }
      },
      [onKey],
    );

    const handleFocus = useCallback(() => {
      focusedRef.current = true;
      onFocusChange(true);
    }, [onFocusChange]);

    const handleBlur = useCallback(() => {
      focusedRef.current = false;
      onFocusChange(false);
    }, [onFocusChange]);

    return (
      <TextInput
        ref={inputRef}
        accessibilityLabel={t("workspace.browser.remote.keyboardInput")}
        accessible
        autoCapitalize={personalized ? "sentences" : "none"}
        autoComplete="off"
        autoCorrect={personalized}
        blurOnSubmit={false}
        caretHidden
        enterKeyHint={resolveEnterKeyHint(enterKeyHint)}
        initialValue=""
        inputMode={secure ? "text" : resolveInputMode(inputMode)}
        multiline={!secure}
        onBlur={handleBlur}
        onChangeText={handleChangeText}
        onFocus={handleFocus}
        onKeyPress={handleKeyPress}
        onSelectionChange={handleSelectionChange}
        secureTextEntry={secure}
        spellCheck={personalized}
        style={styles.input}
        testID="remote-browser-keyboard-input"
      />
    );
  },
);

const styles = StyleSheet.create({
  input: {
    backgroundColor: "transparent",
    color: "transparent",
    height: 1,
    left: 0,
    opacity: 0.01,
    padding: 0,
    position: "absolute",
    top: 0,
    width: 1,
  },
});
