import http from "node:http";
import https from "node:https";
import { isIP, type Server as NetServer } from "node:net";
import type { Duplex } from "node:stream";
import { FixtureRecorder, type FixtureListenerName } from "./recorder.js";
import {
  createRequestListener,
  DEFAULT_FIXTURE_LIMITS,
  type FixtureLimits,
  type FixtureState,
} from "./routes.js";
import { createSyntheticAuthority, type SyntheticLeaf } from "./tls/synthetic-authority.js";
import { attachWebSocketRoutes, type WebSocketRoutes } from "./websocket.js";

/**
 * Loopback HTTP/HTTPS/WebSocket origin for the web proxy experiments (WP01 / F-FIX). Test code
 * starts it, drives it through whichever transport is under test, and reads `events` to prove what
 * reached the origin. Nothing here is wired into the daemon.
 *
 * Distinct loopback ports are distinct origins but the same site, so two fixtures on 127.0.0.1 do
 * not demonstrate site isolation, and a loopback canary cannot tell host egress from phone egress.
 * Those proofs need the separate content domain and the physical device gates.
 */

export interface FixtureListener {
  readonly name: FixtureListenerName;
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly baseUrl: string;
}

export interface FixtureTlsListener extends FixtureListener {
  /** PEM of this run's synthetic authority; pass it as `ca` to the client under test. */
  readonly caPem: string;
  readonly serverNames: readonly string[];
}

export interface FixtureTlsVariants {
  readonly wrongHost: FixtureTlsListener;
  readonly expired: FixtureTlsListener;
  readonly selfSigned: FixtureTlsListener;
}

export interface WebProxyFixtureTlsOptions {
  extraNames?: readonly string[];
}

export interface WebProxyFixtureCanaryOptions {
  host?: string;
}

export interface WebProxyFixtureOptions {
  host?: string;
  tls?: boolean | WebProxyFixtureTlsOptions;
  canary?: boolean | WebProxyFixtureCanaryOptions;
  /** Other origins the probe, exit, and redirect routes may reference. */
  peerOrigins?: readonly string[];
  limits?: Partial<FixtureLimits>;
}

export interface WebProxyFixture {
  readonly http: FixtureListener;
  readonly https: FixtureTlsListener | null;
  readonly httpsVariants: FixtureTlsVariants | null;
  readonly canary: FixtureListener | null;
  readonly events: FixtureRecorder;
  postCount(token: string): number;
  close(): Promise<void>;
}

export class FixtureListenError extends Error {
  constructor(
    public readonly listener: FixtureListenerName,
    public readonly host: string,
    cause?: unknown,
  ) {
    super(`Fixture listener ${listener} could not bind on ${host}`, { cause });
    this.name = "FixtureListenError";
  }
}

interface ManagedListener {
  server: http.Server | https.Server;
  sockets: Set<Duplex>;
  webSocket: WebSocketRoutes | null;
  info: FixtureListener;
}

interface OpenListenerArgs {
  name: FixtureListenerName;
  host: string;
  state: FixtureState;
  tls: SyntheticLeaf | null;
  canaryOnly: boolean;
  webSocket: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function startWebProxyFixture(
  options: WebProxyFixtureOptions = {},
): Promise<WebProxyFixture> {
  const host = options.host ?? "127.0.0.1";
  const limits: FixtureLimits = { ...DEFAULT_FIXTURE_LIMITS, ...options.limits };
  const state: FixtureState = {
    recorder: new FixtureRecorder(limits.maxEvents),
    limits,
    allowedOrigins: new Set(options.peerOrigins ?? []),
    issuedCookieValues: new Set(),
    postCounts: new Map(),
  };
  const managed: ManagedListener[] = [];
  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= Promise.all(managed.map(closeListener)).then(() => undefined);
    return closing;
  };
  const open = async (args: OpenListenerArgs) => {
    const listener = await openListener(args);
    managed.push(listener);
    state.allowedOrigins.add(listener.info.origin);
    return listener;
  };

