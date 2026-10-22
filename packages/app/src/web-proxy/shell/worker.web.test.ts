import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlMessage } from "../bridge-messages";
import type { ShellClient, ShellPurgeHost } from "./client-binding.web";
import { readShellFetchFields } from "./relay-messages";
import {
  createShellWorker,
  InvalidShellWorkerConfigError,
  ShellBridgeTimeoutError,
  type ShellFetchDecision,
  type ShellWorker,
  type ShellWorkerConfig,
} from "./worker.web";

const ORIGIN = "https://wp-a.example";
const CONFIG: ShellWorkerConfig = {
  controlOrigin: "https://app.example",
  shellPathPrefix: "/__paseo/",
  bootstrapPath: "/__paseo/bootstrap.html",
  enterPath: "/__paseo/enter",
  mountPath: "/",
  headTimeoutMs: 1000,
  idleChunkTimeoutMs: 1000,
  maxRequestBodyBytes: 8,
  ticketTtlMs: 5000,
  formationTtlMs: 5000,
  // Longer than vi.waitFor's polling interval, so a test can answer in time.
  resyncTimeoutMs: 500,
};
const TICKET = "TTTTTTTTTTTTTTTTTTTTTT";

interface ForwardedFetch {
  request: Record<string, unknown> | null;
  port: MessagePort;
  fromWorker: unknown[];
}

interface Harness {
  worker: ShellWorker;
  clients: Map<string, ShellClient>;
  forwarded: ForwardedFetch[];
}

const openPorts: MessagePort[] = [];

afterEach(() => {
  for (const port of openPorts.splice(0)) port.close();
});

function nestedClient(id: string, path: string): ShellClient {
  return { id, url: `${ORIGIN}${path}`, frameType: "nested", postMessage: () => {} };
}

// Collects the fetches the worker forwards on a session port, as a bootstrap would.
function collectFetches(port: MessagePort, forwarded: ForwardedFetch[], others: unknown[]): void {
  port.addEventListener("message", (event) => {
    const request = readShellFetchFields(event.data);
    const fetchPort = event.ports[0];
    if (request === null || fetchPort === undefined) {
      others.push(event.data);
      return;
    }
    openPorts.push(fetchPort);
    const entry: ForwardedFetch = { request, port: fetchPort, fromWorker: [] };
    fetchPort.addEventListener("message", (portEvent) => entry.fromWorker.push(portEvent.data));
    fetchPort.start();
    forwarded.push(entry);
  });
  port.start();
}

function forwardedAt(
  harness: { forwarded: ForwardedFetch[] },
  index: number,
): Promise<ForwardedFetch> {
  return vi.waitFor(() => {
    const entry = harness.forwarded[index];
    if (entry === undefined) throw new Error(`fetch ${index} not forwarded yet`);
    return entry;
  });
}

function respond(decision: ShellFetchDecision): Promise<Response> {
  if (decision.kind !== "respond") throw new Error("expected the worker to respond");
  return decision.response;
}

// Request() cannot be constructed with mode "navigate"; the worker only reads these fields.
function navigation(url: string, destination: RequestDestination = "iframe"): Request {
  const request = new Request(url);
  Object.defineProperty(request, "mode", { value: "navigate" });
  Object.defineProperty(request, "destination", { value: destination });
  return request;
}

function reply(port: MessagePort, message: ControlMessage): void {
  port.postMessage(message);
}

function head(
  status: number,
  headers: ReadonlyArray<readonly [string, string]> = [],
): ControlMessage {
  return {
    type: "paseo.web.response.head",
    v: 1,
    generation: 1,
    requestId: 1,
    status,
    statusText: "",
    headers: headers.map(([name, value]) => [name, value]),
  };
}

function chunk(text: string): ControlMessage {
  const buffer = new TextEncoder().encode(text).buffer;
  return { type: "paseo.web.response.chunk", v: 1, generation: 1, requestId: 1, chunk: buffer };
}

const END: ControlMessage = { type: "paseo.web.response.end", v: 1, generation: 1, requestId: 1 };

// An origin with nothing stored: every purge task confirms at once.
const EMPTY_ORIGIN: ShellPurgeHost = {
  caches: { keys: async () => [], delete: async () => true },
  indexedDB: {
    databases: async () => [],
    deleteDatabase: () => ({ addEventListener: () => {} }),
  },
  unregister: async () => true,
};

