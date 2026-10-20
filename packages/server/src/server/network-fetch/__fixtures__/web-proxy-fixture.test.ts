/* eslint-disable max-nested-callbacks */
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { EXIT_VECTORS } from "./pages.js";
import { patternChunk } from "./routes.js";
import { startWebProxyFixture, type WebProxyFixture } from "./web-proxy-fixture.js";
import { ECHO_SUBPROTOCOL } from "./websocket.js";

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  ca?: string;
  servername?: string;
}

interface OpenResponse {
  req: http.ClientRequest;
  res: http.IncomingMessage;
}

function clientFor(url: URL): typeof http | typeof https {
  return url.protocol === "https:" ? https : http;
}

function requestOptions(url: URL, init: RequestInit): https.RequestOptions {
  return {
    host: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: init.method ?? "GET",
    headers: init.headers ?? {},
    ...(init.ca ? { ca: init.ca } : {}),
    ...(init.servername ? { servername: init.servername } : {}),
  };
}

function open(target: string, init: RequestInit = {}): Promise<OpenResponse> {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const req = clientFor(url).request(requestOptions(url, init), (res) => resolve({ req, res }));
    req.on("error", reject);
    req.end(init.body);
  });
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function request(target: string, init: RequestInit = {}): Promise<Reply> {
  const { res } = await open(target, init);
  return { status: res.statusCode ?? 0, headers: res.headers, body: await collect(res) };
}

async function requestJson<T>(
  target: string,
  init: RequestInit = {},
): Promise<Reply & { json: T }> {
  const reply = await request(target, init);
  return { ...reply, json: JSON.parse(reply.body.toString("utf8")) as T };
}

function requestError(target: string, init: RequestInit = {}): Promise<string> {
  return open(target, init).then(
    ({ res }) => {
      res.resume();
      return `status ${res.statusCode}`;
    },
    (error: NodeJS.ErrnoException) => error.code ?? error.message,
  );
}

function expectPattern(body: Buffer, offset: number): void {
  const expected = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 64 * 1024) {
    const step = Math.min(64 * 1024, body.length - index);
    patternChunk(offset + index, step).copy(expected, index);
  }
  expect(body.equals(expected)).toBe(true);
}

interface SocketOutcome {
  opened: Promise<void>;
  messages: Array<string | Buffer>;
  nextMessage(): Promise<string | Buffer>;
  closed: Promise<{ code: number; reason: string }>;
  socket: WebSocket;
}

function connectSocket(
  target: string,
  protocols: string[],
  options: WebSocket.ClientOptions,
): SocketOutcome {
  const socket = new WebSocket(target, protocols, options);
  const messages: Array<string | Buffer> = [];
  const waiters: Array<(message: string | Buffer) => void> = [];
  socket.on("message", (data, isBinary) => {
    const message = isBinary ? Buffer.from(data as Buffer) : data.toString();
    messages.push(message);
    waiters.shift()?.(message);
  });
  return {
    socket,
    messages,
    opened: new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }),
    nextMessage: () => new Promise((resolve) => waiters.push(resolve)),
    closed: new Promise((resolve) =>
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    ),
  };
}

function parseSse(body: string): Array<{ id: string; data: { seq: number; nonce: string } }> {
  return body
    .split("\n\n")
    .filter((block) => block.includes("event: tick"))
    .map((block) => {
      const lines = Object.fromEntries(
        block
          .split("\n")
          .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]),
      );
      return { id: lines.id, data: JSON.parse(lines.data) };
    });
}

function connectRefused(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
  });
}

function cookieHeader(setCookie: string[] | undefined): string {
  return (setCookie ?? []).map((cookie) => cookie.slice(0, cookie.indexOf(";"))).join("; ");
}

let main: WebProxyFixture;
let peer: WebProxyFixture;

beforeAll(async () => {
  peer = await startWebProxyFixture({
    limits: {
      echoBodyBytes: 1024,
      probeReportBytes: 256,
      largeMaxBytes: 65_536,
      maxPostTokens: 1,
      maxEvents: 5,
    },
  });
  main = await startWebProxyFixture({
    tls: { extraNames: ["fixture-a.test"] },
    canary: true,
    peerOrigins: [peer.http.origin],
  });
});

