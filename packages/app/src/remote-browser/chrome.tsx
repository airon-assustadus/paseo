import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ArrowLeft, ArrowRight, Keyboard, RotateCw, X } from "lucide-react-native";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import { ToolbarButton } from "@/desktop/browser/pane/toolbar-button";
import { normalizeWorkspaceBrowserUrl } from "@/desktop/browser/store";
import { HostBadge } from "@/hosts/host-badge";
import type { HostColor } from "@/hosts/appearance";
import type { Theme } from "@/styles/theme";

export interface RemoteBrowserChromeProps {
  serverId: string;
  hostLabel: string;
  hostColor: HostColor;
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  /** Null hides the keyboard toggle (desktop web with a physical keyboard). */
  keyboardShown: boolean | null;
  disabled: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
  onNavigate: (url: string) => void;
  onToggleKeyboard: () => void;
}

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedArrowRight = withUnistyles(ArrowRight);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedX = withUnistyles(X);
const ThemedKeyboard = withUnistyles(Keyboard);
const ThemedUrlInput = withUnistyles(TextInput);

const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentIcon = (theme: Theme) => ({ color: theme.colors.accent });
const urlInputMapping = (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
});

interface PressState {
  hovered?: boolean;
  pressed?: boolean;
}

function iconButtonStyle(state: PressState): StyleProp<ViewStyle> {
  return [styles.iconButton, (state.hovered || state.pressed) && styles.iconButtonHovered];
}

function disabledIconButtonStyle(): StyleProp<ViewStyle> {
  return [styles.iconButton, styles.iconButtonDisabled];
}

function activeIconButtonStyle(state: PressState): StyleProp<ViewStyle> {
  return [
    styles.iconButton,
    styles.iconButtonActive,
    (state.hovered || state.pressed) && styles.iconButtonHovered,
  ];
}

/** Toolbar shared by the native and plain-web remote panes; mirrors the desktop browser chrome. */
export function RemoteBrowserChrome({
  serverId,
  hostLabel,
  hostColor,
  url,
  canGoBack,
  canGoForward,
  isLoading,
  keyboardShown,
  disabled,
  onBack,
  onForward,
  onReload,
  onStop,
  onNavigate,
  onToggleKeyboard,
}: RemoteBrowserChromeProps) {
  const { t } = useTranslation();
  const urlInputRef = useRef<EditingTextInputHandle | null>(null);
  const [draftUrl, setDraftUrl] = useState(url);

  useEffect(() => {
    urlInputRef.current?.replaceText(url);
    setDraftUrl(url);
  }, [url]);

  const submitDraft = useCallback(() => {
    const next = normalizeWorkspaceBrowserUrl(urlInputRef.current?.getText() ?? draftUrl);
    onNavigate(next);
  }, [draftUrl, onNavigate]);

  const badge = useMemo(
    () => ({
      serverId,
      label: t("browserRouting.viaHost", { host: hostLabel }),
      color: hostColor,
      showLabel: true,
    }),
    [hostColor, hostLabel, serverId, t],
  );

  const backStyle = canGoBack && !disabled ? iconButtonStyle : disabledIconButtonStyle;
  const forwardStyle = canGoForward && !disabled ? iconButtonStyle : disabledIconButtonStyle;
  const reloadStyle = disabled ? disabledIconButtonStyle : iconButtonStyle;

  return (
    <View style={styles.chromeRow} testID="remote-browser-chrome">
      <View style={styles.chromeLeft}>
        <ToolbarButton
          label={t("workspace.browser.controls.back")}
          disabled={!canGoBack || disabled}
          onPress={onBack}
          style={backStyle}
          testID="remote-browser-back"
        >
          <ThemedArrowLeft size={16} uniProps={mutedIcon} />
        </ToolbarButton>
        <ToolbarButton
          label={t("workspace.browser.controls.forward")}
          disabled={!canGoForward || disabled}
          onPress={onForward}
          style={forwardStyle}
          testID="remote-browser-forward"
        >
          <ThemedArrowRight size={16} uniProps={mutedIcon} />
        </ToolbarButton>
        <ToolbarButton
          label={
            isLoading
              ? t("workspace.browser.controls.stopLoading")
              : t("workspace.browser.controls.refresh")
          }
          disabled={disabled}
          onPress={isLoading ? onStop : onReload}
          style={reloadStyle}
          testID="remote-browser-reload"
        >
          {isLoading ? (
            <ThemedX size={16} uniProps={mutedIcon} />
          ) : (
            <ThemedRotateCw size={16} uniProps={mutedIcon} />
          )}
        </ToolbarButton>
      </View>
      <View style={styles.urlBarWrap}>
        <View style={styles.badgeWrap}>
          <HostBadge badge={badge} />
        </View>
        <ThemedUrlInput
          accessibilityLabel={t("workspace.browser.controls.browserUrl")}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!disabled}
          initialValue={draftUrl}
          inputMode="url"
          keyboardType="url"
          onChangeText={setDraftUrl}
          onSubmitEditing={submitDraft}
          placeholder={t("workspace.browser.controls.enterUrl")}
          ref={urlInputRef}
          returnKeyType="go"
          selectTextOnFocus
          style={styles.urlInput}
          testID="remote-browser-url"
          uniProps={urlInputMapping}
        />
      </View>
      {keyboardShown === null ? null : (
        <View style={styles.chromeRight}>
          <ToolbarButton
            label={
              keyboardShown
                ? t("workspace.browser.remote.hideKeyboard")
                : t("workspace.browser.remote.showKeyboard")
            }
            active={keyboardShown}
            disabled={disabled}
            onPress={onToggleKeyboard}
            style={keyboardShown ? activeIconButtonStyle : reloadStyle}
            testID="remote-browser-keyboard-toggle"
          >
            <ThemedKeyboard size={16} uniProps={keyboardShown ? accentIcon : mutedIcon} />
          </ToolbarButton>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  chromeRow: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  chromeLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  chromeRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  iconButtonActive: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  iconButtonDisabled: {
    opacity: theme.opacity[50],
  },
  urlBarWrap: {
    flex: 1,
    minWidth: 0,
    height: 28,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  badgeWrap: {
    flexDirection: "row",
    maxWidth: "33%",
  },
  urlInput: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
}));
