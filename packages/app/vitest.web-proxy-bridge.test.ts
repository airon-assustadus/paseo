import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_SHELL_LAYOUT,
  createShellBundler,
  createWebProxyBridgeCommand,
  resolveAppEsbuild,
  type BridgeCommandContext,
  type BridgeHostOptions,
} from "./vitest.web-proxy-bridge";

const HOST_MODULE = "/fake/bridge-host.ts";
const PAGE_ORIGIN = "http://localhost:63315";
const HOST_TOKEN = "Zq3_lK9-xY2mN8pR4tW7vB1cD5eF6gH0iJ2kL3mN4oP";
const SHELL = { bootstrapJs: "// bootstrap", workerJs: "// worker" };

interface FakeRun {
  context: BridgeCommandContext;
  log: string[];
  /** What Vitest does when the run ends. */
  close(): Promise<void>;
}

function fakeRun(input: { module: unknown; local?: string[] | null; log?: string[] }): FakeRun {
  const log = input.log ?? [];
  const closers: Array<() => Promise<void>> = [];
  const local = input.local === undefined ? [`${PAGE_ORIGIN}/`] : input.local;
  const context: BridgeCommandContext = {
    project: {
      vitest: {
        onClose: (fn) => {
          log.push("register-cleanup");
          closers.push(fn);
        },
      },
      browser: { vite: { resolvedUrls: local === null ? null : { local } } },
      import: async (moduleId) => {
        log.push(`import:${moduleId}`);
        return input.module;
      },
    },
  };
  return {
    context,
    log,
    close: async () => {
      for (const fn of closers) await fn();
    },
  };
}

/** A host shaped as bridge-backend-plan.md §1 decides, Node-only members included. */
function canonicalHost(log: string[], overrides: Record<string, unknown> = {}) {
  return {
    url: "ws://127.0.0.1:40000/bridge",
    token: HOST_TOKEN,
    allowedOrigin: PAGE_ORIGIN,
    fixture: {
      http: { origin: "http://127.0.0.1:41000", internalPort: 41000 },
      https: {
        origin: "https://127.0.0.1:41001",
        caPem: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
        serverNames: ["localhost", "127.0.0.1", "::1"],
      },
      httpsVariants: {
        wrongHost: "https://127.0.0.1:41002",
        expired: "https://127.0.0.1:41003",
        selfSigned: "https://127.0.0.1:41004",
      },
      canary: { origin: "http://127.0.0.1:41005" },
    },
    shell: {
      listenerPort: 40001,
      origins: { a: "http://wp-a.localhost:40001", b: "http://wp-b.localhost:40001" },
    },
    stats: { connections: 0, authenticatedConnections: 0, sessionsOpened: 0 },
    backend: { releasePost: () => 0, postCount: () => 0 },
    duplicateNextRequest: () => {},
    close: async () => {
      log.push("host-close");
    },
    ...overrides,
  };
}

function hostModule(log: string[], start: (options: BridgeHostOptions) => Promise<unknown>) {
  return {
    startBridgeHost: async (options: BridgeHostOptions) => {
      log.push("host-start");
      return start(options);
    },
  };
}

