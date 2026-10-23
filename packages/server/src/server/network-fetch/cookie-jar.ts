import {
  assertCookieTime,
  assertHostCookie,
  cookieDomainMatches,
  cookiePathMatches,
  cookieSourceUrl,
  CookieJarError,
  evaluateCookie,
  HOST_COOKIE_LIMITS,
  type CookieDecision,
  type CookiePolicyPorts,
  type CookieSource,
  type HostCookie,
  type ParsedCookieCandidate,
} from "./cookie-policy.js";

function sameKey(first: Pick<HostCookie, "name" | "domain" | "path">, second: HostCookie): boolean {
  return first.name === second.name && first.domain === second.domain && first.path === second.path;
}

export function applyCookieBatch(
  entries: readonly HostCookie[],
  candidates: readonly ParsedCookieCandidate[],
  source: CookieSource,
  ports: CookiePolicyPorts,
): { cookies: HostCookie[]; rejected: number } {
  assertCookieTime(source.now);
  if (candidates.length > HOST_COOKIE_LIMITS.responseCookies)
    throw new CookieJarError("cookie_jar_limit");
  for (const cookie of entries) assertHostCookie(cookie);
  const cookies = structuredClone(
    entries.filter((cookie) => cookie.expiresAt === null || cookie.expiresAt > source.now),
  );
  let rejected = 0;
  for (const candidate of candidates) {
    const decision = evaluateCookie(candidate, source, ports);
    if (decision.kind === "reject") rejected += 1;
    else applyDecision(cookies, decision);
  }
  if (cookies.length > HOST_COOKIE_LIMITS.destinationCookies)
    throw new CookieJarError("cookie_jar_limit");
  return { cookies, rejected };
}

function applyDecision(
  cookies: HostCookie[],
  decision: Exclude<CookieDecision, { kind: "reject" }>,
): void {
  const key = decision.kind === "delete" ? decision.key : decision.cookie;
  const index = cookies.findIndex((cookie) => sameKey(key, cookie));
  if (decision.kind === "delete") {
    if (index >= 0) cookies.splice(index, 1);
  } else if (index >= 0) {
    cookies[index] = { ...decision.cookie, createdAt: cookies[index].createdAt };
  } else cookies.push(decision.cookie);
}

export function selectCookieHeader(
  entries: readonly HostCookie[],
  urlValue: string,
  now: number,
): string {
  assertCookieTime(now);
  const url = cookieSourceUrl(urlValue);
  for (const cookie of entries) assertHostCookie(cookie);
  if (url.protocol !== "https:") return "";
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const selected = entries
    .filter(
      (cookie) =>
        (cookie.expiresAt === null || cookie.expiresAt > now) &&
        (cookie.hostOnly
          ? hostname === cookie.domain
          : cookieDomainMatches(hostname, cookie.domain)) &&
        cookiePathMatches(url.pathname, cookie.path),
    )
    .sort(
      (first, second) =>
        second.path.length - first.path.length || first.createdAt - second.createdAt,
    );
  const header = selected.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  if (Buffer.byteLength(header) > HOST_COOKIE_LIMITS.requestCookieBytes)
    throw new CookieJarError("cookie_jar_limit");
  return header;
}
