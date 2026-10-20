import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BRIDGE_LIMITS,
  type BridgeLimits,
  type BridgeRevokeReason,
  type RequestMessage,
} from "./bridge-messages";
import { startPortSession, type PortSession } from "./port-session.web";
import type { WebProxyCapability } from "./request-policy";
import {
  WebProxyTransportError,
  type WebProxyTransport,
  type WebProxyTransportRequest,
  type WebProxyTransportResponse,
} from "./transport";

const DESTINATION = "http://127.0.0.1:4173";
const CAPABILITY: WebProxyCapability = {
  contentOrigin: "https://wp-a.example",
  destinationOrigin: DESTINATION,
  pathPrefix: "/",
};

interface TransportCall {
  request: WebProxyTransportRequest;
  signal: AbortSignal;
}

interface Harness {
  session: PortSession;
  content: MessagePort;
  calls: TransportCall[];
  revocations: BridgeRevokeReason[];
  blockedRedirects: string[];
  next(): Promise<unknown>;
  expectSilence(): Promise<void>;
}

const openPorts: MessagePort[] = [];

afterEach(() => {
  for (const port of openPorts.splice(0)) port.close();
});

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function ok(body: ReadableStream<Uint8Array> | null): WebProxyTransportResponse {
  return { status: 200, statusText: "OK", headers: [["content-type", "text/plain"]], body };
}

function hanging(
  _request: WebProxyTransportRequest,
  signal: AbortSignal,
): Promise<WebProxyTransportResponse> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason));
  });
}

// Sends `head` bytes and then never finishes, keeping the request in flight.
function openEnded(head: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(head);
    },
  });
}

function start(input: {
  respond: (
    request: WebProxyTransportRequest,
    signal: AbortSignal,
  ) => Promise<WebProxyTransportResponse>;
  limits?: BridgeLimits;
  capability?: WebProxyCapability;
}): Harness {
  const channel = new MessageChannel();
  openPorts.push(channel.port2);
  const calls: TransportCall[] = [];
  const revocations: BridgeRevokeReason[] = [];
  const blockedRedirects: string[] = [];
  const inbox: unknown[] = [];
  let waiter: ((message: unknown) => void) | null = null;
  channel.port2.addEventListener("message", (event) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(event.data);
      return;
    }
    inbox.push(event.data);
  });
  channel.port2.start();
  const transport: WebProxyTransport = {
    request(request, signal) {
      calls.push({ request, signal });
      return input.respond(request, signal);
    },
  };
  const session = startPortSession({
    port: channel.port1,
    generation: 1,
    capability: input.capability ?? CAPABILITY,
    limits: input.limits ?? DEFAULT_BRIDGE_LIMITS,
    transport,
    onRevoked: (reason) => revocations.push(reason),
    onRedirectBlocked: (url) => blockedRedirects.push(url),
  });
  function next(): Promise<unknown> {
    const queued = inbox.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      waiter = resolve;
    });
  }
  // Absence can only be observed by waiting; the bridge delivers within microseconds.
  async function expectSilence(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inbox).toEqual([]);
  }
  return {
    session,
    content: channel.port2,
    calls,
    revocations,
    blockedRedirects,
    next,
    expectSilence,
  };
}

function abortedFlags(harness: Harness): boolean[] {
  return harness.calls.map((call) => call.signal.aborted);
}

async function failWith(error: Error): Promise<WebProxyTransportResponse> {
  throw error;
}

function requestMessage(overrides: Partial<RequestMessage> = {}): RequestMessage {
  return {
    type: "paseo.web.request",
    v: 1,
    generation: 1,
    requestId: 1,
    method: "GET",
    path: "/",
    headers: [],
    body: null,
    mode: "subresource",
    ...overrides,
  };
}

function send(port: MessagePort, message: unknown): void {
  port.postMessage(message);
}

