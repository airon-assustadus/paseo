import type pino from "pino";
import { launchChromiumEngine } from "./chromium-engine.js";
import { findRemoteBrowserExecutable, type ExecutableLookupResult } from "./chromium-executable.js";
import {
  RemoteBrowserLimitError,
  RemoteBrowserUnavailableError,
  type EngineLaunchInput,
  type ManagedRemoteBrowserEngine,
  type RemoteBrowserEngine,
} from "./engine.js";
import { createProcessTable } from "./process-tree.js";

const MIB = 1024 * 1024;

export interface RemoteBrowserManagerLimits {
  maxBrowsers: number;
  perBrowserMemoryBytes: number;
  aggregateMemoryBytes: number;
  /** Opening is refused above this share of the aggregate ceiling. */
  openHeadroom: number;
  sampleIntervalMs: number;
  /** Consecutive samples above the per-browser limit before it is closed. */
  overLimitSamples: number;
}

export const DEFAULT_REMOTE_BROWSER_MANAGER_LIMITS: RemoteBrowserManagerLimits = {
  maxBrowsers: 4,
  perBrowserMemoryBytes: 1536 * MIB,
  aggregateMemoryBytes: 3072 * MIB,
  openHeadroom: 0.8,
  sampleIntervalMs: 2000,
  overLimitSamples: 2,
};

export interface RemoteBrowserManagerOptions {
  logger: pino.Logger;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  limits?: Partial<RemoteBrowserManagerLimits>;
  /** Replaces Chromium in tests. */
  launch?: (input: EngineLaunchInput) => Promise<ManagedRemoteBrowserEngine>;
}

interface Tracked {
  engine: ManagedRemoteBrowserEngine;
  /** Last measured summed RSS of the browser's verified processes. */
  memoryBytes: number;
  overLimit: number;
  /** Set once closing starts; the entry still counts until its processes are gone. */
  closing: Promise<void> | null;
}

/**
 * Daemon-wide owner of remote browsers: executable discovery, the global browser count, the
 * per-browser and aggregate memory watchdog, the set of active proxy ports, and shutdown.
 * A browser keeps its slot and its last measured memory until its close sequence finished, so a
 * close followed by an open cannot exceed the ceilings while the old process tree still lives.
 */
export class RemoteBrowserManager {
  readonly executable: ExecutableLookupResult;
  private readonly logger: pino.Logger;
  private readonly limits: RemoteBrowserManagerLimits;
  private readonly launchEngine: (input: EngineLaunchInput) => Promise<ManagedRemoteBrowserEngine>;
  private readonly tracked = new Set<Tracked>();
  private readonly proxyPorts = new Set<number>();
  private launching = 0;
  /** Opens in progress; shutdown waits for them so no browser outlives the daemon. */
  private readonly pendingLaunches = new Set<Promise<unknown>>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private sampling = false;
  private closed = false;

  constructor(options: RemoteBrowserManagerOptions) {
    this.logger = options.logger.child({ module: "remote-browser" });
    this.limits = { ...DEFAULT_REMOTE_BROWSER_MANAGER_LIMITS, ...options.limits };
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    this.executable = options.launch
      ? { kind: "found", path: "(injected)" }
      : findRemoteBrowserExecutable({ platform, env });
    if (options.launch) {
      this.launchEngine = options.launch;
    } else {
      const processTable = createProcessTable(platform);
      this.launchEngine = (input) => {
        if (this.executable.kind !== "found") {
          return Promise.reject(new RemoteBrowserUnavailableError("No Chrome or Chromium found"));
        }
        return launchChromiumEngine(
          {
            executable: this.executable.path,
            logger: this.logger,
            processTable,
            deniedProxyPorts: () => this.proxyPorts,
            onProxyPort: (port, active) => {
              if (active) this.proxyPorts.add(port);
              else this.proxyPorts.delete(port);
            },
            parentEnv: env,
          },
          input,
        );
      };
    }
  }

  get available(): boolean {
    return this.executable.kind === "found" && !this.closed;
  }

  /** Browsers holding a slot, including those whose close sequence is still running. */
  get activeCount(): number {
    return this.tracked.size;
  }

  get aggregateMemoryBytes(): number {
    let total = 0;
    for (const entry of this.tracked) total += entry.memoryBytes;
    return total;
  }

  launch(input: EngineLaunchInput): Promise<RemoteBrowserEngine> {
    const launching = this.launchTracked(input);
    this.pendingLaunches.add(launching);
    const forget = () => this.pendingLaunches.delete(launching);
    launching.then(forget, forget);
    return launching;
  }