function waitUntilIgnored(): void {}

function createWorker(config: ShellWorkerConfig, clients: Map<string, ShellClient>): ShellWorker {
  return createShellWorker({
    config,
    clients: {
      get: (id) => Promise.resolve(clients.get(id)),
      matchAll: () => Promise.resolve([...clients.values()]),
    },
    purgeHost: EMPTY_ORIGIN,
    origin: ORIGIN,
  });
}

// A bootstrap with an open session, and app-1 let in through a ticket and served once.
async function admittedApp(config: ShellWorkerConfig = CONFIG): Promise<Harness> {
  const clients = new Map<string, ShellClient>();
  clients.set("b1", nestedClient("b1", config.bootstrapPath));
  const worker = createWorker(config, clients);
  const channel = new MessageChannel();
  openPorts.push(channel.port1);
  const forwarded: ForwardedFetch[] = [];
  const others: unknown[] = [];
  collectFetches(channel.port1, forwarded, others);
  worker.message({
    data: { type: "paseo.shell.session.open" },
    sourceId: "b1",
    ports: [channel.port2],
    waitUntil: waitUntilIgnored,
  });
  await vi.waitFor(() => expect(others).toContainEqual({ type: "paseo.shell.session.ready" }));
  channel.port1.postMessage({ type: "paseo.shell.ticket.prepare", ticket: TICKET });
  await vi.waitFor(() =>
    expect(others).toContainEqual({ type: "paseo.shell.ticket.ready", ticket: TICKET }),
  );

  const entry = await respond(
    worker.fetch({
      request: navigation(`${ORIGIN}${config.enterPath}?t=${TICKET}`),
      clientId: "",
      resultingClientId: "app-1",
    }),
  );
  expect(entry.status).toBe(302);
  expect(entry.headers.get("location")).toBe(`${ORIGIN}${config.mountPath}`);
  const document = respond(
    worker.fetch({
      request: navigation(`${ORIGIN}${config.mountPath}`),
      clientId: "",
      resultingClientId: "app-1",
    }),
  );
  const first = await forwardedAt({ forwarded }, 0);
  expect(first.request).toMatchObject({ path: "/", mode: "navigate" });
  reply(first.port, head(200));
  reply(first.port, END);
  await document;
  clients.set("app-1", nestedClient("app-1", config.mountPath));
  return { worker, clients, forwarded };
}

function subresource(harness: Harness, url: string, init?: RequestInit): Promise<Response> {
  return respond(
    harness.worker.fetch({
      request: new Request(url, init),
      clientId: "app-1",
      resultingClientId: "",
    }),
  );
}

describe("createShellWorker routing", () => {
  it("leaves the shell's own assets to the network", () => {
    const worker = createWorker(CONFIG, new Map());
    expect(
      worker.fetch({
        request: new Request(`${ORIGIN}/__paseo/bootstrap.html`),
        clientId: "",
        resultingClientId: "",
      }),
    ).toEqual({ kind: "network" });
  });

  it("answers other origins, paths outside the mount point and top-level documents with a network error", async () => {
    const config = { ...CONFIG, mountPath: "/app/" };
    const worker = createWorker(config, new Map());
    const requests = [
      new Request("http://localhost:6767/api/health"),
      new Request(`${ORIGIN}/other`),
      navigation(`${ORIGIN}/app/`, "document"),
    ];
    for (const request of requests) {
      const response = await respond(
        worker.fetch({ request, clientId: "", resultingClientId: "tab" }),
      );
      expect(response.type).toBe("error");
    }
  });

  it("refuses the entry without a valid ticket", async () => {
    const harness = await admittedApp();
    for (const url of [`${ORIGIN}/__paseo/enter`, `${ORIGIN}/__paseo/enter?t=${TICKET}`]) {
      const response = await respond(
        harness.worker.fetch({
          request: navigation(url),
          clientId: "",
          resultingClientId: "app-9",
        }),
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("x-paseo-web-proxy-error")).toBe("ticket_rejected");
    }
  });

  it("refuses a new frame and an unknown document, with a reason", async () => {
    const harness = await admittedApp();
    harness.clients.set("stranger", nestedClient("stranger", "/x"));
    const fresh = await respond(
      harness.worker.fetch({
        request: navigation(`${ORIGIN}/x`),
        clientId: "",
        resultingClientId: "new",
      }),
    );
    expect(fresh.headers.get("x-paseo-web-proxy-error")).toBe("client_not_admitted");
    const unknown = await respond(
      harness.worker.fetch({
        request: new Request(`${ORIGIN}/x`),
        clientId: "stranger",
        resultingClientId: "",
      }),
    );
    expect(unknown.status).toBe(403);
    expect(unknown.headers.get("x-paseo-web-proxy-error")).toBe("client_not_admitted");
  });
});

