import type { BridgeHeaders, BridgeMethod, BridgeRequestMode } from "./bridge-messages";

// The broker's only way out. A concrete adapter (daemon session, SDK) owns its own opaque
// request ids, replay protection and limits; the content's requestId never reaches it.
export interface WebProxyTransportRequest {
  url: string;
  method: BridgeMethod;
  headers: BridgeHeaders;
  body: Uint8Array | null;
  // One hop per request. The adapter must not follow redirects: it returns the 3xx with its
  // Location so the broker checks the target against the capability, and the browser issues
  // the next hop as a new request that is checked again.
  redirect: "manual";
  initiator: WebProxyInitiator;
}

export interface WebProxyInitiator {
  // The destination origin D of the capability, never the content origin K. It is what the
  // adapter may send upstream as Origin; it must be an origin of the host's allowlist.
  boundOrigin: string;
  generation: number;
  mode: BridgeRequestMode;
}

export interface WebProxyTransportResponse {
  status: number;
  statusText: string;
  headers: BridgeHeaders;
  body: ReadableStream<Uint8Array> | null;
}

export interface WebProxyTransport {
  request(
    request: WebProxyTransportRequest,
    signal: AbortSignal,
  ): Promise<WebProxyTransportResponse>;
}
