import { describe, expect, it, vi } from "vitest";
import { createWebProxyProductRegistry } from "./product-registry.web";

describe("product cross-context invalidation", () => {
  it("propagates a cleanup fence without accepting authority or a clean acknowledgement", async () => {
    const name = crypto.randomUUID();
    const sender = new BroadcastChannel(name);
    const receiver = new BroadcastChannel(name);
    const first = createWebProxyProductRegistry({ channel: sender });
    const second = createWebProxyProductRegistry({ channel: receiver });
    const event = {
      version: 1,
      serverId: "host",
      destinationId: "destination",
      reason: "cleanup_pending",
    } as const;
    const invalidated = new Promise<void>((resolve) => {
      second.register({
        view: { serverId: "host", workspaceId: "second-workspace", browserId: "second-view" },
        destinationId: "destination",
        invalidate: () => resolve(),
      });
    });
    try {
      first.invalidate(event);
      expect(first.isFenced(event)).toBe(true);
      await invalidated;
      expect(second.isFenced(event)).toBe(true);
      const received = new Promise<void>((resolve) => {
        receiver.addEventListener("message", () => resolve(), { once: true });
      });
      const publish = sender.postMessage.bind(sender);
      publish({ ...event, reason: "clean", authorityEpoch: "99" });
      await received;
      expect(second.isFenced(event)).toBe(true);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("ignores malformed invalidation hints", async () => {
    const name = crypto.randomUUID();
    const sender = new BroadcastChannel(name);
    const receiver = new BroadcastChannel(name);
    const registry = createWebProxyProductRegistry({ channel: receiver });
    const invalidate = vi.fn();
    const key = { serverId: "host", destinationId: "destination" };
    registry.register({
      view: { serverId: "host", workspaceId: "workspace", browserId: "view" },
      destinationId: key.destinationId,
      invalidate,
    });
    try {
      const received = new Promise<void>((resolve) => {
        receiver.addEventListener("message", () => resolve(), { once: true });
      });
      const publish = sender.postMessage.bind(sender);
      publish({ ...key, version: 1, reason: "cleanup_pending", token: "unexpected" });
      await received;
      expect(invalidate).not.toHaveBeenCalled();
      expect(registry.isFenced(key)).toBe(false);
    } finally {
      registry.dispose();
      sender.close();
    }
  });
});
