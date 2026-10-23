import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type Socket } from "node:net";
import path from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
import type { ProductShellAssets } from "../../../src/web-proxy/shell/product-assets";

export const CONTROL = "https://control.ticket04-control.test";
export const CONTENT_DOMAIN = "ticket04-content.test";
const CONTROL_HOST = new URL(CONTROL).host;

export interface RequestEvidence {
  method: string;
  path: string;
}

function controlEvents() {
  const events: Array<{ at: number; type: string; id: string; bytes?: number }> = [];
  let failure: string | null = null;
  return {
    events,
    fail(reason: string) {
      failure ??= reason;
    },
    failure: () => failure,
    record(type: string, id: string, bytes?: number) {
      if (events.length >= 256) failure ??= "control_evidence_overflow";
      else events.push({ at: performance.now(), type, id, bytes });
    },
  };
}

// These controls manipulate only this gateway's loopback TCP pairs. No daemon RPC is added.
function createDaemonLinks() {
  const evidence = controlEvents();
  interface Link {
    id: string;
    upstream: Socket;
    downstream: Socket;
    closed: Promise<void>;
    upstreamClosed: boolean;
    downstreamClosed: boolean;
    held: Buffer[] | null;
    queuedBytes: number;
    timer?: ReturnType<typeof setTimeout>;
  }
  const links = new Map<string, Link>();
  let serial = 0;
  let blocked = false;
  let heldId: string | null = null;
  const destroy = (link: Link) => {
    clearTimeout(link.timer);
    link.held = null;
    link.queuedBytes = 0;
    if (heldId === link.id) heldId = null;
    link.upstream.destroy();
    link.downstream.destroy();
  };
  const forward = (link: Link, chunk: Buffer) => {
    if (link.held !== null) {
      if (chunk.byteLength > 65_536 - link.queuedBytes) {
        evidence.fail("downstream_hold_overflow");
        evidence.record("hold_overflow", link.id);
        link.upstream.pause();
        destroy(link);
        return;
      }
      link.held.push(Buffer.from(chunk));
      link.queuedBytes += chunk.byteLength;
      evidence.record("held", link.id, chunk.byteLength);
    } else if (!link.downstream.write(chunk)) link.upstream.pause();
  };
  const attach = (upstream: Socket, downstream: Socket) => {
    const id = `daemon-link-${++serial}`;
    let completed!: () => void;
    const link: Link = {
      id,
      upstream,
      downstream,
      closed: new Promise<void>((resolve) => {
        completed = resolve;
      }),
      upstreamClosed: false,
      downstreamClosed: false,
      held: null,
      queuedBytes: 0,
    };
    links.set(id, link);
    evidence.record("created", id);
    const closed = (side: "upstreamClosed" | "downstreamClosed") => {
      link[side] = true;
      evidence.record(side, id);
      destroy(link);
      if (link.upstreamClosed && link.downstreamClosed) completed();
    };
    upstream.once("close", () => closed("upstreamClosed"));
    downstream.once("close", () => closed("downstreamClosed"));
    downstream.on("drain", () => {
      if (link.held === null) upstream.resume();
    });
    upstream.on("data", (chunk: Buffer) => forward(link, chunk));
  };
  const closePairs = async (requireLive: boolean) => {
    blocked = true;
    const live = [...links.values()].filter(
      (link) => !link.upstreamClosed || !link.downstreamClosed,
    );
    if (requireLive && live.length === 0) throw new Error("No live daemon pair to cut");
    for (const link of live) destroy(link);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(live.map((link) => link.closed)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Daemon pair close unobserved")), 5_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    evidence.record("cut_complete", "gateway", live.length);
  };
  return {
    accept() {
      if (blocked || serial >= 32) {
        if (serial >= 32) evidence.fail("daemon_link_limit");
        evidence.record("upgrade_refused", "gateway");
        return false;
      }
      return true;
    },
    attach,
    snapshot: () =>
      [...links.values()].map((link) => ({
        id: link.id,
        upstreamClosed: link.upstreamClosed,
        downstreamClosed: link.downstreamClosed,
        queuedBytes: link.queuedBytes,
        held: link.held !== null,
      })),
    evidence: () => ({ events: evidence.events, failure: evidence.failure(), blocked }),
    cutAndBlock: () => closePairs(true),
    close: () => closePairs(false),
    unblock() {
      blocked = false;
      evidence.record("unblock", "gateway");
    },
    holdDownstream(id: string) {
      const link = links.get(id);
      if (!link || heldId !== null || blocked || link.upstreamClosed || link.downstreamClosed)
        throw new Error("Ambiguous or unavailable downstream hold");
      heldId = id;
      link.held = [];
      evidence.record("hold_begin", id);
      link.timer = setTimeout(() => {
        evidence.fail("downstream_hold_deadline");
        destroy(link);
      }, 45_000);
      let finished = false;
      return {
        queuedBytes: () => link.queuedBytes,
        release() {
          if (finished) return;
          finished = true;
          clearTimeout(link.timer);
          const chunks = link.held;
          if (!chunks || link.downstream.destroyed)
            throw new Error("Held downstream closed before delivery");
          link.held = null;
          heldId = null;
          evidence.record("hold_release", id, link.queuedBytes);
          link.queuedBytes = 0;
          // Writes remain ordered on the original socket; receipt is proved separately.
          for (const chunk of chunks) if (!link.downstream.write(chunk)) link.upstream.pause();
        },
        discard() {
          if (!finished) {
            finished = true;
            evidence.record("hold_discard", id);
            destroy(link);
          }
        },
      };
    },
  };
}

function createFixtureHolds(proof: string) {
  const evidence = controlEvents();
  interface Held {
    method: "GET" | "POST";
    maxBodyBytes: number;
    received: boolean;
    bodyComplete: boolean;
    bytes: number;
    released: boolean;
    closed: boolean;
    expired: boolean;
    response?: ServerResponse;
    timer: ReturnType<typeof setTimeout>;
  }
  const holds = new Map<string, Held>();
  const close = () => {
    for (const held of holds.values()) {
      clearTimeout(held.timer);
      held.response?.destroy();
    }
  };
  const handle = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (!["/app/hold", "/app/slow-page"].includes(url.pathname)) return false;
    const key = url.searchParams.get("key") ?? "";
    const held = holds.get(key);
    if (
      url.searchParams.get("proof") !== proof ||
      !held ||
      held.expired ||
      held.received ||
      req.method !== held.method
    ) {
      res.writeHead(409).end();
      evidence.fail("unexpected_held_request");
      return true;
    }
    held.received = true;
    held.response = res;
    evidence.record("request", key);
    req.on("data", (chunk: Buffer) => {
      if (chunk.byteLength > held.maxBodyBytes - held.bytes) {
        evidence.fail("fixture_body_overflow");
        req.destroy();
        res.destroy();
        return;
      }
      held.bytes += chunk.byteLength;
    });
    req.once("end", () => {
      held.bodyComplete = true;
      evidence.record("body_complete", key, held.bytes);
    });
    req.once("aborted", () => evidence.record("aborted", key));
    res.once("close", () => {
      clearTimeout(held.timer);
      held.closed = true;
      evidence.record("close", key);
    });
    return true;
  };
  return {
    handle,
    close,
    hold(key: string, options: { method: "GET" | "POST"; maxBodyBytes: number }) {
      if (
        !/^[a-zA-Z0-9_-]{1,64}$/u.test(key) ||
        holds.has(key) ||
        holds.size >= 4 ||
        !Number.isInteger(options.maxBodyBytes) ||
        options.maxBodyBytes < 0 ||
        options.maxBodyBytes > 1024
      )
        throw new Error("Invalid fixture hold");
      const timer = setTimeout(() => {
        evidence.fail("fixture_hold_deadline");
        const expired = holds.get(key);
        if (expired) {
          expired.expired = true;
          expired.response?.destroy();
        }
      }, 45_000);
      holds.set(key, {
        ...options,
        received: false,
        bodyComplete: false,
        bytes: 0,
        released: false,
        closed: false,
        expired: false,
        timer,
      });
    },
    release(key: string) {
      const held = holds.get(key);
      if (!held) throw new Error("Unknown fixture hold");
      if (held.released) return;
      held.released = true;
      clearTimeout(held.timer);
      if (held.closed) {
        evidence.record("release_already_closed", key);
        return;
      }
      if (!held.bodyComplete || !held.response) throw new Error("Fixture request not complete");
      evidence.record("release_write", key);
      held.response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      held.response.end("held-response", () => evidence.record("response_finish", key));
    },
    snapshot: () =>
      [...holds].map(([key, held]) => ({
        key,
        received: held.received,
        bodyComplete: held.bodyComplete,
        bytes: held.bytes,
        released: held.released,
        closed: held.closed,
      })),
    evidence: () => ({ events: evidence.events, failure: evidence.failure() }),
  };
}

