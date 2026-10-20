import { afterEach, describe, expect, it } from "vitest";
import {
  NetworkFetchOpenFailedError,
  openNetworkFetchTransport,
  type NetworkFetchChannel,
  type NetworkFetchChannelHandlers,
  type NetworkFetchErrorCode,
  type NetworkFetchLimits,
  type NetworkFetchOutboundFrame,
  type NetworkFetchTransport,
  type NetworkFetchTransportClosedReason,
} from "./network-fetch-transport";
import type { BridgeErrorReason } from "./bridge-messages";
import type { WebProxyCapability } from "./request-policy";
import {
  WebProxyTransportError,
  type WebProxyTransportRequest,
  type WebProxyTransportResponse,
} from "./transport";

const DESTINATION = "http://127.0.0.1:4173";
const CAPABILITY: WebProxyCapability = {
  contentOrigin: "http://wp-a.localhost:5173",
  destinationOrigin: DESTINATION,
  pathPrefix: "/app/",
};

const LIMITS: NetworkFetchLimits = {
  initialWindowBytes: 8,
  maxChunkBytes: 4,
  maxConcurrentRequests: 2,
  connectTimeoutMs: 1000,
  maxRequestHeadBytes: 1024,
  maxResponseHeadBytes: 1024,
  responseHeadTimeoutMs: 1000,
  maxRequestBodyBytes: 32,
  maxResponseBodyBytes: 1024,
  maxRedirects: 0,
};

interface FakeChannel extends NetworkFetchChannel {
  sent: NetworkFetchOutboundFrame[];
  isClosed(): boolean;
  deliver(frame: unknown): void;
  lose(): void;
}

// In-order delivery like the bridge channel; it records what the adapter sends.
function createFakeChannel(): FakeChannel {
  const sent: NetworkFetchOutboundFrame[] = [];
  let handlers: NetworkFetchChannelHandlers | null = null;
  let closed = false;
  function listener(): NetworkFetchChannelHandlers {
    if (handlers === null) throw new Error("Adapter did not listen");
    return handlers;
  }
  return {
    sent,
    send(frame) {
      if (!closed) sent.push(frame);
    },
    listen(next) {
      handlers = next;
    },
    close() {
      closed = true;
    },
    isClosed: () => closed,
    deliver: (frame) => listener().frame(frame),
    lose: () => listener().lost(),
  };
}

interface Session {
  channel: FakeChannel;
  transport: NetworkFetchTransport;
  closedReasons: NetworkFetchTransportClosedReason[];
}

const openTransports: NetworkFetchTransport[] = [];

afterEach(() => {
  for (const transport of openTransports.splice(0)) transport.close();
});

async function openSession(input: { ttlMs?: number } = {}): Promise<Session> {
  const channel = createFakeChannel();
  const closedReasons: NetworkFetchTransportClosedReason[] = [];
  const opening = openNetworkFetchTransport({
    channel,
    capability: CAPABILITY,
    ttlMs: input.ttlMs ?? 60_000,
    limits: { initialWindowBytes: 8, maxChunkBytes: 4 },
    onClosed: (reason) => closedReasons.push(reason),
  });
  channel.deliver({ type: "session.opened", limits: LIMITS });
  const transport = await opening;
  openTransports.push(transport);
  channel.sent.length = 0;
  return { channel, transport, closedReasons };
}

function requestTo(input: Partial<WebProxyTransportRequest> = {}): WebProxyTransportRequest {
  return {
    url: `${DESTINATION}/app/page`,
    method: "GET",
    headers: [["accept", "text/html"]],
    body: null,
    redirect: "manual",
    initiator: { boundOrigin: DESTINATION, generation: 1, mode: "navigate" },
    ...input,
  };
}

