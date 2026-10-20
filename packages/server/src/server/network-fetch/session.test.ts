/* eslint-disable max-nested-callbacks */
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import https from "node:https";
import type { TunnelDial, TunnelDialInput } from "../network-tunnel/dial-target.js";
import type { ResolvedTunnelAddress } from "../network-tunnel/target-policy.js";
import { createSyntheticAuthority } from "./__fixtures__/tls/synthetic-authority.js";
import { parseTrustedTarget, type TrustedAllowlist, type TrustedTargetInput } from "./allowlist.js";
import { NetworkFetchOpenError, NetworkFetchProtocolError } from "./errors.js";
import type {
  NetworkFetchLimits,
  NetworkFetchMethod,
  NetworkFetchRequest,
  NetworkFetchResponseHead,
} from "./exchange.js";
import {
  openNetworkFetchSession,
  type NetworkFetchClosedReason,
  type NetworkFetchFailure,
  type NetworkFetchSession,
  type NetworkFetchSink,
} from "./session.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

interface FixtureServer {
  port: number;
  origin: string;
  connections(): number;
}

async function serve(handler: http.RequestListener): Promise<FixtureServer> {
  const server = http.createServer(handler);
  let connections = 0;
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Fixture has no port");
  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    connections: () => connections,
  };
}

type SinkEvent =
  | { type: "head"; requestId: number; head: NetworkFetchResponseHead }
  | { type: "body"; requestId: number; chunk: Buffer }
  | { type: "end"; requestId: number }
  | { type: "fail"; requestId: number; failure: NetworkFetchFailure }
  | { type: "uploadCredit"; requestId: number; bytes: number }
  | { type: "closed"; reason: NetworkFetchClosedReason };

interface Outcome {
  head: NetworkFetchResponseHead | null;
  body: string;
  bodyBytes: number;
  result: "end" | NetworkFetchFailure["code"];
}

function recordingSink() {
  const events: SinkEvent[] = [];
  const waiters = new Set<() => void>();
  const listeners = new Set<(event: SinkEvent) => void>();
  let session: NetworkFetchSession | null = null;
  let autoCredit = true;

  function push(event: SinkEvent): void {
    events.push(event);
    for (const listener of listeners) listener(event);
    for (const waiter of waiters) waiter();
  }

  const sink: NetworkFetchSink = {
    head: (requestId, head) => push({ type: "head", requestId, head }),
    body: (requestId, chunk) => {
      push({ type: "body", requestId, chunk: Buffer.from(chunk) });
      if (!autoCredit) return;
      queueMicrotask(() => {
        if (session?.isOpen) session.grantCredit(requestId, chunk.byteLength);
      });
    },
    end: (requestId) => push({ type: "end", requestId }),
    fail: (requestId, failure) => push({ type: "fail", requestId, failure }),
    uploadCredit: (requestId, bytes) => push({ type: "uploadCredit", requestId, bytes }),
    closed: (reason) => push({ type: "closed", reason }),
  };

  function until(predicate: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!predicate()) return;
        waiters.delete(check);
        resolve();
      };
      waiters.add(check);
      check();
    });
  }

  function eventsFor(requestId: number): SinkEvent[] {
    return events.filter((event) => "requestId" in event && event.requestId === requestId);
  }

  function deliveredBytes(requestId: number): number {
    let total = 0;
    for (const event of eventsFor(requestId)) {
      if (event.type === "body") total += event.chunk.length;
    }
    return total;
  }

  async function outcome(requestId: number): Promise<Outcome> {
    const isSettled = (event: SinkEvent) => event.type === "end" || event.type === "fail";
    await until(() => eventsFor(requestId).some(isSettled));
    let head: NetworkFetchResponseHead | null = null;
    const chunks: Buffer[] = [];
    let result: Outcome["result"] = "end";
    for (const event of eventsFor(requestId)) {
      if (event.type === "head") head = event.head;
      if (event.type === "body") chunks.push(event.chunk);
      if (event.type === "fail") result = event.failure.code;
    }
    const body = Buffer.concat(chunks);
    return { head, body: body.toString("utf8"), bodyBytes: body.length, result };
  }

  return {
    sink,
    events,
    until,
    eventsFor,
    deliveredBytes,
    outcome,
    attach(target: NetworkFetchSession) {
      session = target;
    },
    setAutoCredit(value: boolean) {
      autoCredit = value;
    },
    onEvent(listener: (event: SinkEvent) => void) {
      listeners.add(listener);
    },
    closedReasons(): NetworkFetchClosedReason[] {
      return events.flatMap((event) => (event.type === "closed" ? [event.reason] : []));
    },
  };
}

type Recording = ReturnType<typeof recordingSink>;

function allowlistStore(targets: readonly string[]) {
  let current: TrustedAllowlist = {
    id: "fixtures",
    revision: 1,
    targets: targets.map((origin) => parseTrustedTarget({ origin, pathPrefix: "/" })),
  };
  return {
    store: { get: (id: string) => (id === current.id ? current : null) },
    bumpRevision() {
      current = { ...current, revision: current.revision + 1 };
    },
  };
}

interface OpenInput {
  targets: readonly string[];
  /** Defaults to the whole first target. */
  scope?: TrustedTargetInput;
  limits?: Partial<NetworkFetchLimits>;
  protectedPorts?: readonly number[];
  lookup?: (hostname: string) => Promise<ResolvedTunnelAddress[]>;
  dial?: TunnelDial;
  localAddresses?: readonly string[];
  ttlMs?: number;
  isAuthorized?: () => boolean;
  tlsCa?: readonly string[];
}

function open(input: OpenInput) {
  const recording = recordingSink();
  const allowlists = allowlistStore(input.targets);
  const session = openNetworkFetchSession({
    allowlists: allowlists.store,
    allowlistRef: { id: "fixtures", revision: 1 },
    scope: input.scope ?? { origin: input.targets[0], pathPrefix: "/" },
    ttlMs: input.ttlMs ?? 60_000,
    limits: input.limits,
    isAuthorized: input.isAuthorized ?? (() => true),
    protectedLocalPorts: () => new Set(input.protectedPorts ?? []),
    localAddresses: () => input.localAddresses ?? [],
    lookup: input.lookup,
    dial: input.dial,
    tlsCa: input.tlsCa ?? null,
    sink: recording.sink,
  });
  recording.attach(session);
  closers.push(async () => session.close());
  return { session, recording, allowlists };
}

function get(requestId: number, url: string, extra: Partial<NetworkFetchRequest> = {}) {
  const request: NetworkFetchRequest = {
    requestId,
    method: "GET",
    url,
    headers: [],
    redirect: "follow",
    body: { kind: "none" },
    ...extra,
  };
  return request;
}

function lookupTable(table: Record<string, string[]>) {
  return async (hostname: string): Promise<ResolvedTunnelAddress[]> =>
    (table[hostname] ?? []).map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
}

/** Writes `total` bytes and resolves `stalled` the first time the socket refuses more. */
function bulkResponder(total: number) {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let markStalled: (writtenBytes: number) => void = () => {};
  const stalled = new Promise<number>((resolve) => {
    markStalled = resolve;
  });
  const handler: http.RequestListener = (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    let written = 0;
    const pump = () => {
      while (written < total) {
        written += chunk.length;
        if (!response.write(chunk)) {
          markStalled(written);
          response.once("drain", pump);
          return;
        }
      }
      response.end();
    };
    pump();
  };
  return { handler, stalled };
}