function isContentHost(host: string) {
  return /^[a-z0-9-]{1,63}\.ticket04-content\.test$/u.test(host);
}

export async function listenPrivate(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (
        !address ||
        typeof address === "string" ||
        address.address !== "127.0.0.1" ||
        [6767, 6768, 61680].includes(address.port)
      ) {
        server.close();
        reject(new Error("Expected a private loopback listener"));
        return;
      }
      resolve(address.port);
    });
  });
}

export function trackConnections(server: Server) {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };
}

export async function startHostFixture(proof: string, scenario?: "history" | "boundary") {
  const requests: RequestEvidence[] = [];
  const controls = createFixtureHolds(proof);
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    requests.push({ method: req.method ?? "", path: req.url ?? "" });
    if (controls.handle(req, res, url)) return;
    if (
      scenario === "boundary" &&
      req.method === "GET" &&
      url.pathname === "/app/redirect" &&
      url.searchParams.get("proof") === proof
    ) {
      res
        .writeHead(302, { Location: `/outside?proof=${proof}`, "Cache-Control": "no-store" })
        .end();
      return;
    }
    if (
      req.method !== "GET" ||
      !["/app/start", "/app/second"].includes(url.pathname) ||
      url.searchParams.get("proof") !== proof
    ) {
      res.writeHead(404).end();
      return;
    }
    const second = url.pathname.endsWith("second");
    const historyControls =
      scenario === "history"
        ? `<button id="product-push" onclick="history.pushState({proof:'${proof}'},'',location.pathname+location.search+'#pushed')">Push state</button><button id="product-replace" onclick="history.replaceState({proof:'${proof}'},'',location.pathname+location.search+'#replaced')">Replace state</button>`
        : "";
    const boundaryControls =
      scenario === "boundary"
        ? `<button id="product-title-html">Literal title</button><button id="product-title-long">Long title</button><script>
document.getElementById('product-title-html').addEventListener('click',()=>{document.title='<img src=x onerror="globalThis.__titleExecuted=true">';});
document.getElementById('product-title-long').addEventListener('click',()=>{document.title='é'.repeat(800);});
</script>`
        : "";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(
      `<!doctype html><html><head><title>Product ${second ? "second" : "first"} ${proof}</title></head><body><h1 id="product-proof">${proof}</h1><p id="product-path">${url.pathname}${url.search}</p><a id="product-next" href="/app/second?proof=${proof}">Second document</a><a id="product-hash" href="#section">Same document</a>${historyControls}${boundaryControls}<p id="section">Section</p></body></html>`,
    );
  });
  const closeConnections = trackConnections(server);
  const close = async () => {
    controls.close();
    await closeConnections();
  };
  const port = await listenPrivate(server);
  return { origin: `http://127.0.0.1:${port}`, requests, controls, close };
}

