import {
  MAX_ADMITTED_CLIENTS,
  isSessionOpen,
  parseLifecycleArm,
  parseResyncReply,
  parseSessionPortMessage,
  type ShellLifecycleArmedMessage,
  type ShellRefusalReason,
  type ShellWorkerToBootstrapMessage,
} from "./relay-messages";

// Which document may reach which bootstrap's broker port. Measured on Chromium 145
// (shell-client-binding-plan.md §2): a navigation's clientId is the document it replaces in that
// frame, empty for a new frame; resultingClientId survives a same-origin redirect; client ids
// survive a worker restart. Everything on the content origin shares one authority, so this is
// routing and refusal of clients outside the chain, not isolation between sessions.

// Hypotheses for the experiment, to calibrate on a device.
export const BINDING_LIMITS = {
  maxSessions: 4,
  maxClientsPerSession: MAX_ADMITTED_CLIENTS,
  maxTicketsPerSession: 2,
  maxResyncCandidates: 4,
  minResyncIntervalMs: 1000,
  maxClosedRemembered: 64,
} as const;

export interface ShellClient {
  id: string;
  url: string;
  frameType: string;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

export interface ShellClients {
  get(id: string): Promise<ShellClient | undefined>;
  matchAll(options: {
    type: "window";
    includeUncontrolled: boolean;
  }): Promise<ReadonlyArray<ShellClient>>;
}

export interface BindingConfig {
  origin: string;
  bootstrapPath: string;
  shellPathPrefix: string;
  mountPath: string;
  ticketTtlMs: number;
  // A client admitted this recently may not exist yet: it is still being created.
  formationTtlMs: number;
  resyncTimeoutMs: number;
}

export type BindingRefusal =
  | "foreign_client"
  | "client_not_admitted"
  | "client_limit"
  | "session_unavailable";

export type BindingRoute =
  // armed: the bootstrap armed the lifecycle on this binding when the request started.
  { kind: "route"; port: MessagePort; armed: boolean } | { kind: "refused"; code: BindingRefusal };

export interface ShellMessageInput {
  data: unknown;
  sourceId: string | null;
  ports: ReadonlyArray<MessagePort>;
}

export interface NavigationInput {
  clientId: string;
  resultingClientId: string;
}

export interface ClientBinding {
  handleMessage(input: ShellMessageInput): void;
  // Consumes a ticket and reserves resultingClientId for the next hop of this navigation.
  enter(input: NavigationInput & { ticket: string | null }): Promise<boolean>;
  routeNavigation(input: NavigationInput): Promise<BindingRoute>;
  routeSubresource(clientId: string): Promise<BindingRoute>;
}

interface Session {
  bootstrapId: string;
  port: MessagePort;
  // clientId → admitted at
  admitted: Map<string, number>;
  // ticket → expires at
  tickets: Map<string, number>;
  // resultingClientId reserved by a consumed ticket → expires at
  entries: Map<string, number>;
  // Lives with the binding: a restarted worker or an adopted port starts unarmed.
  armed: boolean;
}

interface ResyncReply {
  client: ShellClient;
  port: MessagePort;
  admitted: string[];
}

function refused(code: BindingRefusal): BindingRoute {
  return { kind: "refused", code };
}

export function createClientBinding(input: {
  config: BindingConfig;
  clients: ShellClients;
  now: () => number;
}): ClientBinding {
  const { config, clients, now } = input;
  const sessions = new Map<string, Session>();
  const closed: string[] = [];
  let resyncing: Promise<void> | null = null;
  let lastResyncAt = Number.NEGATIVE_INFINITY;

  function isOwnUrl(url: string, acceptsPath: (pathname: string) => boolean): boolean {
    if (!URL.canParse(url)) return false;
    const parsed = new URL(url);
    return parsed.origin === config.origin && acceptsPath(parsed.pathname);
  }

  function isBootstrap(client: ShellClient | undefined): client is ShellClient {
    return (
      client !== undefined &&
      client.frameType === "nested" &&
      isOwnUrl(client.url, (pathname) => pathname === config.bootstrapPath)
    );
  }

  function isAppDocument(client: ShellClient | undefined): client is ShellClient {
    return (
      client !== undefined &&
      client.frameType === "nested" &&
      isOwnUrl(
        client.url,
        (pathname) =>
          pathname.startsWith(config.mountPath) && !pathname.startsWith(config.shellPathPrefix),
      )
    );
  }

  function send(session: Session, message: ShellWorkerToBootstrapMessage): void {
    session.port.postMessage(message, []);
  }

  function refuse(port: MessagePort, reason: ShellRefusalReason): void {
    const message: ShellWorkerToBootstrapMessage = { type: "paseo.shell.refused", reason };
    port.postMessage(message, []);
    port.close();
  }

  function isClosed(bootstrapId: string): boolean {
    return closed.includes(bootstrapId);
  }

  function dropSession(session: Session): void {
    if (sessions.get(session.bootstrapId) !== session) return;
    sessions.delete(session.bootstrapId);
    session.port.close();
    closed.push(session.bootstrapId);
    if (closed.length > BINDING_LIMITS.maxClosedRemembered) closed.shift();
  }

  function expire(entries: Map<string, number>): void {
    const current = now();
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= current) entries.delete(key);
    }
  }

  function announce(session: Session): void {
    send(session, { type: "paseo.shell.admitted", clientIds: [...session.admitted.keys()] });
  }

  // Dead documents leave before the quota is checked, so a long run of navigations never fills
  // the session with history; ids still being created keep their slot until formationTtlMs.
  async function prune(session: Session): Promise<void> {
    expire(session.tickets);
    expire(session.entries);
    let changed = false;
    // A snapshot: other events may admit or drop clients while this loop awaits.
    for (const [clientId, admittedAt] of Array.from(session.admitted)) {
      if (now() - admittedAt < config.formationTtlMs) continue;
      if ((await clients.get(clientId)) !== undefined) continue;
      session.admitted.delete(clientId);
      changed = true;
    }
    if (changed) announce(session);
  }

  async function admit(session: Session, clientId: string): Promise<boolean> {
    if (session.admitted.has(clientId)) return true;
    await prune(session);
    if (session.admitted.size >= BINDING_LIMITS.maxClientsPerSession) return false;
    session.admitted.set(clientId, now());
    announce(session);
    return true;
  }

  function ownerOf(clientId: string): Session | null {
    for (const session of sessions.values()) {
      if (session.admitted.has(clientId)) return session;
    }
    return null;
  }

  // Checked on every request: a closed MessagePort is not reported by every browser.
  async function isLive(session: Session): Promise<boolean> {
    if (sessions.get(session.bootstrapId) !== session) return false;
    if (isBootstrap(await clients.get(session.bootstrapId))) return true;
    dropSession(session);
    return false;
  }

  async function pruneSessions(): Promise<void> {
    for (const session of Array.from(sessions.values())) await isLive(session);
  }

  function onSessionMessage(session: Session, data: unknown): void {
    if (sessions.get(session.bootstrapId) !== session) return;
    const message = parseSessionPortMessage(data);
    if (message === null || message.type === "paseo.shell.session.close") {
      dropSession(session);
      return;
    }
    expire(session.tickets);
    if (session.tickets.size >= BINDING_LIMITS.maxTicketsPerSession) {
      send(session, { type: "paseo.shell.refused", reason: "ticket_limit" });
      return;
    }
    session.tickets.set(message.ticket, now() + config.ticketTtlMs);
    send(session, { type: "paseo.shell.ticket.ready", ticket: message.ticket });
  }

  function register(session: Session): void {
    sessions.set(session.bootstrapId, session);
    session.port.addEventListener("message", (event) => onSessionMessage(session, event.data));
    session.port.start();
  }

  async function openSession(bootstrapId: string, port: MessagePort): Promise<void> {
    if (!isBootstrap(await clients.get(bootstrapId))) return refuse(port, "bad_source");
    await pruneSessions();
    if (isClosed(bootstrapId)) return refuse(port, "session_closed");
    if (sessions.has(bootstrapId)) return refuse(port, "duplicate_session");
    if (sessions.size >= BINDING_LIMITS.maxSessions) return refuse(port, "session_limit");
    const session: Session = {
      bootstrapId,
      port,
      admitted: new Map(),
      tickets: new Map(),
      entries: new Map(),
      armed: false,
    };
    register(session);
    send(session, { type: "paseo.shell.session.ready" });
  }

  function askCandidate(client: ShellClient): Promise<ResyncReply | null> {
    const channel = new MessageChannel();
    const { promise, resolve } = Promise.withResolvers<ResyncReply | null>();
    // One reply, on this port only, within the deadline; anything later finds the port closed.
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, config.resyncTimeoutMs);
    channel.port1.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        const reply = parseResyncReply(event.data);
        if (reply === null) {
          channel.port1.close();
          resolve(null);
          return;
        }
        resolve({ client, port: channel.port1, admitted: reply.admitted });
      },
      { once: true },
    );
    channel.port1.start();
    client.postMessage({ type: "paseo.shell.resync" }, [channel.port2]);
    return promise;
  }

  async function adopt(reply: ResyncReply, claims: Map<string, number>): Promise<void> {
    const bootstrapId = reply.client.id;
    const hasRoom = sessions.size < BINDING_LIMITS.maxSessions;
    if (!hasRoom || sessions.has(bootstrapId) || isClosed(bootstrapId)) {
      reply.port.close();
      return;
    }
    const admitted = new Map<string, number>();
    for (const clientId of new Set(reply.admitted)) {
      // An id claimed twice, or already owned, has no owner: refusing is the safe answer.
      if (claims.get(clientId) !== 1 || ownerOf(clientId) !== null) continue;
      if (isAppDocument(await clients.get(clientId))) admitted.set(clientId, now());
    }
    const session: Session = {
      bootstrapId,
      port: reply.port,
      admitted,
      tickets: new Map(),
      entries: new Map(),
      armed: false,
    };
    register(session);
    announce(session);
  }

  // A bootstrap arms right after it answered a resync: the adoption must land first.
  async function arm(bootstrapId: string, nonce: string, port: MessagePort): Promise<void> {
    if (resyncing !== null) await resyncing;
    const session = sessions.get(bootstrapId);
    if (session !== undefined) session.armed = true;
    const reply: ShellLifecycleArmedMessage = {
      type: "paseo.shell.lifecycle.armed",
      v: 1,
      nonce,
      armed: session !== undefined,
    };
    port.postMessage(reply, []);
    port.close();
  }

  // After a restart the worker knows nothing; live bootstraps hold the durable copy.
  async function runResync(): Promise<void> {
    await pruneSessions();
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const room = BINDING_LIMITS.maxSessions - sessions.size;
    const candidates = windows
      .filter((client) => isBootstrap(client) && !sessions.has(client.id) && !isClosed(client.id))
      .slice(0, Math.min(room, BINDING_LIMITS.maxResyncCandidates));
    const answered = await Promise.all(candidates.map(askCandidate));
    const replies = answered.filter((reply): reply is ResyncReply => reply !== null);
    const claims = new Map<string, number>();
    for (const reply of replies) {
      for (const clientId of new Set(reply.admitted)) {
        claims.set(clientId, (claims.get(clientId) ?? 0) + 1);
      }
    }
    for (const reply of replies) await adopt(reply, claims);
  }

  function resync(): Promise<void> {
    if (resyncing !== null) return resyncing;
    if (now() - lastResyncAt < BINDING_LIMITS.minResyncIntervalMs) return Promise.resolve();
    lastResyncAt = now();
    resyncing = runResync().finally(() => {
      resyncing = null;
    });
    return resyncing;
  }

  async function knownOwner(clientId: string): Promise<Session | null> {
    const owned = ownerOf(clientId);
    if (owned !== null) return owned;
    await resync();
    return ownerOf(clientId);
  }

  function takeEntry(resultingClientId: string): Session | null {
    for (const session of sessions.values()) {
      expire(session.entries);
      if (session.entries.delete(resultingClientId)) return session;
    }
    return null;
  }

  async function routeTo(session: Session, clientId: string): Promise<BindingRoute> {
    if (!(await isLive(session))) return refused("session_unavailable");
    if (!(await admit(session, clientId))) return refused("client_limit");
    return { kind: "route", port: session.port, armed: session.armed };
  }

  return {
    handleMessage({ data, sourceId, ports }) {
      const port = ports[0];
      if (sourceId === null || ports.length !== 1 || port === undefined) return;
      const armRequest = parseLifecycleArm(data);
      if (armRequest !== null) {
        void arm(sourceId, armRequest.nonce, port);
        return;
      }
      if (isSessionOpen(data)) void openSession(sourceId, port);
    },

    async enter({ ticket, clientId, resultingClientId }) {
      if (ticket === null || clientId !== "" || resultingClientId === "") return false;
      for (const session of sessions.values()) {
        expire(session.tickets);
        if (!session.tickets.delete(ticket)) continue;
        if (!(await isLive(session))) return false;
        expire(session.entries);
        if (session.entries.size >= BINDING_LIMITS.maxTicketsPerSession) return false;
        session.entries.set(resultingClientId, now() + config.ticketTtlMs);
        return true;
      }
      return false;
    },

    async routeNavigation({ clientId, resultingClientId }) {
      if (resultingClientId === "") return refused("client_not_admitted");
      // An empty clientId is a new frame: only the entry reserved by a ticket in this same
      // navigation may continue. A known clientId is the document this frame is replacing.
      const session = clientId === "" ? takeEntry(resultingClientId) : await knownOwner(clientId);
      if (session === null) return refused("client_not_admitted");
      return routeTo(session, resultingClientId);
    },

    async routeSubresource(clientId) {
      const client = clientId === "" ? undefined : await clients.get(clientId);
      if (!isAppDocument(client)) return refused("foreign_client");
      const session = await knownOwner(clientId);
      if (session === null) return refused("client_not_admitted");
      return routeTo(session, clientId);
    },
  };
}
