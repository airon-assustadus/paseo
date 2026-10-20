import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { basename } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProcessTable,
  type ProcessEntry,
  type ProcessIdentity,
  type ProcessTable,
} from "../../remote-browser/process-tree.js";
import { encodeLengthPrefixed, LengthPrefixedReader } from "./length-prefixed.js";
import {
  RelayBridgeStackError,
  RelayBridgeStackStartError,
  startRelayBridgeStack,
  type RelayBridgeStack,
} from "./relay-bridge-stack.js";

/**
 * Lifecycle of the shared L-relay infrastructure. The traffic proofs live in the R1 harness
 * (`daemon-e2e/web-proxy-relay.local.e2e.test.ts`); here only start, restart, evidence shape, close
 * and partial-failure cleanup are asserted. Each `describe` starts one local wrangler relay.
 *
 * No conditional skip: on a runtime the local relay does not support, the start rejects and the
 * file fails visibly (RV-11).
 */

const SHELL = { bootstrapJs: "// bootstrap bundle (unused on TCP)", workerJs: "// worker bundle" };
const ALLOWED_ORIGIN = "http://127.0.0.1:1";
const TEST_TIMEOUT_MS = 120_000;
const ABSENT = { toTarget: false, fromTarget: false };
const NO_HOST_TOTALS = { connections: 0, authenticatedConnections: 0, sessionsOpened: 0 };