afterAll(async () => {
  await main.close();
  await peer.close();
});

describe("web proxy fixture", () => {
  describe("documents", () => {
    it("serves the light page with the request nonce, forms, and ready marker", async () => {
      const reply = await request(`${main.http.baseUrl}/?n=nonce-light-1`);
      expect(reply.status).toBe(200);
      expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(reply.headers["x-fixture-nonce"]).toBe("nonce-light-1");
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.body.length).toBeGreaterThanOrEqual(40 * 1024);
      expect(reply.body.length).toBeLessThanOrEqual(60 * 1024);
      const html = reply.body.toString("utf8");
      expect(html).toContain('data-nonce="nonce-light-1"');
      expect(html).toContain('<code data-role="nonce">nonce-light-1</code>');
      expect(html).toContain('data-role="form-get"');
      expect(html).toContain('data-role="form-post"');
      expect(html).toContain("<textarea");
      expect(html).toContain('document.documentElement.dataset.ready = "1"');
      const event = await main.events.waitFor("request", (e) => e.nonce === "nonce-light-1");
      expect(event).toMatchObject({ listener: "http", method: "GET", path: "/" });
    });

    it("escapes the nonce in HTML and rejects malformed nonces", async () => {
      const reply = await requestJson<{ error: string }>(
        `${main.http.baseUrl}/?n=bad%20nonce%3Cscript%3E`,
      );
      expect(reply.status).toBe(400);
      expect(reply.json).toEqual({ error: "invalid_nonce" });
      const fromHeader = await request(`${main.http.baseUrl}/`, {
        headers: { "x-fixture-nonce": "header.nonce:1" },
      });
      expect(fromHeader.headers["x-fixture-nonce"]).toBe("header.nonce:1");
    });

    it("serves the spa page for nested routes", async () => {
      const reply = await request(`${main.http.baseUrl}/spa/one?n=spa-1`);
      expect(reply.status).toBe(200);
      const html = reply.body.toString("utf8");
      expect(html).toContain('data-fixture="spa"');
      expect(html).toContain('id="fetch-relative"');
      expect(html).toContain('id="fetch-absolute"');
      expect(html).toContain("new AbortController()");
      expect(html).toContain(JSON.stringify(main.http.origin));
    });

    it("serves the probe page only against an allowed peer and records reports", async () => {
      const probe = await request(
        `${main.http.baseUrl}/probe?n=probe-1&peer=${encodeURIComponent(peer.http.origin)}`,
      );
      expect(probe.status).toBe(200);
      const html = probe.body.toString("utf8");
      expect(html).toContain(`<code data-role="peer">${peer.http.origin}</code>`);
      expect(html).toContain('credentials: "include"');
      expect(html).toContain("getRegistrations()");
      expect(html).toContain("$scramjetController");

      const denied = await requestJson<{ error: string }>(
        `${main.http.baseUrl}/probe?peer=http://evil.test`,
      );
      expect(denied).toMatchObject({ status: 400, json: { error: "peer_not_allowed" } });
      const missing = await requestJson<{ error: string }>(`${main.http.baseUrl}/probe`);
      expect(missing).toMatchObject({ status: 400, json: { error: "missing_peer" } });

      const report = { nonce: "probe-2", probes: { documentCookieNames: { ok: true, value: [] } } };
      const posted = await request(`${main.http.baseUrl}/probe/report?n=probe-2`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report),
      });
      expect(posted.status).toBe(204);
      expect(posted.headers["access-control-allow-origin"]).toBe("*");
      const recorded = await main.events.waitFor("probe.report", (e) => e.nonce === "probe-2");
      expect(recorded.report).toEqual(report);

      const invalid = await requestJson<{ error: string }>(`${main.http.baseUrl}/probe/report`, {
        method: "POST",
        body: "{not json",
      });
      expect(invalid).toMatchObject({ status: 400, json: { error: "invalid_json" } });
      const tooLarge = await requestJson<{ error: string }>(`${peer.http.baseUrl}/probe/report`, {
        method: "POST",
        body: JSON.stringify({ pad: "x".repeat(512) }),
      });
      expect(tooLarge).toMatchObject({ status: 413, json: { error: "too_large", limit: 256 } });
    });

    it("serves the exit page with every egress vector aimed at an allowed decoy", async () => {
      const decoy = main.canary?.origin ?? "";
      const reply = await request(
        `${main.http.baseUrl}/exit?n=exit-1&token=tok-exit&decoy=${encodeURIComponent(decoy)}`,
      );
      expect(reply.status).toBe(200);
      const html = reply.body.toString("utf8");
      expect(html).toContain(`<code data-role="decoy">${decoy}</code>`);
      expect(html).toContain(JSON.stringify(EXIT_VECTORS));
      for (const vector of EXIT_VECTORS) expect(html).toContain(`${vector}: function`);
      const denied = await requestJson<{ error: string }>(
        `${main.http.baseUrl}/exit?decoy=http://evil.test`,
      );
      expect(denied).toMatchObject({ status: 400, json: { error: "decoy_not_allowed" } });
    });

    it("answers unknown paths and wrong methods with JSON errors", async () => {
      const missing = await requestJson<{ error: string; path: string }>(
        `${main.http.baseUrl}/nope`,
      );
      expect(missing).toMatchObject({ status: 404, json: { error: "not_found", path: "/nope" } });
      const wrongMethod = await requestJson<{ error: string }>(`${main.http.baseUrl}/slow`, {
        method: "POST",
      });
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.allow).toBe("GET");
    });
  });

  describe("echo and cookies", () => {
    it("echoes method, query, header names, and cookie names without cookie values", async () => {
      const reply = await requestJson<{
        method: string;
        query: Record<string, string[]>;
        headerNames: string[];
        cookieNames: string[];
        body: string;
        bodyBytes: number;
      }>(`${main.http.baseUrl}/api/echo?n=echo-1&q=1&q=2`, {
        method: "POST",
        headers: {
          "x-custom": "1",
          cookie: "a=secret-value-1; b=2",
          "proxy-authorization": "Basic c2VjcmV0",
        },
        body: "hello",
      });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({
        method: "POST",
        query: { n: ["echo-1"], q: ["1", "2"] },
        cookieNames: ["a", "b"],
        body: "hello",
        bodyBytes: 5,
      });
      expect(reply.json.headerNames).toEqual(
        expect.arrayContaining(["x-custom", "cookie", "proxy-authorization", "host"]),
      );
      expect(JSON.stringify(main.events.list())).not.toContain("secret-value-1");
      expect(JSON.stringify(main.events.list())).not.toContain("c2VjcmV0");
    });

    it("refuses echo bodies above the configured limit", async () => {
      const reply = await requestJson<{ error: string }>(`${peer.http.baseUrl}/api/echo`, {
        method: "POST",
        body: Buffer.alloc(2048, 1),
      });
      expect(reply).toMatchObject({ status: 413, json: { error: "too_large", limit: 1024 } });
    });

    it("issues HttpOnly session cookies over http and recognizes them on read", async () => {
      const set = await requestJson<{ issued: string[]; secure: boolean }>(
        `${main.http.baseUrl}/cookie/set?n=cookie-1`,
      );
      const cookies = set.headers["set-cookie"] ?? [];
      expect(set.json).toEqual({ issued: ["fixture_sess", "fixture_plain"], secure: false });
      expect(cookies).toHaveLength(2);
      expect(cookies[0]).toMatch(/^fixture_sess=[0-9a-f]{32}; Path=\/; HttpOnly; SameSite=Lax$/);
      expect(cookies[1]).toMatch(/^fixture_plain=[0-9a-f]{32}; Path=\/; SameSite=Lax$/);

      const read = await requestJson<{ names: string[]; recognized: string[]; unknown: string[] }>(
        `${main.http.baseUrl}/cookie/read?n=cookie-2`,
        { headers: { cookie: `${cookieHeader(cookies)}; other=1` } },
      );
      expect(read.json).toEqual({
        names: ["fixture_sess", "fixture_plain", "other"],
        recognized: ["fixture_sess", "fixture_plain"],
        unknown: ["other"],
      });
      const issuedValue = cookies[0].slice("fixture_sess=".length, "fixture_sess=".length + 32);
      expect(JSON.stringify(main.events.list())).not.toContain(issuedValue);

      const cleared = await request(`${main.http.baseUrl}/cookie/clear`);
      expect(cleared.headers["set-cookie"]).toEqual([
        "fixture_sess=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly",
        "fixture_plain=; Path=/; Max-Age=0; SameSite=Lax",
        "__Host-fixture=; Path=/; Max-Age=0; SameSite=Lax; Secure",
      ]);
    });

    it("adds Secure and __Host- cookies over https", async () => {
      const tls = main.https;
      if (!tls) throw new Error("tls listener missing");
      const set = await requestJson<{ issued: string[]; secure: boolean }>(
        `${tls.baseUrl}/cookie/set`,
        { ca: tls.caPem },
      );
      expect(set.json).toEqual({
        issued: ["fixture_sess", "fixture_plain", "__Host-fixture"],
        secure: true,
      });
      const cookies = set.headers["set-cookie"] ?? [];
      expect(cookies[0]).toMatch(/HttpOnly; SameSite=Lax; Secure$/);
      expect(cookies[1]).toMatch(/SameSite=Lax; Secure$/);
      expect(cookies[2]).toMatch(/^__Host-fixture=[0-9a-f]{32}; Path=\/; Secure; SameSite=Lax$/);
    });
  });

  describe("redirects", () => {
    it.each([301, 302, 303, 307, 308])(
      "answers %s with a same-origin landing location",
      async (code) => {
        const reply = await request(`${main.http.baseUrl}/redirect/${code}?n=r-${code}`);
        expect(reply.status).toBe(code);
        expect(reply.headers.location).toBe(`/redirect/landing?n=r-${code}`);
      },
    );

    it("preserves POST through 307 and downgrades to GET through 303 when followed", async () => {
      const preserved = await fetch(`${main.http.baseUrl}/redirect/307?n=r-follow-307`, {
        method: "POST",
        body: "payload",
      });
      expect(await preserved.json()).toEqual({ landed: true, method: "POST", bodyBytes: 7 });
      const downgraded = await fetch(`${main.http.baseUrl}/redirect/303?n=r-follow-303`, {
        method: "POST",
        body: "payload",
      });
      expect(await downgraded.json()).toEqual({ landed: true, method: "GET", bodyBytes: 0 });
      const landings = main.events
        .ofKind("redirect.landing")
        .map((e) => [e.nonce, e.method, e.bodyBytes]);
      expect(landings).toEqual(
        expect.arrayContaining([
          ["r-follow-307", "POST", 7],
          ["r-follow-303", "GET", 0],
        ]),
      );
    });

    it("loops, chains, and only points absolute redirects at synthetic or peer targets", async () => {
      const loop = await request(`${main.http.baseUrl}/redirect/loop?n=r-loop`);
      expect(loop.status).toBe(302);
      expect(loop.headers.location).toBe("/redirect/loop?n=r-loop");

      const chain = await fetch(`${main.http.baseUrl}/redirect/chain/3?n=r-chain`);
      expect(await chain.json()).toEqual({ landed: true, method: "GET", bodyBytes: 0 });
      const hops = main.events
        .ofKind("request")
        .filter((e) => e.nonce === "r-chain")
        .map((e) => e.path);
      expect(hops).toEqual([
        "/redirect/chain/3",
        "/redirect/chain/2",
        "/redirect/chain/1",
        "/redirect/landing",
      ]);

      const metadata = await request(
        `${main.http.baseUrl}/redirect/302?to=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}`,
      );
      expect(metadata.status).toBe(302);
      expect(metadata.headers.location).toBe("http://169.254.169.254/latest/meta-data/");
      const linkLocal = await request(
        `${main.http.baseUrl}/redirect/307?to=${encodeURIComponent("http://[fe80::1]/")}`,
      );
      expect(linkLocal.headers.location).toBe("http://[fe80::1]/");
      const otherPort = await request(
        `${main.http.baseUrl}/redirect/302?to=${encodeURIComponent("http://localhost:6767/api/health")}`,
      );
      expect(otherPort.headers.location).toBe("http://localhost:6767/api/health");
      const toPeer = await request(
        `${main.http.baseUrl}/redirect/302?to=${encodeURIComponent(`${peer.http.origin}/api/echo`)}`,
      );
      expect(toPeer.headers.location).toBe(`${peer.http.origin}/api/echo`);

      const denied = await requestJson<{ error: string }>(
        `${main.http.baseUrl}/redirect/302?to=${encodeURIComponent("http://example.com/")}`,
      );
      expect(denied).toMatchObject({ status: 400, json: { error: "to_not_allowed" } });
      const schemeRelative = await requestJson<{ error: string }>(
        `${main.http.baseUrl}/redirect/302?to=${encodeURIComponent("//example.com/")}`,
      );
      expect(schemeRelative).toMatchObject({ status: 400, json: { error: "invalid_to" } });
    });
  });

  describe("bodies and streams", () => {
    it("streams the slow body and records client aborts", async () => {
      const { req, res } = await open(
        `${main.http.baseUrl}/slow?bytes=4096&chunk=16&intervalMs=10&n=slow-abort`,
      );
      await new Promise<void>((resolve) => res.once("data", () => resolve()));
      req.destroy();
      const aborted = await main.events.waitFor("slow.closed", (e) => e.nonce === "slow-abort");
      expect(aborted.completed).toBe(false);
      expect(aborted.bytesSent).toBeGreaterThan(0);
      expect(aborted.bytesSent).toBeLessThan(4096);

      const full = await request(
        `${main.http.baseUrl}/slow?bytes=256&chunk=64&intervalMs=1&n=slow-full`,
      );
      expect(full.headers["content-length"]).toBe("256");
      expectPattern(full.body, 0);
      const completed = await main.events.waitFor("slow.closed", (e) => e.nonce === "slow-full");
      expect(completed).toMatchObject({ completed: true, bytesSent: 256 });
    });

    it("serves large downloads with bounded buffering and honours slow consumers", async () => {
      const bytes = 2 * 1024 * 1024;
      const reply = await request(`${main.http.baseUrl}/large?bytes=${bytes}&n=large-1`);
      expect(reply.headers["content-length"]).toBe(String(bytes));
      expect(reply.headers["content-disposition"]).toBe(
        `attachment; filename="fixture-${bytes}.bin"`,
      );
      expectPattern(reply.body, 0);
      const closed = await main.events.waitFor("large.closed", (e) => e.nonce === "large-1");
      expect(closed).toMatchObject({ completed: true, bytesSent: bytes });
      expect(closed.maxBuffered).toBeLessThanOrEqual(128 * 1024);

      // 64 MiB exceeds any loopback socket buffer, so a paused reader must stall the writer.
      const pausedBytes = 64 * 1024 * 1024;
      const { res } = await open(`${main.http.baseUrl}/large?bytes=${pausedBytes}&n=large-paused`);
      res.pause();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        main.events.ofKind("large.closed").find((e) => e.nonce === "large-paused"),
      ).toBeUndefined();
      let received = 0;
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
      });
      res.resume();
      await new Promise<void>((resolve) => res.once("end", () => resolve()));
      expect(received).toBe(pausedBytes);
      const drained = await main.events.waitFor("large.closed", (e) => e.nonce === "large-paused");
      expect(drained).toMatchObject({ completed: true, bytesSent: pausedBytes });
      expect(drained.maxBuffered).toBeLessThanOrEqual(128 * 1024);

      const overLimit = await requestJson<{ error: string }>(
        `${peer.http.baseUrl}/large?bytes=70000`,
      );
      expect(overLimit).toMatchObject({ status: 400, json: { error: "invalid_bytes" } });
    });

    it("answers byte ranges with 206 and unsatisfiable ranges with 416", async () => {
      const total = 1024 * 1024;
      const whole = await request(`${main.http.baseUrl}/range`);
      expect(whole.status).toBe(200);
      expect(whole.headers["accept-ranges"]).toBe("bytes");
      expect(whole.body.length).toBe(total);

      const slice = await request(`${main.http.baseUrl}/range`, {
        headers: { range: "bytes=100-199" },
      });
      expect(slice.status).toBe(206);
      expect(slice.headers["content-range"]).toBe(`bytes 100-199/${total}`);
      expectPattern(slice.body, 100);

      const suffix = await request(`${main.http.baseUrl}/range`, {
        headers: { range: "bytes=-10" },
      });
      expect(suffix.headers["content-range"]).toBe(`bytes ${total - 10}-${total - 1}/${total}`);
      expectPattern(suffix.body, total - 10);

      const beyond = await request(`${main.http.baseUrl}/range`, {
        headers: { range: "bytes=2000000-" },
      });
      expect(beyond.status).toBe(416);
      expect(beyond.headers["content-range"]).toBe(`bytes */${total}`);
    });

    it("hashes uploads, rejects oversize bodies, and records cancellations", async () => {
      const payload = randomBytes(300 * 1024);
      const accepted = await requestJson<{ bytesReceived: number; sha256: string }>(
        `${main.http.baseUrl}/upload?n=up-ok`,
        {
          method: "POST",
          body: payload,
        },
      );
      expect(accepted.json).toEqual({
        bytesReceived: payload.length,
        sha256: createHash("sha256").update(payload).digest("hex"),
      });
      expect(
        await main.events.waitFor("upload.finished", (e) => e.nonce === "up-ok"),
      ).toMatchObject({
        completed: true,
        bytesReceived: payload.length,
        rejected: null,
      });

      const rejected = await requestJson<{ error: string }>(
        `${main.http.baseUrl}/upload?n=up-big&limit=1024`,
        {
          method: "POST",
          body: Buffer.alloc(64 * 1024, 7),
        },
      );
      expect(rejected).toMatchObject({ status: 413, json: { error: "too_large", limit: 1024 } });
      expect(
        await main.events.waitFor("upload.finished", (e) => e.nonce === "up-big"),
      ).toMatchObject({
        completed: false,
        rejected: "too_large",
        bytesReceived: 64 * 1024,
      });

      const url = new URL(`${main.http.baseUrl}/upload?n=up-cancel`);
      const cancelled = http.request({
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: { "content-length": String(1024 * 1024) },
      });
      cancelled.on("error", () => undefined);
      await new Promise<void>((resolve) =>
        cancelled.write(Buffer.alloc(64 * 1024, 1), () => resolve()),
      );
      cancelled.destroy();
      const cancelEvent = await main.events.waitFor(
        "upload.finished",
        (e) => e.nonce === "up-cancel",
      );
      expect(cancelEvent.completed).toBe(false);
      expect(cancelEvent.rejected).toBeNull();
      expect(cancelEvent.bytesReceived).toBeLessThanOrEqual(64 * 1024);
    });

    it("counts idempotent POSTs per token and caps the token table", async () => {
      for (const expected of [1, 2, 3]) {
        const reply = await requestJson<{ token: string; count: number }>(
          `${main.http.baseUrl}/post/tok-1?n=post-${expected}`,
          {
            method: "POST",
            body: "submit",
          },
        );
        expect(reply.json).toEqual({ token: "tok-1", count: expected });
      }
      const read = await requestJson<{ count: number }>(`${main.http.baseUrl}/post/tok-1`);
      expect(read.json).toEqual({ token: "tok-1", count: 3 });
      expect(main.postCount("tok-1")).toBe(3);
      expect(main.events.ofKind("post.count").map((e) => e.count)).toEqual([1, 2, 3]);

      await requestJson(`${peer.http.baseUrl}/post/a`, { method: "POST" });
      const capped = await requestJson<{ error: string }>(`${peer.http.baseUrl}/post/b`, {
        method: "POST",
      });
      expect(capped).toMatchObject({ status: 429, json: { error: "too_many_tokens", limit: 1 } });
    });

    it("emits server-sent events with ids, resumes after Last-Event-ID, and records early close", async () => {
      const reply = await request(`${main.http.baseUrl}/sse?count=3&intervalMs=5&n=sse-1`);
      expect(reply.headers["content-type"]).toBe("text/event-stream");
      expect(reply.headers["cache-control"]).toBe("no-store");
      const events = parseSse(reply.body.toString("utf8"));
      expect(events.map((e) => e.id)).toEqual(["1", "2", "3"]);
      expect(events.map((e) => e.data)).toEqual([
        { seq: 1, nonce: "sse-1" },
        { seq: 2, nonce: "sse-1" },
        { seq: 3, nonce: "sse-1" },
      ]);
      expect(await main.events.waitFor("sse.closed", (e) => e.nonce === "sse-1")).toMatchObject({
        completed: true,
        eventsSent: 3,
        resumedAfter: null,
      });

      const resumed = await request(`${main.http.baseUrl}/sse?count=2&intervalMs=5&n=sse-resume`, {
        headers: { "last-event-id": "7" },
      });
      expect(parseSse(resumed.body.toString("utf8")).map((e) => e.id)).toEqual(["8", "9"]);
      expect(
        await main.events.waitFor("sse.closed", (e) => e.nonce === "sse-resume"),
      ).toMatchObject({
        resumedAfter: 7,
      });

      const { req, res } = await open(
        `${main.http.baseUrl}/sse?count=1000&intervalMs=5&n=sse-abort`,
      );
      await new Promise<void>((resolve) => res.once("data", () => resolve()));
      req.destroy();
      const aborted = await main.events.waitFor("sse.closed", (e) => e.nonce === "sse-abort");
      expect(aborted.completed).toBe(false);
      expect(aborted.eventsSent).toBeLessThan(1000);
    });
  });

  describe("websocket", () => {
    it("echoes text and binary frames, negotiates the subprotocol, and records close codes", async () => {
      const target = `${main.http.baseUrl.replace("http", "ws")}/ws/echo?n=ws-1`;
      const client = connectSocket(target, [ECHO_SUBPROTOCOL], { origin: "http://origin.test" });
      await client.opened;
      expect(client.socket.protocol).toBe(ECHO_SUBPROTOCOL);
      client.socket.send("hello");
      expect(await client.nextMessage()).toBe("hello");
      client.socket.send(Buffer.from([1, 2, 3]));
      expect(await client.nextMessage()).toEqual(Buffer.from([1, 2, 3]));
      client.socket.close(4000, "bye");
      expect(await client.closed).toEqual({ code: 4000, reason: "bye" });
      expect(await main.events.waitFor("ws.opened", (e) => e.nonce === "ws-1")).toMatchObject({
        path: "/ws/echo",
        origin: "http://origin.test",
        subprotocol: ECHO_SUBPROTOCOL,
      });
      expect(await main.events.waitFor("ws.closed", (e) => e.nonce === "ws-1")).toMatchObject({
        code: 4000,
        reason: "bye",
      });
    });

    it("closes with the requested code and refuses unknown upgrade paths", async () => {
      const base = main.http.baseUrl.replace("http", "ws");
      const closing = connectSocket(`${base}/ws/close?code=4321&n=ws-close`, [], {});
      await closing.opened;
      expect(await closing.closed).toEqual({ code: 4321, reason: "fixture-close" });

      const unknown = new WebSocket(`${base}/ws/nope`);
      const status = await new Promise<number>((resolve) => {
        unknown.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      });
      expect(status).toBe(404);
    });

    it("echoes over wss with the synthetic CA", async () => {
      const tls = main.https;
      if (!tls) throw new Error("tls listener missing");
      const client = connectSocket(`${tls.baseUrl.replace("https", "wss")}/ws/echo?n=wss-1`, [], {
        ca: tls.caPem,
      });
      await client.opened;
      client.socket.send("secure");
      expect(await client.nextMessage()).toBe("secure");
      client.socket.close(1000);
      await client.closed;
      expect(await main.events.waitFor("ws.opened", (e) => e.nonce === "wss-1")).toMatchObject({
        listener: "https",
      });
    });
  });

  describe("tls", () => {
    it("accepts the valid listener only with the synthetic CA and rejects each defective variant", async () => {
      const tls = main.https;
      const variants = main.httpsVariants;
      if (!tls || !variants) throw new Error("tls listeners missing");
      expect(tls.serverNames).toEqual(["localhost", "127.0.0.1", "::1", "fixture-a.test"]);

      const trusted = await request(`${tls.baseUrl}/?n=tls-ok`, { ca: tls.caPem });
      expect(trusted.status).toBe(200);
      expect(await main.events.waitFor("request", (e) => e.nonce === "tls-ok")).toMatchObject({
        listener: "https",
      });
      const byName = await request(`${tls.baseUrl}/api/echo`, {
        ca: tls.caPem,
        servername: "fixture-a.test",
      });
      expect(byName.status).toBe(200);

      expect(await requestError(`${tls.baseUrl}/`)).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
      expect(await requestError(`${variants.wrongHost.baseUrl}/`, { ca: tls.caPem })).toBe(
        "ERR_TLS_CERT_ALTNAME_INVALID",
      );
      expect(await requestError(`${variants.expired.baseUrl}/`, { ca: tls.caPem })).toBe(
        "CERT_HAS_EXPIRED",
      );
      expect(await requestError(`${variants.selfSigned.baseUrl}/`, { ca: tls.caPem })).toBe(
        "DEPTH_ZERO_SELF_SIGNED_CERT",
      );
    });
  });

  describe("canary", () => {
    it("records hits on the dedicated listener and serves nothing else there", async () => {
      const canary = main.canary;
      if (!canary) throw new Error("canary listener missing");
      const hit = await request(`${canary.baseUrl}/canary/tok-9?n=canary-1&v=img`, {
        headers: { "user-agent": "fixture-test", origin: "http://page.test" },
      });
      expect(hit.status).toBe(204);
      expect(hit.headers["access-control-allow-origin"]).toBe("*");
      expect(await main.events.waitFor("canary.hit", (e) => e.nonce === "canary-1")).toMatchObject({
        listener: "canary",
        token: "tok-9",
        vector: "img",
        method: "GET",
        userAgent: "fixture-test",
        origin: "http://page.test",
      });
      const preflight = await request(`${canary.baseUrl}/canary/tok-9`, { method: "OPTIONS" });
      expect(preflight.status).toBe(204);
      const elsewhere = await requestJson<{ error: string }>(`${canary.baseUrl}/`);
      expect(elsewhere).toMatchObject({ status: 404, json: { error: "not_found" } });

      const onMain = await request(`${main.http.baseUrl}/canary/tok-9?n=canary-2`, {
        method: "POST",
        body: "beacon",
      });
      expect(onMain.status).toBe(204);
      expect(await main.events.waitFor("canary.hit", (e) => e.nonce === "canary-2")).toMatchObject({
        listener: "http",
        method: "POST",
      });
    });
  });

  describe("lifecycle", () => {
    it("bounds the event buffer and counts what it dropped", async () => {
      peer.events.clear();
      for (let index = 0; index < 8; index += 1)
        await request(`${peer.http.baseUrl}/api/echo?n=bound-${index}`);
      const nonces = peer.events.ofKind("request").map((e) => e.nonce);
      expect(nonces).toEqual(["bound-3", "bound-4", "bound-5", "bound-6", "bound-7"]);
      expect(peer.events.dropped).toBe(3);
    });

    it("closes promptly with open SSE and WebSocket connections and stays closed", async () => {
      const fixture = await startWebProxyFixture();
      const sse = await open(`${fixture.http.baseUrl}/sse?count=1000&intervalMs=50&n=life-sse`);
      await new Promise<void>((resolve) => sse.res.once("data", () => resolve()));
      const socket = connectSocket(
        `${fixture.http.baseUrl.replace("http", "ws")}/ws/echo?n=life-ws`,
        [],
        {},
      );
      await socket.opened;
      socket.socket.on("error", () => undefined);

      const startedAt = Date.now();
      await fixture.close();
      await fixture.close();
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(fixture.events.ofKind("sse.closed").map((e) => [e.nonce, e.completed])).toEqual([
        ["life-sse", false],
      ]);
      expect(fixture.events.ofKind("ws.closed").map((e) => e.nonce)).toEqual(["life-ws"]);
      expect(await connectRefused(fixture.http.port)).toBe("ECONNREFUSED");
    });
  });
});
