import { RemoteBrowserPane } from "@/remote-browser/pane";

interface BrowserPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  isInteractive?: boolean;
  onFocusPane?: () => void;
}

/** Plain web (mobile Chrome, desktop browsers): the host's remote browser streamed into the pane. */
export function BrowserPane({ browserId, serverId, isInteractive, onFocusPane }: BrowserPaneProps) {
  return (
    <RemoteBrowserPane
      browserId={browserId}
      serverId={serverId}
      isInteractive={isInteractive}
      onFocusPane={onFocusPane}
    />
  );
}
