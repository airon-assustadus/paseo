import { afterEach, describe, expect, it, vi } from "vitest";
import { PURGE_WORKER_BUDGET_MS } from "../bridge-messages";
import {
  BINDING_LIMITS,
  PURGE_SW_MAX_OPS,
  createClientBinding,
  type BindingConfig,
  type BindingRoute,
  type ClientBinding,
  type ShellClient,
  type ShellPurgeHost,
  type ShellPurgeRequest,
} from "./client-binding.web";

const ORIGIN = "https://wp-a.example";
const CONFIG: BindingConfig = {
  origin: ORIGIN,
  bootstrapPath: "/__paseo/bootstrap.html",
  shellPathPrefix: "/__paseo/",
  mountPath: "/",
  ticketTtlMs: 5000,
  formationTtlMs: 5000,
  // Longer than vi.waitFor's polling interval, so a test can answer in time.
  resyncTimeoutMs: 500,
};
const TICKET_A = "AAAAAAAAAAAAAAAAAAAAAA";
const TICKET_B = "BBBBBBBBBBBBBBBBBBBBBB";
const TICKET_C = "CCCCCCCCCCCCCCCCCCCCCC";

interface Delivery {
  message: unknown;
  ports: MessagePort[];
}

interface FakeClient extends ShellClient {
  inbox: Delivery[];
}

interface Session {
  port: MessagePort;
  inbox: unknown[];
}

const openPorts: MessagePort[] = [];

afterEach(() => {
  for (const port of openPorts.splice(0)) port.close();
});

interface FakeDeletion {
  name: string;
  succeed(): void;
}

interface FakePurgeHost extends ShellPurgeHost {
  // One execution enumerates the caches once.
  executions(): number;
  deletions: FakeDeletion[];
}

// An origin with the given databases; each deletion stays pending (as "blocked" does) until the
// test settles its request.
function createPurgeHost(
  input: {
    databases?: string[];
    failCaches?: boolean;
    failDatabases?: boolean;
    unregister?: () => Promise<boolean>;
  } = {},
): FakePurgeHost {
  let executions = 0;
  const deletions: FakeDeletion[] = [];
  return {
    executions: () => executions,
    deletions,
    caches: {
      keys: async () => {
        executions += 1;
        if (input.failCaches === true) throw new Error("caches unavailable");
        return ["page-cache"];
      },
      delete: async () => true,
    },
    indexedDB: {
      databases: async () => {
        if (input.failDatabases === true) throw new Error("indexedDB unavailable");
        return (input.databases ?? []).map((name) => ({ name }));
      },
      deleteDatabase: (name) => {
        const successes: Array<() => void> = [];
        const request: ShellPurgeRequest = {
          addEventListener: (type, listener) => {
            if (type === "success") successes.push(listener);
          },
        };
        deletions.push({ name, succeed: () => successes.forEach((listener) => listener()) });
        return request;
      },
    },
    unregister: input.unregister ?? (async () => true),
  };
}

function waitUntilIgnored(): void {}

function createEnvironment(purgeHost: ShellPurgeHost = createPurgeHost()) {
  const all = new Map<string, FakeClient>();
  const clock = { now: 1_000_000 };
  function add(id: string, path: string, frameType = "nested"): FakeClient {
    const inbox: Delivery[] = [];
    const client: FakeClient = {
      id,
      url: `${ORIGIN}${path}`,
      frameType,
      inbox,
      postMessage(message, transfer) {
        const ports = transfer.filter((item): item is MessagePort => item instanceof MessagePort);
        openPorts.push(...ports);
        inbox.push({ message, ports });
      },
    };
    all.set(id, client);
    return client;
  }
  const binding = createClientBinding({
    config: CONFIG,
    clients: {
      get: (id) => Promise.resolve(all.get(id)),
      matchAll: () => Promise.resolve([...all.values()]),
    },
    purgeHost,
    now: () => clock.now,
  });
  return { all, clock, add, binding };
}

function typeOf(message: unknown): unknown {
  return typeof message === "object" && message !== null && "type" in message ? message.type : null;
}

async function open(binding: ClientBinding, bootstrapId: string): Promise<Session> {
  const channel = new MessageChannel();
  openPorts.push(channel.port1);
  const inbox: unknown[] = [];
  channel.port1.addEventListener("message", (event) => inbox.push(event.data));
  channel.port1.start();
  binding.handleMessage({
    data: { type: "paseo.shell.session.open" },
    sourceId: bootstrapId,
    ports: [channel.port2],
    waitUntil: waitUntilIgnored,
  });
  await vi.waitFor(() => expect(inbox.length).toBeGreaterThan(0));
  return { port: channel.port1, inbox };
}

