import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createShellBundler,
  createWebProxyBridgeCommand,
  resolveAppEsbuild,
  type BridgeCommandContext,
  type BridgeHostOptions,
} from "./vitest.web-proxy-bridge";

const HOST_MODULE = "/fake/bridge-host.ts";
const TOKEN = "t".repeat(43);

interface FakeRun {
  context: BridgeCommandContext;
  log: string[];
  /** What Vitest does when the run ends. */
  close(): Promise<void>;
}

function fakeRun(input: { module: unknown; local?: string[] | null; log?: string[] }): FakeRun {
  const log = input.log ?? [];
  const closers: Array<() => Promise<void>> = [];
  const local = input.local === undefined ? ["http://localhost:63315/"] : input.local;
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

function hostModule(log: string[], start: (options: BridgeHostOptions) => Promise<unknown>) {
  return {
    startBridgeHost: async (options: BridgeHostOptions) => {
      log.push("host-start");
      return start(options);
    },
  };
}

function healthyHost(log: string[], overrides: Record<string, unknown> = {}) {
  return {
    url: "ws://127.0.0.1:40000/bridge",
    contentOrigins: ["http://wp-a.localhost:40001", "http://wp-b.localhost:40001"],
    close: async () => {
      log.push("host-close");
    },
    ...overrides,
  };
}

function bridgeCommand(log: string[]) {
  return createWebProxyBridgeCommand({
    hostModulePath: HOST_MODULE,
    bundleShell: async () => {
      log.push("bundle");
      return { bootstrapJs: "export {};", workerJs: "export {};" };
    },
    createToken: () => TOKEN,
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
  it("starts nothing until a test calls it, then registers cleanup before anything opens", async () => {
    const log: string[] = [];
    const run = fakeRun({ module: hostModule(log, async () => healthyHost(log)), log });
    const command = bridgeCommand(log);

    expect(log).toEqual([]);
    const info = await command(run.context);

    expect(log).toEqual(["register-cleanup", "bundle", `import:${HOST_MODULE}`, "host-start"]);
    expect(info).toEqual({
      url: "ws://127.0.0.1:40000/bridge",
      token: TOKEN,
      allowedOrigin: "http://localhost:63315",
      contentOrigins: ["http://wp-a.localhost:40001", "http://wp-b.localhost:40001"],
    });
  });

  it("coalesces calls within one Vitest run and starts again for another run", async () => {
    const log: string[] = [];
    const module = hostModule(log, async () => healthyHost(log));
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

  it("closes the host when the Vitest run closes", async () => {
    const log: string[] = [];
    const run = fakeRun({ module: hostModule(log, async () => healthyHost(log)), log });

    await bridgeCommand(log)(run.context);
    await run.close();
    await run.close();

    expect(log.filter((entry) => entry === "host-close")).toHaveLength(1);
  });

  it("hands the host the exact origin of the browser server and the token", async () => {
    const log: string[] = [];
    const received: BridgeHostOptions[] = [];
    const module = hostModule(log, async (options) => {
      received.push(options);
      return healthyHost(log);
    });
    const run = fakeRun({ module, log, local: ["http://localhost:63315/__vitest__/"] });

    await bridgeCommand(log)(run.context);

    expect(received).toEqual([
      {
        shell: { bootstrapJs: "export {};", workerJs: "export {};" },
        allowedOrigin: "http://localhost:63315",
        token: TOKEN,
      },
    ]);
  });

  it("refuses to start without a browser server URL, before bundling or importing", async () => {
    const log: string[] = [];
    const run = fakeRun({
      module: hostModule(log, async () => healthyHost(log)),
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
    const run = fakeRun({ module: hostModule(log, async () => healthyHost(log)), log });

    await expect(bridgeCommand(log)(run.context, "/etc/passwd")).rejects.toMatchObject({
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

  it.each([
    ["a non-loopback URL", { url: "ws://10.0.0.5:40000/bridge" }],
    ["a secure scheme it cannot serve", { url: "wss://127.0.0.1:40000/bridge" }],
    ["a content origin outside localhost", { contentOrigins: ["http://evil.example:40001"] }],
    ["no content origins", { contentOrigins: [] }],
  ])("closes a started host that returned %s", async (_case, overrides) => {
    const log: string[] = [];
    const run = fakeRun({ module: hostModule(log, async () => healthyHost(log, overrides)), log });

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
    pending.resolve(healthyHost(log));

    await expect(call).rejects.toMatchObject({ problem: "closed_during_start" });
    expect(log.at(-1)).toBe("host-close");
  });
});

describe("shell bundler", () => {
  const appRoot = path.dirname(new URL(import.meta.url).pathname);

  it("uses the esbuild version the app declares", () => {
    const manifest: { devDependencies: Record<string, string> } = JSON.parse(
      readFileSync(path.join(appRoot, "package.json"), "utf8"),
    );

    expect(resolveAppEsbuild(appRoot).version).toBe(manifest.devDependencies.esbuild);
  });

  it("bundles the shell's fixed entries into library modules with the app's esbuild", async () => {
    const bundle = await createShellBundler(appRoot)();

    expect(bundle.bootstrapJs).toMatch(/export\s*\{[^}]*\bstartShellBootstrap\b/);
    expect(bundle.workerJs).toMatch(/export\s*\{[^}]*\binstallShellWorker\b/);
    expect(bundle.bootstrapJs).not.toMatch(/from\s*["']\.\.?\//);
    expect(bundle.workerJs).not.toMatch(/from\s*["']\.\.?\//);
  });
});
