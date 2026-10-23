import {
  BRIDGE_VERSION,
  createLifecycleToken,
  parseContentMessage,
  parseControlMessage,
  parseLifecycleOffer,
  parseLifecycleToShell,
  parsePortGrant,
  PURGE_WORKER_BUDGET_MS,
  suspendedReply,
  type BridgeLimits,
  type BridgeRequestMode,
  type BridgeRevokeReason,
  type ContentMessage,
  type ControlMessage,
  type HelloMessage,
  type LifecycleToBrokerMessage,
  type PurgeMessage,
  type PurgeQueryMessage,
  type ResumeMessage,
  type SuspendMessage,
} from "../bridge-messages";
import { parseNavigationToShell, type NavigationQueryMessage } from "../navigation-messages";
import { parseShellNavigationReady } from "./navigation-binding";
import { createShellNavigation } from "./navigation.web";
import { enterProductNavigation } from "./navigation-entry.web";
import {
  isResync,
  parseLifecycleArmed,
  parseShellPurged,
  parseShellRequestMessage,
  parseWorkerToBootstrapMessage,
  readShellFetchFields,
  type ShellAckMessage,
  type ShellCancelMessage,
  type ShellDropCause,
  type ShellLifecycleArmMessage,
  type ShellPurgeMessage,
  type ShellPurgeResult,
  type ShellResyncReplyMessage,
  type ShellSessionCloseMessage,
  type ShellSessionOpenMessage,
  type ShellTicketPrepareMessage,
  type ShellWorkerToBootstrapMessage,
} from "./relay-messages";

export type ShellBootstrapStatus =
  | "no_session"
  | "registering"
  | "worker_failed"
  | "awaiting_grant"
  | "session_refused"
  | "ready"
  | "suspended"
  | "revoked";

export interface ShellBootstrapOptions {
  navigation?: { assetVersion: string };
  window: Window;
  // A deploy constant. Never read from the URL: a hostile framer could name itself.
  controlOrigin: string;
  workerUrl: string;
  workerScope: string;
  workerType: WorkerType;
  // The worker's entry path; the app frame starts there with a one-time ticket.
  enterPath: string;
  // How long the worker may take to answer session.open and ticket.prepare.
  sessionReplyTimeoutMs: number;
}

interface Grant {
  port: MessagePort;
  generation: number;
  limits: BridgeLimits;
}

function isFramedByControl(win: Window, controlOrigin: string): boolean {
  if (win.parent === win || !("ancestorOrigins" in win.location)) return false;
  const ancestors = win.location.ancestorOrigins;
  return ancestors.length > 0 && ancestors[0] === controlOrigin;
}

function waitForActivation(registration: ServiceWorkerRegistration): Promise<void> {
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (worker === null) return Promise.reject(new Error("Service worker registration is empty"));
  if (worker.state === "activated") return Promise.resolve();
  return new Promise((resolve, reject) => {
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") resolve();
      if (worker.state === "redundant") reject(new Error("Service worker became redundant"));
    });
  });
}

function showStatus(doc: Document, status: ShellBootstrapStatus): void {
  doc.body.dataset.paseoShell = status;
  const label = doc.getElementById("paseo-shell-status");
  if (label) label.textContent = status;
}

// The parent's iframe load event and this page's hello cross processes in either order, and
// the broker only accepts a hello after that load. Repeating it until the grant removes the race.
const HELLO_RETRY_MS = 250;

// Installed before anything else, so a grant that arrives early is never lost.
function listenForGrant(options: ShellBootstrapOptions): Promise<Grant> {
  const win = options.window;
  return new Promise((resolve) => {
    function onMessage(event: MessageEvent): void {
      if (event.origin !== options.controlOrigin || event.source !== win.parent) return;
      const grant = parsePortGrant(event.data);
      const port = event.ports[0];
      if (grant === null || event.ports.length !== 1 || port === undefined) return;
      win.removeEventListener("message", onMessage);
      resolve({ port, generation: grant.generation, limits: grant.limits });
    }
    win.addEventListener("message", onMessage);
  });
}