  private async launchTracked(input: EngineLaunchInput): Promise<RemoteBrowserEngine> {
    if (!this.available) throw new RemoteBrowserUnavailableError("Remote browser is unavailable");
    if (this.tracked.size + this.launching >= this.limits.maxBrowsers) {
      throw new RemoteBrowserLimitError("Too many remote browsers on this host");
    }
    if (this.aggregateMemoryBytes > this.limits.aggregateMemoryBytes * this.limits.openHeadroom) {
      throw new RemoteBrowserLimitError("Remote browsers are using too much memory");
    }
    this.launching += 1;
    let engine: ManagedRemoteBrowserEngine;
    try {
      // The engine starts on about:blank; page content loads only once it is tracked below.
      engine = await this.launchEngine({ ...input, initialUrl: null });
    } finally {
      this.launching -= 1;
    }
    const entry: Tracked = { engine, memoryBytes: 0, overLimit: 0, closing: null };
    this.tracked.add(entry);
    if (this.closed) {
      await this.finish(entry);
      throw new RemoteBrowserUnavailableError("Remote browser is unavailable");
    }
    // A crash or watchdog termination already started the engine's own close; wait for it.
    engine.onExit(() => {
      void this.finish(entry);
    });
    this.ensureWatchdog();
    if (input.initialUrl) {
      // Tracked and watched: a hostile first page is already under the memory limits.
      try {
        await engine.navigate({ kind: "url", url: input.initialUrl }, new AbortController().signal);
      } catch (error) {
        await this.finish(entry);
        throw error;
      }
    }
    return engine;
  }

  /** Runs the bounded close sequence; the slot is released only when it has finished. */
  async closeBrowser(engine: RemoteBrowserEngine): Promise<void> {
    const entry = [...this.tracked].find((candidate) => candidate.engine === engine);
    if (!entry) {
      await engine.close();
      return;
    }
    await this.finish(entry);
  }

  /** One watchdog tick; exposed for tests. */
  async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      for (const entry of this.tracked) {
        const usage = await entry.engine.sampleProcesses().catch(() => null);
        if (!usage) continue;
        entry.memoryBytes = usage.memoryBytes;
        if (entry.closing) continue;
        entry.overLimit =
          usage.memoryBytes > this.limits.perBrowserMemoryBytes ? entry.overLimit + 1 : 0;
        if (entry.overLimit >= this.limits.overLimitSamples) {
          this.logger.warn(
            { memoryBytes: usage.memoryBytes, rssBytes: usage.rssBytes },
            "Remote browser over its memory limit",
          );
          this.terminate(entry);
        }
      }
      // Only live browsers are terminated for the aggregate; closing ones are already going away.
      for (;;) {
        const live = [...this.tracked].filter((entry) => !entry.closing);
        const liveRss = live.reduce((total, entry) => total + entry.memoryBytes, 0);
        if (liveRss <= this.limits.aggregateMemoryBytes || live.length === 0) break;
        const largest = live.sort((a, b) => b.memoryBytes - a.memoryBytes)[0];
        this.logger.warn(
          { memoryBytes: largest.memoryBytes, aggregate: liveRss },
          "Remote browsers over the aggregate memory limit",
        );
        this.terminate(largest);
      }
    } finally {
      this.sampling = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    // A launch in progress finishes its own browser once it sees `closed`; wait for that too.
    await Promise.allSettled(this.pendingLaunches);
    await Promise.all([...this.tracked].map((entry) => this.finish(entry)));
    this.stopWatchdog();
  }

  private terminate(entry: Tracked): void {
    entry.engine.terminate("memory_limit");
    void this.finish(entry);
  }

  private finish(entry: Tracked): Promise<void> {
    entry.closing ??= entry.engine
      .close()
      .catch((error) => this.logger.warn({ err: error }, "Remote browser close failed"))
      .finally(() => {
        this.tracked.delete(entry);
        if (this.tracked.size === 0) this.stopWatchdog();
      });
    return entry.closing;
  }

  private ensureWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      void this.sample().catch((error) =>
        this.logger.warn({ err: error }, "Remote browser watchdog sample failed"),
      );
    }, this.limits.sampleIntervalMs);
    this.watchdog.unref?.();
  }

  private stopWatchdog(): void {
    if (!this.watchdog) return;
    clearInterval(this.watchdog);
    this.watchdog = null;
  }
}
