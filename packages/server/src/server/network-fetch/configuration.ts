import { isIP } from "node:net";
import { z } from "zod";
import {
  NetworkFetchConfigurationSchema,
  type NetworkFetchConfiguration,
} from "@getpaseo/protocol/network-fetch/rpc-schemas";
import { parseTrustedTarget, type TrustedAllowlist } from "./allowlist.js";

export const NetworkFetchConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    dedicatedContentDomain: z.string().min(1).optional(),
    controlOrigin: z.string().url().optional(),
    assetVersion: z.string().min(1).max(256).optional(),
    bootstrapPath: z.string().min(1).max(2048).optional(),
    pathPrefix: z.string().min(1).max(8192).optional(),
    ttlMs: z.number().int().min(1).max(2_147_483_647).optional(),
    handshakeTimeoutMs: z.number().int().min(1).max(2_147_483_647).optional(),
    allowlists: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            targets: z
              .array(
                z
                  .object({
                    origin: z.string().max(8192),
                    pathPrefix: z.string().max(8192),
                  })
                  .strict(),
              )
              .max(256),
          })
          .strict(),
      )
      .max(256)
      .optional(),
  })
  .strict();

export type NetworkFetchConfig = z.infer<typeof NetworkFetchConfigSchema>;

export interface ResolvedNetworkFetchConfiguration extends NetworkFetchConfiguration {
  controlOrigin: string;
  allowlists: readonly TrustedAllowlist[];
}

export function resolveNetworkFetchConfiguration(
  config: NetworkFetchConfig | undefined,
): ResolvedNetworkFetchConfiguration | null {
  if (!config?.enabled) return null;
  const parsed = NetworkFetchConfigSchema.required().parse(config);
  const domain = parsed.dedicatedContentDomain;
  validateContentDomain(domain);
  if (!parsed.allowlists.length) {
    throw new Error("Network fetch configuration is incomplete");
  }
  const control = new URL(parsed.controlOrigin);
  if (
    control.protocol !== "https:" ||
    control.origin !== parsed.controlOrigin ||
    control.hostname === domain ||
    control.hostname.endsWith(`.${domain}`)
  ) {
    throw new Error("Network fetch control origin must be separate and HTTPS");
  }
  const bootstrap = new URL(parsed.bootstrapPath, "https://content.invalid");
  if (
    !parsed.bootstrapPath.startsWith("/") ||
    parsed.bootstrapPath.startsWith("//") ||
    /[\\\\?#\s]/.test(parsed.bootstrapPath) ||
    bootstrap.origin !== "https://content.invalid" ||
    bootstrap.pathname !== parsed.bootstrapPath
  ) {
    throw new Error("Network fetch bootstrap path must be local and canonical");
  }
  parseTrustedTarget({ origin: control.origin, pathPrefix: parsed.pathPrefix });
  const ids = new Set<string>();
  const origins = new Set<string>();
  const allowlists = parsed.allowlists.map((allowlist) => {
    if (ids.has(allowlist.id)) throw new Error("Network fetch allowlist ids must be unique");
    ids.add(allowlist.id);
    return {
      ...allowlist,
      targets: allowlist.targets.map((input) => {
        const target = parseTrustedTarget(input);
        if (origins.has(target.origin))
          throw new Error("Network fetch target origins must be unambiguous");
        origins.add(target.origin);
        return target;
      }),
    };
  });
  const publicConfiguration = NetworkFetchConfigurationSchema.parse({
    dedicatedContentDomain: domain,
    assetVersion: parsed.assetVersion,
    bootstrapPath: parsed.bootstrapPath,
    pathPrefix: parsed.pathPrefix,
    ttlMs: parsed.ttlMs,
    handshakeTimeoutMs: parsed.handshakeTimeoutMs,
  });
  return { ...publicConfiguration, controlOrigin: control.origin, allowlists };
}

export function publicNetworkFetchConfiguration(
  config: ResolvedNetworkFetchConfiguration,
): NetworkFetchConfiguration {
  return {
    dedicatedContentDomain: config.dedicatedContentDomain,
    assetVersion: config.assetVersion,
    bootstrapPath: config.bootstrapPath,
    pathPrefix: config.pathPrefix,
    ttlMs: config.ttlMs,
    handshakeTimeoutMs: config.handshakeTimeoutMs,
  };
}

function validateContentDomain(domain: string): void {
  if (
    domain.length > 200 ||
    isIP(domain) ||
    domain !== domain.toLowerCase() ||
    !domain.includes(".") ||
    !domain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error("Network fetch requires an exact dedicated content domain");
  }
}
