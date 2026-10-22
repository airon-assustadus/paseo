import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Plugin } from "esbuild";
import {
  createShellBundler,
  resolveAppEsbuild,
  type BridgeCommandContext,
} from "../../../../vitest.web-proxy-bridge";

export const BASE = "/storage/workspace-assustadus/paseo-plans/browser-host-network/web-proxy-dev";
export const CONTROL = "https://ssh.assustadus.tech";
export const CONTENT = "https://paseo-content.assustadus.com";
const CONTROL_DIR = path.join(BASE, "domain-functional/control");
const PUBLISHED = path.join(CONTROL_DIR, "dist/6c65a42d65c9-close1");
const PINS: Record<string, string> = {
  "manifest.json": "8323af8a7f1e9a2073263f19bacd361630be39ad05c357ce9d65be6deff940ea",
  "control/control.js": "343168aed5a624880b4d77a6ed9a8a09a04333a89d3bb32a340d97fff5360910",
  "control/index.html": "6b7d953fe422be51f96ffc8a0ce7581f97faf47ace188803f7cd9dec4867ddbd",
  "control/control.css": "7d072f3faff8d5590f4c4cb150602bdb9508ea6829bd7bb7e04f7f7db0d2e9d3",
  "content/__paseo/bootstrap.html":
    "1352fd5ab23bf9531dfe9d476cb6a4959e15e7f7bc08f3b1816e27d2645aa279",
  "content/__paseo/bootstrap.js":
    "2474ca286e60e6084478782892d48801a1ebb4ee861dc55e95f58a0a0ef53f42",
  "content/__paseo/sw.js": "9e1c265ddee72127d9085b6fba640a3912890d4259f8a2d7802e156264879a4f",
};

const CONTROL_PINS: Record<string, string> = {
  "src/session.ts": "e8b2dbff5ae7192f2e484c899e0fa71642e54608a4bc9ed6118fbb83eaa314c8",
  "src/session-lifecycle.ts": "b6706124c778d67fb0deca6392324cb1257b50597d050bbd004eea6374a1d691",
  "src/lab.ts": "7e150ee5f351a0eec1b29b3d656d1346c730d6c188b07a6f5dd5914320a00338",
  "src/main.ts": "b5404e66814ed82c2f1d1b2b28c24192314d9458fba6438a4d9a46d3f2c06917",
};

async function checkControlPins(): Promise<void> {
  for (const [file, pin] of Object.entries(CONTROL_PINS)) {
    assert.equal(
      digest(await readFile(path.join(CONTROL_DIR, file))),
      pin,
      `final control source ${file}`,
    );
  }
}

export type Version = "old" | "new";
export interface Selection {
  control: Version | "probe";
  shell: Version;
  worker: Version;
}

interface RelayStack {
  host: {
    backend: {
      events: {
        list(): ReadonlyArray<{ kind: string; path?: string; method?: string }>;
        waitFor(
          kind: "post.count",
          predicate: (event: { token: string }) => boolean,
        ): Promise<unknown>;
      };
      postCount(token: string): number;
      releasePost(token: string): number;
    };
  };
  info: {
    relay: { endpoint: string };
    daemon: { serverId: string; daemonPublicKeyB64: string };
    bridge: { tcpPort: number; token: string };
  };
  close(): Promise<void>;
}

export interface BenchView {
  context: BrowserContext;
  page: Page;
  selection: Selection;
  close(): Promise<void>;
}

export interface LifecycleBench {
  browser: Browser;
  hashes: Record<string, string>;
  served: Array<{ file: string; sha256: string }>;
  open(selection: Selection): Promise<BenchView>;
  cutRelay(): void;
  restoreRelay(): void;
  requestCount(pathname: string): number;
  postCount(token: string): number;
  waitPost(token: string): Promise<void>;
  releasePost(token: string): number;
  close(): Promise<void>;
}

export function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function versionFor(site: string, pathname: string, selection: Selection): Selection["control"] {
  if (site === "control") return selection.control;
  if (pathname.endsWith("sw.js")) return selection.worker;
  return selection.shell;
}

