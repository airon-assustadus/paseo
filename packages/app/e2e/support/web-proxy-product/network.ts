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
import type { ProductShellAssets } from "../../../src/web-proxy/shell/product-assets";

export const CONTROL = "https://control.ticket04-control.test";
export const CONTENT_DOMAIN = "ticket04-content.test";
const CONTROL_HOST = new URL(CONTROL).host;

export interface RequestEvidence {
  method: string;
  path: string;
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
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    requests.push({ method: req.method ?? "", path: req.url ?? "" });
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
  const close = trackConnections(server);
  const port = await listenPrivate(server);
  return { origin: `http://127.0.0.1:${port}`, requests, close };
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

function proxyUpgrade(req: IncomingMessage, downstream: Socket, head: Buffer, port: number) {
  const upstream = connect(port, "127.0.0.1");
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
    downstream.pipe(upstream).pipe(downstream);
  });
}

export async function startProductGateway(input: {
  root: string;
  metroPort: number;
  daemonPort: number;
  shell: ProductShellAssets;
}) {
  const certificate = await createCertificate(input.root);
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
    if (url.pathname === "/ws") port = input.daemonPort;
    else if (["/hot", "/message", "/inspector/device"].includes(url.pathname))
      port = input.metroPort;
    if (port === null) {
      socket.destroy();
      return;
    }
    proxyUpgrade(req, socket as Socket, head, port);
  });
  const close = trackConnections(server);
  const port = await listenPrivate(server);
  return { port, certificatePin: certificate.pin, served, close };
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
