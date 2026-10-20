import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import {
  createProcessTable,
  ProcessTreeTracker,
  type ProcessIdentity,
  type ProcessTable,
} from "../remote-browser/process-tree.js";

/**
 * The in-repo Cloudflare relay (the legacy relay implementation, `docs/architecture.md`) run
 * locally with `wrangler dev --local`, as an isolated stand-in for transport experiments. It never
 * forwards to the hosted relay: the upstream variable is always cleared, and readiness requires
 * the local Durable Object to log a synthetic session no other server could know. Nothing here
 * touches a real pairing or the daemon on port 6767. Starting it is heavy (workerd): run it under
 * the shared guard, one at a time.
 *
 * The helper owns its processes: it spawns the declared wrangler's entrypoint with this Node in a
 * process group of its own, tracks every descendant by pid and start time, signals only those
 * identities, and reports stopped only when none runs and the port refuses connections.
 */

export type LocalRelayProblem =
  | "unsupported_platform"
  | "wrangler_not_declared"
  | "wrangler_not_installed"
  | "spawn_failed"
  | "exited"
  | "startup_timeout"
  | "stop_failed"
  | "stopped";

export class LocalRelayError extends Error {
  constructor(
    readonly problem: LocalRelayProblem,
    message: string,
    /** Sanitized tail of the relay's output, empty when none was captured. */
    readonly diagnostics = "",
  ) {
    super(diagnostics ? `${message}\n${diagnostics}` : message);
    this.name = "LocalRelayError";
  }
}

export interface RelayWorkDirs {
  state: string;
  logs: string;
  registry: string;
  cache: string;
}

export interface RelayLaunchContext {
  port: number;
  inspectorPort: number;
  dirs: RelayWorkDirs;
}

/** A Node entrypoint to run with `process.execPath`, and the exact environment it receives. */
export interface RelayLaunch {
  entry: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface OwnedRelayOptions {
  launch(context: RelayLaunchContext): RelayLaunch;
  /** One deadline for TCP, WebSocket and the local log proof together. */
  startupTimeoutMs: number;
  /** How long each of SIGTERM and SIGKILL may take before stop gives up. */
  stopGraceMs: number;
  table?: ProcessTable;
}

export interface OwnedRelay {
  port: number;
  endpoint: string;
  /** Temporary state, logs, registry and cache of this relay; removed by `stop`. */
  workDir: string;
  /** The running root process; a restart replaces it. */
  readonly instance: ProcessIdentity;
  /** Sanitized tail of the current instance's output. */
  diagnostics(): string;
  /** Stops the processes, waits for the port to close, and removes the work directory. */
  stop(): Promise<void>;
  /** Stops this instance with the same guarantees and starts a new one on the same port. */
  restart(): Promise<void>;
  readonly exited: boolean;
}

const OUTPUT_LIMIT_CHARS = 64 * 1024;
const DIAGNOSTIC_TAIL_CHARS = 4 * 1024;
const PROBE_ATTEMPT_MS = 5_000;
const POLL_MS = 50;

class OutputBuffer {
  private value = "";

  append(text: string): void {
    this.value += text;
    if (this.value.length > OUTPUT_LIMIT_CHARS) this.value = this.value.slice(-OUTPUT_LIMIT_CHARS);
  }

  hasLine(predicate: (line: string) => boolean): boolean {
    return this.value.split("\n").some(predicate);
  }

