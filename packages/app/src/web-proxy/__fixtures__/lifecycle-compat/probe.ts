import { attachWebProxyBroker, type WebProxyBrokerState } from "../../broker.web";
import { WebProxyTransportError, type WebProxyTransport } from "../../transport";

// An injected transport holds the head; broker, bootstrap, worker and browser are real.
// This probe is used only for P1/P7. The compatibility matrix uses the published control.
const requests: Array<{ method: string; path: string }> = [];
const states: WebProxyBrokerState[] = [];
const html = `<!doctype html><input id="draft"><a id="get" href="/hold">GET</a>
<form action="/hold" method="post"><button id="post">POST</button></form>
<script>window.documentMarker=crypto.randomUUID();</script>`;
const transport: WebProxyTransport = {
  request(request, signal) {
    const pathname = new URL(request.url).pathname;
    requests.push({ method: request.method, path: pathname });
    if (pathname === "/hold")
      return new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new WebProxyTransportError("transport_closed")),
          { once: true },
        );
      });
    return Promise.resolve({
      status: 200,
      statusText: "OK",
      headers: [["content-type", "text/html"]],
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(html));
          controller.close();
        },
      }),
    });
  },
};
const container = document.getElementById("frame");
if (!container) throw new Error("probe container missing");
const broker = attachWebProxyBroker({
  capability: {
    contentOrigin: "https://paseo-content.assustadus.com",
    destinationOrigin: "http://127.0.0.1:1",
    pathPrefix: "/",
  },
  container,
  transport,
  bootstrapPath: "/__paseo/bootstrap.html",
  handshakeTimeoutMs: 4000,
  onStateChange(state) {
    states.push(state);
  },
});
Object.defineProperty(window, "__lifecycleProbe", {
  value: {
    state: () => broker.getState(),
    states,
    requests,
    suspend: () => broker.suspend("channel_lost"),
    resume: () => broker.resume({ transport }),
  },
});
