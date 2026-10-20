import { getIsElectron } from "@/constants/platform";
import { useHostFeature } from "@/runtime/host-features";

/**
 * Whether this host can show a browser tab on this platform: Electron brings its own routed
 * webview; native and plain web need the daemon's remote browser. Gate once here, nowhere else.
 */
export function useCanOpenBrowserTab(serverId: string | null | undefined): boolean {
  // COMPAT(remoteBrowser): added in v0.11.5, remove after 2027-04-19 once the daemon floor includes it.
  const remoteBrowser = useHostFeature(serverId, "remoteBrowser");
  return getIsElectron() || remoteBrowser;
}
