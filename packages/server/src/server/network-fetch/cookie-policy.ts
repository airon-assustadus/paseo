import { isIP } from "node:net";
import { domainToASCII } from "node:url";

export const HOST_COOKIE_PROFILE = "host-cookie-opaque-v1" as const;
export const HOST_COOKIE_LIMITS = {
  cookieBytes: 4096,
  responseCookies: 100,
  destinationCookies: 180,
  principalCookies: 2000,
  daemonCookies: 10000,
  jarBytes: 16 * 1024 * 1024,
  snapshotBytes: 32 * 1024 * 1024,
  requestCookieBytes: 8192,
  lifetimeMs: 180 * 24 * 60 * 60 * 1000,
} as const;

export type CookieSameSite = "strict" | "lax" | "none";
export type CookieJarErrorCode =
  | "cookie_jar_limit"
  | "invalid_cookie_state"
  | "cookie_epoch_conflict"
  | "cookie_partition_denied"
  | "cookie_jar_unavailable";

export class CookieJarError extends Error {
  constructor(readonly code: CookieJarErrorCode) {
    super(code);
    this.name = "CookieJarError";
  }
}

export interface ParsedCookieCandidate {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  maxAgeSeconds?: string;
  expiresAt?: number;
  partitioned: boolean;
  sourceBytes: number;
}

export interface HostCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: true;
  httpOnly: boolean;
  sameSite: "none";
  expiresAt: number | null;
  createdAt: number;
}

export interface CookieSource {
  url: string;
  now: number;
}

export interface CookiePolicyPorts {
  isPublicSuffix(domain: string): boolean | null;
}

export type CookieDecision =
  | { kind: "accept"; cookie: HostCookie }
  | { kind: "delete"; key: Pick<HostCookie, "name" | "domain" | "path"> }
  | {
      kind: "reject";
      reason: "syntax" | "context" | "domain" | "secure" | "prefix" | "partitioned";
    };

const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;

export function hasCookieControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function normalizeCookieSameSite(attribute: string | undefined): CookieSameSite {
  const normalized = attribute?.trim().toLowerCase();
  return normalized === "strict" || normalized === "none" ? normalized : "lax";
}

export function assertCookieTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new CookieJarError("invalid_cookie_state");
}

export function cookieSourceUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CookieJarError("invalid_cookie_state");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.hostname.endsWith(".")
  ) {
    throw new CookieJarError("invalid_cookie_state");
  }
  return url;
}

export function cookieDomainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || (!isIP(hostname) && hostname.endsWith(`.${domain}`));
}

