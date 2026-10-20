import { Writable } from "node:stream";
import pino from "pino";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { generateLocalPairingOffer } from "../../pairing-offer.js";
import {
  startLocalWranglerRelay,
  type LocalWranglerRelay,
} from "../../test-utils/local-wrangler-relay.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../../test-utils/paseo-daemon.js";
import {
  startWsTap,
  type WsTap,
  type WsTapDirection,
  type WsTapMessage,
  type WsTapOverflow,
} from "../../test-utils/ws-tap.js";
import {
  startBridgeHost,
  type BridgeFixtureInfo,
  type BridgeHost,
  type BridgeShell,
  type BridgeShellInfo,
} from "./bridge-host.js";

/**
 * L-relay infrastructure shared by the R1 harness and the R2 browser proof: local wrangler relay,
 * one WebSocket tap per leg, an isolated daemon registered with the relay, its local pairing offer
 * and the bridge host with its TCP listener. The client side (DaemonClient, tunnel, stream) is not
 * here: it is the test page in R2 and the Node harness in R1.
 *
 * The relay is the in-repo Cloudflare worker run locally with wrangler, a legacy implementation.
 * Nothing real is paired, every directory is temporary and every listener is loopback.
 */

export interface StartRelayBridgeStackOptions {
  shell: BridgeShell;
  /** Full origin of the page that will talk to the host; the host validates it. */
  allowedOrigin: string;
  /** One deadline for the wrangler startup. */
  relayStartupTimeoutMs?: number;
  /** Deadline for the daemon to register with the relay, at start and after a restart. */
  registrationTimeoutMs?: number;
  /** Timeline callback; receives step labels and counts only. */
  onStep?: (step: string, detail?: Record<string, unknown>) => void;
}

/**
 * Closed shape the lazy command copies field by field to the test page. Everything in it is
 * connection authority (the offer plus the host token) and stays on the test page only.
 */
export interface RelayBridgeStackInfo {
  relay: { endpoint: string };
  daemon: { serverId: string; daemonPublicKeyB64: string };
  bridge: {
    tcpPort: number;
    token: string;
    allowedOrigin: string;
    fixture: BridgeFixtureInfo;
    shell: BridgeShellInfo;
  };
}

export type RelayLeg = "client" | "daemon";

export interface RelayLegEvidence {
  connections: number;
  messages: number;
  handshake: Array<NonNullable<WsTapMessage["plaintextHandshake"]>>;
  /**
   * Frames the tap did not classify as the cleartext key exchange. On the client leg these are the
   * E2EE frames; on the daemon leg they also include the relay control frames. Not a cryptographic
   * claim.
   */
  nonHandshakeMessages: number;
  bytes: Record<WsTapDirection, number>;
  overflow: WsTapOverflow | null;
  /** Substring search in the tap's memory, per direction. The token never leaves Node. */
  contains: Record<"nonce" | "token" | "hello", Record<WsTapDirection, boolean>>;
}

export interface RelayBridgeEvidence {
  clientLeg: RelayLegEvidence;
  daemonLeg: RelayLegEvidence;
}

export type RelayBridgeStackStep = "relay" | "taps" | "daemon" | "registration" | "offer" | "host";

export class RelayBridgeStackStartError extends Error {
  constructor(
    public readonly step: RelayBridgeStackStep,
    /** Ports the earlier steps had opened; all closed again before this error is thrown. */
    public readonly closedPorts: readonly number[],
    cause: unknown,
  ) {
    super(`Relay bridge stack failed at step "${step}"`, { cause });
    this.name = "RelayBridgeStackStartError";
  }
}

export class RelayBridgeStackError extends Error {
  constructor(
    public readonly operation: "restart" | "evidence",
    message: string,
  ) {
    super(message);
    this.name = "RelayBridgeStackError";
  }
}

export interface RelayBridgeStack {
  readonly info: RelayBridgeStackInfo;
  /** Node-side handles for the harnesses; the command never projects them. */
  readonly host: BridgeHost;
  readonly daemon: TestPaseoDaemon;
  readonly relay: LocalWranglerRelay;
  readonly taps: Record<RelayLeg, WsTap>;
  /** `relay_control_connected` lines this daemon has logged so far. */
  relayRegistrations(): number;
  /**
   * Restarts the relay on the same port and resolves only after a new registration line, counted
   * against the number seen before the restart; an old line never satisfies it.
   */
  restartRelay(): Promise<void>;
  /** Both legs, labelled; booleans and counts only. */
  evidence(markers: { nonce: string }): RelayBridgeEvidence;
  /** Idempotent. Order: host, daemon, taps, relay. Every failure is attempted past and thrown once. */
  close(): Promise<void>;
}

