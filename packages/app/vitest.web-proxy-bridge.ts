import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "esbuild";

/**
 * Vitest browser command that starts the web proxy bridge host on first use (adapter contract §7).
 * Runs in the Vitest Node process. The host and esbuild load inside the first call, so a run whose
 * tests never ask for the bridge opens nothing. Takes no input from the browser: the page origin,
 * the shell entries and the host module are all decided here, and only the host's public
 * description crosses back to the page.
 */

export interface BridgeFixtureInfo {
  http: { origin: string };
  https: { origin: string; caPem: string; serverNames: string[] } | null;
  httpsVariants: { wrongHost: string; expired: string; selfSigned: string } | null;
  canary: { origin: string } | null;
}

export interface BridgeShellInfo {
  listenerPort: number;
  origins: { a: string; b: string };
}

/** What the page receives: the host's public description, nothing that only exists in Node. */
export interface WebProxyBridgeInfo {
  url: string;
  token: string;
  allowedOrigin: string;
  fixture: BridgeFixtureInfo;
  shell: BridgeShellInfo;
}

declare module "vitest/browser" {
  interface BrowserCommands {
    webProxyBridge(): Promise<WebProxyBridgeInfo>;
  }
}

/** Executable shell entries: the bootstrap page module and the service worker script. */
export interface BridgeShellBundle {
  bootstrapJs: string;
  workerJs: string;
}

export interface BridgeHostOptions {
  shell: BridgeShellBundle;
  allowedOrigin: string;
}

/** The slice of Vitest's `BrowserCommandContext` the command reads. */
export interface BridgeCommandContext {
  project: {
    vitest: { onClose(fn: () => Promise<void>): void };
    browser?: { vite: { resolvedUrls: { local: string[] } | null } };
    import(moduleId: string): Promise<unknown>;
  };
}

export type WebProxyBridgeProblem =
  | "unexpected_arguments"
  | "no_browser_origin"
  | "host_module_invalid"
  | "host_result_invalid"
  | "closed_during_start";

export class WebProxyBridgeError extends Error {
  constructor(
    readonly problem: WebProxyBridgeProblem,
    message: string,
  ) {
    super(message);
    this.name = "WebProxyBridgeError";
  }
}

export interface WebProxyBridgeOptions {
  hostModulePath: string;
  bundleShell(controlOrigin: string): Promise<BridgeShellBundle>;
}

/**
 * Deployment layout of the shell, served by the bridge host: worker scope and mount point are
 * "/", the shell lives under /__paseo/, and the app frame enters through a path the worker
 * intercepts before the shell prefix.
 */
export const BRIDGE_SHELL_LAYOUT = {
  shellPathPrefix: "/__paseo/",
  bootstrapPath: "/__paseo/bootstrap.html",
  workerUrl: "/__paseo/sw.js",
  enterPath: "/__paseo/enter",
  scope: "/",
} as const;

const HOST_MODULE = "../server/src/server/network-fetch/__fixtures__/bridge-host.ts";
const SHELL_SOURCES = {
  bootstrap: "src/web-proxy/shell/bootstrap.web.ts",
  worker: "src/web-proxy/shell/worker.web.ts",
  // Lab timings already exercised by the shell's browser harness (D-LAZY-1), not a production budget.
  harness: "src/web-proxy/__fixtures__/shell/harness.ts",
  limits: "src/web-proxy/bridge-messages.ts",
} as const;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ENTRY_NAMESPACE = "paseo-bridge-entry";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function browserOrigin(context: BridgeCommandContext): string {
  const local = context.project.browser?.vite.resolvedUrls?.local[0];
  if (local === undefined) {
    throw new WebProxyBridgeError("no_browser_origin", "The browser server has no local URL");
  }
  return new URL(local).origin;
}

type StartBridgeHost = (options: BridgeHostOptions) => Promise<unknown>;

function hostStarter(module: unknown): StartBridgeHost {
  const start: unknown = isRecord(module) ? module.startBridgeHost : undefined;
  if (typeof start !== "function") {
    throw new WebProxyBridgeError(
      "host_module_invalid",
      "The bridge host module does not export startBridgeHost",
    );
  }
  return async (options) => start(options);
}

function loopbackOrigin(value: unknown, protocol: "http:" | "https:"): string | null {
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const url = new URL(value);
  const isLoopback = url.protocol === protocol && url.hostname === "127.0.0.1";
  return isLoopback && url.origin === value ? value : null;
}

function originOf(value: unknown, protocol: "http:" | "https:"): { origin: string } | null {
  if (!isRecord(value)) return null;
  const origin = loopbackOrigin(value.origin, protocol);
  return origin === null ? null : { origin };
}