async function prepare(session: Session, ticket: string): Promise<unknown> {
  const before = session.inbox.length;
  session.port.postMessage({ type: "paseo.shell.ticket.prepare", ticket }, []);
  await vi.waitFor(() =>
    expect(
      session.inbox.slice(before).filter((m) => typeOf(m) !== "paseo.shell.admitted"),
    ).toHaveLength(1),
  );
  return session.inbox.slice(before).find((m) => typeOf(m) !== "paseo.shell.admitted");
}

// Opens a session for `bootstrapId` and lets `clientId` in through a ticket, as a real entry.
async function enterApp(input: {
  env: ReturnType<typeof createEnvironment>;
  bootstrapId: string;
  clientId: string;
  ticket: string;
}): Promise<{ session: Session; route: BindingRoute }> {
  const { env } = input;
  env.add(input.bootstrapId, CONFIG.bootstrapPath);
  const session = await open(env.binding, input.bootstrapId);
  await prepare(session, input.ticket);
  const entered = await env.binding.enter({
    ticket: input.ticket,
    clientId: "",
    resultingClientId: input.clientId,
  });
  expect(entered).toBe(true);
  const route = await env.binding.routeNavigation({
    clientId: "",
    resultingClientId: input.clientId,
  });
  env.add(input.clientId, "/");
  return { session, route };
}

function routedTo(route: BindingRoute): MessagePort | null {
  return route.kind === "route" ? route.port : null;
}

describe("session.open", () => {
  it.each([
    ["a top-level client", "top-level", "/__paseo/bootstrap.html"],
    ["another path", "nested", "/__paseo/other.html"],
  ])("refuses %s as a bootstrap", async (_label, frameType, path) => {
    const env = createEnvironment();
    env.add("b1", path, frameType);
    const session = await open(env.binding, "b1");
    expect(session.inbox).toEqual([{ type: "paseo.shell.refused", reason: "bad_source" }]);
  });

  it("refuses an unknown source and a client of another origin", async () => {
    const env = createEnvironment();
    const foreign = env.add("b1", CONFIG.bootstrapPath);
    foreign.url = `https://wp-b.example${CONFIG.bootstrapPath}`;
    expect((await open(env.binding, "b1")).inbox).toEqual([
      { type: "paseo.shell.refused", reason: "bad_source" },
    ]);
    expect((await open(env.binding, "missing")).inbox).toEqual([
      { type: "paseo.shell.refused", reason: "bad_source" },
    ]);
  });

  it("refuses a second session for the same bootstrap and a fifth session", async () => {
    const env = createEnvironment();
    for (const id of ["b1", "b2", "b3", "b4", "b5"]) env.add(id, CONFIG.bootstrapPath);
    expect((await open(env.binding, "b1")).inbox).toEqual([{ type: "paseo.shell.session.ready" }]);
    expect((await open(env.binding, "b1")).inbox).toEqual([
      { type: "paseo.shell.refused", reason: "duplicate_session" },
    ]);
    for (const id of ["b2", "b3", "b4"]) await open(env.binding, id);
    expect((await open(env.binding, "b5")).inbox).toEqual([
      { type: "paseo.shell.refused", reason: "session_limit" },
    ]);

    // A bootstrap that disappeared frees its slot.
    env.all.delete("b2");
    expect((await open(env.binding, "b5")).inbox).toEqual([{ type: "paseo.shell.session.ready" }]);
  });

  it("never reopens a session its bootstrap closed", async () => {
    const env = createEnvironment();
    env.add("b1", CONFIG.bootstrapPath);
    const session = await open(env.binding, "b1");
    session.port.postMessage({ type: "paseo.shell.session.close" }, []);
    await vi.waitFor(async () =>
      expect((await open(env.binding, "b1")).inbox).toEqual([
        { type: "paseo.shell.refused", reason: "session_closed" },
      ]),
    );
  });
});

