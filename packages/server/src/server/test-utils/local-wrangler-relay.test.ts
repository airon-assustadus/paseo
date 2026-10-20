import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessTable, type ProcessIdentity } from "../remote-browser/process-tree.js";
import {
  LocalRelayError,
  WRANGLER_DECLARING_PACKAGE,
  relayEnvironment,
  resolveWrangler,
  sanitizeRelayOutput,
  startOwnedRelay,
  wranglerLaunch,
  type OwnedRelay,
  type RelayLaunchContext,
} from "./local-wrangler-relay.js";

/**
 * A stand-in for `wrangler dev`: listens on the given port, answers WebSocket upgrades by hand,
 * and prints the local Durable Object's connect line, unless a mode makes it misbehave. It also
 * starts a grandchild so cleanup has to reach past the root.
 */
const SYNTHETIC_RELAY = String.raw`
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const [, , portArg, mode, pidFile] = process.argv;
// Failure modes wait a moment, so the helper has identified the root before it goes away.
if (mode === "exit-early") {
  setTimeout(() => process.exit(3), 200);
  return;
}
if (mode === "self-kill") {
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 200);
  return;
}
if (mode === "noisy") {
  console.log("token=" + "A".repeat(48));
  console.error("serverId=abc123def session leaked-session-id at " + process.cwd());
  setTimeout(() => process.exit(7), 200);
  return;
}
const ignoresTerm = mode === "ignore-term";
if (ignoresTerm) process.on("SIGTERM", () => {});
const grandchild = spawn(
  process.execPath,
  ["-e", (ignoresTerm ? "process.on('SIGTERM', () => {});" : "") + "setInterval(() => {}, 1000);"],
  { stdio: "ignore" },
);
// Exact identities (pid + start time), so the test's safety net never signals a reused pid.
const identity = (pid) => {
  const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
  return { pid, startTime: stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19] };
};
fs.writeFileSync(pidFile, JSON.stringify([identity(process.pid), identity(grandchild.pid)]));
if (mode === "silent") {
  setInterval(() => {}, 1000);
  return;
}
const server = http.createServer((request, response) => response.writeHead(404).end());
server.on("upgrade", (request, socket) => {
  const serverId = new URL(request.url, "http://relay.invalid").searchParams.get("serverId");
  const accept = crypto
    .createHash("sha1")
    .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept + "\r\n\r\n",
  );
  if (mode !== "forged") {
    console.log("[Relay DO] v2:server(control) connected to session " + serverId);
  }
  socket.on("error", () => {});
  socket.on("data", (frame) => {
    // Answer a close frame so the probe's socket ends promptly.
    if ((frame[0] & 0x0f) === 0x08) socket.end(Buffer.from([0x88, 0x00]));
  });
});
server.listen(Number(portArg), "127.0.0.1");
`;

type SyntheticMode =
  | "ok"
  | "forged"
  | "silent"
  | "exit-early"
  | "self-kill"
  | "noisy"
  | "ignore-term";

const table = createProcessTable(process.platform);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-relay-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

interface Synthetic {
  launches: RelayLaunchContext[];
  /** Identities the instance of one launch recorded (root first); the latest by default. */
  owned(launch?: number): Promise<ProcessIdentity[]>;
  start(options?: { startupTimeoutMs?: number; stopGraceMs?: number }): Promise<OwnedRelay>;
}

async function synthetic(modes: SyntheticMode[]): Promise<Synthetic> {
  const dir = await scratchDir();
  const script = path.join(dir, "relay.cjs");
  await writeFile(script, SYNTHETIC_RELAY);
  const launches: RelayLaunchContext[] = [];
  const pidFileFor = (launch: number) => path.join(dir, `pids-${launch}.json`);
  async function owned(launch = launches.length - 1): Promise<ProcessIdentity[]> {
    return JSON.parse(await readFile(pidFileFor(launch), "utf8"));
  }
  // Safety net if the helper under test fails: only identities a synthetic instance recorded.
  cleanups.push(async () => {
    for (let launch = 0; launch < launches.length; launch += 1) {
      if (!existsSync(pidFileFor(launch))) continue;
      for (const identity of await owned(launch)) {
        if (await running(identity)) process.kill(identity.pid, "SIGKILL");
      }
    }
  });
  return {
    launches,
    owned,
    async start(options = {}) {
      const relay = await startOwnedRelay({
        launch: (context) => {
          launches.push(context);
          const mode = modes[Math.min(launches.length - 1, modes.length - 1)];
          const pidFile = pidFileFor(launches.length - 1);
          return { entry: script, args: [String(context.port), mode, pidFile], cwd: dir, env: {} };
        },
        startupTimeoutMs: options.startupTimeoutMs ?? 10_000,
        stopGraceMs: options.stopGraceMs ?? 5_000,
      });
      cleanups.push(() => relay.stop());
      return relay;
    },
  };
}