async function createCertificate(root: string) {
  const keyPath = path.join(root, "key.pem");
  const certificatePath = path.join(root, "certificate.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "1",
      "-subj",
      "/CN=control.ticket04-control.test",
      "-addext",
      "subjectAltName=DNS:control.ticket04-control.test,DNS:*.ticket04-content.test",
    ],
    { stdio: "ignore" },
  );
  const publicKey = execFileSync("openssl", ["x509", "-in", certificatePath, "-pubkey", "-noout"]);
  const spki = execFileSync("openssl", ["pkey", "-pubin", "-outform", "DER"], { input: publicKey });
  return {
    key: await readFile(keyPath),
    cert: await readFile(certificatePath),
    pin: createHash("sha256").update(spki).digest("base64"),
  };
}

function proxyHttp(req: IncomingMessage, res: ServerResponse, port: number) {
  const upstream = request(
    {
      hostname: "127.0.0.1",
      port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `localhost:${port}` },
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.once("aborted", () => upstream.destroy());
  req.pipe(upstream);
}

function proxyUpgrade(
  req: IncomingMessage,
  downstream: Socket,
  head: Buffer,
  port: number,
  controlled?: ReturnType<typeof createDaemonLinks>,
) {
  const upstream = connect(port, "127.0.0.1");
  controlled?.attach(upstream, downstream);
  const close = () => {
    upstream.destroy();
    downstream.destroy();
  };
  upstream.once("error", close);
  downstream.once("error", close);
  downstream.once("close", () => upstream.destroy());
  upstream.once("close", () => downstream.destroy());
  upstream.once("connect", () => {
    const headers = Object.entries({ ...req.headers, host: `localhost:${port}` }).flatMap(
      ([name, value]) =>
        value === undefined ? [] : [`${name}: ${Array.isArray(value) ? value.join(", ") : value}`],
    );
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    downstream.pipe(upstream);
    if (!controlled) upstream.pipe(downstream);
  });
}

export async function startProductGateway(input: {
  root: string;
  metroPort: number;
  daemonPort: number;
  shell: ProductShellAssets;
}) {
  const certificate = await createCertificate(input.root);
  const daemonLinks = createDaemonLinks();
  const served: Array<{ path: string; sha256: string }> = [];
  const assets = new Map(input.shell.assets.map((asset) => [asset.path, asset]));
  for (const asset of input.shell.assets) {
    const digest = createHash("sha256").update(asset.bytes).digest("hex");
    if (
      digest !== asset.sha256 ||
      !input.shell.manifest.assets.some(
        (item) => item.path === asset.path && item.sha256 === digest,
      )
    )
      throw new Error("Shell asset does not match its manifest");
  }
  const server = createHttpsServer(certificate, (req, res) => {
    const host = req.headers.host ?? "";
    if (host === CONTROL_HOST) {
      proxyHttp(req, res, input.metroPort);
      return;
    }
    if (!isContentHost(host) || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(403).end();
      return;
    }
    const asset = assets.get(req.url ?? "");
    if (!asset) {
      res.writeHead(404).end();
      return;
    }
    served.push({ path: asset.path, sha256: asset.sha256 });
    res.writeHead(200, {
      ...asset.headers,
      "Content-Type": asset.contentType,
      "Content-Length": asset.bytes.byteLength,
    });
    res.end(req.method === "HEAD" ? undefined : asset.bytes);
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.headers.host !== CONTROL_HOST || req.headers.origin !== CONTROL) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", CONTROL);
    let port: number | null = null;
    if (url.pathname === "/ws") {
      if (!daemonLinks.accept()) {
        socket.destroy();
        return;
      }
      port = input.daemonPort;
    } else if (["/hot", "/message", "/inspector/device"].includes(url.pathname))
      port = input.metroPort;
    if (port === null) {
      socket.destroy();
      return;
    }
    proxyUpgrade(
      req,
      socket as Socket,
      head,
      port,
      url.pathname === "/ws" ? daemonLinks : undefined,
    );
  });
  const close = trackConnections(server);
  const port = await listenPrivate(server);
  return { port, certificatePin: certificate.pin, served, daemonLinks, close };
}

// Restrict browser egress, including IP literals and Service Worker fetches.
// CONNECT targets are resolved to our gateway; the proxy never performs DNS.
export async function startBrowserEgress(gatewayPort: number) {
  const denied: string[] = [];
  const server = createHttpServer((req, res) => {
    denied.push(req.url ?? "");
    res.writeHead(403).end();
  });
  server.on("connect", (req, socket, head) => {
    const target = req.url ?? "";
    const host = target.endsWith(":443") ? target.slice(0, -4) : "";
    if (host !== CONTROL_HOST && !isContentHost(host)) {
      denied.push(target);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(gatewayPort, "127.0.0.1");
    socket.once("error", () => upstream.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.once("error", () => socket.destroy());
    upstream.once("close", () => socket.destroy());
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  });
  const close = trackConnections(server);
  const port = await listenPrivate(server);
  return { port, denied, close };
}
