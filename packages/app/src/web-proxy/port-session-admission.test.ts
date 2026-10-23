import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_BRIDGE_LIMITS, type RequestMessage } from "./bridge-messages";
import { startPortSession, type PortSession, type PortSessionAdmission } from "./port-session.web";
import type { WebProxyTransportRequest, WebProxyTransportResponse } from "./transport";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function request(patch: Partial<RequestMessage> = {}): RequestMessage {
  return {
    type: "paseo.web.request",
    v: 1,
    generation: 4,
    requestId: 1,
    method: "GET",
    path: "/allowed/page?query=1",
    headers: [],
    body: null,
    mode: "navigate",
    ...patch,
  };
}

function start(
  options: {
    observe?: boolean;
    hold?: boolean;
    admitted?(admission: PortSessionAdmission, session: PortSession): void;
  } = {},
) {
  const channel = new MessageChannel();
  const admissions: PortSessionAdmission[] = [];
  const calls: WebProxyTransportRequest[] = [];
  const order: string[] = [];
  const inbox: unknown[] = [];
  const revocations: string[] = [];
  channel.port2.addEventListener("message", (event) => inbox.push(event.data));
  channel.port2.start();
  const session = startPortSession({
    port: channel.port1,
    generation: 4,
    capability: {
      contentOrigin: "https://destination.ticket04-content.test",
      destinationOrigin: "http://127.0.0.1:8123",
      pathPrefix: "/allowed/",
    },
    limits: { ...DEFAULT_BRIDGE_LIMITS, maxConcurrentRequests: 1, maxRequestBodyBytes: 8 },
    transport: {
      request(input, signal) {
        order.push("transport");
        calls.push(input);
        if (options.hold)
          return new Promise<WebProxyTransportResponse>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        return Promise.resolve({ status: 200, statusText: "OK", headers: [], body: null });
      },
    },
    onRevoked: (reason) => revocations.push(reason),
    onRedirectBlocked() {},
    ...(options.observe === false
      ? {}
      : {
          onRequestAdmitted(admission: PortSessionAdmission) {
            admissions.push(admission);
            order.push("admitted");
            options.admitted?.(admission, session);
          },
        }),
  });
  cleanup.push(() => {
    session.discard();
    channel.port2.close();
  });
  async function next() {
    await vi.waitFor(() => expect(inbox.length).toBeGreaterThan(0));
    return inbox.shift();
  }
  function send(message: unknown) {
    channel.port2.postMessage(message);
  }
  return {
    session,
    admissions,
    calls,
    order,
    inbox,
    revocations,
    next,
    send,
    receivingPort: channel.port1,
  };
}

it("notifies exactly once with admitted URL/generation/id before transport", async () => {
  const test = start();
  test.send(request());
  expect(await test.next()).toMatchObject({ type: "paseo.web.response.head", requestId: 1 });
  expect(await test.next()).toMatchObject({ type: "paseo.web.response.end", requestId: 1 });
  expect(test.admissions).toEqual([
    {
      requestId: 1,
      generation: 4,
      url: "http://127.0.0.1:8123/allowed/page?query=1",
      mode: "navigate",
    },
  ]);
  expect(test.order).toEqual(["admitted", "transport"]);
  expect(test.calls[0]?.url).toBe(test.admissions[0]?.url);
});

it("preserves requests when the optional observer is absent", async () => {
  const test = start({ observe: false });
  test.send(request());
  expect(await test.next()).toMatchObject({ type: "paseo.web.response.head" });
  expect(await test.next()).toMatchObject({ type: "paseo.web.response.end" });
  expect(test.admissions).toEqual([]);
  expect(test.calls).toHaveLength(1);
});

it.each([
  ["scope", { path: "/outside/page" }],
  ["invalid path", { path: "https://elsewhere.test/page" }],
  ["generation", { generation: 3 }],
  ["body limit", { method: "POST", body: new ArrayBuffer(9) }],
] as const)("does not notify a request rejected by %s", async (_reason, patch) => {
  const test = start();
  test.send(request(patch));
  await test.next();
  expect(test.admissions).toEqual([]);
  expect(test.calls).toEqual([]);
});

