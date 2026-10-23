import { describe, expect, it, vi } from "vitest";
import { NetworkFetchOpcode, NetworkFetchRpcError, type NetworkFetch } from "@getpaseo/client";
import {
  NETWORK_FETCH_LIMITS,
  type NetworkFetchDescriptor,
} from "@getpaseo/protocol/network-fetch/rpc-schemas";
import { NetworkFetchRegistry } from "../../../client/src/network-fetch";
import { createDaemonFetchChannel } from "./daemon-fetch-channel.web";

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

function setup() {
  const send = vi.fn();
  const close = vi.fn(async () => {});
  const wire = new NetworkFetchRegistry({ send, close, handlerError: vi.fn() });
  const handle = wire.open({ subscriptionId: "owner", descriptor, limits: NETWORK_FETCH_LIMITS });
  const client = { openNetworkFetch: vi.fn(async () => handle) };
  const onError = vi.fn();
  const frame = vi.fn();
  const lost = vi.fn();
  const channel = createDaemonFetchChannel({ client, descriptor, onError });
  channel.listen({ frame, lost });
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