function headersFor(site: string, file: string): Record<string, string> {
  let type = "text/html";
  if (file.endsWith(".js")) type = "text/javascript";
  if (file.endsWith(".css")) type = "text/css";
  const headers: Record<string, string> = {
    "content-type": type,
    "cache-control": "no-store, no-transform",
    "x-content-type-options": "nosniff",
  };
  if (site === "content" && file.endsWith(".html"))
    headers["content-security-policy"] = `frame-ancestors ${CONTROL}`;
  if (file.endsWith("sw.js")) headers["service-worker-allowed"] = "/";
  return headers;
}

async function bundleControl(appRoot: string): Promise<Buffer> {
  const esbuild = resolveAppEsbuild(appRoot);
  const aliases: Record<string, string> = {
    "paseo-lab-codec": path.resolve(
      appRoot,
      "../server/src/server/network-fetch/__fixtures__/length-prefixed.ts",
    ),
    "@getpaseo/relay/e2ee": path.resolve(appRoot, "../relay/src/e2ee.ts"),
  };
  const resolution: Plugin = {
    name: "lifecycle-compat-control-resolution",
    setup(build) {
      build.onResolve({ filter: /^paseo-lab-codec$|^@getpaseo\/relay\/e2ee$/ }, (args) => ({
        path: aliases[args.path],
      }));
      build.onResolve({ filter: /^@\// }, (args) =>
        build.resolve(`./${args.path.slice(2)}`, {
          kind: args.kind,
          resolveDir: path.join(appRoot, "src"),
          pluginData: { resolved: true },
        }),
      );
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.pluginData?.resolved || !args.importer.startsWith(CONTROL_DIR)) return;
        return build.resolve(args.path, {
          kind: args.kind,
          resolveDir: appRoot,
          pluginData: { resolved: true },
        });
      });
    },
  };
  const result = await esbuild.build({
    absWorkingDir: appRoot,
    entryPoints: [path.join(CONTROL_DIR, "src/main.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    resolveExtensions: [".web.ts", ".web.tsx", ".web.js", ".ts", ".tsx", ".mjs", ".js", ".json"],
    define: {
      __PASEO_CONTROL_CONFIG__: JSON.stringify({
        controlOrigin: CONTROL,
        contentOrigins: { a: CONTENT, b: "https://paseo-content-b.assustadus.com" },
        relayEndpoint: "ssh.assustadus.tech:443",
      }),
      "process.env.NODE_ENV": '"production"',
    },
    plugins: [resolution],
    minify: true,
    legalComments: "none",
    write: false,
    logLevel: "silent",
  });
  assert(result.outputFiles[0]);
  return Buffer.from(result.outputFiles[0].contents);
}

interface CandidateBundles {
  shell: { bootstrapJs: string; workerJs: string };
  probeJs: Buffer;
}

// Every scenario in a Vitest run uses one compiled snapshot; contexts and servers stay separate.
const candidates = new WeakMap<object, Promise<CandidateBundles>>();
const controls = new WeakMap<object, Promise<Buffer>>();

function candidateFor(appRoot: string, owner: object): Promise<CandidateBundles> {
  let pending = candidates.get(owner);
  if (!pending) {
    pending = (async () => {
      const shell = await createShellBundler(appRoot)(CONTROL);
      const probe = await resolveAppEsbuild(appRoot).build({
        absWorkingDir: appRoot,
        entryPoints: [path.join(appRoot, "src/web-proxy/__fixtures__/lifecycle-compat/probe.ts")],
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
        write: false,
      });
      assert(probe.outputFiles[0]);
      return { shell, probeJs: Buffer.from(probe.outputFiles[0].contents) };
    })();
    candidates.set(owner, pending);
  }
  return pending;
}

/** One private TLS endpoint. DNS changes exist only in this browser's resolver rules. */
export async function createLifecycleBench(
  appRoot: string,
  command: BridgeCommandContext,
): Promise<LifecycleBench> {
  const old = new Map<string, Buffer>();
  const hashes: Record<string, string> = {};
  for (const [file, pin] of Object.entries(PINS)) {
    const bytes = await readFile(path.join(PUBLISHED, file));
    assert.equal(digest(bytes), pin, `published pin ${file}`);
    old.set(file, bytes);
    hashes[`old/${file}`] = pin;
  }
  const manifest = JSON.parse(old.get("manifest.json")!.toString()) as {
    files: Array<{ site: string; path: string; headers: Record<string, string> }>;
  };
  const publishedHeaders = new Map(
    manifest.files.map((file) => [`${file.site}${file.path}`, file.headers]),
  );
  const { shell, probeJs } = await candidateFor(appRoot, command.project.vitest);
  const candidate = new Map<string, Buffer>([
    ["content/__paseo/bootstrap.html", old.get("content/__paseo/bootstrap.html")!],
    ["content/__paseo/bootstrap.js", Buffer.from(shell.bootstrapJs)],
    ["content/__paseo/sw.js", Buffer.from(shell.workerJs)],
  ]);
  hashes["new/probe.js"] = digest(probeJs);
  for (const [file, bytes] of candidate) hashes[`new/${file}`] = digest(bytes);

  const temp = await mkdtemp(path.join(tmpdir(), "paseo-lifecycle-tls-"));
  let browser: Browser | undefined;
  let stack: RelayStack | undefined;
  let selection: Selection | null = null;
  let relayAllowed = true;
  const sockets = new Set<Socket>();
  const served: LifecycleBench["served"] = [];
  const key = path.join(temp, "key.pem");
  const cert = path.join(temp, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=lifecycle.local",
      "-addext",
      "subjectAltName=DNS:ssh.assustadus.tech,DNS:paseo-content.assustadus.com",
    ],
    { stdio: "ignore" },
  );
  const pubkey = execFileSync("openssl", ["x509", "-in", cert, "-pubkey", "-noout"]);
  const spki = execFileSync("openssl", ["pkey", "-pubin", "-outform", "DER"], { input: pubkey });
  const certPin = createHash("sha256").update(spki).digest("base64");
  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (req, res) => {
      const host = req.headers.host;
      const url = new URL(req.url ?? "/", CONTROL);
      if (
        !selection ||
        (host !== new URL(CONTROL).hostname && host !== new URL(CONTENT).hostname)
      ) {
        res.writeHead(403).end();
        return;
      }
      if (
        host === new URL(CONTROL).hostname &&
        url.pathname === "/bootstrap" &&
        req.method === "POST" &&
        stack
      ) {
        req.resume();
        const { daemon, bridge } = stack.info;
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(
          JSON.stringify({
            v: 1,
            offer: { ...daemon, relay: { endpoint: "ssh.assustadus.tech:443", useTls: true } },
            bridge: { tcpPort: bridge.tcpPort, token: bridge.token },
          }),
        );
        return;
      }
      const site = host === new URL(CONTROL).hostname ? "control" : "content";
      const file = `${site}${url.pathname === "/" ? "/index.html" : url.pathname}`;
      let bytes: Buffer | undefined;
      const version = versionFor(site, url.pathname, selection);
      if (version === "probe") {
        bytes =
          url.pathname === "/probe.js"
            ? probeJs
            : Buffer.from(
                '<!doctype html><div id="frame"></div><script type="module" src="/probe.js"></script>',
              );
      } else bytes = (version === "old" ? old : candidate).get(file);
      if (!bytes) {
        res.writeHead(404).end();
        return;
      }
      served.push({ file: `${version}/${file}`, sha256: digest(bytes) });
      res.writeHead(200, publishedHeaders.get(file) ?? headersFor(site, file));
      res.end(bytes);
    },
  );
  server.on("upgrade", (req, socket, head) => {
    if (!relayAllowed || !stack || req.headers.host !== new URL(CONTROL).hostname) {
      socket.destroy();
      return;
    }
    const endpoint = new URL(`http://${stack.info.relay.endpoint}`);
    const upstream = connect(Number(endpoint.port), "127.0.0.1");
    sockets.add(upstream);
    upstream.on("close", () => {
      sockets.delete(upstream);
      socket.destroy();
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("connect", () => {
      const headers = Object.entries(req.headers)
        .map(([name, value]) => `${name}: ${name === "host" ? endpoint.host : value}`)
        .join("\r\n");
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const failures: unknown[] = [];
      await browser?.close().catch((error: unknown) => failures.push(error));
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await stack?.close().catch((error: unknown) => failures.push(error));
      await rm(temp, { recursive: true, force: true }).catch((error: unknown) =>
        failures.push(error),
      );
      if (failures.length) throw new AggregateError(failures, "Lifecycle bench cleanup failed");
    })());
  command.project.vitest.onClose(close);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      args: [
        "--no-proxy-server",
        `--ignore-certificate-errors-spki-list=${certPin}`,
        `--host-resolver-rules=MAP ssh.assustadus.tech:443 127.0.0.1:${address.port}, MAP paseo-content.assustadus.com:443 127.0.0.1:${address.port}, MAP * ~NOTFOUND`,
      ],
    });
    console.log("LIFECYCLE_BUILD", JSON.stringify({ browser: browser.version(), hashes }));
    return {
      browser,
      hashes,
      served,
      async open(next) {
        assert.equal(selection, null, "one scenario per bench at a time");
        selection = next;
        relayAllowed = true;
        if (next.control !== "probe" && !stack) {
          const module = (await command.project.import(
            path.resolve(
              appRoot,
              "../server/src/server/network-fetch/__fixtures__/relay-bridge-stack.ts",
            ),
          )) as {
            startRelayBridgeStack(options: {
              shell: typeof shell;
              allowedOrigin: string;
            }): Promise<RelayStack>;
          };
          stack = await module.startRelayBridgeStack({ shell, allowedOrigin: CONTROL });
        }
        if (next.control === "new" && !candidate.has("control/control.js")) {
          await checkControlPins();
          let pending = controls.get(command.project.vitest);
          if (!pending) {
            pending = bundleControl(appRoot);
            controls.set(command.project.vitest, pending);
          }
          candidate.set("control/control.js", await pending);
          await checkControlPins();
          for (const [file, pin] of Object.entries(CONTROL_PINS))
            hashes[`source/control/${file}`] = pin;
          for (const file of ["index.html", "control.css"])
            candidate.set(
              `control/${file}`,
              await readFile(path.join(CONTROL_DIR, "static", file)),
            );
          for (const [file, bytes] of candidate) hashes[`new/${file}`] = digest(bytes);
          console.log("LIFECYCLE_CONTROL_BUILD", JSON.stringify(hashes));
        }
        const context = await browser!.newContext({ viewport: { width: 1200, height: 900 } });
        await context.addInitScript(() => {
          const messages: Array<{ type: string; reason?: string }> = [];
          const original = MessagePort.prototype.postMessage;
          MessagePort.prototype.postMessage = function (
            message: unknown,
            options?: Transferable[] | StructuredSerializeOptions,
          ) {
            const value = message as { type?: unknown; reason?: unknown };
            if (typeof value?.type === "string" && value.type.startsWith("paseo.web.")) {
              messages.push({
                type: value.type,
                ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
              });
            }
            Reflect.apply(original, this, [message, options]);
          };
          Object.defineProperty(window, "__lifecycleWire", { value: messages });
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => console.log("lifecycle pageerror", error.message));
        await page.goto(CONTROL);
        if (next.control !== "probe") {
          await page.locator("#code").fill("AAAAAAAAAAAAAAAAAAAA");
          await page.locator("#connect button").click();
        }
        return {
          context,
          page,
          selection: next,
          async close() {
            await context.close();
            for (const socket of sockets) socket.destroy();
            selection = null;
          },
        };
      },
      cutRelay() {
        relayAllowed = false;
        for (const socket of sockets) socket.destroy();
      },
      restoreRelay() {
        relayAllowed = true;
      },
      requestCount(pathname) {
        assert(stack);
        return stack.host.backend.events
          .list()
          .filter((event) => event.kind === "request" && event.path === pathname).length;
      },
      postCount(token) {
        assert(stack);
        return stack.host.backend.postCount(token);
      },
      async waitPost(token) {
        assert(stack);
        await stack.host.backend.events.waitFor("post.count", (event) => event.token === token);
      },
      releasePost(token) {
        assert(stack);
        return stack.host.backend.releasePost(token);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