const DEFAULT_RELAY_STARTUP_TIMEOUT_MS = 90_000;
const DEFAULT_REGISTRATION_TIMEOUT_MS = 30_000;
const REGISTRATION_LINE = "relay_control_connected";
const HELLO_NEEDLE = '"harness.hello"';

/** Daemon log sink: keeps the lines and wakes waiters on every write, so registration is event-driven. */
class DaemonLog {
  private readonly lines: string[] = [];
  private readonly waiters = new Set<() => void>();
  readonly sink = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      this.lines.push(chunk.toString("utf8"));
      for (const waiter of this.waiters) waiter();
      callback();
    },
  });

  registrations(): number {
    return this.lines.filter((line) => line.includes(REGISTRATION_LINE)).length;
  }

  /** Resolves once at least `count` registration lines exist; rejects with the recent relay events. */
  waitForRegistrations(count: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.registrations() < count) return;
        this.waiters.delete(check);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(
          new Error(
            `Daemon did not reach ${count} relay registration(s) in ${timeoutMs}ms; recent relay events: ${this.recentRelayEvents().join(",")}`,
          ),
        );
      }, timeoutMs);
      this.waiters.add(check);
      check();
    });
  }

  private recentRelayEvents(): string[] {
    return this.lines
      .filter((line) => line.includes("relay_"))
      .map((line) => line.match(/"msg":"([a-z_]+)"/)?.[1] ?? "?")
      .slice(-10);
  }
}