function announceUntilGranted(options: ShellBootstrapOptions, granted: Promise<Grant>): void {
  const hello: HelloMessage = { type: "paseo.web.hello", v: BRIDGE_VERSION };
  const post = () => options.window.parent.postMessage(hello, options.controlOrigin);
  post();
  const timer = setInterval(post, HELLO_RETRY_MS);
  void granted.then(() => clearInterval(timer));
}

// 16 random bytes, base64url: correlation for the worker, not a secret from same-origin code.
function createTicket(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface Relay {
  // Opens the worker session and prepares the entry ticket; null when the worker refused.
  openSession(worker: ServiceWorker): Promise<string | null>;
}

type NavigationMark = "open" | "completed" | "failed";

interface PendingRequest {
  workerPort: MessagePort;
  mode: BridgeRequestMode;
  headForwarded: boolean;
}

// One broker port and what was asked on it. A resumed view replaces the context; callbacks keep
// the context they were born with, so nothing late from a previous generation reaches the next.
interface GenerationContext {
  generation: number;
  limits: BridgeLimits;
  port: MessagePort;
  pending: Map<number, PendingRequest>;
  state: "live" | "suspended" | "discarded";
  // Navigations answered locally on suspend: a head the control still sends for one of them is
  // a result this view dropped.
  answeredOnSuspend: Set<number>;
  dropReported: boolean;
  // Removes the listeners and closes the port, without a revoke.
  detach(): void;
}

// Relays the worker's per-request ports to the broker port of the current generation. The broker
// port lives here, in a window, because the browser may stop the worker whenever it is idle. This
// page also keeps the copy of its admitted client ids that a restarted worker asks for.
function startRelay(input: {
  options: ShellBootstrapOptions;
  grant: Grant;
  appFrame: HTMLIFrameElement;
}): Relay {
  const { options, grant, appFrame } = input;
  const doc = options.window.document;
  const workerUrl = new URL(options.workerUrl, options.window.location.href).href;
  // Per shell instance and never reset: an id of a previous generation is never reused.
  let nextRequestId = 1;
  let revokedReason: BridgeRevokeReason | null = null;
  let sessionPort: MessagePort | null = null;
  let admitted: string[] = [];
  let awaitingReply: ((message: ShellWorkerToBootstrapMessage | null) => void) | null = null;
  // Lifecycle: the side port the control offered, and the worker arm on the current binding.
  let side: MessagePort | null = null;
  let acceptedOffer: { generation: number; offer: string } | null = null;
  let lifecycleConfirmed = false;
  let binding: ServiceWorker | null = null;
  let isSessionReady = false;
  let workerArmed = false;
  let armAttempt = 0;
  // Authoritative purge (lifecycle contract §5.9): answered once per shell instance.
  let isPurgeQueryAnswered = false;
  let purgeOp: string | null = null;
  // Preservation reference (lifecycle contract §5.8), kept outside `pending` so it survives the
  // end of a request.
  let reference: Document | null = null;
  const marks = new Map<number, NavigationMark>();
  let current = openContext(grant.generation, grant.limits, grant.port);
  let navigationQuery: NavigationQueryMessage | null = null;
  let navigationSequence = 0;
  let navigationGeneration = 0;
  let navigationAttempt = 0;
  let navigationReadyForBinding = false;
  const navigation =
    options.navigation === undefined
      ? null
      : createShellNavigation({
          frame: appFrame,
          origin: options.window.location.origin,
          assetVersion: options.navigation.assetVersion,
          timeoutMs: 30_000,
          enter: prepareNavigationEntry,
          send: (message) => {
            if (lifecycleConfirmed && current.state === "live" && purgeOp === null)
              side?.postMessage(message, []);
          },
        });

  async function prepareNavigationEntry(
    target: string,
    authority: { signal: AbortSignal; isCurrent(): boolean },
  ): Promise<boolean> {
    if (sessionPort === null || current.state !== "live" || !navigationReadyForBinding)
      return false;
    const ctx = current;
    const port = sessionPort;
    const worker = binding;
    const bindingAttempt = navigationAttempt;
    return enterProductNavigation({
      frame: appFrame,
      port,
      target,
      ticket: createTicket(),
      enterPath: options.enterPath,
      timeoutMs: options.sessionReplyTimeoutMs,
      signal: authority.signal,
      isCurrent: () =>
        authority.isCurrent() &&
        ctx === current &&
        ctx.state === "live" &&
        port === sessionPort &&
        worker === binding &&
        bindingAttempt === navigationAttempt &&
        navigationReadyForBinding,
    });
  }

  function negotiateNavigation(): void {
    const query = navigationQuery;
    const worker = binding;
    if (
      navigation === null ||
      query === null ||
      worker === null ||
      !isSessionReady ||
      !lifecycleConfirmed ||
      current.state !== "live" ||
      query.generation !== current.generation
    )
      return;
    const attempt = ++navigationAttempt;
    const ctx = current;
    const nonce = createLifecycleToken();
    const channel = new MessageChannel();
    const timer = setTimeout(() => channel.port1.close(), options.sessionReplyTimeoutMs);
    channel.port1.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        channel.port1.close();
        const reply = parseShellNavigationReady(event.data);
        if (
          attempt !== navigationAttempt ||
          ctx !== current ||
          ctx.state !== "live" ||
          binding !== worker
        )
          return;
        if (
          event.ports.length !== 0 ||
          reply?.nonce !== nonce ||
          !reply.supported ||
          reply.assetVersion !== query.assetVersion
        )
          return;
        navigationReadyForBinding = true;
        navigation.activate({ generation: ctx.generation, shellInstance: query.shellInstance });
      },
      { once: true },
    );
    channel.port1.start();
    worker.postMessage(
      { type: "paseo.shell.navigation.query", v: 1, nonce, assetVersion: query.assetVersion },
      [channel.port2],
    );
  }

  function openContext(generation: number, limits: BridgeLimits, port: MessagePort) {
    const ctx: GenerationContext = {
      generation,
      limits,
      port,
      pending: new Map(),
      state: "live",
      answeredOnSuspend: new Set(),
      dropReported: false,
      detach,
    };
    function onMessage(event: MessageEvent): void {
      onBrokerMessage(ctx, event);
    }
    // The broker always announces a revocation; a current port that dies without one is treated
    // the same. A replaced port closing is only the end of its generation.
    function onClose(): void {
      if (ctx === current) revoke("port_closed");
    }
    function onMessageError(): void {
      if (ctx === current) revoke("protocol_error");
    }
    function detach(): void {
      ctx.state = "discarded";
      port.removeEventListener("message", onMessage);
      port.removeEventListener("close", onClose);
      port.removeEventListener("messageerror", onMessageError);
      port.close();
    }
    port.addEventListener("message", onMessage);
    port.addEventListener("close", onClose);
    port.addEventListener("messageerror", onMessageError);
    port.start();
    return ctx;
  }

  function revokeMessage(reason: BridgeRevokeReason): ControlMessage {
    return { type: "paseo.web.revoke", v: 1, generation: current.generation, reason };
  }

  function toBroker(
    ctx: GenerationContext,
    message: ContentMessage,
    transfer: Transferable[] = [],
  ) {
    if (ctx.state !== "live") return;
    ctx.port.postMessage(message, transfer);
  }

  function toWorker(
    port: MessagePort,
    message: ControlMessage,
    transfer: Transferable[] = [],
  ): void {
    port.postMessage(message, transfer);
  }

  function toControl(message: LifecycleToBrokerMessage): void {
    if (message.type !== "paseo.web.lifecycle.accept" && !lifecycleConfirmed) return;
    // A purging shell says nothing else: its only remaining message is the purged report.
    if (purgeOp !== null && message.type !== "paseo.web.purged") return;
    side?.postMessage(message, []);
  }

  function markNavigation(requestId: number, mark: NavigationMark): void {
    marks.set(requestId, mark);
  }

  function computeDocumentKept(): boolean {
    return (
      reference !== null &&
      marks.size === 0 &&
      appFrame.isConnected &&
      appFrame.contentDocument === reference
    );
  }

  // A new reference only after a navigation that went through the bridge and completed.
  function onAppFrameLoad(): void {
    if (current.state === "suspended") return;
    let highest = -1;
    for (const [requestId, mark] of marks) {
      if (mark === "open") return;
      highest = Math.max(highest, requestId);
    }
    if (highest < 0 || marks.get(highest) !== "completed") return;
    reference = appFrame.contentDocument;
    marks.clear();
  }

  function release(ctx: GenerationContext, requestId: number): void {
    const entry = ctx.pending.get(requestId);
    if (entry === undefined) return;
    if (entry.mode === "navigate" && (!entry.headForwarded || marks.get(requestId) === "open")) {
      markNavigation(requestId, "failed");
    }
    ctx.pending.delete(requestId);
    toBroker(ctx, { type: "paseo.web.cancel", v: 1, generation: ctx.generation, requestId });
  }

  function onDropped(dropped: {
    ctx: GenerationContext;
    requestId: number;
    cause: ShellDropCause;
  }): void {
    const { ctx, requestId, cause } = dropped;
    release(ctx, requestId);
    // The worker kept the document with a 204: the failure this navigation was marked with
    // never reached the frame.
    if (marks.get(requestId) === "failed") marks.delete(requestId);
    const { generation } = ctx;
    toControl({ type: "paseo.web.navigation.dropped", v: 1, generation, requestId, cause });
  }

  function onWorkerPortMessage(received: {
    ctx: GenerationContext;
    requestId: number;
    message: ShellAckMessage | ShellCancelMessage | null;
  }): void {
    const { ctx, requestId, message } = received;
    const entry = ctx.pending.get(requestId);
    if (entry === undefined) return;
    if (message === null || message.type === "paseo.shell.cancel") {
      release(ctx, requestId);
      return;
    }
    const { generation } = ctx;
    toBroker(ctx, { type: "paseo.web.ack", v: 1, generation, requestId, bytes: message.bytes });
  }

  function listenToWorkerPort(request: {
    ctx: GenerationContext;
    requestId: number;
    workerPort: MessagePort;
    mode: BridgeRequestMode;
  }): void {
    const { ctx, requestId, workerPort, mode } = request;
    let isDropReported = false;
    workerPort.addEventListener("message", (portEvent) => {
      const message = parseShellRequestMessage(portEvent.data);
      // The drop follows the error that triggered it, after the request left `pending`.
      if (message?.type === "paseo.shell.request.dropped") {
        if (mode !== "navigate" || isDropReported) return;
        isDropReported = true;
        onDropped({ ctx, requestId, cause: message.cause });
        return;
      }
      onWorkerPortMessage({ ctx, requestId, message });
    });
    // A worker stopped mid-response never sends cancel; release the host request instead.
    workerPort.addEventListener("close", () => release(ctx, requestId));
    workerPort.start();
  }

  function onFetch(fields: Record<string, unknown>, ports: ReadonlyArray<MessagePort>): void {
    const workerPort = ports[0];
    if (ports.length !== 1 || workerPort === undefined) return;
    if (revokedReason !== null) {
      toWorker(workerPort, revokeMessage(revokedReason));
      return;
    }
    const ctx = current;
    const { generation } = ctx;
    const requestId = nextRequestId++;
    const request = parseContentMessage(
      { ...fields, type: "paseo.web.request", v: 1, generation, requestId },
      ctx.limits,
    );
    if (request === null || request.type !== "paseo.web.request") {
      const code = "invalid_request";
      toWorker(workerPort, { type: "paseo.web.response.error", v: 1, generation, requestId, code });
      return;
    }
    // Suspended: answered here with the v1 primitives, never forwarded.
    if (ctx.state === "suspended") {
      toWorker(workerPort, suspendedReply(request.mode, requestId, generation));
      return;
    }
    ctx.pending.set(requestId, { workerPort, mode: request.mode, headForwarded: false });
    navigation?.request(request);
    listenToWorkerPort({ ctx, requestId, workerPort, mode: request.mode });
    toBroker(ctx, request, request.body === null ? [] : [request.body]);
  }

  function onSessionMessage(event: MessageEvent): void {
    const fields = readShellFetchFields(event.data);
    if (fields !== null) {
      onFetch(fields, event.ports);
      return;
    }
    const message = parseWorkerToBootstrapMessage(event.data);
    if (message === null) return;
    if (options.navigation !== undefined && message.type === "paseo.shell.ticket.ready") return;
    if (message.type === "paseo.shell.admitted") {
      admitted = message.clientIds;
      if (!navigationReadyForBinding) negotiateNavigation();
      return;
    }
    const resolve = awaitingReply;
    awaitingReply = null;
    resolve?.(message);
  }

  function setWorkerArmed(armed: boolean): void {
    if (workerArmed === armed) return;
    workerArmed = armed;
    toControl({ type: "paseo.web.lifecycle.state", v: 1, workerArmed: armed });
  }

  function disarm(): void {
    navigationReadyForBinding = false;
    navigationAttempt += 1;
    navigation?.deactivate();
    armAttempt += 1;
    setWorkerArmed(false);
  }

  // Arms the worker of the current binding, once the control accepted the lifecycle and the
  // session is open. A worker that does not answer in time leaves this view unarmed.
  function arm(): void {
    if (
      !lifecycleConfirmed ||
      side === null ||
      binding === null ||
      !isSessionReady ||
      revokedReason !== null
    )
      return;
    armAttempt += 1;
    const attempt = armAttempt;
    const nonce = createLifecycleToken();
    const channel = new MessageChannel();
    const timer = setTimeout(() => channel.port1.close(), options.sessionReplyTimeoutMs);
    channel.port1.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        channel.port1.close();
        const reply = parseLifecycleArmed(event.data);
        if (attempt !== armAttempt || reply === null || reply.nonce !== nonce) return;
        setWorkerArmed(reply.armed);
      },
      { once: true },
    );
    channel.port1.start();
    const message: ShellLifecycleArmMessage = { type: "paseo.shell.lifecycle.arm", v: 1, nonce };
    binding.postMessage(message, [channel.port2]);
  }

  function watchBinding(worker: ServiceWorker): void {
    binding = worker;
    worker.addEventListener("statechange", () => {
      if (binding !== worker || worker.state !== "redundant") return;
      binding = null;
      disarm();
    });
  }

  function adoptSessionPort(port: MessagePort): void {
    sessionPort?.removeEventListener("message", onSessionMessage);
    sessionPort?.close();
    sessionPort = port;
    port.addEventListener("message", onSessionMessage);
    port.start();
  }

  function nextReply(): Promise<ShellWorkerToBootstrapMessage | null> {
    const { promise, resolve } = Promise.withResolvers<ShellWorkerToBootstrapMessage | null>();
    const timer = setTimeout(() => {
      awaitingReply = null;
      resolve(null);
    }, options.sessionReplyTimeoutMs);
    awaitingReply = (message) => {
      clearTimeout(timer);
      resolve(message);
    };
    return promise;
  }

  // A restarted worker rebuilds its routes from the bootstraps it can still see. A revoked
  // bootstrap stays silent, so a late answer can never bring its session back. A suspended one
  // still answers: it keeps routing to this page, which answers locally.
  function onWorkerMessage(event: MessageEvent): void {
    const source = event.source;
    if (!(source instanceof ServiceWorker) || source.scriptURL !== workerUrl) return;
    const port = event.ports[0];
    if (!isResync(event.data) || event.ports.length !== 1 || port === undefined) return;
    if (revokedReason !== null) {
      port.close();
      return;
    }
    const reply: ShellResyncReplyMessage = { type: "paseo.shell.resync.reply", admitted };
    port.postMessage(reply, []);
    // A new binding, maybe of a restarted worker or of another version: arm it again.
    adoptSessionPort(port);
    disarm();
    watchBinding(source);
    arm();
    negotiateNavigation();
  }

  async function openSession(worker: ServiceWorker): Promise<string | null> {
    const channel = new MessageChannel();
    adoptSessionPort(channel.port1);
    watchBinding(worker);
    const reply = nextReply();
    const open: ShellSessionOpenMessage = { type: "paseo.shell.session.open" };
    worker.postMessage(open, [channel.port2]);
    if ((await reply)?.type !== "paseo.shell.session.ready" || sessionPort === null) return null;
    isSessionReady = true;
    arm();
    if (options.navigation !== undefined) {
      negotiateNavigation();
      return "";
    }
    const ticket = createTicket();
    const ticketReply = nextReply();
    const prepare: ShellTicketPrepareMessage = { type: "paseo.shell.ticket.prepare", ticket };
    sessionPort.postMessage(prepare, []);
    const ready = await ticketReply;
    const isReady = ready?.type === "paseo.shell.ticket.ready" && ready.ticket === ticket;
    return isReady ? ticket : null;
  }

  // Runs once; afterwards every worker request gets the same answer at once, not a timeout.
  function revoke(reason: BridgeRevokeReason): void {
    if (revokedReason !== null) return;
    revokedReason = reason;
    navigationAttempt += 1;
    navigation?.dispose();
    armAttempt += 1;
    const close: ShellSessionCloseMessage = { type: "paseo.shell.session.close" };
    sessionPort?.postMessage(close, []);
    sessionPort?.close();
    sessionPort = null;
    side?.close();
    side = null;
    acceptedOffer = null;
    lifecycleConfirmed = false;
    for (const entry of current.pending.values()) {
      toWorker(entry.workerPort, revokeMessage(reason));
    }
    current.pending.clear();
    current.detach();
    appFrame.remove();
    showStatus(doc, "revoked");
  }

  function noteNavigationResponse(ctx: GenerationContext, message: ControlMessage): void {
    if (message.type === "paseo.web.revoke") return;
    const entry = ctx.pending.get(message.requestId);
    if (entry === undefined || entry.mode !== "navigate") return;
    const { requestId } = message;
    if (message.type === "paseo.web.response.head") {
      entry.headForwarded = true;
      if (message.status !== 204 && message.status !== 205) markNavigation(requestId, "open");
    } else if (message.type === "paseo.web.response.end") {
      if (marks.get(requestId) === "open") markNavigation(requestId, "completed");
    } else if (message.type === "paseo.web.response.error") {
      markNavigation(requestId, "failed");
    }
  }

  // A head the control sent before the suspension reached it: that navigation's result is gone.
  function noteLateHead(ctx: GenerationContext, message: ControlMessage): void {
    if (message.type !== "paseo.web.response.head" || message.status === 204) return;
    if (!ctx.answeredOnSuspend.has(message.requestId) || ctx.dropReported) return;
    ctx.dropReported = true;
    const { generation } = ctx;
    const { requestId } = message;
    toControl({
      type: "paseo.web.navigation.dropped",
      v: 1,
      generation,
      requestId,
      cause: "suspended",
    });
  }

  function onControlMessage(ctx: GenerationContext, message: ControlMessage): void {
    if (message.type === "paseo.web.revoke") {
      revoke(message.reason);
      return;
    }
    if (ctx.state === "suspended") noteLateHead(ctx, message);
    if (ctx.state === "live") navigation?.response(message);
    const entry = ctx.pending.get(message.requestId);
    if (entry === undefined) return;
    noteNavigationResponse(ctx, message);
    if (message.type === "paseo.web.response.chunk") {
      toWorker(entry.workerPort, message, [message.chunk]);
      return;
    }
    if (message.type !== "paseo.web.response.head") ctx.pending.delete(message.requestId);
    toWorker(entry.workerPort, message);
  }

  function acceptLifecycle(ctx: GenerationContext, event: MessageEvent): boolean {
    const offer = parseLifecycleOffer(event.data);
    const port = event.ports[0];
    if (offer === null) return false;
    const isAcceptable =
      side === null &&
      ctx.state === "live" &&
      offer.generation === ctx.generation &&
      event.ports.length === 1;
    if (!isAcceptable || port === undefined) {
      for (const received of event.ports) received.close();
      return true;
    }
    side = port;
    acceptedOffer = { generation: offer.generation, offer: offer.offer };
    port.addEventListener("message", onSideMessage);
    port.addEventListener("close", () => {
      if (side !== port) return;
      side = null;
      acceptedOffer = null;
      lifecycleConfirmed = false;
      disarm();
    });
    port.start();
    toControl({
      type: "paseo.web.lifecycle.accept",
      v: 1,
      generation: ctx.generation,
      offer: offer.offer,
    });
    return true;
  }

  function onBrokerMessage(ctx: GenerationContext, event: MessageEvent): void {
    if (ctx !== current || acceptLifecycle(ctx, event)) return;
    const message = parseControlMessage(event.data);
    if (message === null || message.generation !== ctx.generation) return;
    onControlMessage(ctx, message);
  }

  // From here on every request is answered locally with the v1 primitives, never forwarded.
  function answerPendingLocally(ctx: GenerationContext): void {
    navigationAttempt += 1;
    navigation?.deactivate();
    ctx.state = "suspended";
    for (const [requestId, entry] of ctx.pending) {
      const isNavigationHead = entry.mode === "navigate" && !entry.headForwarded;
      if (isNavigationHead) ctx.answeredOnSuspend.add(requestId);
      if (entry.mode === "navigate" && entry.headForwarded && marks.get(requestId) === "open") {
        markNavigation(requestId, "failed");
      }
      const mode = isNavigationHead ? "navigate" : "subresource";
      toWorker(entry.workerPort, suspendedReply(mode, requestId, ctx.generation));
    }
    ctx.pending.clear();
  }

  function suspend(message: SuspendMessage): void {
    const ctx = current;
    if (ctx.state !== "live" || message.generation !== ctx.generation) return;
    answerPendingLocally(ctx);
    const documentKept = computeDocumentKept();
    toControl({ type: "paseo.web.suspended", v: 1, generation: ctx.generation, documentKept });
    showStatus(doc, "suspended");
  }

  function resume(message: ResumeMessage, ports: ReadonlyArray<MessagePort>): void {
    const port = ports[0];
    const previous = current;
    const isAdoptable =
      previous.state === "suspended" &&
      message.previous === previous.generation &&
      ports.length === 1 &&
      port !== undefined;
    if (!isAdoptable || port === undefined) {
      for (const received of ports) received.close();
      return;
    }
    const next = openContext(message.generation, message.limits, port);
    const documentKept = computeDocumentKept();
    const { generation } = next;
    port.postMessage(
      { type: "paseo.web.resumed", v: 1, previous: previous.generation, generation, documentKept },
      [],
    );
    current = next;
    previous.detach();
    showStatus(doc, "ready");
  }

  function answerPurgeQuery(message: PurgeQueryMessage, ports: ReadonlyArray<MessagePort>): void {
    if (isPurgeQueryAnswered || ports.length !== 0) return;
    isPurgeQueryAnswered = true;
    toControl({ type: "paseo.web.purge.capable", v: 1, nonce: message.nonce });
  }

  // Asks the worker of the binding, on a port of its own, and waits until the budget counted from
  // the purge's receipt. No binding, no answer in time or a wrong answer: nothing is confirmed.
  function askWorkerToPurge(op: string, deadline: number): Promise<ShellPurgeResult> {
    const worker = binding;
    const notConfirmed: ShellPurgeResult = { caches: false, indexedDB: false, unregistered: false };
    if (worker === null) return Promise.resolve(notConfirmed);
    const channel = new MessageChannel();
    const reply = new Promise<ShellPurgeResult>((resolve) => {
      channel.port1.addEventListener(
        "message",
        (event) => {
          const purged = parseShellPurged(event.data);
          if (purged === null || purged.op !== op) {
            resolve(notConfirmed);
            return;
          }
          const { caches, indexedDB, unregistered } = purged;
          resolve({ caches, indexedDB, unregistered });
        },
        { once: true },
      );
    });
    const budget: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
    const expired = new Promise<ShellPurgeResult>((resolve) => {
      budget.timer = setTimeout(
        () => resolve(notConfirmed),
        Math.max(0, deadline - performance.now()),
      );
    });
    channel.port1.start();
    const message: ShellPurgeMessage = { type: "paseo.shell.purge", v: 1, op };
    worker.postMessage(message, [channel.port2]);
    return Promise.race([reply, expired]).finally(() => {
      if (budget.timer !== null) clearTimeout(budget.timer);
      channel.port1.close();
    });
  }

  function clearStorage(storage: () => Storage): boolean {
    try {
      storage().clear();
      return true;
    } catch {
      return false;
    }
  }

  // The page goes first, so it cannot write after the clear. No port is closed: a close could
  // reach the control before the report and turn the operation into an interruption.
  async function purge(message: PurgeMessage, ports: ReadonlyArray<MessagePort>): Promise<void> {
    if (purgeOp !== null || ports.length !== 0) return;
    const deadline = performance.now() + PURGE_WORKER_BUDGET_MS;
    const { op } = message;
    purgeOp = op;
    answerPendingLocally(current);
    appFrame.remove();
    const localStorage = clearStorage(() => options.window.localStorage);
    const sessionStorage = clearStorage(() => options.window.sessionStorage);
    const worker = await askWorkerToPurge(op, deadline);
    toControl({ type: "paseo.web.purged", v: 1, op, localStorage, sessionStorage, ...worker });
  }

  function onNavigationMessage(event: MessageEvent): boolean {
    const navigationMessage = parseNavigationToShell(event.data);
    if (navigationMessage !== null) {
      if (
        !lifecycleConfirmed ||
        purgeOp !== null ||
        current.state !== "live" ||
        event.ports.length !== 0
      )
        return true;
      if (
        navigationMessage.generation !== current.generation ||
        navigationMessage.shellInstance !== acceptedOffer?.offer
      )
        return true;
      if (navigationGeneration !== current.generation) {
        navigationGeneration = current.generation;
        navigationSequence = 0;
      }
      if (navigationMessage.sequence <= navigationSequence) return true;
      navigationSequence = navigationMessage.sequence;
      if (navigationMessage.type === "paseo.web.navigation.query") {
        if (navigationMessage.assetVersion !== options.navigation?.assetVersion) return true;
        navigationQuery = navigationMessage;
        negotiateNavigation();
      } else void navigation?.command(navigationMessage);
      return true;
    }
    return false;
  }

  function onSideMessage(event: MessageEvent): void {
    if (revokedReason !== null || onNavigationMessage(event)) return;
    const message = parseLifecycleToShell(event.data);
    if (message === null) return;
    if (message.type === "paseo.web.lifecycle.ready") {
      if (lifecycleConfirmed || acceptedOffer === null || event.ports.length !== 0) return;
      if (message.generation !== acceptedOffer.generation || message.offer !== acceptedOffer.offer)
        return;
      lifecycleConfirmed = true;
      arm();
      return;
    }
    if (!lifecycleConfirmed) return;
    if (message.type === "paseo.web.purge.query") {
      answerPurgeQuery(message, event.ports);
      return;
    }
    if (message.type === "paseo.web.purge") {
      void purge(message, event.ports);
      return;
    }
    // A purging shell stays inert until the control removes its frame.
    if (purgeOp !== null) return;
    if (message.type === "paseo.web.suspend") suspend(message);
    else resume(message, event.ports);
  }

  options.window.navigator.serviceWorker.addEventListener("message", onWorkerMessage);
  appFrame.addEventListener("load", onAppFrameLoad);
  return { openSession };
}