async function identityOf(pid: number | undefined): Promise<ProcessIdentity> {
  const entry = pid === undefined ? null : await table.read(pid);
  if (!entry) throw new Error("The process is not running");
  return { pid: entry.pid, startTime: entry.startTime };
}

async function running(identity: ProcessIdentity): Promise<boolean> {
  const entry = await table.read(identity.pid);
  return entry !== null && entry.startTime === identity.startTime && entry.zombie !== true;
}

function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function workRootOf(context: RelayLaunchContext): string {
  return path.dirname(context.dirs.state);
}

async function expectProblem(promise: Promise<unknown>, problem: string): Promise<LocalRelayError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(LocalRelayError);
  expect(error).toMatchObject({ problem });
  if (!(error instanceof LocalRelayError)) throw new Error("unreachable");
  return error;
}

describe.skipIf(process.platform !== "linux")("owned relay process lifecycle", () => {
  it("is ready only after the local worker logged the synthetic probe session", async () => {
    const relay = await (await synthetic(["ok"])).start();

    expect(relay.endpoint).toBe(`127.0.0.1:${relay.port}`);
    expect(await portAccepts(relay.port)).toBe(true);
    expect(relay.diagnostics()).toContain(
      "[Relay DO] v2:server(control) connected to session <id>",
    );
    expect(relay.exited).toBe(false);
  });

  it("does not accept a WebSocket that opens without the local worker's log line", async () => {
    const relay = await synthetic(["forged"]);

    const error = await expectProblem(relay.start({ startupTimeoutMs: 2_000 }), "startup_timeout");

    expect(error.message).toContain("never logged the probe session");
    const [context] = relay.launches;
    for (const identity of await relay.owned()) {
      expect(await running(identity)).toBe(false);
    }
    expect(await portAccepts(context.port)).toBe(false);
    expect(existsSync(workRootOf(context))).toBe(false);
  });

  it("stops every owned process, grandchildren included, then the port and the work directory", async () => {
    const relay = await synthetic(["ok"]);
    const started = await relay.start();
    const owned = await relay.owned();
    const [context] = relay.launches;
    expect(owned).toHaveLength(2);
    for (const identity of owned) expect(await running(identity)).toBe(true);
    expect(started.instance).toEqual(owned[0]);
    expect(existsSync(started.workDir)).toBe(true);

    await started.stop();
    await started.stop();

    for (const identity of owned) expect(await running(identity)).toBe(false);
    expect(await portAccepts(context.port)).toBe(false);
    expect(existsSync(started.workDir)).toBe(false);
    expect(started.exited).toBe(true);
    expect(() => started.instance).toThrow(expect.objectContaining({ problem: "stopped" }));
  });

  it("escalates to SIGKILL for owned processes that ignore SIGTERM", async () => {
    const relay = await synthetic(["ignore-term"]);
    const started = await relay.start({ stopGraceMs: 1_000 });
    const owned = await relay.owned();

    await started.stop();

    for (const identity of owned) expect(await running(identity)).toBe(false);
  });

  it("never signals a process it does not own", async () => {
    const bystander: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    cleanups.push(async () => {
      bystander.kill("SIGKILL");
    });
    await new Promise((resolve) => bystander.once("spawn", resolve));
    const bystanderIdentity = await identityOf(bystander.pid);
    const relay = await (await synthetic(["ok"])).start();

    await relay.stop();

    expect(await running(bystanderIdentity)).toBe(true);
  });

  it("restarts as a new instance only after the previous one is gone", async () => {
    const relay = await synthetic(["ok"]);
    const started = await relay.start();
    const before = await relay.owned();
    const first = started.instance;

    await started.restart();

    const after = await relay.owned(1);
    expect(started.instance).not.toEqual(first);
    expect(started.instance).toEqual(after[0]);
    expect(relay.launches.map((launch) => launch.port)).toEqual([started.port, started.port]);
    for (const identity of before) expect(await running(identity)).toBe(false);
    for (const identity of after) expect(await running(identity)).toBe(true);
    expect(started.diagnostics()).toContain("connected to session <id>");
  });

  it("reports an early exit with its code and leaves nothing behind", async () => {
    const relay = await synthetic(["exit-early"]);

    const error = await expectProblem(relay.start(), "exited");

    expect(error.message).toContain("code 3");
    expect(existsSync(workRootOf(relay.launches[0]))).toBe(false);
  });

  it(
    "notices death by signal at once instead of waiting for the startup deadline",
    { timeout: 15_000 },
    async () => {
      const relay = await synthetic(["self-kill"]);

      const error = await expectProblem(relay.start({ startupTimeoutMs: 60_000 }), "exited");

      expect(error.message).toContain("signal SIGKILL");
    },
  );

  it("turns a spawn error into a rejection", async () => {
    const dir = await scratchDir();

    await expectProblem(
      startOwnedRelay({
        launch: () => ({
          entry: path.join(dir, "missing.cjs"),
          args: [],
          cwd: path.join(dir, "no-such-dir"),
          env: {},
        }),
        startupTimeoutMs: 2_000,
        stopGraceMs: 1_000,
      }),
      "spawn_failed",
    );
  });

  it("applies one deadline to the whole startup", async () => {
    const relay = await synthetic(["silent"]);
    const startedAt = Date.now();

    await expectProblem(
      relay.start({ startupTimeoutMs: 1_500, stopGraceMs: 1_000 }),
      "startup_timeout",
    );

    // Two phases with a full deadline each would take at least 3 s before the stop even begins.
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    for (const identity of await relay.owned()) {
      expect(await running(identity)).toBe(false);
    }
  });

  it("attaches a sanitized, bounded tail of the output to a failure", async () => {
    const relay = await synthetic(["noisy"]);

    const error = await expectProblem(relay.start(), "exited");

    expect(error.message).toContain("code 7");
    expect(error.diagnostics).toContain("token=<redacted>");
    expect(error.diagnostics).toContain("serverId=<id>");
    expect(error.diagnostics).toContain("session <id>");
    expect(error.diagnostics).not.toContain("A".repeat(32));
    expect(error.diagnostics).not.toContain("abc123def");
    expect(error.diagnostics).not.toContain("leaked-session-id");
    expect(error.diagnostics.length).toBeLessThanOrEqual(4 * 1024);
  });
});