function heldResponder() {
  let markClosed: () => void = () => {};
  const upstreamClosed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const handler: http.RequestListener = (request, response) => {
    request.socket.once("close", () => markClosed());
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write("data: first\n\n");
  };
  return { handler, upstreamClosed };
}

function settleIo(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function expectSilenceAfter(recording: Recording, requestId: number, count: number) {
  await settleIo();
  await settleIo();
  expect(recording.eventsFor(requestId)).toHaveLength(count);
}

describe("network fetch session", () => {
  it("streams an allowlisted response with filtered headers and no ambient credentials", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const fixture = await serve((request, response) => {
      seen.push(request.headers);
      response.setHeader("Set-Cookie", "sess=1; HttpOnly");
      response.writeHead(200, { "Content-Type": "text/plain", "Alt-Svc": 'h3=":443"' });
      response.end("hello");
    });
    const { session, recording } = open({ targets: [fixture.origin] });

    session.request(
      get(1, `${fixture.origin}/page?q=1#frag`, {
        headers: [
          ["Accept", "text/plain"],
          ["User-Agent", "fixture-agent"],
          ["X-Custom", "1"],
          ["Referer", "http://elsewhere.test/"],
        ],
      }),
    );
    const outcome = await recording.outcome(1);

    expect(outcome.result).toBe("end");
    expect(outcome.body).toBe("hello");
    expect(outcome.head).toMatchObject({
      status: 200,
      url: `${fixture.origin}/page?q=1`,
      redirected: false,
      redirect: null,
      setCookieDropped: 1,
      droppedRequestHeaders: ["x-custom", "referer"],
    });
    const names = (outcome.head?.headers ?? []).map(([name]) => name.toLowerCase());
    expect(names).toContain("content-type");
    expect(names).not.toContain("set-cookie");
    expect(names).not.toContain("alt-svc");
    expect(names).not.toContain("connection");
    expect(seen).toEqual([
      expect.objectContaining({
        host: `127.0.0.1:${fixture.port}`,
        accept: "text/plain",
        "user-agent": "fixture-agent",
        "accept-encoding": "identity",
        connection: "close",
      }),
    ]);
    const forbidden = new Set(["cookie", "authorization", "referer", "origin", "x-custom"]);
    expect(Object.keys(seen[0]).filter((name) => forbidden.has(name))).toEqual([]);
  });

  it("refuses targets outside the exact allowlist without connecting", async () => {
    const fixture = await serve((_request, response) => response.end("ok"));
    const { session, recording } = open({
      targets: [`http://localhost:${fixture.port}`],
    });

    session.request(get(1, `http://127.0.0.1:${fixture.port}/`));
    session.request(get(2, `http://app.localhost:${fixture.port}/`));
    session.request(get(3, `http://localhost:${fixture.port + 1}/`));
    session.request(get(4, `http://localhost:${fixture.port}/`));

    expect((await recording.outcome(1)).result).toBe("not_allowlisted");
    expect((await recording.outcome(2)).result).toBe("not_allowlisted");
    expect((await recording.outcome(3)).result).toBe("not_allowlisted");
    expect(await recording.outcome(4)).toMatchObject({ result: "end", body: "ok" });
    expect(fixture.connections()).toBe(1);
  });

  it("rejects Cookie and Authorization explicitly instead of forwarding them", async () => {
    const fixture = await serve((_request, response) => response.end("ok"));
    const { session, recording } = open({ targets: [fixture.origin] });

    session.request(get(1, `${fixture.origin}/`, { headers: [["Cookie", "sess=1"]] }));
    session.request(get(2, `${fixture.origin}/`, { headers: [["Authorization", "Bearer x"]] }));

    expect((await recording.outcome(1)).result).toBe("credentials_unsupported");
    expect((await recording.outcome(2)).result).toBe("credentials_unsupported");
    expect(fixture.connections()).toBe(0);
  });

  it("sends the scope's destination origin as Origin whatever the request claims", async () => {
    const seen: string[] = [];
    const fixture = await serve((request, response) => {
      seen.push(`${request.method} ${request.url} ${request.headers.origin ?? "-"}`);
      response.end("ok");
    });
    const { session, recording } = open({
      targets: [fixture.origin],
      scope: { origin: fixture.origin, pathPrefix: "/app/" },
    });
    const forged: [string, string][] = [
      ["Origin", "http://content-origin.test"],
      ["X-Paseo-Generation", "99"],
    ];

    session.request(get(1, `${fixture.origin}/app/item`, { method: "POST", headers: forged }));
    session.request(get(2, `${fixture.origin}/admin`, { method: "POST", headers: forged }));
    session.request(get(3, "http://content-origin.test/app/item", { method: "POST" }));

    expect((await recording.outcome(1)).result).toBe("end");
    expect((await recording.outcome(2)).result).toBe("not_allowlisted");
    expect((await recording.outcome(3)).result).toBe("not_allowlisted");
    expect(seen).toEqual([`POST /app/item ${fixture.origin}`]);
  });

  it("holds the response to the granted credit and pushes backpressure upstream", async () => {
    const total = 32 * 1024 * 1024;
    const bulk = bulkResponder(total);
    const fixture = await serve(bulk.handler);
    const window = 64 * 1024;
    const { session, recording } = open({
      targets: [fixture.origin],
      limits: { initialWindowBytes: window, maxChunkBytes: 16 * 1024 },
    });
    recording.setAutoCredit(false);

    session.request(get(1, `${fixture.origin}/bulk`));
    const writtenAtStall = await bulk.stalled;
    await recording.until(() => recording.deliveredBytes(1) === window);
    await settleIo();

    expect(writtenAtStall).toBeLessThan(total);
    expect(recording.deliveredBytes(1)).toBe(window);
    const chunkSizes = recording
      .eventsFor(1)
      .flatMap((event) => (event.type === "body" ? [event.chunk.length] : []));
    expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(16 * 1024);

    recording.setAutoCredit(true);
    session.grantCredit(1, window);
    const outcome = await recording.outcome(1);
    expect(outcome).toMatchObject({ result: "end", bodyBytes: total });
  });

  it("returns upload credit only after the upstream socket accepted the bytes", async () => {
    const fixture = await serve((request, response) => {
      const hash = createHash("sha256");
      let bytes = 0;
      request.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        hash.update(chunk);
      });
      request.on("end", () => response.end(JSON.stringify({ bytes, sha: hash.digest("hex") })));
    });
    const window = 64 * 1024;
    const chunkSize = 16 * 1024;
    const { session, recording } = open({
      targets: [fixture.origin],
      limits: { initialWindowBytes: window, maxChunkBytes: chunkSize },
    });
    const payload = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
    let available = window;
    let offset = 0;
    let lowestAvailable = window;
    const pump = () => {
      while (offset < payload.length && available >= chunkSize) {
        session.writeBody(1, payload.subarray(offset, offset + chunkSize));
        available -= chunkSize;
        offset += chunkSize;
        lowestAvailable = Math.min(lowestAvailable, available);
      }
      if (offset === payload.length) {
        offset += 1;
        session.endBody(1);
      }
    };
    recording.onEvent((event) => {
      if (event.type !== "uploadCredit") return;
      available += event.bytes;
      pump();
    });

    session.request(
      get(1, `${fixture.origin}/upload`, {
        method: "POST",
        body: { kind: "stream", length: null },
      }),
    );
    pump();
    const outcome = await recording.outcome(1);

    expect(outcome.result).toBe("end");
    expect(JSON.parse(outcome.body)).toEqual({
      bytes: payload.length,
      sha: createHash("sha256").update(payload).digest("hex"),
    });
    expect(lowestAvailable).toBe(0);
  });

  it("fails a request whose body outruns the upload credit", async () => {
    const fixture = await serve((request, response) => {
      request.resume();
      request.on("end", () => response.end("ok"));
    });
    const window = 32 * 1024;
    const { session, recording } = open({
      targets: [fixture.origin],
      limits: { initialWindowBytes: window, maxChunkBytes: 16 * 1024 },
    });

    session.request(
      get(1, `${fixture.origin}/`, { method: "PUT", body: { kind: "stream", length: null } }),
    );
    session.writeBody(1, Buffer.alloc(16 * 1024));
    session.writeBody(1, Buffer.alloc(16 * 1024));
    session.writeBody(1, Buffer.alloc(1));

    expect((await recording.outcome(1)).result).toBe("credit_exceeded");
  });

  it("closes the upstream connection on cancel and emits nothing afterwards", async () => {
    const held = heldResponder();
    const fixture = await serve(held.handler);
    const { session, recording } = open({ targets: [fixture.origin] });

    session.request(get(1, `${fixture.origin}/events`));
    await recording.until(() => recording.deliveredBytes(1) > 0);
    const count = recording.eventsFor(1).length;
    session.cancel(1);
    await held.upstreamClosed;

    await expectSilenceAfter(recording, 1, count);
    expect(session.activeRequests).toBe(0);
    session.grantCredit(1, 1);
  });

  it("announces revocation first, stops every stream, and refuses later calls", async () => {
    const first = heldResponder();
    const second = heldResponder();
    const fixture = await serve((request, response) =>
      (request.url === "/first" ? first : second).handler(request, response),
    );
    const { session, recording } = open({ targets: [fixture.origin] });

    session.request(get(1, `${fixture.origin}/first`));
    session.request(get(2, `${fixture.origin}/second`));
    await recording.until(() => recording.deliveredBytes(1) > 0 && recording.deliveredBytes(2) > 0);
    const before = recording.events.length;
    session.revoke();
    await Promise.all([first.upstreamClosed, second.upstreamClosed]);
    await settleIo();

    expect(recording.events.slice(before)).toEqual([{ type: "closed", reason: "revoked" }]);
    expect(() => session.request(get(3, `${fixture.origin}/`))).toThrow(
      expect.objectContaining({ violation: "session_closed" }),
    );
    expect(() => session.grantCredit(1, 1)).toThrow(NetworkFetchProtocolError);
  });

  it("revokes on the next operation once the session loses its authority", async () => {
    let authorized = true;
    const held = heldResponder();
    const fixture = await serve(held.handler);
    const { session, recording } = open({
      targets: [fixture.origin],
      isAuthorized: () => authorized,
    });
    recording.setAutoCredit(false);

    session.request(get(1, `${fixture.origin}/`));
    await recording.until(() => recording.deliveredBytes(1) > 0);
    authorized = false;

    expect(() => session.grantCredit(1, recording.deliveredBytes(1))).toThrow(
      expect.objectContaining({ violation: "session_closed" }),
    );
    await held.upstreamClosed;
    expect(recording.closedReasons()).toEqual(["revoked"]);
  });

  it("closes when the trusted allowlist revision changes", async () => {
    const fixture = await serve((_request, response) => response.end("ok"));
    const { session, recording, allowlists } = open({ targets: [fixture.origin] });

    allowlists.bumpRevision();

    expect(() => session.request(get(1, `${fixture.origin}/`))).toThrow(NetworkFetchProtocolError);
    expect(recording.closedReasons()).toEqual(["allowlist_changed"]);
    expect(fixture.connections()).toBe(0);
  });

  it("refuses to open without authority, for an unknown allowlist, or a stale revision", () => {
    const allowlists = allowlistStore(["http://fixture.test"]);
    const base = {
      allowlists: allowlists.store,
      scope: { origin: "http://fixture.test", pathPrefix: "/" },
      ttlMs: 1000,
      isAuthorized: () => true,
      protectedLocalPorts: () => new Set<number>(),
      sink: recordingSink().sink,
    };
    const failure = (options: Parameters<typeof openNetworkFetchSession>[0]) => {
      try {
        openNetworkFetchSession(options).close();
        return "opened";
      } catch (error) {
        if (error instanceof NetworkFetchOpenError) return error.code;
        throw error;
      }
    };

    expect(
      failure({
        ...base,
        isAuthorized: () => false,
        allowlistRef: { id: "fixtures", revision: 1 },
      }),
    ).toBe("permission_denied");
    expect(failure({ ...base, allowlistRef: { id: "other", revision: 1 } })).toBe(
      "allowlist_not_found",
    );
    allowlists.bumpRevision();
    expect(failure({ ...base, allowlistRef: { id: "fixtures", revision: 1 } })).toBe(
      "revision_conflict",
    );
    expect(failure({ ...base, allowlistRef: { id: "fixtures", revision: 2 } })).toBe("opened");
  });

  describe("configuration", () => {
    const store = {
      get: (id: string): TrustedAllowlist | null =>
        id === "fixtures"
          ? {
              id,
              revision: 1,
              targets: [parseTrustedTarget({ origin: "http://fixture.test", pathPrefix: "/app/" })],
            }
          : null,
    };
    const base: Parameters<typeof openNetworkFetchSession>[0] = {
      allowlists: store,
      allowlistRef: { id: "fixtures", revision: 1 },
      scope: { origin: "http://fixture.test", pathPrefix: "/app/" },
      ttlMs: 1000,
      isAuthorized: () => true,
      protectedLocalPorts: () => new Set<number>(),
      sink: recordingSink().sink,
    };
    function openOutcome(overrides: Partial<Parameters<typeof openNetworkFetchSession>[0]>) {
      try {
        openNetworkFetchSession({ ...base, ...overrides }).close();
        return "opened";
      } catch (error) {
        if (error instanceof NetworkFetchOpenError) return error.code;
        throw error;
      }
    }

    const invalid: [string, Partial<Parameters<typeof openNetworkFetchSession>[0]>][] = [
      ["a NaN window", { limits: { initialWindowBytes: Number.NaN } }],
      ["an infinite connect timeout", { limits: { connectTimeoutMs: Number.POSITIVE_INFINITY } }],
      ["a negative body limit", { limits: { maxResponseBodyBytes: -1 } }],
      ["a fractional chunk", { limits: { maxChunkBytes: 1.5 } }],
      ["a zero window", { limits: { initialWindowBytes: 0 } }],
      ["zero concurrency", { limits: { maxConcurrentRequests: 0 } }],
      ["a zero head timeout", { limits: { responseHeadTimeoutMs: 0 } }],
      ["a window smaller than the chunk", { limits: { initialWindowBytes: 1024 } }],
      ["a zero TTL", { ttlMs: 0 }],
      ["a fractional TTL", { ttlMs: 1.5 }],
      ["a TTL past the timer ceiling", { ttlMs: 2 ** 31 }],
      [
        "a scope with a path in its origin",
        { scope: { origin: "http://fixture.test/app", pathPrefix: "/" } },
      ],
    ];

    it.each(invalid)("rejects %s before creating timers or sockets", (_case, overrides) => {
      expect(openOutcome(overrides)).toBe("invalid_configuration");
    });

    it("accepts zero body and redirect limits and a window that equals the chunk", () => {
      expect(
        openOutcome({
          limits: {
            maxRequestBodyBytes: 0,
            maxResponseBodyBytes: 0,
            maxRedirects: 0,
            initialWindowBytes: 512,
            maxChunkBytes: 512,
          },
        }),
      ).toBe("opened");
    });

    it("lets a scope narrow an allowlist entry but never widen it", () => {
      expect(openOutcome({ scope: { origin: "http://fixture.test", pathPrefix: "/app/x/" } })).toBe(
        "opened",
      );
      for (const scope of [
        { origin: "http://fixture.test", pathPrefix: "/" },
        { origin: "http://fixture.test", pathPrefix: "/application/" },
        { origin: "http://other.test", pathPrefix: "/app/" },
        { origin: "http://fixture.test:8080", pathPrefix: "/app/" },
      ]) {
        expect(openOutcome({ scope })).toBe("scope_not_allowlisted");
      }
    });
  });

  it("finishes a large response through a small valid window", async () => {
    const fixture = await serve((_request, response) => response.end(Buffer.alloc(64 * 1024, 1)));
    const { session, recording } = open({
      targets: [fixture.origin],
      limits: { initialWindowBytes: 1024, maxChunkBytes: 512 },
    });

    session.request(get(1, `${fixture.origin}/`));
    const outcome = await recording.outcome(1);

    expect(outcome).toMatchObject({ result: "end", bodyBytes: 64 * 1024 });
    const sizes = recording
      .eventsFor(1)
      .flatMap((event) => (event.type === "body" ? [event.chunk.length] : []));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(512);
  });

  it("applies reduced body and redirect limits", async () => {
    const fixture = await serve((request, response) => {
      request.resume();
      if (request.url === "/redirect") response.writeHead(302, { Location: "/next" }).end();
      else if (request.url === "/empty") response.writeHead(204).end();
      else response.end("x");
    });
    const { session, recording } = open({
      targets: [fixture.origin],
      limits: { maxRequestBodyBytes: 10, maxResponseBodyBytes: 0, maxRedirects: 0 },
    });

    session.request(get(1, `${fixture.origin}/redirect`));
    session.request(get(2, `${fixture.origin}/empty`));
    session.request(get(3, `${fixture.origin}/full`));
    session.request(
      get(4, `${fixture.origin}/upload`, { method: "POST", body: { kind: "stream", length: 11 } }),
    );
    session.request(
      get(5, `${fixture.origin}/upload`, {
        method: "POST",
        body: { kind: "stream", length: null },
      }),
    );
    session.writeBody(5, Buffer.alloc(11));

    expect((await recording.outcome(1)).result).toBe("redirect_limit");
    expect(await recording.outcome(2)).toMatchObject({ result: "end", bodyBytes: 0 });
    expect((await recording.outcome(3)).result).toBe("response_body_too_large");
    expect((await recording.outcome(4)).result).toBe("request_body_too_large");
    expect((await recording.outcome(5)).result).toBe("request_body_too_large");
  });

  describe("lapses while work is pending", () => {
    function pendingLookup() {
      let answer: (addresses: ResolvedTunnelAddress[]) => void = () => {};
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const lookup = () =>
        new Promise<ResolvedTunnelAddress[]>((resolve) => {
          answer = resolve;
          markStarted();
        });
      return { lookup, started, answer: (addresses: ResolvedTunnelAddress[]) => answer(addresses) };
    }

    function recordingDial() {
      const attempts: string[] = [];
      const dial: TunnelDial = ({ address, port }) => {
        attempts.push(`${address.address}:${port}`);
        return new Promise((resolve, reject) => {
          const socket = net.connect({ host: address.address, port });
          socket.once("connect", () => resolve(socket));
          socket.once("error", reject);
        });
      };
      return { dial, attempts };
    }

    function heldServer() {
      let held: http.ServerResponse | null = null;
      let markClosed: () => void = () => {};
      const upstreamClosed = new Promise<void>((resolve) => {
        markClosed = resolve;
      });
      let markArrived: () => void = () => {};
      const arrived = new Promise<void>((resolve) => {
        markArrived = resolve;
      });
      const handler: http.RequestListener = (request, response) => {
        request.socket.once("close", () => markClosed());
        held = response;
        markArrived();
      };
      function release(): void {
        if (held && !held.destroyed) held.end("late");
      }
      return { handler, arrived, upstreamClosed, release };
    }

    it.each([
      ["an explicit revoke", "revoked"],
      ["a lapsed authority with no revoke call", "revoked"],
      ["a changed allowlist revision", "allowlist_changed"],
    ])("opens no connection after %s during DNS resolution", async (cause, reason) => {
      let authorized = true;
      const dns = pendingLookup();
      const dialer = recordingDial();
      const fixture = await serve((_request, response) => response.end("late"));
      const origin = `http://slow-dns.test:${fixture.port}`;
      const { session, recording, allowlists } = open({
        targets: [origin],
        lookup: dns.lookup,
        dial: dialer.dial,
        isAuthorized: () => authorized,
      });

      session.request(get(1, `${origin}/`));
      await dns.started;
      if (cause === "an explicit revoke") session.revoke();
      if (cause === "a lapsed authority with no revoke call") authorized = false;
      if (cause === "a changed allowlist revision") allowlists.bumpRevision();
      dns.answer([{ address: "127.0.0.1", family: 4 }]);
      await recording.until(() => recording.closedReasons().length > 0);
      await settleIo();

      expect(recording.events).toEqual([{ type: "closed", reason }]);
      expect(dialer.attempts).toEqual([]);
      expect(fixture.connections()).toBe(0);
    });

    it("stops a pending TLS handshake on revoke", async () => {
      let markConnected: () => void = () => {};
      const connected = new Promise<void>((resolve) => {
        markConnected = resolve;
      });
      let markClosed: () => void = () => {};
      const closed = new Promise<void>((resolve) => {
        markClosed = resolve;
      });
      const silent = net.createServer((socket) => {
        socket.once("close", () => markClosed());
        markConnected();
      });
      await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
      closers.push(() => new Promise<void>((resolve) => silent.close(() => resolve())));
      const address = silent.address();
      if (typeof address !== "object" || address === null) throw new Error("No port");
      const origin = `https://127.0.0.1:${address.port}`;
      const { session, recording } = open({ targets: [origin] });

      session.request(get(1, `${origin}/`));
      await connected;
      session.revoke();
      await closed;
      await settleIo();

      expect(recording.events).toEqual([{ type: "closed", reason: "revoked" }]);
    });

    it("stops a request waiting for headers on revoke", async () => {
      const held = heldServer();
      const fixture = await serve(held.handler);
      const { session, recording } = open({ targets: [fixture.origin] });

      session.request(get(1, `${fixture.origin}/`));
      await held.arrived;
      session.revoke();
      await held.upstreamClosed;
      held.release();
      await settleIo();

      expect(recording.events).toEqual([{ type: "closed", reason: "revoked" }]);
    });

    it("drops headers that resolve after the revision changed, with no frame in between", async () => {
      const held = heldServer();
      const fixture = await serve(held.handler);
      const { session, recording, allowlists } = open({ targets: [fixture.origin] });

      session.request(get(1, `${fixture.origin}/`));
      await held.arrived;
      allowlists.bumpRevision();
      held.release();
      await recording.until(() => recording.closedReasons().length > 0);
      await held.upstreamClosed;

      expect(recording.events).toEqual([{ type: "closed", reason: "allowlist_changed" }]);
    });

    it("expires a session whose body is paused for credit", async () => {
      const held = heldResponder();
      const fixture = await serve(held.handler);
      const { session, recording } = open({ targets: [fixture.origin], ttlMs: 300 });
      recording.setAutoCredit(false);

      session.request(get(1, `${fixture.origin}/`));
      await recording.until(() => recording.deliveredBytes(1) > 0);
      const count = recording.eventsFor(1).length;
      await held.upstreamClosed;

      expect(recording.closedReasons()).toEqual(["expired"]);
      expect(recording.eventsFor(1)).toHaveLength(count);
    });
  });

  it("expires at its TTL", async () => {
    const { session, recording } = open({ targets: ["http://fixture.test"], ttlMs: 20 });

    await recording.until(() => recording.closedReasons().length > 0);

    expect(recording.closedReasons()).toEqual(["expired"]);
    expect(session.isOpen).toBe(false);
  });

  it("rejects a replayed request id without repeating its effect", async () => {
    let effects = 0;
    const fixture = await serve((_request, response) => {
      effects += 1;
      response.end(String(effects));
    });
    const { session, recording } = open({ targets: [fixture.origin] });
    const post = get(5, `${fixture.origin}/effect`, { method: "POST" });

    session.request(post);
    expect(() => session.request(post)).toThrow(expect.objectContaining({ violation: "replayed" }));
    expect(() => session.request({ ...post, requestId: 4 })).toThrow(
      expect.objectContaining({ violation: "replayed" }),
    );
    const outcome = await recording.outcome(5);

    expect(outcome).toMatchObject({ result: "end", body: "1" });
    expect(effects).toBe(1);
    expect(() => session.writeBody(9, Buffer.from("x"))).toThrow(
      expect.objectContaining({ violation: "unknown_request" }),
    );
  });

  it("limits concurrent requests without disturbing the ones in flight", async () => {
    const held = heldResponder();
    const fixture = await serve(held.handler);
    const { session, recording } = open({
      targets: [fixture.origin],
      limits: { maxConcurrentRequests: 1 },
    });

    session.request(get(1, `${fixture.origin}/`));
    session.request(get(2, `${fixture.origin}/`));

    expect((await recording.outcome(2)).result).toBe("stream_limit");
    await recording.until(() => recording.deliveredBytes(1) > 0);
    expect(session.activeRequests).toBe(1);
  });

  it("denies the daemon's own listeners through every spelling of this host", async () => {
    const fixture = await serve((_request, response) => response.end("control plane"));
    const targets = [
      `http://127.0.0.1:${fixture.port}`,
      `http://localhost:${fixture.port}`,
      `http://[::ffff:127.0.0.1]:${fixture.port}`,
      `http://lan-name.test:${fixture.port}`,
    ];
    for (const origin of targets) {
      const { session, recording } = open({
        targets: [origin],
        protectedPorts: [fixture.port],
        lookup: lookupTable({ "lan-name.test": ["192.0.2.10"] }),
        localAddresses: ["192.0.2.10"],
      });
      session.request(get(1, `${origin}/api/health`));
      expect((await recording.outcome(1)).result).toBe("self_target_denied");
    }
    expect(fixture.connections()).toBe(0);
  });

  it("applies the host target policy to names and reports dial failures by code", async () => {
    const closed = await serve((_request, response) => response.end());
    const closedPort = closed.port;
    await closers.pop()?.();
    const cases: [string, string][] = [
      ["http://mixed.test", "policy_denied"],
      ["http://missing.test", "host_not_found"],
      [`http://127.0.0.1:${closedPort}`, "connection_refused"],
    ];
    for (const [origin, expected] of cases) {
      const { session, recording } = open({
        targets: [origin],
        lookup: lookupTable({ "mixed.test": ["127.0.0.1", "169.254.169.254"] }),
      });
      session.request(get(1, `${origin}/`));
      expect((await recording.outcome(1)).result).toBe(expected);
    }
  });

  describe("redirects", () => {
    async function redirectFixture(
      routes: Record<string, (response: http.ServerResponse) => void>,
    ) {
      const log: string[] = [];
      let effects = 0;
      const fixture = await serve((request, response) => {
        log.push(`${request.method} ${request.url} ${request.headers["content-type"] ?? "-"}`);
        if (request.method === "POST") effects += 1;
        request.resume();
        request.on("end", () => {
          const route = routes[request.url ?? ""];
          if (route) route(response);
          else response.writeHead(404).end();
        });
      });
      return { fixture, log, effects: () => effects };
    }

    function redirectTo(status: number, location: string) {
      return (response: http.ServerResponse) =>
        response.writeHead(status, { Location: location }).end();
    }

    it("follows relative hops inside the scope's path and reports the final URL", async () => {
      const { fixture, log } = await redirectFixture({
        "/app/start": redirectTo(302, "middle"),
        "/app/middle": redirectTo(301, "/app/final"),
        "/app/final": (response) => response.end("done"),
      });
      const { session, recording } = open({
        targets: [fixture.origin],
        scope: { origin: fixture.origin, pathPrefix: "/app/" },
      });

      session.request(get(1, `${fixture.origin}/app/start`));
      const outcome = await recording.outcome(1);

      expect(outcome).toMatchObject({ result: "end", body: "done" });
      expect(outcome.head).toMatchObject({
        status: 200,
        url: `${fixture.origin}/app/final`,
        redirected: true,
      });
      expect(log).toEqual(["GET /app/start -", "GET /app/middle -", "GET /app/final -"]);
    });

    it("never connects to an allowlisted origin the page's scope does not grant", async () => {
      const other = await serve((_request, response) => response.end("other destination"));
      const { fixture, log } = await redirectFixture({
        "/app/cross": redirectTo(302, `${other.origin}/`),
        "/app/up": redirectTo(302, "../admin"),
      });
      const { session, recording } = open({
        targets: [fixture.origin, other.origin],
        scope: { origin: fixture.origin, pathPrefix: "/app/" },
      });

      session.request(get(1, `${fixture.origin}/app/cross`));
      session.request(get(2, `${fixture.origin}/app/up`));
      session.request(get(3, `${fixture.origin}/app/cross`, { redirect: "manual" }));
      session.request(get(4, `${fixture.origin}/app/up`, { redirect: "manual" }));

      expect((await recording.outcome(1)).result).toBe("redirect_not_allowlisted");
      expect((await recording.outcome(2)).result).toBe("redirect_not_allowlisted");
      expect((await recording.outcome(3)).head?.redirect).toEqual({
        location: `${other.origin}/`,
        allowed: false,
      });
      expect((await recording.outcome(4)).head?.redirect).toEqual({
        location: `${fixture.origin}/admin`,
        allowed: false,
      });
      expect(other.connections()).toBe(0);
      expect(log.filter((line) => line.includes("/admin"))).toEqual([]);
    });

    it("re-resolves and re-applies the dial policy on every hop", async () => {
      const answers = [["127.0.0.1"], ["169.254.169.254"]];
      const { fixture } = await redirectFixture({ "/start": redirectTo(302, "/next") });
      const origin = `http://rebind.test:${fixture.port}`;
      const { session, recording } = open({
        targets: [origin],
        lookup: async () =>
          (answers.shift() ?? []).map((address) => ({ address, family: 4 as const })),
      });

      session.request(get(1, `${origin}/start`));

      expect((await recording.outcome(1)).result).toBe("policy_denied");
      expect(answers).toEqual([]);
    });

    it("stops a redirect loop at the redirect limit", async () => {
      const { fixture, log } = await redirectFixture({ "/loop": redirectTo(302, "/loop") });
      const { session, recording } = open({
        targets: [fixture.origin],
        limits: { maxRedirects: 3 },
      });

      session.request(get(1, `${fixture.origin}/loop`));

      expect((await recording.outcome(1)).result).toBe("redirect_limit");
      expect(log).toHaveLength(4);
    });

    it("turns a POST answered by 303 into one GET without the body headers", async () => {
      const { fixture, log, effects } = await redirectFixture({
        "/submit": redirectTo(303, "/done"),
        "/done": (response) => response.end("thanks"),
      });
      const { session, recording } = open({ targets: [fixture.origin] });

      session.request(
        get(1, `${fixture.origin}/submit`, {
          method: "POST",
          headers: [["Content-Type", "application/x-www-form-urlencoded"]],
          body: { kind: "stream", length: 3 },
        }),
      );
      session.writeBody(1, Buffer.from("a=1"));
      session.endBody(1);
      const outcome = await recording.outcome(1);

      expect(outcome).toMatchObject({ result: "end", body: "thanks" });
      expect(log).toEqual(["POST /submit application/x-www-form-urlencoded", "GET /done -"]);
      expect(effects()).toBe(1);
    });

    it("refuses to replay a streamed body on 307", async () => {
      const { fixture, effects } = await redirectFixture({
        "/submit": redirectTo(307, "/again"),
        "/again": (response) => response.end("replayed"),
      });
      const { session, recording } = open({ targets: [fixture.origin] });

      session.request(
        get(1, `${fixture.origin}/submit`, {
          method: "POST",
          body: { kind: "stream", length: 3 },
        }),
      );
      session.writeBody(1, Buffer.from("a=1"));
      session.endBody(1);

      expect((await recording.outcome(1)).result).toBe("redirect_body_unreplayable");
      expect(effects()).toBe(1);
    });

    it("returns the redirect in manual mode with whether the session may follow it", async () => {
      const { fixture } = await redirectFixture({
        "/inside": redirectTo(302, "/final"),
        "/outside": redirectTo(302, "http://elsewhere.test/"),
      });
      const { session, recording } = open({ targets: [fixture.origin] });

      session.request(get(1, `${fixture.origin}/inside`, { redirect: "manual" }));
      session.request(get(2, `${fixture.origin}/outside`, { redirect: "manual" }));
      session.request(get(3, `${fixture.origin}/inside`, { redirect: "error" }));

      expect((await recording.outcome(1)).head).toMatchObject({
        status: 302,
        redirect: { location: `${fixture.origin}/final`, allowed: true },
      });
      expect((await recording.outcome(2)).head).toMatchObject({
        status: 302,
        redirect: { location: "http://elsewhere.test/", allowed: false },
      });
      expect((await recording.outcome(3)).result).toBe("redirect_error_mode");
    });
  });

  it("starts the response head timeout after the upload finished", async () => {
    const fixture = await serve((request, response) => {
      request.resume();
      request.on("end", () => {
        if (request.url === "/answer") response.end("ok");
      });
    });
    const { session, recording } = open({
      targets: [fixture.origin],
      limits: { responseHeadTimeoutMs: 200 },
    });
    const upload = { method: "POST", body: { kind: "stream", length: 2 } } as const;

    session.request(get(1, `${fixture.origin}/answer`, upload));
    session.request(get(2, `${fixture.origin}/silent`, upload));
    session.writeBody(1, Buffer.from("a"));
    session.writeBody(2, Buffer.from("a"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    for (const requestId of [1, 2]) {
      session.writeBody(requestId, Buffer.from("b"));
      session.endBody(requestId);
    }

    expect(await recording.outcome(1)).toMatchObject({ result: "end", body: "ok" });
    expect((await recording.outcome(2)).result).toBe("timeout");
  });

  it("enforces response size limits as failures, never as a short success", async () => {
    const fixture = await serve((request, response) => {
      if (request.url === "/big-head") {
        response.writeHead(200, { "X-Big": "x".repeat(8 * 1024) }).end();
        return;
      }
      response.end(Buffer.alloc(4096));
    });
    const { session, recording } = open({
      targets: [fixture.origin],
      limits: { maxResponseBodyBytes: 1024, maxResponseHeadBytes: 4096 },
    });

    session.request(get(1, `${fixture.origin}/big-body`));
    session.request(get(2, `${fixture.origin}/big-head`));

    expect((await recording.outcome(1)).result).toBe("response_body_too_large");
    expect((await recording.outcome(2)).result).toBe("response_head_too_large");
  });

  it("fails a response the upstream cut short", async () => {
    const fixture = await serve((_request, response) => {
      response.writeHead(200, { "Content-Length": "100" });
      response.write("partial", () => response.socket?.destroy());
    });
    const { session, recording } = open({ targets: [fixture.origin] });

    session.request(get(1, `${fixture.origin}/`));
    const outcome = await recording.outcome(1);

    expect(outcome.result).toBe("upstream_error");
    expect(recording.eventsFor(1).some((event) => event.type === "end")).toBe(false);
  });

  it("decodes a compressed response the server sent despite identity", async () => {
    const fixture = await serve((request, response) => {
      if (request.url === "/gzip") {
        response.writeHead(200, { "Content-Encoding": "gzip" });
        response.end(gzipSync("compressed body"));
        return;
      }
      response.writeHead(200, { "Content-Encoding": "compress" }).end("x");
    });
    const { session, recording } = open({ targets: [fixture.origin] });

    session.request(get(1, `${fixture.origin}/gzip`));
    session.request(get(2, `${fixture.origin}/compress`));
    const outcome = await recording.outcome(1);

    expect(outcome).toMatchObject({ result: "end", body: "compressed body" });
    const names = (outcome.head?.headers ?? []).map(([name]) => name.toLowerCase());
    expect(names).not.toContain("content-encoding");
    expect((await recording.outcome(2)).result).toBe("unsupported_encoding");
  });
});

