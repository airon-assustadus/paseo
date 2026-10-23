import { describe, expect, it, vi } from "vitest";
import { NetworkFetchOpcode, NetworkFetchRpcError, type NetworkFetch } from "@getpaseo/client";
import {
  NETWORK_FETCH_LIMITS,
  type NetworkFetchDescriptor,
} from "@getpaseo/protocol/network-fetch/rpc-schemas";
import { NetworkFetchRegistry } from "../../../client/src/network-fetch";
import { createDaemonFetchChannel } from "./daemon-fetch-channel.web";
import { openNetworkFetchTransport } from "./network-fetch-transport";

const descriptor: NetworkFetchDescriptor = {
  destinationId: "a".repeat(52),
  origin: "https://destination.example",
  pathPrefix: "/",
  allowlistRevision: 1,
  authorityEpoch: "5",
  cleanupRequiredEpoch: null,
  contentOrigin: `https://${"a".repeat(52)}.content.example`,
  assetVersion: "one",
};
const request = {
  type: "request",
  requestId: 1,
  method: "GET",
  url: "https://destination.example/",
  headers: [],
  redirect: "manual",
  body: { kind: "none" },
} as const;

function setup(limits = NETWORK_FETCH_LIMITS, listen = true) {
  const send = vi.fn();
  const close = vi.fn(async () => {});
  const wire = new NetworkFetchRegistry({ send, close, handlerError: vi.fn() });
  const handle = wire.open({ subscriptionId: "owner", descriptor, limits });
  const client = { openNetworkFetch: vi.fn(async () => handle) };
  const onError = vi.fn();
  const frame = vi.fn();
  const lost = vi.fn();
  const channel = createDaemonFetchChannel({ client, descriptor, onError });
  if (listen) channel.listen({ frame, lost });
  async function open(): Promise<void> {
    channel.send({
      type: "session.open",
      scope: { origin: descriptor.origin, pathPrefix: "/" },
      ttlMs: 1000,
      limits: {},
    });
    await Promise.resolve();
  }
  return { wire, handle, client, onError, frame, lost, channel, send, close, open };
}

