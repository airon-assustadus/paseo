import { describe, expect, it, vi } from "vitest";
import {
  createWebProxyProductRegistry,
  WebProxyProductRegistryError,
} from "./product-registry.web";

describe("product registry", () => {
  it("R0 attempts the broadcast even when a callback disposes the registry", () => {
    const channel = new BroadcastChannel(crypto.randomUUID());
    const post = vi.spyOn(channel, "postMessage");
    const registry = createWebProxyProductRegistry({ channel });
    const visited = vi.fn();
    const first = { serverId: "host", workspaceId: "workspace", browserId: "first" };
    registry.register({
      view: first,
      destinationId: "destination",
      invalidate: () => registry.dispose(),
    });
    registry.register({
      view: { ...first, browserId: "second" },
      destinationId: "destination",
      invalidate: visited,
    });
    expect(
      registry.invalidate({
        version: 1,
        serverId: "host",
        destinationId: "destination",
        reason: "cleanup_pending",
      }),
    ).toEqual({
      matchingViews: 2,
      failedViews: 0,
      broadcast: "failed",
    });
    expect(visited).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("R0 preserves fences and reports unavailable or failed broadcast without retries", () => {
    const key = {
      version: 1,
      serverId: "host",
      destinationId: "destination",
      reason: "cleanup_pending",
    } as const;
    const local = createWebProxyProductRegistry({ channel: null });
    expect(local.invalidate(key)).toMatchObject({ broadcast: "unavailable" });
    const channel = new BroadcastChannel(crypto.randomUUID());
    const post = vi.spyOn(channel, "postMessage").mockImplementation(() => {
      throw new Error("unavailable");
    });
    const registry = createWebProxyProductRegistry({ channel });
    const registration = {
      view: { serverId: "host", browserId: "view", workspaceId: "workspace" },
      destinationId: key.destinationId,
      invalidate: vi.fn(),
    };
    const release = registry.register(registration);
    expect(registry.invalidate(key)).toEqual({
      matchingViews: 1,
      failedViews: 0,
      broadcast: "failed",
    });
    expect(post).toHaveBeenCalledTimes(1);
    release();
    registry.invalidate({ ...key, reason: "reconcile_required" });
    expect(() => registry.register(registration)).toThrowError(
      expect.objectContaining({ reason: "cleanup_pending" }),
    );
    expect(registry.isFenced(key)).toBe(true);
    registry.dispose();
    local.dispose();
  });

  it("R0 fences before callbacks, visits all views and rejects reentrant registration", () => {
    const channel = new BroadcastChannel(crypto.randomUUID());
    const broadcast = vi.spyOn(channel, "postMessage");
    const registry = createWebProxyProductRegistry({ channel });
    const key = { serverId: "host", destinationId: "destination" };
    const visited: string[] = [];
    for (const browserId of ["first", "second", "third"]) {
      registry.register({
        view: { serverId: "host", workspaceId: "workspace", browserId },
        destinationId: key.destinationId,
        invalidate() {
          visited.push(browserId);
          expect(registry.isFenced(key)).toBe(true);
          expect(() =>
            registry.register({
              view: { serverId: "host", workspaceId: "workspace", browserId: "late" },
              destinationId: key.destinationId,
              invalidate() {},
            }),
          ).toThrow(WebProxyProductRegistryError);
          if (browserId === "first") throw new Error("callback failure");
        },
      });
    }
    try {
      expect(registry.invalidate({ ...key, version: 1, reason: "cleanup_pending" })).toEqual({
        matchingViews: 3,
        failedViews: 1,
        broadcast: "sent",
      });
      expect(visited).toEqual(["first", "second", "third"]);
      expect(broadcast).toHaveBeenCalledTimes(1);
    } finally {
      registry.dispose();
    }
  });

  it("fences every matching view synchronously without crossing host or destination", () => {
    const registry = createWebProxyProductRegistry({ channel: null });
    const first = vi.fn();
    const second = vi.fn();
    const otherHost = vi.fn();
    const otherDestination = vi.fn();
    registry.register({
      view: { serverId: "host", workspaceId: "one", browserId: "one" },
      destinationId: "destination",
      invalidate: first,
    });
    registry.register({
      view: { serverId: "host", workspaceId: "two", browserId: "two" },
      destinationId: "destination",
      invalidate: second,
    });
    registry.register({
      view: { serverId: "other", workspaceId: "one", browserId: "one" },
      destinationId: "destination",
      invalidate: otherHost,
    });
    registry.register({
      view: { serverId: "host", workspaceId: "one", browserId: "three" },
      destinationId: "different",
      invalidate: otherDestination,
    });
    const event = {
      version: 1,
      serverId: "host",
      destinationId: "destination",
      reason: "cleanup_pending",
    } as const;
    registry.invalidate(event);
    expect(first).toHaveBeenCalledExactlyOnceWith(event);
    expect(second).toHaveBeenCalledExactlyOnceWith(event);
    expect(otherHost).not.toHaveBeenCalled();
    expect(otherDestination).not.toHaveBeenCalled();
    expect(registry.isFenced(event)).toBe(true);
    registry.dispose();
  });

  it("unregisters only one view and cannot erase a cleanup fence with a reconciliation hint", () => {
    const registry = createWebProxyProductRegistry({ channel: null });
    const invalidate = vi.fn();
    const registration = {
      view: { serverId: "host", workspaceId: "one", browserId: "one" },
      destinationId: "destination",
      invalidate,
    };
    const release = registry.register(registration);
    expect(() => registry.register(registration)).toThrow(WebProxyProductRegistryError);
    release();
    const key = { version: 1, serverId: "host", destinationId: "destination" } as const;
    registry.invalidate({ ...key, reason: "cleanup_pending" });
    registry.invalidate({ ...key, reason: "reconcile_required" });
    expect(invalidate).not.toHaveBeenCalled();
    expect(registry.isFenced(key)).toBe(true);
    registry.dispose();
  });
});
