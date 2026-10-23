import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { NetworkFetchConfiguration } from "@getpaseo/protocol/network-fetch/rpc-schemas";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { isWeb } from "@/constants/platform";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { UrlForm } from "@/remote-browser/url-form";
import { createWebProxyProductController } from "@/web-proxy/product-controller.web";
import type { WebProxyProductController, WebProxyProductSnapshot } from "@/web-proxy/product-types";
import { normalizeWorkspaceBrowserUrl, useBrowserStore } from "./store";

interface DomProxyPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  configuration: NetworkFetchConfiguration;
  isInteractive?: boolean;
  onFocusPane?: () => void;
}

const emptySnapshot: WebProxyProductSnapshot = {
  phase: "closed",
  url: null,
  title: null,
  canNavigate: false,
  canReload: false,
  canGoBack: false,
  canGoForward: false,
  canResume: false,
  canRequestClear: false,
  error: null,
  cleanup: { status: "unknown", requiredEpoch: null },
};
const noSubscribe = () => () => {};
const surfaceStyle = { display: "flex", flex: 1, minHeight: 0, minWidth: 0 };

function getNotice(snapshot: WebProxyProductSnapshot, connected: boolean, actionFailed: boolean) {
  switch (snapshot.cleanup.status) {
    case "pending_local":
      return { key: "webProxy.cleanupLocal", variant: "warning" } as const;
    case "pending_host":
      return { key: "webProxy.cleanupPending", variant: "warning" } as const;
    case "partial":
      return { key: "webProxy.cleanupPartial", variant: "warning" } as const;
  }
  if (snapshot.error?.code === "navigation_unavailable") {
    return { key: "webProxy.navigationUnavailable", variant: "error" } as const;
  }
  if (snapshot.error || actionFailed) {
    return { key: "webProxy.actionFailed", variant: "error" } as const;
  }
  if (!connected) return { key: "webProxy.offline", variant: "info" } as const;
  if (snapshot.phase === "opening") return { key: "webProxy.opening", variant: "info" } as const;
  if (snapshot.phase === "suspended")
    return { key: "webProxy.suspended", variant: "info" } as const;
  return null;
}

function useProductController({
  browserId,
  serverId,
  workspaceId,
  configuration,
}: DomProxyPaneProps) {
  const client = useHostRuntimeClient(serverId);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const [controller, setController] = useState<WebProxyProductController | null>(null);
  useEffect(() => {
    if (!isWeb || !client || !surface) return;
    const next = createWebProxyProductController({
      client,
      container: surface,
      view: { serverId, workspaceId, browserId },
      enabled: true,
      configuration,
    });
    setController(next);
    return () => {
      next.closeView();
      setController(null);
    };
  }, [browserId, client, configuration, serverId, surface, workspaceId]);
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    () => controller?.getSnapshot() ?? emptySnapshot,
    () => emptySnapshot,
  );
  return { client, surface, setSurface, controller, snapshot };
}

function useControllerActions(controller: WebProxyProductController | null, interactive: boolean) {
  const [actionFailed, setActionFailed] = useState(false);
  const run = useCallback(
    (operation: () => Promise<void>) => {
      if (!interactive) return;
      setActionFailed(false);
      void operation().catch(() => setActionFailed(true));
    },
    [interactive],
  );
  const actions = useMemo(
    () => ({
      back: () => controller && run(() => controller.goBack()),
      forward: () => controller && run(() => controller.goForward()),
      reload: () => controller && run(() => controller.reload()),
      stop: () => {
        if (interactive) controller?.stop();
      },
      resume: () => controller && run(() => controller.resume()),
      clear: () => controller && run(() => controller.requestClear()),
    }),
    [controller, interactive, run],
  );
  return { actions, run, actionFailed };
}

