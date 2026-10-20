import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { RemoteBrowserRpcError } from "@getpaseo/client";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";
import { isHostUpdateRequired, remoteBrowserEndKey, remoteBrowserReasonKey } from "./copy";
import { RemoteBrowserPresentationError, type RemoteBrowserPhase } from "./session";

type Translate = (key: string, options?: Record<string, string>) => string;

export type PaneStatus =
  | { kind: "quiet" }
  | { kind: "busy"; text: string }
  | { kind: "alert"; title: string; body: string }
  | { kind: "notice"; title: string; body: string };

const ThemedSpinner = withUnistyles(LoadingSpinner);
const spinnerMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function errorCode(error: Error): string {
  return error instanceof RemoteBrowserRpcError ? error.code : error.name;
}

function describeFailure(error: Error, t: Translate, host: string): PaneStatus {
  const code = error instanceof RemoteBrowserPresentationError ? "presentation" : errorCode(error);
  if (isHostUpdateRequired(code)) {
    return {
      kind: "notice",
      title: t("workspace.browser.remote.unavailableTitle"),
      body: t("workspace.browser.remote.updateHost", { host }),
    };
  }
  return {
    kind: "alert",
    title: t("workspace.browser.remote.failedTitle", { host }),
    body: t(remoteBrowserReasonKey(code), { host }),
  };
}

/** What the viewport shows over (or instead of) the frames for the session's phase. */
export function describePhase(input: {
  phase: RemoteBrowserPhase;
  connected: boolean;
  t: Translate;
  host: string;
}): PaneStatus {
  const { phase, connected, t, host } = input;
  switch (phase.kind) {
    case "ready":
      return { kind: "quiet" };
    case "idle":
      return connected
        ? { kind: "busy", text: t("workspace.browser.remote.connecting", { host }) }
        : {
            kind: "notice",
            title: t("workspace.browser.remote.offlineTitle", { host }),
            body: t("workspace.browser.remote.offlineSubtitle"),
          };
    case "opening":
      return { kind: "busy", text: t("workspace.browser.remote.connecting", { host }) };
    case "reconnecting":
      return { kind: "busy", text: t("workspace.browser.remote.reconnecting", { host }) };
    case "failed":
      return describeFailure(phase.error, t, host);
    case "ended":
      return {
        kind: "alert",
        title: t("workspace.browser.remote.endedTitle", { host }),
        body: t(remoteBrowserEndKey(phase.end), { host }),
      };
  }
}

/** The host needs a daemon with the remote browser; nothing else can be shown. */
export function PaneUnsupported({ host }: { host: string }) {
  const { t } = useTranslation();
  return (
    <View style={styles.centered} testID="remote-browser-unsupported">
      <Text style={styles.stateTitle}>{t("workspace.browser.remote.unavailableTitle")}</Text>
      <Text style={styles.stateSubtitle}>{t("workspace.browser.remote.updateHost", { host })}</Text>
    </View>
  );
}

/** Overlay for a non-ready phase: spinner, a quiet notice, or an alert with Retry. */
export function PaneStatusOverlay({
  status,
  onRetry,
}: {
  status: PaneStatus;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  switch (status.kind) {
    case "quiet":
      return null;
    case "busy":
      return (
        <View style={styles.overlay} pointerEvents="none" testID="remote-browser-busy">
          <ThemedSpinner size="small" uniProps={spinnerMapping} />
          <Text style={styles.stateSubtitle}>{status.text}</Text>
        </View>
      );
    case "notice":
      return (
        <View style={styles.overlay} testID="remote-browser-state">
          <Text style={styles.stateTitle}>{status.title}</Text>
          <Text style={styles.stateSubtitle}>{status.body}</Text>
        </View>
      );
    case "alert":
      return (
        <View style={styles.alertWrap} testID="remote-browser-alert">
          <Alert variant="error" size="sm" title={status.title} description={status.body}>
            <Button variant="outline" size="sm" onPress={onRetry} testID="remote-browser-retry">
              {t("workspace.browser.remote.retry")}
            </Button>
          </Alert>
        </View>
      );
  }
}

/** One line under the toolbar: a page load error or a daemon notice. */
export function PaneMessageRow({
  text,
  tone,
  testID,
}: {
  text: string;
  tone: "error" | "notice";
  testID: string;
}) {
  return (
    <View style={styles.messageRow} testID={testID}>
      <Text numberOfLines={2} style={tone === "error" ? styles.errorText : styles.noticeText}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[6],
  },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[6],
  },
  alertWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    padding: theme.spacing[3],
  },
  stateTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  stateSubtitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  messageRow: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[300],
  },
  noticeText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
