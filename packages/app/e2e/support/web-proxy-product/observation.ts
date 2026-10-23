import type { Page } from "@playwright/test";
import type * as NetworkFetchProtocol from "@getpaseo/protocol/binary-frames/network-fetch";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Keep protocol runtime in the same ESM loader as the SDK. Playwright transforms
// static imports in this CommonJS test package and otherwise mixes the graphs.
export async function loadProductFetchProtocol(): Promise<typeof NetworkFetchProtocol> {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, "../../../../../packages/protocol/dist/binary-frames/network-fetch.js"),
  ).href;
  return import(moduleUrl) as Promise<typeof NetworkFetchProtocol>;
}

export interface FetchObservation {
  at: number;
  direction: "sent" | "received";
  type: string;
  fields: Record<string, string | number | boolean | null>;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function projectRpc(payload: string): { type: string; fields: FetchObservation["fields"] } | null {
  let envelope: Record<string, unknown> | null;
  try {
    envelope = object(JSON.parse(payload));
  } catch {
    return null;
  }
  const message = envelope?.type === "session" ? object(envelope.message) : envelope;
  if (!message || typeof message.type !== "string") return null;
  if (message.type === "hello") {
    const hello = object(message.payload) ?? message;
    return {
      type: "hello",
      fields: typeof hello.clientId === "string" ? { clientId: hello.clientId.slice(0, 128) } : {},
    };
  }
  if (message.type === "server_info") return { type: message.type, fields: {} };
  if (!message.type.startsWith("network.fetch.")) return null;
  const body = object(message.payload) ?? message;
  return { type: message.type, fields: projectFetchFields(body) };
}

function projectFetchFields(body: Record<string, unknown>): FetchObservation["fields"] {
  const descriptor = object(body.descriptor) ?? {};
  const fields: FetchObservation["fields"] = {};
  for (const key of [
    "requestId",
    "subscriptionId",
    "destinationId",
    "authorityEpoch",
    "expectedAuthorityEpoch",
    "cleanupRequiredEpoch",
    "allowlistRevision",
    "state",
    "reason",
    "ok",
    "contentOrigin",
    "assetVersion",
  ]) {
    const value = key in body ? body[key] : descriptor[key];
    if (value === null || typeof value === "boolean" || typeof value === "number")
      fields[key] = value;
    else if (typeof value === "string" && value.length <= 8192) fields[key] = value;
  }
  const error = object(body.error);
  if (typeof error?.code === "string") fields.errorCode = error.code.slice(0, 128);
  return fields;
}

export interface PortObservation {
  frameUrl: string;
  message: Record<string, unknown>;
}

// Test-only observation. These records never supply authority or a product response.
export async function observeProductChannels(page: Page, traceReceipts = false) {
  const { decodeNetworkFetchFrame } = await loadProductFetchProtocol();
  const messages: PortObservation[] = [];
  const rpcTypes: string[] = [];
  const fetchEvents: FetchObservation[] = [];
  const browserOpenTimes: Array<{ requestId: string; at: number }> = [];
  let overflow = false;
  const recordFetch = (
    direction: FetchObservation["direction"],
    type: string,
    fields: FetchObservation["fields"],
  ) => {
    if (fetchEvents.length >= 2048) overflow = true;
    else fetchEvents.push({ at: performance.now(), direction, type, fields });
  };
  await page.exposeBinding("__productObserveOpenClock", ({ frame }, value: unknown) => {
    const input = object(value);
    if (
      frame !== page.mainFrame() ||
      !input ||
      typeof input.requestId !== "string" ||
      input.requestId.length > 128 ||
      typeof input.at !== "number" ||
      !Number.isFinite(input.at)
    )
      return;
    if (browserOpenTimes.length >= 2048) overflow = true;
    else browserOpenTimes.push({ requestId: input.requestId, at: input.at });
  });
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
    const observeFrame = (direction: FetchObservation["direction"], payload: string | Buffer) => {
      if (typeof payload === "string") {
        const projected = projectRpc(payload);
        if (projected) recordFetch(direction, projected.type, projected.fields);
        return;
      }
      const decoded = decodeNetworkFetchFrame(
        payload,
        direction === "sent" ? "client_to_host" : "host_to_client",
      );
      if (decoded)
        recordFetch(direction, "binary", {
          opcode: decoded.opcode,
          subscriptionId: decoded.subscriptionId,
          fetchId: decoded.fetchId,
          bytes: payload.byteLength,
        });
    };
    socket.on("framereceived", ({ payload }) => observeFrame("received", payload));
    socket.on("framesent", ({ payload }) => {
      observeFrame("sent", payload);
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
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, ...args: Parameters<WebSocket["send"]>) {
      const at = performance.now();
      const result = Reflect.apply(originalSend, this, args);
      try {
        if (typeof args[0] !== "string") return result;
        const envelope = JSON.parse(args[0]);
        const message = envelope.type === "session" ? envelope.message : envelope;
        if (
          message?.type === "network.fetch.open.request" &&
          typeof message.requestId === "string"
        ) {
          const observer = window as unknown as {
            __productObserveOpenClock(value: unknown): Promise<void>;
          };
          void observer
            .__productObserveOpenClock({ requestId: message.requestId, at })
            .catch(() => undefined);
        }
      } catch {
        /* Observation cannot alter the transport result. */
      }
      return result;
    };
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
      } else if (value.type === "paseo.web.suspend") {
        const suspend = value as Record<string, unknown>;
        record = { type: suspend.type, generation: suspend.generation, reason: suspend.reason };
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
  return { messages, rpcTypes, fetchEvents, browserOpenTimes, overflow: () => overflow };
}
