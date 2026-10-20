import {
  DEFAULT_BRIDGE_LIMITS,
  parseHello,
  validateBridgeLimits,
  type BridgeLimits,
  type BridgeRevokeReason,
  type PortGrantMessage,
} from "./bridge-messages";
import { startPortSession, type PortSession } from "./port-session.web";
import { createCapability, type WebProxyCapability } from "./request-policy";
import type { WebProxyTransport } from "./transport";

export type WebProxyBrokerState =
  | { status: "loading"; generation: number }
  | { status: "awaiting_hello"; generation: number }
  | { status: "granted"; generation: number }
  | { status: "failed"; generation: number; reason: "handshake_timeout" }
  | { status: "revoked"; generation: number; reason: BridgeRevokeReason };

export interface WebProxyBrokerOptions {
  capability: WebProxyCapability;
  transport: WebProxyTransport;
  container: HTMLElement;
  bootstrapPath: string;
  handshakeTimeoutMs: number;
  limits?: BridgeLimits;
  onStateChange?: (state: WebProxyBrokerState) => void;
  onRedirectBlocked?: (requestUrl: string) => void;
}

export interface WebProxyBroker {
  frame: HTMLIFrameElement;
  getState(): WebProxyBrokerState;
  // Ends the current grant and blanks the frame. Terminal until reopen(), which loads the
  // bootstrap again and hands out a new generation.
  revoke(reason: BridgeRevokeReason): void;
  reopen(): void;
  dispose(): void;
}

export class WebProxyBrokerSetupError extends Error {
  constructor(readonly problem: "detached_container" | "bootstrap_off_origin") {
    super(`Web proxy broker cannot start: ${problem}`);
    this.name = "WebProxyBrokerSetupError";
  }
}

const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms";

function getOwnerWindow(container: HTMLElement): Window {
  const view = container.ownerDocument.defaultView;
  if (view === null) throw new WebProxyBrokerSetupError("detached_container");
  return view;
}

function isTerminal(state: WebProxyBrokerState): boolean {
  return state.status === "revoked" || state.status === "failed";
}

// Lives on the control origin. It is the only code that holds both the transport and a frame
// of the content origin, and the content only ever sees one MessagePort per generation.
export function attachWebProxyBroker(options: WebProxyBrokerOptions): WebProxyBroker {
  const capability = createCapability(options.capability);
  const limits = validateBridgeLimits(options.limits ?? DEFAULT_BRIDGE_LIMITS);
  const ownerWindow = getOwnerWindow(options.container);
  const bootstrapUrl = new URL(options.bootstrapPath, capability.contentOrigin);
  if (bootstrapUrl.origin !== capability.contentOrigin) {
    throw new WebProxyBrokerSetupError("bootstrap_off_origin");
  }

  // oxlint-disable-next-line react/iframe-missing-sandbox -- set on the next line, before src.
  const frame = options.container.ownerDocument.createElement("iframe");
  frame.setAttribute("sandbox", FRAME_SANDBOX);
  frame.referrerPolicy = "no-referrer";
  let state: WebProxyBrokerState = { status: "loading", generation: 0 };
  let session: PortSession | null = null;
  let expectingLoad = false;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  function setState(next: WebProxyBrokerState): void {
    state = next;
    options.onStateChange?.(next);
  }

  // Ending a generation also unloads whatever the content origin left in the frame.
  function terminate(next: WebProxyBrokerState): void {
    if (handshakeTimer !== null) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    expectingLoad = false;
    setState(next);
    frame.src = "about:blank";
  }

  function revoke(reason: BridgeRevokeReason): void {
    if (isTerminal(state)) return;
    const current = session;
    session = null;
    current?.revoke(reason);
    terminate({ status: "revoked", generation: state.generation, reason });
  }

  function navigate(): void {
    expectingLoad = true;
    setState({ status: "loading", generation: state.generation + 1 });
    frame.src = bootstrapUrl.href;
  }

  function onLoad(): void {
    // A readable document is the control's own about:blank; content-origin and opaque
    // documents are never readable from here.
    if (isTerminal(state) || frame.contentDocument !== null) return;
    if (!expectingLoad) {
      // The content origin navigated its own top frame. The new document never gets the
      // current port, and its hello is ignored until the control reopens.
      revoke("frame_navigated");
      return;
    }
    expectingLoad = false;
    setState({ status: "awaiting_hello", generation: state.generation });
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null;
      if (state.status !== "awaiting_hello") return;
      terminate({ status: "failed", generation: state.generation, reason: "handshake_timeout" });
    }, options.handshakeTimeoutMs);
  }

  function grant(target: Window): void {
    if (handshakeTimer !== null) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    const channel = new MessageChannel();
    const generation = state.generation;
    const granted = startPortSession({
      port: channel.port1,
      generation,
      capability,
      limits,
      transport: options.transport,
      onRevoked: (reason) => {
        // Revocations started by the session itself (protocol errors) end the generation too.
        if (session !== granted) return;
        session = null;
        terminate({ status: "revoked", generation, reason });
      },
      onRedirectBlocked: (requestUrl) => options.onRedirectBlocked?.(requestUrl),
    });
    session = granted;
    const message: PortGrantMessage = { type: "paseo.web.port", v: 1, generation, limits };
    setState({ status: "granted", generation });
    // An exact target origin: if the frame navigated elsewhere meanwhile, nothing is delivered.
    target.postMessage(message, capability.contentOrigin, [channel.port2]);
  }

  function onWindowMessage(event: MessageEvent): void {
    if (parseHello(event.data) === null) return;
    const target = frame.contentWindow;
    const isOwnFrame =
      event.origin === capability.contentOrigin && target !== null && event.source === target;
    if (!isOwnFrame || state.status !== "awaiting_hello") return;
    grant(target);
  }

  function dispose(): void {
    revoke("disposed");
    ownerWindow.removeEventListener("message", onWindowMessage);
    frame.removeEventListener("load", onLoad);
    frame.remove();
  }

  ownerWindow.addEventListener("message", onWindowMessage);
  frame.addEventListener("load", onLoad);
  // src before insertion: the frame's first load event is the bootstrap's, not about:blank's.
  navigate();
  options.container.appendChild(frame);

  return {
    frame,
    getState: () => state,
    revoke,
    reopen: () => {
      if (isTerminal(state)) navigate();
    },
    dispose,
  };
}
