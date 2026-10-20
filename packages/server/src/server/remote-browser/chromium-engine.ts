import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type pino from "pino";
import type {
  RemoteBrowserNavigation,
  RemoteBrowserViewport,
} from "@getpaseo/protocol/remote-browser/rpc-schemas";
import { CdpConnection, CdpError, type CdpEvent } from "./cdp-connection.js";
import { assertSafeChromiumArgs, buildChromiumArgs, buildChromiumEnv } from "./chromium-launch.js";
import { RemoteBrowserEgressProxy } from "./egress-proxy.js";
import {
  RemoteBrowserUnavailableError,
  parseNavigableUrl,
  type EngineExitReason,
  type EngineFrame,
  type EngineLaunchInput,
  type EngineMetrics,
  type EnginePageState,
  type ManagedRemoteBrowserEngine,
  type ProcessUsage,
  type ScreencastParams,
} from "./engine.js";
import type { CdpCommand } from "./input-mapping.js";
import { ProcessTreeTracker, type ProcessIdentity, type ProcessTable } from "./process-tree.js";
import { boundPageState } from "./state-budget.js";

export interface ChromiumEngineConfig {
  executable: string;
  logger: pino.Logger;
  processTable: ProcessTable;
  deniedProxyPorts: () => ReadonlySet<number>;
  onProxyPort: (port: number, active: boolean) => void;
  tempRoot?: string;
  parentEnv?: NodeJS.ProcessEnv;
  launchTimeoutMs?: number;
  commandTimeoutMs?: number;
  navigationTimeoutMs?: number;
  maxCdpInFlight?: number;
  maxConsecutiveCdpTimeouts?: number;
  proxy?: {
    maxConnections: number;
    maxHeadBytes: number;
    headTimeoutMs: number;
    connectTimeoutMs: number;
  };
  closeGraceMs?: number;
  terminateGraceMs?: number;
}

const DEFAULTS = {
  launchTimeoutMs: 15_000,
  commandTimeoutMs: 10_000,
  navigationTimeoutMs: 30_000,
  maxCdpInFlight: 32,
  maxConsecutiveCdpTimeouts: 3,
  proxy: {
    maxConnections: 256,
    maxHeadBytes: 64 * 1024,
    headTimeoutMs: 10_000,
    connectTimeoutMs: 10_000,
  },
  closeGraceMs: 2_000,
  terminateGraceMs: 5_000,
};

/** Profile preferences of the temporary profile; 2 = never predict (no preconnect/prefetch). */
const CHROMIUM_PREFERENCES = {
  net: { network_prediction_options: 2 },
  search: { suggest_enabled: false },
  // Without a default search engine, omnibox services have nothing to contact.
  default_search_provider: { enabled: false },
};

const FOCUS_WORLD = "paseo-remote-focus";
/**
 * Daemon-owned constant evaluated in an isolated world; never built from client input. It reports
 * the focused editable's hints, a per-document focus token and whether it is composing. The token
 * changes on every focusin (listeners live in the isolated world, invisible to the page) and when
 * the focused element differs from the last probe. No element identity, name or value is returned.
 * It also reads document.title: Chromium reports title changes in targetInfoChanged only lazily.
 */
const FOCUS_PROBE = `(() => {
  const g = globalThis;
  const st = g.__paseoFocus || (g.__paseoFocus = { token: 1, composing: false, last: null, docs: new WeakSet() });
  const watch = (doc) => {
    if (st.docs.has(doc)) return;
    st.docs.add(doc);
    doc.addEventListener("focusin", () => { st.token += 1; st.composing = false; }, true);
    doc.addEventListener("compositionstart", () => { st.composing = true; }, true);
    doc.addEventListener("compositionend", () => { st.composing = false; }, true);
  };
  watch(document);
  const title = String(document.title || "").slice(0, 2048);
  let element = document.activeElement;
  for (;;) {
    if (element && element.shadowRoot && element.shadowRoot.activeElement) { element = element.shadowRoot.activeElement; continue; }
    if (element && (element.tagName === "IFRAME" || element.tagName === "FRAME")) {
      let inner = null;
      try { inner = element.contentDocument; } catch { inner = null; }
      if (inner) { watch(inner); element = inner.activeElement; continue; }
    }
    break;
  }
  const previous = st.last ? st.last.deref() : null;
  if (element !== previous) { st.token += 1; st.last = element ? new WeakRef(element) : null; }
  if (!element || element === document.body) return { title, token: st.token, editable: false };
  const tag = element.tagName;
  const editable = element.isContentEditable || tag === "TEXTAREA" ||
    (tag === "INPUT" && !["button","checkbox","color","file","hidden","image","radio","range","reset","submit"].includes(element.type));
  if (!editable) return { title, token: st.token, editable: false };
  return { title, token: st.token, editable: true, composing: st.composing, inputMode: String(element.inputMode || ""), inputType: String(element.type || (element.isContentEditable ? "contenteditable" : "text")), enterKeyHint: String(element.enterKeyHint || "") };
})()`;