export function cookiePathMatches(requestPath: string, cookiePath: string): boolean {
  return (
    requestPath === cookiePath ||
    (requestPath.startsWith(cookiePath) &&
      (cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/"))
  );
}

export function cookieDefaultPath(pathname: string): string {
  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}

function canonicalCookieDomain(domain: string): string | null {
  const canonical = domainToASCII(domain.replace(/^\./, "")).toLowerCase();
  if (
    !canonical ||
    canonical.length > 253 ||
    !canonical.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return null;
  return canonical;
}

function expiration(candidate: ParsedCookieCandidate, now: number): number | null {
  const maximum = Math.min(Number.MAX_SAFE_INTEGER, now + HOST_COOKIE_LIMITS.lifetimeMs);
  if (candidate.maxAgeSeconds !== undefined && /^-?\d+$/.test(candidate.maxAgeSeconds)) {
    const seconds = BigInt(candidate.maxAgeSeconds);
    if (seconds <= 0n) return now;
    return seconds >= BigInt(HOST_COOKIE_LIMITS.lifetimeMs / 1000)
      ? maximum
      : Math.min(maximum, now + Number(seconds) * 1000);
  }
  return candidate.expiresAt !== undefined && Number.isSafeInteger(candidate.expiresAt)
    ? Math.min(candidate.expiresAt, maximum)
    : null;
}

function validCandidate(candidate: ParsedCookieCandidate): boolean {
  const attributes = [
    candidate.domain,
    candidate.path,
    candidate.sameSite,
    candidate.maxAgeSeconds,
  ];
  return (
    typeof candidate.name === "string" &&
    COOKIE_NAME.test(candidate.name) &&
    validCookieValue(candidate.value) &&
    typeof candidate.secure === "boolean" &&
    typeof candidate.httpOnly === "boolean" &&
    typeof candidate.partitioned === "boolean" &&
    Number.isSafeInteger(candidate.sourceBytes) &&
    candidate.sourceBytes > 0 &&
    candidate.sourceBytes <= HOST_COOKIE_LIMITS.cookieBytes &&
    attributes.every(
      (attribute) => attribute === undefined || !hasCookieControlCharacters(attribute),
    ) &&
    Buffer.byteLength(candidate.name + candidate.value + attributes.join("")) <=
      HOST_COOKIE_LIMITS.cookieBytes
  );
}

function validCookieValue(value: string): boolean {
  if (typeof value !== "string") return false;
  const unquoted =
    value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return COOKIE_VALUE.test(unquoted);
}

function validCookiePrefixes(
  cookie: Pick<HostCookie, "name" | "httpOnly">,
  hostOnly: boolean,
  path: string | undefined,
): boolean {
  if (cookie.name.startsWith("__Host-") && (!hostOnly || path !== "/")) return false;
  return !(
    (cookie.name.startsWith("__Http-") || cookie.name.startsWith("__Host-Http-")) &&
    !cookie.httpOnly
  );
}

export function evaluateCookie(
  candidate: ParsedCookieCandidate,
  source: CookieSource,
  ports: CookiePolicyPorts,
): CookieDecision {
  assertCookieTime(source.now);
  const url = cookieSourceUrl(source.url);
  if (!validCandidate(candidate)) return { kind: "reject", reason: "syntax" };
  if (candidate.partitioned) return { kind: "reject", reason: "partitioned" };
  if (normalizeCookieSameSite(candidate.sameSite) !== "none")
    return { kind: "reject", reason: "context" };
  if (!candidate.secure || url.protocol !== "https:") return { kind: "reject", reason: "secure" };
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const hostOnly = candidate.domain === undefined;
  const domain = hostOnly ? hostname : canonicalCookieDomain(candidate.domain!);
  if (
    domain === null ||
    (!hostOnly &&
      (isIP(hostname) ||
        !hostname.includes(".") ||
        !cookieDomainMatches(hostname, domain) ||
        ports.isPublicSuffix(domain) !== false))
  )
    return { kind: "reject", reason: "domain" };
  const path = candidate.path?.startsWith("/") ? candidate.path : cookieDefaultPath(url.pathname);
  if (!validCookiePrefixes(candidate, hostOnly, candidate.path))
    return { kind: "reject", reason: "prefix" };
  const expiresAt = expiration(candidate, source.now);
  if (expiresAt !== null && expiresAt <= source.now) {
    return { kind: "delete", key: { name: candidate.name, domain, path } };
  }
  return {
    kind: "accept",
    cookie: {
      name: candidate.name,
      value: candidate.value,
      domain,
      path,
      hostOnly,
      secure: true,
      httpOnly: candidate.httpOnly,
      sameSite: "none",
      expiresAt,
      createdAt: source.now,
    },
  };
}

function validStoredIdentity(cookie: HostCookie): boolean {
  return (
    typeof cookie.name === "string" &&
    COOKIE_NAME.test(cookie.name) &&
    validCookieValue(cookie.value) &&
    typeof cookie.domain === "string" &&
    (isIP(cookie.domain) !== 0 || canonicalCookieDomain(cookie.domain) === cookie.domain) &&
    typeof cookie.path === "string" &&
    cookie.path.startsWith("/") &&
    !hasCookieControlCharacters(cookie.path) &&
    Buffer.byteLength(cookie.name + cookie.value + cookie.domain + cookie.path) <=
      HOST_COOKIE_LIMITS.cookieBytes
  );
}

export function assertHostCookie(cookie: HostCookie): void {
  if (
    !validStoredIdentity(cookie) ||
    cookie.secure !== true ||
    cookie.sameSite !== "none" ||
    typeof cookie.hostOnly !== "boolean" ||
    typeof cookie.httpOnly !== "boolean" ||
    (cookie.expiresAt !== null &&
      (!Number.isSafeInteger(cookie.expiresAt) || cookie.expiresAt < 0)) ||
    !validCookiePrefixes(cookie, cookie.hostOnly, cookie.path)
  )
    throw new CookieJarError("invalid_cookie_state");
  assertCookieTime(cookie.createdAt);
}
