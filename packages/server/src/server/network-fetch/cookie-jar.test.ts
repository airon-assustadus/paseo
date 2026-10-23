import { describe, expect, it } from "vitest";
import { applyCookieBatch, selectCookieHeader } from "./cookie-jar.js";
import type { HostCookie, ParsedCookieCandidate } from "./cookie-policy.js";

const source = { url: "https://app.example.test/account/login", now: 10000 };
const policy = { isPublicSuffix: () => false };

function candidate(overrides: Partial<ParsedCookieCandidate> = {}): ParsedCookieCandidate {
  return {
    name: "session",
    value: "synthetic",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "none",
    partitioned: false,
    sourceBytes: 80,
    ...overrides,
  };
}

function cookies(candidates: ParsedCookieCandidate[]): HostCookie[] {
  return applyCookieBatch([], candidates, source, policy).cookies;
}

describe("host cookie response batches", () => {
  it("replaces by name/domain/path and preserves creation order", () => {
    const original = cookies([candidate()]);
    const next = applyCookieBatch(
      original,
      [candidate({ value: "new", httpOnly: false })],
      { ...source, now: 20000 },
      policy,
    );
    expect(original[0].value).toBe("synthetic");
    expect(next.cookies).toHaveLength(1);
    expect(next.cookies[0]).toMatchObject({ value: "new", httpOnly: false, createdAt: source.now });
  });

  it("deletes the exact key and drops expired entries without changing input", () => {
    const original = cookies([
      candidate({ path: "/account" }),
      candidate({ path: "/", maxAgeSeconds: "1" }),
    ]);
    const next = applyCookieBatch(
      original,
      [candidate({ path: "/account", maxAgeSeconds: "0" })],
      { ...source, now: 12000 },
      policy,
    );
    expect(next.cookies).toEqual([]);
    expect(original).toHaveLength(2);
  });

  it("counts refused candidates without exposing their values", () => {
    const next = applyCookieBatch(
      [],
      [candidate({ sameSite: undefined }), candidate()],
      source,
      policy,
    );
    expect(next.rejected).toBe(1);
    expect(next.cookies).toHaveLength(1);
  });

  it("rejects a whole over-limit batch without evicting existing cookies", () => {
    const original = cookies([candidate()]);
    const oversized = Array.from({ length: 101 }, (_, index) =>
      candidate({ name: `cookie${index}` }),
    );
    expect(() => applyCookieBatch(original, oversized, source, policy)).toThrow("cookie_jar_limit");
    expect(original).toHaveLength(1);
    const full = Array.from({ length: 180 }, (_, index) => ({
      ...original[0],
      name: `cookie${index}`,
    }));
    expect(() => applyCookieBatch(full, [candidate({ name: "overflow" })], source, policy)).toThrow(
      "cookie_jar_limit",
    );
    expect(full).toHaveLength(180);
  });

  it("selects HttpOnly only into the private HTTP header, with path and creation ordering", () => {
    const entries = cookies([
      candidate({ path: "/" }),
      candidate({ path: "/account", value: "narrow" }),
    ]);
    expect(selectCookieHeader(entries, source.url, source.now)).toBe(
      "session=narrow; session=synthetic",
    );
    expect(selectCookieHeader(entries, "https://app.example.test/accounting", source.now)).toBe(
      "session=synthetic",
    );
    expect(selectCookieHeader(entries, "https://other.example.test/account", source.now)).toBe("");
    expect(selectCookieHeader(entries, "http://app.example.test/account", source.now)).toBe("");
  });

  it("checks expiration at selection rather than relying on a previous snapshot", () => {
    const entries = cookies([candidate({ maxAgeSeconds: "1" })]);
    expect(selectCookieHeader(entries, source.url, 10999)).toBe("session=synthetic");
    expect(selectCookieHeader(entries, source.url, 11000)).toBe("");
  });

  it("fails an oversized private header rather than truncating credentials", () => {
    const entries = cookies(
      Array.from({ length: 3 }, (_, index) =>
        candidate({ name: `cookie${index}`, value: "x".repeat(3000), sourceBytes: 3100 }),
      ),
    );
    expect(() => selectCookieHeader(entries, source.url, source.now)).toThrow("cookie_jar_limit");
  });
});
