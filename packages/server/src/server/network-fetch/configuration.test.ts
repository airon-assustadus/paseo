import { describe, expect, it } from "vitest";
import { resolveNetworkFetchConfiguration, type NetworkFetchConfig } from "./configuration.js";

function configuration(): NetworkFetchConfig {
  return {
    enabled: true,
    dedicatedContentDomain: "content.example.test",
    controlOrigin: "https://control.example.test",
    assetVersion: "v1",
    bootstrapPath: "/bootstrap.html",
    pathPrefix: "/",
    ttlMs: 60_000,
    handshakeTimeoutMs: 10_000,
    allowlists: [
      {
        id: "local",
        revision: 1,
        targets: [{ origin: "http://localhost:3000", pathPrefix: "/app/" }],
      },
    ],
  };
}

describe("network fetch host configuration", () => {
  it("is disabled without explicit opt-in and has no public defaults", () => {
    expect(resolveNetworkFetchConfiguration(undefined)).toBeNull();
    expect(resolveNetworkFetchConfiguration({})).toBeNull();
    expect(resolveNetworkFetchConfiguration({ enabled: false })).toBeNull();
    expect(() => resolveNetworkFetchConfiguration({ enabled: true })).toThrow();
  });

  it("accepts an explicit HTTPS control origin separated from the content domain", () => {
    expect(resolveNetworkFetchConfiguration(configuration())).toMatchObject({
      controlOrigin: "https://control.example.test",
      dedicatedContentDomain: "content.example.test",
    });
  });

  it.each([
    "http://control.example.test",
    "https://content.example.test",
    "https://nested.content.example.test",
    "https://control.example.test/path",
    "https://user:pass@control.example.test",
  ])("rejects the unsafe control origin %s", (controlOrigin) => {
    expect(() => resolveNetworkFetchConfiguration({ ...configuration(), controlOrigin })).toThrow();
  });

  it.each([
    "*.content.test",
    "CONTENT.test",
    "127.0.0.1",
    "content.test.",
    "localhost",
    "content..test",
  ])("rejects the content domain %s", (dedicatedContentDomain) => {
    expect(() =>
      resolveNetworkFetchConfiguration({ ...configuration(), dedicatedContentDomain }),
    ).toThrow();
  });

  it("rejects ambiguous allowlist authorities for one origin", () => {
    const config = configuration();
    config.allowlists!.push({
      id: "second",
      revision: 2,
      targets: [{ origin: "http://localhost:3000", pathPrefix: "/" }],
    });
    expect(() => resolveNetworkFetchConfiguration(config)).toThrow("unambiguous");
  });

  it.each([
    "//other.test/a",
    "/\\other.test/a",
    "https://other.test/a",
    "/a?b",
    "/a#b",
    "/a/../b",
    "/a b",
  ])("rejects the nonlocal bootstrap path %s", (bootstrapPath) => {
    expect(() => resolveNetworkFetchConfiguration({ ...configuration(), bootstrapPath })).toThrow();
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, 2 ** 31])("rejects the invalid TTL %s", (ttlMs) => {
    expect(() => resolveNetworkFetchConfiguration({ ...configuration(), ttlMs })).toThrow();
  });
});