export function DomProxyPane({
  browserId,
  serverId,
  workspaceId,
  configuration,
  isInteractive = true,
  onFocusPane,
}: DomProxyPaneProps) {
  const { t } = useTranslation();
  const { client, surface, setSurface, controller, snapshot } = useProductController({
    browserId,
    serverId,
    workspaceId,
    configuration,
  });
  const presented = useRetainedPanelActive();
  const interactive = isInteractive && presented;
  const { actions, run, actionFailed } = useControllerActions(controller, interactive);
  const input = useRef<EditingTextInputHandle | null>(null);
  const initialUrl = useBrowserStore((state) => state.browsersById[browserId]?.url ?? "");

  useEffect(() => {
    if (isWeb && surface) surface.inert = !interactive;
  }, [interactive, surface]);

  useEffect(() => {
    if (snapshot.url !== null) input.current?.replaceText(snapshot.url);
  }, [snapshot.url]);

  useEffect(() => {
    if (snapshot.url !== null) {
      useBrowserStore.getState().updateBrowser(browserId, {
        url: snapshot.url,
        ...(snapshot.title !== null ? { title: snapshot.title } : {}),
        canGoBack: snapshot.canGoBack,
        canGoForward: snapshot.canGoForward,
        isLoading: snapshot.phase === "opening",
      });
    }
  }, [browserId, snapshot]);

  const canSubmit =
    interactive &&
    controller !== null &&
    snapshot.phase !== "opening" &&
    (snapshot.canNavigate ||
      snapshot.phase === "unavailable" ||
      snapshot.phase === "closed" ||
      snapshot.phase === "blocked");
  const submit = useCallback(() => {
    if (!canSubmit || !controller) return;
    const url = normalizeWorkspaceBrowserUrl(input.current?.getText() ?? initialUrl);
    run(() => (snapshot.canNavigate ? controller.navigate(url) : controller.open(url)));
  }, [canSubmit, controller, initialUrl, run, snapshot.canNavigate]);
  const notice = getNotice(snapshot, client !== null, actionFailed);

  return (
    <View style={styles.root} testID="dom-proxy-pane" onTouchStart={onFocusPane}>
      <View style={styles.toolbar}>
        <Button
          size="xs"
          variant="ghost"
          disabled={!interactive || !snapshot.canGoBack}
          onPress={actions.back}
        >
          {t("workspace.browser.controls.back")}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!interactive || !snapshot.canGoForward}
          onPress={actions.forward}
        >
          {t("workspace.browser.controls.forward")}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!interactive || !snapshot.canReload}
          onPress={actions.reload}
        >
          {t("workspace.browser.controls.refresh")}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!interactive || !controller || snapshot.phase === "closed"}
          onPress={actions.stop}
        >
          {t("webProxy.stop")}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!interactive || !snapshot.canResume}
          onPress={actions.resume}
        >
          {t("webProxy.resume")}
        </Button>
      </View>
      <View style={styles.addressRow}>
        <UrlForm onSubmit={submit}>
          <EditingTextInput
            ref={input}
            initialValue={initialUrl}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            editable={interactive && snapshot.phase !== "opening"}
            accessibilityLabel={t("workspace.browser.controls.browserUrl")}
            placeholder={t("workspace.browser.controls.enterUrl")}
            onSubmitEditing={submit}
            testID="dom-proxy-url"
          />
          <Button size="sm" variant="outline" disabled={!canSubmit} onPress={submit}>
            {t("workspace.browser.controls.navigate")}
          </Button>
        </UrlForm>
      </View>
      {notice && (
        <View style={styles.notice}>
          <Alert
            variant={notice.variant}
            size="sm"
            description={t(notice.key)}
            testID="dom-proxy-status"
          />
        </View>
      )}
      <div ref={setSurface} style={surfaceStyle} data-testid="dom-proxy-surface" />
      <View style={styles.toolbar}>
        <Button
          size="xs"
          variant="outline"
          disabled={!interactive || !snapshot.canRequestClear}
          onPress={actions.clear}
        >
          {t("webProxy.requestCleanup")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.surface0 },
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[2],
  },
  addressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  input: { flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  notice: { padding: theme.spacing[2] },
}));