/**
 * Blink PermissionDescriptors (permission_descriptor.idl), denied for every origin of the page's
 * context. Essential ones must be accepted by Chromium or the browser does not open; the rest
 * vary across versions and are denied when the running Chromium knows them.
 */
const ESSENTIAL_DENIED_PERMISSIONS: ReadonlyArray<Record<string, unknown>> = [
  { name: "geolocation" },
  { name: "notifications" },
  { name: "camera" },
  { name: "microphone" },
  { name: "clipboard-read" },
  { name: "clipboard-write" },
  { name: "midi", sysex: true },
  { name: "display-capture" },
];
const OPTIONAL_DENIED_PERMISSIONS: ReadonlyArray<Record<string, unknown>> = [
  { name: "midi", sysex: false },
  { name: "push", userVisibleOnly: true },
  { name: "background-sync" },
  { name: "background-fetch" },
  { name: "periodic-background-sync" },
  { name: "accelerometer" },
  { name: "gyroscope" },
  { name: "magnetometer" },
  { name: "ambient-light-sensor" },
  { name: "idle-detection" },
  { name: "storage-access" },
  { name: "top-level-storage-access" },
  { name: "local-fonts" },
  { name: "window-management" },
  { name: "payment-handler" },
  { name: "screen-wake-lock" },
  { name: "system-wake-lock" },
  { name: "keyboard-lock" },
  { name: "pointer-lock" },
  { name: "captured-surface-control" },
  { name: "speaker-selection" },
  { name: "local-network-access" },
  { name: "web-app-installation" },
];

const MAX_PENDING_POPUPS = 4;
const POPUP_URL_WAIT_MS = 5_000;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try {
    await once(child, "exit", { signal: AbortSignal.timeout(ms) });
    return true;
  } catch {
    return child.exitCode !== null || child.signalCode !== null;
  }
}

