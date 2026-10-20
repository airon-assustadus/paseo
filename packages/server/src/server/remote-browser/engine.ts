import type {
  RemoteBrowserFocusedEditable,
  RemoteBrowserLoadError,
  RemoteBrowserNavigation,
  RemoteBrowserNotice,
  RemoteBrowserViewport,
} from "@getpaseo/protocol/remote-browser/rpc-schemas";
import type { CdpCommand } from "./input-mapping.js";
import type { EgressDial } from "./egress-proxy.js";
import type { ProcessIdentity } from "./process-tree.js";

/** Page state the engine owns; the session adds viewport and visibility. */
export interface EnginePageState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  error: RemoteBrowserLoadError | null;
  focusedEditable: RemoteBrowserFocusedEditable | null;
  notice: RemoteBrowserNotice | null;
}

export interface EngineFrame {
  /** Base64 JPEG as received from Chromium; decoded only after the size check. */
  base64: string;
  cssWidth: number;
  cssHeight: number;
  /** Returns the frame's credit to Chromium so it produces the next one. Idempotent. */
  release(): void;
}

export interface ScreencastParams {
  quality: number;
  maxWidth: number;
  maxHeight: number;
}

export type EngineExitReason = "crashed" | "memory_limit" | "internal_error";

export interface EngineMetrics extends ProcessUsage {
  proxyBytesUp: number;
  proxyBytesDown: number;
  proxyConnections: number;
  /** How the browser addressed the proxy: CONNECT, absolute-form requests, upgrades by scheme. */
  proxyRequestShapes: { connects: number; plainRequests: number; upgrades: Record<string, number> };
  /** Recent dial decisions of the egress proxy (in memory only). */
  proxyRecentDials: readonly EgressDial[];
  /** Browser-internal connections refused by the process-wide deny-all proxy (in memory only). */
  browserInternalRefused: readonly EgressDial[];
}

/**
 * One isolated browser as the session sees it. The Chromium implementation lives in
 * `chromium-engine.ts`; tests drive the session with a scripted engine.
 */
export interface RemoteBrowserEngine {
  readonly state: EnginePageState;
  onStateChange(listener: () => void): () => void;
  onFrame(listener: (frame: EngineFrame) => void): () => void;
  /** The browser is gone without the session asking (crash, watchdog, unresponsive CDP). */
  onExit(listener: (reason: EngineExitReason) => void): () => void;
  /** Every CDP step checks `signal` immediately before it is written. */
  navigate(navigation: RemoteBrowserNavigation, signal: AbortSignal): Promise<void>;
  dispatch(command: CdpCommand, signal: AbortSignal): Promise<void>;
  /**
   * Re-reads the focused editable and the document title; returns the focusId (null when none).
   * Used to push focus and title changes and to guard focus-bound input; not a security boundary.
   */
  refreshFocus(signal: AbortSignal): Promise<number | null>;
  setViewport(
    viewport: RemoteBrowserViewport,
    renderScale: number,
    signal: AbortSignal,
  ): Promise<void>;
  /** Stop then start; each write checks `signal`, so a replaced attachment writes nothing more. */
  startScreencast(params: ScreencastParams, signal: AbortSignal): Promise<void>;
  /** Browser-level: also used when an attachment ends, so it takes no attachment signal. */
  stopScreencast(): Promise<void>;
  metrics(): EngineMetrics;
  /** Bounded close sequence; resolves when processes, proxy and temp dir are gone. */
  close(): Promise<void>;
}

export interface ProcessUsage {
  rssBytes: number;
  /** Proportional set size, diagnostic only (Linux); null when smaps is not readable. */
  pssBytes: number | null;
  /** What the watchdog limits: the summed RSS of the verified process set (contract §7). */
  memoryBytes: number;
  cpuMs: number;
  processCount: number;
}

/** What the daemon-wide manager additionally needs: sampling and forced termination. */
export interface ManagedRemoteBrowserEngine extends RemoteBrowserEngine {
  sampleProcesses(): Promise<ProcessUsage>;
  /** Exact identities of the verified process set, for containment evidence. */
  processIdentities(): ProcessIdentity[];
  /** Closes the browser and reports `reason` to exit listeners. */
  terminate(reason: EngineExitReason): void;
}

export interface EngineLaunchInput {
  viewport: RemoteBrowserViewport;
  renderScale: number;
  /** Opened by the manager after the browser is tracked; engines start on about:blank. */
  initialUrl: string | null;
}

export type EngineLauncher = (input: EngineLaunchInput) => Promise<RemoteBrowserEngine>;

export class RemoteBrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteBrowserUnavailableError";
  }
}

/** Processes of a closed browser are still running; their slot and memory stay accounted. */
export class RemoteBrowserCleanupError extends Error {
  constructor(readonly survivors: number) {
    super(`${survivors} remote browser processes did not exit`);
    this.name = "RemoteBrowserCleanupError";
  }
}

export class RemoteBrowserLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteBrowserLimitError";
  }
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Only http(s) URLs are navigable; no file, data, javascript, chrome or view-source schemes. */
export function parseNavigableUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) return null;
  if (url.username || url.password) return null;
  return url.href;
}
