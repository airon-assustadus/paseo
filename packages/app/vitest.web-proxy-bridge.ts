import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "esbuild";

/**
 * Vitest browser commands that start the web proxy bridge host on first use (adapter contract §7),
 * directly or behind the local relay stack (relay-r2-command-plan.md). They run in the Vitest Node
 * process. The host, the stack and esbuild load inside the first call, so a run whose tests never
 * ask for them opens nothing. They take no input from the browser beyond a validated nonce: the
 * page origin, the shell entries and the modules are all decided here, and only a closed public
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

/**
 * What the relay page receives. Every field is connection authority (the pairing offer plus the
 * host token): it stays in the test page and never reaches content, the worker, logs or evidence.
 */
export interface WebProxyRelayInfo {
  /** "127.0.0.1:<port>" of the client-leg tap, without a scheme; TLS is off. */
  relay: { endpoint: string };
  daemon: { serverId: string; daemonPublicKeyB64: string };
  bridge: {
    tcpPort: number;
    token: string;
    allowedOrigin: string;
    fixture: BridgeFixtureInfo;
    shell: BridgeShellInfo;
  };
  /** The server's length-prefixed codec, served by this browser server: "/@fs" + its real path. */
  codecModuleUrl: string;
}

export type RelayTapDirection = "toTarget" | "fromTarget";

/** One relay leg as the stack's taps saw it: counts, booleans and handshake names only. */
export interface WebProxyRelayLegEvidence {
  connections: number;
  messages: number;
  nonHandshakeMessages: number;
  handshake: Array<"e2ee_hello" | "e2ee_ready">;
  bytes: Record<RelayTapDirection, number>;
  overflow: { direction: RelayTapDirection; limit: number } | null;
  contains: Record<"nonce" | "token" | "hello", Record<RelayTapDirection, boolean>>;
}

/**
 * Host totals across both listeners; the host does not count per transport. The page compares them
 * with the channel openings and sessions it made itself through the tunnel (RV-7).
 */
export interface WebProxyRelayHostTotals {
  connections: number;
  authenticatedConnections: number;
  sessionsOpened: number;
}

export interface WebProxyRelayEvidence {
  clientLeg: WebProxyRelayLegEvidence;
  daemonLeg: WebProxyRelayLegEvidence;
  host: WebProxyRelayHostTotals;
}