describe("relay bridge stack", () => {
  let stack: RelayBridgeStack;
  const steps: string[] = [];

  beforeAll(async () => {
    stack = await startRelayBridgeStack({
      shell: SHELL,
      allowedOrigin: ALLOWED_ORIGIN,
      onStep: (step) => steps.push(step),
    });
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await stack?.close();
  });

  it("starts the relay, both taps, the daemon and the host, and projects the offer", () => {
    expect(steps).toEqual([
      "relay started",
      "taps listening",
      "daemon started",
      "daemon relay control connected",
      "offer parsed",
      "host ready",
    ]);
    expect(stack.info.relay.endpoint).toBe(`127.0.0.1:${stack.taps.client.port}`);
    expect(stack.info.daemon.serverId).not.toBe("");
    expect(stack.info.daemon.daemonPublicKeyB64).not.toBe("");
    expect(stack.info.bridge).toEqual({
      tcpPort: stack.host.tcp?.port,
      token: stack.host.token,
      allowedOrigin: ALLOWED_ORIGIN,
      fixture: stack.host.fixture,
      shell: stack.host.shell,
    });
    expect(stack.relayRegistrations()).toBeGreaterThanOrEqual(1);

    // Before any client, only the daemon leg has traffic: the legs are told apart by construction.
    const evidence = stack.evidence({ nonce: "never-sent" });
    expect(evidence.daemonLeg.connections).toBeGreaterThanOrEqual(1);
    expect(evidence.clientLeg.connections).toBe(0);
    for (const leg of [evidence.clientLeg, evidence.daemonLeg]) {
      expect(leg.handshake).toEqual([]);
      expect(leg.overflow).toBeNull();
      expect(leg.contains).toEqual({ nonce: ABSENT, token: ABSENT, hello: ABSENT });
    }
    expect(evidence.host).toEqual(NO_HOST_TOTALS);
  });

  it(
    "copies the host's connection, authentication and session totals into the evidence",
    async () => {
      // One peer on the TCP listener, authenticated and with a session: the three totals the page
      // compares with its own openings (RV-7). Copied from `host.stats`, not counted here.
      const peer = await connectTcp(stack.info.bridge.tcpPort);
      try {
        peer.send({ type: "harness.hello", token: stack.info.bridge.token });
        await peer.take("harness.ready");
        expect(stack.evidence({ nonce: "never-sent" }).host).toEqual({
          connections: 1,
          authenticatedConnections: 1,
          sessionsOpened: 0,
        });
        peer.send({
          type: "session.open",
          scope: { origin: stack.info.bridge.fixture.http.origin, pathPrefix: "/" },
          ttlMs: 60_000,
        });
        await peer.take("session.opened");
        const { host } = stack.evidence({ nonce: "never-sent" });
        expect(host).toEqual({ connections: 1, authenticatedConnections: 1, sessionsOpened: 1 });
        const stats = stack.host.stats;
        expect(host).toEqual({
          connections: stats.connections,
          authenticatedConnections: stats.authenticatedConnections,
          sessionsOpened: stats.sessionsOpened,
        });
      } finally {
        peer.socket.destroy();
        await peer.closed;
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "restarts the relay on the same port and resolves only after the daemon registers again",
    async () => {
      const before = stack.relayRegistrations();
      const instanceBefore = { ...stack.relay.instance };
      const portBefore = stack.relay.port;

      const restart = stack.restartRelay();
      // A second restart while one is in flight is refused with a typed error, not queued.
      await expect(stack.restartRelay()).rejects.toBeInstanceOf(RelayBridgeStackError);
      await restart;

      expect(stack.relay.port).toBe(portBefore);
      expect(stack.relay.instance).not.toEqual(instanceBefore);
      expect(stack.relay.exited).toBe(false);
      expect(stack.relayRegistrations()).toBeGreaterThan(before);
      expect(steps.slice(-3)).toEqual([
        "relay restarting",
        "relay restarted",
        "daemon re-registered",
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it("refuses evidence without a nonce", () => {
    expect(() => stack.evidence({ nonce: "" })).toThrow(RelayBridgeStackError);
  });

  it(
    "closes once and every listener refuses connections afterwards",
    async () => {
      const ports = listenerPorts(stack);
      const first = stack.close();
      const second = stack.close();
      expect(second).toBe(first);
      await first;

      expect(stack.relay.exited).toBe(true);
      expect(stack.host.stats.activeSockets).toBe(0);
      for (const [name, port] of Object.entries(ports)) {
        expect({ name, outcome: await connectionOutcome(port) }).toEqual({
          name,
          outcome: "ECONNREFUSED",
        });
      }
      await expect(stack.restartRelay()).rejects.toBeInstanceOf(RelayBridgeStackError);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("relay bridge stack close during restart", () => {
  // Each case owns its stack: closing is the subject, so the stack is gone at the end of the case.
  // The helper's `restart` clears its current instance while the old process stops (B-1): a close
  // in that window must still end up with no relay process of ours and the port refusing.

  it(
    "closes while the old relay process is still stopping, and no relay process of ours survives",
    async () => {
      const table = createProcessTable(process.platform);
      const before = await descendantsOf(table, process.pid);
      const steps: string[] = [];
      const stack = await startRelayBridgeStack({
        shell: SHELL,
        allowedOrigin: ALLOWED_ORIGIN,
        onStep: (step) => steps.push(step),
      });
      const relayPort = stack.relay.port;

      const pending = stack.restartRelay();
      // Synchronous barrier: the helper has already dropped its current instance and begun stopping.
      expect(steps.at(-1)).toBe("relay restarting");
      expect(stack.relay.exited).toBe(true);

      // The restart rejects while the close is in progress; its handler is attached first.
      const rejected = expect(pending).rejects.toMatchObject({
        name: "RelayBridgeStackError",
        message: "Relay bridge stack closed during restart",
      });
      const closing = stack.close();
      expect(stack.close()).toBe(closing);
      await expect(stack.restartRelay()).rejects.toBeInstanceOf(RelayBridgeStackError);
      await closing;
      await rejected;

      expect(steps).toContain("relay restarted");
      expect(stack.relay.exited).toBe(true);
      expect(await connectionOutcome(relayPort)).toBe("ECONNREFUSED");
      const processes = await newDescendants(table, process.pid, before);
      logProcesses("close while stopping", processes);
      expect(processes.leftovers).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "closes while waiting for the daemon to register again, without waiting out the deadline",
    async () => {
      const table = createProcessTable(process.platform);
      const before = await descendantsOf(table, process.pid);
      let relayRestarted: () => void = () => undefined;
      const restarted = new Promise<void>((resolve) => {
        relayRestarted = resolve;
      });
      const stack = await startRelayBridgeStack({
        shell: SHELL,
        allowedOrigin: ALLOWED_ORIGIN,
        registrationTimeoutMs: 30_000,
        onStep: (step) => {
          if (step === "relay restarted") relayRestarted();
        },
      });
      const relayPort = stack.relay.port;

      const pending = stack.restartRelay();
      // Rejected by the close, not by the registration deadline: the daemon is gone and nothing
      // could register anyway. The handler is attached before the close that triggers it.
      const rejected = expect(pending).rejects.toMatchObject({
        name: "RelayBridgeStackError",
        message: "Relay bridge stack closed during restart",
      });
      await restarted;
      const closeStartedAt = Date.now();
      await stack.close();
      await rejected;
      expect(Date.now() - closeStartedAt).toBeLessThan(30_000);

      expect(stack.relay.exited).toBe(true);
      expect(await connectionOutcome(relayPort)).toBe("ECONNREFUSED");
      const processes = await newDescendants(table, process.pid, before);
      logProcesses("close while registering", processes);
      expect(processes.leftovers).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

function logProcesses(label: string, processes: Leftovers): void {
  // Command basenames and counts only; no paths, ports or identifiers.
  // eslint-disable-next-line no-console
  console.info(
    `[relay-stack] ${label} ${JSON.stringify({ transient: processes.transient, unrelated: processes.unrelated, waitedMs: processes.waitedMs, leftovers: processes.leftovers.length })}`,
  );
}

describe("relay bridge stack start failure", () => {
  it(
    "tears down the relay, both taps and the daemon when the host refuses the origin",
    async () => {
      let failure: unknown;
      try {
        // Parses as a URL but is not a bare origin: the host's own validation refuses it.
        await startRelayBridgeStack({ shell: SHELL, allowedOrigin: `${ALLOWED_ORIGIN}/path` });
      } catch (error) {
        failure = error;
      }
      if (!(failure instanceof RelayBridgeStackStartError)) {
        throw new Error(`Expected RelayBridgeStackStartError, got ${String(failure)}`);
      }
      expect(failure.step).toBe("host");
      expect(failure.cause).toBeInstanceOf(RangeError);
      // Unwound in reverse: daemon, daemon tap, client tap, relay.
      expect(failure.closedPorts).toHaveLength(4);
      for (const port of failure.closedPorts) {
        expect({ port, outcome: await connectionOutcome(port) }).toEqual({
          port,
          outcome: "ECONNREFUSED",
        });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

function listenerPorts(stack: RelayBridgeStack): Record<string, number> {
  if (stack.host.tcp === null) throw new Error("Bridge host started without its TCP listener");
  return {
    hostWs: Number(new URL(stack.host.url).port),
    hostTcp: stack.host.tcp.port,
    daemon: stack.daemon.port,
    clientTap: stack.taps.client.port,
    daemonTap: stack.taps.daemon.port,
    relay: stack.relay.port,
  };
}

interface TcpPeer {
  socket: Socket;
  send(frame: Record<string, unknown>): void;
  /** Next frame of `type`, in arrival order; frames of other types are kept for later takes. */
  take(type: string): Promise<Record<string, unknown>>;
  closed: Promise<void>;
}

/** A direct length-prefixed peer on the host's TCP listener, the same protocol the tunnel carries. */
function connectTcp(port: number): Promise<TcpPeer> {
  const socket = connect({ host: "127.0.0.1", port });
  const frames: Array<Record<string, unknown>> = [];
  const waiters = new Set<() => void>();
  const reader = new LengthPrefixedReader({
    onFrame: (text) => {
      frames.push(JSON.parse(text) as Record<string, unknown>);
      for (const waiter of waiters) waiter();
    },
  });
  socket.on("data", (chunk: Buffer) => reader.push(chunk));
  socket.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  const peer: TcpPeer = {
    socket,
    send: (frame) => {
      socket.write(encodeLengthPrefixed(JSON.stringify(frame)));
    },
    take: (type) =>
      new Promise((resolve) => {
        const check = () => {
          const index = frames.findIndex((frame) => frame.type === type);
          if (index === -1) return;
          waiters.delete(check);
          const [frame] = frames.splice(index, 1);
          if (frame) resolve(frame);
        };
        waiters.add(check);
        check();
      }),
    closed,
  };
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(peer));
    socket.once("error", reject);
  });
}

/** Live (non-zombie) processes below `root`, by pid and start time, from the repo's process table. */
async function descendantsOf(table: ProcessTable, root: number): Promise<ProcessIdentity[]> {
  const byParent = new Map<number, ProcessEntry[]>();
  for (const entry of await table.list()) {
    byParent.set(entry.ppid, [...(byParent.get(entry.ppid) ?? []), entry]);
  }
  const result: ProcessIdentity[] = [];
  const queue = [root];
  for (;;) {
    const pid = queue.shift();
    if (pid === undefined) break;
    for (const child of byParent.get(pid) ?? []) {
      if (!child.zombie) result.push({ pid: child.pid, startTime: child.startTime });
      queue.push(child.pid);
    }
  }
  return result;
}

interface Leftovers {
  /** New relay descendants still alive at the deadline: wrangler or workerd nobody will stop. */
  leftovers: Array<ProcessIdentity & { command: string }>;
  /** New relay descendants seen on the way out, by command basename; exiting is not surviving. */
  transient: string[];
  /**
   * New descendants that are not relay processes, by command basename. The daemon's plugin
   * compiler keeps an esbuild service alive for the life of this process; it is not the stack's.
   */
  unrelated: string[];
  waitedMs: number;
}

function isRelayProcess(command: string): boolean {
  return /wrangler|workerd/i.test(command);
}

/**
 * Relay descendants of `root` that did not exist in `before`, re-read until none is left or the
 * deadline passes. A child still exiting after its parent was stopped is allowed to finish; one
 * that is still there at the deadline has no owner, which is what B-1 is about.
 */
async function newDescendants(
  table: ProcessTable,
  root: number,
  before: readonly ProcessIdentity[],
  timeoutMs = 5_000,
): Promise<Leftovers> {
  const known = new Set(before.map((entry) => `${entry.pid}:${entry.startTime}`));
  const transient = new Set<string>();
  const unrelated = new Set<string>();
  const startedAt = Date.now();
  for (;;) {
    const now = await descendantsOf(table, root);
    const fresh = now.filter((entry) => !known.has(`${entry.pid}:${entry.startTime}`));
    const described = await Promise.all(
      fresh.map(async (entry) => ({
        pid: entry.pid,
        startTime: entry.startTime,
        command: await commandOf(entry.pid),
      })),
    );
    const relay = described.filter((entry) => isRelayProcess(entry.command));
    for (const entry of described) {
      (isRelayProcess(entry.command) ? transient : unrelated).add(entry.command);
    }
    const waitedMs = Date.now() - startedAt;
    if (relay.length === 0 || waitedMs >= timeoutMs) {
      return { leftovers: relay, transient: [...transient], unrelated: [...unrelated], waitedMs };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Basenames of the first arguments only: enough to tell wrangler, workerd or node apart. */
async function commandOf(pid: number): Promise<string> {
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`);
    return cmdline
      .toString("utf8")
      .split("\0")
      .filter((arg) => arg.length > 0)
      .slice(0, 3)
      .map((arg) => basename(arg))
      .join(" ");
  } catch {
    return "?";
  }
}

/** Resolves with the connect outcome: "connected" or the error code, never throws. */
function connectionOutcome(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
  });
}