describe("entry", () => {
  it("routes only the navigation reserved by a ticket, even with one live session", async () => {
    const env = createEnvironment();
    const { session, route } = await enterApp({
      env,
      bootstrapId: "b1",
      clientId: "app-1",
      ticket: TICKET_A,
    });
    expect(routedTo(route)).not.toBeNull();
    await vi.waitFor(() =>
      expect(session.inbox.at(-1)).toEqual({ type: "paseo.shell.admitted", clientIds: ["app-1"] }),
    );

    // A new frame nobody reserved: the single live session confers no authority.
    expect(
      await env.binding.routeNavigation({ clientId: "", resultingClientId: "intruder" }),
    ).toEqual({
      kind: "refused",
      code: "client_not_admitted",
    });
    // The reservation was used by its hop and cannot serve a second one.
    expect(await env.binding.routeNavigation({ clientId: "", resultingClientId: "app-1" })).toEqual(
      {
        kind: "refused",
        code: "client_not_admitted",
      },
    );
  });

  it("rejects unknown, reused and expired tickets and entries that already have a client", async () => {
    const env = createEnvironment();
    env.add("b1", CONFIG.bootstrapPath);
    const session = await open(env.binding, "b1");
    await prepare(session, TICKET_A);
    const enter = (ticket: string | null, clientId = "") =>
      env.binding.enter({ ticket, clientId, resultingClientId: "app-1" });
    expect(await enter(null)).toBe(false);
    expect(await enter(TICKET_B)).toBe(false);
    expect(await enter(TICKET_A, "someone")).toBe(false);
    await prepare(session, TICKET_B);
    expect(await enter(TICKET_B)).toBe(true);
    expect(await enter(TICKET_B)).toBe(false);

    await prepare(session, TICKET_C);
    env.clock.now += CONFIG.ticketTtlMs;
    expect(await enter(TICKET_C)).toBe(false);
  });

  it("caps pending tickets per session", async () => {
    const env = createEnvironment();
    env.add("b1", CONFIG.bootstrapPath);
    const session = await open(env.binding, "b1");
    expect(await prepare(session, TICKET_A)).toEqual({
      type: "paseo.shell.ticket.ready",
      ticket: TICKET_A,
    });
    await prepare(session, TICKET_B);
    expect(await prepare(session, TICKET_C)).toEqual({
      type: "paseo.shell.refused",
      reason: "ticket_limit",
    });
  });

  it("refuses the next hop when the reservation expires between hops", async () => {
    const env = createEnvironment();
    env.add("b1", CONFIG.bootstrapPath);
    const session = await open(env.binding, "b1");
    await prepare(session, TICKET_A);
    await env.binding.enter({ ticket: TICKET_A, clientId: "", resultingClientId: "app-1" });
    env.clock.now += CONFIG.ticketTtlMs;
    expect(await env.binding.routeNavigation({ clientId: "", resultingClientId: "app-1" })).toEqual(
      {
        kind: "refused",
        code: "client_not_admitted",
      },
    );
  });

  it("refuses the next hop when the session is revoked between hops", async () => {
    const env = createEnvironment();
    env.add("b1", CONFIG.bootstrapPath);
    env.add("b2", CONFIG.bootstrapPath);
    const closing = await open(env.binding, "b1");
    const vanishing = await open(env.binding, "b2");
    await prepare(closing, TICKET_A);
    await prepare(vanishing, TICKET_B);
    await env.binding.enter({ ticket: TICKET_A, clientId: "", resultingClientId: "app-1" });
    await env.binding.enter({ ticket: TICKET_B, clientId: "", resultingClientId: "app-2" });

    // The worker closes the session port once it has dropped the session.
    const dropped = new Promise((resolve) => closing.port.addEventListener("close", resolve));
    closing.port.postMessage({ type: "paseo.shell.session.close" }, []);
    await dropped;
    expect(await env.binding.routeNavigation({ clientId: "", resultingClientId: "app-1" })).toEqual(
      {
        kind: "refused",
        code: "client_not_admitted",
      },
    );
    env.all.delete("b2");
    expect(await env.binding.routeNavigation({ clientId: "", resultingClientId: "app-2" })).toEqual(
      {
        kind: "refused",
        code: "session_unavailable",
      },
    );
  });
});