declare module "vitest/browser" {
  interface BrowserCommands {
    webProxyBridge(): Promise<WebProxyBridgeInfo>;
    webProxyRelayBridge(): Promise<WebProxyRelayInfo>;
    webProxyRelayRestart(): Promise<void>;
    webProxyRelayEvidence(nonce: string): Promise<WebProxyRelayEvidence>;
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
  | "closed_during_start"
  | "codec_module_invalid"
  | "stack_module_invalid"
  | "relay_start_failed"
  | "relay_result_invalid"
  | "relay_not_started"
  | "relay_not_ready"
  | "relay_busy"
  | "relay_failed"
  | "relay_closed"
  | "relay_restart_failed"
  | "relay_evidence_failed"
  | "invalid_nonce";

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
const STACK_MODULE = "../server/src/server/network-fetch/__fixtures__/relay-bridge-stack.ts";
const CODEC_MODULE = "../server/src/server/network-fetch/__fixtures__/length-prefixed.ts";
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

export interface RelayStackOptions {
  shell: BridgeShellBundle;
  allowedOrigin: string;
}

export interface WebProxyRelayOptions {
  stackModulePath: string;
  codecModulePath: string;
  /** The codec must resolve inside this directory, which the browser server already serves. */
  servedRoot: string;
  bundleShell(controlOrigin: string): Promise<BridgeShellBundle>;
}

const RELAY_ENDPOINT = /^127\.0\.0\.1:([1-9]\d{0,4})$/;
const SERVER_ID = /^srv_[A-Za-z0-9_-]{12}$/;
/** 32-byte box public key, standard base64. */
const DAEMON_PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/;
const NONCE = /^[A-Za-z0-9_-]{8,64}$/;
const STACK_STEPS = ["relay", "taps", "daemon", "registration", "offer", "host"] as const;
const DIRECTIONS = ["toTarget", "fromTarget"] as const;
const MARKERS = ["nonce", "token", "hello"] as const;

/** The codec URL is computed here, never chosen by the page, and only for a file already served. */
function resolveCodecModuleUrl(modulePath: string, servedRoot: string): string {
  let real: string;
  let root: string;
  try {
    real = realpathSync(modulePath);
    root = realpathSync(servedRoot);
  } catch {
    throw new WebProxyBridgeError("codec_module_invalid", "The codec module does not exist");
  }
  const relative = path.relative(root, real);
  const isInside =
    relative !== "" && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
  if (!isInside || path.extname(real) !== ".ts") {
    throw new WebProxyBridgeError(
      "codec_module_invalid",
      "The codec module is not inside the served root",
    );
  }
  return `/@fs${real}`;
}

type StartRelayStack = (options: RelayStackOptions) => Promise<unknown>;

function stackStarter(module: unknown): StartRelayStack {
  const start: unknown = isRecord(module) ? module.startRelayBridgeStack : undefined;
  if (typeof start !== "function") {
    throw new WebProxyBridgeError(
      "stack_module_invalid",
      "The relay stack module does not export startRelayBridgeStack",
    );
  }
  return async (options) => start(options);
}

/** The page learns which step failed, never the cause: it can carry log lines, ports or paths. */
function stackStartFailure(error: unknown): WebProxyBridgeError {
  const step = isRecord(error) ? error.step : undefined;
  const known = STACK_STEPS.find((candidate) => candidate === step);
  const message = known
    ? `The relay stack failed at step "${known}"`
    : "The relay stack failed to start";
  return new WebProxyBridgeError("relay_start_failed", message);
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isHandshake(value: unknown): value is "e2ee_hello" | "e2ee_ready" {
  return value === "e2ee_hello" || value === "e2ee_ready";
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

type RelayStackInfo = Omit<WebProxyRelayInfo, "codecModuleUrl">;

function parseRelayEndpoint(value: unknown): string | null {
  const match = typeof value === "string" ? RELAY_ENDPOINT.exec(value) : null;
  return match !== null && isPort(Number(match[1])) ? match[0] : null;
}

function parseRelayInfo(value: unknown, allowedOrigin: string): RelayStackInfo | null {
  if (!isRecord(value) || !isRecord(value.relay)) return null;
  if (!isRecord(value.daemon) || !isRecord(value.bridge)) return null;
  const endpoint = parseRelayEndpoint(value.relay.endpoint);
  const { serverId, daemonPublicKeyB64 } = value.daemon;
  const { tcpPort, token } = value.bridge;
  const fixture = parseFixture(value.bridge.fixture);
  const shell = parseShell(value.bridge.shell);
  if (endpoint === null || !matches(serverId, SERVER_ID)) return null;
  if (!matches(daemonPublicKeyB64, DAEMON_PUBLIC_KEY)) return null;
  if (!isPort(tcpPort) || !matches(token, TOKEN) || value.bridge.allowedOrigin !== allowedOrigin) {
    return null;
  }
  if (fixture === null || shell === null) return null;
  return {
    relay: { endpoint },
    daemon: { serverId, daemonPublicKeyB64 },
    bridge: { tcpPort, token, allowedOrigin, fixture, shell },
  };
}

function parseDirections<T>(
  value: unknown,
  isValue: (entry: unknown) => entry is T,
): Record<RelayTapDirection, T> | null {
  if (!isRecord(value)) return null;
  const { toTarget, fromTarget } = value;
  return isValue(toTarget) && isValue(fromTarget) ? { toTarget, fromTarget } : null;
}

function parseOverflow(value: unknown): WebProxyRelayLegEvidence["overflow"] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const direction = DIRECTIONS.find((candidate) => candidate === value.direction);
  return direction && isCount(value.limit) ? { direction, limit: value.limit } : undefined;
}

function parseContains(value: unknown): WebProxyRelayLegEvidence["contains"] | null {
  if (!isRecord(value)) return null;
  const [nonce, token, hello] = MARKERS.map((marker) => parseDirections(value[marker], isBoolean));
  return nonce && token && hello ? { nonce, token, hello } : null;
}

function parseLeg(value: unknown): WebProxyRelayLegEvidence | null {
  if (!isRecord(value)) return null;
  const { connections, messages, nonHandshakeMessages, handshake } = value;
  if (!isCount(connections) || !isCount(messages) || !isCount(nonHandshakeMessages)) return null;
  if (!Array.isArray(handshake) || !handshake.every(isHandshake)) return null;
  const bytes = parseDirections(value.bytes, isCount);
  const overflow = parseOverflow(value.overflow);
  const contains = parseContains(value.contains);
  if (bytes === null || overflow === undefined || contains === null) return null;
  return {
    connections,
    messages,
    nonHandshakeMessages,
    handshake: [...handshake],
    bytes,
    overflow,
    contains,
  };
}

function parseHostTotals(value: unknown): WebProxyRelayHostTotals | null {
  if (!isRecord(value)) return null;
  const { connections, authenticatedConnections, sessionsOpened } = value;
  if (!isCount(connections) || !isCount(authenticatedConnections) || !isCount(sessionsOpened)) {
    return null;
  }
  return { connections, authenticatedConnections, sessionsOpened };
}

function parseEvidence(value: unknown): WebProxyRelayEvidence | null {
  if (!isRecord(value)) return null;
  const clientLeg = parseLeg(value.clientLeg);
  const daemonLeg = parseLeg(value.daemonLeg);
  const host = parseHostTotals(value.host);
  return clientLeg && daemonLeg && host ? { clientLeg, daemonLeg, host } : null;
}

/** The three operations the commands use; host, daemon, relay and taps stay out of reach. */
interface RelayStack {
  restart(): Promise<void>;
  evidence(nonce: string): Promise<unknown>;
  close(): Promise<void>;
}

interface ParsedStack {
  /** Present whenever the result can be shut down, even if the rest of it is malformed. */
  close: (() => Promise<void>) | null;
  stack: RelayStack | null;
  info: RelayStackInfo | null;
}

function parseStack(value: unknown, allowedOrigin: string): ParsedStack {
  if (!isRecord(value)) return { close: null, stack: null, info: null };
  const { close, restartRelay, evidence } = value;
  if (typeof close !== "function") return { close: null, stack: null, info: null };
  const shutdown = async () => {
    await close.call(value);
  };
  const info = parseRelayInfo(value.info, allowedOrigin);
  if (typeof restartRelay !== "function" || typeof evidence !== "function" || info === null) {
    return { close: shutdown, stack: null, info: null };
  }
  const stack: RelayStack = {
    restart: async () => {
      await restartRelay.call(value);
    },
    evidence: async (nonce) => evidence.call(value, { nonce }),
    close: shutdown,
  };
  return { close: shutdown, stack, info };
}

type RelayPhase =
  | { state: "starting" }
  | { state: "ready"; stack: RelayStack }
  | { state: "restarting"; stack: RelayStack }
  /** A failed restart keeps its stack, so the run's close still shuts it down. */
  | { state: "failed"; stack: RelayStack | null }
  | { state: "closed" };

interface RelayRun {
  phase: RelayPhase;
}

/** Read through a function so a check after an await is not narrowed by the assignment before it. */
function isRunClosed(run: RelayRun): boolean {
  return run.phase.state === "closed";
}

function readyStack(run: RelayRun): RelayStack {
  switch (run.phase.state) {
    case "starting":
      throw new WebProxyBridgeError("relay_not_ready", "The relay stack is still starting");
    case "restarting":
      throw new WebProxyBridgeError("relay_busy", "The relay is restarting");
    case "failed":
      throw new WebProxyBridgeError("relay_failed", "The relay stack failed");
    case "closed":
      throw new WebProxyBridgeError("relay_closed", "The relay stack is closed");
    case "ready":
      return run.phase.stack;
  }
}

function unexpectedArguments(command: string): WebProxyBridgeError {
  return new WebProxyBridgeError("unexpected_arguments", `${command} takes no arguments`);
}

export function createWebProxyRelayCommands(options: WebProxyRelayOptions) {
  const runs = new WeakMap<object, { run: RelayRun; info: Promise<WebProxyRelayInfo> }>();

  async function start(context: BridgeCommandContext, run: RelayRun): Promise<WebProxyRelayInfo> {
    // Registered before anything opens, so a run that ends mid-start still releases the stack.
    context.project.vitest.onClose(async () => {
      const previous = run.phase;
      run.phase = { state: "closed" };
      if ("stack" in previous) await previous.stack?.close();
    });
    try {
      const allowedOrigin = browserOrigin(context);
      const codecModuleUrl = resolveCodecModuleUrl(options.codecModulePath, options.servedRoot);
      const shell = await options.bundleShell(allowedOrigin);
      const startStack = stackStarter(await context.project.import(options.stackModulePath));
      if (isRunClosed(run)) {
        throw new WebProxyBridgeError(
          "closed_during_start",
          "Vitest closed before the stack started",
        );
      }
      let started: unknown;
      try {
        started = await startStack({ shell, allowedOrigin });
      } catch (error) {
        throw stackStartFailure(error);
      }
      const parsed = parseStack(started, allowedOrigin);
      if (parsed.stack === null || parsed.info === null) {
        await parsed.close?.();
        throw new WebProxyBridgeError(
          "relay_result_invalid",
          "The relay stack did not return its decided public description and operations",
        );
      }
      if (isRunClosed(run)) {
        await parsed.stack.close();
        throw new WebProxyBridgeError(
          "closed_during_start",
          "Vitest closed while the stack started",
        );
      }
      run.phase = { state: "ready", stack: parsed.stack };
      return { ...parsed.info, codecModuleUrl };
    } catch (error) {
      if (!isRunClosed(run)) run.phase = { state: "failed", stack: null };
      throw error;
    }
  }

  function webProxyRelayBridge(
    context: BridgeCommandContext,
    ...payload: unknown[]
  ): Promise<WebProxyRelayInfo> {
    if (payload.length > 0) return Promise.reject(unexpectedArguments("webProxyRelayBridge"));
    const vitest = context.project.vitest;
    let entry = runs.get(vitest);
    if (!entry) {
      const run: RelayRun = { phase: { state: "starting" } };
      // A failed start stays the answer for this run: tests see the same error, never a retry.
      entry = { run, info: start(context, run) };
      runs.set(vitest, entry);
    }
    // After a failed restart the stack exists but is unusable; a failed start keeps its own error.
    const { phase } = entry.run;
    if (phase.state === "failed" && phase.stack !== null) {
      return Promise.reject(new WebProxyBridgeError("relay_failed", "The relay stack failed"));
    }
    return entry.info;
  }

  async function webProxyRelayRestart(
    context: BridgeCommandContext,
    ...payload: unknown[]
  ): Promise<void> {
    if (payload.length > 0) throw unexpectedArguments("webProxyRelayRestart");
    const entry = runs.get(context.project.vitest);
    if (!entry) throw new WebProxyBridgeError("relay_not_started", "No relay stack was started");
    const { run } = entry;
    const stack = readyStack(run);
    run.phase = { state: "restarting", stack };
    try {
      await stack.restart();
    } catch {
      if (isRunClosed(run))
        throw new WebProxyBridgeError("relay_closed", "The relay stack is closed");
      run.phase = { state: "failed", stack };
      throw new WebProxyBridgeError("relay_restart_failed", "The relay did not come back");
    }
    if (isRunClosed(run))
      throw new WebProxyBridgeError("relay_closed", "The relay stack is closed");
    run.phase = { state: "ready", stack };
  }

  async function webProxyRelayEvidence(
    context: BridgeCommandContext,
    ...payload: unknown[]
  ): Promise<WebProxyRelayEvidence> {
    if (payload.length !== 1) {
      throw new WebProxyBridgeError("unexpected_arguments", "webProxyRelayEvidence takes a nonce");
    }
    const [nonce] = payload;
    if (!matches(nonce, NONCE)) {
      throw new WebProxyBridgeError("invalid_nonce", "The nonce must match [A-Za-z0-9_-]{8,64}");
    }
    const entry = runs.get(context.project.vitest);
    if (!entry) throw new WebProxyBridgeError("relay_not_started", "No relay stack was started");
    const stack = readyStack(entry.run);
    let collected: unknown;
    try {
      collected = await stack.evidence(nonce);
    } catch {
      throw new WebProxyBridgeError(
        "relay_evidence_failed",
        "The relay stack refused the evidence",
      );
    }
    const evidence = parseEvidence(collected);
    if (evidence === null) {
      throw new WebProxyBridgeError("relay_result_invalid", "The relay evidence is not as decided");
    }
    return evidence;
  }

  return { webProxyRelayBridge, webProxyRelayRestart, webProxyRelayEvidence };
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

/** The relay commands as the app's browser project registers them; the worktree root is served. */
export function webProxyRelayCommandsFor(appRoot: string) {
  return createWebProxyRelayCommands({
    stackModulePath: path.resolve(appRoot, STACK_MODULE),
    codecModulePath: path.resolve(appRoot, CODEC_MODULE),
    servedRoot: path.resolve(appRoot, "../.."),
    bundleShell: createShellBundler(appRoot),
  });
}