function send(
  session: Session,
  input: Partial<WebProxyTransportRequest> = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<WebProxyTransportResponse> {
  const response = session.transport.request(requestTo(input), signal);
  // Requests a test leaves open end with the session in afterEach; callers still see the outcome.
  response.catch(() => {});
  return response;
}

function headFrame(requestId: number, head: Record<string, unknown> = {}) {
  return {
    type: "head",
    requestId,
    head: {
      status: 200,
      statusText: "OK",
      headers: [["content-type", "text/plain"]],
      url: `${DESTINATION}/app/page`,
      redirected: false,
      redirect: null,
      setCookieDropped: 0,
      droppedRequestHeaders: [],
      ...head,
    },
  };
}

function bodyFrame(requestId: number, text: string) {
  return { type: "body", requestId, data: new TextEncoder().encode(text) };
}

interface Tracked<T> {
  state: "pending" | "fulfilled" | "rejected";
  value: T | null;
  error: unknown;
}

function track<T>(promise: Promise<T>): Tracked<T> {
  const tracked: Tracked<T> = { state: "pending", value: null, error: null };
  void (async () => {
    try {
      tracked.value = await promise;
      tracked.state = "fulfilled";
    } catch (error) {
      tracked.state = "rejected";
      tracked.error = error;
    }
  })();
  return tracked;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function framesOfType<T extends NetworkFetchOutboundFrame["type"]>(
  channel: FakeChannel,
  type: T,
): Extract<NetworkFetchOutboundFrame, { type: T }>[] {
  return channel.sent.filter(
    (frame): frame is Extract<NetworkFetchOutboundFrame, { type: T }> => frame.type === type,
  );
}

function reasonOf(error: unknown): BridgeErrorReason | null {
  return error instanceof WebProxyTransportError ? error.reason : null;
}

// What the broker reads: only a WebProxyTransportError carries its code and reason to the content.
function brokerViewOf(error: unknown): Pick<WebProxyTransportError, "code" | "reason"> | null {
  return error instanceof WebProxyTransportError
    ? { code: error.code, reason: error.reason }
    : null;
}

function bodyOf(response: WebProxyTransportResponse): ReadableStream<Uint8Array> {
  if (response.body === null) throw new Error("Response has no body");
  return response.body;
}

function textOf(chunk: Uint8Array | undefined): string {
  return new TextDecoder().decode(chunk);
}

describe("opening the session", () => {
  it("opens with the capability as scope and exposes the agreed limits", async () => {
    const channel = createFakeChannel();
    const opening = openNetworkFetchTransport({
      channel,
      capability: CAPABILITY,
      ttlMs: 60_000,
      limits: { maxRequestBodyBytes: 0 },
      onClosed: () => {},
    });
    expect(channel.sent).toEqual([
      {
        type: "session.open",
        scope: { origin: DESTINATION, pathPrefix: "/app/" },
        ttlMs: 60_000,
        limits: { maxRequestBodyBytes: 0 },
      },
    ]);
    const agreed = { ...LIMITS, maxRequestBodyBytes: 0, maxRedirects: 0 };
    channel.deliver({ type: "session.opened", limits: agreed });
    const transport = await opening;
    openTransports.push(transport);
    expect(transport.limits).toEqual(agreed);
  });

  it("rejects with the core's open failure code", async () => {
    const channel = createFakeChannel();
    const closedReasons: NetworkFetchTransportClosedReason[] = [];
    const opening = openNetworkFetchTransport({
      channel,
      capability: CAPABILITY,
      ttlMs: 60_000,
      limits: {},
      onClosed: (reason) => closedReasons.push(reason),
    });
    channel.deliver({ type: "session.open_failed", code: "scope_not_allowlisted" });
    const error = await opening.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkFetchOpenFailedError);
    expect(error).toMatchObject({ code: "scope_not_allowlisted" });
    expect(channel.isClosed()).toBe(true);
    expect(closedReasons).toEqual([]);
  });

  it.each([
    { name: "zero ttl", ttlMs: 0, limits: {} },
    { name: "ttl above the timer ceiling", ttlMs: 2 ** 31, limits: {} },
    { name: "zero window", ttlMs: 1000, limits: { initialWindowBytes: 0 } },
    { name: "fractional chunk", ttlMs: 1000, limits: { maxChunkBytes: 1.5 } },
  ])("refuses $name before sending anything", async ({ ttlMs, limits }) => {
    const channel = createFakeChannel();
    const opening = openNetworkFetchTransport({
      channel,
      capability: CAPABILITY,
      ttlMs,
      limits,
      onClosed: () => {},
    });
    await expect(opening).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(channel.sent).toEqual([]);
  });

  it.each([
    { name: "above the requested window", limits: { ...LIMITS, initialWindowBytes: 16 } },
    { name: "a zero window", limits: { ...LIMITS, initialWindowBytes: 0 } },
    { name: "a chunk above the window", limits: { ...LIMITS, maxChunkBytes: 8 } },
    { name: "a missing limit", limits: { ...LIMITS, maxRedirects: undefined } },
  ])("closes when the host agrees on $name", async ({ limits }) => {
    const channel = createFakeChannel();
    const opening = openNetworkFetchTransport({
      channel,
      capability: CAPABILITY,
      ttlMs: 60_000,
      limits: { initialWindowBytes: 8, maxChunkBytes: 4 },
      onClosed: () => {},
    });
    channel.deliver({ type: "session.opened", limits });
    const error = await opening.catch((caught: unknown) => caught);
    expect(reasonOf(error)).toBe("transport_closed");
    expect(framesOfType(channel, "close")).toHaveLength(1);
    expect(channel.isClosed()).toBe(true);
  });

  it("closes on a request frame before the session opened", async () => {
    const channel = createFakeChannel();
    const opening = openNetworkFetchTransport({
      channel,
      capability: CAPABILITY,
      ttlMs: 60_000,
      limits: {},
      onClosed: () => {},
    });
    channel.deliver(headFrame(1));
    await expect(opening).rejects.toMatchObject({ reason: "transport_closed" });
    expect(framesOfType(channel, "close")).toHaveLength(1);
  });

  it("rejects when the channel is lost before the session opened", async () => {
    const channel = createFakeChannel();
    const opening = openNetworkFetchTransport({
      channel,
      capability: CAPABILITY,
      ttlMs: 60_000,
      limits: {},
      onClosed: () => {},
    });
    channel.lose();
    await expect(opening).rejects.toMatchObject({ reason: "transport_closed" });
  });
});

describe("requests", () => {
  it("numbers requests from 1 and does not spend an id on a local refusal", async () => {
    const session = await openSession();
    void send(session);
    const otherInitiator = send(session, {
      initiator: { boundOrigin: "http://127.0.0.1:9999", generation: 1, mode: "navigate" },
    });
    const otherUrl = send(session, { url: "http://127.0.0.1:9999/app/page" });
    void send(session);
    for (const refused of [otherInitiator, otherUrl]) {
      const error = await refused.catch((caught: unknown) => caught);
      expect(brokerViewOf(error)).toEqual({ code: "transport_error", reason: "not_allowed" });
    }
    expect(framesOfType(session.channel, "request").map((frame) => frame.requestId)).toEqual([
      1, 2,
    ]);
    expect(framesOfType(session.channel, "request")[0]).toEqual({
      type: "request",
      requestId: 1,
      method: "GET",
      url: `${DESTINATION}/app/page`,
      headers: [["accept", "text/html"]],
      redirect: "manual",
      body: { kind: "none" },
    });
  });

  it("resolves at the head with a stream, before any body or end", async () => {
    const session = await openSession();
    const responsePromise = send(session);
    const response = track(responsePromise);
    await flush();
    expect(response.state).toBe("pending");
    session.channel.deliver(headFrame(1));
    await flush();
    expect(response.state).toBe("fulfilled");
    expect(framesOfType(session.channel, "grantCredit")).toEqual([]);
    const reader = bodyOf(await responsePromise).getReader();
    const read = reader.read();
    session.channel.deliver(bodyFrame(1, "hi"));
    expect(textOf((await read).value)).toBe("hi");
  });

  it("keeps duplicate headers as a list, in order", async () => {
    const session = await openSession();
    const response = send(session);
    const headers = [
      ["vary", "accept"],
      ["link", "</a>; rel=preload"],
      ["vary", "origin"],
      ["link", "</b>; rel=preload"],
    ];
    session.channel.deliver(headFrame(1, { headers }));
    expect((await response).headers).toEqual(headers);
  });

  it("refuses a body above the agreed limit without sending", async () => {
    const session = await openSession();
    const response = send(session, { method: "POST", body: new Uint8Array(33) });
    await expect(response).rejects.toMatchObject({ reason: "limit" });
    expect(session.channel.sent).toEqual([]);
  });

  it("refuses a request over the concurrency limit until one is released", async () => {
    const session = await openSession();
    void send(session);
    void send(session);
    await expect(send(session)).rejects.toMatchObject({ reason: "limit" });
    session.channel.deliver(headFrame(1));
    session.channel.deliver({ type: "end", requestId: 1 });
    void send(session);
    expect(framesOfType(session.channel, "request").map((frame) => frame.requestId)).toEqual([
      1, 2, 3,
    ]);
  });

  it("refuses everything after the session closed, without sending", async () => {
    const session = await openSession();
    session.transport.close();
    session.channel.sent.length = 0;
    await expect(send(session)).rejects.toMatchObject({ reason: "transport_closed" });
    expect(session.channel.sent).toEqual([]);
  });
});

describe("request frame bounds", () => {
  // The host checks the frame in string units: URL length, header name length, and the sum of
  // name and value lengths against the agreed maxRequestHeadBytes (1024 in LIMITS).
  const base = `${DESTINATION}/app/`;
  const urlAtLimit = base + "a".repeat(8192 - base.length);
  // "é" serializes as "%C3%A9": 1360 of them plus padding land exactly on 8192 characters.
  const encodedAtLimit = new URL(base + "é".repeat(1360) + "a".repeat(8192 - base.length - 8160))
    .href;
  const encodedOverLimit = new URL(base + "é".repeat(1400)).href;

  it("builds the boundary URLs on the limit", () => {
    expect(urlAtLimit).toHaveLength(8192);
    expect(encodedAtLimit).toHaveLength(8192);
    expect(encodedOverLimit.length).toBeGreaterThan(8192);
  });

  function pair(name: string, value: string): [string, string] {
    return [name, value];
  }

  it.each([
    { name: "a URL at the limit", input: { url: urlAtLimit } },
    { name: "a percent-encoded URL at the limit", input: { url: encodedAtLimit } },
    { name: "headers at the agreed budget", input: { headers: [pair("x-a", "v".repeat(1021))] } },
    { name: "a header name at the limit", input: { headers: [pair("n".repeat(256), "")] } },
  ])("sends $name unchanged", async ({ input }) => {
    const session = await openSession();
    void send(session, input);
    const [frame] = framesOfType(session.channel, "request");
    expect(frame).toMatchObject({ requestId: 1, ...input });
    expect(frame?.url.length).toBeLessThanOrEqual(8192);
  });

  it.each([
    { name: "a URL one character over", input: { url: `${urlAtLimit}a` } },
    { name: "a URL over the limit only once percent-encoded", input: { url: encodedOverLimit } },
    {
      name: "headers one character over the agreed budget",
      input: { headers: [pair("x-a", "v".repeat(1022))] },
    },
    { name: "a header name one character over", input: { headers: [pair("n".repeat(257), "")] } },
  ])("refuses $name alone, before it takes an id", async ({ input }) => {
    const session = await openSession();
    const other = send(session);
    const error = await send(session, input).catch((caught: unknown) => caught);
    expect(brokerViewOf(error)).toEqual({ code: "transport_error", reason: "limit" });
    void send(session);
    expect(framesOfType(session.channel, "request").map((frame) => frame.requestId)).toEqual([
      1, 2,
    ]);

    session.channel.deliver(headFrame(1));
    expect((await other).status).toBe(200);
    expect(framesOfType(session.channel, "close")).toEqual([]);
    expect(session.closedReasons).toEqual([]);
  });
});

describe("response credit", () => {
  it("grants credit only for chunks the consumer pulled", async () => {
    const session = await openSession();
    const response = send(session);
    session.channel.deliver(headFrame(1));
    const reader = bodyOf(await response).getReader();
    session.channel.deliver(bodyFrame(1, "abcd"));
    session.channel.deliver(bodyFrame(1, "efgh"));
    await flush();
    expect(framesOfType(session.channel, "grantCredit")).toEqual([]);

    expect(textOf((await reader.read()).value)).toBe("abcd");
    expect(framesOfType(session.channel, "grantCredit")).toEqual([
      { type: "grantCredit", requestId: 1, bytes: 4 },
    ]);
    session.channel.deliver(bodyFrame(1, "ijkl"));
    expect(session.closedReasons).toEqual([]);
  });

  it("closes when the host sends beyond the window", async () => {
    const session = await openSession();
    const response = send(session);
    session.channel.deliver(headFrame(1));
    await response;
    session.channel.deliver(bodyFrame(1, "abcd"));
    session.channel.deliver(bodyFrame(1, "efgh"));
    session.channel.deliver(bodyFrame(1, "i"));
    expect(session.closedReasons).toEqual(["protocol_error"]);
    expect(framesOfType(session.channel, "close")).toHaveLength(1);
  });

  it("closes on a chunk above the chunk limit or empty", async () => {
    for (const text of ["abcde", ""]) {
      const session = await openSession();
      const response = send(session);
      session.channel.deliver(headFrame(1));
      await response;
      session.channel.deliver(bodyFrame(1, text));
      expect(session.closedReasons).toEqual(["protocol_error"]);
    }
  });

  it("ends the stream after the queued chunks, without crediting a finished request", async () => {
    const session = await openSession();
    const response = send(session);
    session.channel.deliver(headFrame(1));
    const reader = bodyOf(await response).getReader();
    session.channel.deliver(bodyFrame(1, "abcd"));
    session.channel.deliver({ type: "end", requestId: 1 });
    expect(textOf((await reader.read()).value)).toBe("abcd");
    expect((await reader.read()).done).toBe(true);
    expect(framesOfType(session.channel, "grantCredit")).toEqual([]);
  });
});

describe("errors", () => {
  const expected: Record<NetworkFetchErrorCode, BridgeErrorReason> = {
    credentials_unsupported: "credentials_unsupported",
    not_allowlisted: "not_allowed",
    redirect_not_allowlisted: "not_allowed",
    policy_denied: "not_allowed",
    self_target_denied: "not_allowed",
    host_not_found: "unreachable",
    connection_refused: "unreachable",
    network_unreachable: "unreachable",
    timeout: "timeout",
    tls_certificate_invalid: "tls_error",
    tls_hostname_mismatch: "tls_error",
    tls_error: "tls_error",
    request_head_too_large: "limit",
    request_body_too_large: "limit",
    response_head_too_large: "limit",
    response_body_too_large: "limit",
    stream_limit: "limit",
    credit_exceeded: "limit",
    invalid_request: "upstream_error",
    redirect_limit: "upstream_error",
    redirect_body_unreplayable: "upstream_error",
    redirect_error_mode: "upstream_error",
    unsupported_encoding: "upstream_error",
    upstream_error: "upstream_error",
  };

  it.each(Object.entries(expected))("maps %s to %s with a fixed message", async (code, reason) => {
    const session = await openSession();
    const response = send(session);
    session.channel.deliver({
      type: "fail",
      requestId: 1,
      code,
      message: "secret upstream detail",
    });
    const error = await response.catch((caught: unknown) => caught);
    expect(brokerViewOf(error)).toEqual({ code: "transport_error", reason });
    expect(String(error)).not.toContain("secret");
  });

  it("errors the stream when the request fails after the head", async () => {
    const session = await openSession();
    const response = send(session);
    session.channel.deliver(headFrame(1));
    const reader = bodyOf(await response).getReader();
    session.channel.deliver({ type: "fail", requestId: 1, code: "timeout" });
    await expect(reader.read()).rejects.toMatchObject({ reason: "timeout" });
  });

  it("closes on a failure code outside the closed list", async () => {
    const session = await openSession();
    const response = send(session);
    session.channel.deliver({ type: "fail", requestId: 1, code: "socket hang up" });
    await expect(response).rejects.toMatchObject({ reason: "transport_closed" });
    expect(session.closedReasons).toEqual(["protocol_error"]);
  });
});

describe("cancellation", () => {
  it("rejects a request aborted before the head only once the host released it", async () => {
    const session = await openSession();
    const abort = new AbortController();
    const first = track(send(session, {}, abort.signal));
    void send(session);
    abort.abort();
    abort.abort();
    expect(framesOfType(session.channel, "cancel")).toEqual([{ type: "cancel", requestId: 1 }]);

    await expect(send(session)).rejects.toMatchObject({ reason: "limit" });
    await flush();
    expect(first.state).toBe("pending");

    session.channel.deliver({ type: "cancelled", requestId: 1, dnsPending: true });
    await flush();
    expect(first.state).toBe("rejected");
    expect(first.error).toBe(abort.signal.reason);
    void send(session);
    expect(framesOfType(session.channel, "request").map((frame) => frame.requestId)).toEqual([
      1, 2, 3,
    ]);
  });

  it("holds a request aborted by its signal after the head until released", async () => {
    const session = await openSession();
    const abort = new AbortController();
    const response = send(session, {}, abort.signal);
    void send(session);
    session.channel.deliver(headFrame(1));
    const reader = bodyOf(await response).getReader();
    session.channel.deliver(bodyFrame(1, "abcd"));
    abort.abort();
    abort.abort();
    expect(framesOfType(session.channel, "cancel")).toEqual([{ type: "cancel", requestId: 1 }]);

    const read = track(reader.read());
    session.channel.deliver(bodyFrame(1, "efgh"));
    await expect(send(session)).rejects.toMatchObject({ reason: "limit" });
    await flush();
    expect(read.state).toBe("pending");
    expect(framesOfType(session.channel, "grantCredit")).toEqual([]);

    session.channel.deliver({ type: "cancelled", requestId: 1, dnsPending: false });
    await flush();
    expect(read.state).toBe("rejected");
    expect(read.error).toBe(abort.signal.reason);
    void send(session);
    expect(framesOfType(session.channel, "request").map((frame) => frame.requestId)).toEqual([
      1, 2, 3,
    ]);
    expect(session.closedReasons).toEqual([]);
  });

  it("does not cancel twice when the stream is cancelled after the signal aborted", async () => {
    const session = await openSession();
    const abort = new AbortController();
    const response = send(session, {}, abort.signal);
    session.channel.deliver(headFrame(1));
    const reader = bodyOf(await response).getReader();
    abort.abort();
    const cancelling = track(reader.cancel());
    expect(framesOfType(session.channel, "cancel")).toHaveLength(1);
    await flush();
    expect(cancelling.state).toBe("pending");
    session.channel.deliver({ type: "cancelled", requestId: 1, dnsPending: false });
    await flush();
    expect(cancelling.state).toBe("fulfilled");
  });

  it("does not send a request whose signal is already aborted", async () => {
    const session = await openSession();
    const abort = new AbortController();
    abort.abort();
    await expect(send(session, {}, abort.signal)).rejects.toBe(abort.signal.reason);
    void send(session);
    expect(framesOfType(session.channel, "request").map((frame) => frame.requestId)).toEqual([1]);
  });

  it("holds the stream cancel until cancelled and drops the request's late frames", async () => {
    const session = await openSession();
    const response = send(session);
    session.channel.deliver(headFrame(1));
    const reader = bodyOf(await response).getReader();
    session.channel.deliver(bodyFrame(1, "abcd"));
    const cancelling = track(reader.cancel());
    expect(framesOfType(session.channel, "cancel")).toEqual([{ type: "cancel", requestId: 1 }]);

    session.channel.deliver(bodyFrame(1, "efgh"));
    session.channel.deliver(bodyFrame(1, "ijkl"));
    session.channel.deliver({ type: "uploadCredit", requestId: 1, bytes: 4 });
    await flush();
    expect(cancelling.state).toBe("pending");
    expect(framesOfType(session.channel, "grantCredit")).toEqual([]);

    session.channel.deliver({ type: "cancelled", requestId: 1, dnsPending: false });
    await flush();
    expect(cancelling.state).toBe("fulfilled");
    expect(session.closedReasons).toEqual([]);
  });

  it("accepts one late cancelled after an end that crossed the cancel", async () => {
    const session = await openSession();
    const response = send(session);
    session.channel.deliver(headFrame(1));
    const reader = bodyOf(await response).getReader();
    const cancelling = reader.cancel();
    session.channel.deliver({ type: "end", requestId: 1 });
    await cancelling;

    session.channel.deliver({ type: "cancelled", requestId: 1, dnsPending: false });
    expect(session.closedReasons).toEqual([]);
    session.channel.deliver({ type: "cancelled", requestId: 1, dnsPending: false });
    expect(session.closedReasons).toEqual(["protocol_error"]);
  });

  it("forgets the oldest crossed cancel beyond the concurrency limit", async () => {
    const session = await openSession();
    for (let requestId = 1; requestId <= 3; requestId += 1) {
      const abort = new AbortController();
      const response = send(session, {}, abort.signal).catch(() => null);
      abort.abort();
      session.channel.deliver({ type: "end", requestId });
      await response;
    }
    session.channel.deliver({ type: "cancelled", requestId: 3, dnsPending: false });
    session.channel.deliver({ type: "cancelled", requestId: 2, dnsPending: false });
    expect(session.closedReasons).toEqual([]);
    session.channel.deliver({ type: "cancelled", requestId: 1, dnsPending: false });
    expect(session.closedReasons).toEqual(["protocol_error"]);
  });

  it("fails a request the host cancelled on its own, keeping the session", async () => {
    const session = await openSession();
    const response = send(session);
    session.channel.deliver({ type: "cancelled", requestId: 1, dnsPending: false });
    await expect(response).rejects.toMatchObject({ reason: "transport_closed" });
    expect(session.closedReasons).toEqual([]);
  });
});

describe("upload", () => {
  it("sends the body in chunks within the upload credit, then ends it", async () => {
    const session = await openSession();
    const body = new TextEncoder().encode("0123456789");
    void send(session, { method: "POST", body });
    expect(framesOfType(session.channel, "request")[0]?.body).toEqual({
      kind: "stream",
      length: 10,
    });
    expect(framesOfType(session.channel, "body").map((frame) => textOf(frame.data))).toEqual([
      "0123",
      "4567",
    ]);
    expect(framesOfType(session.channel, "endBody")).toEqual([]);

    session.channel.deliver({ type: "uploadCredit", requestId: 1, bytes: 4 });
    expect(framesOfType(session.channel, "body").map((frame) => textOf(frame.data))).toEqual([
      "0123",
      "4567",
      "89",
    ]);
    expect(framesOfType(session.channel, "endBody")).toEqual([{ type: "endBody", requestId: 1 }]);
    session.channel.deliver({ type: "uploadCredit", requestId: 1, bytes: 10 });
    expect(session.closedReasons).toEqual(["protocol_error"]);
  });

  it("sends an empty body as no body", async () => {
    const session = await openSession();
    void send(session, { method: "POST", body: new Uint8Array(0) });
    expect(framesOfType(session.channel, "request")[0]?.body).toEqual({ kind: "none" });
    expect(framesOfType(session.channel, "body")).toEqual([]);
    expect(framesOfType(session.channel, "endBody")).toEqual([]);
  });

  it("stops writing once the request is cancelled", async () => {
    const session = await openSession();
    const abort = new AbortController();
    void send(session, { method: "PUT", body: new Uint8Array(20) }, abort.signal).catch(() => null);
    abort.abort();
    session.channel.deliver({ type: "uploadCredit", requestId: 1, bytes: 8 });
    expect(framesOfType(session.channel, "body")).toHaveLength(2);
    expect(framesOfType(session.channel, "endBody")).toEqual([]);
  });
});

describe("redirects", () => {
  it("never delivers a redirect the core refused and keeps it reserved until released", async () => {
    const session = await openSession();
    const response = track(send(session));
    session.channel.deliver(
      headFrame(1, {
        status: 302,
        headers: [["location", "http://127.0.0.1:5000/"]],
        redirect: { location: "http://127.0.0.1:5000/", allowed: false },
      }),
    );
    expect(framesOfType(session.channel, "cancel")).toEqual([{ type: "cancel", requestId: 1 }]);
    await flush();
    expect(response.state).toBe("pending");

    session.channel.deliver({ type: "cancelled", requestId: 1, dnsPending: false });
    await flush();
    expect(brokerViewOf(response.error)).toEqual({
      code: "redirect_blocked",
      reason: "not_allowed",
    });
  });

  it("keeps exactly one Location, the core's, where the first one was", async () => {
    const session = await openSession();
    const response = send(session);
    session.channel.deliver(
      headFrame(1, {
        status: 302,
        headers: [
          ["cache-control", "no-store"],
          ["Location", "/app/first"],
          ["vary", "accept"],
          ["location", "/app/second"],
        ],
        redirect: { location: `${DESTINATION}/app/first`, allowed: true },
      }),
    );
    expect((await response).headers).toEqual([
      ["cache-control", "no-store"],
      ["location", `${DESTINATION}/app/first`],
      ["vary", "accept"],
    ]);
  });

  it("drops Location when the core saw no redirect", async () => {
    const session = await openSession();
    const response = send(session);
    session.channel.deliver(headFrame(1, { headers: [["location", "/app/elsewhere"]] }));
    expect((await response).headers).toEqual([]);
  });
});

describe("end of session", () => {
  it("fails every request when the host closes and never sends again", async () => {
    const session = await openSession();
    const pending = send(session);
    const streaming = send(session);
    session.channel.deliver(headFrame(2));
    const reader = bodyOf(await streaming).getReader();
    session.channel.deliver({ type: "closed", reason: "allowlist_changed" });

    await expect(pending).rejects.toMatchObject({ reason: "transport_closed" });
    await expect(reader.read()).rejects.toMatchObject({ reason: "transport_closed" });
    expect(session.closedReasons).toEqual(["allowlist_changed"]);
    expect(session.channel.isClosed()).toBe(true);
    expect(framesOfType(session.channel, "close")).toEqual([]);
  });

  it("does not retry a POST whose channel was lost", async () => {
    const session = await openSession();
    const post = send(session, { method: "POST", body: new TextEncoder().encode("order") });
    session.channel.lose();
    await expect(post).rejects.toMatchObject({ reason: "transport_closed" });
    await expect(send(session, { method: "POST" })).rejects.toMatchObject({
      reason: "transport_closed",
    });
    expect(framesOfType(session.channel, "request")).toHaveLength(1);
    expect(session.closedReasons).toEqual(["channel_lost"]);
  });

  it("closes locally at once, without waiting for the host", async () => {
    const session = await openSession();
    const pending = send(session);
    session.transport.close();
    session.transport.close();
    await expect(pending).rejects.toMatchObject({ reason: "transport_closed" });
    expect(framesOfType(session.channel, "close")).toHaveLength(1);
    expect(session.closedReasons).toEqual(["closed"]);
  });

  it("closes itself at the session deadline", async () => {
    const session = await openSession({ ttlMs: 20 });
    const pending = send(session);
    await expect(pending).rejects.toMatchObject({ reason: "transport_closed" });
    expect(session.closedReasons).toEqual(["expired"]);
    expect(framesOfType(session.channel, "close")).toHaveLength(1);
  });

  it("ignores a replay refusal, which names a duplicate the adapter never sent", async () => {
    const session = await openSession();
    const response = send(session, { method: "POST", body: new TextEncoder().encode("once") });
    session.channel.deliver({ type: "protocol_error", violation: "replayed" });
    session.channel.deliver(headFrame(1));
    const reader = bodyOf(await response).getReader();
    session.channel.deliver({ type: "end", requestId: 1 });
    expect((await reader.read()).done).toBe(true);
    expect(session.closedReasons).toEqual([]);
  });

  it.each(["unknown_request", "session_closed", "body_not_expected", "credit_overflow"])(
    "closes on the protocol error %s",
    async (violation) => {
      const session = await openSession();
      const response = send(session);
      session.channel.deliver({ type: "protocol_error", violation });
      await expect(response).rejects.toMatchObject({ reason: "transport_closed" });
      expect(session.closedReasons).toEqual(["protocol_error"]);
      expect(framesOfType(session.channel, "close")).toHaveLength(1);
    },
  );

  it.each([
    { name: "an id never sent", frame: headFrame(5) },
    { name: "a body before the head", frame: bodyFrame(1, "a") },
    { name: "an unknown frame", frame: { type: "trailers", requestId: 1 } },
    { name: "a second open", frame: { type: "session.opened", limits: LIMITS } },
  ])("closes on $name", async ({ frame }) => {
    const session = await openSession();
    const response = send(session);
    session.channel.deliver(frame);
    await expect(response).rejects.toMatchObject({ reason: "transport_closed" });
    expect(session.closedReasons).toEqual(["protocol_error"]);
  });

  it("closes on a second head for the same request", async () => {
    const session = await openSession();
    const response = send(session);
    session.channel.deliver(headFrame(1));
    await response;
    session.channel.deliver(headFrame(1));
    expect(session.closedReasons).toEqual(["protocol_error"]);
  });
});
