import { describe, expect, it, vi } from "vitest";
import type { ControlMessage } from "../bridge-messages";
import { readShellFetchFields } from "./relay-messages";
import {
  createShellFetchHandler,
  InvalidShellWorkerConfigError,
  ShellBridgeTimeoutError,
  type ShellClients,
  type ShellFetchDecision,
  type ShellWindowClient,
  type ShellWorkerConfig,
} from "./worker.web";

const ORIGIN = "https://wp-a.example";
const CONFIG: ShellWorkerConfig = {
  controlOrigin: "https://app.example",
  shellPathPrefix: "/__paseo/",
  bootstrapPath: "/__paseo/bootstrap.html",
  mountPath: "/",
  headTimeoutMs: 1000,
  idleChunkTimeoutMs: 1000,
  maxRequestBodyBytes: 8,
};

interface ForwardedFetch {
  request: Record<string, unknown> | null;
  port: MessagePort;
  fromWorker: unknown[];
}

interface FakeBootstrap extends ShellWindowClient {
  forwarded: ForwardedFetch[];
}

function createBootstrap(url = `${ORIGIN}${CONFIG.bootstrapPath}`): FakeBootstrap {
  const forwarded: ForwardedFetch[] = [];
  return {
    url,
    forwarded,
    postMessage(message, transfer) {
      const port = transfer.find((item) => item instanceof MessagePort);
      if (!(port instanceof MessagePort)) throw new Error("fetch without a port");
      const entry: ForwardedFetch = {
        request: readShellFetchFields(message),
        port,
        fromWorker: [],
      };
      port.addEventListener("message", (event) => entry.fromWorker.push(event.data));
      port.start();
      forwarded.push(entry);
    },
  };
}

function forwardedAt(bootstrap: FakeBootstrap, index: number): Promise<ForwardedFetch> {
  return vi.waitFor(() => {
    const entry = bootstrap.forwarded[index];
    if (entry === undefined) throw new Error(`fetch ${index} not forwarded yet`);
    return entry;
  });
}

function clientsOf(...windows: ShellWindowClient[]): ShellClients {
  return { matchAll: () => Promise.resolve(windows) };
}

function respond(decision: ShellFetchDecision): Promise<Response> {
  if (decision.kind !== "respond") throw new Error("expected the worker to respond");
  return decision.response;
}

