import { describe, expect, it, vi } from "vitest";
import {
  createWebProxyProductRegistry,
  WebProxyProductRegistryError,
} from "./product-registry.web";

describe("product registry", () => {
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
