import { describe, expect, it, vi } from "vitest";
import { NetworkFetchRegistry, NetworkFetchOpcode } from "./network-fetch.js";
import { NETWORK_FETCH_LIMITS } from "@getpaseo/protocol/network-fetch/rpc-schemas";
import type { NetworkFetchRequestMetadata } from "@getpaseo/protocol/binary-frames/index";

const descriptor = {
  destinationId: "a".repeat(52),
  origin: "https://target.test",
  pathPrefix: "/",
  allowlistRevision: 1,
  authorityEpoch: "1",
  cleanupRequiredEpoch: null,
  contentOrigin: "https://content.test",
  assetVersion: "v1",
};
const request: NetworkFetchRequestMetadata = {
  method: "POST",
  url: "https://target.test/",
  headers: [],
  redirect: "manual",
  body: { kind: "stream", length: null },
};
function setup() {
  const connection = { send: vi.fn(), close: vi.fn(async () => {}), handlerError: vi.fn() };
  const registry = new NetworkFetchRegistry(connection);
  const limits = {
    ...NETWORK_FETCH_LIMITS,
    initialWindowBytes: 4,
    maxChunkBytes: 3,
    maxConcurrentRequests: 1,
    maxRequestBodyBytes: 6,
    maxResponseBodyBytes: 6,
  };
  const handle = registry.open({ subscriptionId: "owner", descriptor, limits });
  return { registry, handle, connection, limits };
}
const identity = { subscriptionId: "owner", fetchId: 1 };
const head = {
  status: 200,
  statusText: "OK",
  headers: [] as [string, string][],
  url: request.url,
  redirected: false,
  redirect: null,
  setCookieDropped: 0,
  droppedRequestHeaders: [],
};
describe("network fetch owned registry", () => {
  it.each([NetworkFetchOpcode.End, NetworkFetchOpcode.Fail])(
    "releases a cancelling exchange on in-flight terminal %i exactly once",
    (opcode) => {
      const { registry, handle } = setup();
      const observed: number[] = [];
      const unsubscribe = handle.onFrame((frame) => observed.push(frame.opcode));
      handle.send({ opcode: NetworkFetchOpcode.Request, fetchId: 1, request });
      handle.send({ opcode: NetworkFetchOpcode.Cancel, fetchId: 1 });
      const terminal =
        opcode === NetworkFetchOpcode.End
          ? { ...identity, opcode }
          : {
              ...identity,
              opcode,
              failure: { code: "upstream_error" as const, message: "Failed" },
            };
      expect(registry.receive(terminal)).toBe(true);
      expect(observed).toEqual([opcode]);
      unsubscribe();
      expect(
        registry.receive({ ...identity, opcode: NetworkFetchOpcode.Cancelled, dnsPending: false }),
      ).toBe(true);
      handle.onFrame((frame) => observed.push(frame.opcode));
      handle.send({ opcode: NetworkFetchOpcode.Request, fetchId: 2, request });
      expect(
        registry.receive({ ...identity, opcode: NetworkFetchOpcode.Cancelled, dnsPending: false }),
      ).toBe(true);
      expect(registry.receive(terminal)).toBe(true);
      expect(observed).toEqual([opcode]);
      expect(handle.ended).toBeNull();
    },
  );
  it("orders reentrant events for every listener and isolates listener failures", () => {
    const { registry, handle, connection } = setup();
    const first: number[] = [];
    const second: number[] = [];
    handle.onFrame((frame) => {
      first.push(frame.opcode);
      if (frame.opcode === NetworkFetchOpcode.Head) {
        expect(
          registry.receive({
            ...identity,
            opcode: NetworkFetchOpcode.Body,
            data: new Uint8Array([1]),
          }),
        ).toBe(true);
        throw new Error("private listener error");
      }
    });
    handle.onFrame((frame) => second.push(frame.opcode));
    handle.send({ opcode: NetworkFetchOpcode.Request, fetchId: 1, request });
    expect(registry.receive({ ...identity, opcode: NetworkFetchOpcode.Head, head })).toBe(true);
    expect(first).toEqual([NetworkFetchOpcode.Head, NetworkFetchOpcode.Body]);
    expect(second).toEqual(first);
    expect(connection.handlerError).toHaveBeenCalledExactlyOnceWith();
  });
  it("enforces credits, concurrency, body ceilings and cancellation", () => {
    const { registry, handle, connection } = setup();
    handle.onFrame(() => {});
    handle.send({ opcode: NetworkFetchOpcode.Request, fetchId: 1, request });
    expect(() =>
      handle.send({ opcode: NetworkFetchOpcode.Request, fetchId: 2, request }),
    ).toThrow();
    handle.send({ opcode: NetworkFetchOpcode.Body, fetchId: 1, data: new Uint8Array(3) });
    expect(() =>
      handle.send({ opcode: NetworkFetchOpcode.Body, fetchId: 1, data: new Uint8Array(2) }),
    ).toThrow();
    expect(registry.receive({ ...identity, opcode: NetworkFetchOpcode.Credit, bytes: 4 })).toBe(
      false,
    );
    expect(registry.receive({ ...identity, opcode: NetworkFetchOpcode.Credit, bytes: 3 })).toBe(
      true,
    );
    handle.send({ opcode: NetworkFetchOpcode.Body, fetchId: 1, data: new Uint8Array(3) });
    expect(registry.receive({ ...identity, opcode: NetworkFetchOpcode.Credit, bytes: 3 })).toBe(
      true,
    );
    expect(() =>
      handle.send({ opcode: NetworkFetchOpcode.Body, fetchId: 1, data: new Uint8Array(1) }),
    ).toThrow();
    handle.send({ opcode: NetworkFetchOpcode.Cancel, fetchId: 1 });
    expect(
      registry.receive({ ...identity, opcode: NetworkFetchOpcode.Cancelled, dnsPending: true }),
    ).toBe(true);
    handle.send({ opcode: NetworkFetchOpcode.Request, fetchId: 2, request });
    expect(connection.send).toHaveBeenCalledTimes(5);
  });
  it("rejects response overruns and freezes negotiated limits", () => {
    const { registry, handle, limits } = setup();
    limits.initialWindowBytes = 999;
    expect(handle.limits.initialWindowBytes).toBe(4);
    expect(Object.isFrozen(handle.limits)).toBe(true);
    handle.onFrame(() => {});
    handle.send({ opcode: NetworkFetchOpcode.Request, fetchId: 1, request });
    expect(
      registry.receive({ ...identity, opcode: NetworkFetchOpcode.Body, data: new Uint8Array(1) }),
    ).toBe(false);
    expect(registry.receive({ ...identity, opcode: NetworkFetchOpcode.Head, head })).toBe(true);
    expect(
      registry.receive({ ...identity, opcode: NetworkFetchOpcode.Body, data: new Uint8Array(3) }),
    ).toBe(true);
    expect(
      registry.receive({ ...identity, opcode: NetworkFetchOpcode.Body, data: new Uint8Array(2) }),
    ).toBe(false);
    handle.send({ opcode: NetworkFetchOpcode.Credit, fetchId: 1, bytes: 3 });
    expect(
      registry.receive({ ...identity, opcode: NetworkFetchOpcode.Body, data: new Uint8Array(3) }),
    ).toBe(true);
    handle.send({ opcode: NetworkFetchOpcode.Credit, fetchId: 1, bytes: 3 });
    expect(
      registry.receive({ ...identity, opcode: NetworkFetchOpcode.Body, data: new Uint8Array(1) }),
    ).toBe(false);
  });
  it("requires observation, retires closed owners and never restores handles", async () => {
    const { registry, handle, connection } = setup();
    expect(() =>
      handle.send({ opcode: NetworkFetchOpcode.Request, fetchId: 1, request }),
    ).toThrow();
    handle.onFrame(() => {});
    handle.send({ opcode: NetworkFetchOpcode.Request, fetchId: 0xffffffff, request });
    registry.disconnected();
    expect(handle.ended).toBe("channel_lost");
    expect(() =>
      handle.send({ opcode: NetworkFetchOpcode.Request, fetchId: 1, request }),
    ).toThrow();
    await handle.close();
    expect(connection.close).not.toHaveBeenCalled();
    expect(registry.receive({ ...identity, opcode: NetworkFetchOpcode.End })).toBe(false);
    const next = registry.open({
      subscriptionId: "next",
      descriptor,
      limits: NETWORK_FETCH_LIMITS,
    });
    expect(registry.closed("next", "expired")).toBe(true);
    const ended = vi.fn();
    next.onEnd(ended);
    expect(ended).toHaveBeenCalledExactlyOnceWith("expired");
    expect(
      registry.receive({ ...identity, subscriptionId: "next", opcode: NetworkFetchOpcode.End }),
    ).toBe(true);
    expect(() =>
      registry.open({ subscriptionId: "é".repeat(128), descriptor, limits: NETWORK_FETCH_LIMITS }),
    ).toThrow();
  });
  it("fails closed on a synchronous send failure even when observers throw", () => {
    const { registry, handle, connection } = setup();
    handle.onFrame(() => {});
    handle.onEnd(() => {
      throw new Error("listener");
    });
    connection.send.mockImplementation(() => {
      throw new Error("transport");
    });
    expect(() =>
      handle.send({ opcode: NetworkFetchOpcode.Request, fetchId: 1, request }),
    ).toThrow();
    expect(handle.ended).toBe("channel_lost");
    expect(connection.handlerError).toHaveBeenCalledOnce();
    expect(registry.closed("owner", "revoked")).toBe(true);
  });
});
