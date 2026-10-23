import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  createHostCookieParser,
  parseCookieResponseHeaders,
  HOST_COOKIE_PUBLIC_SUFFIX_POLICY,
} from "./cookie-parser.js";
import { applyCookieBatch } from "./cookie-jar.js";

const source = { url: "https://app.example.com/account/login", now: 10000 };
const loadDependency = createRequire(import.meta.url);

function loader(overrides: Record<string, unknown>, missing?: string) {
  return (name: string): unknown => {
    if (name === missing) throw new Error("synthetic-private-dependency-path");
    return Object.hasOwn(overrides, name) ? overrides[name] : loadDependency(name);
  };
}

function invalidCookieResult() {
  return { key: "session", value: "synthetic" };
}
function invalidSuffixResult() {
  return { listed: "yes", domain: "example.com" };
}
function throwingParser() {
  throw new Error("synthetic-private-parser-data");
}

function accept(raw: string) {
  const parsed = parseCookieResponseHeaders(["Set-Cookie", raw]);
  return applyCookieBatch([], parsed.candidates, source, HOST_COOKIE_PUBLIC_SUFFIX_POLICY);
}

describe("pinned host cookie parser adapter", () => {
  it.each(["", "; SameSite=invalid", "; SameSite=None; SameSite=invalid"])(
    "normalizes absent or invalid SameSite to Lax: %s",
    (attribute) => {
      const parsed = parseCookieResponseHeaders([
        "Set-Cookie",
        `session=synthetic; Secure${attribute}`,
      ]);
      expect(parsed.candidates[0].sameSite).toBe("lax");
      expect(accept(`session=synthetic; Secure${attribute}`).cookies).toEqual([]);
    },
  );

  it("keeps distinct Set-Cookie fields, Expires commas, HttpOnly and explicit None", () => {
    const result = parseCookieResponseHeaders([
      "Set-Cookie",
      "session=synthetic; Secure; HttpOnly; SameSite=None; Expires=Wed, 09 Jun 2038 10:18:14 GMT",
      "sEt-CoOkIe",
      "second=value; Secure; SameSite=None",
      "Content-Type",
      "text/plain",
    ]);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      name: "session",
      value: "synthetic",
      httpOnly: true,
      sameSite: "none",
    });
    expect(result.candidates[0].expiresAt).toBeGreaterThan(source.now);
  });

  it("refuses None without Secure and Partitioned rather than downgrading them", () => {
    expect(accept("session=synthetic; SameSite=None").cookies).toEqual([]);
    expect(accept("session=synthetic; SameSite=None; Secure; Partitioned").cookies).toEqual([]);
    expect(accept("session=synthetic; SameSite=None; Secure; Partitioned=true").cookies).toEqual(
      [],
    );
  });

  it("uses the pinned PSL including private rules and rejects unknown Domain classification", () => {
    expect(HOST_COOKIE_PUBLIC_SUFFIX_POLICY.isPublicSuffix("com")).toBe(true);
    expect(HOST_COOKIE_PUBLIC_SUFFIX_POLICY.isPublicSuffix("github.io")).toBe(true);
    expect(HOST_COOKIE_PUBLIC_SUFFIX_POLICY.isPublicSuffix("example.com")).toBe(false);
    expect(HOST_COOKIE_PUBLIC_SUFFIX_POLICY.isPublicSuffix("example.invalid")).toBeNull();
    expect(accept("session=synthetic; Secure; SameSite=None; Domain=com").cookies).toEqual([]);
    expect(
      accept("session=synthetic; Secure; SameSite=None; Domain=.example.com").cookies,
    ).toHaveLength(1);
  });

  it("caps overflowing Max-Age and does not lose the deletion precedence", () => {
    expect(
      accept(
        "session=synthetic; Secure; SameSite=None; Max-Age=999999999999999999999999999999999999999",
      ).cookies[0].expiresAt,
    ).toBe(source.now + 180 * 86400000);
    expect(
      accept(
        "session=synthetic; Secure; SameSite=None; Max-Age=0; Expires=Wed, 09 Jun 2038 10:18:14 GMT",
      ).cookies,
    ).toEqual([]);
  });

  it("rejects controls, malformed syntax and oversized fields without reporting contents", () => {
    const parsed = parseCookieResponseHeaders([
      "Set-Cookie",
      "session=synthetic\r\nInjected=true",
      "Set-Cookie",
      "not-a-cookie",
      "Set-Cookie",
      `session=${"x".repeat(4096)}`,
    ]);
    expect(parsed).toEqual({ candidates: [], rejected: 3 });
    expect(() => parseCookieResponseHeaders(["Set-Cookie"])).toThrow("invalid_cookie_state");
  });

  it("bounds total metadata and counts refused fields against the response cap", () => {
    expect(() => parseCookieResponseHeaders(["Other", "x".repeat(65536)])).toThrow(
      "cookie_jar_limit",
    );
    const fields = Array.from({ length: 101 }, () => ["Set-Cookie", "invalid"]).flat();
    expect(() => parseCookieResponseHeaders(fields)).toThrow("cookie_jar_limit");
  });

  it.each(["tough-cookie", "psl"])("fails closed when %s cannot be loaded", (missing) => {
    const load = loader({}, missing);
    expect(() => createHostCookieParser(load)).toThrow(/^cookie_jar_unavailable$/);
  });

  it.each(["tough-cookie", "psl"])("fails closed on an invalid %s module shape", (name) => {
    const load = loader({ [name]: { parse: "not-callable" } });
    expect(() => createHostCookieParser(load)).toThrow(/^cookie_jar_unavailable$/);
  });

  it.each([invalidCookieResult, throwingParser])(
    "latches closed on a broken cookie parser: %s",
    (parse) => {
      const adapter = createHostCookieParser(loader({ "tough-cookie": { Cookie: { parse } } }));
      expect(() =>
        adapter.parseResponseHeaders(["Set-Cookie", "session=synthetic; Secure; SameSite=None"]),
      ).toThrow(/^cookie_jar_unavailable$/);
      expect(() => adapter.policy.isPublicSuffix("example.com")).toThrow(
        /^cookie_jar_unavailable$/,
      );
      expect(() => adapter.parseResponseHeaders([])).toThrow(/^cookie_jar_unavailable$/);
    },
  );

  it.each([invalidSuffixResult, throwingParser])(
    "latches closed on a broken PSL parser: %s",
    (parse) => {
      const adapter = createHostCookieParser(loader({ psl: { parse } }));
      expect(() => adapter.policy.isPublicSuffix("example.com")).toThrow(
        /^cookie_jar_unavailable$/,
      );
      expect(() =>
        adapter.parseResponseHeaders(["Set-Cookie", "session=synthetic; Secure; SameSite=None"]),
      ).toThrow(/^cookie_jar_unavailable$/);
    },
  );
});