  try {
    const plain = await open({
      name: "http",
      host,
      state,
      tls: null,
      canaryOnly: false,
      webSocket: true,
    });
    const tls = options.tls ? await openTls(options.tls, host, state, open) : null;
    const canary = options.canary
      ? await open({
          name: "canary",
          host: (typeof options.canary === "object" ? options.canary.host : undefined) ?? host,
          state,
          tls: null,
          canaryOnly: true,
          webSocket: false,
        })
      : null;
    return {
      http: plain.info,
      https: tls?.valid ?? null,
      httpsVariants: tls?.variants ?? null,
      canary: canary?.info ?? null,
      events: state.recorder,
      postCount: (token) => state.postCounts.get(token) ?? 0,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

interface TlsListeners {
  valid: FixtureTlsListener;
  variants: FixtureTlsVariants;
}

async function openTls(
  tlsOptions: true | WebProxyFixtureTlsOptions,
  host: string,
  state: FixtureState,
  open: (args: OpenListenerArgs) => Promise<ManagedListener>,
): Promise<TlsListeners> {
  const extraNames = typeof tlsOptions === "object" ? (tlsOptions.extraNames ?? []) : [];
  const serverNames = [...new Set(["localhost", "127.0.0.1", "::1", host, ...extraNames])];
  const dnsNames = serverNames.filter((name) => isIP(name) === 0);
  const ipAddresses = serverNames.filter((name) => isIP(name) !== 0);
  const authority = createSyntheticAuthority();
  const now = Date.now();
  const leaves: Record<keyof FixtureTlsVariants | "valid", SyntheticLeaf> = {
    valid: authority.issue({ commonName: "web-proxy-fixture", dnsNames, ipAddresses }),
    wrongHost: authority.issue({
      commonName: "wrong-host.invalid",
      dnsNames: ["wrong-host.invalid"],
    }),
    expired: authority.issue({
      commonName: "web-proxy-fixture-expired",
      dnsNames,
      ipAddresses,
      notBefore: new Date(now - 3 * DAY_MS),
      notAfter: new Date(now - DAY_MS),
    }),
    selfSigned: authority.issue({
      commonName: "web-proxy-fixture-self-signed",
      dnsNames,
      ipAddresses,
      selfSigned: true,
    }),
  };
  const decorate = (listener: ManagedListener): FixtureTlsListener => ({
    ...listener.info,
    caPem: authority.certificatePem,
    serverNames,
  });
  const valid = await open({
    name: "https",
    host,
    state,
    tls: leaves.valid,
    canaryOnly: false,
    webSocket: true,
  });
  const variant = (name: FixtureListenerName, leaf: SyntheticLeaf) =>
    open({ name, host, state, tls: leaf, canaryOnly: false, webSocket: false });
  return {
    valid: decorate(valid),
    variants: {
      wrongHost: decorate(await variant("https:wrongHost", leaves.wrongHost)),
      expired: decorate(await variant("https:expired", leaves.expired)),
      selfSigned: decorate(await variant("https:selfSigned", leaves.selfSigned)),
    },
  };
}

async function openListener(args: OpenListenerArgs): Promise<ManagedListener> {
  let origin = "";
  const requestListener = createRequestListener({
    listener: args.name,
    secure: args.tls !== null,
    origin: () => origin,
    state: args.state,
    canaryOnly: args.canaryOnly,
  });
  const server = args.tls
    ? https.createServer(
        { key: args.tls.privateKeyPem, cert: args.tls.certificatePem, minVersion: "TLSv1.2" },
        requestListener,
      )
    : http.createServer(requestListener);
  const sockets = new Set<Duplex>();
  server.on("connection", (socket: Duplex) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const port = await listen(server, args.host, args.name);
  const scheme = args.tls ? "https" : "http";
  origin = `${scheme}://${args.host.includes(":") ? `[${args.host}]` : args.host}:${port}`;
  const webSocket = args.webSocket
    ? attachWebSocketRoutes({
        server,
        listener: args.name,
        origin: () => origin,
        state: args.state,
      })
    : null;
  return {
    server,
    sockets,
    webSocket,
    info: { name: args.name, scheme, host: args.host, port, origin, baseUrl: origin },
  };
}

function listen(server: NetServer, host: string, name: FixtureListenerName): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (cause: Error) => reject(new FixtureListenError(name, host, cause));
    server.once("error", onError);
    server.listen({ host, port: 0, exclusive: true }, () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new FixtureListenError(name, host));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeListener(listener: ManagedListener): Promise<void> {
  if (listener.webSocket) await listener.webSocket.close();
  // Registered after the response listeners, so these settle once every `res` "close" has fired
  // and the recorder already holds the matching `*.closed` event.
  const closed = [...listener.sockets].map((socket) =>
    socket.closed
      ? Promise.resolve()
      : new Promise<void>((resolve) => socket.once("close", () => resolve())),
  );
  listener.server.closeAllConnections();
  for (const socket of listener.sockets) socket.destroy();
  await Promise.all(closed);
  await new Promise<void>((resolve) => listener.server.close(() => resolve()));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