describe("routing", () => {
  it("keeps a frame in its session across navigations and refuses unknown documents", async () => {
    const env = createEnvironment();
    const { route } = await enterApp({
      env,
      bootstrapId: "b1",
      clientId: "app-1",
      ticket: TICKET_A,
    });
    const next = await env.binding.routeNavigation({
      clientId: "app-1",
      resultingClientId: "app-2",
    });
    expect(routedTo(next)).toBe(routedTo(route));
    expect(
      await env.binding.routeNavigation({ clientId: "stranger", resultingClientId: "x" }),
    ).toEqual({
      kind: "refused",
      code: "client_not_admitted",
    });
  });

  it("sends each view's requests to its own bootstrap", async () => {
    const env = createEnvironment();
    const one = await enterApp({ env, bootstrapId: "b1", clientId: "app-1", ticket: TICKET_A });
    const two = await enterApp({ env, bootstrapId: "b2", clientId: "app-2", ticket: TICKET_B });
    expect(routedTo(await env.binding.routeSubresource("app-1"))).toBe(routedTo(one.route));
    expect(routedTo(await env.binding.routeSubresource("app-2"))).toBe(routedTo(two.route));
    expect(routedTo(one.route)).not.toBe(routedTo(two.route));
  });

  it("refuses subresources of top-level, shell and unknown clients", async () => {
    const env = createEnvironment();
    await enterApp({ env, bootstrapId: "b1", clientId: "app-1", ticket: TICKET_A });
    env.add("tab", "/", "top-level");
    env.add("app-2", "/");
    expect(await env.binding.routeSubresource("tab")).toEqual({
      kind: "refused",
      code: "foreign_client",
    });
    expect(await env.binding.routeSubresource("b1")).toEqual({
      kind: "refused",
      code: "foreign_client",
    });
    expect(await env.binding.routeSubresource("")).toEqual({
      kind: "refused",
      code: "foreign_client",
    });
    expect(await env.binding.routeSubresource("app-2")).toEqual({
      kind: "refused",
      code: "client_not_admitted",
    });
  });

  it("answers session_unavailable once the bootstrap is gone", async () => {
    const env = createEnvironment();
    await enterApp({ env, bootstrapId: "b1", clientId: "app-1", ticket: TICKET_A });
    env.all.delete("b1");
    expect(await env.binding.routeSubresource("app-1")).toEqual({
      kind: "refused",
      code: "session_unavailable",
    });
  });
});

describe("admission quota", () => {
  it("drops dead documents before the quota, keeps those still forming, and refuses above it", async () => {
    const env = createEnvironment();
    const { session } = await enterApp({
      env,
      bootstrapId: "b1",
      clientId: "doc-0",
      ticket: TICKET_A,
    });
    let previous = "doc-0";
    // A long run of navigations in one frame: each replaced document disappears.
    for (let index = 1; index < 3 * BINDING_LIMITS.maxClientsPerSession; index += 1) {
      const next = `doc-${index}`;
      env.clock.now += CONFIG.formationTtlMs;
      const route = await env.binding.routeNavigation({
        clientId: previous,
        resultingClientId: next,
      });
      expect(route.kind).toBe("route");
      env.all.delete(previous);
      env.add(next, "/");
      previous = next;
    }
    const last = 3 * BINDING_LIMITS.maxClientsPerSession - 1;
    await vi.waitFor(() =>
      expect(session.inbox.at(-1)).toEqual({
        type: "paseo.shell.admitted",
        clientIds: [`doc-${last - 1}`, `doc-${last}`],
      }),
    );

    // Documents that are alive, or not created yet, keep their slots; the quota then holds.
    for (let index = 1; index < BINDING_LIMITS.maxClientsPerSession; index += 1) {
      const route = await env.binding.routeNavigation({
        clientId: previous,
        resultingClientId: `forming-${index}`,
      });
      expect(route.kind).toBe("route");
    }
    expect(
      await env.binding.routeNavigation({ clientId: previous, resultingClientId: "late" }),
    ).toEqual({
      kind: "refused",
      code: "client_limit",
    });
  });
});

