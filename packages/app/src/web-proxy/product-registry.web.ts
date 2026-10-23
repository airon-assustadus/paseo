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
  invalidate(event: WebProxyProductInvalidation): void;
  isFenced(key: WebProxyProductDestinationKey): boolean;
  dispose(): void;
}

export class WebProxyProductRegistryError extends Error {
  constructor() {
    super("Web proxy view already registered or registry closed");
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

  function notify(event: WebProxyProductInvalidation): void {
    if (disposed) return;
    if (event.reason === "cleanup_pending") fences.add(destinationKey(event));
    const registrations = [...views.values()];
    for (const registration of registrations) {
      const matches =
        registration.view.serverId === event.serverId &&
        registration.destinationId === event.destinationId;
      if (matches) registration.invalidate(event);
    }
  }

  function receive(event: MessageEvent<unknown>): void {
    const parsed = invalidationSchema.safeParse(event.data);
    if (parsed.success) notify(parsed.data);
  }

  channel?.addEventListener("message", receive);

  return {
    register(registration) {
      const key = JSON.stringify([registration.view.serverId, registration.view.browserId]);
      if (disposed || views.has(key)) throw new WebProxyProductRegistryError();
      views.set(key, registration);
      return () => {
        if (views.get(key) === registration) views.delete(key);
      };
    },
    invalidate(event) {
      const parsed = invalidationSchema.parse(event);
      notify(parsed);
      if (!disposed) broadcast?.(parsed);
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
