import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";

/**
 * The in-repo Cloudflare relay run locally with `wrangler dev --local`, extracted from
 * `daemon-e2e/relay-transport.e2e.test.ts`. It is the legacy relay implementation
 * (`docs/architecture.md`), kept as a local, isolated stand-in for transport experiments; nothing
 * here touches the hosted relay, a real pairing, or the daemon on port 6767. Starting it is heavy
 * (a workerd process): run it under the shared guard, one at a time.
 */

export interface LocalWranglerRelay {
  port: number;
  endpoint: string;
  stop(): Promise<void>;
  /** Stops and starts again on the same port, for interruption experiments. */
  restart(): Promise<void>;
  readonly exited: boolean;
}

export interface LocalWranglerRelayOptions {
  startupTimeoutMs?: number;
  /** Disable upstream forwarding so the local worker serves sessions itself. */
  localOnly?: boolean;
}

const RELAY_PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../relay",
);

export async function startLocalWranglerRelay(
  options: LocalWranglerRelayOptions = {},
): Promise<LocalWranglerRelay> {
  const port = await availablePort();
  let child: ChildProcess | null = null;
  const start = async () => {
    child = spawnWrangler(port, options.localOnly ?? true);
    const process_ = child;
    try {
      await waitForTcp(port, options.startupTimeoutMs ?? 30_000, process_);
      await waitForRelayWebSocket(port, options.startupTimeoutMs ?? 60_000, process_);
    } catch (error) {
      await stopProcess(process_);
      throw error;
    }
  };
  const stop = async () => {
    if (!child) return;
    const process_ = child;
    child = null;
    await stopProcess(process_);
  };
  await start();
  return {
    port,
    endpoint: `127.0.0.1:${port}`,
    stop,
    async restart() {
      await stop();
      await start();
    },
    get exited() {
      return child === null || child.exitCode !== null;
    },
  };
}

function spawnWrangler(port: number, localOnly: boolean): ChildProcess {
  const args = [
    "wrangler",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--live-reload=false",
    "--show-interactive-dev-session=false",
  ];
  if (localOnly) args.push("--var", "PASEO_RELAY_UPSTREAM:");
  const child = spawn("npx", args, {
    cwd: RELAY_PACKAGE_ROOT,
    env: { ...process.env },
    stdio: ["ignore", "ignore", "ignore"],
    detached: false,
  });
  return child;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
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

async function waitForTcp(port: number, timeoutMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited with code ${child.exitCode}`);
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Local relay did not listen on ${port} within ${timeoutMs}ms`);
}

async function waitForRelayWebSocket(
  port: number,
  timeoutMs: number,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited with code ${child.exitCode}`);
    const url = buildRelayWebSocketUrl({
      endpoint: `127.0.0.1:${port}`,
      useTls: false,
      serverId: `probe-${Date.now().toString(36)}`,
      role: "server",
    });
    const opened = await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(url);
      let pendingResolve: ((value: boolean) => void) | null = resolve;
      const settle = (value: boolean) => {
        if (!pendingResolve) return;
        const finish = pendingResolve;
        pendingResolve = null;
        clearTimeout(timer);
        finish(value);
      };
      const timer = setTimeout(() => {
        socket.terminate();
        settle(false);
      }, 5_000);
      socket.once("open", () => {
        socket.close(1000, "probe");
        settle(true);
      });
      socket.once("error", () => settle(false));
    });
    if (opened) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Local relay WebSocket not ready on ${port} within ${timeoutMs}ms`);
}