describe("resync after a worker restart", () => {
  function answerResync(
    client: FakeClient,
    admitted: string[],
  ): { port: MessagePort; received: unknown[] } {
    const delivery = client.inbox.find((entry) => typeOf(entry.message) === "paseo.shell.resync");
    const port = delivery?.ports[0];
    if (port === undefined) throw new Error("no resync request");
    const received: unknown[] = [];
    port.addEventListener("message", (event) => received.push(event.data));
    port.start();
    port.postMessage({ type: "paseo.shell.resync.reply", admitted });
    return { port, received };
  }

  it("rebuilds routes from the live bootstraps' copies", async () => {
    const env = createEnvironment();
    const bootstrap = env.add("b1", CONFIG.bootstrapPath);
    env.add("app-1", "/");
    env.add("tab", "/", "top-level");
    const pending = env.binding.routeSubresource("app-1");
    await vi.waitFor(() => expect(bootstrap.inbox).toHaveLength(1));
    const { received } = answerResync(bootstrap, ["app-1", "tab", "gone"]);
    const route = await pending;
    expect(route.kind).toBe("route");
    // Only an existing nested app document is restored.
    expect(await env.binding.routeSubresource("tab")).toEqual({
      kind: "refused",
      code: "foreign_client",
    });
    await vi.waitFor(() =>
      expect(received).toContainEqual({ type: "paseo.shell.admitted", clientIds: ["app-1"] }),
    );
  });

  it("gives no owner to an id two bootstraps claim, and ignores late answers", async () => {
    const env = createEnvironment();
    const first = env.add("b1", CONFIG.bootstrapPath);
    const second = env.add("b2", CONFIG.bootstrapPath);
    const late = env.add("b3", CONFIG.bootstrapPath);
    env.add("app-1", "/");
    const pending = env.binding.routeSubresource("app-1");
    await vi.waitFor(() => expect(late.inbox).toHaveLength(1));
    answerResync(first, ["app-1"]);
    answerResync(second, ["app-1"]);
    expect(await pending).toEqual({ kind: "refused", code: "client_not_admitted" });
    answerResync(late, ["app-1"]);
    env.clock.now += BINDING_LIMITS.minResyncIntervalMs;
    expect(await env.binding.routeSubresource("app-1")).toEqual({
      kind: "refused",
      code: "client_not_admitted",
    });
  });

  it("asks at most four candidates and at most once per interval", async () => {
    const env = createEnvironment();
    const bootstraps = ["b1", "b2", "b3", "b4", "b5", "b6"].map((id) =>
      env.add(id, CONFIG.bootstrapPath),
    );
    expect(await env.binding.routeSubresource("nobody")).toEqual({
      kind: "refused",
      code: "foreign_client",
    });
    env.add("app-1", "/");
    await env.binding.routeSubresource("app-1");
    await env.binding.routeSubresource("app-1");
    const asked = bootstraps.filter((client) => client.inbox.length > 0);
    expect(asked).toHaveLength(BINDING_LIMITS.maxResyncCandidates);
    expect(asked.every((client) => client.inbox.length === 1)).toBe(true);
  });

  it("drops a session whose bootstrap answers twice on its port", async () => {
    const env = createEnvironment();
    const bootstrap = env.add("b1", CONFIG.bootstrapPath);
    env.add("app-1", "/");
    const pending = env.binding.routeSubresource("app-1");
    await vi.waitFor(() => expect(bootstrap.inbox).toHaveLength(1));
    const { port } = answerResync(bootstrap, ["app-1"]);
    expect((await pending).kind).toBe("route");
    port.postMessage({ type: "paseo.shell.resync.reply", admitted: ["app-1"] });
    await vi.waitFor(async () =>
      expect(await env.binding.routeSubresource("app-1")).toEqual({
        kind: "refused",
        code: "client_not_admitted",
      }),
    );
  });
});

