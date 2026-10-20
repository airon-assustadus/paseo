import {
  BRIDGE_VERSION,
  parseContentMessage,
  parseControlMessage,
  parsePortGrant,
  type BridgeLimits,
  type BridgeRevokeReason,
  type ContentMessage,
  type ControlMessage,
  type HelloMessage,
} from "../bridge-messages";
import { parseShellRequestMessage, readShellFetchFields } from "./relay-messages";

export type ShellBootstrapStatus =
  | "no_session"
  | "registering"
  | "worker_failed"
  | "awaiting_grant"
  | "ready"
  | "revoked";

export interface ShellBootstrapOptions {
  window: Window;
  // A deploy constant. Never read from the URL: a hostile framer could name itself.
  controlOrigin: string;
  workerUrl: string;
  workerScope: string;
  workerType: WorkerType;
  appPath: string;
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

// Relays the worker's per-request ports to the single broker port. The broker port lives
// here, in a window, because the browser may stop the worker whenever it is idle.
function startRelay(input: {
  options: ShellBootstrapOptions;
  grant: Grant;
  appFrame: HTMLIFrameElement;
}): void {
  const { options, grant, appFrame } = input;
  const doc = options.window.document;
  const workerUrl = new URL(options.workerUrl, options.window.location.href).href;
  const pending = new Map<number, MessagePort>();
  let nextRequestId = 1;
  let revokedReason: BridgeRevokeReason | null = null;

  function revokeMessage(reason: BridgeRevokeReason): ControlMessage {
    return { type: "paseo.web.revoke", v: 1, generation: grant.generation, reason };
  }

  function toBroker(message: ContentMessage, transfer: Transferable[] = []): void {
    grant.port.postMessage(message, transfer);
  }

  function toWorker(
    port: MessagePort,
    message: ControlMessage,
    transfer: Transferable[] = [],
  ): void {
    port.postMessage(message, transfer);
  }

  function release(requestId: number): void {
    if (!pending.delete(requestId)) return;
    toBroker({ type: "paseo.web.cancel", v: 1, generation: grant.generation, requestId });
  }

  function onWorkerPortMessage(requestId: number, data: unknown): void {
    const message = parseShellRequestMessage(data);
    if (!pending.has(requestId)) return;
    if (message === null || message.type === "paseo.shell.cancel") {
      release(requestId);
      return;
    }
    const { generation } = grant;
    toBroker({ type: "paseo.web.ack", v: 1, generation, requestId, bytes: message.bytes });
  }

  function onWorkerMessage(event: MessageEvent): void {
    const source = event.source;
    if (!(source instanceof ServiceWorker) || source.scriptURL !== workerUrl) return;
    const fields = readShellFetchFields(event.data);
    const workerPort = event.ports[0];
    if (fields === null || event.ports.length !== 1 || workerPort === undefined) return;
    if (revokedReason !== null) {
      toWorker(workerPort, revokeMessage(revokedReason));
      return;
    }
    const requestId = nextRequestId++;
    const request = parseContentMessage(
      { ...fields, type: "paseo.web.request", v: 1, generation: grant.generation, requestId },
      grant.limits,
    );
    if (request === null || request.type !== "paseo.web.request") {
      const { generation } = grant;
      const code = "invalid_request";
      toWorker(workerPort, { type: "paseo.web.response.error", v: 1, generation, requestId, code });
      return;
    }
    pending.set(requestId, workerPort);
    workerPort.addEventListener("message", (portEvent) =>
      onWorkerPortMessage(requestId, portEvent.data),
    );
    // A worker stopped mid-response never sends cancel; release the host request instead.
    workerPort.addEventListener("close", () => release(requestId));
    workerPort.start();
    toBroker(request, request.body === null ? [] : [request.body]);
  }

  // Runs once; afterwards every worker request gets the same answer at once, not a timeout.
  function revoke(reason: BridgeRevokeReason): void {
    if (revokedReason !== null) return;
    revokedReason = reason;
    grant.port.removeEventListener("message", onBrokerMessage);
    grant.port.removeEventListener("close", onBrokerPortClosed);
    grant.port.removeEventListener("messageerror", onBrokerMessageError);
    for (const workerPort of pending.values()) toWorker(workerPort, revokeMessage(reason));
    pending.clear();
    grant.port.close();
    appFrame.remove();
    showStatus(doc, "revoked");
  }

  function onBrokerMessage(event: MessageEvent): void {
    const message = parseControlMessage(event.data);
    if (message === null || message.generation !== grant.generation) return;
    if (message.type === "paseo.web.revoke") {
      revoke(message.reason);
      return;
    }
    const workerPort = pending.get(message.requestId);
    if (workerPort === undefined) return;
    if (message.type === "paseo.web.response.chunk") {
      toWorker(workerPort, message, [message.chunk]);
      return;
    }
    if (message.type !== "paseo.web.response.head") pending.delete(message.requestId);
    toWorker(workerPort, message);
  }

  // The broker always announces a revocation; a port that dies without one is treated the same.
  function onBrokerPortClosed(): void {
    revoke("port_closed");
  }

  function onBrokerMessageError(): void {
    revoke("protocol_error");
  }

  options.window.navigator.serviceWorker.addEventListener("message", onWorkerMessage);
  grant.port.addEventListener("message", onBrokerMessage);
  grant.port.addEventListener("close", onBrokerPortClosed);
  grant.port.addEventListener("messageerror", onBrokerMessageError);
  grant.port.start();
}

export async function startShellBootstrap(options: ShellBootstrapOptions): Promise<void> {
  const doc = options.window.document;
  if (!isFramedByControl(options.window, options.controlOrigin)) {
    showStatus(doc, "no_session");
    return;
  }
  const granted = listenForGrant(options);
  showStatus(doc, "registering");
  try {
    const registration = await options.window.navigator.serviceWorker.register(options.workerUrl, {
      scope: options.workerScope,
      type: options.workerType,
    });
    await waitForActivation(registration);
  } catch {
    // Without the worker no request can reach the broker; the page states it and stops.
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
  startRelay({ options, grant, appFrame });
  appFrame.src = options.appPath;
  doc.body.append(appFrame);
  showStatus(doc, "ready");
}
