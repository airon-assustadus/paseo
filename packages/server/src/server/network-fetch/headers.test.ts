import { describe, expect, it } from "vitest";
import { NetworkFetchError } from "./errors.js";
import { buildUpstreamHead, filterResponseHeaders } from "./headers.js";

function pairs(raw: string[]): [string, string][] {
  const result: [string, string][] = [];
  for (let index = 0; index < raw.length; index += 2) result.push([raw[index], raw[index + 1]]);
  return result;
}

describe("upstream request head", () => {
  it("forwards only the allowed headers and sets transport headers itself", () => {
    const head = buildUpstreamHead({
      method: "GET",
      url: new URL("http://fixture.test:8080/a?b=1"),
      headers: [
        ["Accept", "text/html"],
        ["X-Custom", "1"],
        ["Referer", "http://elsewhere.test/"],
        ["Origin", "http://forged.test"],
        ["Host", "forged.test"],
        ["Sec-Fetch-Site", "same-origin"],
        ["Connection", "keep-alive"],
        ["Accept-Encoding", "gzip"],
      ],
      origin: "http://fixture.test:8080",
      bodyLength: null,
      hasBody: false,
    });
    expect(pairs(head.rawHeaders)).toEqual([
      ["Accept", "text/html"],
      ["Host", "fixture.test:8080"],
      ["Accept-Encoding", "identity"],
      ["Connection", "close"],
    ]);
    expect(head.droppedRequestHeaders).toEqual([
      "x-custom",
      "referer",
      "origin",
      "host",
      "sec-fetch-site",
      "connection",
      "accept-encoding",
    ]);
  });

  it("sends the bound origin, never the page's, on unsafe methods", () => {
    const withOrigin = buildUpstreamHead({
      method: "POST",
      url: new URL("http://fixture.test/form"),
      headers: [["Origin", "http://forged.test"]],
      origin: "http://fixture.test",
      bodyLength: 3,
      hasBody: true,
    });
    expect(pairs(withOrigin.rawHeaders)).toContainEqual(["Origin", "http://fixture.test"]);
    expect(pairs(withOrigin.rawHeaders)).toContainEqual(["Content-Length", "3"]);
    const opaque = buildUpstreamHead({
      method: "DELETE",
      url: new URL("http://fixture.test/item"),
      headers: [],
      origin: null,
      bodyLength: null,
      hasBody: false,
    });
    expect(pairs(opaque.rawHeaders)).toContainEqual(["Origin", "null"]);
    expect(pairs(opaque.rawHeaders)).toContainEqual(["Content-Length", "0"]);
  });

  it.each(["Cookie", "authorization", "Proxy-Authorization"])(
    "refuses the credential header %s explicitly",
    (name) => {
      expect(() =>
        buildUpstreamHead({
          method: "GET",
          url: new URL("http://fixture.test/"),
          headers: [[name, "secret"]],
          origin: null,
          bodyLength: null,
          hasBody: false,
        }),
      ).toThrow(expect.objectContaining({ code: "credentials_unsupported" }));
    },
  );

  const malformed: [string, [string, string]][] = [
    ["a header name with a space", ["Bad Name", "x"]],
    ["a CRLF in a value", ["Accept", "a\r\nX-Injected: 1"]],
    ["a NUL in a value", ["Accept", "a\0b"]],
  ];
  it.each(malformed)("refuses %s", (_case, header) => {
    expect(() =>
      buildUpstreamHead({
        method: "GET",
        url: new URL("http://fixture.test/"),
        headers: [header],
        origin: null,
        bodyLength: null,
        hasBody: false,
      }),
    ).toThrow(NetworkFetchError);
  });
});

describe("response headers", () => {
  it("strips cookies, transport and browser-state headers and counts dropped cookies", () => {
    const filtered = filterResponseHeaders(
      [
        "Content-Type",
        "text/html",
        "Set-Cookie",
        "a=1; HttpOnly",
        "set-cookie",
        "b=2",
        "Connection",
        "close, X-Hop",
        "X-Hop",
        "1",
        "Transfer-Encoding",
        "chunked",
        "Strict-Transport-Security",
        "max-age=1",
        "Alt-Svc",
        'h3=":443"',
        "Report-To",
        "{}",
        "NEL",
        "{}",
        "Content-Security-Policy",
        "default-src 'self'",
      ],
      { decoded: false },
    );
    expect(filtered).toEqual({
      headers: [
        ["Content-Type", "text/html"],
        ["Content-Security-Policy", "default-src 'self'"],
      ],
      setCookieDropped: 2,
    });
  });

  it("removes encoding and length once the daemon decoded the body", () => {
    const raw = ["Content-Encoding", "gzip", "Content-Length", "10", "ETag", '"x"'];
    expect(filterResponseHeaders(raw, { decoded: true }).headers).toEqual([["ETag", '"x"']]);
    expect(filterResponseHeaders(raw, { decoded: false }).headers).toHaveLength(3);
  });
});
