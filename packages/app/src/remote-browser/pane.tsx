import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PixelRatio, View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { GestureDetector } from "react-native-gesture-handler";
import type {
  RemoteBrowserFrame,
  RemoteBrowserInputEvent,
  RemoteBrowserState,
} from "@getpaseo/client";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useBrowserStore } from "@/desktop/browser/store";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeConnectionStatus, useHosts } from "@/runtime/host-runtime";
import { RemoteBrowserChrome } from "./chrome";
import { remoteBrowserLoadErrorKey, remoteBrowserNoticeKey } from "./copy";
import { FrameView } from "./frame-view";
import { KeyboardInput } from "./keyboard-input";
import { resolveInputPrivacy } from "./keyboard-input-props";
import { describePhase, PaneMessageRow, PaneStatusOverlay, PaneUnsupported } from "./pane-status";
import { useRemoteKeyboard } from "./use-remote-keyboard";
import { useRemotePointer } from "./use-remote-pointer";
import type { RemoteBrowserSession } from "./session";
import { useRemoteBrowserSession } from "./use-session";
import { mapPointToPage, placeFrame, requestViewport, type BoxSize, type Point } from "./viewport";

export interface RemoteBrowserPaneProps {
  browserId: string;
  serverId: string;
  isInteractive?: boolean;
  onFocusPane?: () => void;
}

const EMPTY_BOX: BoxSize = { width: 0, height: 0 };
const NOTICE_VISIBLE_MS = 6000;
const DEFAULT_URL = "https://example.com";

/** The daemon's latest notice stays on screen briefly, then clears on its own. */
function useTransientNoticeKey(browserState: RemoteBrowserState | null): string | null {
  const notice = browserState?.notice ?? null;
  const [kind, setKind] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) {
      return;
    }
    setKind(notice.kind);
    const handle = setTimeout(() => setKind(null), NOTICE_VISIBLE_MS);
    return () => clearTimeout(handle);
  }, [notice]);
  return kind ? remoteBrowserNoticeKey(kind) : null;
}

/** The page load error, or the last refused operation, as one line for the user. */
function useErrorLine(input: {
  browserState: RemoteBrowserState | null;
  operationError: Error | null;
  host: string;
}): string | null {
  const { browserState, operationError, host } = input;
  const { t } = useTranslation();
  const loadError = browserState?.error ?? null;
  return useMemo(() => {
    if (loadError) {
      return t(remoteBrowserLoadErrorKey(loadError.code), { host });
    }
    return operationError ? t("workspace.browser.remote.inputFailed", { host }) : null;
  }, [host, loadError, operationError, t]);
}

/** Toolbar and frame callbacks bound to the pane's session; inert until it exists. */
function useSessionActions(session: RemoteBrowserSession | null) {
  return useMemo(
    () => ({
      navigate: (url: string) => session?.navigate({ kind: "url", url }),
      goBack: () => session?.navigate({ kind: "back" }),
      goForward: () => session?.navigate({ kind: "forward" }),
      reload: () => session?.navigate({ kind: "reload" }),
      stop: () => session?.navigate({ kind: "stop" }),
      retry: () => session?.retry(),
      dispatch: (events: RemoteBrowserInputEvent[]) => session?.dispatch(events),
      painted: (frame: RemoteBrowserFrame) => session?.framePainted(frame),
      presentationFailed: (frame: RemoteBrowserFrame) => session?.framePresentationFailed(frame),
    }),
    [session],
  );
}

/** Where the current frame sits in the pane and how pane points map to page pixels. */
function useFrameGeometry(input: {
  frame: RemoteBrowserFrame | null;
  box: BoxSize;
  browserState: RemoteBrowserState | null;
}) {
  const { frame, box, browserState } = input;
  const frameSize = useMemo<BoxSize>(
    () => (frame ? { width: frame.cssWidth, height: frame.cssHeight } : EMPTY_BOX),
    [frame],
  );
  const placement = useMemo(() => placeFrame(frameSize, box), [box, frameSize]);
  const pageViewport = browserState?.viewport ?? null;
  const toPage = useCallback(
    (point: Point): Point | null =>
      pageViewport
        ? mapPointToPage({ point, placement, content: frameSize, viewport: pageViewport })
        : null,
    [frameSize, pageViewport, placement],
  );
  return { placement, toPage };
}

function chromeStateOf(browserState: RemoteBrowserState | null, initialUrl: string) {
  return {
    url: browserState?.url ?? initialUrl,
    canGoBack: browserState?.canGoBack ?? false,
    canGoForward: browserState?.canGoForward ?? false,
    isLoading: browserState?.loading ?? false,
  };
}

function useViewportBox(): { box: BoxSize; onLayout: (event: LayoutChangeEvent) => void } {
  const [box, setBox] = useState<BoxSize>(EMPTY_BOX);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBox((current) =>
      current.width === width && current.height === height ? current : { width, height },
    );
  }, []);
  return { box, onLayout };
}

