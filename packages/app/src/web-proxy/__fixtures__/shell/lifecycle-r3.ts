// U3-R3 drives the real bootstrap. Only its worker registration and worker-side ports are
// controlled here; navigation marks, lifecycle confirmation and reference selection are product code.
import { startShellBootstrap } from "../../shell/bootstrap.web";
import { harnessControlOrigin } from "./harness";

const controlOrigin = harnessControlOrigin(location);
let sessionPort: MessagePort | null = null;
let arms = 0;
let loads = 0;
const requests = new Map<string, MessagePort>();
const requestIds = new Map<string, number>();
const receivers = new Map<number, MessagePort>();
const lateralReceivers: MessagePort[] = [];
let pendingArm: { port: MessagePort; nonce: string | undefined } | null = null;

function report(event: string, data: unknown = null): void {
  parent.postMessage({ type: "fixture.r3", event, data }, controlOrigin);
}

// Capture the real receiving endpoints only. Chromium does not consistently deliver a peer's
// close event; scripted cases close the port and explicitly deliver that event to its handler.
const postMessage = MessagePort.prototype.postMessage;
MessagePort.prototype.postMessage = function (
  this: MessagePort,
  message: unknown,
  transfer: Transferable[] | StructuredSerializeOptions = [],
) {
  if (typeof message === "object" && message !== null && "type" in message) {
    if (message.type === "paseo.web.lifecycle.accept") lateralReceivers.push(this);
    if (
      message.type === "paseo.web.response.head" &&
      "requestId" in message &&
      typeof message.requestId === "number"
    )
      receivers.set(message.requestId, this);
    if (
      message.type === "paseo.web.lifecycle.state" ||
      message.type === "paseo.web.navigation.dropped"
    )
      report("sent", { type: message.type });
  }
  const options = Array.isArray(transfer) ? { transfer } : transfer;
  postMessage.call(this, message, options);
};

const worker = Object.assign(new EventTarget(), {
  state: "activated",
  postMessage(message: { type: string; nonce?: string }, transfer: Transferable[]) {
    const port = transfer[0];
    if (!(port instanceof MessagePort)) throw new Error("worker call without its port");
    if (message.type === "paseo.shell.lifecycle.arm") {
      arms += 1;
      report("arm", arms);
      if (new URLSearchParams(location.search).has("holdArm")) {
        pendingArm = { port, nonce: message.nonce };
        return;
      }
      port.postMessage({
        type: "paseo.shell.lifecycle.armed",
        v: 1,
        nonce: message.nonce,
        armed: true,
      });
      return;
    }
    if (message.type !== "paseo.shell.session.open") throw new Error("unexpected worker call");
    sessionPort = port;
    port.addEventListener("message", (event: MessageEvent) => {
      if (event.data.type === "paseo.shell.ticket.prepare") {
        port.postMessage({ type: "paseo.shell.ticket.ready", ticket: event.data.ticket });
      }
    });
    port.start();
    port.postMessage({ type: "paseo.shell.session.ready" });
  },
});
const serviceWorker = Object.assign(new EventTarget(), {
  register: async () => ({ active: worker, installing: null, waiting: null }),
});
Object.defineProperty(navigator, "serviceWorker", { value: serviceWorker });

function appFrame(): HTMLIFrameElement {
  const frame = document.querySelector("iframe");
  if (!(frame instanceof HTMLIFrameElement)) throw new Error("no app frame");
  return frame;
}

function fetchNavigation(label: string): void {
  if (sessionPort === null) throw new Error("session not open");
  const channel = new MessageChannel();
  requests.set(label, channel.port1);
  channel.port1.addEventListener("message", (event) => {
    if (typeof event.data.requestId === "number") requestIds.set(label, event.data.requestId);
    report("worker", { label, message: event.data });
  });
  channel.port1.start();
  sessionPort.postMessage(
    {
      type: "paseo.shell.fetch",
      request: {
        method: "GET",
        path: `/r3-${label}`,
        headers: [],
        body: null,
        mode: "navigate",
      },
    },
    [channel.port2],
  );
}

function closeLateral(): void {
  const port = lateralReceivers.at(-1);
  if (port === undefined) throw new Error("no lifecycle port");
  port.close();
  port.dispatchEvent(new Event("close"));
  report("lateral-closed");
}

function replyArm(): void {
  if (pendingArm === null) throw new Error("no pending ARM");
  pendingArm.port.postMessage(
    { type: "paseo.shell.lifecycle.armed", v: 1, nonce: pendingArm.nonce, armed: true },
    [],
  );
  report("arm-replied");
}

window.addEventListener("message", (event: MessageEvent) => {
  if (
    event.source !== parent ||
    event.origin !== controlOrigin ||
    event.data?.type !== "fixture.r3.command"
  )
    return;
  const { name, label } = event.data;
  const port = requests.get(label);
  switch (name) {
    case "fetch":
      fetchNavigation(label);
      break;
    case "cancel":
      port?.postMessage({ type: "paseo.shell.cancel" });
      break;
    case "drop":
      port?.postMessage({ type: "paseo.shell.request.dropped", cause: "head_timeout" });
      break;
    case "close":
      port?.close();
      receivers.get(requestIds.get(label) ?? -1)?.dispatchEvent(new Event("close"));
      break;
    case "lateral-close":
      closeLateral();
      break;
    case "arm-reply":
      replyArm();
      break;
    case "load": {
      const frame = appFrame();
      frame.addEventListener("load", () => report("load", loads), { once: true });
      frame.srcdoc = `<p>R3 document ${++loads}</p>`;
      break;
    }
    case "probe":
      report("probe", { arms, status: document.body.dataset.paseoShell });
      break;
    default:
      throw new Error("unknown R3 command");
  }
});

await startShellBootstrap({
  window,
  controlOrigin,
  workerUrl: new URL("./r3-controlled-worker.js", location.href).href,
  workerScope: "/",
  workerType: "module",
  enterPath: new URL("./silent.html", location.href).pathname,
  sessionReplyTimeoutMs: 1000,
});
await new Promise<void>((resolve) =>
  appFrame().addEventListener("load", () => resolve(), { once: true }),
);
report("bootstrap");
