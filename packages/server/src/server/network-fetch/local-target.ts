import os from "node:os";
import { reachesLocalListener } from "../remote-browser/egress-proxy.js";
import { normalizeAddress, type ResolvedTunnelAddress } from "../network-tunnel/target-policy.js";

/**
 * A daemon listening on `0.0.0.0` answers on every interface address of the host, so blocking
 * loopback alone leaves the control plane reachable through the host's LAN address.
 */
export function hostInterfaceAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flatMap((entries) =>
    (entries ?? []).map((entry) => normalizeAddress(entry.address).address),
  );
}

export function reachesThisHost(
  address: ResolvedTunnelAddress,
  interfaceAddresses: readonly string[],
): boolean {
  if (reachesLocalListener(address)) return true;
  return interfaceAddresses.includes(normalizeAddress(address.address).address);
}
