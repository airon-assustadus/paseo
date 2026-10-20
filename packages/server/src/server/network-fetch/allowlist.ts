import { isIP } from "node:net";
import { isDeniedAddress, normalizeAddress } from "../network-tunnel/target-policy.js";
import { NetworkFetchError } from "./errors.js";

/**
 * The destinations a session may reach. It comes from trusted host configuration, never from the
 * proxied page: content cannot add a target, widen a path, or turn one origin into an alias of
 * another. Matching is exact on the WHATWG origin, so `localhost`, `127.0.0.1`, `[::1]`, and
 * `app.localhost` are four unrelated targets.
 */
export interface TrustedAllowlist {
  id: string;
  revision: number;
  targets: readonly TrustedTarget[];
}

export interface AllowlistStore {
  get(id: string): TrustedAllowlist | null;
}

export interface TrustedTargetInput {
  origin: string;
  /** `/` for the whole origin, otherwise a path ending in `/`. */
  pathPrefix: string;
}

export interface TrustedTarget {
  origin: string;
  pathPrefix: string;
}

export class AllowlistEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowlistEntryError";
  }
}

const ENCODED_SEPARATOR = /%2f|%5c/i;

export function parseTrustedTarget(input: TrustedTargetInput): TrustedTarget {
  let url: URL;
  try {
    url = new URL(input.origin);
  } catch {
    throw new AllowlistEntryError("Allowlist origin is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AllowlistEntryError("Allowlist origin must be http or https");
  }
  const hasExtraParts =
    url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "";
  if (hasExtraParts || url.pathname !== "/") {
    throw new AllowlistEntryError("Allowlist origin must be scheme, host, and port only");
  }
  if (url.hostname.endsWith(".") || url.hostname.includes("*")) {
    throw new AllowlistEntryError("Allowlist host must be an exact name");
  }
  const literal = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (isIP(literal) && isDeniedAddress(normalizeAddress(literal))) {
    throw new AllowlistEntryError("Allowlist host is a denied address");
  }
  return { origin: url.origin, pathPrefix: parsePathPrefix(input.pathPrefix, url) };
}

function parsePathPrefix(pathPrefix: string, origin: URL): string {
  const isCanonical =
    pathPrefix.startsWith("/") &&
    pathPrefix.endsWith("/") &&
    !ENCODED_SEPARATOR.test(pathPrefix) &&
    new URL(pathPrefix, origin).pathname === pathPrefix;
  if (!isCanonical) {
    throw new AllowlistEntryError("Allowlist path prefix must be a canonical path ending in /");
  }
  return pathPrefix;
}

/** Validates a URL a request names; the fragment never leaves the client side. */
export function parseRequestUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NetworkFetchError("invalid_request", "Request URL is not absolute");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NetworkFetchError("invalid_request", "Request URL must be http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new NetworkFetchError("invalid_request", "Request URL must not carry credentials");
  }
  if (url.hostname === "" || url.hostname.endsWith(".")) {
    throw new NetworkFetchError("invalid_request", "Request host must be an exact name");
  }
  url.hash = "";
  return url;
}

export function findAllowedTarget(allowlist: TrustedAllowlist, url: URL): TrustedTarget | null {
  for (const target of allowlist.targets) {
    if (target.origin !== url.origin) continue;
    if (!url.pathname.startsWith(target.pathPrefix)) continue;
    // A server may decode %2F after this check and walk out of the prefix.
    if (target.pathPrefix !== "/" && ENCODED_SEPARATOR.test(url.pathname)) continue;
    return target;
  }
  return null;
}

export function isAllowedOrigin(allowlist: TrustedAllowlist, origin: string): boolean {
  return allowlist.targets.some((target) => target.origin === origin);
}