describe("createShellWorker responses", () => {
  it("forwards a mounted request and returns credit as the page reads the body", async () => {
    const harness = await admittedApp({ ...CONFIG, mountPath: "/app/" });
    const pending = subresource(harness, `${ORIGIN}/app/api/x?y=1`, {
      method: "POST",
      body: "abc",
    });
    const forwarded = await forwardedAt(harness, 1);
    expect(forwarded.request).toMatchObject({
      method: "POST",
      path: "/api/x?y=1",
      mode: "subresource",
      body: new TextEncoder().encode("abc").buffer,
    });

    reply(forwarded.port, head(200, [["content-type", "text/plain"]]));
    reply(forwarded.port, chunk("he"));
    reply(forwarded.port, chunk("llo"));
    reply(forwarded.port, END);
    expect(await (await pending).text()).toBe("hello");
    await vi.waitFor(() =>
      expect(forwarded.fromWorker).toEqual([
        { type: "paseo.shell.ack", bytes: 2 },
        { type: "paseo.shell.ack", bytes: 3 },
      ]),
    );
  });

  it("adds the shell policy and maps root redirects into the mount point", async () => {
    const harness = await admittedApp({ ...CONFIG, mountPath: "/app/" });
    const pending = subresource(harness, `${ORIGIN}/app/old`, { redirect: "manual" });
    const forwarded = await forwardedAt(harness, 1);
    reply(forwarded.port, head(302, [["location", "/new?x=1"]]));
    reply(forwarded.port, END);
    const response = await pending;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app/new?x=1");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self'; " +
        "form-action 'self'; base-uri 'self'; object-src 'none'; " +
        "frame-ancestors 'self' https://app.example",
    );
    expect(response.headers.get("x-dns-prefetch-control")).toBe("off");
  });

  it("keeps the destination's CSP next to the shell's", async () => {
    const harness = await admittedApp();
    const pending = subresource(harness, `${ORIGIN}/page`);
    const forwarded = await forwardedAt(harness, 1);
    reply(forwarded.port, head(200, [["content-security-policy", "img-src 'none'"]]));
    reply(forwarded.port, END);
    const policy = (await pending).headers.get("content-security-policy");
    expect(policy?.startsWith("img-src 'none', default-src 'self'")).toBe(true);
  });

  it.each([
    ["X-Frame-Options", [["x-frame-options", "SAMEORIGIN"]]],
    [
      "frame-ancestors 'self'",
      [["content-security-policy", "default-src 'self'; frame-ancestors 'self'"]],
    ],
    ["frame-ancestors 'none'", [["content-security-policy", "frame-ancestors 'none'"]]],
  ] as const)(
    "refuses a navigation whose destination forbids framing through %s",
    async (_label, headers) => {
      const harness = await admittedApp();
      // The admitted document navigates its own frame (frame continuity).
      const pending = respond(
        harness.worker.fetch({
          request: navigation(`${ORIGIN}/page`),
          clientId: "app-1",
          resultingClientId: "app-2",
        }),
      );
      const forwarded = await forwardedAt(harness, 1);
      expect(forwarded.request).toMatchObject({ mode: "navigate" });
      reply(forwarded.port, head(200, headers));
      const response = await pending;
      expect(response.status).toBe(502);
      expect(response.headers.get("x-paseo-web-proxy-error")).toBe("embedding_refused");
      await vi.waitFor(() =>
        expect(forwarded.fromWorker).toEqual([{ type: "paseo.shell.cancel" }]),
      );
    },
  );

  it("lets a subresource through with the destination's frame policy untouched", async () => {
    const harness = await admittedApp();
    const pending = subresource(harness, `${ORIGIN}/data.json`);
    const forwarded = await forwardedAt(harness, 1);
    reply(forwarded.port, head(200, [["x-frame-options", "DENY"]]));
    reply(forwarded.port, END);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("answers bridge_timeout and cancels when the bootstrap never answers", async () => {
    const harness = await admittedApp({ ...CONFIG, headTimeoutMs: 20 });
    const response = await subresource(harness, `${ORIGIN}/slow`);
    expect(response.status).toBe(504);
    expect(response.headers.get("x-paseo-web-proxy-error")).toBe("bridge_timeout");
    const forwarded = await forwardedAt(harness, 1);
    await vi.waitFor(() => expect(forwarded.fromWorker).toEqual([{ type: "paseo.shell.cancel" }]));
  });

  it("errors the body and cancels when the bridge goes silent mid-stream", async () => {
    const harness = await admittedApp({ ...CONFIG, idleChunkTimeoutMs: 20 });
    const pending = subresource(harness, `${ORIGIN}/stream`);
    const forwarded = await forwardedAt(harness, 1);
    reply(forwarded.port, head(200));
    const response = await pending;
    await expect(response.text()).rejects.toBeInstanceOf(ShellBridgeTimeoutError);
    await vi.waitFor(() => expect(forwarded.fromWorker).toEqual([{ type: "paseo.shell.cancel" }]));
  });

  it("answers session_revoked when the grant ends before the response", async () => {
    const harness = await admittedApp();
    const pending = subresource(harness, `${ORIGIN}/x`);
    const forwarded = await forwardedAt(harness, 1);
    reply(forwarded.port, { type: "paseo.web.revoke", v: 1, generation: 1, reason: "disposed" });
    const response = await pending;
    expect(response.status).toBe(502);
    expect(response.headers.get("x-paseo-web-proxy-error")).toBe("session_revoked");
  });

  it("passes the broker's error code through", async () => {
    const harness = await admittedApp();
    const pending = subresource(harness, `${ORIGIN}/cross`);
    const forwarded = await forwardedAt(harness, 1);
    reply(forwarded.port, {
      type: "paseo.web.response.error",
      v: 1,
      generation: 1,
      requestId: 1,
      code: "redirect_blocked",
    });
    const response = await pending;
    expect(response.status).toBe(502);
    expect(response.headers.get("x-paseo-web-proxy-error")).toBe("redirect_blocked");
  });

  it("exposes the transport's reason before the head and in the body's error after it", async () => {
    const harness = await admittedApp();
    const early = subresource(harness, `${ORIGIN}/private`);
    const first = await forwardedAt(harness, 1);
    reply(first.port, {
      type: "paseo.web.response.error",
      v: 1,
      generation: 1,
      requestId: 1,
      code: "transport_error",
      reason: "credentials_unsupported",
    });
    const refused = await early;
    expect(refused.status).toBe(502);
    expect(refused.headers.get("x-paseo-web-proxy-error")).toBe("transport_error");
    expect(refused.headers.get("x-paseo-web-proxy-reason")).toBe("credentials_unsupported");

    const late = subresource(harness, `${ORIGIN}/stream`);
    const second = await forwardedAt(harness, 2);
    reply(second.port, head(200));
    const response = await late;
    reply(second.port, {
      type: "paseo.web.response.error",
      v: 1,
      generation: 1,
      requestId: 1,
      code: "transport_error",
      reason: "transport_closed",
    });
    await expect(response.text()).rejects.toMatchObject({
      name: "ShellBridgeClosedError",
      code: "transport_error",
      reason: "transport_closed",
    });
  });

  it("refuses an oversized body without reaching the bootstrap", async () => {
    const harness = await admittedApp();
    const response = await subresource(harness, `${ORIGIN}/upload`, {
      method: "POST",
      body: "123456789",
    });
    expect(response.status).toBe(413);
    expect(harness.forwarded).toHaveLength(1);
  });

  it("answers session_unavailable once the bootstrap is gone", async () => {
    const harness = await admittedApp();
    harness.clients.delete("b1");
    const response = await subresource(harness, `${ORIGIN}/x`);
    expect(response.status).toBe(503);
    expect(response.headers.get("x-paseo-web-proxy-error")).toBe("session_unavailable");
  });
});

describe("a restarted worker", () => {
  it("serves an admitted document again after the bootstrap answers its resync", async () => {
    const before = await admittedApp();
    const resyncPorts: MessagePort[] = [];
    const bootstrap = before.clients.get("b1");
    if (bootstrap === undefined) throw new Error("missing bootstrap");
    before.clients.set("b1", {
      ...bootstrap,
      postMessage: (_message, transfer) => {
        for (const item of transfer) if (item instanceof MessagePort) resyncPorts.push(item);
      },
    });

    // A fresh instance has none of the previous instance's state.
    const harness: Harness = {
      clients: before.clients,
      worker: createWorker(CONFIG, before.clients),
      forwarded: [],
    };
    const pending = subresource(harness, `${ORIGIN}/after-restart`);
    const port = await vi.waitFor(() => {
      const resync = resyncPorts[0];
      if (resync === undefined) throw new Error("no resync yet");
      return resync;
    });
    openPorts.push(port);
    collectFetches(port, harness.forwarded, []);
    port.postMessage({ type: "paseo.shell.resync.reply", admitted: ["app-1"] });
    const forwarded = await forwardedAt(harness, 0);
    expect(forwarded.request).toMatchObject({ path: "/after-restart" });
    reply(forwarded.port, head(200));
    reply(forwarded.port, END);
    expect((await pending).status).toBe(200);
  });
});

describe("configuration", () => {
  it.each([
    ["headTimeoutMs", { headTimeoutMs: 0 }],
    ["idleChunkTimeoutMs", { idleChunkTimeoutMs: Number.NaN }],
    ["maxRequestBodyBytes", { maxRequestBodyBytes: 1.5 }],
    ["ticketTtlMs", { ticketTtlMs: -1 }],
    ["resyncTimeoutMs", { resyncTimeoutMs: Number.POSITIVE_INFINITY }],
    ["mountPath", { mountPath: "/app" }],
    ["shellPathPrefix", { shellPathPrefix: "__paseo/" }],
    ["bootstrapPath", { bootstrapPath: "/elsewhere/bootstrap.html" }],
    ["enterPath", { enterPath: "/__paseo/bootstrap.html" }],
    ["enterPath", { mountPath: "/app/", enterPath: "/other/enter" }],
    ["controlOrigin", { controlOrigin: "https://app.example/" }],
  ] as const)("rejects an invalid %s", (field, override) => {
    expect(() => createWorker({ ...CONFIG, ...override }, new Map())).toThrow(
      new InvalidShellWorkerConfigError(field),
    );
  });
});

describe("createShellWorker lifecycle arm", () => {
  const NONCE = "NNNNNNNNNNNNNNNNNNNNNN";

  async function arm(harness: Harness): Promise<unknown> {
    const channel = new MessageChannel();
    openPorts.push(channel.port1);
    const replies: unknown[] = [];
    channel.port1.addEventListener("message", (event) => replies.push(event.data));
    channel.port1.start();
    harness.worker.message({
      data: { type: "paseo.shell.lifecycle.arm", v: 1, nonce: NONCE },
      sourceId: "b1",
      ports: [channel.port2],
      waitUntil: waitUntilIgnored,
    });
    return vi.waitFor(() => {
      const [first] = replies;
      if (first === undefined) throw new Error("no armed reply yet");
      return first;
    });
  }

  // A navigation of the app frame: the document app-1 is replaced by app-2.
  function appNavigation(harness: Harness, path: string): Promise<Response> {
    return respond(
      harness.worker.fetch({
        request: navigation(`${ORIGIN}${path}`),
        clientId: "app-1",
        resultingClientId: "app-2",
      }),
    );
  }

  const transportClosed: ControlMessage = {
    type: "paseo.web.response.error",
    v: 1,
    generation: 1,
    requestId: 1,
    code: "transport_error",
    reason: "transport_closed",
  };

  it("arms the bootstrap's own session and says so", async () => {
    const harness = await admittedApp();
    expect(await arm(harness)).toEqual({
      type: "paseo.shell.lifecycle.armed",
      v: 1,
      nonce: NONCE,
      armed: true,
    });
  });

  it("keeps the document of a protected navigation whose head times out, and says why", async () => {
    const harness = await admittedApp({ ...CONFIG, headTimeoutMs: 20 });
    await arm(harness);
    const response = await appNavigation(harness, "/next");
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    const forwarded = await forwardedAt(harness, 1);
    await vi.waitFor(() =>
      expect(forwarded.fromWorker).toEqual([
        { type: "paseo.shell.request.dropped", cause: "head_timeout" },
      ]),
    );
  });

  it("still answers bridge_timeout to an unarmed navigation and to an armed subresource", async () => {
    const unarmed = await admittedApp({ ...CONFIG, headTimeoutMs: 20 });
    expect((await appNavigation(unarmed, "/next")).status).toBe(504);
    const forwarded = await forwardedAt(unarmed, 1);
    await vi.waitFor(() => expect(forwarded.fromWorker).toEqual([{ type: "paseo.shell.cancel" }]));

    const armed = await admittedApp({ ...CONFIG, headTimeoutMs: 20 });
    await arm(armed);
    const response = await subresource(armed, `${ORIGIN}/slow`);
    expect(response.status).toBe(504);
    expect(response.headers.get("x-paseo-web-proxy-error")).toBe("bridge_timeout");
  });

  it("keeps the document when a protected navigation loses its transport before the head", async () => {
    const harness = await admittedApp();
    await arm(harness);
    const pending = appNavigation(harness, "/next");
    const forwarded = await forwardedAt(harness, 1);
    reply(forwarded.port, transportClosed);
    expect((await pending).status).toBe(204);
    await vi.waitFor(() =>
      expect(forwarded.fromWorker).toEqual([
        { type: "paseo.shell.request.dropped", cause: "transport_closed" },
      ]),
    );
  });

  it("answers 502 to an unarmed transport loss and to a revoke even when armed", async () => {
    const unarmed = await admittedApp();
    const lost = appNavigation(unarmed, "/next");
    reply((await forwardedAt(unarmed, 1)).port, transportClosed);
    expect((await lost).status).toBe(502);

    const armed = await admittedApp();
    await arm(armed);
    const revoked = appNavigation(armed, "/next");
    const forwarded = await forwardedAt(armed, 1);
    reply(forwarded.port, { type: "paseo.web.revoke", v: 1, generation: 1, reason: "disposed" });
    const response = await revoked;
    expect(response.status).toBe(502);
    expect(response.headers.get("x-paseo-web-proxy-error")).toBe("session_revoked");
    expect(forwarded.fromWorker).toEqual([]);
  });

  it("leaves the body phase of a protected navigation unchanged", async () => {
    const harness = await admittedApp();
    await arm(harness);
    const pending = appNavigation(harness, "/next");
    const forwarded = await forwardedAt(harness, 1);
    reply(forwarded.port, head(200));
    const response = await pending;
    reply(forwarded.port, transportClosed);
    await expect(response.text()).rejects.toMatchObject({ reason: "transport_closed" });
  });

  it("turns a v1 204 head into a null 204 response and releases the host request", async () => {
    const harness = await admittedApp();
    await arm(harness);
    const pending = appNavigation(harness, "/next");
    const forwarded = await forwardedAt(harness, 1);
    reply(forwarded.port, head(204));
    const response = await pending;
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    await vi.waitFor(() => expect(forwarded.fromWorker).toEqual([{ type: "paseo.shell.cancel" }]));
  });
});

describe("createShellWorker authoritative purge", () => {
  it("hands the message event's waitUntil to the purge during the dispatch, and answers", async () => {
    const harness = await admittedApp();
    const channel = new MessageChannel();
    openPorts.push(channel.port1);
    const replies: unknown[] = [];
    channel.port1.addEventListener("message", (event) => replies.push(event.data));
    channel.port1.start();
    const waited: Array<Promise<unknown>> = [];
    const op = "AAAAAAAAAAAAAAAAAAAAAA";
    harness.worker.message({
      data: { type: "paseo.shell.purge", v: 1, op },
      sourceId: "b1",
      ports: [channel.port2],
      waitUntil: (promise) => waited.push(promise),
    });
    expect(waited).toHaveLength(1);
    await vi.waitFor(() =>
      expect(replies).toEqual([
        { type: "paseo.shell.purged", v: 1, op, caches: true, indexedDB: true, unregistered: true },
      ]),
    );
    // The purge dropped the session: the admitted document has no route any more.
    expect((await subresource(harness, `${ORIGIN}/after`)).status).toBeGreaterThanOrEqual(400);
  });
});