export async function startRelayBridgeStack(
  options: StartRelayBridgeStackOptions,
): Promise<RelayBridgeStack> {
  const registrationTimeoutMs = options.registrationTimeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS;
  const step = options.onStep ?? (() => undefined);
  const opened: Array<{ port: number; close: () => Promise<void> }> = [];

  async function unwind(failedStep: RelayBridgeStackStep, cause: unknown): Promise<never> {
    const closedPorts: number[] = [];
    while (opened.length > 0) {
      const entry = opened.pop();
      if (!entry) break;
      await entry.close().catch(() => undefined);
      closedPorts.push(entry.port);
    }
    throw new RelayBridgeStackStartError(failedStep, closedPorts, cause);
  }

  let relay: LocalWranglerRelay;
  try {
    relay = await startLocalWranglerRelay({
      startupTimeoutMs: options.relayStartupTimeoutMs ?? DEFAULT_RELAY_STARTUP_TIMEOUT_MS,
    });
  } catch (error) {
    return unwind("relay", error);
  }
  opened.push({ port: relay.port, close: () => relay.stop() });
  step("relay started", { wrangler: relay.wrangler.version });

  let clientTap: WsTap;
  let daemonTap: WsTap;
  try {
    clientTap = await startWsTap({ targetPort: relay.port });
    opened.push({ port: clientTap.port, close: () => clientTap.close() });
    daemonTap = await startWsTap({ targetPort: relay.port });
    opened.push({ port: daemonTap.port, close: () => daemonTap.close() });
  } catch (error) {
    return unwind("taps", error);
  }
  step("taps listening");

  const log = new DaemonLog();
  let daemon: TestPaseoDaemon;
  try {
    daemon = await createTestPaseoDaemon({
      logger: pino({ level: "debug" }, log.sink),
      listen: "127.0.0.1",
      mcpEnabled: false,
      relayEnabled: true,
      relayEndpoint: `127.0.0.1:${daemonTap.port}`,
      relayUseTls: false,
      relayPublicUseTls: false,
    });
  } catch (error) {
    return unwind("daemon", error);
  }
  opened.push({ port: daemon.port, close: () => daemon.close() });
  step("daemon started");

  try {
    await log.waitForRegistrations(1, registrationTimeoutMs);
  } catch (error) {
    return unwind("registration", error);
  }
  step("daemon relay control connected");

  let info: Omit<RelayBridgeStackInfo, "bridge">;
  try {
    info = await offerFor({ daemon, daemonTapPort: daemonTap.port, clientTapPort: clientTap.port });
  } catch (error) {
    return unwind("offer", error);
  }
  step("offer parsed");

  let host: BridgeHost;
  try {
    host = await startBridgeHost({
      shell: options.shell,
      allowedOrigin: options.allowedOrigin,
      tcp: true,
    });
  } catch (error) {
    return unwind("host", error);
  }
  if (host.tcp === null) {
    await host.close().catch(() => undefined);
    return unwind("host", new Error("Bridge host started without its TCP listener"));
  }
  step("host ready", { tcp: true });

  const tcpPort = host.tcp.port;
  let closing: Promise<void> | null = null;

  async function closeAll(): Promise<void> {
    const failures: unknown[] = [];
    const steps: Array<() => Promise<void>> = [
      () => host.close(),
      () => daemon.close(),
      () => clientTap.close(),
      () => daemonTap.close(),
      () => relay.stop(),
    ];
    for (const run of steps) {
      await run().catch((error: unknown) => failures.push(error));
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Relay bridge stack did not close cleanly");
    }
  }

  function legEvidence(tap: WsTap, nonce: string): RelayLegEvidence {
    const summary = tap.summary();
    const messages = tap.messages();
    const handshake = messages
      .map((message) => message.plaintextHandshake)
      .filter((kind): kind is NonNullable<typeof kind> => kind !== null);
    return {
      connections: summary.connections,
      messages: summary.messages,
      handshake,
      nonHandshakeMessages: messages.length - handshake.length,
      bytes: { ...summary.bytes },
      overflow: summary.overflow,
      contains: {
        nonce: tap.contains(nonce),
        token: tap.contains(host.token),
        hello: tap.contains(HELLO_NEEDLE),
      },
    };
  }

  return {
    info: {
      relay: info.relay,
      daemon: info.daemon,
      bridge: {
        tcpPort,
        token: host.token,
        allowedOrigin: host.allowedOrigin,
        fixture: host.fixture,
        shell: host.shell,
      },
    },
    host,
    daemon,
    relay,
    taps: { client: clientTap, daemon: daemonTap },
    relayRegistrations: () => log.registrations(),
    restartRelay: async () => {
      if (closing !== null) {
        throw new RelayBridgeStackError("restart", "Relay bridge stack is closed");
      }
      const before = log.registrations();
      step("relay restarting", { registrations: before });
      await relay.restart();
      await log.waitForRegistrations(before + 1, registrationTimeoutMs);
      step("daemon re-registered", { registrations: log.registrations() });
    },
    evidence: ({ nonce }) => {
      if (nonce.length === 0) {
        throw new RelayBridgeStackError("evidence", "Evidence needs a non-empty nonce");
      }
      return { clientLeg: legEvidence(clientTap, nonce), daemonLeg: legEvidence(daemonTap, nonce) };
    },
    close: () => {
      closing ??= closeAll();
      return closing;
    },
  };
}

async function offerFor(args: {
  daemon: TestPaseoDaemon;
  daemonTapPort: number;
  clientTapPort: number;
}): Promise<Omit<RelayBridgeStackInfo, "bridge">> {
  const pairing = await generateLocalPairingOffer({
    paseoHome: args.daemon.paseoHome,
    relayEnabled: true,
    relayEndpoint: `127.0.0.1:${args.daemonTapPort}`,
    relayPublicEndpoint: `127.0.0.1:${args.clientTapPort}`,
    relayUseTls: false,
    relayPublicUseTls: false,
    appBaseUrl: "https://app.paseo.sh",
    includeQr: false,
  });
  if (!pairing.url) throw new Error("Local pairing did not produce a relay offer");
  const offer = parseConnectionOfferFromUrl(pairing.url);
  if (!offer) throw new Error("Local pairing offer did not parse");
  const expectedEndpoint = `127.0.0.1:${args.clientTapPort}`;
  if (offer.relay.endpoint !== expectedEndpoint || offer.relay.useTls !== false) {
    throw new Error(
      `Local pairing offer is not the loopback client tap: ${offer.relay.endpoint} tls=${offer.relay.useTls}`,
    );
  }
  return {
    relay: { endpoint: offer.relay.endpoint },
    daemon: { serverId: offer.serverId, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
  };
}
