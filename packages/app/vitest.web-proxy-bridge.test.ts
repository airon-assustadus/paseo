import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_SHELL_LAYOUT,
  createShellBundler,
  createWebProxyBridgeCommand,
  createWebProxyRelayCommands,
  resolveAppEsbuild,
  type BridgeCommandContext,
  type BridgeHostOptions,
  type RelayStackOptions,
} from "./vitest.web-proxy-bridge";

const appRoot = path.dirname(new URL(import.meta.url).pathname);

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

const STACK_MODULE = "/fake/relay-bridge-stack.ts";
const WORKTREE = path.resolve(appRoot, "../..");
const CODEC = path.resolve(
  appRoot,
  "../server/src/server/network-fetch/__fixtures__/length-prefixed.ts",
);
const SERVER_ID = "srv_AbCdEfGhIj_-";
const DAEMON_KEY = Buffer.alloc(32, 0xfb).toString("base64");
const NONCE = "nonce_R2-0001";

function stackInfo(log: string[]) {
  const { fixture, shell } = canonicalHost(log);
  return {
    relay: { endpoint: "127.0.0.1:42000" },
    daemon: { serverId: SERVER_ID, daemonPublicKeyB64: DAEMON_KEY },
    bridge: { tcpPort: 40002, token: HOST_TOKEN, allowedOrigin: PAGE_ORIGIN, fixture, shell },
  };
}

function legEvidence(extra: Record<string, unknown> = {}) {
  const directions = { toTarget: false, fromTarget: false };
  return {
    connections: 1,
    messages: 6,
    nonHandshakeMessages: 4,
    handshake: ["e2ee_hello", "e2ee_ready"],
    bytes: { toTarget: 900, fromTarget: 1200 },
    overflow: null,
    contains: { nonce: { ...directions }, token: { ...directions }, hello: { ...directions } },
    ...extra,
  };
}

/** `BridgeHost.stats` as the stack copies it, plus members it must never pass on. */
function hostTotals(extra: Record<string, unknown> = {}) {
  return { connections: 3, authenticatedConnections: 2, sessionsOpened: 2, ...extra };
}

/** Host stats members outside the decided totals, and an authority value, that must not cross. */
const HOST_STATS_EXTRAS = {
  fixtureQueries: 5,
  activeSockets: 1,
  rawSockets: 1,
  truncatedFrames: 0,
  token: HOST_TOKEN,
};

const HOST_TOTAL_FIELDS = ["connections", "authenticatedConnections", "sessionsOpened"] as const;

