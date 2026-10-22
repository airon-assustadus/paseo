import {
  parseContentMessage,
  suspendedReply,
  type BridgeErrorCode,
  type BridgeErrorReason,
  type BridgeLimits,
  type BridgeRequestMode,
  type BridgeRevokeReason,
  type ControlMessage,
  type LifecycleOfferMessage,
  type RequestMessage,
} from "./bridge-messages";
import {
  filterRequestHeaders,
  filterResponseHeaders,
  resolveDestinationUrl,
  type WebProxyCapability,
} from "./request-policy";
import {
  WebProxyTransportError,
  type WebProxyTransport,
  type WebProxyTransportResponse,
} from "./transport";

export interface PortSessionOptions {
  port: MessagePort;
  generation: number;
  capability: WebProxyCapability;
  limits: BridgeLimits;
  transport: WebProxyTransport;
  onRevoked(reason: BridgeRevokeReason): void;
  onRedirectBlocked(requestUrl: string): void;
  // What the content port closing means. The broker owns the answer: the current generation
  // ends the view, a generation it is already replacing is only dropped. Default: terminal.
  closePolicy?(): "terminal" | "discard";
}

export interface PortSession {
  revoke(reason: BridgeRevokeReason): void;
  // Ends this generation's authority synchronously: every request in flight is answered on
  // this port and aborted, and the port becomes a tombstone that never reaches the transport.
  quiesce(): void;
  offerLifecycle(sidePort: MessagePort, offer: string): void;
  // Lets go of the port without a revoke: the generation was replaced, not ended.
  discard(): void;
}

interface InFlightRequest {
  abort: AbortController;
  mode: BridgeRequestMode;
  headSent: boolean;
  unackedBytes: number;
  wakeForCredit: (() => void) | null;
}

type PortSessionPhase = "serving" | "tombstone" | "closed";

// Serves one granted MessagePort. The port is the capability: whatever arrives on it is
// treated as hostile content and every malformed message ends the grant.
export function startPortSession(options: PortSessionOptions): PortSession {
  const { port, generation, capability, limits, transport } = options;
  const inFlight = new Map<number, InFlightRequest>();
  let phase: PortSessionPhase = "serving";

  function post(message: ControlMessage | LifecycleOfferMessage, transfer: Transferable[]): void {
    if (phase === "closed") return;
    port.postMessage(message, transfer);
  }

  // The normal flow. A tombstone drops whatever a late continuation still tries to send.
  function send(message: ControlMessage, transfer: Transferable[] = []): void {
    if (phase !== "serving") return;
    post(message, transfer);
  }

  function sendError(requestId: number, code: BridgeErrorCode, reason?: BridgeErrorReason): void {
    const message: ControlMessage = {
      type: "paseo.web.response.error",
      v: 1,
      generation,
      requestId,
      code,
    };
    send(reason === undefined ? message : { ...message, reason });
  }

  function finish(requestId: number, entry: InFlightRequest): void {
    if (inFlight.get(requestId) === entry) inFlight.delete(requestId);
  }

  function abortEntry(entry: InFlightRequest): void {
    entry.abort.abort();
    entry.wakeForCredit?.();
  }

  function close(): void {
    phase = "closed";
    for (const entry of inFlight.values()) abortEntry(entry);
    inFlight.clear();
    port.removeEventListener("message", onMessage);
    port.removeEventListener("messageerror", onMessageError);
    port.removeEventListener("close", onClose);
    port.close();
  }

  function revoke(reason: BridgeRevokeReason): void {
    if (phase === "closed") return;
    post({ type: "paseo.web.revoke", v: 1, generation, reason }, []);
    close();
    options.onRevoked(reason);
  }

  function discard(): void {
    if (phase === "closed") return;
    close();
  }

  function quiesce(): void {
    if (phase !== "serving") return;
    phase = "tombstone";
    // Map order is arrival order, and each answer queues behind what this port already sent.
    for (const [requestId, entry] of inFlight) {
      // Once a head left, only an error can end that response; 204 is for a navigation's head.
      const mode = entry.headSent ? "subresource" : entry.mode;
      post(suspendedReply(mode, requestId, generation), []);
      abortEntry(entry);
    }
    inFlight.clear();
  }

  function offerLifecycle(sidePort: MessagePort, offer: string): void {
    if (phase !== "serving") return;
    post({ type: "paseo.web.lifecycle.offer", v: 1, generation, offer }, [sidePort]);
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

  // Returns false when the request was aborted before the body ended.
  async function pumpBody(input: {
    requestId: number;
    entry: InFlightRequest;
    reader: ReadableStreamDefaultReader<Uint8Array>;
  }): Promise<boolean> {
    const { requestId, entry, reader } = input;
    for (;;) {
      const { done, value } = await reader.read();
      if (entry.abort.signal.aborted) return false;
      if (done) return true;
      for (let offset = 0; offset < value.byteLength; offset += limits.maxChunkBytes) {
        const piece = value.slice(offset, offset + limits.maxChunkBytes);
        await waitForCredit(entry, piece.byteLength);
        if (entry.abort.signal.aborted) return false;
        entry.unackedBytes += piece.byteLength;
        const chunk = piece.buffer;
        send({ type: "paseo.web.response.chunk", v: 1, generation, requestId, chunk }, [chunk]);
      }
    }
  }

  async function streamBody(input: {
    requestId: number;
    entry: InFlightRequest;
    body: ReadableStream<Uint8Array>;
  }): Promise<void> {
    const { requestId, entry } = input;
    const reader = input.body.getReader();
    const cancellation: { done: Promise<void> | null } = { done: null };
    function cancelBody(): void {
      cancellation.done = reader.cancel();
    }
    entry.abort.signal.addEventListener("abort", cancelBody, { once: true });
    try {
      const completed = await pumpBody({ requestId, entry, reader });
      if (completed) send({ type: "paseo.web.response.end", v: 1, generation, requestId });
    } finally {
      entry.abort.signal.removeEventListener("abort", cancelBody);
      // The slot is released only once the transport has let go of the body: for a relayed
      // transport, cancel resolves when the host confirms the upstream request is gone.
      if (cancellation.done !== null) await cancellation.done;
    }
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
    entry.headSent = true;
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
    } catch (error) {
      // Any transport or stream failure ends only this request. Only a typed transport error
      // carries a reason, and only from the closed list; the rest is upstream_error.
      if (entry.abort.signal.aborted) return;
      if (error instanceof WebProxyTransportError) {
        sendError(message.requestId, error.code, error.reason);
        return;
      }
      sendError(message.requestId, "transport_error", "upstream_error");
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
      mode: message.mode,
      headSent: false,
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
    if (phase === "tombstone") {
      // Answered here, body dropped; acks and cancels have nothing left to act on.
      if (message.type === "paseo.web.request") {
        post(suspendedReply(message.mode, message.requestId, generation), []);
      }
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
    if (options.closePolicy?.() === "discard") {
      discard();
      return;
    }
    revoke("port_closed");
  }

  port.addEventListener("message", onMessage);
  port.addEventListener("messageerror", onMessageError);
  port.addEventListener("close", onClose);
  port.start();

  return { revoke, quiesce, offerLifecycle, discard };
}