describe("lifecycle arm", () => {
  const NONCE = "NNNNNNNNNNNNNNNNNNNNNN";
  const ARM = { type: "paseo.shell.lifecycle.arm", v: 1, nonce: NONCE };

  function sendArm(input: {
    binding: ClientBinding;
    sourceId: string;
    data?: unknown;
    extraPort?: boolean;
  }): unknown[] {
    const channel = new MessageChannel();
    openPorts.push(channel.port1);
    const replies: unknown[] = [];
    channel.port1.addEventListener("message", (event) => replies.push(event.data));
    channel.port1.start();
    const ports = [channel.port2];
    if (input.extraPort === true) ports.push(new MessageChannel().port1);
    input.binding.handleMessage({
      data: input.data ?? ARM,
      sourceId: input.sourceId,
      ports,
      waitUntil: waitUntilIgnored,
    });
    return replies;
  }

  function armedReply(armed: boolean) {
    return { type: "paseo.shell.lifecycle.armed", v: 1, nonce: NONCE, armed };
  }

  function armedOf(route: BindingRoute): boolean | null {
    return route.kind === "route" ? route.armed : null;
  }

  function hasResync(client: FakeClient): boolean {
    return client.inbox.some((entry) => typeOf(entry.message) === "paseo.shell.resync");
  }

  function answerResync(client: FakeClient, admitted: string[]): void {
    const delivery = client.inbox.findLast(
      (entry) => typeOf(entry.message) === "paseo.shell.resync",
    );
    const port = delivery?.ports[0];
    if (port === undefined) throw new Error("no resync request");
    port.postMessage({ type: "paseo.shell.resync.reply", admitted });
  }

  it("arms only the sender's session, without a word on the session port", async () => {
    const env = createEnvironment();
    const first = await enterApp({ env, bootstrapId: "b1", clientId: "app-1", ticket: TICKET_A });
    await enterApp({ env, bootstrapId: "b2", clientId: "app-2", ticket: TICKET_B });
    expect(armedOf(first.route)).toBe(false);
    const before = [...first.session.inbox];

    const replies = sendArm({ binding: env.binding, sourceId: "b1" });
    await vi.waitFor(() => expect(replies).toEqual([armedReply(true)]));

    expect(armedOf(await env.binding.routeSubresource("app-1"))).toBe(true);
    expect(armedOf(await env.binding.routeSubresource("app-2"))).toBe(false);
    expect(first.session.inbox).toEqual(before);
  });

  it("answers false to a bootstrap without a session", async () => {
    const env = createEnvironment();
    env.add("b1", CONFIG.bootstrapPath);
    const replies = sendArm({ binding: env.binding, sourceId: "b1" });
    await vi.waitFor(() => expect(replies).toEqual([armedReply(false)]));
  });

  it("waits for the resync in flight, so the adopted session is the one armed", async () => {
    const env = createEnvironment();
    const bootstrap = env.add("b1", CONFIG.bootstrapPath);
    env.add("app-1", "/");
    const pending = env.binding.routeSubresource("app-1");
    await vi.waitFor(() => expect(bootstrap.inbox).toHaveLength(1));
    const replies = sendArm({ binding: env.binding, sourceId: "b1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replies).toEqual([]);

    answerResync(bootstrap, ["app-1"]);
    expect((await pending).kind).toBe("route");
    await vi.waitFor(() => expect(replies).toEqual([armedReply(true)]));
    expect(armedOf(await env.binding.routeSubresource("app-1"))).toBe(true);
  });

  it("binds a restarted worker without the arm", async () => {
    const env = createEnvironment();
    await enterApp({ env, bootstrapId: "b1", clientId: "app-1", ticket: TICKET_A });
    const replies = sendArm({ binding: env.binding, sourceId: "b1" });
    await vi.waitFor(() => expect(replies).toEqual([armedReply(true)]));

    const restarted = createClientBinding({
      config: CONFIG,
      clients: {
        get: (id) => Promise.resolve(env.all.get(id)),
        matchAll: () => Promise.resolve([...env.all.values()]),
      },
      purgeHost: createPurgeHost(),
      now: () => env.clock.now,
    });
    const bootstrap = env.all.get("b1");
    if (bootstrap === undefined) throw new Error("bootstrap missing");
    const pending = restarted.routeSubresource("app-1");
    await vi.waitFor(() => expect(hasResync(bootstrap)).toBe(true));
    answerResync(bootstrap, ["app-1"]);
    expect(armedOf(await pending)).toBe(false);
  });

  it.each([
    ["another version", { ...ARM, v: 2 }, false],
    ["a short nonce", { ...ARM, nonce: "abc" }, false],
    ["an extra key", { ...ARM, armed: true }, false],
    ["an unknown message", { type: "paseo.shell.unknown" }, false],
    ["two ports", ARM, true],
  ])("ignores %s on the worker's message event", async (_label, data, extraPort) => {
    const env = createEnvironment();
    await enterApp({ env, bootstrapId: "b1", clientId: "app-1", ticket: TICKET_A });
    const replies = sendArm({ binding: env.binding, sourceId: "b1", data, extraPort });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replies).toEqual([]);
    const route = await env.binding.routeSubresource("app-1");
    expect(route.kind).toBe("route");
    expect(armedOf(route)).toBe(false);
  });
});

describe("authoritative purge in the worker", () => {
  // Canonical base64url of 16 bytes: 21 characters and a last one in [AQgw].
  function op(index: number): string {
    return `${index.toString(36).padStart(21, "x")}A`;
  }

  function purgedOf(result: { caches: boolean; indexedDB: boolean; unregistered: boolean }) {
    return (value: string) => ({ type: "paseo.shell.purged", v: 1, op: value, ...result });
  }

  const ALL_CONFIRMED = purgedOf({ caches: true, indexedDB: true, unregistered: true });
  const NONE_CONFIRMED = purgedOf({ caches: false, indexedDB: false, unregistered: false });

  function sendPurge(input: { binding: ClientBinding; sourceId: string; op: string }) {
    const channel = new MessageChannel();
    openPorts.push(channel.port1);
    const replies: unknown[] = [];
    channel.port1.addEventListener("message", (event) => replies.push(event.data));
    channel.port1.start();
    const waited: Array<Promise<unknown>> = [];
    input.binding.handleMessage({
      data: { type: "paseo.shell.purge", v: 1, op: input.op },
      sourceId: input.sourceId,
      ports: [channel.port2],
      waitUntil: (promise) => waited.push(promise),
    });
    return { replies, waited };
  }

  function bootstraps(host: FakePurgeHost, ids: string[]) {
    const env = createEnvironment(host);
    for (const id of ids) env.add(id, CONFIG.bootstrapPath);
    return env;
  }

  async function silence(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  function settleDeletions(host: FakePurgeHost): void {
    for (const deletion of host.deletions) deletion.succeed();
  }

  it("calls waitUntil during the dispatch with a promise bounded by the budget", async () => {
    const host = createPurgeHost({ databases: ["page-db"] });
    const env = bootstraps(host, ["b1"]);
    const started = performance.now();
    const { waited, replies } = sendPurge({ binding: env.binding, sourceId: "b1", op: op(1) });
    expect(waited).toHaveLength(1);
    await waited[0];
    expect(performance.now() - started).toBeGreaterThanOrEqual(PURGE_WORKER_BUDGET_MS - 50);
    expect(replies).toEqual([]);
  });

  it("keeps a blocked deletion pending and confirms only after it succeeds", async () => {
    const host = createPurgeHost({ databases: ["page-db"] });
    const env = bootstraps(host, ["b1"]);
    const { replies } = sendPurge({ binding: env.binding, sourceId: "b1", op: op(1) });
    await vi.waitFor(() => expect(host.deletions).toHaveLength(1));
    await silence();
    expect(replies).toEqual([]);
    settleDeletions(host);
    await vi.waitFor(() => expect(replies).toEqual([ALL_CONFIRMED(op(1))]));
  });

  it("shares one execution among every bootstrap that asks with the same op", async () => {
    const host = createPurgeHost({ databases: ["page-db"] });
    const env = bootstraps(host, ["b1", "b2"]);
    const first = sendPurge({ binding: env.binding, sourceId: "b1", op: op(1) });
    const second = sendPurge({ binding: env.binding, sourceId: "b2", op: op(1) });
    await vi.waitFor(() => expect(host.deletions).toHaveLength(1));
    settleDeletions(host);
    await vi.waitFor(() => expect(second.replies).toEqual([ALL_CONFIRMED(op(1))]));
    expect(first.replies).toEqual([ALL_CONFIRMED(op(1))]);
    expect(host.executions()).toBe(1);
  });

  it("starts a different op only after the previous execution really finished", async () => {
    const host = createPurgeHost({ databases: ["page-db"] });
    const env = bootstraps(host, ["b1"]);
    const first = sendPurge({ binding: env.binding, sourceId: "b1", op: op(1) });
    const second = sendPurge({ binding: env.binding, sourceId: "b1", op: op(2) });
    await vi.waitFor(() => expect(host.deletions).toHaveLength(1));
    await silence();
    expect(host.executions()).toBe(1);
    settleDeletions(host);
    await vi.waitFor(() => expect(first.replies).toEqual([ALL_CONFIRMED(op(1))]));
    await vi.waitFor(() => expect(host.deletions).toHaveLength(2));
    expect(host.executions()).toBe(2);
    expect(second.replies).toEqual([]);
    settleDeletions(host);
    await vi.waitFor(() => expect(second.replies).toEqual([ALL_CONFIRMED(op(2))]));
  });

  it("reports nothing while one task is stuck, even though the others finished", async () => {
    const unregistered = { calls: 0 };
    const host = createPurgeHost({
      databases: ["page-db"],
      unregister: async () => {
        unregistered.calls += 1;
        return true;
      },
    });
    const env = bootstraps(host, ["b1"]);
    const { replies } = sendPurge({ binding: env.binding, sourceId: "b1", op: op(1) });
    await vi.waitFor(() => expect(unregistered.calls).toBe(1));
    await silence();
    expect(replies).toEqual([]);
  });

  it("turns a failing task into false for that field only, never into true", async () => {
    const host = createPurgeHost({
      failCaches: true,
      failDatabases: true,
      unregister: async () => {
        throw new Error("unregister failed");
      },
    });
    const env = bootstraps(host, ["b1"]);
    const { replies } = sendPurge({ binding: env.binding, sourceId: "b1", op: op(1) });
    await vi.waitFor(() => expect(replies).toEqual([NONE_CONFIRMED(op(1))]));

    const partial = createPurgeHost({ unregister: async () => false });
    const second = bootstraps(partial, ["b1"]);
    const answer = sendPurge({ binding: second.binding, sourceId: "b1", op: op(2) });
    const expected = purgedOf({ caches: true, indexedDB: true, unregistered: false });
    await vi.waitFor(() => expect(answer.replies).toEqual([expected(op(2))]));
  });

  it("refuses a new op once 16 accepted ops are pending, without running or queuing it", async () => {
    const host = createPurgeHost({ databases: ["page-db"] });
    const env = bootstraps(host, ["b1"]);
    const accepted = Array.from({ length: PURGE_SW_MAX_OPS }, (_, index) =>
      sendPurge({ binding: env.binding, sourceId: "b1", op: op(index + 1) }),
    );
    const refused = sendPurge({ binding: env.binding, sourceId: "b1", op: op(17) });
    await vi.waitFor(() => expect(refused.replies).toEqual([NONE_CONFIRMED(op(17))]));
    for (let done = 1; done <= PURGE_SW_MAX_OPS; done += 1) {
      await vi.waitFor(() => expect(host.deletions).toHaveLength(done));
      settleDeletions(host);
    }
    await vi.waitFor(() => expect(accepted.at(-1)?.replies).toHaveLength(1));
    expect(host.executions()).toBe(PURGE_SW_MAX_OPS);
    const again = sendPurge({ binding: env.binding, sourceId: "b1", op: op(17) });
    await vi.waitFor(() => expect(again.replies).toEqual([NONE_CONFIRMED(op(17))]));
    expect(host.executions()).toBe(PURGE_SW_MAX_OPS);
  });

  it("keeps resolved ops too: a 17th is refused and an old duplicate reuses its result", async () => {
    const host = createPurgeHost();
    const env = bootstraps(host, ["b1"]);
    for (let index = 1; index <= PURGE_SW_MAX_OPS; index += 1) {
      const { replies } = sendPurge({ binding: env.binding, sourceId: "b1", op: op(index) });
      await vi.waitFor(() => expect(replies).toEqual([ALL_CONFIRMED(op(index))]));
    }
    const refused = sendPurge({ binding: env.binding, sourceId: "b1", op: op(17) });
    await vi.waitFor(() => expect(refused.replies).toEqual([NONE_CONFIRMED(op(17))]));
    const duplicate = sendPurge({ binding: env.binding, sourceId: "b1", op: op(1) });
    await vi.waitFor(() => expect(duplicate.replies).toEqual([ALL_CONFIRMED(op(1))]));
    expect(host.executions()).toBe(PURGE_SW_MAX_OPS);
  });

  it("answers only bootstraps, with or without a session", async () => {
    const host = createPurgeHost();
    const env = createEnvironment(host);
    env.add("app-1", "/");
    env.add("b9", CONFIG.bootstrapPath);
    const fromPage = sendPurge({ binding: env.binding, sourceId: "app-1", op: op(1) });
    expect(fromPage.waited).toHaveLength(1);
    await silence();
    expect(fromPage.replies).toEqual([]);
    expect(host.executions()).toBe(0);
    const sessionless = sendPurge({ binding: env.binding, sourceId: "b9", op: op(2) });
    await vi.waitFor(() => expect(sessionless.replies).toEqual([ALL_CONFIRMED(op(2))]));
  });

  it("drops every session before purging", async () => {
    const env = createEnvironment(createPurgeHost());
    await enterApp({ env, bootstrapId: "b1", clientId: "app-1", ticket: TICKET_A });
    const { replies } = sendPurge({ binding: env.binding, sourceId: "b1", op: op(1) });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect((await env.binding.routeSubresource("app-1")).kind).toBe("refused");
  });
});
