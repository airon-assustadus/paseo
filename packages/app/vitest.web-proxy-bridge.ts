import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Vitest browser command that starts the web proxy bridge host on first use (adapter contract §7).
 * Runs in the Vitest Node process. The host and esbuild load inside the first call, so a run whose
 * tests never ask for the bridge opens nothing. Takes no input from the browser: the page origin,
 * the shell entries and the host module are all decided here.
 */

export interface WebProxyBridgeInfo {
  url: string;
  token: string;
  allowedOrigin: string;
  contentOrigins: string[];
}

declare module "vitest/browser" {
  interface BrowserCommands {
    webProxyBridge(): Promise<WebProxyBridgeInfo>;
  }
}

/** ESM library modules exporting `startShellBootstrap` and `installShellWorker`. */
export interface BridgeShellBundle {
  bootstrapJs: string;
  workerJs: string;
}

export interface BridgeHostOptions {
  shell: BridgeShellBundle;
  allowedOrigin: string;
  token: string;
}

export interface BridgeHost {
  url: string;
  contentOrigins: string[];
  close(): Promise<void>;
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
  bundleShell(): Promise<BridgeShellBundle>;
  createToken(): string;
}

const SHELL_ENTRIES = {
  bootstrap: "src/web-proxy/shell/bootstrap.web.ts",
  worker: "src/web-proxy/shell/worker.web.ts",
} as const;

const HOST_MODULE = "../server/src/server/network-fetch/__fixtures__/bridge-host.ts";

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

function isLoopbackBridgeUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "ws:" && url.hostname === "127.0.0.1";
}

function isContentOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "http:" && url.hostname.endsWith(".localhost") && url.origin === value;
}

interface ParsedHost {
  /** Present whenever the result can be shut down, even if the rest of it is malformed. */
  close: (() => Promise<void>) | null;
  host: BridgeHost | null;
}

/** Accepts the host only when it is shaped as proposed and its URL is loopback. */
function parseHost(value: unknown): ParsedHost {
  if (!isRecord(value)) return { close: null, host: null };
  const { url, contentOrigins, close } = value;
  if (typeof close !== "function") return { close: null, host: null };
  const shutdown = async () => {
    await close.call(value);
  };
  if (typeof url !== "string" || !isLoopbackBridgeUrl(url) || !Array.isArray(contentOrigins)) {
    return { close: shutdown, host: null };
  }
  const origins = contentOrigins.filter(
    (origin): origin is string => typeof origin === "string" && isContentOrigin(origin),
  );
  if (origins.length === 0 || origins.length !== contentOrigins.length) {
    return { close: shutdown, host: null };
  }
  return { close: shutdown, host: { url, contentOrigins: origins, close: shutdown } };
}

export function createWebProxyBridgeCommand(options: WebProxyBridgeOptions) {
  const runs = new WeakMap<object, Promise<WebProxyBridgeInfo>>();

  async function start(context: BridgeCommandContext): Promise<WebProxyBridgeInfo> {
    let host: BridgeHost | null = null;
    let isClosed = false;
    // Registered before anything opens, so a run that ends mid-start still releases the host.
    context.project.vitest.onClose(async () => {
      isClosed = true;
      const current = host;
      host = null;
      await current?.close();
    });
    const allowedOrigin = browserOrigin(context);
    const shell = await options.bundleShell();
    const startHost = hostStarter(await context.project.import(options.hostModulePath));
    const token = options.createToken();
    const parsed = parseHost(await startHost({ shell, allowedOrigin, token }));
    const started = parsed.host;
    if (started === null) {
      if (parsed.close) await parsed.close();
      throw new WebProxyBridgeError(
        "host_result_invalid",
        "The bridge host did not return close(), a loopback URL and content origins",
      );
    }
    if (isClosed) {
      await started.close();
      throw new WebProxyBridgeError("closed_during_start", "Vitest closed while the host started");
    }
    host = started;
    return { url: started.url, token, allowedOrigin, contentOrigins: started.contentOrigins };
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

/** Bundles the shell's fixed entries with the app's esbuild. */
export function createShellBundler(appRoot: string): () => Promise<BridgeShellBundle> {
  return async function bundleShell() {
    const esbuild = resolveAppEsbuild(appRoot);
    const result = await esbuild.build({
      absWorkingDir: appRoot,
      entryPoints: SHELL_ENTRIES,
      outdir: "web-proxy-bridge",
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      logLevel: "silent",
    });
    const output = (name: keyof typeof SHELL_ENTRIES) => {
      const file = result.outputFiles.find((entry) => path.basename(entry.path) === `${name}.js`);
      if (!file) throw new Error(`esbuild produced no ${name}.js`);
      return file.text;
    };
    return { bootstrapJs: output("bootstrap"), workerJs: output("worker") };
  };
}

function createToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The command as the app's browser project registers it. */
export function webProxyBridgeCommandFor(appRoot: string) {
  return createWebProxyBridgeCommand({
    hostModulePath: path.resolve(appRoot, HOST_MODULE),
    bundleShell: createShellBundler(appRoot),
    createToken,
  });
}