  text(): string {
    return this.value;
  }
}

/** Redacts what could identify a session or a local path; keeps only a bounded tail. */
export function sanitizeRelayOutput(text: string, known: readonly string[]): string {
  let result = text;
  for (const value of known) {
    if (value) result = result.split(value).join("<redacted>");
  }
  result = result
    .replace(/(session\s+)\S+/g, "$1<id>")
    .replace(/(serverId|connectionId)=[^&\s"']+/g, "$1=<id>")
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, "<redacted>");
  return result.slice(-DIAGNOSTIC_TAIL_CHARS);
}

interface Instance {
  child: ChildProcess;
  identity: ProcessIdentity;
  tracker: ProcessTreeTracker;
  output: OutputBuffer;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  failure: Error | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a relay port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function spawnInstance(launch: RelayLaunch, table: ProcessTable): Promise<Instance> {
  const child = spawn(process.execPath, [launch.entry, ...launch.args], {
    cwd: launch.cwd,
    env: launch.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = new OutputBuffer();
  const state: Pick<Instance, "exit" | "failure"> = { exit: null, failure: null };
  child.on("error", (error) => {
    state.failure ??= error;
  });
  child.once("exit", (code, signal) => {
    state.exit = { code, signal };
  });
  child.stdout?.setEncoding("utf8").on("data", (text: string) => output.append(text));
  child.stderr?.setEncoding("utf8").on("data", (text: string) => output.append(text));
  await new Promise<void>((resolve) => {
    child.once("spawn", () => resolve());
    child.once("error", () => resolve());
  });
  const pid = child.pid;
  const entry = pid === undefined ? null : await table.read(pid);
  if (pid === undefined || entry === null) {
    const reason = state.failure?.message ?? "the process exited before it could be identified";
    throw new LocalRelayError("spawn_failed", `Could not start the local relay: ${reason}`);
  }
  const identity = { pid, startTime: entry.startTime };
  return {
    child,
    identity,
    tracker: new ProcessTreeTracker(identity, table),
    output,
    get exit() {
      return state.exit;
    },
    get failure() {
      return state.failure;
    },
  };
}

function assertRunning(instance: Instance, known: readonly string[]): void {
  const diagnostics = () => sanitizeRelayOutput(instance.output.text(), known);
  if (instance.failure) {
    throw new LocalRelayError("spawn_failed", "The local relay process failed", diagnostics());
  }
  if (instance.exit) {
    const { code, signal } = instance.exit;
    const how = signal === null ? `code ${code}` : `signal ${signal}`;
    throw new LocalRelayError("exited", `The local relay exited with ${how}`, diagnostics());
  }
}

/** Opens a relay server socket for `serverId`; resolves whether it opened before `deadline`. */
async function probeWebSocket(port: number, serverId: string, deadline: number): Promise<boolean> {
  const url = buildRelayWebSocketUrl({
    endpoint: `127.0.0.1:${port}`,
    useTls: false,
    serverId,
    role: "server",
  });
  const socket = new WebSocket(url);
  // Errors after the outcome (a close racing the server) must not surface as unhandled events.
  socket.on("error", () => {});
  const waitMs = Math.max(1, Math.min(PROBE_ATTEMPT_MS, deadline - Date.now()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const opened = await new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), waitMs);
    socket.once("open", () => resolve(true));
    socket.once("error", () => resolve(false));
  });
  clearTimeout(timer);
  if (opened) socket.close(1000, "probe");
  else socket.terminate();
  return opened;
}

/**
 * Ready means: this port listens, a server socket for a fresh synthetic session opens, and the
 * local Durable Object logged that exact session. A server elsewhere (the hosted relay behind a
 * forwarding worker, or a stranger on the port) cannot produce that line in this process.
 */
async function waitUntilReady(input: {
  instance: Instance;
  port: number;
  deadline: number;
  known: string[];
}): Promise<void> {
  const { instance, port, deadline, known } = input;
  const probeId = `local-relay-probe-${randomUUID()}`;
  known.push(probeId);
  const isProof = (line: string) =>
    line.includes("[Relay DO]") && line.includes(`connected to session ${probeId}`);
  let opened = false;
  while (Date.now() < deadline) {
    assertRunning(instance, known);
    await instance.tracker.sample();
    if (opened && instance.output.hasLine(isProof)) return;
    if (!opened && (await isPortOpen(port))) {
      opened = await probeWebSocket(port, probeId, deadline);
    }
    await delay(POLL_MS);
  }
  assertRunning(instance, known);
  throw new LocalRelayError(
    "startup_timeout",
    opened
      ? "The relay socket opened but the local worker never logged the probe session"
      : `The local relay was not ready on port ${port} in time`,
    sanitizeRelayOutput(instance.output.text(), known),
  );
}

async function stopInstance(input: {
  instance: Instance;
  port: number;
  graceMs: number;
}): Promise<void> {
  const { instance, port, graceMs } = input;
  await instance.tracker.sample();
  await instance.tracker.signal("SIGTERM");
  let running = await instance.tracker.waitUntilGone(graceMs);
  if (running.length > 0) {
    await instance.tracker.signal("SIGKILL");
    running = await instance.tracker.waitUntilGone(graceMs);
  }
  if (running.length > 0) {
    throw new LocalRelayError("stop_failed", `${running.length} owned relay processes still run`);
  }
  const deadline = Date.now() + graceMs;
  while (await isPortOpen(port)) {
    if (Date.now() >= deadline) {
      throw new LocalRelayError("stop_failed", `Port ${port} still accepts connections`);
    }
    await delay(POLL_MS);
  }
}

export async function startOwnedRelay(options: OwnedRelayOptions): Promise<OwnedRelay> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new LocalRelayError("unsupported_platform", "The local relay needs Linux or macOS");
  }
  const table = options.table ?? createProcessTable(process.platform);
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-local-relay-"));
  const dirs: RelayWorkDirs = {
    state: path.join(root, "state"),
    logs: path.join(root, "logs"),
    registry: path.join(root, "registry"),
    cache: path.join(root, "cache"),
  };
  const known = [root];
  let current: Instance | null = null;
  let stopping: Promise<void> | null = null;

  async function removeWorkDir(): Promise<void> {
    await rm(root, { recursive: true, force: true });
  }

  async function startInstance(context: RelayLaunchContext): Promise<void> {
    const instance = await spawnInstance(options.launch(context), table);
    current = instance;
    try {
      await waitUntilReady({
        instance,
        port: context.port,
        deadline: Date.now() + options.startupTimeoutMs,
        known,
      });
    } catch (error) {
      current = null;
      try {
        await stopInstance({ instance, port: context.port, graceMs: options.stopGraceMs });
      } catch (stopError) {
        const cause = error instanceof Error ? error.message : String(error);
        const reason = stopError instanceof Error ? stopError.message : String(stopError);
        throw new LocalRelayError("stop_failed", `${reason}, after the start failed: ${cause}`);
      }
      throw error;
    }
  }

  let port: number;
  let context: RelayLaunchContext;
  try {
    await Promise.all(Object.values(dirs).map((dir) => mkdir(dir)));
    port = await availablePort();
    context = { port, inspectorPort: await availablePort(), dirs };
    await startInstance(context);
  } catch (error) {
    await removeWorkDir();
    throw error;
  }

  function running(): Instance {
    if (stopping || !current) throw new LocalRelayError("stopped", "The local relay is stopped");
    return current;
  }

  return {
    port,
    endpoint: `127.0.0.1:${port}`,
    workDir: root,
    get instance() {
      return running().identity;
    },
    diagnostics() {
      return current ? sanitizeRelayOutput(current.output.text(), known) : "";
    },
    stop() {
      stopping ??= (async () => {
        const instance = current;
        current = null;
        try {
          if (instance) await stopInstance({ instance, port, graceMs: options.stopGraceMs });
        } finally {
          await removeWorkDir();
        }
      })();
      return stopping;
    },
    async restart() {
      const instance = running();
      current = null;
      await stopInstance({ instance, port, graceMs: options.stopGraceMs });
      await startInstance(context);
    },
    get exited() {
      return current === null || current.exit !== null || current.failure !== null;
    },
  };
}

export interface WranglerInstallation {
  version: string;
  /** Directory of the resolved wrangler package. */
  packageDir: string;
  /** Its `bin.wrangler` entrypoint, run with this Node. */
  entry: string;
  /** The manifest that declares wrangler and that resolution starts from. */
  declaredBy: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function declaresDependency(manifest: unknown, name: string): boolean {
  if (!isRecord(manifest)) return false;
  return ["dependencies", "devDependencies"].some((field) => {
    const block = manifest[field];
    return isRecord(block) && typeof block[name] === "string";
  });
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Neither relay nor server declares wrangler; the app does, and its copy is the one resolved. */
export const WRANGLER_DECLARING_PACKAGE = path.resolve(HERE, "../../../../app");
const RELAY_PACKAGE_ROOT = path.resolve(HERE, "../../../../relay");

/** Resolves wrangler from a package that declares it; never npx, PATH, or a download. */
export function resolveWrangler(
  declaringPackageDir = WRANGLER_DECLARING_PACKAGE,
): WranglerInstallation {
  const declaredBy = path.join(declaringPackageDir, "package.json");
  const manifest: unknown = JSON.parse(readFileSync(declaredBy, "utf8"));
  if (!declaresDependency(manifest, "wrangler")) {
    throw new LocalRelayError("wrangler_not_declared", `${declaredBy} does not declare wrangler`);
  }
  let manifestPath: string;
  try {
    manifestPath = createRequire(declaredBy).resolve("wrangler/package.json");
  } catch {
    throw new LocalRelayError("wrangler_not_installed", "wrangler is declared but not installed");
  }
  const wrangler: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  const version = isRecord(wrangler) ? wrangler.version : undefined;
  const bin = isRecord(wrangler) && isRecord(wrangler.bin) ? wrangler.bin.wrangler : undefined;
  if (typeof version !== "string" || typeof bin !== "string") {
    throw new LocalRelayError("wrangler_not_installed", "The wrangler package has no entrypoint");
  }
  const packageDir = path.dirname(manifestPath);
  return { version, packageDir, entry: path.resolve(packageDir, bin), declaredBy };
}

/**
 * The only variables the relay process receives. Credentials (Cloudflare, providers), NODE_OPTIONS
 * and everything else from the caller stay out; HOME is passed unchanged, and wrangler's logs,
 * dev registry and cache go to the work directory instead of the user's global config.
 */
export function relayEnvironment(
  dirs: RelayWorkDirs,
  source = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_SEND_ERROR_REPORTS: "false",
    WRANGLER_LOG_PATH: dirs.logs,
    WRANGLER_REGISTRY_PATH: dirs.registry,
    WRANGLER_CACHE_DIR: dirs.cache,
  };
  for (const name of ["PATH", "HOME", "LANG", "TMPDIR"]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export function wranglerLaunch(input: {
  installation: WranglerInstallation;
  context: RelayLaunchContext;
  relayPackageDir?: string;
}): RelayLaunch {
  const { installation, context } = input;
  return {
    entry: installation.entry,
    args: [
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(context.port),
      "--inspector-ip",
      "127.0.0.1",
      "--inspector-port",
      String(context.inspectorPort),
      "--persist-to",
      context.dirs.state,
      "--live-reload=false",
      "--show-interactive-dev-session=false",
      // wrangler.toml points PASEO_RELAY_UPSTREAM at the hosted relay; an empty value keeps the
      // worker serving sessions itself. Not optional.
      "--var",
      "PASEO_RELAY_UPSTREAM:",
    ],
    cwd: input.relayPackageDir ?? RELAY_PACKAGE_ROOT,
    env: relayEnvironment(context.dirs),
  };
}

export interface LocalWranglerRelay extends OwnedRelay {
  wrangler: Pick<WranglerInstallation, "version" | "packageDir">;
}

export interface LocalWranglerRelayOptions {
  /** One deadline for the whole startup; workerd usually needs 30–90 s. */
  startupTimeoutMs?: number;
  stopGraceMs?: number;
}

export async function startLocalWranglerRelay(
  options: LocalWranglerRelayOptions = {},
): Promise<LocalWranglerRelay> {
  const installation = resolveWrangler();
  const relay = await startOwnedRelay({
    launch: (context) => wranglerLaunch({ installation, context }),
    startupTimeoutMs: options.startupTimeoutMs ?? 90_000,
    stopGraceMs: options.stopGraceMs ?? 10_000,
  });
  return Object.assign(relay, {
    wrangler: { version: installation.version, packageDir: installation.packageDir },
  });
}
