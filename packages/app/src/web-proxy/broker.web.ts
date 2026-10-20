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
  // The frame of the current generation; null once the generation ended. Every generation gets
  // a fresh element, so no late event of a previous document can be mistaken for the next one.
  getFrame(): HTMLIFrameElement | null;
  getState(): WebProxyBrokerState;
  // Ends the current grant and removes the frame. Terminal until reopen(), which loads the
  // bootstrap in a new frame and hands out a new generation.
  revoke(reason: BridgeRevokeReason): void;
  reopen(): void;
  dispose(): void;
}

export class WebProxyBrokerSetupError extends Error {
  constructor(
    readonly problem: "detached_container" | "bootstrap_off_origin" | "content_origin_is_control",
  ) {
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
  // Content on the control origin would read the control's DOM and storage. Same registrable
  // site cannot be checked here (no PSL); that stays a deployment gate.
  if (capability.contentOrigin === ownerWindow.location.origin) {
    throw new WebProxyBrokerSetupError("content_origin_is_control");
  }
  const bootstrapUrl = new URL(options.bootstrapPath, capability.contentOrigin);
  if (bootstrapUrl.origin !== capability.contentOrigin) {
    throw new WebProxyBrokerSetupError("bootstrap_off_origin");
  }

  let state: WebProxyBrokerState = { status: "loading", generation: 0 };
  let frame: HTMLIFrameElement | null = null;
  let session: PortSession | null = null;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  function setState(next: WebProxyBrokerState): void {
    state = next;
    options.onStateChange?.(next);
  }

  function clearHandshakeTimer(): void {
    if (handshakeTimer !== null) clearTimeout(handshakeTimer);
    handshakeTimer = null;
  }

  // Ending a generation also unloads whatever the content origin left in the frame.
  function terminate(next: WebProxyBrokerState): void {
    clearHandshakeTimer();
    setState(next);
    frame?.remove();
    frame = null;
  }

  function revoke(reason: BridgeRevokeReason): void {
    if (isTerminal(state)) return;
    const current = session;
    session = null;
    current?.revoke(reason);
    terminate({ status: "revoked", generation: state.generation, reason });
  }

  function createFrame(): HTMLIFrameElement {
    // oxlint-disable-next-line react/iframe-missing-sandbox -- set on the next line, before src.
    const created = options.container.ownerDocument.createElement("iframe");
    created.setAttribute("sandbox", FRAME_SANDBOX);
    created.referrerPolicy = "no-referrer";
    let awaitingBootstrap = true;
    created.addEventListener("load", () => {
      if (created !== frame || isTerminal(state)) return;
      if (!awaitingBootstrap) {
        // The content origin navigated its own top frame. The new document never gets the
        // current port, and its hello is ignored until the control reopens.
        revoke("frame_navigated");
        return;
      }
      // Before the bootstrap commits, the only readable document is the element's initial
      // about:blank, which belongs to this origin; the bootstrap (another origin) never is.
      if (created.contentDocument !== null) return;
      awaitingBootstrap = false;
      setState({ status: "awaiting_hello", generation: state.generation });
    });
    return created;
  }

  // The deadline covers loading and the hello: a bootstrap that never loads fails too.
  function navigate(): void {
    const generation = state.generation + 1;
    setState({ status: "loading", generation });
    frame = createFrame();
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null;
      if (state.status !== "loading" && state.status !== "awaiting_hello") return;
      terminate({ status: "failed", generation, reason: "handshake_timeout" });
    }, options.handshakeTimeoutMs);
    // src before insertion, so the first navigation the element performs is the bootstrap's.
    frame.src = bootstrapUrl.href;
    options.container.appendChild(frame);
  }

  function grant(target: Window): void {
    clearHandshakeTimer();
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
    const target = frame?.contentWindow ?? null;
    const isOwnFrame =
      event.origin === capability.contentOrigin && target !== null && event.source === target;
    if (!isOwnFrame || state.status !== "awaiting_hello") return;
    grant(target);
  }

  function dispose(): void {
    revoke("disposed");
    clearHandshakeTimer();
    frame?.remove();
    frame = null;
    ownerWindow.removeEventListener("message", onWindowMessage);
  }

  ownerWindow.addEventListener("message", onWindowMessage);
  navigate();

  return {
    getFrame: () => frame,
    getState: () => state,
    revoke,
    reopen: () => {
      if (isTerminal(state)) navigate();
    },
    dispose,
  };
}