function parseHttps(value: unknown): BridgeFixtureInfo["https"] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const origin = loopbackOrigin(value.origin, "https:");
  const { caPem, serverNames } = value;
  if (origin === null || typeof caPem !== "string" || !caPem.startsWith("-----BEGIN ")) {
    return undefined;
  }
  if (!Array.isArray(serverNames)) return undefined;
  const names = serverNames.filter((name): name is string => typeof name === "string");
  if (names.length !== serverNames.length) return undefined;
  return { origin, caPem, serverNames: names };
}

function parseVariants(value: unknown): BridgeFixtureInfo["httpsVariants"] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const wrongHost = loopbackOrigin(value.wrongHost, "https:");
  const expired = loopbackOrigin(value.expired, "https:");
  const selfSigned = loopbackOrigin(value.selfSigned, "https:");
  if (wrongHost === null || expired === null || selfSigned === null) return undefined;
  return { wrongHost, expired, selfSigned };
}

function parseFixture(value: unknown): BridgeFixtureInfo | null {
  if (!isRecord(value)) return null;
  const http = originOf(value.http, "http:");
  const https = parseHttps(value.https);
  const httpsVariants = parseVariants(value.httpsVariants);
  const canary = value.canary === null ? null : originOf(value.canary, "http:");
  const hasMissingCanary = value.canary !== null && canary === null;
  if (http === null || https === undefined || httpsVariants === undefined || hasMissingCanary) {
    return null;
  }
  return { http, https, httpsVariants, canary };
}

/** The static listener serves exactly the two content names on its own port. */
function parseShell(value: unknown): BridgeShellInfo | null {
  if (!isRecord(value) || !isRecord(value.origins)) return null;
  const port = value.listenerPort;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const a = `http://wp-a.localhost:${port}`;
  const b = `http://wp-b.localhost:${port}`;
  if (value.origins.a !== a || value.origins.b !== b) return null;
  return { listenerPort: port, origins: { a, b } };
}

interface ParsedHost {
  /** Present whenever the result can be shut down, even if the rest of it is malformed. */
  close: (() => Promise<void>) | null;
  info: WebProxyBridgeInfo | null;
}

/**
 * Accepts the host only when its public description is shaped as decided, and copies that
 * description field by field: backend, stats, hooks, and any extra property stay in Node.
 */
function parseHost(value: unknown, allowedOrigin: string): ParsedHost {
  if (!isRecord(value)) return { close: null, info: null };
  const { close } = value;
  if (typeof close !== "function") return { close: null, info: null };
  const shutdown = async () => {
    await close.call(value);
  };
  const { url, token } = value;
  const fixture = parseFixture(value.fixture);
  const shell = parseShell(value.shell);
  const isUrl = typeof url === "string" && URL.canParse(url) && isBridgeUrl(new URL(url));
  const isToken = typeof token === "string" && TOKEN.test(token);
  const isComplete =
    isUrl && isToken && value.allowedOrigin === allowedOrigin && fixture !== null && shell !== null;
  if (!isComplete) return { close: shutdown, info: null };
  return { close: shutdown, info: { url, token, allowedOrigin, fixture, shell } };
}

function isBridgeUrl(url: URL): boolean {
  return url.protocol === "ws:" && url.hostname === "127.0.0.1" && url.pathname === "/bridge";
}

export function createWebProxyBridgeCommand(options: WebProxyBridgeOptions) {
  const runs = new WeakMap<object, Promise<WebProxyBridgeInfo>>();

  async function start(context: BridgeCommandContext): Promise<WebProxyBridgeInfo> {
    let close: (() => Promise<void>) | null = null;
    let isClosed = false;
    // Registered before anything opens, so a run that ends mid-start still releases the host.
    context.project.vitest.onClose(async () => {
      isClosed = true;
      const current = close;
      close = null;
      await current?.();
    });
    const allowedOrigin = browserOrigin(context);
    const shell = await options.bundleShell(allowedOrigin);
    const startHost = hostStarter(await context.project.import(options.hostModulePath));
    const parsed = parseHost(await startHost({ shell, allowedOrigin }), allowedOrigin);
    if (parsed.info === null) {
      if (parsed.close) await parsed.close();
      throw new WebProxyBridgeError(
        "host_result_invalid",
        "The bridge host did not return its decided public description and close()",
      );
    }
    if (isClosed) {
      await parsed.close?.();
      throw new WebProxyBridgeError("closed_during_start", "Vitest closed while the host started");
    }
    close = parsed.close;
    return parsed.info;
  }

  return function webProxyBridge(
    context: BridgeCommandContext,
    ...payload: unknown[]
  ): Promise<WebProxyBridgeInfo> {
    if (payload.length > 0) {
      return Promise.reject(
        new WebProxyBridgeError("unexpected_arguments", "webProxyBridge takes no arguments"),
      );
    }
    const vitest = context.project.vitest;
    let run = runs.get(vitest);
    if (!run) {
      // A failed start stays the answer for this run: tests see the same error, never a retry.
      run = start(context);
      runs.set(vitest, run);
    }
    return run;
  };
}

