/* eslint-disable max-nested-callbacks */
import { createHash } from "node:crypto";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedTunnelAddress } from "../network-tunnel/target-policy.js";
import { parseTrustedTarget, type TrustedAllowlist } from "./allowlist.js";
import { NetworkFetchOpenError, NetworkFetchProtocolError } from "./errors.js";
import type {
  NetworkFetchLimits,
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
  limits?: Partial<NetworkFetchLimits>;
  protectedPorts?: readonly number[];
  lookup?: (hostname: string) => Promise<ResolvedTunnelAddress[]>;
  localAddresses?: readonly string[];
  ttlMs?: number;
  isAuthorized?: () => boolean;
}

function open(input: OpenInput) {
  const recording = recordingSink();
  const allowlists = allowlistStore(input.targets);
  const session = openNetworkFetchSession({
    allowlists: allowlists.store,
    allowlistRef: { id: "fixtures", revision: 1 },
    ttlMs: input.ttlMs ?? 60_000,
    limits: input.limits,
    isAuthorized: input.isAuthorized ?? (() => true),
    protectedLocalPorts: () => new Set(input.protectedPorts ?? []),
    localAddresses: () => input.localAddresses ?? [],
    lookup: input.lookup,
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
    initiatorOrigin: null,
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

  it("refuses an initiator origin the allowlist does not bind and sends the bound one", async () => {
    const origins: (string | undefined)[] = [];
    const fixture = await serve((request, response) => {
      origins.push(request.headers.origin);
      response.end("ok");
    });
    const { session, recording } = open({ targets: [fixture.origin] });

    session.request(
      get(1, `${fixture.origin}/`, { method: "DELETE", initiatorOrigin: "http://evil.test" }),
    );
    session.request(
      get(2, `${fixture.origin}/`, { method: "DELETE", initiatorOrigin: fixture.origin }),
    );

    expect((await recording.outcome(1)).result).toBe("not_allowlisted");
    expect((await recording.outcome(2)).result).toBe("end");
    expect(origins).toEqual([fixture.origin]);
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
    const fixtureA = await serve(first.handler);
    const fixtureB = await serve(second.handler);
    const { session, recording } = open({ targets: [fixtureA.origin, fixtureB.origin] });

    session.request(get(1, `${fixtureA.origin}/`));
    session.request(get(2, `${fixtureB.origin}/`));
    await recording.until(() => recording.deliveredBytes(1) > 0 && recording.deliveredBytes(2) > 0);
    const before = recording.events.length;
    session.revoke();
    await Promise.all([first.upstreamClosed, second.upstreamClosed]);
    await settleIo();

    expect(recording.events.slice(before)).toEqual([{ type: "closed", reason: "revoked" }]);
    expect(() => session.request(get(3, `${fixtureA.origin}/`))).toThrow(
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
    const { session, recording } = open({
      targets,
      protectedPorts: [fixture.port],
      lookup: lookupTable({ "lan-name.test": ["192.0.2.10"] }),
      localAddresses: ["192.0.2.10"],
    });

    targets.forEach((origin, index) => session.request(get(index + 1, `${origin}/api/health`)));

    for (const requestId of [1, 2, 3, 4]) {
      expect((await recording.outcome(requestId)).result).toBe("self_target_denied");
    }
    expect(fixture.connections()).toBe(0);
  });

  it("applies the host target policy to names and reports dial failures by code", async () => {
    const closed = await serve((_request, response) => response.end());
    const closedPort = closed.port;
    await closers.pop()?.();
    const { session, recording } = open({
      targets: ["http://mixed.test", "http://missing.test", `http://127.0.0.1:${closedPort}`],
      lookup: lookupTable({ "mixed.test": ["127.0.0.1", "169.254.169.254"] }),
    });

    session.request(get(1, "http://mixed.test/"));
    session.request(get(2, "http://missing.test/"));
    session.request(get(3, `http://127.0.0.1:${closedPort}/`));

    expect((await recording.outcome(1)).result).toBe("policy_denied");
    expect((await recording.outcome(2)).result).toBe("host_not_found");
    expect((await recording.outcome(3)).result).toBe("connection_refused");
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

    it("follows hops inside the allowlist and reports the final URL", async () => {
      let port = 0;
      const { fixture, log } = await redirectFixture({
        "/start": redirectTo(302, "/middle"),
        "/middle": (response) => redirectTo(301, `http://localhost:${port}/final`)(response),
        "/final": (response) => response.end("done"),
      });
      port = fixture.port;
      const { session, recording } = open({
        targets: [fixture.origin, `http://localhost:${port}`],
      });

      session.request(get(1, `${fixture.origin}/start`));
      const outcome = await recording.outcome(1);

      expect(outcome).toMatchObject({ result: "end", body: "done" });
      expect(outcome.head).toMatchObject({
        status: 200,
        url: `http://localhost:${port}/final`,
        redirected: true,
      });
      expect(log).toEqual(["GET /start -", "GET /middle -", "GET /final -"]);
    });

    it("refuses a hop outside the allowlist without connecting to it", async () => {
      const outside = await serve((_request, response) => response.end("outside"));
      const { fixture } = await redirectFixture({
        "/start": redirectTo(302, `${outside.origin}/`),
      });
      const { session, recording } = open({ targets: [fixture.origin] });

      session.request(get(1, `${fixture.origin}/start`));

      expect((await recording.outcome(1)).result).toBe("redirect_not_allowlisted");
      expect(outside.connections()).toBe(0);
    });

    it("re-applies the dial policy to every hop", async () => {
      const { fixture } = await redirectFixture({
        "/start": redirectTo(302, "http://metadata.test/latest/meta-data/"),
      });
      const { session, recording } = open({
        targets: [fixture.origin, "http://metadata.test"],
        lookup: lookupTable({ "metadata.test": ["169.254.169.254"] }),
      });

      session.request(get(1, `${fixture.origin}/start`));

      expect((await recording.outcome(1)).result).toBe("policy_denied");
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
          initiatorOrigin: fixture.origin,
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
