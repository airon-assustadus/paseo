import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { getRemoteBrowserBinding, setRemoteBrowserBinding } from "./registry";
import type { RemoteBrowserSession } from "./session";

const liveSessions = new Map<string, RemoteBrowserSession>();

function sessionKey(serverId: string, tabBrowserId: string): string {
  return `${serverId}\u0000${tabBrowserId}`;
}

export function registerLiveRemoteBrowserSession(
  serverId: string,
  tabBrowserId: string,
  session: RemoteBrowserSession,
): () => void {
  const key = sessionKey(serverId, tabBrowserId);
  liveSessions.set(key, session);
  return () => {
    if (liveSessions.get(key) === session) {
      liveSessions.delete(key);
    }
  };
}

function hostClient(serverId: string): DaemonClient | null {
  return getHostRuntimeStore().getSnapshot(serverId)?.client ?? null;
}

/**
 * The tab is gone: close its daemon browser. Through the mounted pane's attachment when there is
 * one (generation-safe close), otherwise through the Session-level close with the generation the
 * tab last held, so a browser taken over by another attachment is left alone.
 */
export function closeRemoteBrowserForTab(serverId: string, tabBrowserId: string): void {
  const live = liveSessions.get(sessionKey(serverId, tabBrowserId));
  if (live) {
    live.closeBrowser();
    return;
  }
  const binding = getRemoteBrowserBinding(serverId, tabBrowserId);
  setRemoteBrowserBinding(serverId, tabBrowserId, null);
  if (!binding) {
    return;
  }
  const client = hostClient(serverId);
  if (!client || client.getConnectionState().status !== "connected") {
    return;
  }
  client
    .closeRemoteBrowser(binding.browserId, { expectedGeneration: binding.generation })
    .catch(() => {});
}
