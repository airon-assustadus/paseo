import { describe, expect, it } from "vitest";
import {
  assertHostCookie,
  cookieDefaultPath,
  cookiePathMatches,
  evaluateCookie,
  HOST_COOKIE_LIMITS,
  hasCookieControlCharacters,
  normalizeCookieSameSite,
  type CookiePolicyPorts,
  type ParsedCookieCandidate,
} from "./cookie-policy.js";

const source = { url: "https://app.example.test/account/login", now: 10000 };
const policy: CookiePolicyPorts = {
  isPublicSuffix: (domain) => domain === "test" || domain === "private.test",
};

function candidate(overrides: Partial<ParsedCookieCandidate> = {}): ParsedCookieCandidate {
  return {
    name: "session",
    value: "synthetic",
    secure: true,
    httpOnly: true,
    sameSite: "None",
    partitioned: false,
    sourceBytes: 80,
    ...overrides,
  };
}

describe("host cookie policy: opaque context", () => {
  it.each([undefined, "", "garbage", "LAX"])("defaults %s to Lax, never None", (attribute) => {
    expect(normalizeCookieSameSite(attribute)).toBe("lax");
    expect(evaluateCookie(candidate({ sameSite: attribute }), source, policy)).toEqual({
      kind: "reject",
      reason: "context",
    });
  });

  it("refuses Strict even for a request targeting the same origin", () => {
    expect(normalizeCookieSameSite("Strict")).toBe("strict");
    expect(evaluateCookie(candidate({ sameSite: "Strict" }), source, policy)).toEqual({
      kind: "reject",
      reason: "context",
    });
  });

  it("keeps HttpOnly private in the host record and derives the default path", () => {
    expect(evaluateCookie(candidate(), source, policy)).toEqual({
      kind: "accept",
      cookie: {
        name: "session",
        value: "synthetic",
        secure: true,
        httpOnly: true,
        sameSite: "none",
        domain: "app.example.test",
        path: "/account",
        hostOnly: true,
        expiresAt: null,
        createdAt: source.now,
      },
    });
  });

  it.each(["http://app.example.test/", "http://localhost/"])(
    "refuses Secure exceptions for %s",
    (url) => {
      expect(evaluateCookie(candidate(), { ...source, url }, policy)).toEqual({
        kind: "reject",
        reason: "secure",
      });
    },
  );

  it("requires Secure for explicit None", () => {
    expect(evaluateCookie(candidate({ secure: false }), source, policy)).toEqual({
      kind: "reject",
      reason: "secure",
    });
  });

  it.each(["other.test", "test", "private.test", "example.test.", "..example.test"])(
    "refuses ungranted Domain %s",
    (domain) => {
      expect(evaluateCookie(candidate({ domain }), source, policy).kind).toBe("reject");
    },
  );

  it("uses an explicit public suffix port and normalizes a matching Domain", () => {
    expect(evaluateCookie(candidate({ domain: ".EXAMPLE.test" }), source, policy)).toMatchObject({
      kind: "accept",
      cookie: { domain: "example.test", hostOnly: false },
    });
    expect(
      evaluateCookie(candidate({ domain: "example.test" }), source, { isPublicSuffix: () => null }),
    ).toEqual({ kind: "reject", reason: "domain" });
  });

  it.each(["https://127.0.0.1/", "https://localhost/"])("admits only hostOnly at %s", (url) => {
    expect(evaluateCookie(candidate(), { ...source, url }, policy).kind).toBe("accept");
    expect(
      evaluateCookie(candidate({ domain: new URL(url).hostname }), { ...source, url }, policy).kind,
    ).toBe("reject");
  });

  it("requires explicit Path=/ and no Domain for the Host prefix", () => {
    expect(
      evaluateCookie(candidate({ name: "__Host-session", path: "/" }), source, policy).kind,
    ).toBe("accept");
    expect(evaluateCookie(candidate({ name: "__Host-session" }), source, policy).kind).toBe(
      "reject",
    );
    expect(
      evaluateCookie(
        candidate({ name: "__Host-session", path: "/", domain: "app.example.test" }),
        source,
        policy,
      ).kind,
    ).toBe("reject");
    expect(
      evaluateCookie(candidate({ name: "__Http-session", httpOnly: false }), source, policy).kind,
    ).toBe("reject");
  });

  it("does not downgrade Partitioned to an ordinary cookie", () => {
    expect(evaluateCookie(candidate({ partitioned: true }), source, policy)).toEqual({
      kind: "reject",
      reason: "partitioned",
    });
  });

  it("gives Max-Age priority, deletes nonpositive ages and caps large values", () => {
    expect(
      evaluateCookie(candidate({ maxAgeSeconds: "5", expiresAt: 1 }), source, policy),
    ).toMatchObject({ kind: "accept", cookie: { expiresAt: 15000 } });
    expect(
      evaluateCookie(candidate({ maxAgeSeconds: "0", expiresAt: 999999 }), source, policy),
    ).toMatchObject({ kind: "delete" });
    expect(evaluateCookie(candidate({ maxAgeSeconds: "-1" }), source, policy)).toMatchObject({
      kind: "delete",
    });
    expect(
      evaluateCookie(candidate({ maxAgeSeconds: "9999999999999999999999999" }), source, policy),
    ).toMatchObject({
      kind: "accept",
      cookie: { expiresAt: source.now + HOST_COOKIE_LIMITS.lifetimeMs },
    });
    expect(
      evaluateCookie(candidate({ maxAgeSeconds: "invalid", expiresAt: 12000 }), source, policy),
    ).toMatchObject({ kind: "accept", cookie: { expiresAt: 12000 } });
  });

  it("treats invalid Expires as a session cookie", () => {
    expect(evaluateCookie(candidate({ expiresAt: Number.NaN }), source, policy)).toMatchObject({
      kind: "accept",
      cookie: { expiresAt: null },
    });
  });

  it.each([
    { name: "bad;name" },
    { value: "value\r\ninjected" },
    { path: "/\u0000" },
    { sourceBytes: 4097 },
    { value: "value".repeat(1000) },
  ])("rejects malformed or oversized candidate %j", (overrides) => {
    expect(evaluateCookie(candidate(overrides), source, policy)).toEqual({
      kind: "reject",
      reason: "syntax",
    });
  });

  it("matches path boundaries without decoding escaped separators", () => {
    expect(cookieDefaultPath("/login")).toBe("/");
    expect(cookieDefaultPath("/account/login")).toBe("/account");
    expect(cookiePathMatches("/foo", "/foo")).toBe(true);
    expect(cookiePathMatches("/foo/bar", "/foo")).toBe(true);
    expect(cookiePathMatches("/foobar", "/foo")).toBe(false);
    expect(cookiePathMatches("/foo%2fbar", "/foo")).toBe(false);
  });

  it("checks the extracted control guard in candidates and stored paths", () => {
    const accepted = evaluateCookie(candidate(), source, policy);
    expect(accepted.kind).toBe("accept");
    if (accepted.kind !== "accept") throw new Error("Expected accepted cookie");
    for (let code = 0; code <= 128; code += 1) {
      const text = `/path${String.fromCharCode(code)}tail`;
      const forbidden = code <= 31 || code === 127;
      expect(hasCookieControlCharacters(text)).toBe(forbidden);
      expect(evaluateCookie(candidate({ path: text }), source, policy).kind).toBe(
        forbidden ? "reject" : "accept",
      );
      const validateStored = () => assertHostCookie({ ...accepted.cookie, path: text });
      if (forbidden) expect(validateStored).toThrow("invalid_cookie_state");
      else expect(validateStored).not.toThrow();
    }
    for (const attribute of ["domain", "sameSite", "maxAgeSeconds"]) {
      expect(evaluateCookie(candidate({ [attribute]: "value\u007f" }), source, policy)).toEqual({
        kind: "reject",
        reason: "syntax",
      });
    }
  });
});
