import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { RemoteBrowserState } from "@getpaseo/client";
import { useBrowserStore } from "@/desktop/browser/store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { getRemoteBrowserBinding, setRemoteBrowserBinding } from "./registry";
import {
  createRemoteBrowserSession,
  type RemoteBrowserSession,
  type RemoteBrowserSessionSnapshot,
} from "./session";
import { registerLiveRemoteBrowserSession } from "./tabs";

const EMPTY_SNAPSHOT: RemoteBrowserSessionSnapshot = {
  phase: { kind: "idle" },
  attachmentEpoch: 0,
  browserState: null,
  frame: null,
  operationError: null,
};

function noopSubscribe(): () => void {
  return () => {};
}

function writeBrowserRecord(tabBrowserId: string, state: RemoteBrowserState): void {
  useBrowserStore.getState().updateBrowser(tabBrowserId, {
    url: state.url,
    title: state.title,
    isLoading: state.loading,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
  });
}

/**
 * One session per mounted pane. It starts on mount, detaches on unmount, and re-attaches to the
 * browser the tab was bound to before. The tab's persisted record follows the daemon's state so the
 * tab strip shows the live title and loading status.
 */
export function useRemoteBrowserSession(input: {
  serverId: string;
  tabBrowserId: string;
  initialUrl: string;
}): { session: RemoteBrowserSession | null; snapshot: RemoteBrowserSessionSnapshot } {
  const { serverId, tabBrowserId, initialUrl } = input;
  const client = useHostRuntimeClient(serverId);
  const session = useMemo(() => {
    if (!client) {
      return null;
    }
    return createRemoteBrowserSession({
      client,
      initialUrl,
      binding: getRemoteBrowserBinding(serverId, tabBrowserId),
      onBinding: (binding) => setRemoteBrowserBinding(serverId, tabBrowserId, binding),
      onBrowserState: (state) => writeBrowserRecord(tabBrowserId, state),
    });
    // The initial URL only seeds the first open; later navigation comes from the daemon's state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, serverId, tabBrowserId]);

  useEffect(() => {
    if (!session) {
      return;
    }
    const unregister = registerLiveRemoteBrowserSession(serverId, tabBrowserId, session);
    session.start();
    return () => {
      unregister();
      session.dispose();
    };
  }, [serverId, session, tabBrowserId]);

  const snapshot = useSyncExternalStore(
    session ? session.subscribe : noopSubscribe,
    () => session?.getSnapshot() ?? EMPTY_SNAPSHOT,
    () => session?.getSnapshot() ?? EMPTY_SNAPSHOT,
  );

  return { session, snapshot };
}