it("does not notify a malformed request", async () => {
  const test = start();
  test.send({ ...request(), requestId: -1 });
  expect(await test.next()).toMatchObject({ type: "paseo.web.revoke", reason: "protocol_error" });
  expect(test.admissions).toEqual([]);
  expect(test.calls).toEqual([]);
});

it("reserves inFlight before notification and rejects an over-limit request", async () => {
  const test = start({ hold: true });
  test.send(request());
  await vi.waitFor(() => expect(test.calls).toHaveLength(1));
  test.send(request({ requestId: 2 }));
  expect(await test.next()).toMatchObject({
    type: "paseo.web.response.error",
    requestId: 2,
    code: "too_many_requests",
  });
  expect(test.admissions.map((admission) => admission.requestId)).toEqual([1]);
  expect(test.calls).toHaveLength(1);
});

it("does not notify a duplicate in-flight id", async () => {
  const test = start({ hold: true });
  test.send(request());
  await vi.waitFor(() => expect(test.calls).toHaveLength(1));
  test.send(request());
  expect(await test.next()).toMatchObject({ type: "paseo.web.revoke", reason: "protocol_error" });
  expect(test.admissions).toHaveLength(1);
  expect(test.calls).toHaveLength(1);
});

it("has reserved the slot when the observer reentrantly dispatches another request", async () => {
  const test = start({
    hold: true,
    admitted() {
      test.receivingPort.dispatchEvent(
        new MessageEvent("message", { data: request({ requestId: 2 }) }),
      );
    },
  });
  test.send(request());
  expect(await test.next()).toMatchObject({
    type: "paseo.web.response.error",
    requestId: 2,
    code: "too_many_requests",
  });
  expect(test.admissions.map((admission) => admission.requestId)).toEqual([1]);
  expect(test.calls).toHaveLength(1);
});

it("does not start transport after a reentrant cancel of the admitted request", async () => {
  const test = start({
    admitted(admission) {
      test.receivingPort.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "paseo.web.cancel",
            v: 1,
            generation: admission.generation,
            requestId: admission.requestId,
          },
        }),
      );
    },
  });
  test.send(request());
  await vi.waitFor(() => expect(test.admissions).toHaveLength(1));
  expect(test.calls).toEqual([]);
});

it("does not notify tombstone requests", async () => {
  const test = start();
  test.session.quiesce();
  test.send(request());
  expect(await test.next()).toMatchObject({ type: "paseo.web.response.head", status: 204 });
  expect(test.admissions).toEqual([]);
  expect(test.calls).toEqual([]);
});

it.each(["quiesce", "discard", "revoke"] as const)(
  "does not start transport after observer reentrantly calls %s",
  async (action) => {
    const test = start({
      admitted(_admission, session) {
        if (action === "revoke") session.revoke("protocol_error");
        else session[action]();
      },
    });
    test.send(request());
    await vi.waitFor(() => expect(test.admissions).toHaveLength(1));
    expect(test.calls).toEqual([]);
    test.receivingPort.dispatchEvent(
      new MessageEvent("message", { data: request({ requestId: 2 }) }),
    );
    expect(test.admissions).toHaveLength(1);
    expect(test.calls).toEqual([]);
  },
);

it("releases the slot and reports failure when the observer throws", async () => {
  let fail = true;
  const test = start({
    admitted() {
      if (fail) throw new Error("observer failed");
    },
  });
  test.send(request());
  expect(await test.next()).toMatchObject({
    type: "paseo.web.response.error",
    requestId: 1,
    code: "transport_error",
  });
  expect(test.calls).toEqual([]);
  fail = false;
  test.send(request({ requestId: 2 }));
  expect(await test.next()).toMatchObject({ type: "paseo.web.response.head", requestId: 2 });
  expect(test.calls).toHaveLength(1);
});

it("does not expose mutable transport request state to the observer", async () => {
  const test = start({
    admitted(admission) {
      Object.assign(admission, { requestId: 99, generation: 99, url: "https://outside.test/" });
    },
  });
  test.send(request());
  expect(await test.next()).toMatchObject({
    type: "paseo.web.response.head",
    requestId: 1,
    generation: 4,
  });
  expect(test.calls[0]).toMatchObject({
    url: "http://127.0.0.1:8123/allowed/page?query=1",
    initiator: { generation: 4 },
  });
});