/** The esbuild the app declares, not whichever copy the workspace root hoisted. */
export function resolveAppEsbuild(appRoot: string): typeof import("esbuild") {
  return createRequire(path.join(appRoot, "package.json"))("esbuild");
}

function importFrom(appRoot: string, source: string): string {
  return JSON.stringify(path.join(appRoot, source));
}

/** Entry modules that start the real shell; the control origin is the one resolved in Node. */
export function shellEntrySources(appRoot: string, controlOrigin: string) {
  const origin = JSON.stringify(new URL(controlOrigin).origin);
  const layout = BRIDGE_SHELL_LAYOUT;
  const bootstrap = [
    `import { startShellBootstrap } from ${importFrom(appRoot, SHELL_SOURCES.bootstrap)};`,
    `import { HARNESS } from ${importFrom(appRoot, SHELL_SOURCES.harness)};`,
    "void startShellBootstrap({",
    "  window,",
    `  controlOrigin: ${origin},`,
    `  workerUrl: ${JSON.stringify(layout.workerUrl)},`,
    `  workerScope: ${JSON.stringify(layout.scope)},`,
    '  workerType: "module",',
    `  enterPath: ${JSON.stringify(layout.enterPath)},`,
    "  sessionReplyTimeoutMs: HARNESS.sessionReplyTimeoutMs,",
    "});",
  ].join("\n");
  const worker = [
    `import { installShellWorker } from ${importFrom(appRoot, SHELL_SOURCES.worker)};`,
    `import { HARNESS } from ${importFrom(appRoot, SHELL_SOURCES.harness)};`,
    `import { DEFAULT_BRIDGE_LIMITS } from ${importFrom(appRoot, SHELL_SOURCES.limits)};`,
    "installShellWorker(globalThis, {",
    `  controlOrigin: ${origin},`,
    `  shellPathPrefix: ${JSON.stringify(layout.shellPathPrefix)},`,
    `  bootstrapPath: ${JSON.stringify(layout.bootstrapPath)},`,
    `  mountPath: ${JSON.stringify(layout.scope)},`,
    `  enterPath: ${JSON.stringify(layout.enterPath)},`,
    "  headTimeoutMs: HARNESS.headTimeoutMs,",
    "  idleChunkTimeoutMs: HARNESS.idleChunkTimeoutMs,",
    "  ticketTtlMs: HARNESS.ticketTtlMs,",
    "  formationTtlMs: HARNESS.formationTtlMs,",
    "  resyncTimeoutMs: HARNESS.resyncTimeoutMs,",
    "  maxRequestBodyBytes: DEFAULT_BRIDGE_LIMITS.maxRequestBodyBytes,",
    "});",
  ].join("\n");
  return { bootstrap, worker };
}

/** Bundles the two executable shell entries with the app's esbuild; nothing is written to disk. */
export function createShellBundler(
  appRoot: string,
): (controlOrigin: string) => Promise<BridgeShellBundle> {
  return async function bundleShell(controlOrigin) {
    const esbuild = resolveAppEsbuild(appRoot);
    const sources = shellEntrySources(appRoot, controlOrigin);
    const entries: Plugin = {
      name: ENTRY_NAMESPACE,
      setup(build) {
        build.onResolve({ filter: /^paseo-bridge-entry:/ }, (args) => ({
          path: args.path.slice(`${ENTRY_NAMESPACE}:`.length),
          namespace: ENTRY_NAMESPACE,
        }));
        build.onLoad({ filter: /.*/, namespace: ENTRY_NAMESPACE }, (args) => ({
          contents: args.path === "bootstrap" ? sources.bootstrap : sources.worker,
          loader: "ts",
          resolveDir: appRoot,
        }));
      },
    };
    const result = await esbuild.build({
      absWorkingDir: appRoot,
      entryPoints: {
        bootstrap: `${ENTRY_NAMESPACE}:bootstrap`,
        worker: `${ENTRY_NAMESPACE}:worker`,
      },
      plugins: [entries],
      outdir: "web-proxy-bridge",
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      logLevel: "silent",
    });
    const output = (name: "bootstrap" | "worker") => {
      const file = result.outputFiles.find((entry) => path.basename(entry.path) === `${name}.js`);
      if (!file) throw new Error(`esbuild produced no ${name}.js`);
      return file.text;
    };
    return { bootstrapJs: output("bootstrap"), workerJs: output("worker") };
  };
}

/** The command as the app's browser project registers it. */
export function webProxyBridgeCommandFor(appRoot: string) {
  return createWebProxyBridgeCommand({
    hostModulePath: path.resolve(appRoot, HOST_MODULE),
    bundleShell: createShellBundler(appRoot),
  });
}
