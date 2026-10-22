import {
  DEFAULT_BRIDGE_LIMITS,
  PURGE_DEADLINE_MS,
  createLifecycleToken,
  parseHello,
  parseLifecycleToBroker,
  parseResumed,
  validateBridgeLimits,
  type BridgeLimits,
  type BridgeRevokeReason,
  type LifecycleSuspendReason,
  type LifecycleToBrokerMessage,
  type LifecycleToShellMessage,
  type NavigationDroppedMessage,
  type PortGrantMessage,
  type PurgedMessage,
} from "./bridge-messages";
import { startPortSession, type PortSession } from "./port-session.web";
import { createCapability, type WebProxyCapability } from "./request-policy";
import type { WebProxyTransport } from "./transport";

export type WebProxyLifecycle = "negotiating" | "ready" | "unavailable";

export interface WebProxyNavigationDrops {
  head_timeout: number;
  transport_closed: number;
  suspended: number;
}

export type WebProxyResumeFailure =
  | "not_suspended"
  | "ack_timeout"
  | "ack_invalid"
  | "ack_port_closed"
  | "transport_lost"
  | "terminal";

export type WebProxyTerminalCause = "ack_timeout" | "ack_invalid" | "ack_port_closed";

interface LifecycleFields {
  lifecycle: WebProxyLifecycle;
  workerArmed: boolean;
  navigationDrops: WebProxyNavigationDrops;
  // The shell answered paseo.web.purge.capable. Diagnostic.
  purgeCapable: boolean;
}

// Authoritative purge (lifecycle contract §5.9, synthetic bench only). `sent` says whether this
// view ever posted paseo.web.purge: only sent: false proves the view caused no worker request.
// The booleans are the cooperating shell's operational confirmation, never proof against hostile
// content (L-P8).
export type WebProxyPurgeOutcome =
  | {
      kind: "purged";
      op: string;
      sent: true;
      localStorage: boolean;
      sessionStorage: boolean;
      caches: boolean;
      indexedDB: boolean;
      unregistered: boolean;
    }
  | { kind: "unsupported"; op: string; sent: false }
  | { kind: "timeout"; op: string; sent: true }
  | { kind: "interrupted"; op: string; sent: boolean };

export type WebProxyBrokerState =
  | { status: "loading"; generation: number }
  | { status: "awaiting_hello"; generation: number }
  | ({ status: "granted"; generation: number } & LifecycleFields)
  | ({
      status: "suspended";
      generation: number;
      reason: LifecycleSuspendReason;
      // From the shell's paseo.web.suspended; null until it arrives.
      documentKept: boolean | null;
      lastResumeFailure: "transport_lost" | null;
    } & LifecycleFields)
  | ({ status: "resuming"; previous: number; generation: number } & LifecycleFields)
  | ({ status: "purging"; generation: number; op: string } & LifecycleFields)
  | { status: "failed"; generation: number; reason: "handshake_timeout" }
  | {
      status: "revoked";
      generation: number;
      reason: BridgeRevokeReason;
      cause?: WebProxyTerminalCause;
      // Only on the authoritative path.
      purge?: WebProxyPurgeOutcome;
    };

export type WebProxyResumeResult =
  | { kind: "resumed"; previous: number; generation: number; documentPreserved: boolean }
  | { kind: "failed"; reason: WebProxyResumeFailure };

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
  // Ends the current generation's authority synchronously and keeps the document, without
  // input. False when the shell has no lifecycle: the caller then revokes as before.
  suspend(reason: LifecycleSuspendReason): boolean;
  // Hands a new generation, served by `transport`, to the suspended shell. Authority starts
  // only with the shell's acknowledgement on the new port.
  resume(input: { transport: WebProxyTransport }): Promise<WebProxyResumeResult>;
  // Authoritative close of this view: fences it at once, asks the shell to purge its origin, and
  // ends the view on the report, on the deadline or on an interruption. Never called by a loss or
  // by closeView.
  purge(input: { op: string }): Promise<WebProxyPurgeOutcome>;
}

