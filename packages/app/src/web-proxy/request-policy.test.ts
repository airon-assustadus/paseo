import { describe, expect, it } from "vitest";
import {
  createCapability,
  filterRequestHeaders,
  filterResponseHeaders,
  InvalidCapabilityError,
  resolveDestinationUrl,
  type WebProxyCapability,
} from "./request-policy";

const DESTINATION = "http://127.0.0.1:4173";
const ROOT: WebProxyCapability = {
  contentOrigin: "https://wp-a.example",
  destinationOrigin: DESTINATION,
  pathPrefix: "/",
};
const SCOPED: WebProxyCapability = { ...ROOT, pathPrefix: "/app/" };

function resolvedHref(capability: WebProxyCapability, path: string): string | null {
  const result = resolveDestinationUrl(capability, path);
  return result.kind === "ok" ? result.url.href : null;
}

describe("resolveDestinationUrl", () => {
  it("keeps paths and queries on the destination origin", () => {
    expect(resolvedHref(ROOT, "/a/b?c=1#frag")).toBe("http://127.0.0.1:4173/a/b?c=1");
    expect(resolvedHref(ROOT, "/../../etc")).toBe("http://127.0.0.1:4173/etc");
  });

  it.each([
    ["scheme-relative", "//elsewhere.invalid/x"],
    ["backslash scheme-relative", "/\\elsewhere.invalid/x"],
    ["absolute URL", "http://elsewhere.invalid/x"],
    ["relative path", "x"],
    ["control character", "/a\u0000b"],
    ["tab inside host position", "/\t/elsewhere.invalid"],
    ["empty", ""],
  ])("rejects a %s path", (_label, path) => {
    expect(resolveDestinationUrl(ROOT, path)).toEqual({ kind: "invalid" });
  });

  it("keeps requests inside the capability's path prefix", () => {
    expect(resolvedHref(SCOPED, "/app/")).toBe("http://127.0.0.1:4173/app/");
    expect(resolvedHref(SCOPED, "/app/x/y?z=1")).toBe("http://127.0.0.1:4173/app/x/y?z=1");
  });

  it.each([
    ["the prefix without its slash", "/app"],
    ["a sibling path", "/application/x"],
    ["the root", "/"],
    ["dot segments", "/app/../admin"],
    ["encoded dot segments", "/app/%2e%2e/admin"],
    ["an encoded slash", "/app/..%2fadmin"],
    ["an encoded backslash", "/app/..%5Cadmin"],
  ])("refuses %s outside the prefix", (_label, path) => {
    expect(resolveDestinationUrl(SCOPED, path)).toEqual({ kind: "path_not_allowed" });
  });
});

describe("createCapability", () => {
  it("accepts exact http(s) origins and a canonical prefix", () => {
    expect(createCapability(SCOPED)).toEqual(SCOPED);
  });

  it.each([
    ["contentOrigin", { ...ROOT, contentOrigin: "https://wp-a.example/" }],
    ["contentOrigin", { ...ROOT, contentOrigin: "null" }],
    ["destinationOrigin", { ...ROOT, destinationOrigin: "ws://h:1" }],
    ["destinationOrigin", { ...ROOT, destinationOrigin: "http://h:1/path" }],
    ["pathPrefix", { ...ROOT, pathPrefix: "/app" }],
    ["pathPrefix", { ...ROOT, pathPrefix: "app/" }],
    ["pathPrefix", { ...ROOT, pathPrefix: "//app/" }],
    ["pathPrefix", { ...ROOT, pathPrefix: "/a/../b/" }],
    ["pathPrefix", { ...ROOT, pathPrefix: "/a%2fb/" }],
  ] as const)("rejects an invalid %s", (field, capability) => {
    expect(() => createCapability(capability)).toThrow(new InvalidCapabilityError(field));
  });
});

describe("filterRequestHeaders", () => {
  it("drops identity, cookie, fetch metadata and hop-by-hop headers", () => {
    expect(
      filterRequestHeaders([
        ["Cookie", "a=b"],
        ["Origin", "http://elsewhere.invalid"],
        ["Referer", "http://elsewhere.invalid/"],
        ["Host", "elsewhere.invalid"],
        ["Sec-Fetch-Site", "cross-site"],
        ["Proxy-Authorization", "x"],
        ["Connection", "close"],
        ["Content-Length", "3"],
        ["Accept", "text/html"],
        ["Authorization", "Bearer fixture"],
      ]),
    ).toEqual([
      ["accept", "text/html"],
      ["authorization", "Bearer fixture"],
    ]);
  });
});

describe("filterResponseHeaders", () => {
  const requestUrl = new URL(`${DESTINATION}/app/dir/page`);

  it("drops cookies and headers that would teach the browser about the destination", () => {
    expect(
      filterResponseHeaders({
        status: 200,
        headers: [
          ["Set-Cookie", "sid=1; HttpOnly"],
          ["Strict-Transport-Security", "max-age=1"],
          ["Alt-Svc", 'h3=":443"'],
          ["NEL", "{}"],
          ["Report-To", "{}"],
          ["Clear-Site-Data", '"*"'],
          ["Content-Type", "text/html"],
        ],
        requestUrl,
        capability: ROOT,
      }),
    ).toEqual({ kind: "pass", headers: [["content-type", "text/html"]] });
  });

  it("turns a redirect inside the capability into a path", () => {
    expect(
      filterResponseHeaders({
        status: 302,
        headers: [["Location", "../next?x=1"]],
        requestUrl,
        capability: SCOPED,
      }),
    ).toEqual({ kind: "pass", headers: [["location", "/app/next?x=1"]] });
  });

  it.each([
    ["another origin", "http://elsewhere.invalid/", ROOT],
    ["another scheme", "https://127.0.0.1:4173/", ROOT],
    ["a scheme-relative URL", "//elsewhere.invalid/", ROOT],
    ["a backslash scheme-relative URL", "/\\elsewhere.invalid/", ROOT],
    ["a double-slash path", "http://127.0.0.1:4173//elsewhere.invalid/x", ROOT],
    ["a path outside the prefix", "/admin/", SCOPED],
    ["a relative path leaving the prefix", "../../admin", SCOPED],
  ])("blocks a redirect to %s", (_label, location, capability) => {
    expect(
      filterResponseHeaders({
        status: 307,
        headers: [["location", location]],
        requestUrl,
        capability,
      }),
    ).toEqual({ kind: "redirect_blocked" });
  });

  it("drops Location outside redirects", () => {
    expect(
      filterResponseHeaders({
        status: 201,
        headers: [["location", "http://elsewhere.invalid/"]],
        requestUrl,
        capability: ROOT,
      }),
    ).toEqual({ kind: "pass", headers: [] });
  });
});
