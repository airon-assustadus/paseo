import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
 */

const nodeMajor = Number((process.versions.node ?? "0").split(".")[0] ?? "0");
// wrangler's local runtime is not supported on Node 25 yet; the skip is visible, not silent.
const relaySuite = nodeMajor < 25 ? describe : describe.skip;
const suiteName = (name: string) =>
  nodeMajor < 25 ? name : `${name} — skipped: wrangler needs Node < 25, found ${nodeMajor}`;

const SHELL = { bootstrapJs: "// bootstrap bundle (unused on TCP)", workerJs: "// worker bundle" };
const ALLOWED_ORIGIN = "http://127.0.0.1:1";
const TEST_TIMEOUT_MS = 120_000;
const ABSENT = { toTarget: false, fromTarget: false };

relaySuite(suiteName("relay bridge stack"), () => {
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
  });

  it(
    "restarts the relay on the same port and resolves only after the daemon registers again",
    async () => {
      const before = stack.relayRegistrations();
      const instanceBefore = { ...stack.relay.instance };
      const portBefore = stack.relay.port;

      await stack.restartRelay();

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

relaySuite(suiteName("relay bridge stack start failure"), () => {
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