function bridgeCommand(log: string[]) {
  return createWebProxyBridgeCommand({
    hostModulePath: HOST_MODULE,
    bundleShell: async (controlOrigin) => {
      log.push(`bundle:${controlOrigin}`);
      return SHELL;
    },
  });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("webProxyBridge command", () => {
  it("starts nothing until called, then registers cleanup before anything opens", async () => {
    const log: string[] = [];
    const run = fakeRun({ module: hostModule(log, async () => canonicalHost(log)), log });
    const command = bridgeCommand(log);

    expect(log).toEqual([]);
    await command(run.context);

    expect(log).toEqual([
      "register-cleanup",
      `bundle:${PAGE_ORIGIN}`,
      `import:${HOST_MODULE}`,
      "host-start",
    ]);
  });

  it("gives the host only the bundle and the page origin; the host owns the token", async () => {
    const log: string[] = [];
    const received: BridgeHostOptions[] = [];
    const module = hostModule(log, async (options) => {
      received.push(options);
      return canonicalHost(log);
    });
    const run = fakeRun({ module, log, local: [`${PAGE_ORIGIN}/__vitest__/`] });

    const info = await bridgeCommand(log)(run.context);

    expect(received).toEqual([{ shell: SHELL, allowedOrigin: PAGE_ORIGIN }]);
    expect(Object.keys(received[0]).sort()).toEqual(["allowedOrigin", "shell"]);
    expect(info.token).toBe(HOST_TOKEN);
  });

  it("projects exactly the public description and keeps every Node-only member in Node", async () => {
    const log: string[] = [];
    const host = canonicalHost(log);
    const run = fakeRun({ module: hostModule(log, async () => host), log });

    const info = await bridgeCommand(log)(run.context);

    expect(info).toEqual({
      url: "ws://127.0.0.1:40000/bridge",
      token: HOST_TOKEN,
      allowedOrigin: PAGE_ORIGIN,
      fixture: {
        http: { origin: "http://127.0.0.1:41000" },
        https: host.fixture.https,
        httpsVariants: host.fixture.httpsVariants,
        canary: { origin: "http://127.0.0.1:41005" },
      },
      shell: host.shell,
    });
    expect(Object.keys(info).sort()).toEqual(["allowedOrigin", "fixture", "shell", "token", "url"]);
    expect(info.fixture).not.toBe(host.fixture);
    expect(info.shell.origins).not.toBe(host.shell.origins);
    expect(JSON.parse(JSON.stringify(info))).toEqual(info);
  });

  it("coalesces calls within one Vitest run and starts again for another run", async () => {
    const log: string[] = [];
    const module = hostModule(log, async () => canonicalHost(log));
    const command = bridgeCommand(log);
    const first = fakeRun({ module, log });
    const second = fakeRun({ module, log });

    const results = await Promise.all([
      command(first.context),
      command(first.context),
      command(first.context),
    ]);
    await command(first.context);
    await command(second.context);

    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
    expect(log.filter((entry) => entry === "host-start")).toHaveLength(2);
  });

  it("closes the host once when the Vitest run closes", async () => {
    const log: string[] = [];
    const run = fakeRun({ module: hostModule(log, async () => canonicalHost(log)), log });

    await bridgeCommand(log)(run.context);
    await run.close();
    await run.close();

    expect(log.filter((entry) => entry === "host-close")).toHaveLength(1);
  });

  it("refuses to start without a browser server URL, before bundling or importing", async () => {
    const log: string[] = [];
    const run = fakeRun({
      module: hostModule(log, async () => canonicalHost(log)),
      log,
      local: null,
    });

    await expect(bridgeCommand(log)(run.context)).rejects.toMatchObject({
      problem: "no_browser_origin",
    });
    expect(log).toEqual(["register-cleanup"]);
  });

  it("refuses arguments from the browser without starting anything", async () => {
    const log: string[] = [];
    const run = fakeRun({ module: hostModule(log, async () => canonicalHost(log)), log });

    await expect(bridgeCommand(log)(run.context, { limits: {} })).rejects.toMatchObject({
      problem: "unexpected_arguments",
    });
    expect(log).toEqual([]);
  });

  it("explains a host module without startBridgeHost", async () => {
    const log: string[] = [];
    const run = fakeRun({ module: {}, log });

    await expect(bridgeCommand(log)(run.context)).rejects.toMatchObject({
      problem: "host_module_invalid",
    });
  });

  it("keeps a failed start as the answer for the whole run, with no retry", async () => {
    const log: string[] = [];
    const failure = new Error("fixture could not bind");
    const run = fakeRun({ module: hostModule(log, () => Promise.reject(failure)), log });
    const command = bridgeCommand(log);

    await expect(command(run.context)).rejects.toBe(failure);
    await expect(command(run.context)).rejects.toBe(failure);

    expect(log.filter((entry) => entry === "host-start")).toHaveLength(1);
  });

  const invalidHosts: [string, Record<string, unknown>][] = [
    ["a token of 42 characters", { token: HOST_TOKEN.slice(1) }],
    ["a token of 44 characters", { token: `${HOST_TOKEN}A` }],
    ["a token outside base64url", { token: `${HOST_TOKEN.slice(1)}+` }],
    ["no token", { token: undefined }],
    ["a non-loopback URL", { url: "ws://10.0.0.5:40000/bridge" }],
    ["a secure scheme it cannot serve", { url: "wss://127.0.0.1:40000/bridge" }],
    ["another WebSocket path", { url: "ws://127.0.0.1:40000/other" }],
    ["another page origin", { allowedOrigin: "http://localhost:9999" }],
    [
      "a content origin on another port",
      {
        shell: {
          listenerPort: 40001,
          origins: { a: "http://wp-a.localhost:40002", b: "http://wp-b.localhost:40001" },
        },
      },
    ],
    [
      "a content origin outside the two names",
      {
        shell: {
          listenerPort: 40001,
          origins: { a: "http://evil.localhost:40001", b: "http://wp-b.localhost:40001" },
        },
      },
    ],
    ["a fixture outside loopback", { fixture: { http: { origin: "http://10.0.0.5:41000" } } }],
    ["no fixture", { fixture: undefined }],
  ];

  it.each(invalidHosts)("closes a started host that returned %s", async (_case, overrides) => {
    const log: string[] = [];
    const run = fakeRun({
      module: hostModule(log, async () => canonicalHost(log, overrides)),
      log,
    });

    await expect(bridgeCommand(log)(run.context)).rejects.toMatchObject({
      problem: "host_result_invalid",
    });
    expect(log.at(-1)).toBe("host-close");
  });

  it("closes a host that finishes starting after the run closed", async () => {
    const log: string[] = [];
    const pending = deferred<unknown>();
    const run = fakeRun({ module: hostModule(log, () => pending.promise), log });

    const call = bridgeCommand(log)(run.context);
    await expect.poll(() => log.includes("host-start")).toBe(true);
    await run.close();
    pending.resolve(canonicalHost(log));

    await expect(call).rejects.toMatchObject({ problem: "closed_during_start" });
    expect(log.at(-1)).toBe("host-close");
  });
});

const appRoot = path.dirname(new URL(import.meta.url).pathname);

/** The bundles are plain scripts: nothing for a browser to resolve after serving them. */
function asScript(code: string): string {
  expect(code).not.toMatch(/^\s*(import|export)\b/m);
  return code;
}

interface FetchEventRecord {
  responded: Promise<Response> | null;
}

/** Runs the worker bundle in its own realm with a minimal service worker global scope. */
function runWorker(code: string, origin: string) {
  const listeners = new Map<string, (event: unknown) => void>();
  const scope = {
    location: { origin },
    registration: {},
    clients: {
      matchAll: async () => [],
      get: async () => undefined,
      claim: async () => undefined,
    },
    skipWaiting: async () => undefined,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
    URL,
    Request,
    Response,
    Headers,
    ReadableStream,
    MessageChannel,
    TextEncoder,
    TextDecoder,
    AbortController,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    atob,
    btoa,
    console,
  };
  vm.runInNewContext(asScript(code), scope);
  function fetch(url: string): FetchEventRecord {
    const record: FetchEventRecord = { responded: null };
    listeners.get("fetch")?.({
      request: new Request(url),
      clientId: "",
      resultingClientId: "",
      respondWith: (response: Promise<Response>) => {
        record.responded = Promise.resolve(response);
      },
    });
    return record;
  }
  return { listeners, fetch };
}

/** Runs the bootstrap bundle in its own realm, as a frame whose parent is `ancestor`. */
function runBootstrap(code: string, ancestor: string) {
  const statuses: string[] = [];
  const registrations: Array<{ url: string; options: unknown }> = [];
  const posted: Array<{ message: unknown; targetOrigin: string }> = [];
  const dataset = {};
  Object.defineProperty(dataset, "paseoShell", {
    set: (status: string) => statuses.push(status),
  });
  const fakeWindow = {
    parent: {
      postMessage: (message: unknown, targetOrigin: string) =>
        posted.push({ message, targetOrigin }),
    },
    location: {
      href: "http://wp-a.localhost:40001/__paseo/bootstrap.html",
      ancestorOrigins: { length: 1, 0: ancestor },
    },
    document: {
      body: { dataset, append: () => {} },
      getElementById: () => null,
      createElement: () => ({ setAttribute: () => {}, dataset: {}, remove: () => {} }),
    },
    navigator: {
      serviceWorker: {
        addEventListener: () => {},
        register: async (url: string, options: unknown) => {
          registrations.push({ url, options });
          const active = { state: "activated", postMessage: () => {}, addEventListener: () => {} };
          return { installing: null, waiting: null, active };
        },
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  vm.runInNewContext(asScript(code), {
    window: fakeWindow,
    URL,
    MessageChannel,
    console,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    // The hello retry never fires here; the first hello is posted before the interval starts.
    setInterval: () => 0,
    clearInterval: () => {},
  });
  return { statuses, registrations, posted };
}

describe("shell bundle", () => {
  it("uses the esbuild version the app declares", () => {
    const manifest: { devDependencies: Record<string, string> } = JSON.parse(
      readFileSync(path.join(appRoot, "package.json"), "utf8"),
    );

    expect(resolveAppEsbuild(appRoot).version).toBe(manifest.devDependencies.esbuild);
  });

  it("produces a worker script that installs the shell with the bridge layout", async () => {
    const { workerJs } = await createShellBundler(appRoot)(PAGE_ORIGIN);
    const worker = runWorker(workerJs, "http://wp-a.localhost:40001");

    expect([...worker.listeners.keys()].sort()).toEqual(["fetch", "install", "message"]);
    const shellAsset = worker.fetch("http://wp-a.localhost:40001/__paseo/bootstrap.js");
    const enter = worker.fetch(`http://wp-a.localhost:40001${BRIDGE_SHELL_LAYOUT.enterPath}?t=x`);
    const mounted = worker.fetch("http://wp-a.localhost:40001/app/page");
    const foreign = worker.fetch("http://elsewhere.test/app/page");

    expect(shellAsset.responded).toBeNull();
    expect(await enter.responded).toBeInstanceOf(Response);
    expect(await mounted.responded).toBeInstanceOf(Response);
    expect((await foreign.responded)?.type).toBe("error");
  });

  it("produces a bootstrap that registers the worker and greets only its control origin", async () => {
    const { bootstrapJs } = await createShellBundler(appRoot)(PAGE_ORIGIN);

    const framed = runBootstrap(bootstrapJs, PAGE_ORIGIN);
    await expect.poll(() => framed.posted.length).toBe(1);
    const foreign = runBootstrap(bootstrapJs, "http://localhost:9999");

    expect(framed.registrations).toEqual([
      { url: BRIDGE_SHELL_LAYOUT.workerUrl, options: { scope: "/", type: "module" } },
    ]);
    expect(framed.posted[0]).toMatchObject({
      message: { type: "paseo.web.hello" },
      targetOrigin: PAGE_ORIGIN,
    });
    expect(framed.statuses).toEqual(["registering", "awaiting_grant"]);
    expect(foreign.statuses).toEqual(["no_session"]);
    expect(foreign.registrations).toEqual([]);
    expect(foreign.posted).toEqual([]);
  });
});
