import { z } from "zod";
import type { WebProxyProductDestinationKey } from "./product-persistence.web";
import type { WebProxyProductViewIdentity } from "./product-types";

const invalidationSchema = z
  .object({
    version: z.literal(1),
    serverId: z.string().min(1).max(256),
    destinationId: z.string().min(1).max(256),
    reason: z.enum(["cleanup_pending", "reconcile_required"]),
  })
  .strict();

export type WebProxyProductInvalidation = z.infer<typeof invalidationSchema>;

export interface WebProxyProductRegistration {
  view: WebProxyProductViewIdentity;
  destinationId: string;
  invalidate(event: WebProxyProductInvalidation): void;
}

export interface WebProxyProductRegistry {
  register(registration: WebProxyProductRegistration): () => void;
  invalidate(event: WebProxyProductInvalidation): WebProxyProductFenceOutcome;
  isFenced(key: WebProxyProductDestinationKey): boolean;
  dispose(): void;
}

export interface WebProxyProductFenceOutcome {
  matchingViews: number;
  failedViews: number;
  broadcast: "sent" | "unavailable" | "failed";
}

export class WebProxyProductRegistryError extends Error {
  constructor(readonly reason: "closed" | "duplicate_view" | "cleanup_pending") {
    super(`Web proxy registry: ${reason}`);
    this.name = "WebProxyProductRegistryError";
  }
}

export interface WebProxyProductRegistryOptions {
  channel?: BroadcastChannel | null;
}

function destinationKey(key: WebProxyProductDestinationKey): string {
  return JSON.stringify([key.serverId, key.destinationId]);
}

export function createWebProxyProductRegistry(
  options: WebProxyProductRegistryOptions = {},
): WebProxyProductRegistry {
  const channel =
    options.channel === undefined
      ? new BroadcastChannel("paseo-web-proxy-product")
      : options.channel;
  const views = new Map<string, WebProxyProductRegistration>();
  const broadcast = channel === null ? null : channel.postMessage.bind(channel);
  const fences = new Set<string>();
  let disposed = false;

  function notify(event: WebProxyProductInvalidation): WebProxyProductFenceOutcome {
    const outcome: WebProxyProductFenceOutcome = {
      matchingViews: 0,
      failedViews: 0,
      broadcast: "unavailable",
    };
    if (disposed) return outcome;
    if (event.reason === "cleanup_pending") fences.add(destinationKey(event));
    const registrations = [...views.values()];
    for (const registration of registrations) {
      const matches =
        registration.view.serverId === event.serverId &&
        registration.destinationId === event.destinationId;
      if (!matches) continue;
      outcome.matchingViews += 1;
      try {
        registration.invalidate(event);
      } catch {
        outcome.failedViews += 1;
      }
    }
    return outcome;
  }

  function receive(event: MessageEvent<unknown>): void {
    const parsed = invalidationSchema.safeParse(event.data);
    if (parsed.success) notify(parsed.data);
  }

  channel?.addEventListener("message", receive);

  return {
    register(registration) {
      const key = JSON.stringify([registration.view.serverId, registration.view.browserId]);
      if (disposed) throw new WebProxyProductRegistryError("closed");
      if (
        fences.has(
          destinationKey({
            serverId: registration.view.serverId,
            destinationId: registration.destinationId,
          }),
        )
      )
        throw new WebProxyProductRegistryError("cleanup_pending");
      if (views.has(key)) throw new WebProxyProductRegistryError("duplicate_view");
      views.set(key, registration);
      return () => {
        if (views.get(key) === registration) views.delete(key);
      };
    },
    invalidate(event) {
      const parsed = invalidationSchema.parse(event);
      const wasOpen = !disposed;
      const outcome = notify(parsed);
      if (wasOpen && broadcast !== null) {
        try {
          broadcast(parsed);
          outcome.broadcast = "sent";
        } catch {
          outcome.broadcast = "failed";
        }
      }
      return outcome;
    },
    isFenced: (key) => fences.has(destinationKey(key)),
    dispose() {
      disposed = true;
      channel?.removeEventListener("message", receive);
      channel?.close();
      views.clear();
    },
  };
}