/** Lookups that stay pending until the test answers them, with a barrier on how many started. */
function gatedLookup() {
  const answers: Array<(addresses: ResolvedTunnelAddress[]) => void> = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  let started = 0;
  const lookup = () =>
    new Promise<ResolvedTunnelAddress[]>((resolve) => {
      answers.push(resolve);
      started += 1;
      for (const waiter of waiters.splice(0)) {
        if (started >= waiter.count) waiter.resolve();
        else waiters.push(waiter);
      }
    });
  return {
    lookup,
    /** Lookups ever started, answered or not. */
    get started(): number {
      return started;
    },
    untilStarted(count: number): Promise<void> {
      if (started >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ count, resolve }));
    },
    answerAll(address: string): void {
      for (const answer of answers.splice(0)) answer([{ address, family: 4 }]);
    },
  };
}

/** Dials that stay pending until the test connects them; optionally deaf to the abort signal. */
function gatedDial(mode: "honours-abort" | "ignores-abort") {
  interface Pending {
    input: TunnelDialInput;
    resolve: (socket: net.Socket) => void;
    reject: (error: unknown) => void;
  }
  const pending: Pending[] = [];
  const aborted: string[] = [];
  const sockets: net.Socket[] = [];
  let calls = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const dial: TunnelDial = (input) =>
    new Promise((resolve, reject) => {
      calls += 1;
      const entry: Pending = { input, resolve, reject };
      pending.push(entry);
      if (mode === "honours-abort") {
        input.signal.addEventListener(
          "abort",
          () => {
            aborted.push(`${input.address.address}:${input.port}`);
            pending.splice(pending.indexOf(entry), 1);
            reject(new Error("dial aborted by the test port"));
          },
          { once: true },
        );
      }
      for (const waiter of waiters.splice(0)) {
        if (calls >= waiter.count) waiter.resolve();
        else waiters.push(waiter);
      }
    });
  return {
    dial,
    aborted,
    sockets,
    get calls(): number {
      return calls;
    },
    untilCalled(count: number): Promise<void> {
      if (calls >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ count, resolve }));
    },
    /** Hands every pending dial a real connected socket, to `port` when given, else to the asked port. */
    async connectAll(port?: number): Promise<void> {
      for (const entry of pending.splice(0)) {
        const socket = net.connect({
          host: entry.input.address.address,
          port: port ?? entry.input.port,
        });
        sockets.push(socket);
        await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
        entry.resolve(socket);
      }
    },
  };
}