export async function startShellBootstrap(options: ShellBootstrapOptions): Promise<void> {
  const doc = options.window.document;
  if (!isFramedByControl(options.window, options.controlOrigin)) {
    showStatus(doc, "no_session");
    return;
  }
  const granted = listenForGrant(options);
  showStatus(doc, "registering");
  let worker: ServiceWorker | null = null;
  try {
    const registration = await options.window.navigator.serviceWorker.register(options.workerUrl, {
      scope: options.workerScope,
      type: options.workerType,
    });
    await waitForActivation(registration);
    worker = registration.active;
  } catch {
    // Without the worker no request can reach the broker; the page states it and stops.
    showStatus(doc, "worker_failed");
    return;
  }
  if (worker === null) {
    showStatus(doc, "worker_failed");
    return;
  }
  showStatus(doc, "awaiting_grant");
  announceUntilGranted(options, granted);
  const grant = await granted;
  // oxlint-disable-next-line react/iframe-missing-sandbox -- set on the next line, before src.
  const appFrame = doc.createElement("iframe");
  // The outer frame's sandbox already applies; repeating it keeps the flags explicit here.
  appFrame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  appFrame.dataset.testid = "paseo-web-proxy-app";
  appFrame.title = "Proxied page";
  const relay = startRelay({ options, grant, appFrame });
  const ticket = await relay.openSession(worker);
  if (ticket === null) {
    showStatus(doc, "session_refused");
    return;
  }
  if (options.navigation === undefined) appFrame.src = `${options.enterPath}?t=${ticket}`;
  doc.body.append(appFrame);
  showStatus(doc, "ready");
}
