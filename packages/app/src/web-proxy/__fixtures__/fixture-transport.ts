import type { BridgeHeaders } from "../bridge-messages";
import type {
  WebProxyInitiator,
  WebProxyTransport,
  WebProxyTransportRequest,
  WebProxyTransportResponse,
} from "../transport";

// A known application on the host, served in memory. Everything here is fictitious test data.
export const FIXTURE_DESTINATION_ORIGIN = "http://127.0.0.1:4173";
export const FIXTURE_BIG_BODY_BYTES = 600_000;
export const FIXTURE_SECRET_COOKIE = "sid=fixture-httponly-secret";

export type FixtureIndex = "app" | "navigate-parent" | "hang" | "framing";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: BridgeHeaders;
  bodyText: string | null;
  initiator: WebProxyInitiator;
}

export interface FixtureTransport extends WebProxyTransport {
  requests: RecordedRequest[];
  // Resolves when a pending /hang request's signal aborts.
  waitForHangAbort(): Promise<void>;
  waitForHangRequest(): Promise<void>;
}

const APP_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Fixture app</title>
    <link rel="stylesheet" href="style.css">
  </head>
  <body>
    <h1 id="title">Fixture app</h1>
    <p id="status">waiting</p>
    <button id="increment" type="button">Increment</button>
    <output id="count">0</output>
    <script src="app.js"></script>
  </body>