describe("daemon fetch channel", () => {
  it.each([NetworkFetchOpcode.End, NetworkFetchOpcode.Fail])(
    "settles stream cancellation on terminal %s and reuses the slot without replay",
    async (opcode) => {
      const context = setup({ ...NETWORK_FETCH_LIMITS, maxConcurrentRequests: 1 }, false);
      const onClosed = vi.fn();
      const transport = await openNetworkFetchTransport({
        channel: context.channel,
        capability: {
          destinationOrigin: descriptor.origin,
          contentOrigin: descriptor.contentOrigin,
          pathPrefix: descriptor.pathPrefix,
        },
        ttlMs: 60_000,
        limits: { maxConcurrentRequests: 1 },
        onClosed,
      });
      try {
        const input = {
          ...request,
          headers: [],
          body: null,
          initiator: {
            boundOrigin: descriptor.origin,
            generation: 1,
            mode: "subresource" as const,
          },
        };
        const first = transport.request(input, new AbortController().signal);
        const head = {
          status: 200,
          statusText: "OK",
          headers: [],
          url: request.url,
          redirected: false,
          redirect: null,
          setCookieDropped: 0,
          droppedRequestHeaders: [],
        };
        expect(
          context.wire.receive({
            subscriptionId: "owner",
            fetchId: 1,
            opcode: NetworkFetchOpcode.Head,
            head,
          }),
        ).toBe(true);
        const response = await first;
        expect(response.body).not.toBeNull();
        const settled = vi.fn();
        const cancelling = response.body!.getReader().cancel().then(settled);
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
        expect(context.send).toHaveBeenCalledTimes(2);
        await expect(transport.request(input, new AbortController().signal)).rejects.toMatchObject({
          reason: "limit",
        });
        const terminal =
          opcode === NetworkFetchOpcode.End
            ? { subscriptionId: "owner", fetchId: 1, opcode }
            : {
                subscriptionId: "owner",
                fetchId: 1,
                opcode,
                failure: { code: "upstream_error" as const, message: "Upstream failure" },
              };
        expect(context.wire.receive(terminal)).toBe(true);
        await cancelling;
        expect(settled).toHaveBeenCalledOnce();
        const second = transport.request(input, new AbortController().signal);
        expect(context.send).toHaveBeenCalledTimes(3);
        expect(
          context.wire.receive({
            subscriptionId: "owner",
            fetchId: 1,
            opcode: NetworkFetchOpcode.Cancelled,
            dnsPending: false,
          }),
        ).toBe(true);
        expect(context.wire.receive(terminal)).toBe(true);
        expect(
          context.wire.receive({
            subscriptionId: "owner",
            fetchId: 2,
            opcode: NetworkFetchOpcode.Head,
            head,
          }),
        ).toBe(true);
        expect(
          context.wire.receive({
            subscriptionId: "owner",
            fetchId: 2,
            opcode: NetworkFetchOpcode.End,
          }),
        ).toBe(true);
        const next = await second;
        await expect(next.body!.getReader().read()).resolves.toEqual({
          done: true,
          value: undefined,
        });
        expect(settled).toHaveBeenCalledOnce();
        expect(context.send).toHaveBeenCalledTimes(3);
        expect(context.client.openNetworkFetch).toHaveBeenCalledOnce();
        expect(context.handle.ended).toBeNull();
        expect(context.onError).not.toHaveBeenCalled();
        expect(onClosed).not.toHaveBeenCalled();
      } finally {
        transport.close();
      }
    },
  );

  it("opens with pinned identity and installs ordered SDK listeners before the first request", async () => {
    const context = setup();
    await context.open();
    expect(context.client.openNetworkFetch).toHaveBeenCalledExactlyOnceWith({
      destinationId: descriptor.destinationId,
      expectedAuthorityEpoch: "5",
      allowlistRevision: 1,
      scope: { origin: descriptor.origin, pathPrefix: "/" },
      ttlMs: 1000,
      limits: {},
    });
    context.channel.send({ ...request, headers: [] });
    expect(context.send).toHaveBeenCalledTimes(1);
    expect(context.onError).not.toHaveBeenCalled();
    const head = {
      status: 200,
      statusText: "OK",
      headers: [],
      url: request.url,
      redirected: false,
      redirect: null,
      setCookieDropped: 0,
      droppedRequestHeaders: [],
    };
    const data = new Uint8Array([1, 2, 3]);
    expect(
      context.wire.receive({
        subscriptionId: "owner",
        fetchId: 1,
        opcode: NetworkFetchOpcode.Head,
        head,
      }),
    ).toBe(true);
    expect(
      context.wire.receive({
        subscriptionId: "owner",
        fetchId: 1,
        opcode: NetworkFetchOpcode.Body,
        data,
      }),
    ).toBe(true);
    expect(
      context.wire.receive({ subscriptionId: "owner", fetchId: 1, opcode: NetworkFetchOpcode.End }),
    ).toBe(true);
    expect(context.frame.mock.calls).toEqual([
      [{ type: "session.opened", limits: NETWORK_FETCH_LIMITS }],
      [{ type: "head", requestId: 1, head }],
      [{ type: "body", requestId: 1, data }],
      [{ type: "end", requestId: 1 }],
    ]);
    context.channel.close();
  });

  it("does not resend requests or throw after channel loss", async () => {
    const context = setup();
    await context.open();
    context.channel.send({ ...request, headers: [] });
    context.wire.disconnected();
    expect(context.lost).toHaveBeenCalledOnce();
    expect(() => context.channel.send({ ...request, headers: [] })).not.toThrow();
    expect(context.send).toHaveBeenCalledTimes(1);
    expect(context.client.openNetworkFetch).toHaveBeenCalledTimes(1);
    expect(context.close).not.toHaveBeenCalled();
  });

  it("closes a late owner when the view closed during admission", async () => {
    const context = setup();
    let finish = (_handle: NetworkFetch) => {};
    context.client.openNetworkFetch.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await context.open();
    context.channel.close();
    finish(context.handle);
    await Promise.resolve();
    expect(context.close).toHaveBeenCalledExactlyOnceWith("owner");
    expect(context.frame).not.toHaveBeenCalled();
    expect(context.handle.ended).toBe("closed");
  });

  it("delivers an already ended owner without announcing an open session", async () => {
    const context = setup();
    context.wire.closed("owner", "revoked");
    await context.open();
    expect(context.frame.mock.calls).toEqual([[{ type: "closed", reason: "revoked" }]]);
    expect(context.onError).toHaveBeenCalledExactlyOnceWith("cleanup_pending");
    expect(context.send).not.toHaveBeenCalled();
  });

  it("preserves detailed admission errors outside the old transport failure union", async () => {
    const context = setup();
    context.client.openNetworkFetch.mockRejectedValue(
      new NetworkFetchRpcError("open", "cleanup_pending"),
    );
    await context.open();
    expect(context.onError).toHaveBeenCalledExactlyOnceWith("cleanup_pending");
    expect(context.lost).toHaveBeenCalledOnce();
    context.wire.disconnected();
  });

  it("rejects a mismatched scope before calling the SDK", () => {
    const context = setup();
    context.channel.send({
      type: "session.open",
      scope: { origin: "https://other.example", pathPrefix: "/" },
      ttlMs: 1000,
      limits: {},
    });
    expect(context.client.openNetworkFetch).not.toHaveBeenCalled();
    expect(context.onError).toHaveBeenCalledExactlyOnceWith("scope_not_allowlisted");
    context.wire.disconnected();
  });
});
