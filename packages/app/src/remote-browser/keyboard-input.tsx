import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
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
  resolveEnterKeyHint,
  resolveInputMode,
  type KeyboardInputHandle,
  type KeyboardInputProps,
} from "./keyboard-input-props";

/**
 * The hidden input that owns the soft keyboard on native. Its text is the page's composition
 * (see keyboard.ts), so it never shows anything itself. Autofill and content types stay off: the
 * buffer is a transit area for the remote page, not a field of this app.
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
    const textRef = useRef("");
    const selectionRef = useRef({ start: 0, end: 0 });
    const focusedRef = useRef(false);

    const publish = useCallback(() => {
      onSnapshot({
        text: textRef.current,
        selectionStart: selectionRef.current.start,
        selectionEnd: selectionRef.current.end,
      });
    }, [onSnapshot]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => inputRef.current?.focus(),
        blur: () => inputRef.current?.blur(),
        clear: () => {
          textRef.current = "";
          selectionRef.current = { start: 0, end: 0 };
          inputRef.current?.replaceText("");
        },
        isFocused: () => focusedRef.current,
      }),
      [],
    );

    const handleChangeText = useCallback(
      (text: string) => {
        textRef.current = text;
        // Android reports the caret after the text; assume end-of-text until it does.
        selectionRef.current = { start: text.length, end: text.length };
        publish();
      },
      [publish],
    );

    const handleSelectionChange = useCallback(
      (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        const { start, end } = event.nativeEvent.selection;
        if (selectionRef.current.start === start && selectionRef.current.end === end) {
          return;
        }
        selectionRef.current = { start, end };
        publish();
      },
      [publish],
    );

    const handleKeyPress = useCallback(
      (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        onKey(event.nativeEvent.key, 0);
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
        contextMenuHidden
        enterKeyHint={resolveEnterKeyHint(enterKeyHint)}
        importantForAutofill="no"
        initialValue=""
        inputMode={secure ? "text" : resolveInputMode(inputMode)}
        multiline={!secure}
        onBlur={handleBlur}
        onChangeText={handleChangeText}
        onFocus={handleFocus}
        onKeyPress={handleKeyPress}
        onSelectionChange={handleSelectionChange}
        secureTextEntry={secure}
        showSoftInputOnFocus
        spellCheck={personalized}
        style={styles.input}
        testID="remote-browser-keyboard-input"
        textContentType="none"
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