interface Purging {
  op: string;
  timer: ReturnType<typeof setTimeout>;
  // A malformed message or messageerror on any port while purging: it never closes a port, and
  // it turns the result into an interruption even if the report arrives.
  violation: boolean;
  settle(outcome: WebProxyPurgeOutcome): void;
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

// A refused acknowledgement ends the view with a reason the wire already has.
const TERMINAL_WIRE_REASON: Record<WebProxyTerminalCause, BridgeRevokeReason> = {
  ack_invalid: "protocol_error",
  ack_port_closed: "port_closed",
  ack_timeout: "protocol_error",
};

// The side port belongs to the shell instance: it travels inside the first generation's request
// port and outlives generations.
interface SidePort {
  port: MessagePort;
  offer: string;
  generation: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Resumption {
  previous: number;
  generation: number;
  port: MessagePort;
  transport: WebProxyTransport;
  timer: ReturnType<typeof setTimeout>;
  lost: LifecycleSuspendReason | null;
  settle(result: WebProxyResumeResult): void;
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
  let side: SidePort | null = null;
  let resumption: Resumption | null = null;
  let lifecycle: WebProxyLifecycle = "negotiating";
  let workerArmed = false;
  let purgeCapable = false;
  let purgeQueryNonce: string | null = null;
  // Sticky for the life of the view: once a purge was posted, it never reads false again.
  let purgeSent = false;
  let purging: Purging | null = null;
  const navigationDrops: WebProxyNavigationDrops = {
    head_timeout: 0,
    transport_closed: 0,
    suspended: 0,
  };
  const suspendedDropGenerations = new Set<number>();

  function setState(next: WebProxyBrokerState): void {
    state = next;
    options.onStateChange?.(next);
  }

  function lifecycleFields(): LifecycleFields {
    return { lifecycle, workerArmed, navigationDrops: { ...navigationDrops }, purgeCapable };
  }

  function publishLifecycle(): void {
    const status = state.status;
    const hasLifecycle =
      status === "granted" ||
      status === "suspended" ||
      status === "resuming" ||
      status === "purging";
    if (hasLifecycle) setState({ ...state, ...lifecycleFields() });
  }

  function clearHandshakeTimer(): void {
    if (handshakeTimer !== null) clearTimeout(handshakeTimer);
    handshakeTimer = null;
  }

  function closeSidePort(): void {
    if (side === null) return;
    if (side.timer !== null) clearTimeout(side.timer);
    side.port.removeEventListener("message", onSideMessage);
    side.port.removeEventListener("messageerror", onSideMessageError);
    side.port.removeEventListener("close", onSidePortClosed);
    side.port.close();
    side = null;
  }

  function sendToShell(message: LifecycleToShellMessage, transfer: Transferable[] = []): void {
    side?.port.postMessage(message, transfer);
  }

  // Takes the pending resumption out of play: its port closes, a late acknowledgement is lost.
  function abandonResumption(result: WebProxyResumeResult): void {
    const current = resumption;
    if (current === null) return;
    resumption = null;
    clearTimeout(current.timer);
    current.port.removeEventListener("message", onAdoptionMessage);
    current.port.removeEventListener("messageerror", onAdoptionMessageError);
    current.port.removeEventListener("close", onAdoptionPortClosed);
    current.port.close();
    current.settle(result);
  }

  // Ending a generation also unloads whatever the content origin left in the frame.
  function terminate(next: WebProxyBrokerState): void {
    clearHandshakeTimer();
    abandonResumption({ kind: "failed", reason: "terminal" });
    closeSidePort();
    setState(next);
    frame?.remove();
    frame = null;
  }

  function revoke(reason: BridgeRevokeReason, cause?: WebProxyTerminalCause): void {
    if (isTerminal(state)) return;
    if (purging !== null) {
      // A loss is absorbed: the view is already fenced and only the purge decides its end.
      if (reason !== "transport_closed")
        finishPurge({ kind: "interrupted", op: purging.op, sent: true });
      return;
    }
    const current = session;
    session = null;
    current?.revoke(reason);
    // A generation being adopted never held authority: the view ends on the one that did.
    const generation = state.status === "resuming" ? state.previous : state.generation;
    terminate(
      cause === undefined
        ? { status: "revoked", generation, reason }
        : { status: "revoked", generation, reason, cause },
    );
  }

  // The seam the authoritative revocation reuses: authority ends, the frame stays.
  function fence(): void {
    session?.quiesce();
    if (frame !== null) frame.inert = true;
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

  function startSession(input: {
    port: MessagePort;
    generation: number;
    transport: WebProxyTransport;
  }): PortSession {
    const { generation } = input;
    const started = startPortSession({
      port: input.port,
      generation,
      capability,
      limits,
      transport: input.transport,
      onRevoked: (reason) => {
        // Revocations started by the session itself (protocol errors) end the generation too.
        if (session !== started) return;
        session = null;
        terminate({ status: "revoked", generation, reason });
      },
      onRedirectBlocked: (requestUrl) => options.onRedirectBlocked?.(requestUrl),
      // While a new generation is being adopted or a purge runs, the shell may drop this port on
      // its own; the purge goes on over the side port.
      closePolicy: () =>
        session === started && state.status !== "resuming" && state.status !== "purging"
          ? "terminal"
          : "discard",
      onViolation: () => {
        if (purging === null) return "revoke";
        purging.violation = true;
        return "absorb";
      },
    });
    return started;
  }

  function offerLifecycle(granted: PortSession, generation: number): void {
    const channel = new MessageChannel();
    const offered: SidePort = {
      port: channel.port1,
      offer: createLifecycleToken(),
      generation,
      timer: null,
    };
    side = offered;
    // COMPAT(web-proxy-lifecycle): a shell published before the lifecycle never accepts and
    // its losses revoke as before; remove after the minimum published shell accepts.
    offered.timer = setTimeout(() => {
      offered.timer = null;
      if (side !== offered || lifecycle !== "negotiating") return;
      closeSidePort();
      lifecycle = "unavailable";
      publishLifecycle();
    }, options.handshakeTimeoutMs);
    channel.port1.addEventListener("message", onSideMessage);
    channel.port1.addEventListener("messageerror", onSideMessageError);
    channel.port1.addEventListener("close", onSidePortClosed);
    channel.port1.start();
    granted.offerLifecycle(channel.port2, offered.offer);
  }

  function grant(target: Window): void {
    clearHandshakeTimer();
    const channel = new MessageChannel();
    const generation = state.generation;
    const granted = startSession({ port: channel.port1, generation, transport: options.transport });
    session = granted;
    lifecycle = "negotiating";
    workerArmed = false;
    const message: PortGrantMessage = { type: "paseo.web.port", v: 1, generation, limits };
    setState({ status: "granted", generation, ...lifecycleFields() });
    // An exact target origin: if the frame navigated elsewhere meanwhile, nothing is delivered.
    target.postMessage(message, capability.contentOrigin, [channel.port2]);
    offerLifecycle(granted, generation);
  }

  function countDrop(message: NavigationDroppedMessage): void {
    if (message.cause === "suspended") {
      if (suspendedDropGenerations.has(message.generation)) return;
      suspendedDropGenerations.add(message.generation);
    }
    navigationDrops[message.cause] += 1;
    publishLifecycle();
  }

  function acceptSideMessage(message: LifecycleToBrokerMessage): boolean {
    if (message.type === "paseo.web.lifecycle.accept") {
      const isOffered =
        lifecycle === "negotiating" &&
        side !== null &&
        message.generation === side.generation &&
        message.offer === side.offer;
      if (!isOffered || side === null) return false;
      if (side.timer !== null) clearTimeout(side.timer);
      side.timer = null;
      sendToShell({
        type: "paseo.web.lifecycle.ready",
        v: 1,
        generation: side.generation,
        offer: side.offer,
      });
      // Asked once and never announced by the shell: a C without purge would revoke on it.
      purgeQueryNonce = createLifecycleToken();
      sendToShell({ type: "paseo.web.purge.query", v: 1, nonce: purgeQueryNonce });
      lifecycle = "ready";
      publishLifecycle();
      return true;
    }
    if (lifecycle !== "ready") return false;
    if (message.type === "paseo.web.purge.capable") {
      if (purgeQueryNonce === null || message.nonce !== purgeQueryNonce) return false;
      purgeQueryNonce = null;
      purgeCapable = true;
      publishLifecycle();
      return true;
    }
    if (message.type === "paseo.web.purged") {
      // Outside a purge, or for another operation, a well-formed report changes nothing.
      if (purging !== null && message.op === purging.op) finishPurge(purgedOutcome(message));
      return true;
    }
    if (message.type === "paseo.web.lifecycle.state") {
      workerArmed = message.workerArmed;
      publishLifecycle();
      return true;
    }
    if (message.type === "paseo.web.navigation.dropped") {
      countDrop(message);
      return true;
    }
    // Informative, and it may race a newer generation; only the matching one is recorded.
    if (
      state.status === "suspended" &&
      state.generation === message.generation &&
      state.documentKept === null
    ) {
      setState({ ...state, documentKept: message.documentKept });
    }
    return true;
  }

  // While purging, a violation is recorded instead of ending the view: no port closes before the
  // purge's terminal, and the result becomes an interruption.
  function violate(): void {
    if (purging !== null) {
      purging.violation = true;
      return;
    }
    revoke("protocol_error");
  }

  // The side port carries content from the content origin: a malformed message ends the view.
  function onSideMessage(event: MessageEvent): void {
    const message = parseLifecycleToBroker(event.data);
    if (message === null || event.ports.length > 0 || !acceptSideMessage(message)) violate();
  }

  function onSideMessageError(): void {
    violate();
  }

  function onSidePortClosed(): void {
    if (purging !== null) {
      finishPurge({ kind: "interrupted", op: purging.op, sent: true });
      return;
    }
    if (state.status === "suspended" || state.status === "resuming") {
      revoke("port_closed");
      return;
    }
    closeSidePort();
    lifecycle = "unavailable";
    publishLifecycle();
  }

  function suspend(reason: LifecycleSuspendReason): boolean {
    // Already fenced: a loss changes nothing while the purge runs.
    if (purging !== null) return true;
    if (state.status === "resuming" && resumption !== null) {
      resumption.lost ??= reason;
      return true;
    }
    if (state.status !== "granted" || lifecycle !== "ready" || session === null) return false;
    const { generation } = state;
    fence();
    setState({
      status: "suspended",
      generation,
      reason,
      documentKept: null,
      lastResumeFailure: null,
      ...lifecycleFields(),
    });
    sendToShell({ type: "paseo.web.suspend", v: 1, generation, reason });
    return true;
  }

  function refuseAdoption(cause: WebProxyTerminalCause): void {
    abandonResumption({ kind: "failed", reason: cause });
    revoke(TERMINAL_WIRE_REASON[cause], cause);
  }

  function adopt(current: Resumption, documentKept: boolean): void {
    resumption = null;
    clearTimeout(current.timer);
    current.port.removeEventListener("message", onAdoptionMessage);
    current.port.removeEventListener("messageerror", onAdoptionMessageError);
    current.port.removeEventListener("close", onAdoptionPortClosed);
    session?.discard();
    const { previous, generation, lost } = current;
    const adopted = startSession({ port: current.port, generation, transport: current.transport });
    session = adopted;
    if (lost !== null) {
      // The candidate leg died before the acknowledgement: the new generation is born fenced.
      adopted.quiesce();
      setState({
        status: "suspended",
        generation,
        reason: lost,
        documentKept: null,
        lastResumeFailure: "transport_lost",
        ...lifecycleFields(),
      });
      sendToShell({ type: "paseo.web.suspend", v: 1, generation, reason: lost });
      current.settle({ kind: "failed", reason: "transport_lost" });
      return;
    }
    if (frame !== null) frame.inert = false;
    setState({ status: "granted", generation, ...lifecycleFields() });
    current.settle({ kind: "resumed", previous, generation, documentPreserved: documentKept });
  }

  // The first message on the new port must be the acknowledgement, and nothing else.
  function onAdoptionMessage(event: MessageEvent): void {
    const current = resumption;
    if (current === null) return;
    const message = parseResumed(event.data);
    const isAcknowledgement =
      message !== null &&
      event.ports.length === 0 &&
      message.previous === current.previous &&
      message.generation === current.generation;
    if (!isAcknowledgement || message === null) {
      refuseAdoption("ack_invalid");
      return;
    }
    adopt(current, message.documentKept);
  }

  function onAdoptionMessageError(): void {
    refuseAdoption("ack_port_closed");
  }

  function onAdoptionPortClosed(): void {
    refuseAdoption("ack_port_closed");
  }

  function resume(input: { transport: WebProxyTransport }): Promise<WebProxyResumeResult> {
    if (state.status !== "suspended") {
      return Promise.resolve({ kind: "failed", reason: "not_suspended" });
    }
    const previous = state.generation;
    const generation = previous + 1;
    const channel = new MessageChannel();
    const settled = Promise.withResolvers<WebProxyResumeResult>();
    resumption = {
      previous,
      generation,
      port: channel.port1,
      transport: input.transport,
      timer: setTimeout(() => refuseAdoption("ack_timeout"), options.handshakeTimeoutMs),
      lost: null,
      settle: settled.resolve,
    };
    channel.port1.addEventListener("message", onAdoptionMessage);
    channel.port1.addEventListener("messageerror", onAdoptionMessageError);
    channel.port1.addEventListener("close", onAdoptionPortClosed);
    channel.port1.start();
    setState({ status: "resuming", previous, generation, ...lifecycleFields() });
    sendToShell({ type: "paseo.web.resume", v: 1, previous, generation, limits }, [channel.port2]);
    return settled.promise;
  }

  function onWindowMessage(event: MessageEvent): void {
    if (parseHello(event.data) === null) return;
    const target = frame?.contentWindow ?? null;
    const isOwnFrame =
      event.origin === capability.contentOrigin && target !== null && event.source === target;
    if (!isOwnFrame || state.status !== "awaiting_hello") return;
    grant(target);
  }

  function purgedOutcome(message: PurgedMessage): WebProxyPurgeOutcome {
    const { op, localStorage, sessionStorage, caches, indexedDB, unregistered } = message;
    return {
      kind: "purged",
      op,
      sent: true,
      localStorage,
      sessionStorage,
      caches,
      indexedDB,
      unregistered,
    };
  }

  // The purge's terminal: ports first (the retained candidate port included), then the frame,
  // then the pending resume.
  function finishPurge(outcome: WebProxyPurgeOutcome): void {
    const current = purging;
    if (current === null) return;
    purging = null;
    clearTimeout(current.timer);
    const final: WebProxyPurgeOutcome = current.violation
      ? { kind: "interrupted", op: current.op, sent: true }
      : outcome;
    const reason: BridgeRevokeReason = current.violation ? "protocol_error" : "transport_closed";
    const { generation } = state;
    const tomb = session;
    session = null;
    tomb?.revoke(reason);
    const candidate = resumption;
    resumption = null;
    candidate?.port.close();
    terminate({ status: "revoked", generation, reason, purge: final });
    candidate?.settle({ kind: "failed", reason: "terminal" });
    current.settle(final);
  }

  function endUnsupported(op: string): WebProxyPurgeOutcome {
    const outcome: WebProxyPurgeOutcome = { kind: "unsupported", op, sent: false };
    const generation = state.status === "resuming" ? state.previous : state.generation;
    const current = session;
    session = null;
    current?.revoke("transport_closed");
    terminate({ status: "revoked", generation, reason: "transport_closed", purge: outcome });
    return outcome;
  }

  // B1: the late acknowledgement must not grant, publish or reopen, and neither the candidate port
  // nor g closes before the purge's terminal; the resume promise stays pending until then (G4).
  function detachAdoption(current: Resumption): void {
    clearTimeout(current.timer);
    current.port.removeEventListener("message", onAdoptionMessage);
    current.port.removeEventListener("messageerror", onAdoptionMessageError);
    current.port.removeEventListener("close", onAdoptionPortClosed);
  }

  // Synchronous until it returns the promise: the view is fenced before the caller moves on (B5).
  function purge(input: { op: string }): Promise<WebProxyPurgeOutcome> {
    const { op } = input;
    if (isTerminal(state)) return Promise.resolve({ kind: "interrupted", op, sent: purgeSent });
    if (purging !== null) return Promise.resolve({ kind: "interrupted", op, sent: true });
    const status = state.status;
    const isPurgeable =
      purgeCapable &&
      side !== null &&
      (status === "granted" || status === "suspended" || status === "resuming");
    if (!isPurgeable) return Promise.resolve(endUnsupported(op));
    if (state.status === "resuming" && resumption !== null) detachAdoption(resumption);
    const generation = state.status === "resuming" ? state.previous : state.generation;
    fence();
    const settled = Promise.withResolvers<WebProxyPurgeOutcome>();
    const timer = setTimeout(
      () => finishPurge({ kind: "timeout", op, sent: true }),
      PURGE_DEADLINE_MS,
    );
    purging = { op, timer, violation: false, settle: settled.resolve };
    setState({ status: "purging", generation, op, ...lifecycleFields() });
    purgeSent = true;
    sendToShell({ type: "paseo.web.purge", v: 1, op });
    return settled.promise;
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
    revoke: (reason) => revoke(reason),
    reopen: () => {
      if (isTerminal(state)) navigate();
    },
    dispose,
    suspend,
    resume,
    purge,
  };
}
