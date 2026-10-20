import { connect, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
      expect(steps.slice(-2)).toEqual(["relay restarting", "daemon re-registered"]);
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
