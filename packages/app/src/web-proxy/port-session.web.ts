import {
  parseContentMessage,
  type BridgeErrorCode,
  type BridgeLimits,
  type BridgeRevokeReason,
  type ControlMessage,
  type RequestMessage,
} from "./bridge-messages";
import {
  filterRequestHeaders,
  filterResponseHeaders,
  resolveDestinationUrl,
  type WebProxyCapability,
} from "./request-policy";
import type { WebProxyTransport, WebProxyTransportResponse } from "./transport";

export interface PortSessionOptions {
  port: MessagePort;
  generation: number;
  capability: WebProxyCapability;
  limits: BridgeLimits;
  transport: WebProxyTransport;
  onRevoked(reason: BridgeRevokeReason): void;
  onRedirectBlocked(requestUrl: string): void;
}

export interface PortSession {
  revoke(reason: BridgeRevokeReason): void;
}

interface InFlightRequest {
  abort: AbortController;
  unackedBytes: number;
  wakeForCredit: (() => void) | null;
}

// Serves one granted MessagePort. The port is the capability: whatever arrives on it is
// treated as hostile content and every malformed message ends the grant.
export function startPortSession(options: PortSessionOptions): PortSession {
  const { port, generation, capability, limits, transport } = options;
  const inFlight = new Map<number, InFlightRequest>();
  let revoked = false;

  function send(message: ControlMessage, transfer: Transferable[] = []): void {
    if (revoked) return;
    port.postMessage(message, transfer);
  }

  function sendError(requestId: number, code: BridgeErrorCode): void {
    send({ type: "paseo.web.response.error", v: 1, generation, requestId, code });
  }

  function finish(requestId: number, entry: InFlightRequest): void {
    if (inFlight.get(requestId) === entry) inFlight.delete(requestId);
  }

  function abortEntry(entry: InFlightRequest): void {
    entry.abort.abort();
    entry.wakeForCredit?.();
  }

  function revoke(reason: BridgeRevokeReason): void {
    if (revoked) return;
    send({ type: "paseo.web.revoke", v: 1, generation, reason });
    revoked = true;
    for (const entry of inFlight.values()) abortEntry(entry);
    inFlight.clear();
    port.removeEventListener("message", onMessage);
    port.removeEventListener("messageerror", onMessageError);
    port.removeEventListener("close", onClose);
    port.close();
    options.onRevoked(reason);
  }

  function waitForCredit(entry: InFlightRequest, bytes: number): Promise<void> {
    if (entry.unackedBytes + bytes <= limits.windowBytes || entry.abort.signal.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      entry.wakeForCredit = () => {
        entry.wakeForCredit = null;
        resolve();
      };
    }).then(() => waitForCredit(entry, bytes));
  }

  async function streamBody(input: {
    requestId: number;
    entry: InFlightRequest;
    body: ReadableStream<Uint8Array>;
  }): Promise<void> {
    const { requestId, entry } = input;
    const reader = input.body.getReader();
    entry.abort.signal.addEventListener("abort", () => void reader.cancel(), { once: true });
    for (;;) {
      const { done, value } = await reader.read();
      if (entry.abort.signal.aborted) return;
      if (done) break;
      for (let offset = 0; offset < value.byteLength; offset += limits.maxChunkBytes) {
        const piece = value.slice(offset, offset + limits.maxChunkBytes);
        await waitForCredit(entry, piece.byteLength);
        if (entry.abort.signal.aborted) return;
        entry.unackedBytes += piece.byteLength;
        const chunk = piece.buffer;
        send({ type: "paseo.web.response.chunk", v: 1, generation, requestId, chunk }, [chunk]);
      }
    }
    send({ type: "paseo.web.response.end", v: 1, generation, requestId });
  }

  async function relayResponse(input: {
    message: RequestMessage;
    url: URL;
    entry: InFlightRequest;
    response: WebProxyTransportResponse;
  }): Promise<void> {
    const { message, url, entry, response } = input;
    // A Response the service worker can construct: no 1xx/101, which WebSockets would need.
    const isConstructibleStatus = response.status >= 200 && response.status <= 599;
    if (!isConstructibleStatus) {
      await response.body?.cancel();
      sendError(message.requestId, "transport_error");
      return;
    }
    const filtered = filterResponseHeaders({
      status: response.status,
      headers: response.headers,
      requestUrl: url,
      capability,
    });
    if (filtered.kind === "redirect_blocked") {
      await response.body?.cancel();
      sendError(message.requestId, "redirect_blocked");
      options.onRedirectBlocked(url.href);
      return;
    }
    send({
      type: "paseo.web.response.head",
      v: 1,
      generation,
      requestId: message.requestId,
      status: response.status,
      statusText: response.statusText,
      headers: filtered.headers,
    });
    if (response.body === null) {
      send({ type: "paseo.web.response.end", v: 1, generation, requestId: message.requestId });
      return;
    }
    await streamBody({ requestId: message.requestId, entry, body: response.body });
  }

  async function serve(message: RequestMessage, url: URL, entry: InFlightRequest): Promise<void> {
    try {
      const response = await transport.request(
        {
          url: url.href,
          method: message.method,
          headers: filterRequestHeaders(message.headers),
          body: message.body === null ? null : new Uint8Array(message.body),
          redirect: "manual",
          initiator: { boundOrigin: capability.destinationOrigin, generation, mode: message.mode },
        },
        entry.abort.signal,
      );
      if (entry.abort.signal.aborted) {
        await response.body?.cancel();
        return;
      }
      await relayResponse({ message, url, entry, response });
    } catch {
      // Any transport or stream failure ends only this request. Its detail stays on the
      // control side: the content receives a fixed code.
      if (!entry.abort.signal.aborted) sendError(message.requestId, "transport_error");
    } finally {
      finish(message.requestId, entry);
    }
  }

  function handleRequest(message: RequestMessage): void {
    if (inFlight.has(message.requestId)) {
      revoke("protocol_error");
      return;
    }
    if (inFlight.size >= limits.maxConcurrentRequests) {
      sendError(message.requestId, "too_many_requests");
      return;
    }
    if (message.body !== null && message.body.byteLength > limits.maxRequestBodyBytes) {
      sendError(message.requestId, "body_too_large");
      return;
    }
    const resolved = resolveDestinationUrl(capability, message.path);
    if (resolved.kind !== "ok") {
      const code = resolved.kind === "invalid" ? "invalid_request" : "path_not_allowed";
      sendError(message.requestId, code);
      return;
    }
    const { url } = resolved;
    const entry: InFlightRequest = {
      abort: new AbortController(),
      unackedBytes: 0,
      wakeForCredit: null,
    };
    inFlight.set(message.requestId, entry);
    void serve(message, url, entry);
  }

  function onMessage(event: MessageEvent): void {
    const message = parseContentMessage(event.data, limits);
    if (message === null || message.generation !== generation) {
      revoke("protocol_error");
      return;
    }
    if (message.type === "paseo.web.request") {
      handleRequest(message);
      return;
    }
    // Late acks and cancels race with the end of a request; they are not violations.
    const entry = inFlight.get(message.requestId);
    if (!entry || entry.abort.signal.aborted) return;
    if (message.type === "paseo.web.cancel") {
      // The slot stays taken until serve() returns: a transport that honours the abort late
      // still holds the request and its body, and that work must count toward the limit.
      abortEntry(entry);
      return;
    }
    if (message.bytes > entry.unackedBytes) {
      revoke("protocol_error");
      return;
    }
    entry.unackedBytes -= message.bytes;
    entry.wakeForCredit?.();
  }

  function onMessageError(): void {
    revoke("protocol_error");
  }

  // The content side went away without a word (document destroyed, port garbage-collected).
  // Browsers without MessagePort "close" rely on the frame load check and on revocation.
  function onClose(): void {
    revoke("port_closed");
  }

  port.addEventListener("message", onMessage);
  port.addEventListener("messageerror", onMessageError);
  port.addEventListener("close", onClose);
  port.start();

  return { revoke };
}