function mobileUserAgent(userAgent: string, mobile: boolean): string {
  const base = userAgent.replace("HeadlessChrome/", "Chrome/");
  if (!mobile || base.includes(" Mobile")) return base;
  return base.replace(/ Safari\//, " Mobile Safari/");
}

function loadErrorCode(errorText: string, proxyReason: number | null): string {
  if (proxyReason !== null) {
    switch (proxyReason) {
      case 2:
        return "policy_denied";
      case 3:
        return "network_unreachable";
      case 4:
        return "host_not_found";
      case 5:
        return "connection_refused";
      case 6:
        return "timeout";
      default:
        return "failed";
    }
  }
  if (errorText.includes("CERT") || errorText.includes("SSL")) return "tls_error";
  if (errorText.includes("ABORTED")) return "aborted";
  if (errorText.includes("NAME_NOT_RESOLVED")) return "host_not_found";
  if (errorText.includes("CONNECTION_REFUSED")) return "connection_refused";
  if (errorText.includes("TIMED_OUT")) return "timeout";
  return "failed";
}

/**
 * Launches a sandboxed Chromium for one remote browser: temp profile and HOME, a dedicated egress
 * proxy, CDP over the pipe, one isolated browser context and one page.
 */
export async function launchChromiumEngine(
  config: ChromiumEngineConfig,
  input: EngineLaunchInput,
): Promise<ManagedRemoteBrowserEngine> {
  const settings = { ...DEFAULTS, ...config, proxy: config.proxy ?? DEFAULTS.proxy };
  const tempDir = await mkdtemp(path.join(config.tempRoot ?? os.tmpdir(), "paseo-remote-browser-"));
  const profileDir = path.join(tempDir, "profile");
  const homeDir = path.join(tempDir, "home");
  await mkdir(profileDir, { mode: 0o700 });
  await mkdir(homeDir, { mode: 0o700 });
  // No network prediction: Chromium would otherwise preconnect to its default search engine
  // from the page's context as soon as it exists.
  await mkdir(path.join(profileDir, "Default"), { mode: 0o700 });
  await writeFile(
    path.join(profileDir, "Default", "Preferences"),
    JSON.stringify(CHROMIUM_PREFERENCES),
    { mode: 0o600 },
  );
  // The page's browser context uses the policy proxy. The process-wide proxy refuses everything,
  // so browser-internal services (component updates, push, sync) cannot reach any network.
  const proxy = new RemoteBrowserEgressProxy({
    logger: config.logger,
    ...settings.proxy,
    deniedLocalPorts: config.deniedProxyPorts,
  });
  const browserProxy = new RemoteBrowserEgressProxy({
    logger: config.logger,
    ...settings.proxy,
    deniedLocalPorts: config.deniedProxyPorts,
    refuseAll: true,
  });
  const ports: number[] = [];
  // Once constructed, the engine owns cleanup: its close sequence releases proxies, ports and dir.
  let engine: ChromiumEngine | null = null;
  try {
    const proxyPort = await proxy.listen();
    ports.push(proxyPort);
    config.onProxyPort(proxyPort, true);
    const browserProxyPort = await browserProxy.listen();
    ports.push(browserProxyPort);
    config.onProxyPort(browserProxyPort, true);
    const args = buildChromiumArgs({
      userDataDir: profileDir,
      proxyPort: browserProxyPort,
      maxOldSpaceMb: 512,
      rendererProcessLimit: 2,
    });
    assertSafeChromiumArgs(args);
    const spawnedAt = Date.now();
    const child = spawn(config.executable, args, {
      detached: true,
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      env: buildChromiumEnv({ parentEnv: config.parentEnv ?? process.env, homeDir }),
    });
    engine = new ChromiumEngine({
      settings,
      child,
      proxy,
      proxyPort,
      browserProxy,
      browserProxyPort,
      tempDir,
      spawnedAt,
      config,
    });
    await engine.start(input);
    return engine;
  } catch (error) {
    if (engine) {
      await engine.close();
    } else {
      await proxy.close();
      await browserProxy.close();
      for (const port of ports) config.onProxyPort(port, false);
      await rm(tempDir, { recursive: true, force: true });
    }
    throw error;
  }
}

interface EngineParts {
  settings: typeof DEFAULTS & ChromiumEngineConfig;
  child: ChildProcess;
  proxy: RemoteBrowserEgressProxy;
  proxyPort: number;
  browserProxy: RemoteBrowserEgressProxy;
  browserProxyPort: number;
  tempDir: string;
  spawnedAt: number;
  config: ChromiumEngineConfig;
}

class ChromiumEngine implements ManagedRemoteBrowserEngine {
  state: EnginePageState = {
    url: "about:blank",
    title: "",
    canGoBack: false,
    canGoForward: false,
    loading: false,
    error: null,
    focusedEditable: null,
    notice: null,
  };
  private readonly parts: EngineParts;
  private readonly logger: pino.Logger;
  private readonly cdp: CdpConnection;
  private readonly stateListeners = new Set<() => void>();
  private readonly frameListeners = new Set<(frame: EngineFrame) => void>();
  private readonly exitListeners = new Set<(reason: EngineExitReason) => void>();
  private readonly pendingPopups = new Map<string, ReturnType<typeof setTimeout>>();
  private stderrTail = "";
  private tracker: ProcessTreeTracker | null = null;
  private lastMetrics: ProcessUsage = {
    rssBytes: 0,
    pssBytes: null,
    memoryBytes: 0,
    cpuMs: 0,
    processCount: 0,
  };
  private pageSession = "";
  private targetId = "";
  private mainFrameId = "";
  private focusContextId: number | null = null;
  private focusSerial = 0;
  private browserContextId = "";
  /** Start of the current main-frame navigation; proxy failures since then explain its error. */
  private navigationStartedAt = 0;
  private lastFocusKey = "";
  private screencasting = false;
  private pendingScreencast: { params: ScreencastParams; signal: AbortSignal } | null = null;
  private closing: Promise<void> | null = null;
  private exited = false;

  constructor(parts: EngineParts) {
    this.parts = parts;
    this.logger = parts.config.logger.child({ module: "remote-browser-engine" });
    const [, , stderr, output, input] = parts.child.stdio;
    (stderr as Readable).on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-4096);
    });
    this.cdp = new CdpConnection({
      output: output as Writable,
      input: input as Readable,
      maxInFlight: parts.settings.maxCdpInFlight,
      defaultTimeoutMs: parts.settings.commandTimeoutMs,
      maxConsecutiveTimeouts: parts.settings.maxConsecutiveCdpTimeouts,
      onUnresponsive: () => this.exit("internal_error"),
      onListenerError: (error, method) =>
        this.logger.warn({ err: error, method }, "Remote browser event handler failed"),
    });
    this.cdp.onEvent((event) => this.handleEvent(event));
    parts.child.once("exit", () => {
      this.cdp.close("Chromium exited");
      if (!this.closing) this.exit("crashed");
    });
  }

  async start(input: EngineLaunchInput): Promise<void> {
    const { child, settings } = this.parts;
    const spawnFailed = new Promise<never>((_resolve, reject) => {
      child.once("error", (error) => reject(new RemoteBrowserUnavailableError(error.message)));
      child.once("exit", () =>
        reject(new RemoteBrowserUnavailableError(this.describeLaunchFailure())),
      );
    });
    spawnFailed.catch(() => {});
    try {
      // Identity first: if the handshake never completes, close must still reach this tree.
      await Promise.race([this.recordRoot(), spawnFailed]);
      const version = await Promise.race([
        this.cdp.send("Browser.getVersion", {}, { timeoutMs: settings.launchTimeoutMs }),
        spawnFailed,
      ]);
      const context = await this.cdp.send("Target.createBrowserContext", {
        disposeOnDetach: true,
        proxyServer: `http://127.0.0.1:${this.parts.proxyPort}`,
        proxyBypassList: "<-loopback>",
      });
      const browserContextId = str(context.browserContextId);
      this.browserContextId = browserContextId;
      // eventsEnabled: newer Chromium reports denied downloads only as Browser.downloadWillBegin.
      await this.cdp.send("Browser.setDownloadBehavior", {
        behavior: "deny",
        browserContextId,
        eventsEnabled: true,
      });
      for (const permission of ESSENTIAL_DENIED_PERMISSIONS) {
        // A failure here aborts the launch: these must be denied, not assumed unknown.
        await this.cdp.send("Browser.setPermission", {
          permission,
          setting: "denied",
          browserContextId,
        });
      }
      for (const permission of OPTIONAL_DENIED_PERMISSIONS) {
        await this.cdp
          .send("Browser.setPermission", { permission, setting: "denied", browserContextId })
          .catch((error: unknown) =>
            this.logger.debug(
              { permission: permission.name, err: error },
              "Chromium does not know this permission",
            ),
          );
      }
      await this.cdp.send("Target.setDiscoverTargets", { discover: true });
      const target = await this.cdp.send("Target.createTarget", {
        url: "about:blank",
        browserContextId,
      });
      this.targetId = str(target.targetId);
      await this.closeStartupPages(browserContextId);
      const attached = await this.cdp.send("Target.attachToTarget", {
        targetId: this.targetId,
        flatten: true,
      });
      this.pageSession = str(attached.sessionId);
      await this.page("Page.enable");
      const tree = await this.page("Page.getFrameTree");
      this.mainFrameId = str(obj(obj(tree.frameTree).frame).id);
      await this.page("Page.setInterceptFileChooserDialog", { enabled: true });
      await this.page("Emulation.setFocusEmulationEnabled", { enabled: true });
      await this.page("Emulation.setUserAgentOverride", {
        userAgent: mobileUserAgent(str(version.userAgent), input.viewport.mobile),
      });
      await this.applyViewport(input.viewport, input.renderScale, new AbortController().signal);
    } catch (error) {
      await this.close();
      if (error instanceof RemoteBrowserUnavailableError) throw error;
      throw new RemoteBrowserUnavailableError(
        error instanceof CdpError ? this.describeLaunchFailure() : String(error),
      );
    }
  }

  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onFrame(listener: (frame: EngineFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onExit(listener: (reason: EngineExitReason) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async navigate(navigation: RemoteBrowserNavigation, signal: AbortSignal): Promise<void> {
    switch (navigation.kind) {
      case "url": {
        const url = parseNavigableUrl(navigation.url);
        if (!url) throw new RangeError("Only http and https URLs can be opened");
        this.navigationStartedAt = Date.now();
        this.update({ error: null, loading: true });
        const result = await this.page(
          "Page.navigate",
          { url },
          { signal, timeoutMs: this.parts.settings.navigationTimeoutMs },
        );
        const errorText = str(result.errorText);
        if (errorText) this.reportLoadError(url, errorText);
        return;
      }
      case "back":
      case "forward": {
        const history = await this.page("Page.getNavigationHistory", {}, { signal });
        const entries = Array.isArray(history.entries) ? history.entries.map(obj) : [];
        const index = Number(history.currentIndex);
        const target = entries[navigation.kind === "back" ? index - 1 : index + 1];
        if (!target) return;
        await this.page("Page.navigateToHistoryEntry", { entryId: target.id }, { signal });
        return;
      }
      case "reload":
        this.update({ error: null });
        await this.page("Page.reload", {}, { signal });
        return;
      case "stop":
        await this.page("Page.stopLoading", {}, { signal });
        return;
    }
  }

  async dispatch(command: CdpCommand, signal: AbortSignal): Promise<void> {
    await this.page(command.method, command.params, { signal });
  }

  async refreshFocus(signal: AbortSignal): Promise<number | null> {
    if (this.focusContextId === null) {
      const world = await this.page(
        "Page.createIsolatedWorld",
        { frameId: this.mainFrameId, worldName: FOCUS_WORLD, grantUniveralAccess: false },
        { signal },
      );
      this.focusContextId = Number(world.executionContextId);
    }
    const contextId = this.focusContextId;
    const evaluated = await this.page(
      "Runtime.evaluate",
      { expression: FOCUS_PROBE, contextId, returnByValue: true },
      { signal },
    ).catch((error: unknown): Record<string, unknown> => {
      if (error instanceof CdpError && error.kind === "aborted") throw error;
      // The world went away with its document; the next probe creates a new one.
      this.focusContextId = null;
      return {};
    });
    const value = obj(obj(evaluated.result).value);
    if (Object.keys(value).length === 0) return this.state.focusedEditable?.focusId ?? null;
    const title = str(value.title);
    if (title !== this.state.title && !this.state.url.startsWith("chrome-error:")) {
      this.update({ title });
    }
    // The daemon's focusId is monotonic across documents; the page token only within one.
    const key = `${contextId}:${Number(value.token)}`;
    if (key !== this.lastFocusKey) {
      this.lastFocusKey = key;
      this.focusSerial += 1;
    }
    const focused =
      value.editable === true
        ? {
            inputMode: str(value.inputMode),
            inputType: str(value.inputType),
            enterKeyHint: str(value.enterKeyHint),
            focusId: this.focusSerial,
            composing: value.composing === true,
          }
        : null;
    if (JSON.stringify(this.state.focusedEditable) !== JSON.stringify(focused)) {
      this.update({ focusedEditable: focused });
    }
    return focused?.focusId ?? null;
  }

  async setViewport(
    viewport: RemoteBrowserViewport,
    renderScale: number,
    signal: AbortSignal,
  ): Promise<void> {
    await this.applyViewport(viewport, renderScale, signal);
  }

  async startScreencast(params: ScreencastParams, signal: AbortSignal): Promise<void> {
    this.pendingScreencast = null;
    if (this.screencasting) {
      await this.page("Page.stopScreencast", {}, { signal });
      this.screencasting = false;
    }
    try {
      await this.page(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: params.quality,
          maxWidth: params.maxWidth,
          maxHeight: params.maxHeight,
          everyNthFrame: 1,
        },
        { signal },
      );
    } catch (error) {
      // During a cross-process navigation the frame has no active host until it commits.
      if (
        !(
          error instanceof CdpError &&
          error.kind === "protocol" &&
          /active page/i.test(error.message)
        )
      ) {
        throw error;
      }
      this.pendingScreencast = { params, signal };
      return;
    }
    this.screencasting = true;
  }

  /** Retries a screencast that was requested while the main frame had no active host. */
  private resumePendingScreencast(): void {
    const pending = this.pendingScreencast;
    if (!pending || pending.signal.aborted) return;
    void this.startScreencast(pending.params, pending.signal).catch((error: unknown) =>
      this.logger.debug({ err: error }, "Remote browser screencast retry failed"),
    );
  }

  async stopScreencast(): Promise<void> {
    this.pendingScreencast = null;
    if (!this.screencasting) return;
    this.screencasting = false;
    await this.page("Page.stopScreencast").catch(() => {});
  }

  metrics(): EngineMetrics {
    return {
      ...this.lastMetrics,
      proxyBytesUp: this.parts.proxy.metrics.bytesUp,
      proxyBytesDown: this.parts.proxy.metrics.bytesDown,
      proxyConnections: this.parts.proxy.metrics.connections,
      proxyRequestShapes: {
        connects: this.parts.proxy.metrics.connects,
        plainRequests: this.parts.proxy.metrics.plainRequests,
        upgrades: { ...this.parts.proxy.metrics.upgrades },
      },
      proxyRecentDials: [...this.parts.proxy.recentDials],
      browserInternalRefused: [...this.parts.browserProxy.recentDials],
    };
  }

  processIdentities(): ProcessIdentity[] {
    return this.tracker?.identities ?? [];
  }

  /** Samples the verified process set; used by the manager's watchdog. */
  async sampleProcesses(): Promise<ProcessUsage> {
    if (!this.tracker) return this.lastMetrics;
    const sample = await this.tracker.sample();
    this.lastMetrics = {
      rssBytes: sample.rssBytes,
      pssBytes: sample.pssBytes,
      // The contract's limits are on summed RSS; PSS is reported for diagnosis only.
      memoryBytes: sample.rssBytes,
      cpuMs: sample.cpuMs,
      processCount: sample.processCount,
    };
    return this.lastMetrics;
  }

  /** Called by the watchdog: the browser is closed and listeners hear the reason. */
  terminate(reason: EngineExitReason): void {
    this.exit(reason);
  }

  close(): Promise<void> {
    this.closing ??= this.runClose();
    return this.closing;
  }

  private async runClose(): Promise<void> {
    const { child, settings, proxy, proxyPort, browserProxy, browserProxyPort, tempDir, config } =
      this.parts;
    for (const timer of this.pendingPopups.values()) clearTimeout(timer);
    this.pendingPopups.clear();
    let exited = false;
    try {
      if (!this.cdp.closed) {
        await this.cdp
          .send("Browser.close", {}, { timeoutMs: settings.closeGraceMs })
          .catch(() => {});
      }
      exited = await waitForExit(child, settings.closeGraceMs);
      if (this.tracker) await this.tracker.sample().catch(() => undefined);
      if (!exited) {
        await this.tracker?.signal("SIGTERM").catch(() => 0);
        exited = await waitForExit(child, settings.terminateGraceMs);
      }
      // Helpers can outlive the root briefly; the verified set still identifies them exactly.
      if (this.tracker) {
        await this.tracker.sample().catch(() => undefined);
        await this.tracker.signal("SIGKILL").catch(() => 0);
      }
    } finally {
      this.cdp.close("Remote browser closed");
      await proxy.close().catch(() => undefined);
      await browserProxy.close().catch(() => undefined);
      config.onProxyPort(proxyPort, false);
      config.onProxyPort(browserProxyPort, false);
      await rm(tempDir, { recursive: true, force: true, maxRetries: 3 }).catch((error) =>
        this.logger.warn({ err: error }, "Remote browser temp dir removal failed"),
      );
      this.logger.debug({ exited }, "Remote browser engine closed");
    }
  }

  private exit(reason: EngineExitReason): void {
    // A close we started also detaches the page and ends the process; that is not a crash.
    if (this.exited || this.closing) return;
    this.exited = true;
    void this.close();
    for (const listener of this.exitListeners) listener(reason);
  }

  /**
   * The process opens an about:blank tab in its default context at startup. Only the page in the
   * isolated context is used, so the startup tab (and the renderer it keeps alive) is closed.
   */
  private async closeStartupPages(browserContextId: string): Promise<void> {
    const targets = await this.cdp.send("Target.getTargets");
    const infos = Array.isArray(targets.targetInfos) ? targets.targetInfos.map(obj) : [];
    for (const info of infos) {
      const targetId = str(info.targetId);
      if (
        str(info.type) === "page" &&
        targetId !== this.targetId &&
        str(info.browserContextId) !== browserContextId
      ) {
        await this.cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
      }
    }
  }

  /**
   * Records the root's exact identity. The child is ours from spawn() until it is reaped, so the
   * PID cannot be reused before this read; an exited child is simply not recorded.
   */
  private async recordRoot(): Promise<void> {
    const pid = this.parts.child.pid;
    if (pid === undefined) throw new RemoteBrowserUnavailableError("Chromium did not start");
    const entry = await this.parts.config.processTable.read(pid);
    if (!entry || this.parts.child.exitCode !== null || this.parts.child.signalCode !== null) {
      throw new RemoteBrowserUnavailableError("Chromium exited during launch");
    }
    this.tracker = new ProcessTreeTracker(
      { pid, startTime: entry.startTime },
      this.parts.config.processTable,
    );
  }

  private describeLaunchFailure(): string {
    if (/No usable sandbox|sandbox/i.test(this.stderrTail)) {
      return "Chromium could not enable its sandbox on this host";
    }
    return "Chromium failed to start";
  }

  private page(
    method: string,
    params: Record<string, unknown> = {},
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.cdp.send(method, params, { ...options, sessionId: this.pageSession });
  }

  /** Two writes, each checking `signal` right before it goes out. */
  private async applyViewport(
    viewport: RemoteBrowserViewport,
    renderScale: number,
    signal: AbortSignal,
  ): Promise<void> {
    await this.page(
      "Emulation.setDeviceMetricsOverride",
      {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: renderScale,
        mobile: viewport.mobile,
      },
      { signal },
    );
    await this.page(
      "Emulation.setTouchEmulationEnabled",
      { enabled: viewport.touch, maxTouchPoints: 5 },
      { signal },
    );
  }

  /** Page-controlled strings are bounded on arrival, so no raw value is kept or forwarded. */
  private update(patch: Partial<EnginePageState>): void {
    this.state = boundPageState({ ...this.state, ...patch });
    for (const listener of this.stateListeners) listener();
  }

  private notice(kind: string): void {
    this.update({ notice: { kind, at: Date.now() } });
  }

  private reportLoadError(url: string, errorText: string): void {
    let proxyReason: number | null = null;
    try {
      const parsed = new URL(url);
      const defaultPort = parsed.protocol === "https:" ? 443 : 80;
      const port = parsed.port ? Number(parsed.port) : defaultPort;
      proxyReason =
        this.parts.proxy.failureFor(parsed.hostname, port)?.reason ??
        this.parts.proxy.latestFailureSince(this.navigationStartedAt)?.reason ??
        null;
    } catch {
      proxyReason = null;
    }
    this.update({
      loading: false,
      error: { code: loadErrorCode(errorText, proxyReason), url, message: errorText },
    });
  }

  private async refreshHistory(): Promise<void> {
    const history = await this.page("Page.getNavigationHistory").catch(() => null);
    if (!history) return;
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const index = Number(history.currentIndex);
    this.update({ canGoBack: index > 0, canGoForward: index < entries.length - 1 });
  }

  private handleEvent(event: CdpEvent): void {
    const params = event.params;
    if (event.sessionId === this.pageSession) {
      this.handlePageEvent(event.method, params);
      return;
    }
    switch (event.method) {
      case "Target.targetInfoChanged": {
        const info = obj(params.targetInfo);
        if (str(info.targetId) === this.targetId) {
          const url = str(info.url);
          if (!url.startsWith("chrome-error:")) this.update({ url, title: str(info.title) });
          return;
        }
        this.followPopup(info);
        return;
      }
      case "Target.targetCreated":
        this.followPopup(obj(params.targetInfo));
        return;
      case "Browser.downloadWillBegin":
        this.notice("download_blocked");
        return;
      case "Target.targetCrashed":
        if (str(params.targetId) === this.targetId) {
          this.update({
            loading: false,
            error: { code: "crashed", url: this.state.url, message: "The page crashed" },
          });
        }
        return;
      case "Target.detachedFromTarget":
        if (str(params.sessionId) === this.pageSession) this.exit("crashed");
        return;
    }
  }

  private handlePageEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "Page.screencastFrame":
        this.deliverFrame(params);
        return;
      case "Page.frameStartedNavigating":
        if (str(params.frameId) === this.mainFrameId) this.navigationStartedAt = Date.now();
        return;
      case "Page.frameStartedLoading":
        if (str(params.frameId) === this.mainFrameId) this.update({ loading: true });
        return;
      case "Page.frameStoppedLoading":
        if (str(params.frameId) === this.mainFrameId) {
          this.update({ loading: false });
          // History read at frameNavigated can predate the committed index; read it again.
          void this.refreshHistory();
          this.resumePendingScreencast();
          void this.refreshFocus(new AbortController().signal).catch(() => {});
        }
        return;
      case "Page.frameNavigated":
        this.mainFrameNavigated(obj(params.frame));
        return;
      case "Page.navigatedWithinDocument":
        if (str(params.frameId) === this.mainFrameId) {
          this.update({ url: str(params.url) });
          void this.refreshHistory();
        }
        return;
      case "Page.javascriptDialogOpening": {
        const type = str(params.type);
        const accept = type === "alert" || type === "beforeunload";
        void this.page("Page.handleJavaScriptDialog", { accept }).catch(() => {});
        this.notice("dialog_dismissed");
        return;
      }
      case "Page.fileChooserOpened":
        this.notice("file_chooser_blocked");
        return;
      case "Page.downloadWillBegin":
        this.notice("download_blocked");
        return;
      case "Inspector.targetCrashed":
        this.update({
          loading: false,
          error: { code: "crashed", url: this.state.url, message: "The page crashed" },
        });
        return;
    }
  }

  private deliverFrame(params: Record<string, unknown>): void {
    const sessionId = params.sessionId;
    const metadata = obj(params.metadata);
    let released = false;
    const frame: EngineFrame = {
      base64: str(params.data),
      cssWidth: Math.round(Number(metadata.deviceWidth) || 0),
      cssHeight: Math.round(Number(metadata.deviceHeight) || 0),
      release: () => {
        if (released) return;
        released = true;
        void this.page("Page.screencastFrameAck", { sessionId }).catch(() => {});
      },
    };
    if (this.frameListeners.size === 0) frame.release();
    for (const listener of this.frameListeners) listener(frame);
  }

  private mainFrameNavigated(frame: Record<string, unknown>): void {
    if (str(frame.parentId)) return;
    this.mainFrameId = str(frame.id) || this.mainFrameId;
    this.focusContextId = null;
    const unreachable = str(frame.unreachableUrl);
    if (unreachable) {
      this.reportLoadError(unreachable, "net::ERR_FAILED");
      this.update({ url: unreachable });
    } else {
      this.update({ url: str(frame.url), error: null, focusedEditable: null });
    }
    void this.refreshHistory();
    this.resumePendingScreencast();
  }

  /** Popups open in place: the new target is closed and the main page navigates to its URL. */
  private followPopup(info: Record<string, unknown>): void {
    const targetId = str(info.targetId);
    // Any other page in this browser's context is a popup; target=_blank links are noopener by
    // default, so the opener is not always reported.
    if (
      str(info.type) !== "page" ||
      !this.targetId ||
      targetId === this.targetId ||
      str(info.browserContextId) !== this.browserContextId
    ) {
      return;
    }
    const url = parseNavigableUrl(str(info.url));
    if (url) {
      const timer = this.pendingPopups.get(targetId);
      if (timer) clearTimeout(timer);
      this.pendingPopups.delete(targetId);
      void this.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      this.notice("popup_opened_in_place");
      void this.navigate({ kind: "url", url }, new AbortController().signal).catch(() => {});
      return;
    }
    if (this.pendingPopups.has(targetId)) return;
    if (this.pendingPopups.size >= MAX_PENDING_POPUPS) {
      void this.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      return;
    }
    // about:blank first; its real URL arrives in targetInfoChanged. Close it if none does.
    const timer = setTimeout(() => {
      this.pendingPopups.delete(targetId);
      void this.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }, POPUP_URL_WAIT_MS);
    timer.unref?.();
    this.pendingPopups.set(targetId, timer);
  }
}