describe("startPortSession", () => {
  it("forwards a request inside the destination with the identity the capability binds", async () => {
    const harness = start({
      respond: () =>
        Promise.resolve({
          status: 200,
          statusText: "OK",
          headers: [
            ["Set-Cookie", "sid=fixture; HttpOnly"],
            ["Strict-Transport-Security", "max-age=1"],
            ["Content-Type", "text/plain"],
          ],
          body: streamOf(new TextEncoder().encode("ok")),
        }),
    });
    send(
      harness.content,
      requestMessage({
        method: "POST",
        path: "/api/x?y=1",
        headers: [
          ["Cookie", "a=b"],
          ["Origin", "http://elsewhere.invalid"],
          ["Sec-Fetch-Site", "cross-site"],
          ["X-Custom", "1"],
        ],
        body: bytes("abc"),
      }),
    );

    expect(await harness.next()).toEqual({
      type: "paseo.web.response.head",
      v: 1,
      generation: 1,
      requestId: 1,
      status: 200,
      statusText: "OK",
      headers: [["content-type", "text/plain"]],
    });
    const chunk = await harness.next();
    expect(chunk).toMatchObject({ type: "paseo.web.response.chunk", requestId: 1 });
    expect(await harness.next()).toEqual({
      type: "paseo.web.response.end",
      v: 1,
      generation: 1,
      requestId: 1,
    });
    expect(harness.calls).toHaveLength(1);
    const [call] = harness.calls;
    expect(call?.request).toEqual({
      url: "http://127.0.0.1:4173/api/x?y=1",
      method: "POST",
      headers: [["x-custom", "1"]],
      body: new Uint8Array(bytes("abc")),
      redirect: "manual",
      initiator: { boundOrigin: DESTINATION, generation: 1, mode: "subresource" },
    });
  });

  it.each(["//elsewhere.invalid/x", "/\\elsewhere.invalid", "http://elsewhere.invalid/", "x"])(
    "answers invalid_request for %s without calling the transport",
    async (path) => {
      const harness = start({ respond: () => Promise.resolve(ok(null)) });
      send(harness.content, requestMessage({ path }));
      expect(await harness.next()).toEqual({
        type: "paseo.web.response.error",
        v: 1,
        generation: 1,
        requestId: 1,
        code: "invalid_request",
      });
      expect(harness.calls).toEqual([]);
    },
  );

  it.each([
    ["a malformed message", { ...requestMessage(), destination: "http://elsewhere.invalid" }],
    ["another generation", requestMessage({ generation: 2 })],
    ["an unknown type", { type: "paseo.web.label", v: 1, generation: 1, requestId: 1 }],
  ])("ends the grant on %s", async (_label, message) => {
    const harness = start({ respond: () => Promise.resolve(ok(null)) });
    send(harness.content, message);
    expect(await harness.next()).toEqual({
      type: "paseo.web.revoke",
      v: 1,
      generation: 1,
      reason: "protocol_error",
    });
    expect(harness.revocations).toEqual(["protocol_error"]);
    send(harness.content, requestMessage({ requestId: 2 }));
    await harness.expectSilence();
    expect(harness.calls).toEqual([]);
  });

  it("ends the grant on a requestId that is still in flight and aborts its request", async () => {
    const harness = start({ respond: hanging });
    send(harness.content, requestMessage());
    send(harness.content, requestMessage());
    expect(await harness.next()).toMatchObject({
      type: "paseo.web.revoke",
      reason: "protocol_error",
    });
    expect(abortedFlags(harness)).toEqual([true]);
  });

  it("keeps response bytes in flight within the window until the content acks", async () => {
    const harness = start({
      respond: () => Promise.resolve(ok(streamOf(new Uint8Array(16)))),
      limits: { ...DEFAULT_BRIDGE_LIMITS, windowBytes: 8, maxChunkBytes: 4 },
    });
    send(harness.content, requestMessage());
    expect(await harness.next()).toMatchObject({ type: "paseo.web.response.head" });
    const first = await harness.next();
    const second = await harness.next();
    expect([first, second]).toMatchObject([
      { type: "paseo.web.response.chunk" },
      { type: "paseo.web.response.chunk" },
    ]);
    await harness.expectSilence();

    send(harness.content, { type: "paseo.web.ack", v: 1, generation: 1, requestId: 1, bytes: 8 });
    expect([await harness.next(), await harness.next()]).toMatchObject([
      { type: "paseo.web.response.chunk" },
      { type: "paseo.web.response.chunk" },
    ]);
    // End carries no bytes, so it does not wait for credit.
    expect(await harness.next()).toMatchObject({ type: "paseo.web.response.end" });
  });

  it("ends the grant on an ack above the bytes in flight", async () => {
    const harness = start({ respond: () => Promise.resolve(ok(openEnded(new Uint8Array(4)))) });
    send(harness.content, requestMessage());
    await harness.next();
    expect(await harness.next()).toMatchObject({ type: "paseo.web.response.chunk" });
    send(harness.content, { type: "paseo.web.ack", v: 1, generation: 1, requestId: 1, bytes: 5 });
    expect(await harness.next()).toMatchObject({
      type: "paseo.web.revoke",
      reason: "protocol_error",
    });
    expect(abortedFlags(harness)).toEqual([true]);
  });

  it("ignores acks and cancels that race with the end of a request", async () => {
    const harness = start({ respond: () => Promise.resolve(ok(null)) });
    send(harness.content, requestMessage());
    await harness.next();
    expect(await harness.next()).toMatchObject({ type: "paseo.web.response.end" });
    send(harness.content, { type: "paseo.web.ack", v: 1, generation: 1, requestId: 1, bytes: 1 });
    send(harness.content, { type: "paseo.web.cancel", v: 1, generation: 1, requestId: 1 });
    send(harness.content, requestMessage({ requestId: 2 }));
    expect(await harness.next()).toMatchObject({ type: "paseo.web.response.head", requestId: 2 });
    expect(harness.revocations).toEqual([]);
  });

  it("propagates a cancel to the transport", async () => {
    const harness = start({ respond: hanging });
    send(harness.content, requestMessage());
    send(harness.content, { type: "paseo.web.cancel", v: 1, generation: 1, requestId: 1 });
    await vi.waitFor(() => expect(abortedFlags(harness)).toEqual([true]));
    await harness.expectSilence();
  });

  it("revokes by aborting in-flight requests and announcing the reason", async () => {
    const harness = start({ respond: hanging });
    send(harness.content, requestMessage());
    await vi.waitFor(() => expect(harness.calls).toHaveLength(1));
    harness.session.revoke("disposed");
    expect(await harness.next()).toEqual({
      type: "paseo.web.revoke",
      v: 1,
      generation: 1,
      reason: "disposed",
    });
    expect(abortedFlags(harness)).toEqual([true]);
    expect(harness.revocations).toEqual(["disposed"]);
  });

  it("revokes and aborts in-flight requests when the content port closes", async () => {
    const harness = start({ respond: hanging });
    send(harness.content, requestMessage());
    await vi.waitFor(() => expect(harness.calls).toHaveLength(1));
    harness.content.close();
    await vi.waitFor(() => expect(harness.revocations).toEqual(["port_closed"]));
    expect(abortedFlags(harness)).toEqual([true]);
  });

  it("maps same-destination redirects and blocks the rest", async () => {
    const harness = start({
      respond: (request) =>
        Promise.resolve({
          status: 302,
          statusText: "Found",
          headers: [
            [
              "location",
              request.url.endsWith("/same")
                ? `${DESTINATION}/new?x=1`
                : "http://elsewhere.invalid/",
            ],
          ],
          body: null,
        }),
    });
    send(harness.content, requestMessage({ path: "/same" }));
    expect(await harness.next()).toMatchObject({
      type: "paseo.web.response.head",
      status: 302,
      headers: [["location", "/new?x=1"]],
    });
    await harness.next();
    send(harness.content, requestMessage({ requestId: 2, path: "/cross" }));
    expect(await harness.next()).toMatchObject({
      type: "paseo.web.response.error",
      requestId: 2,
      code: "redirect_blocked",
    });
    expect(harness.blockedRedirects).toEqual([`${DESTINATION}/cross`]);
    // One transport call per hop: nothing followed the cross-origin Location.
    expect(harness.calls.map((call) => call.request.url)).toEqual([
      `${DESTINATION}/same`,
      `${DESTINATION}/cross`,
    ]);
  });

  it("enforces the capability's path prefix on requests and redirects", async () => {
    const harness = start({
      capability: { ...CAPABILITY, pathPrefix: "/app/" },
      respond: () =>
        Promise.resolve({
          status: 302,
          statusText: "Found",
          headers: [["location", "/admin/"]],
          body: null,
        }),
    });
    send(harness.content, requestMessage({ path: "/admin/" }));
    expect(await harness.next()).toMatchObject({ requestId: 1, code: "path_not_allowed" });
    send(harness.content, requestMessage({ requestId: 2, path: "/app/../admin/" }));
    expect(await harness.next()).toMatchObject({ requestId: 2, code: "path_not_allowed" });
    send(harness.content, requestMessage({ requestId: 3, path: "/app/start" }));
    expect(await harness.next()).toMatchObject({ requestId: 3, code: "redirect_blocked" });
    expect(harness.calls.map((call) => call.request.url)).toEqual([`${DESTINATION}/app/start`]);
  });

  it("finishes a large response under the smallest valid window", async () => {
    const harness = start({
      respond: () => Promise.resolve(ok(streamOf(new Uint8Array(5)))),
      limits: { ...DEFAULT_BRIDGE_LIMITS, windowBytes: 1, maxChunkBytes: 1 },
    });
    send(harness.content, requestMessage());
    expect(await harness.next()).toMatchObject({ type: "paseo.web.response.head" });
    for (let index = 0; index < 5; index += 1) {
      expect(await harness.next()).toMatchObject({ type: "paseo.web.response.chunk" });
      send(harness.content, { type: "paseo.web.ack", v: 1, generation: 1, requestId: 1, bytes: 1 });
    }
    expect(await harness.next()).toMatchObject({ type: "paseo.web.response.end" });
  });

  it("keeps a cancelled request's slot until the transport lets go of it", async () => {
    const releases: Array<() => void> = [];
    const harness = start({
      // A transport that honours the abort only later, like a cancel crossing a relay.
      respond: () =>
        new Promise((resolve) => {
          releases.push(() => resolve(ok(null)));
        }),
      limits: { ...DEFAULT_BRIDGE_LIMITS, maxConcurrentRequests: 2 },
    });
    for (const requestId of [1, 2]) {
      send(harness.content, requestMessage({ requestId }));
      send(harness.content, { type: "paseo.web.cancel", v: 1, generation: 1, requestId });
    }
    send(harness.content, requestMessage({ requestId: 3 }));
    expect(await harness.next()).toMatchObject({ requestId: 3, code: "too_many_requests" });
    expect(abortedFlags(harness)).toEqual([true, true]);

    for (const release of releases.splice(0)) release();
    send(harness.content, requestMessage({ requestId: 4 }));
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    for (const release of releases.splice(0)) release();
    expect(await harness.next()).toMatchObject({ type: "paseo.web.response.head", requestId: 4 });
  });

  it("answers too_many_requests above the concurrency limit", async () => {
    const harness = start({
      respond: hanging,
      limits: { ...DEFAULT_BRIDGE_LIMITS, maxConcurrentRequests: 1 },
    });
    send(harness.content, requestMessage());
    send(harness.content, requestMessage({ requestId: 2 }));
    expect(await harness.next()).toMatchObject({
      type: "paseo.web.response.error",
      requestId: 2,
      code: "too_many_requests",
    });
    expect(harness.calls).toHaveLength(1);
  });

  it("answers body_too_large without calling the transport", async () => {
    const harness = start({
      respond: () => Promise.resolve(ok(null)),
      limits: { ...DEFAULT_BRIDGE_LIMITS, maxRequestBodyBytes: 2 },
    });
    send(harness.content, requestMessage({ method: "POST", body: bytes("abc") }));
    expect(await harness.next()).toMatchObject({ code: "body_too_large" });
    expect(harness.calls).toEqual([]);
  });

  it("hides transport failures behind a fixed code and reason", async () => {
    const harness = start({
      respond: () => Promise.reject(new Error("dial 10.0.0.5 failed: secret detail")),
    });
    send(harness.content, requestMessage());
    expect(await harness.next()).toEqual({
      type: "paseo.web.response.error",
      v: 1,
      generation: 1,
      requestId: 1,
      code: "transport_error",
      reason: "upstream_error",
    });
  });

  it.each([
    [
      new WebProxyTransportError("credentials_unsupported"),
      "transport_error",
      "credentials_unsupported",
    ],
    [
      new WebProxyTransportError("not_allowed", "redirect_blocked"),
      "redirect_blocked",
      "not_allowed",
    ],
    [new WebProxyTransportError("tls_error"), "transport_error", "tls_error"],
  ] as const)(
    "passes a typed transport failure on with its code and reason",
    async (error, code, reason) => {
      const harness = start({ respond: () => failWith(error) });
      send(harness.content, requestMessage());
      expect(await harness.next()).toEqual({
        type: "paseo.web.response.error",
        v: 1,
        generation: 1,
        requestId: 1,
        code,
        reason,
      });
    },
  );

  it("reports a body that fails after the head with the transport's reason", async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2));
      },
      pull(controller) {
        controller.error(new WebProxyTransportError("transport_closed"));
      },
    });
    const harness = start({ respond: () => Promise.resolve(ok(failing)) });
    send(harness.content, requestMessage());
    expect(await harness.next()).toMatchObject({ type: "paseo.web.response.head" });
    expect(await harness.next()).toMatchObject({ type: "paseo.web.response.chunk" });
    expect(await harness.next()).toEqual({
      type: "paseo.web.response.error",
      v: 1,
      generation: 1,
      requestId: 1,
      code: "transport_error",
      reason: "transport_closed",
    });
  });

  it("keeps a cancelled body's slot until the transport's cancel has finished", async () => {
    const release = Promise.withResolvers<void>();
    const slowCancel = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
      },
      // A relayed transport resolves this once the host confirms the upstream request closed.
      cancel: () => release.promise,
    });
    const harness = start({
      respond: (request) => Promise.resolve(ok(request.url.endsWith("/slow") ? slowCancel : null)),
      limits: { ...DEFAULT_BRIDGE_LIMITS, maxConcurrentRequests: 1 },
    });
    send(harness.content, requestMessage({ path: "/slow" }));
    await harness.next();
    expect(await harness.next()).toMatchObject({ type: "paseo.web.response.chunk" });
    send(harness.content, { type: "paseo.web.cancel", v: 1, generation: 1, requestId: 1 });
    send(harness.content, requestMessage({ requestId: 2 }));
    expect(await harness.next()).toMatchObject({ requestId: 2, code: "too_many_requests" });

    release.resolve();
    send(harness.content, requestMessage({ requestId: 3 }));
    expect(await harness.next()).toMatchObject({ type: "paseo.web.response.head", requestId: 3 });
  });
});