const INVALID_TOTALS: [string, unknown][] = [
  ["negative", -1],
  ["fractional", 1.5],
  ["above MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 1],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["a numeric string", "3"],
  ["a bigint", 3n],
  ["null", null],
  ["missing", undefined],
];

const INVALID_HOST_TOTALS = HOST_TOTAL_FIELDS.flatMap((field) =>
  INVALID_TOTALS.map(([label, value]): [string, Record<string, unknown>] => [
    `${field} ${label}`,
    hostTotals({ [field]: value }),
  ]),
);

/** A stack shaped as relay-r2-backend-contract.md publishes it, Node-only members included. */
function canonicalStack(log: string[], overrides: Record<string, unknown> = {}) {
  return {
    info: stackInfo(log),
    host: canonicalHost(log),
    daemon: { serverId: SERVER_ID, paseoHome: "/tmp/paseo-home-r2" },
    relay: { port: 42001, instance: 1 },
    taps: { client: { port: 42000 }, daemon: { port: 42003 } },
    relayRegistrations: () => 1,
    restartRelay: async () => {
      log.push("stack-restart");
    },
    evidence: (markers: { nonce: string }) => {
      log.push(`evidence:${JSON.stringify(markers)}`);
      return {
        clientLeg: legEvidence(),
        daemonLeg: legEvidence({ connections: 2 }),
        host: hostTotals(),
      };
    },
    close: async () => {
      log.push("stack-close");
    },
    ...overrides,
  };
}

function stackModule(log: string[], start: (options: RelayStackOptions) => Promise<unknown>) {
  return {
    startRelayBridgeStack: async (options: RelayStackOptions) => {
      log.push("stack-start");
      return start(options);
    },
  };
}

function relayCommands(
  log: string[],
  options: { codecModulePath?: string; servedRoot?: string; bundle?: Promise<void> } = {},
) {
  return createWebProxyRelayCommands({
    stackModulePath: STACK_MODULE,
    codecModulePath: options.codecModulePath ?? CODEC,
    servedRoot: options.servedRoot ?? WORKTREE,
    bundleShell: async (controlOrigin) => {
      log.push(`bundle:${controlOrigin}`);
      await options.bundle;
      return SHELL;
    },
  });
}

/** True once `promise` has settled, checked after pending microtasks and one macrotask ran. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  const mark = () => {
    settled = true;
  };
  promise.then(mark, mark);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

/** A run whose stack already started. */
async function startedRelay(overrides: Record<string, unknown> = {}) {
  const log: string[] = [];
  const run = fakeRun({
    module: stackModule(log, async () => canonicalStack(log, overrides)),
    log,
  });
  const commands = relayCommands(log);
  await commands.webProxyRelayBridge(run.context);
  return { log, run, commands };
}

describe("webProxyRelay commands", () => {
  it("start nothing until called, then register cleanup and resolve the codec before opening", async () => {
    const log: string[] = [];
    const run = fakeRun({ module: stackModule(log, async () => canonicalStack(log)), log });
    const commands = relayCommands(log);

    expect(log).toEqual([]);
    await commands.webProxyRelayBridge(run.context);

    expect(log).toEqual([
      "register-cleanup",
      `bundle:${PAGE_ORIGIN}`,
      `import:${STACK_MODULE}`,
      "stack-start",
    ]);
  });

  it("give the stack only the bundle and the page origin", async () => {
    const log: string[] = [];
    const received: RelayStackOptions[] = [];
    const module = stackModule(log, async (options) => {
      received.push(options);
      return canonicalStack(log);
    });
    const run = fakeRun({ module, log, local: [`${PAGE_ORIGIN}/__vitest__/`] });

    await relayCommands(log).webProxyRelayBridge(run.context);

    expect(received).toEqual([{ shell: SHELL, allowedOrigin: PAGE_ORIGIN }]);
    expect(Object.keys(received[0]).sort()).toEqual(["allowedOrigin", "shell"]);
  });

  it("project the decided fields and the codec URL, and nothing else", async () => {
    const log: string[] = [];
    const stack = canonicalStack(log);
    const extra = {
      ...stack.info,
      offer: { v: 2 },
      relay: { ...stack.info.relay, useTls: false },
      bridge: { ...stack.info.bridge, url: "ws://127.0.0.1:40000/bridge" },
    };
    const run = fakeRun({ module: stackModule(log, async () => ({ ...stack, info: extra })), log });

    const info = await relayCommands(log).webProxyRelayBridge(run.context);

    expect(info).toEqual({
      relay: { endpoint: "127.0.0.1:42000" },
      daemon: { serverId: SERVER_ID, daemonPublicKeyB64: DAEMON_KEY },
      bridge: {
        tcpPort: 40002,
        token: HOST_TOKEN,
        allowedOrigin: PAGE_ORIGIN,
        fixture: {
          http: { origin: "http://127.0.0.1:41000" },
          https: stack.info.bridge.fixture.https,
          httpsVariants: stack.info.bridge.fixture.httpsVariants,
          canary: { origin: "http://127.0.0.1:41005" },
        },
        shell: stack.info.bridge.shell,
      },
      codecModuleUrl: `/@fs${realpathSync(CODEC)}`,
    });
    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain("ws://");
    expect(serialized).not.toContain("paseo-home");
    expect(info.bridge.shell).not.toBe(stack.info.bridge.shell);
  });

  it("coalesce calls within one Vitest run and start again for another run", async () => {
    const log: string[] = [];
    const module = stackModule(log, async () => canonicalStack(log));
    const commands = relayCommands(log);
    const first = fakeRun({ module, log });
    const second = fakeRun({ module, log });

    const results = await Promise.all([
      commands.webProxyRelayBridge(first.context),
      commands.webProxyRelayBridge(first.context),
    ]);
    await commands.webProxyRelayBridge(second.context);

    expect(results[1]).toBe(results[0]);
    expect(log.filter((entry) => entry === "stack-start")).toHaveLength(2);
  });

  it("close the stack once when the Vitest run closes", async () => {
    const { log, run } = await startedRelay();

    await run.close();
    await run.close();

    expect(log.filter((entry) => entry === "stack-close")).toHaveLength(1);
  });

  it("refuse a codec outside the served root before opening anything", async () => {
    const log: string[] = [];
    const run = fakeRun({ module: stackModule(log, async () => canonicalStack(log)), log });

    const outside = relayCommands(log, { servedRoot: appRoot });
    await expect(outside.webProxyRelayBridge(run.context)).rejects.toMatchObject({
      problem: "codec_module_invalid",
    });
    expect(log).toEqual(["register-cleanup"]);
  });

  it("refuse a codec that does not exist", async () => {
    const log: string[] = [];
    const run = fakeRun({ module: stackModule(log, async () => canonicalStack(log)), log });
    const missing = relayCommands(log, { codecModulePath: path.join(WORKTREE, "missing.ts") });

    await expect(missing.webProxyRelayBridge(run.context)).rejects.toMatchObject({
      problem: "codec_module_invalid",
    });
  });

  it("explain a stack module without startRelayBridgeStack", async () => {
    const log: string[] = [];
    const run = fakeRun({ module: {}, log });

    await expect(relayCommands(log).webProxyRelayBridge(run.context)).rejects.toMatchObject({
      problem: "stack_module_invalid",
    });
  });

  it("report only the failed step of a start, and keep it for the whole run", async () => {
    const log: string[] = [];
    const failure = Object.assign(new Error("relay_control_disconnected /tmp/paseo-home 42000"), {
      step: "registration",
      closedPorts: [42000, 42001],
    });
    const run = fakeRun({ module: stackModule(log, () => Promise.reject(failure)), log });
    const commands = relayCommands(log);

    const first = commands.webProxyRelayBridge(run.context);
    await expect(first).rejects.toMatchObject({
      problem: "relay_start_failed",
      message: 'The relay stack failed at step "registration"',
    });
    await expect(first).rejects.not.toHaveProperty("cause");
    await expect(commands.webProxyRelayBridge(run.context)).rejects.toMatchObject({
      problem: "relay_start_failed",
    });
    await expect(commands.webProxyRelayRestart(run.context)).rejects.toMatchObject({
      problem: "relay_failed",
    });
    expect(log.filter((entry) => entry === "stack-start")).toHaveLength(1);
  });

  it("report a start failure without a known step without its message", async () => {
    const log: string[] = [];
    const failure = Object.assign(new Error("/tmp/paseo-home"), { step: "elsewhere" });
    const run = fakeRun({ module: stackModule(log, () => Promise.reject(failure)), log });

    await expect(relayCommands(log).webProxyRelayBridge(run.context)).rejects.toMatchObject({
      problem: "relay_start_failed",
      message: "The relay stack failed to start",
    });
  });

  type StackCase = [string, (log: string[]) => Record<string, unknown>];
  const withInfo = (log: string[], patch: (value: ReturnType<typeof stackInfo>) => unknown) => ({
    info: patch(stackInfo(log)),
  });
  const invalidStacks: StackCase[] = [
    [
      "an endpoint with a scheme",
      (log) => withInfo(log, (v) => ({ ...v, relay: { endpoint: "ws://127.0.0.1:42000" } })),
    ],
    [
      "an endpoint outside loopback",
      (log) => withInfo(log, (v) => ({ ...v, relay: { endpoint: "10.0.0.5:42000" } })),
    ],
    [
      "an endpoint on port 0",
      (log) => withInfo(log, (v) => ({ ...v, relay: { endpoint: "127.0.0.1:0" } })),
    ],
    [
      "an endpoint above 65535",
      (log) => withInfo(log, (v) => ({ ...v, relay: { endpoint: "127.0.0.1:70000" } })),
    ],
    [
      "a server id of another shape",
      (log) => withInfo(log, (v) => ({ ...v, daemon: { ...v.daemon, serverId: "srv_short" } })),
    ],
    [
      "a public key in base64url",
      (log) =>
        withInfo(log, (v) => ({
          ...v,
          daemon: { ...v.daemon, daemonPublicKeyB64: DAEMON_KEY.replaceAll("/", "_") },
        })),
    ],
    [
      "a public key of 31 bytes",
      (log) =>
        withInfo(log, (v) => ({
          ...v,
          daemon: { ...v.daemon, daemonPublicKeyB64: Buffer.alloc(31, 1).toString("base64") },
        })),
    ],
    [
      "a TCP port that is not an integer",
      (log) => withInfo(log, (v) => ({ ...v, bridge: { ...v.bridge, tcpPort: "40002" } })),
    ],
    [
      "a token outside base64url",
      (log) =>
        withInfo(log, (v) => ({ ...v, bridge: { ...v.bridge, token: `${HOST_TOKEN.slice(1)}+` } })),
    ],
    [
      "another page origin",
      (log) =>
        withInfo(log, (v) => ({
          ...v,
          bridge: { ...v.bridge, allowedOrigin: "http://localhost:9999" },
        })),
    ],
    [
      "a fixture outside loopback",
      (log) =>
        withInfo(log, (v) => ({
          ...v,
          bridge: { ...v.bridge, fixture: { http: { origin: "http://10.0.0.5:41000" } } },
        })),
    ],
    ["no daemon", (log) => withInfo(log, (v) => ({ ...v, daemon: undefined }))],
    ["no restartRelay", () => ({ restartRelay: undefined })],
    ["no evidence", () => ({ evidence: undefined })],
  ];

  it.each(invalidStacks)("close a started stack that returned %s", async (_case, overrides) => {
    const log: string[] = [];
    const run = fakeRun({
      module: stackModule(log, async () => canonicalStack(log, overrides(log))),
      log,
    });

    await expect(relayCommands(log).webProxyRelayBridge(run.context)).rejects.toMatchObject({
      problem: "relay_result_invalid",
    });
    expect(log.at(-1)).toBe("stack-close");
  });

  it("reject a stack without close and has nothing to shut down", async () => {
    const log: string[] = [];
    const stack = canonicalStack(log, { close: undefined });
    const run = fakeRun({ module: stackModule(log, async () => stack), log });

    await expect(relayCommands(log).webProxyRelayBridge(run.context)).rejects.toMatchObject({
      problem: "relay_result_invalid",
    });
    expect(log).not.toContain("stack-close");
  });

  it("hold the run's close until a start in flight has started and closed its stack", async () => {
    const log: string[] = [];
    const started = deferred<unknown>();
    const stackClosed = deferred<void>();
    const stack = canonicalStack(log, {
      close: async () => {
        log.push("stack-close");
        await stackClosed.promise;
        log.push("stack-closed");
      },
    });
    const run = fakeRun({ module: stackModule(log, () => started.promise), log });
    const commands = relayCommands(log);

    const call = commands.webProxyRelayBridge(run.context);
    const rejected = expect(call).rejects.toMatchObject({ problem: "closed_during_start" });
    await expect.poll(() => log.includes("stack-start")).toBe(true);
    const closing = run.close();

    expect(await hasSettled(closing)).toBe(false);
    started.resolve(stack);
    await expect.poll(() => log.includes("stack-close")).toBe(true);
    expect(await hasSettled(closing)).toBe(false);
    stackClosed.resolve();
    await closing;

    expect(log.slice(-2)).toEqual(["stack-close", "stack-closed"]);
    await rejected;
    await expect(commands.webProxyRelayBridge(run.context)).rejects.toMatchObject({
      problem: "closed_during_start",
    });
    await expect(commands.webProxyRelayRestart(run.context)).rejects.toMatchObject({
      problem: "relay_closed",
    });
    expect(log.filter((entry) => entry === "stack-start")).toHaveLength(1);
    expect(log.filter((entry) => entry === "stack-close")).toHaveLength(1);
  });

  it("hold the run's close until a failing start in flight has unwound, keeping its sanitized error", async () => {
    const log: string[] = [];
    const unwound = deferred<void>();
    const failure = Object.assign(new Error("/tmp/paseo-home 42000"), { step: "registration" });
    const module = stackModule(log, async () => {
      await unwound.promise;
      log.push("stack-unwound");
      throw failure;
    });
    const run = fakeRun({ module, log });
    const commands = relayCommands(log);

    const call = commands.webProxyRelayBridge(run.context);
    const rejected = expect(call).rejects.toMatchObject({
      problem: "relay_start_failed",
      message: 'The relay stack failed at step "registration"',
    });
    await expect.poll(() => log.includes("stack-start")).toBe(true);
    const closing = run.close();

    expect(await hasSettled(closing)).toBe(false);
    unwound.resolve();
    await closing;

    expect(log).toContain("stack-unwound");
    await rejected;
    await expect(commands.webProxyRelayBridge(run.context)).rejects.toMatchObject({
      problem: "relay_start_failed",
    });
    expect(log.filter((entry) => entry === "stack-start")).toHaveLength(1);
    expect(log).not.toContain("stack-close");
  });

  it("never start the stack when the run closed while the shell was bundling", async () => {
    const log: string[] = [];
    const bundle = deferred<void>();
    const run = fakeRun({ module: stackModule(log, async () => canonicalStack(log)), log });

    const call = relayCommands(log, { bundle: bundle.promise }).webProxyRelayBridge(run.context);
    await expect.poll(() => log.includes(`bundle:${PAGE_ORIGIN}`)).toBe(true);
    const closing = run.close();
    expect(await hasSettled(closing)).toBe(false);
    bundle.resolve();
    await closing;

    await expect(call).rejects.toMatchObject({ problem: "closed_during_start" });
    expect(log).not.toContain("stack-start");
  });

  it("refuse arguments from the browser", async () => {
    const { run, commands } = await startedRelay();

    await expect(commands.webProxyRelayBridge(run.context, 1)).rejects.toMatchObject({
      problem: "unexpected_arguments",
    });
    await expect(commands.webProxyRelayRestart(run.context, {})).rejects.toMatchObject({
      problem: "unexpected_arguments",
    });
    await expect(commands.webProxyRelayEvidence(run.context)).rejects.toMatchObject({
      problem: "unexpected_arguments",
    });
    await expect(commands.webProxyRelayEvidence(run.context, NONCE, NONCE)).rejects.toMatchObject({
      problem: "unexpected_arguments",
    });
  });
});

describe("webProxyRelayRestart command", () => {
  it("refuses before any start", async () => {
    const log: string[] = [];
    const run = fakeRun({ module: stackModule(log, async () => canonicalStack(log)), log });

    await expect(relayCommands(log).webProxyRelayRestart(run.context)).rejects.toMatchObject({
      problem: "relay_not_started",
    });
    expect(log).toEqual([]);
  });

  it("refuses while the stack is starting", async () => {
    const log: string[] = [];
    const pending = deferred<unknown>();
    const run = fakeRun({ module: stackModule(log, () => pending.promise), log });
    const commands = relayCommands(log);

    const call = commands.webProxyRelayBridge(run.context);
    await expect(commands.webProxyRelayRestart(run.context)).rejects.toMatchObject({
      problem: "relay_not_ready",
    });
    pending.resolve(canonicalStack(log));
    await call;
  });

  it("restarts the relay and leaves the stack usable", async () => {
    const { log, run, commands } = await startedRelay();

    await commands.webProxyRelayRestart(run.context);
    await commands.webProxyRelayEvidence(run.context, NONCE);

    expect(log.filter((entry) => entry === "stack-restart")).toHaveLength(1);
  });

  it("refuses a concurrent restart", async () => {
    const restarted = deferred<void>();
    const { run, commands } = await startedRelay({ restartRelay: () => restarted.promise });

    const first = commands.webProxyRelayRestart(run.context);
    await expect(commands.webProxyRelayRestart(run.context)).rejects.toMatchObject({
      problem: "relay_busy",
    });
    await expect(commands.webProxyRelayEvidence(run.context, NONCE)).rejects.toMatchObject({
      problem: "relay_busy",
    });
    restarted.resolve();
    await first;
  });

  it("leaves a stack whose restart failed failed for every later command", async () => {
    const { log, run, commands } = await startedRelay({
      restartRelay: () => Promise.reject(new Error("/tmp/relay")),
    });

    await expect(commands.webProxyRelayRestart(run.context)).rejects.toMatchObject({
      problem: "relay_restart_failed",
      message: "The relay did not come back",
    });
    for (const call of [
      commands.webProxyRelayBridge(run.context),
      commands.webProxyRelayRestart(run.context),
      commands.webProxyRelayEvidence(run.context, NONCE),
    ]) {
      await expect(call).rejects.toMatchObject({ problem: "relay_failed" });
    }
    await run.close();
    expect(log.filter((entry) => entry === "stack-close")).toHaveLength(1);
  });

  it("refuses after the run closed", async () => {
    const { run, commands } = await startedRelay();

    await run.close();

    await expect(commands.webProxyRelayRestart(run.context)).rejects.toMatchObject({
      problem: "relay_closed",
    });
  });

  it("stays closed when the run closes during a restart", async () => {
    const restarted = deferred<void>();
    const { log, run, commands } = await startedRelay({ restartRelay: () => restarted.promise });

    const call = commands.webProxyRelayRestart(run.context);
    await run.close();
    restarted.resolve();

    await expect(call).rejects.toMatchObject({ problem: "relay_closed" });
    await expect(commands.webProxyRelayEvidence(run.context, NONCE)).rejects.toMatchObject({
      problem: "relay_closed",
    });
    expect(log.filter((entry) => entry === "stack-close")).toHaveLength(1);
  });
});

describe("webProxyRelayEvidence command", () => {
  it("passes the nonce and copies both legs and the host totals field by field", async () => {
    const raw = {
      clientLeg: legEvidence({ payload: "AAAA" }),
      daemonLeg: legEvidence(),
      host: hostTotals(HOST_STATS_EXTRAS),
      offer: { serverId: SERVER_ID },
    };
    const received: unknown[] = [];
    const { run, commands } = await startedRelay({
      evidence: (markers: unknown) => {
        received.push(markers);
        return raw;
      },
    });

    const evidence = await commands.webProxyRelayEvidence(run.context, NONCE);

    expect(received).toEqual([{ nonce: NONCE }]);
    expect(evidence).toEqual({
      clientLeg: legEvidence(),
      daemonLeg: legEvidence(),
      host: { connections: 3, authenticatedConnections: 2, sessionsOpened: 2 },
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(HOST_TOKEN);
    expect(serialized).not.toContain(SERVER_ID);
    expect(evidence.host).not.toBe(raw.host);
    expect(evidence.clientLeg.contains.token).not.toBe(raw.clientLeg.contains.token);
    expect(evidence.clientLeg.handshake).not.toBe(raw.clientLeg.handshake);
  });

  it.each([
    ["too short", "nonce"],
    ["too long", "n".repeat(65)],
    ["outside the alphabet", "nonce with space"],
    ["not a string", 12_345_678],
  ])("refuses a nonce %s without reading the taps", async (_case, nonce) => {
    const { log, run, commands } = await startedRelay();

    await expect(commands.webProxyRelayEvidence(run.context, nonce)).rejects.toMatchObject({
      problem: "invalid_nonce",
    });
    expect(log.some((entry) => entry.startsWith("evidence:"))).toBe(false);
  });

  it("refuses before any start", async () => {
    const log: string[] = [];
    const run = fakeRun({ module: stackModule(log, async () => canonicalStack(log)), log });

    await expect(
      relayCommands(log).webProxyRelayEvidence(run.context, NONCE),
    ).rejects.toMatchObject({ problem: "relay_not_started" });
  });

  it("reports a stack that refused, without its message", async () => {
    const { run, commands } = await startedRelay({
      evidence: () => {
        throw new Error("tap memory /tmp/x");
      },
    });

    await expect(commands.webProxyRelayEvidence(run.context, NONCE)).rejects.toMatchObject({
      problem: "relay_evidence_failed",
      message: "The relay stack refused the evidence",
    });
  });

  it.each([
    ["a negative count", { messages: -1 }],
    ["a fractional count", { connections: 1.5 }],
    ["an unknown handshake name", { handshake: ["e2ee_hello", "relay_hello"] }],
    ["a byte count that is a string", { bytes: { toTarget: "900", fromTarget: 1200 } }],
    ["an overflow on an unknown direction", { overflow: { direction: "both", limit: 10 } }],
    [
      "a marker without its direction",
      { contains: { nonce: { toTarget: false }, token: {}, hello: {} } },
    ],
    [
      "a marker that is not a boolean",
      { contains: { ...legEvidence().contains, hello: { toTarget: 0, fromTarget: false } } },
    ],
  ])("refuses evidence with %s", async (_case, patch) => {
    const { run, commands } = await startedRelay({
      evidence: () => ({
        clientLeg: legEvidence(patch),
        daemonLeg: legEvidence(),
        host: hostTotals(),
      }),
    });

    await expect(commands.webProxyRelayEvidence(run.context, NONCE)).rejects.toMatchObject({
      problem: "relay_result_invalid",
    });
  });

  it("accepts an overflow with its direction and limit", async () => {
    const overflow = { direction: "fromTarget", limit: 1_048_576 };
    const { run, commands } = await startedRelay({
      evidence: () => ({
        clientLeg: legEvidence({ overflow }),
        daemonLeg: legEvidence(),
        host: hostTotals(),
      }),
    });

    const evidence = await commands.webProxyRelayEvidence(run.context, NONCE);

    expect(evidence.clientLeg.overflow).toEqual(overflow);
  });

  it.each([
    ["zero", 0],
    ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
  ])("accepts host totals of %s", async (_case, value) => {
    const host = { connections: value, authenticatedConnections: value, sessionsOpened: value };
    const { run, commands } = await startedRelay({
      evidence: () => ({ clientLeg: legEvidence(), daemonLeg: legEvidence(), host }),
    });

    const evidence = await commands.webProxyRelayEvidence(run.context, NONCE);

    expect(evidence.host).toEqual(host);
  });

  it.each(INVALID_HOST_TOTALS)("refuses host totals with %s", async (_case, host) => {
    const { run, commands } = await startedRelay({
      evidence: () => ({ clientLeg: legEvidence(), daemonLeg: legEvidence(), host }),
    });

    await expect(commands.webProxyRelayEvidence(run.context, NONCE)).rejects.toMatchObject({
      problem: "relay_result_invalid",
    });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["a number", 3],
    ["an array of the totals", [3, 2, 2]],
  ])("refuses evidence whose host is %s", async (_case, host) => {
    const { run, commands } = await startedRelay({
      evidence: () => ({ clientLeg: legEvidence(), daemonLeg: legEvidence(), host }),
    });

    await expect(commands.webProxyRelayEvidence(run.context, NONCE)).rejects.toMatchObject({
      problem: "relay_result_invalid",
    });
  });
});

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