function useHostLabel(serverId: string) {
  const hosts = useHosts();
  const host = hosts.find((entry) => entry.serverId === serverId);
  return { label: host?.label.trim() || serverId, color: host?.appearance.color ?? "none" };
}

/**
 * The browser tab on Android and plain web: a page rendered by the host's own browser, streamed
 * as frames and driven by touch, mouse and the device keyboard. One attachment per mounted pane;
 * see session.ts for the lifecycle and keyboard.ts for how typing reaches the page.
 */
export function RemoteBrowserPane({
  browserId,
  serverId,
  isInteractive = true,
  onFocusPane,
}: RemoteBrowserPaneProps) {
  const { t } = useTranslation();
  const host = useHostLabel(serverId);
  const connected = useHostRuntimeConnectionStatus(serverId) === "online";
  // COMPAT(remoteBrowser): added in v0.11.5, remove after 2027-04-19 once the daemon floor includes it.
  const supported = useHostFeature(serverId, "remoteBrowser");
  const isCompact = useIsCompactFormFactor();
  const isPresented = useRetainedPanelActive();
  // Input reaches the page only from a focused, visible pane; a hidden or unfocused one must
  // neither type nor scroll it.
  const inputEnabled = isInteractive && isPresented;
  const record = useBrowserStore((state) => state.browsersById[browserId] ?? null);
  const initialUrl = record?.url ?? DEFAULT_URL;

  const { session, snapshot } = useRemoteBrowserSession({
    serverId,
    tabBrowserId: browserId,
    initialUrl,
  });
  const { phase, browserState, frame, operationError, attachmentEpoch } = snapshot;
  const { box, onLayout } = useViewportBox();
  const surfaceRef = useRef<View | null>(null);
  const actions = useSessionActions(session);

  useEffect(() => {
    session?.setVisible(isPresented);
  }, [isPresented, session]);

  useEffect(() => {
    session?.setViewport(
      requestViewport({
        box,
        devicePixelRatio: PixelRatio.get(),
        mobile: isCompact,
        touch: isNative || isCompact,
      }),
    );
  }, [box, isCompact, session]);

  const { placement, toPage } = useFrameGeometry({ frame, box, browserState });
  const focusedEditable = browserState?.focusedEditable ?? null;
  const keyboard = useRemoteKeyboard({
    dispatch: actions.dispatch,
    inputEnabled,
    focusedEditable,
    attachmentEpoch,
  });
  const gesture = useRemotePointer({
    surfaceRef,
    dispatch: actions.dispatch,
    inputEnabled,
    toPage,
    onPointerDown: keyboard.commitKeyboard,
    onFocusPane,
  });

  const noticeKey = useTransientNoticeKey(browserState);
  const errorLine = useErrorLine({ browserState, operationError, host: host.label });
  const status = describePhase({ phase, connected, t, host: host.label });
  const chrome = chromeStateOf(browserState, initialUrl);

  if (!supported) {
    return <PaneUnsupported host={host.label} />;
  }

  return (
    <View style={styles.container} testID={`remote-browser-pane-${browserId}`}>
      <RemoteBrowserChrome
        serverId={serverId}
        hostLabel={host.label}
        hostColor={host.color}
        {...chrome}
        keyboardShown={isNative || isCompact ? keyboard.keyboardFocused : null}
        disabled={phase.kind !== "ready" || !isInteractive}
        onBack={actions.goBack}
        onForward={actions.goForward}
        onReload={actions.reload}
        onStop={actions.stop}
        onNavigate={actions.navigate}
        onToggleKeyboard={keyboard.toggleKeyboard}
      />
      {errorLine ? (
        <PaneMessageRow text={errorLine} tone="error" testID="remote-browser-error" />
      ) : null}
      {noticeKey ? (
        <PaneMessageRow text={t(noticeKey)} tone="notice" testID="remote-browser-notice" />
      ) : null}
      <View style={styles.viewport} onLayout={onLayout} testID="remote-browser-viewport">
        <GestureDetector gesture={gesture}>
          <View ref={surfaceRef} style={styles.surface} collapsable={false}>
            <FrameView
              frame={frame}
              placement={placement}
              accessibilityLabel={t("workspace.browser.remote.viewport", { host: host.label })}
              onPainted={actions.painted}
              onPresentationFailed={actions.presentationFailed}
            />
          </View>
        </GestureDetector>
        <PaneStatusOverlay status={status} onRetry={actions.retry} />
        <KeyboardInput
          ref={keyboard.keyboardRef}
          privacy={resolveInputPrivacy(focusedEditable)}
          inputMode={focusedEditable?.inputMode ?? null}
          enterKeyHint={focusedEditable?.enterKeyHint ?? null}
          onSnapshot={keyboard.handleSnapshot}
          onKey={keyboard.handleKey}
          onFocusChange={keyboard.handleKeyboardFocus}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  viewport: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: theme.colors.surface1,
  },
  surface: {
    flex: 1,
    minHeight: 0,
  },
}));
