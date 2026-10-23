import type { Cookie } from "tough-cookie";
import { createRequire } from "node:module";
import { NETWORK_FETCH_LIMITS } from "@getpaseo/protocol/network-fetch/rpc-schemas";
import {
  CookieJarError,
  HOST_COOKIE_LIMITS,
  hasCookieControlCharacters,
  normalizeCookieSameSite,
  type CookiePolicyPorts,
  type ParsedCookieCandidate,
} from "./cookie-policy.js";

export const HOST_COOKIE_PARSER_POLICY = {
  parser: "tough-cookie@4.1.4",
  suffixList: "psl@1.15.0",
  suffixRulesSha256: "88acb0ed1454263e482a02f8fbef97a377f191b1f1e497bd1b71a29af9b21d7c",
  defaultSameSite: "lax",
} as const;

type RuntimeParser = (value: string) => unknown;
type ParsedCookie = Pick<
  Cookie,
  | "key"
  | "value"
  | "domain"
  | "path"
  | "secure"
  | "httpOnly"
  | "sameSite"
  | "maxAge"
  | "expires"
  | "extensions"
>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function optionalString(value: unknown): boolean {
  return value == null || typeof value === "string";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function parsedCookie(value: unknown): value is ParsedCookie {
  if (!record(value)) return false;
  return (
    typeof value.key === "string" &&
    typeof value.value === "string" &&
    optionalString(value.domain) &&
    optionalString(value.path) &&
    optionalString(value.sameSite) &&
    typeof value.secure === "boolean" &&
    typeof value.httpOnly === "boolean" &&
    (value.maxAge == null ||
      typeof value.maxAge === "number" ||
      value.maxAge === "Infinity" ||
      value.maxAge === "-Infinity") &&
    (value.expires === "Infinity" || value.expires instanceof Date) &&
    (value.extensions == null ||
      (Array.isArray(value.extensions) && value.extensions.every(isString)))
  );
}

function loadParser(load: (name: string) => unknown, name: "psl" | "tough-cookie"): RuntimeParser {
  try {
    const loaded = load(name);
    const owner = name === "tough-cookie" && record(loaded) ? loaded.Cookie : loaded;
    if (!record(owner) || typeof owner.parse !== "function") throw new Error("Invalid parser");
    const parse = owner.parse;
    return (value) => Reflect.apply(parse, owner, [value, { loose: false }]);
  } catch {
    throw new CookieJarError("cookie_jar_unavailable");
  }
}

function classifyPublicSuffix(result: unknown): boolean | null {
  if (!record(result)) throw new CookieJarError("cookie_jar_unavailable");
  if ("error" in result) return null;
  if (
    typeof result.listed !== "boolean" ||
    (result.domain !== null && typeof result.domain !== "string")
  )
    throw new CookieJarError("cookie_jar_unavailable");
  return result.listed ? result.domain === null : null;
}

export function createHostCookieParser(
  load: (name: string) => unknown = createRequire(import.meta.url),
) {
  const cookieParser = loadParser(load, "tough-cookie");
  const suffixParser = loadParser(load, "psl");
  let available = true;
  function checkedParse(parser: RuntimeParser, value: string): unknown {
    if (!available) throw new CookieJarError("cookie_jar_unavailable");
    try {
      return parser(value);
    } catch {
      available = false;
      throw new CookieJarError("cookie_jar_unavailable");
    }
  }
  const policy: CookiePolicyPorts = {
    isPublicSuffix(domain) {
      try {
        return classifyPublicSuffix(checkedParse(suffixParser, domain));
      } catch (error) {
        if (error instanceof CookieJarError && error.code !== "cookie_jar_unavailable") throw error;
        available = false;
        throw new CookieJarError("cookie_jar_unavailable");
      }
    },
  };
  return {
    policy,
    parseResponseHeaders(rawHeaders: readonly string[]) {
      if (!available) throw new CookieJarError("cookie_jar_unavailable");
      try {
        return parseResponseHeaders(rawHeaders, (value) => checkedParse(cookieParser, value));
      } catch (error) {
        if (error instanceof CookieJarError && error.code !== "cookie_jar_unavailable") throw error;
        available = false;
        throw new CookieJarError("cookie_jar_unavailable");
      }
    },
  };
}

function boundedMaxAge(cookie: ParsedCookie): string | undefined {
  if (cookie.maxAge == null) return undefined;
  const seconds = Number(cookie.maxAge);
  if (Number.isNaN(seconds)) return undefined;
  if (seconds <= 0) return "0";
  return String(Math.min(seconds, HOST_COOKIE_LIMITS.lifetimeMs / 1000));
}

function parseCandidate(value: string, parse: RuntimeParser): ParsedCookieCandidate | null {
  const sourceBytes = Buffer.byteLength(value);
  if (sourceBytes > HOST_COOKIE_LIMITS.cookieBytes || hasCookieControlCharacters(value))
    return null;
  const parsed = parse(value);
  if (parsed === undefined) return null;
  if (!parsedCookie(parsed)) throw new CookieJarError("cookie_jar_unavailable");
  return {
    name: parsed.key,
    value: parsed.value,
    domain: parsed.domain ?? undefined,
    path: parsed.path ?? undefined,
    secure: parsed.secure,
    httpOnly: parsed.httpOnly,
    sameSite: normalizeCookieSameSite(parsed.sameSite),
    maxAgeSeconds: boundedMaxAge(parsed),
    expiresAt: parsed.expires instanceof Date ? parsed.expires.getTime() : undefined,
    partitioned:
      parsed.extensions?.some((attribute) => /^partitioned(?:\s*=|\s*$)/i.test(attribute)) ?? false,
    sourceBytes,
  };
}

function parseResponseHeaders(
  rawHeaders: readonly string[],
  parse: RuntimeParser,
): {
  candidates: ParsedCookieCandidate[];
  rejected: number;
} {
  if (rawHeaders.length % 2 !== 0) throw new CookieJarError("invalid_cookie_state");
  let headBytes = 0;
  let fields = 0;
  let rejected = 0;
  const candidates: ParsedCookieCandidate[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    headBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (headBytes > NETWORK_FETCH_LIMITS.maxResponseHeadBytes)
      throw new CookieJarError("cookie_jar_limit");
    if (name.toLowerCase() !== "set-cookie") continue;
    fields += 1;
    if (fields > HOST_COOKIE_LIMITS.responseCookies) throw new CookieJarError("cookie_jar_limit");
    const candidate = parseCandidate(value, parse);
    if (candidate) candidates.push(candidate);
    else rejected += 1;
  }
  return { candidates, rejected };
}

const hostCookieParser = createHostCookieParser();
export const HOST_COOKIE_PUBLIC_SUFFIX_POLICY = hostCookieParser.policy;
export const parseCookieResponseHeaders = hostCookieParser.parseResponseHeaders;