</html>`;

const APP_CSS = "#title { color: rgb(1, 2, 3); }";

// Runs inside the proxied document on the content origin and reports what it could and could
// not reach to the test page (bootstrap's parent).
const APP_JS = `(async () => {
  const report = { type: "fixture.report" };
  const testPage = parent.parent;
  document.getElementById("status").textContent = "script-ran";
  const title = document.getElementById("title");
  report.heading = title.textContent;
  report.headingRendered = title.getBoundingClientRect().height > 0;
  report.status = document.getElementById("status").textContent;
  report.color = getComputedStyle(title).color;
  const echo = await fetch("api/echo?q=1", { method: "POST", body: "hello bridge" });
  report.echoStatus = echo.status;
  report.echo = await echo.text();
  report.echoSetCookie = echo.headers.get("set-cookie");
  report.echoHsts = echo.headers.get("strict-transport-security");
  report.cookie = document.cookie;
  try { report.topAccess = String(testPage.document.title); } catch (error) { report.topAccess = error.name; }
  const controlUrl = location.protocol + "//" + location.hostname.slice(location.hostname.indexOf(".") + 1) + ":" + location.port + "/";
  report.escape = await fetch(controlUrl).then(() => "reached", () => "blocked");
  const redirected = await fetch("old");
  report.redirect = { path: new URL(redirected.url).pathname, text: await redirected.text() };
  const cross = await fetch("cross");
  report.cross = { status: cross.status, code: cross.headers.get("x-paseo-web-proxy-error") };
  report.bigBytes = (await (await fetch("big")).arrayBuffer()).byteLength;
  const injected = parent.document.createElement("script");
  injected.textContent = 'parent.postMessage({ type: "paseo.web.hello", v: 1 }, "*")';
  parent.document.body.append(injected);
  testPage.postMessage({ type: "paseo.web.hello", v: 1 }, "*");
  const button = document.getElementById("increment").getBoundingClientRect();
  report.button = { x: Math.round(button.x + button.width / 2), y: Math.round(button.y + button.height / 2) };
  let count = 0;
  document.getElementById("increment").addEventListener("click", () => {
    count += 1;
    document.getElementById("count").textContent = String(count);
    testPage.postMessage({ type: "fixture.clicked", count }, "*");
  });
  testPage.postMessage(report, "*");
})();`;

// The sandbox stops the app from navigating its parent directly. Being same-origin with the
// bootstrap, it injects a script there instead, and the bootstrap navigates itself.
const NAVIGATE_PARENT_HTML = `<!doctype html>
<html lang="en"><body><script>
const injected = parent.document.createElement("script");
injected.textContent = "location.replace(location.href)";
parent.document.body.append(injected);
</script></body></html>`;

const HANG_HTML = `<!doctype html>
<html lang="en"><body><script>
fetch("hang").then(
  (response) => parent.parent.postMessage({ type: "fixture.hang", status: response.status, code: response.headers.get("x-paseo-web-proxy-error") }, "*"),
  () => parent.parent.postMessage({ type: "fixture.hang", status: "network-error", code: null }, "*"),
);
</script></body></html>`;

// Posts to every ancestor; the test page is one of them, whatever the depth.
const REPORT_TO_ANCESTORS = `function reportToAncestors(message) {
  let target = window;
  while (target !== target.parent) {
    target = target.parent;
    target.postMessage(message, "*");
  }
}`;

// Served with the destination's own CSP (img-src 'none'). It reports only after that policy
// blocked its image, so a message proves the document loaded with the destination CSP intact.
const FRAMED_HTML = `<!doctype html>
<html lang="en"><body><script>
${REPORT_TO_ANCESTORS}
const via = new URLSearchParams(location.search).get("via");
document.addEventListener("securitypolicyviolation", (event) => {
  reportToAncestors({ type: "fixture.framed", via, blocked: event.effectiveDirective });
});
const image = new Image();
image.src = "pixel.png";
document.body.append(image);
</script></body></html>`;

const FRAMING_HTML = `<!doctype html>
<html lang="en"><body><script>
const own = document.createElement("iframe");
own.src = "framed?via=self";
document.body.append(own);
const refused = document.createElement("iframe");
refused.src = "refuses-embedding";
refused.addEventListener("load", () => {
  parent.parent.postMessage({
    type: "fixture.refused",
    text: refused.contentDocument.body.textContent.trim(),
  }, "*");
});
document.body.append(refused);
</script></body></html>`;

const INDEX_HTML: Record<FixtureIndex, string> = {
  app: APP_HTML,
  "navigate-parent": NAVIGATE_PARENT_HTML,
  hang: HANG_HTML,
  framing: FRAMING_HTML,
};

function textStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function bigStream(): ReadableStream<Uint8Array> {
  const chunkBytes = 100_000;
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= FIXTURE_BIG_BODY_BYTES) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunkBytes).fill(sent / chunkBytes));
      sent += chunkBytes;
    },
  });
}

function respond(status: number, headers: BridgeHeaders, body: string): WebProxyTransportResponse {
  return { status, statusText: "", headers, body: textStream(body) };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function createFixtureTransport(options: { index: FixtureIndex }): FixtureTransport {
  const requests: RecordedRequest[] = [];
  const hangRequested = createDeferred();
  const hangAborted = createDeferred();

  function route(
    request: WebProxyTransportRequest,
    bodyText: string | null,
    signal: AbortSignal,
  ): Promise<WebProxyTransportResponse> {
    const url = new URL(request.url);
    const html: BridgeHeaders = [["content-type", "text/html; charset=utf-8"]];
    switch (url.pathname) {
      case "/":
        return Promise.resolve(respond(200, html, INDEX_HTML[options.index]));
      case "/style.css":
        return Promise.resolve(respond(200, [["content-type", "text/css"]], APP_CSS));
      case "/app.js":
        return Promise.resolve(respond(200, [["content-type", "text/javascript"]], APP_JS));
      case "/api/echo":
        return Promise.resolve(
          respond(
            200,
            [
              ["content-type", "text/plain"],
              ["set-cookie", `${FIXTURE_SECRET_COOKIE}; HttpOnly; Path=/`],
              ["strict-transport-security", "max-age=31536000"],
            ],
            `${request.method} ${url.search} ${bodyText ?? ""}`,
          ),
        );
      case "/old":
        return Promise.resolve(
          respond(302, [["location", `${FIXTURE_DESTINATION_ORIGIN}/new`]], ""),
        );
      case "/new":
        return Promise.resolve(respond(200, [["content-type", "text/plain"]], "redirected"));
      case "/cross":
        return Promise.resolve(respond(302, [["location", "http://elsewhere.invalid/"]], ""));
      case "/big":
        return Promise.resolve({
          status: 200,
          statusText: "OK",
          headers: [["content-type", "application/octet-stream"]],
          body: bigStream(),
        });
      case "/framed":
        return Promise.resolve(
          respond(200, [...html, ["content-security-policy", "img-src 'none'"]], FRAMED_HTML),
        );
      case "/refuses-embedding":
        return Promise.resolve(respond(200, [...html, ["x-frame-options", "DENY"]], "framed page"));
      case "/hang":
        hangRequested.resolve();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            hangAborted.resolve();
            reject(signal.reason);
          });
        });
      default:
        return Promise.resolve(respond(404, [["content-type", "text/plain"]], "not found"));
    }
  }

  return {
    requests,
    waitForHangAbort: () => hangAborted.promise,
    waitForHangRequest: () => hangRequested.promise,
    request(request, signal) {
      const bodyText = request.body === null ? null : new TextDecoder().decode(request.body);
      requests.push({
        url: request.url,
        method: request.method,
        headers: request.headers,
        bodyText,
        initiator: request.initiator,
      });
      return route(request, bodyText, signal);
    },
  };
}