// Request() cannot be constructed with mode "navigate"; the handler only reads these fields.
function navigation(url: string): Request {
  const request = new Request(url);
  Object.defineProperty(request, "mode", { value: "navigate" });
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

describe("createShellFetchHandler", () => {
  it("leaves the shell's own assets to the network", () => {
    const handle = createShellFetchHandler({
      config: CONFIG,
      clients: clientsOf(),
      origin: ORIGIN,
    });
    expect(handle(new Request(`${ORIGIN}/__paseo/bootstrap.html`))).toEqual({ kind: "network" });
  });

  it("answers requests to other origins with a network error", async () => {
    const handle = createShellFetchHandler({
      config: CONFIG,
      clients: clientsOf(),
      origin: ORIGIN,
    });
    const response = await respond(handle(new Request("http://localhost:6767/api/health")));
    expect(response.type).toBe("error");
  });

  it("answers same-origin paths outside the mount point with a network error", async () => {
    const config = { ...CONFIG, mountPath: "/app/" };
    const handle = createShellFetchHandler({ config, clients: clientsOf(), origin: ORIGIN });
    expect((await respond(handle(new Request(`${ORIGIN}/other`)))).type).toBe("error");
  });

  it("fails closed when no bootstrap holds a session", async () => {
    const handle = createShellFetchHandler({
      config: CONFIG,
      clients: clientsOf({ url: `${ORIGIN}/page`, postMessage: () => {} }),
      origin: ORIGIN,
    });
    const response = await respond(handle(new Request(`${ORIGIN}/`)));
    expect(response.status).toBe(503);
    expect(response.headers.get("x-paseo-web-proxy-error")).toBe("session_unavailable");
  });

  it("fails closed when two bootstraps could serve the request", async () => {
    const handle = createShellFetchHandler({
      config: CONFIG,
      clients: clientsOf(createBootstrap(), createBootstrap()),
      origin: ORIGIN,
    });
    const response = await respond(handle(new Request(`${ORIGIN}/`)));
    expect(response.status).toBe(503);
    expect(response.headers.get("x-paseo-web-proxy-error")).toBe("session_ambiguous");
  });

  it("forwards a mounted request and returns credit as the page reads the body", async () => {
    const bootstrap = createBootstrap();
    const config = { ...CONFIG, mountPath: "/app/" };
    const handle = createShellFetchHandler({
      config,
      clients: clientsOf(bootstrap),
      origin: ORIGIN,
    });
    const pending = respond(
      handle(new Request(`${ORIGIN}/app/api/x?y=1`, { method: "POST", body: "abc" })),
    );
    const forwarded = await forwardedAt(bootstrap, 0);
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
    const response = await pending;
    expect(await response.text()).toBe("hello");
    await vi.waitFor(() =>
      expect(forwarded.fromWorker).toEqual([
        { type: "paseo.shell.ack", bytes: 2 },
        { type: "paseo.shell.ack", bytes: 3 },
      ]),
    );
  });

  it("adds the shell policy and maps root redirects into the mount point", async () => {
    const bootstrap = createBootstrap();
    const config = { ...CONFIG, mountPath: "/app/" };
    const handle = createShellFetchHandler({
      config,
      clients: clientsOf(bootstrap),
      origin: ORIGIN,
    });
    const pending = respond(handle(new Request(`${ORIGIN}/app/old`, { redirect: "manual" })));
    const forwarded = await forwardedAt(bootstrap, 0);
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

  it("answers bridge_timeout and cancels when the bootstrap never answers", async () => {
    const bootstrap = createBootstrap();
    const config = { ...CONFIG, headTimeoutMs: 20 };
    const handle = createShellFetchHandler({
      config,
      clients: clientsOf(bootstrap),
      origin: ORIGIN,
    });
    const response = await respond(handle(new Request(`${ORIGIN}/`)));
    expect(response.status).toBe(504);
    expect(response.headers.get("x-paseo-web-proxy-error")).toBe("bridge_timeout");
    const [forwarded] = bootstrap.forwarded;
    await vi.waitFor(() => expect(forwarded?.fromWorker).toEqual([{ type: "paseo.shell.cancel" }]));
  });

  it("errors the body and cancels when the bridge goes silent mid-stream", async () => {
    const bootstrap = createBootstrap();
    const config = { ...CONFIG, idleChunkTimeoutMs: 20 };
    const handle = createShellFetchHandler({
      config,
      clients: clientsOf(bootstrap),
      origin: ORIGIN,
    });
    const pending = respond(handle(new Request(`${ORIGIN}/`)));
    const forwarded = await forwardedAt(bootstrap, 0);
    reply(forwarded.port, head(200));
    const response = await pending;
    await expect(response.text()).rejects.toBeInstanceOf(ShellBridgeTimeoutError);
    await vi.waitFor(() => expect(forwarded.fromWorker).toEqual([{ type: "paseo.shell.cancel" }]));
  });

  it("answers session_revoked when the grant ends before the response", async () => {
    const bootstrap = createBootstrap();
    const handle = createShellFetchHandler({
      config: CONFIG,
      clients: clientsOf(bootstrap),
      origin: ORIGIN,
    });
    const pending = respond(handle(new Request(`${ORIGIN}/`)));
    const forwarded = await forwardedAt(bootstrap, 0);
    reply(forwarded.port, { type: "paseo.web.revoke", v: 1, generation: 1, reason: "disposed" });
    const response = await pending;
    expect(response.status).toBe(502);
    expect(response.headers.get("x-paseo-web-proxy-error")).toBe("session_revoked");
  });

  it("passes the broker's error code through", async () => {
    const bootstrap = createBootstrap();
    const handle = createShellFetchHandler({
      config: CONFIG,
      clients: clientsOf(bootstrap),
      origin: ORIGIN,
    });
    const pending = respond(handle(new Request(`${ORIGIN}/cross`)));
    const forwarded = await forwardedAt(bootstrap, 0);
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

  it("refuses an oversized body without reaching the bootstrap", async () => {
    const bootstrap = createBootstrap();
    const handle = createShellFetchHandler({
      config: CONFIG,
      clients: clientsOf(bootstrap),
      origin: ORIGIN,
    });
    const response = await respond(
      handle(new Request(`${ORIGIN}/upload`, { method: "POST", body: "123456789" })),
    );
    expect(response.status).toBe(413);
    expect(bootstrap.forwarded).toEqual([]);
  });

  it("serves the next request from a fresh handler as a restarted worker would", async () => {
    const bootstrap = createBootstrap();
    for (const [index, attempt] of ["first", "second"].entries()) {
      const handle = createShellFetchHandler({
        config: CONFIG,
        clients: clientsOf(bootstrap),
        origin: ORIGIN,
      });
      const pending = respond(handle(new Request(`${ORIGIN}/${attempt}`)));
      const forwarded = await forwardedAt(bootstrap, index);
      expect(forwarded.request).toMatchObject({ path: `/${attempt}` });
      reply(forwarded.port, head(200));
      reply(forwarded.port, chunk(attempt));
      reply(forwarded.port, END);
      expect(await (await pending).text()).toBe(attempt);
    }
  });

  it("keeps the destination's CSP next to the shell's", async () => {
    const bootstrap = createBootstrap();
    const handle = createShellFetchHandler({
      config: CONFIG,
      clients: clientsOf(bootstrap),
      origin: ORIGIN,
    });
    const pending = respond(handle(new Request(`${ORIGIN}/page`)));
    const forwarded = await forwardedAt(bootstrap, 0);
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
      const bootstrap = createBootstrap();
      const handle = createShellFetchHandler({
        config: CONFIG,
        clients: clientsOf(bootstrap),
        origin: ORIGIN,
      });
      const pending = respond(handle(navigation(`${ORIGIN}/page`)));
      const forwarded = await forwardedAt(bootstrap, 0);
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
    const bootstrap = createBootstrap();
    const handle = createShellFetchHandler({
      config: CONFIG,
      clients: clientsOf(bootstrap),
      origin: ORIGIN,
    });
    const pending = respond(handle(new Request(`${ORIGIN}/data.json`)));
    const forwarded = await forwardedAt(bootstrap, 0);
    reply(forwarded.port, head(200, [["x-frame-options", "DENY"]]));
    reply(forwarded.port, END);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it.each([
    ["headTimeoutMs", { headTimeoutMs: 0 }],
    ["idleChunkTimeoutMs", { idleChunkTimeoutMs: Number.NaN }],
    ["maxRequestBodyBytes", { maxRequestBodyBytes: 1.5 }],
    ["mountPath", { mountPath: "/app" }],
    ["shellPathPrefix", { shellPathPrefix: "__paseo/" }],
    ["bootstrapPath", { bootstrapPath: "/elsewhere/bootstrap.html" }],
    ["controlOrigin", { controlOrigin: "https://app.example/" }],
  ] as const)("rejects an invalid %s", (field, override) => {
    expect(() =>
      createShellFetchHandler({
        config: { ...CONFIG, ...override },
        clients: clientsOf(),
        origin: ORIGIN,
      }),
    ).toThrow(new InvalidShellWorkerConfigError(field));
  });
});
