import { describe, expect, it } from "vitest";
import {
  AllowlistEntryError,
  findAllowedTarget,
  parseRequestUrl,
  parseTrustedTarget,
  type TrustedAllowlist,
} from "./allowlist.js";
import { NetworkFetchError } from "./errors.js";

function allowlist(...targets: [string, string][]): TrustedAllowlist {
  return {
    id: "fixtures",
    revision: 1,
    targets: targets.map(([origin, pathPrefix]) => parseTrustedTarget({ origin, pathPrefix })),
  };
}

function allows(list: TrustedAllowlist, url: string): boolean {
  return findAllowedTarget(list, parseRequestUrl(url)) !== null;
}

describe("trusted allowlist", () => {
  it("normalizes the origin and makes the default port explicit in matching", () => {
    expect(parseTrustedTarget({ origin: "HTTP://LocalHost:80", pathPrefix: "/" })).toEqual({
      origin: "http://localhost",
      pathPrefix: "/",
    });
    const list = allowlist(["https://fixture.test", "/"]);
    expect(allows(list, "https://fixture.test:443/a")).toBe(true);
    expect(allows(list, "https://fixture.test:8443/a")).toBe(false);
    expect(allows(list, "http://fixture.test/a")).toBe(false);
  });

  it.each([
    ["userinfo", "http://user:pass@fixture.test"],
    ["a path", "http://fixture.test/app"],
    ["a query", "http://fixture.test/?x=1"],
    ["a fragment", "http://fixture.test/#x"],
    ["a trailing dot", "http://fixture.test."],
    ["another scheme", "ftp://fixture.test"],
    ["cloud metadata", "http://169.254.169.254"],
    ["IPv4-mapped metadata", "http://[::ffff:169.254.169.254]"],
    ["link-local IPv6", "http://[fe80::1]"],
  ])("refuses an origin with %s", (_case, origin) => {
    expect(() => parseTrustedTarget({ origin, pathPrefix: "/" })).toThrow(AllowlistEntryError);
  });

  it.each(["/app", "app/", "/app/../admin/", "/app%2fx/", "/a/./b/"])(
    "refuses the non-canonical path prefix %s",
    (pathPrefix) => {
      expect(() => parseTrustedTarget({ origin: "http://fixture.test", pathPrefix })).toThrow(
        AllowlistEntryError,
      );
    },
  );

  it("never treats loopback spellings as aliases of each other", () => {
    const list = allowlist(["http://localhost:3000", "/"]);
    expect(allows(list, "http://localhost:3000/")).toBe(true);
    for (const url of [
      "http://127.0.0.1:3000/",
      "http://[::1]:3000/",
      "http://app.localhost:3000/",
      "http://localhost:3001/",
    ]) {
      expect(allows(list, url)).toBe(false);
    }
  });

  it("keeps requests inside the path prefix, encoded separators included", () => {
    const list = allowlist(["http://fixture.test", "/app/"]);
    expect(allows(list, "http://fixture.test/app/page")).toBe(true);
    expect(allows(list, "http://fixture.test/app/../admin")).toBe(false);
    expect(allows(list, "http://fixture.test/app/%2e%2e/admin")).toBe(false);
    expect(allows(list, "http://fixture.test/app/..%2Fadmin")).toBe(false);
    expect(allows(list, "http://fixture.test/app/..%5cadmin")).toBe(false);
    expect(allows(list, "http://fixture.test/application")).toBe(false);
  });

  it("drops the fragment and refuses credentials or a trailing dot in request URLs", () => {
    expect(parseRequestUrl("http://fixture.test/a?b=1#frag").href).toBe(
      "http://fixture.test/a?b=1",
    );
    for (const url of ["http://u:p@fixture.test/", "http://fixture.test./", "file:///etc/passwd"]) {
      expect(() => parseRequestUrl(url)).toThrow(NetworkFetchError);
    }
  });
});
