import type { Page } from "@playwright/test";

export interface PortObservation {
  frameUrl: string;
  message: Record<string, unknown>;
}

// Test-only observation. These records never supply authority or a product response.
export async function observeProductChannels(page: Page, traceReceipts = false) {
  const messages: PortObservation[] = [];
  const rpcTypes: string[] = [];
  let overflow = false;
  await page.exposeBinding("__productObservePort", ({ frame }, value: unknown) => {
    if (messages.length >= 512) {
      overflow = true;
      return;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      messages.push({ frameUrl: frame.url(), message: value as Record<string, unknown> });
    }
  });
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const message: unknown = JSON.parse(payload);
        if (!message || typeof message !== "object" || !("type" in message)) return;
        const sessionMessage =
          message.type === "session" && "message" in message ? message.message : message;
        if (!sessionMessage || typeof sessionMessage !== "object" || !("type" in sessionMessage))
          return;
        if (typeof sessionMessage.type !== "string") return;
        if (rpcTypes.length >= 2048) overflow = true;
        else rpcTypes.push(sessionMessage.type);
      } catch {
        // Non-JSON traffic is not an RPC observation.
      }
    });
  });
  await page.addInitScript((receipts) => {
    const original = MessagePort.prototype.postMessage;
    const observedPorts = new WeakSet<MessagePort>();
    let replay: ((message: unknown) => void) | null = null;
    Object.defineProperty(window, "__productReplayNavigation", {
      value: (message: unknown) => {
        if (replay === null) throw new Error("No observed navigation port");
        replay(message);
      },
    });
    MessagePort.prototype.postMessage = function (this: MessagePort, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args);
      const value = args[0];
      if (!value || typeof value !== "object" || !("type" in value)) return result;
      if (typeof value.type !== "string") return result;
      if (receipts && value.type === "paseo.web.navigation.query" && !observedPorts.has(this)) {
        observedPorts.add(this);
        // Installed after the product handler. This reports receipt, not acceptance.
        this.addEventListener("message", (event: MessageEvent<unknown>) => {
          const received = event.data;
          if (!received || typeof received !== "object" || !("type" in received)) return;
          if (
            typeof received.type !== "string" ||
            !received.type.startsWith("paseo.web.navigation.")
          )
            return;
          const observer = window as unknown as {
            __productObservePort(record: unknown): Promise<void>;
          };
          void observer.__productObservePort({
            type: "product.test.navigation.received",
            received,
          });
        });
      }
      let record: unknown = null;
      if (value.type.startsWith("paseo.web.navigation.")) {
        replay = original.bind(this);
        record = value;
      } else if (value.type === "paseo.web.response.head") {
        const head = value as Record<string, unknown>;
        record = {
          type: head.type,
          generation: head.generation,
          requestId: head.requestId,
          status: head.status,
        };
      }
      if (record !== null) {
        const observer = window as unknown as {
          __productObservePort(record: unknown): Promise<void>;
        };
        void observer.__productObservePort(record);
      }
      return result;
    };
  }, traceReceipts);
  return { messages, rpcTypes, overflow: () => overflow };
}