describe("relay output sanitizer", () => {
  it("redacts known values and keeps at most the last 4 Ki characters", () => {
    const text = `${"x ".repeat(10_000)}/tmp/paseo-local-relay-abc/state done`;

    const result = sanitizeRelayOutput(text, ["/tmp/paseo-local-relay-abc"]);

    expect(result.length).toBe(4 * 1024);
    expect(result.endsWith("<redacted>/state done")).toBe(true);
  });
});

describe("wrangler resolution and launch", () => {
  it("resolves the wrangler the app declares, from the app's own installation", () => {
    const installation = resolveWrangler();
    const manifest: { version: string } = JSON.parse(
      readFileSync(path.join(installation.packageDir, "package.json"), "utf8"),
    );

    expect(installation.declaredBy).toBe(path.join(WRANGLER_DECLARING_PACKAGE, "package.json"));
    expect(installation.packageDir.startsWith(WRANGLER_DECLARING_PACKAGE)).toBe(true);
    expect(installation.version).toBe(manifest.version);
    expect(installation.entry).toBe(path.join(installation.packageDir, "bin", "wrangler.js"));
    expect(existsSync(installation.entry)).toBe(true);
  });

  it("refuses a package that does not declare wrangler", () => {
    const relayPackage = path.resolve(WRANGLER_DECLARING_PACKAGE, "../relay");

    expect(() => resolveWrangler(relayPackage)).toThrow(
      expect.objectContaining({ problem: "wrangler_not_declared" }),
    );
  });

  it("always clears the hosted upstream and binds everything to loopback", () => {
    const context: RelayLaunchContext = {
      port: 41_234,
      inspectorPort: 41_235,
      dirs: { state: "/w/state", logs: "/w/logs", registry: "/w/registry", cache: "/w/cache" },
    };
    const installation = {
      version: "4.105.0",
      packageDir: "/pkg",
      entry: "/pkg/bin/wrangler.js",
      declaredBy: "/app/package.json",
    };

    const launch = wranglerLaunch({ installation, context, relayPackageDir: "/relay" });

    expect(launch.entry).toBe("/pkg/bin/wrangler.js");
    expect(launch.cwd).toBe("/relay");
    expect(launch.args).toEqual([
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      "41234",
      "--inspector-ip",
      "127.0.0.1",
      "--inspector-port",
      "41235",
      "--persist-to",
      "/w/state",
      "--live-reload=false",
      "--show-interactive-dev-session=false",
      "--var",
      "PASEO_RELAY_UPSTREAM:",
    ]);
  });

  it("passes an explicit environment without inherited credentials", () => {
    const dirs = { state: "/w/state", logs: "/w/logs", registry: "/w/registry", cache: "/w/cache" };
    const source = {
      PATH: "/usr/bin",
      HOME: "/home/someone",
      LANG: "C.UTF-8",
      CLOUDFLARE_API_TOKEN: "cf-secret",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CF_API_KEY: "cf-key",
      ANTHROPIC_API_KEY: "provider-secret",
      NODE_OPTIONS: "--inspect",
      PASEO_HOME: "/home/someone/.paseo",
    };

    expect(relayEnvironment(dirs, source)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/someone",
      LANG: "C.UTF-8",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_SEND_ERROR_REPORTS: "false",
      WRANGLER_LOG_PATH: "/w/logs",
      WRANGLER_REGISTRY_PATH: "/w/registry",
      WRANGLER_CACHE_DIR: "/w/cache",
    });
  });
});
