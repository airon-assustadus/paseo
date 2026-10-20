/**
 * Which daemon browser a workspace browser tab is showing, per host. Kept in memory only: the
 * daemon browser dies with the daemon Session, so nothing here survives an app restart. A pane that
 * unmounts (hidden workspace, host switch) detaches and re-attaches to the same browser when it
 * mounts again; closing the tab forgets it.
 */
export interface RemoteBrowserBinding {
  browserId: string;
  generation: number;
  /** How long the daemon keeps the detached browser; after that a new mount opens a new one. */
  detachedTimeoutMs: number;
}

const bindings = new Map<string, RemoteBrowserBinding>();

function bindingKey(serverId: string, tabBrowserId: string): string {
  return `${serverId}\u0000${tabBrowserId}`;
}

export function getRemoteBrowserBinding(
  serverId: string,
  tabBrowserId: string,
): RemoteBrowserBinding | null {
  return bindings.get(bindingKey(serverId, tabBrowserId)) ?? null;
}

export function setRemoteBrowserBinding(
  serverId: string,
  tabBrowserId: string,
  binding: RemoteBrowserBinding | null,
): void {
  const key = bindingKey(serverId, tabBrowserId);
  if (binding) {
    bindings.set(key, binding);
  } else {
    bindings.delete(key);
  }
}

export function clearRemoteBrowserBindings(): void {
  bindings.clear();
}