async function listenSilent(onData: () => void): Promise<{ port: number; closed: Promise<void> }> {
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const silent = net.createServer((socket) => {
    socket.once("data", onData);
    socket.once("close", () => markClosed());
  });
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => silent.close(() => resolve())));
  const address = silent.address();
  if (typeof address !== "object" || address === null) throw new Error("No port");
  return { port: address.port, closed };
}

describe("network fetch session: cancel, credit guards, and late frames", () => {
  it("refuses credit beyond the bytes delivered and keeps the exchange usable (T-B1)", async () => {
    const fixture = await serve((_request, response) => response.end(Buffer.alloc(4096, 0x62)));
    const { session, recording } = open({
      targets: [fixture.origin],
      limits: { initialWindowBytes: 1024, maxChunkBytes: 256 },
    });
    recording.setAutoCredit(false);

    session.request(get(1, `${fixture.origin}/`));
    await recording.until(() => recording.deliveredBytes(1) === 1024);
    const delivered = recording.eventsFor(1).length;

    for (const bytes of [1025, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => session.grantCredit(1, bytes)).toThrow(
        expect.objectContaining({ violation: "credit_overflow" }),
      );
    }
    await expectSilenceAfter(recording, 1, delivered);
    expect(session.activeRequests).toBe(1);

    recording.setAutoCredit(true);
    session.grantCredit(1, 1024);
    expect(await recording.outcome(1)).toMatchObject({ result: "end", bodyBytes: 4096 });
  });

  it("cancels a request during DNS resolution without dialing, and the session goes on (T-D1)", async () => {
    const dns = gatedLookup();
    const dialer = gatedDial("honours-abort");
    let hits = 0;
    const fixture = await serve((_request, response) => {
      hits += 1;
      response.end("late");
    });
    const origin = `http://cancel-dns.test:${fixture.port}`;
    const { session, recording } = open({
      targets: [origin],
      lookup: dns.lookup,
      dial: dialer.dial,
    });

    session.request(get(1, `${origin}/`));
    await dns.untilStarted(1);
    session.cancel(1);
    expect(session.activeRequests).toBe(0);
    dns.answerAll("127.0.0.1");
    await expectSilenceAfter(recording, 1, 0);
    expect(dialer.calls).toBe(0);
    expect(session.isOpen).toBe(true);

    session.request(get(2, `${origin}/`));
    await dns.untilStarted(2);
    dns.answerAll("127.0.0.1");
    await dialer.untilCalled(1);
    await dialer.connectAll();
    expect(await recording.outcome(2)).toMatchObject({ result: "end", body: "late" });
    expect(hits).toBe(1);
    expect(recording.eventsFor(1)).toEqual([]);
  });

  it.each([
    ["honours-abort", 0],
    ["ignores-abort", 1],
  ] as const)(
    "cancels a request while TCP is connecting when the dial port %s (T-D1)",
    async (mode, lateConnections) => {
      const dialer = gatedDial(mode);
      let hits = 0;
      const fixture = await serve((_request, response) => {
        hits += 1;
        response.end("late");
      });
      const { session, recording } = open({ targets: [fixture.origin], dial: dialer.dial });

      session.request(get(1, `${fixture.origin}/`));
      await dialer.untilCalled(1);
      session.cancel(1);
      expect(session.activeRequests).toBe(0);
      if (mode === "honours-abort") expect(dialer.aborted).toEqual([`127.0.0.1:${fixture.port}`]);
      // A port deaf to the signal still hands over a socket; the exchange must destroy it unused.
      await dialer.connectAll();
      await expectSilenceAfter(recording, 1, 0);
      for (const socket of dialer.sockets) {
        if (!socket.closed)
          await new Promise<void>((resolve) => socket.once("close", () => resolve()));
        expect(socket.destroyed).toBe(true);
      }
      expect(fixture.connections()).toBe(lateConnections);
      expect(hits).toBe(0);
      expect(session.isOpen).toBe(true);

      session.request(get(2, `${fixture.origin}/`));
      await dialer.untilCalled(2);
      await dialer.connectAll();
      expect(await recording.outcome(2)).toMatchObject({ result: "end", body: "late" });
      expect(hits).toBe(1);
    },
  );

  it("cancels a request during the TLS handshake and completes the next one (T-D1)", async () => {
    const authority = createSyntheticAuthority();
    const leaf = authority.issue({ commonName: "cancel-tls", ipAddresses: ["127.0.0.1"] });
    const secure = https.createServer(
      { key: leaf.privateKeyPem, cert: leaf.certificatePem },
      (_request, response) => response.end("secure"),
    );
    await new Promise<void>((resolve) => secure.listen(0, "127.0.0.1", resolve));
    closers.push(async () => {
      secure.closeAllConnections();
      await new Promise<void>((resolve) => secure.close(() => resolve()));
    });
    const securePort = (secure.address() as net.AddressInfo).port;
    let markHello: () => void = () => {};
    const clientHello = new Promise<void>((resolve) => {
      markHello = resolve;
    });
    const silent = await listenSilent(() => markHello());
    // First dial lands on a server that never answers the handshake; later dials reach the real one.
    const dialer = gatedDial("honours-abort");
    const origin = `https://127.0.0.1:${securePort}`;
    const { session, recording } = open({
      targets: [origin],
      dial: dialer.dial,
      tlsCa: [authority.certificatePem],
    });

    session.request(get(1, `${origin}/`));
    await dialer.untilCalled(1);
    await dialer.connectAll(silent.port);
    await clientHello;
    session.cancel(1);
    await silent.closed;
    await expectSilenceAfter(recording, 1, 0);
    expect(session.activeRequests).toBe(0);
    expect(session.isOpen).toBe(true);

    session.request(get(2, `${origin}/`));
    await dialer.untilCalled(2);
    await dialer.connectAll();
    expect(await recording.outcome(2)).toMatchObject({ result: "end", body: "secure" });
  });

  it("bounds what a request/cancel loop leaves pending to the shared DNS slots (reserva de concorrência)", async () => {
    const dns = gatedLookup();
    const dialer = gatedDial("honours-abort");
    const fixture = await serve((_request, response) => response.end("late"));
    const origin = `http://pending-loop.test:${fixture.port}`;
    const { session, recording } = open({
      targets: [origin],
      lookup: dns.lookup,
      dial: dialer.dial,
      limits: { maxConcurrentRequests: 1 },
    });
    try {
      for (let requestId = 1; requestId <= 6; requestId += 1) {
        session.request(get(requestId, `${origin}/`));
        if (requestId <= 2) await dns.untilStarted(requestId);
        else await settleIo();
        session.cancel(requestId);
        expect(session.activeRequests).toBe(0);
      }
      // Two resolver calls are in flight (dial-target's global slots); the other four waited for a
      // slot and left the queue when cancelled. Nothing else is pending for the session.
      expect(dns.started).toBe(2);
      dns.answerAll("127.0.0.1");
      await settleIo();
      await settleIo();
      expect(dialer.calls).toBe(0);
      expect(recording.events).toEqual([]);
      expect(session.isOpen).toBe(true);

      session.request(get(7, `${origin}/`));
      await dns.untilStarted(3);
      dns.answerAll("127.0.0.1");
      await dialer.untilCalled(1);
      await dialer.connectAll();
      expect(await recording.outcome(7)).toMatchObject({ result: "end", body: "late" });
    } finally {
      dns.answerAll("127.0.0.1");
    }
  });

  it("refuses body frames a request cannot take, without touching the request (T-B2)", async () => {
    const fixture = await serve((request, response) => {
      request.pipe(response);
    });
    const { session, recording } = open({ targets: [fixture.origin] });

    session.request(get(1, `${fixture.origin}/`));
    expect(() => session.writeBody(1, Buffer.from("x"))).toThrow(
      expect.objectContaining({ violation: "body_not_expected" }),
    );
    expect(() => session.endBody(1)).toThrow(
      expect.objectContaining({ violation: "body_not_expected" }),
    );
    expect(await recording.outcome(1)).toMatchObject({ result: "end" });

    session.request(
      get(2, `${fixture.origin}/`, { method: "POST", body: { kind: "stream", length: 2 } }),
    );
    session.writeBody(2, Buffer.from("ab"));
    session.endBody(2);
    expect(() => session.writeBody(2, Buffer.from("c"))).toThrow(
      expect.objectContaining({ violation: "body_not_expected" }),
    );
    expect(() => session.endBody(2)).toThrow(
      expect.objectContaining({ violation: "body_not_expected" }),
    );
    expect(await recording.outcome(2)).toMatchObject({ result: "end", body: "ab" });
  });

  it("treats an empty body chunk as a no-op instead of crediting zero bytes (T-B3)", async () => {
    const fixture = await serve((request, response) => {
      const hash = createHash("sha256");
      request.on("data", (chunk: Buffer) => hash.update(chunk));
      request.on("end", () => response.end(hash.digest("hex")));
    });
    const { session, recording } = open({ targets: [fixture.origin] });

    session.request(
      get(1, `${fixture.origin}/`, { method: "POST", body: { kind: "stream", length: null } }),
    );
    session.writeBody(1, Buffer.from("ab"));
    session.writeBody(1, new Uint8Array(0));
    session.writeBody(1, Buffer.from("cd"));
    session.endBody(1);

    expect(await recording.outcome(1)).toMatchObject({
      result: "end",
      body: createHash("sha256").update("abcd").digest("hex"),
    });
    const credits = recording
      .eventsFor(1)
      .filter((event) => event.type === "uploadCredit")
      .map((event) => (event.type === "uploadCredit" ? event.bytes : 0));
    expect(credits).toEqual([2, 2]);
  });

  it("emits no upload credit after revocation for bytes the upstream never accepted (T-B4)", async () => {
    const dialer = gatedDial("honours-abort");
    const fixture = await serve((request, response) => request.pipe(response));
    const { session, recording } = open({ targets: [fixture.origin], dial: dialer.dial });

    session.request(
      get(1, `${fixture.origin}/`, { method: "POST", body: { kind: "stream", length: null } }),
    );
    session.writeBody(1, Buffer.alloc(16 * 1024, 1));
    await dialer.untilCalled(1);
    session.revoke();
    await dialer.connectAll();
    await settleIo();
    await settleIo();

    expect(recording.events).toEqual([{ type: "closed", reason: "revoked" }]);
    expect(dialer.aborted).toEqual([`127.0.0.1:${fixture.port}`]);
  });

  it("refuses an oversized request head before connecting (T-L1)", async () => {
    const fixture = await serve((_request, response) => response.end());
    const { session, recording } = open({
      targets: [fixture.origin],
      limits: { maxRequestHeadBytes: 64 },
    });

    session.request(get(1, `${fixture.origin}/`, { headers: [["Accept", "x".repeat(200)]] }));

    expect((await recording.outcome(1)).result).toBe("request_head_too_large");
    expect(fixture.connections()).toBe(0);
  });

  it("fails malformed requests synchronously as invalid_request without connecting (T-S2)", async () => {
    const fixture = await serve((_request, response) => response.end());
    const { session, recording } = open({ targets: [fixture.origin] });
    const unsupported = "TRACE" as NetworkFetchMethod;

    session.request(get(1, `${fixture.origin}/`, { method: unsupported }));
    session.request(
      get(2, `${fixture.origin}/`, { method: "POST", body: { kind: "stream", length: -1 } }),
    );
    session.request(
      get(3, `${fixture.origin}/`, { method: "POST", body: { kind: "stream", length: 1.5 } }),
    );
    session.request(get(4, `${fixture.origin}/`, { body: { kind: "stream", length: 1 } }));
    session.request(get(5, `${fixture.origin}/`, { url: "/relative" }));

    for (const requestId of [1, 2, 3, 4, 5]) {
      expect(recording.eventsFor(requestId)).toEqual([
        { type: "fail", requestId, failure: expect.objectContaining({ code: "invalid_request" }) },
      ]);
    }
    expect(fixture.connections()).toBe(0);
    expect(session.activeRequests).toBe(0);
  });

  it("completes HEAD without a body and sends Origin plus Content-Length: 0 on OPTIONS (T-S3)", async () => {
    const seen: Array<{ method: string; origin: string | undefined; length: string | undefined }> =
      [];
    const fixture = await serve((request, response) => {
      seen.push({
        method: request.method ?? "",
        origin: request.headers.origin,
        length: request.headers["content-length"],
      });
      if (request.method === "HEAD") {
        response.writeHead(200, { "Content-Length": "10" }).end();
        return;
      }
      response.writeHead(204).end();
    });
    const { session, recording } = open({ targets: [fixture.origin] });

    session.request(get(1, `${fixture.origin}/`, { method: "HEAD" }));
    session.request(get(2, `${fixture.origin}/`, { method: "OPTIONS" }));

    const head = await recording.outcome(1);
    expect(head).toMatchObject({ result: "end", bodyBytes: 0 });
    expect(head.head?.headers).toContainEqual(["Content-Length", "10"]);
    expect((await recording.outcome(2)).head?.status).toBe(204);
    expect(seen).toEqual([
      { method: "HEAD", origin: undefined, length: undefined },
      { method: "OPTIONS", origin: fixture.origin, length: "0" },
    ]);
  });
});
