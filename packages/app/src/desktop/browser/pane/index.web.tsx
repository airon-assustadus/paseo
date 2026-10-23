import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RemoteBrowserPane } from "@/remote-browser/pane";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { DomProxyPane } from "../dom-proxy-pane.web";
import { useWebProxySettings, webProxySettings } from "../web-proxy-settings";

interface BrowserPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  isInteractive?: boolean;
  onFocusPane?: () => void;
}

function loadPreferences() {
  void webProxySettings.getState().load();
}

export function BrowserPane({
  browserId,
  serverId,
  workspaceId,
  isInteractive,
  onFocusPane,
}: BrowserPaneProps) {
  const { t } = useTranslation();
  const ready = useWebProxySettings((state) => state.ready);
  const loading = useWebProxySettings((state) => state.loading);
  const failed = useWebProxySettings((state) => state.failed);
  const domEnabled = useWebProxySettings((state) => state.domByHost[serverId] === true);
  const supported = useHostFeature(serverId, "networkFetch");
  const configuration = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.networkFetchConfiguration ?? null,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void webProxySettings.getState().load();
  }, []);

  const chooseMode = useCallback(
    (enabled: boolean) => {
      if (saving) return;
      setSaving(true);
      void webProxySettings
        .getState()
        .setDomEnabled(serverId, enabled)
        .finally(() => setSaving(false));
    },
    [saving, serverId],
  );
  const chooseDom = useCallback(() => chooseMode(true), [chooseMode]);
  const chooseImage = useCallback(() => chooseMode(false), [chooseMode]);

  if (!ready) {
    return (
      <View style={styles.notice}>
        {failed ? (
          <Alert variant="error" description={t("webProxy.preferenceFailed")}>
            <Button variant="outline" size="sm" disabled={loading} onPress={loadPreferences}>
              {t("common.actions.retry")}
            </Button>
          </Alert>
        ) : (
          <Text style={styles.text}>{t("common.loading")}</Text>
        )}
      </View>
    );
  }

  let content;
  if (!domEnabled) {
    content = (
      <RemoteBrowserPane
        key={`${serverId}:${browserId}`}
        browserId={browserId}
        serverId={serverId}
        isInteractive={isInteractive}
        onFocusPane={onFocusPane}
      />
    );
  } else if (supported && configuration) {
    content = (
      <DomProxyPane
        key={`${serverId}:${browserId}`}
        browserId={browserId}
        serverId={serverId}
        workspaceId={workspaceId}
        configuration={configuration}
        isInteractive={isInteractive}
        onFocusPane={onFocusPane}
      />
    );
  } else {
    content = (
      <View style={styles.notice}>
        <Alert variant="info" description={t("webProxy.unavailable")} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.modes}>
        <Button
          size="xs"
          variant={domEnabled ? "secondary" : "ghost"}
          disabled={saving || domEnabled || !supported || !configuration}
          onPress={chooseDom}
        >
          {t("webProxy.useDom")}
        </Button>
        <Button
          size="xs"
          variant={domEnabled ? "ghost" : "secondary"}
          disabled={saving || !domEnabled}
          onPress={chooseImage}
        >
          {t("webProxy.useImage")}
        </Button>
      </View>
      {failed && (
        <View style={styles.notice}>
          <Alert variant="error" size="sm" description={t("webProxy.preferenceFailed")} />
        </View>
      )}
      {content}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0, minWidth: 0 },
  modes: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    padding: theme.spacing[2],
  },
  notice: { padding: theme.spacing[2] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));
