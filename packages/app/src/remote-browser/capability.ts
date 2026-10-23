import { NetworkFetchConfigurationSchema } from "@getpaseo/protocol/network-fetch/rpc-schemas";
import { getIsElectron, isWeb } from "@/constants/platform";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";

/**
 * Tab eligibility precedes the panel's mode choice. It does not grant network authority;
 * the selected controller still validates the current host before opening a destination.
 */
export function useCanOpenBrowserTab(serverId: string | null | undefined): boolean {
  // COMPAT(remoteBrowser): added in v0.11.5, remove after 2027-04-19 once the daemon floor includes it.
  const remoteBrowser = useHostFeature(serverId, "remoteBrowser");
  const networkFetch = useHostFeature(serverId, "networkFetch");
  const configuration = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.serverInfo?.networkFetchConfiguration : undefined,
  );
  return (
    getIsElectron() ||
    remoteBrowser ||
    (isWeb && networkFetch && NetworkFetchConfigurationSchema.safeParse(configuration).success)
  );
}
