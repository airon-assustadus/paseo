/* eslint-disable max-nested-callbacks */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { EngineExitReason, ManagedRemoteBrowserEngine, ProcessUsage } from "./engine.js";
import { RemoteBrowserManager } from "./remote-browser-manager.js";

const MIB = 1024 * 1024;
const viewport = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, touch: true };
const input = { viewport, renderScale: 2, initialUrl: null };

function usageOf(memoryBytes: number, processCount: number): ProcessUsage {
  return { rssBytes: memoryBytes, pssBytes: null, memoryBytes, cpuMs: 0, processCount };
}

interface FakeEngine extends ManagedRemoteBrowserEngine {
  usage: ProcessUsage;
  terminated: EngineExitReason[];
  closes: number;
  finishClose(): void;
}

function fakeEngine(): FakeEngine {
  const exitListeners = new Set<(reason: EngineExitReason) => void>();
  let finish: () => void = () => {};
  let closing: Promise<void> | null = null;
  const engine: FakeEngine = {
    usage: usageOf(100 * MIB, 3),
    terminated: [],
    closes: 0,
    finishClose: () => finish(),
    state: {
      url: "",
      title: "",
      canGoBack: false,
      canGoForward: false,
      loading: false,
      error: null,
      focusedEditable: null,
      notice: null,
    },
    onStateChange: () => () => {},
    onFrame: () => () => {},
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    navigate: async () => {},
    dispatch: async () => {},
    refreshFocus: async () => null,
    setViewport: async () => {},
    startScreencast: async () => {},
    stopScreencast: async () => {},
    metrics: () => ({
      ...engine.usage,
      proxyBytesUp: 0,
      proxyBytesDown: 0,
      proxyConnections: 0,
      proxyRequestShapes: { connects: 0, plainRequests: 0, upgrades: {} },
      proxyRecentDials: [],
      browserInternalRefused: [],
    }),
    sampleProcesses: async () => engine.usage,
    processIdentities: () => [],
    terminate: (reason) => {
      engine.terminated.push(reason);
      void engine.close();
      for (const listener of exitListeners) listener(reason);
    },
    close: () => {
      engine.closes += 1;
      closing ??= new Promise<void>((resolve) => {
        finish = resolve;
      });
      return closing;
    },
  };
  return engine;
}

function gate(): { wait: Promise<void>; open(): void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

function createManager(
  limits: Partial<ConstructorParameters<typeof RemoteBrowserManager>[0]["limits"]> = {},
) {
  const engines: FakeEngine[] = [];
  const manager = new RemoteBrowserManager({
    logger: pino({ level: "silent" }),
    limits: { sampleIntervalMs: 60_000, ...limits },
    launch: async () => {
      const engine = fakeEngine();
      engines.push(engine);
      return engine;
    },
  });
  return { manager, engines };
}

describe("RemoteBrowserManager", () => {
  it("keeps a closing browser's slot until its processes are gone", async () => {
    const { manager, engines } = createManager({ maxBrowsers: 1 });
    const engine = await manager.launch(input);
    const closing = manager.closeBrowser(engine);
    await expect(manager.launch(input)).rejects.toThrow(/Too many/);
    expect(manager.activeCount).toBe(1);
    engines[0].finishClose();
    await closing;
    expect(manager.activeCount).toBe(0);
    await expect(manager.launch(input)).resolves.toBeDefined();
  });

  it("closes a browser over its limit after consecutive samples and keeps it counted while closing", async () => {
    const { manager, engines } = createManager({
      perBrowserMemoryBytes: 500 * MIB,
      overLimitSamples: 2,
    });
    await manager.launch(input);
    engines[0].usage = usageOf(600 * MIB, 4);
    await manager.sample();
    expect(engines[0].terminated).toEqual([]);
    await manager.sample();
    expect(engines[0].terminated).toEqual(["memory_limit"]);
    await manager.sample();
    expect(engines[0].terminated).toEqual(["memory_limit"]);
    expect(manager.aggregateMemoryBytes).toBe(600 * MIB);
    engines[0].finishClose();
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.activeCount).toBe(0);
  });

  it("terminates the largest live browser over the aggregate ceiling, once", async () => {
    const { manager, engines } = createManager({
      aggregateMemoryBytes: 1000 * MIB,
      perBrowserMemoryBytes: 10_000 * MIB,
    });
    await manager.launch(input);
    await manager.launch(input);
    engines[0].usage = usageOf(400 * MIB, 2);
    engines[1].usage = usageOf(700 * MIB, 2);
    await manager.sample();
    expect(engines[1].terminated).toEqual(["memory_limit"]);
    expect(engines[0].terminated).toEqual([]);
    await manager.sample();
    expect(engines[0].terminated).toEqual([]);
  });

  it("refuses to open above the memory headroom, counting closing browsers", async () => {
    const { manager, engines } = createManager({
      aggregateMemoryBytes: 1000 * MIB,
      openHeadroom: 0.8,
    });
    const engine = await manager.launch(input);
    engines[0].usage = usageOf(900 * MIB, 2);
    await manager.sample();
    void manager.closeBrowser(engine);
    await expect(manager.launch(input)).rejects.toThrow(/too much memory/);
  });

  it("closes every browser on shutdown and refuses new ones", async () => {
    const { manager, engines } = createManager();
    await manager.launch(input);
    await manager.launch(input);
    const closing = manager.close();
    await vi.waitFor(() => expect(engines.map((engine) => engine.closes)).toEqual([1, 1]));
    for (const engine of engines) engine.finishClose();
    await closing;
    expect(engines.map((engine) => engine.closes)).toEqual([1, 1]);
    expect(manager.available).toBe(false);
    await expect(manager.launch(input)).rejects.toThrow(/unavailable/);
  });

  it("is unavailable on Windows", () => {
    const manager = new RemoteBrowserManager({
      logger: pino({ level: "silent" }),
      platform: "win32",
      env: {},
    });
    expect(manager.available).toBe(false);
    expect(manager.executable).toEqual({ kind: "unsupported_platform" });
  });

  it("waits for a launch in progress, and its cleanup, before shutdown resolves", async () => {
    const launchGate = gate();
    const engine = fakeEngine();
    const manager = new RemoteBrowserManager({
      logger: pino({ level: "silent" }),
      limits: { sampleIntervalMs: 60_000 },
      launch: async () => {
        await launchGate.wait;
        return engine;
      },
    });
    const launching = manager.launch(input);
    launching.catch(() => undefined);
    let closed = false;
    const closing = manager.close().then(() => {
      closed = true;
      return closed;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    launchGate.open();
    await vi.waitFor(() => expect(engine.closes).toBe(1));
    await Promise.resolve();
    expect(closed).toBe(false);
    engine.finishClose();
    await closing;
    await expect(launching).rejects.toThrow(/unavailable/);
  });

  it("opens the initial page only after the browser is tracked and watched", async () => {
    let trackedDuringNavigation = -1;
    const engine = fakeEngine();
    const manager = new RemoteBrowserManager({
      logger: pino({ level: "silent" }),
      limits: { sampleIntervalMs: 60_000 },
      launch: async (launchInput) => {
        expect(launchInput.initialUrl).toBeNull();
        engine.navigate = async () => {
          trackedDuringNavigation = manager.activeCount;
        };
        return engine;
      },
    });
    await manager.launch({ ...input, initialUrl: "http://localhost:3000/" });
    expect(trackedDuringNavigation).toBe(1);
  });
});
