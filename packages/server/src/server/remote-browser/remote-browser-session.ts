import { randomUUID } from "node:crypto";
import type pino from "pino";
import {
  encodeRemoteBrowserFrame,
  RemoteBrowserImageFormat,
  RemoteBrowserOpcode,
  type RemoteBrowserBinaryFrame,
} from "@getpaseo/protocol/binary-frames/index";
import {
  REMOTE_BROWSER_MAX_FRAME_BYTES,
  REMOTE_BROWSER_MAX_FRAMES_IN_FLIGHT,
  REMOTE_BROWSER_MAX_IMAGE_EDGE,
  REMOTE_BROWSER_MAX_IMAGE_PIXELS,
  REMOTE_BROWSER_MAX_INPUT_EVENTS,
  type RemoteBrowserCloseReason,
  type RemoteBrowserDetachReason,
  type RemoteBrowserErrorCode,
  type RemoteBrowserLimits,
  type RemoteBrowserState,
  type RemoteBrowserViewport,
} from "@getpaseo/protocol/remote-browser/rpc-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { TunnelProtocolError } from "../network-tunnel/network-tunnel-session.js";
import type { OwnedSubscription } from "../session/owned-subscriptions/index.js";
import { CdpError } from "./cdp-connection.js";
import {
  RemoteBrowserLimitError,
  RemoteBrowserUnavailableError,
  parseNavigableUrl,
  type EngineExitReason,
  type EngineFrame,
  type EngineLaunchInput,
  type RemoteBrowserEngine,
} from "./engine.js";
import {
  MIN_OVERSIZE_FACTOR,
  OVERSIZE_FACTOR_STEP,
  jpegDimensions,
  screencastSize,
  withinRaster,
} from "./frame-geometry.js";
import { RemoteBrowserInputError, mapInputEvent, type CdpCommand } from "./input-mapping.js";
import { budgetedState, buildStateMessage } from "./state-budget.js";

export const REMOTE_BROWSER_FAMILY = "browser.remote";

type Inbound<T extends SessionInboundMessage["type"]> = Extract<SessionInboundMessage, { type: T }>;
type ResponseType =
  | "browser.remote.open.response"
  | "browser.remote.attach.response"
  | "browser.remote.detach.response"
  | "browser.remote.close.response"
  | "browser.remote.list.response"
  | "browser.remote.navigate.response"
  | "browser.remote.dispatch_input.response"
  | "browser.remote.resize.response"
  | "browser.remote.set_visibility.response";

export interface RemoteBrowserSessionHost {
  /** Emits a reply for the request being handled. */
  emit(message: SessionOutboundMessage): void;
  /** Wraps `delivery.begin(REMOTE_BROWSER_FAMILY, undefined, stop)` for the current request. */
  begin(stop: (id: string) => void | Promise<void>): OwnedSubscription;
  currentSource(): object | undefined;
  isModernSource(source: object): boolean;
  allowsNetworkProxy(): boolean;
}

/** The part of the daemon-wide manager a session uses. */
export interface RemoteBrowserLauncher {
  readonly available: boolean;
  launch(input: EngineLaunchInput): Promise<RemoteBrowserEngine>;
  closeBrowser(engine: RemoteBrowserEngine): Promise<void>;
}

export interface RemoteBrowserSessionLimits extends RemoteBrowserLimits {
  maxBrowsers: number;
  maxQueuedOperations: number;
  stateIntervalMs: number;
  tombstonesPerSource: number;
  oversizeFramesAtFloor: number;
  /** Focus probe interval while visible; page scripts can move focus without input. */
  focusPollMs: number;
}

export const DEFAULT_REMOTE_BROWSER_SESSION_LIMITS: RemoteBrowserSessionLimits = {
  maxFramesInFlight: REMOTE_BROWSER_MAX_FRAMES_IN_FLIGHT,
  maxFrameBytes: REMOTE_BROWSER_MAX_FRAME_BYTES,
  maxImageEdge: REMOTE_BROWSER_MAX_IMAGE_EDGE,
  maxImagePixels: REMOTE_BROWSER_MAX_IMAGE_PIXELS,
  maxInputEventsPerRequest: REMOTE_BROWSER_MAX_INPUT_EVENTS,
  maxInputRequestsPerSecond: 120,
  detachedTimeoutMs: 60_000,
  frameAckTimeoutMs: 30_000,
  maxBrowsers: 2,
  maxQueuedOperations: 8,
  stateIntervalMs: 100,
  tombstonesPerSource: 32,
  oversizeFramesAtFloor: 3,
  focusPollMs: 300,
};

export interface RemoteBrowserSessionOptions {
  host: RemoteBrowserSessionHost;
  logger: pino.Logger;
  launcher: RemoteBrowserLauncher;
  limits?: Partial<RemoteBrowserSessionLimits>;
}

const DEFAULT_QUALITY = 60;
const MIN_QUALITY = 30;
const QUALITY_STEP = 10;
const DEFAULT_PIXEL_RATIO = 2;
const MAX_INPUT_REQUESTS_WINDOW_MS = 1000;

class RemoteBrowserOpError extends Error {
  constructor(
    readonly code: RemoteBrowserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RemoteBrowserOpError";
  }
}

const STALE = () => new RemoteBrowserOpError("stale_attachment", "The attachment was replaced");

interface PendingFrame {
  image: Buffer;
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
  source: EngineFrame;
}

interface Attachment {
  owner: OwnedSubscription;
  browser: Browser;
  generation: number;
  source: object;
  abort: AbortController;
  /** Frames and state flow only after the attach reply went out. */
  ready: boolean;
  visible: boolean;
  ended: boolean;
  nextSeq: number;
  unacked: Set<number>;
  pending: PendingFrame | null;
  ackTimer: ReturnType<typeof setTimeout> | null;
  stateTimer: ReturnType<typeof setTimeout> | null;
  stateDirty: boolean;
  lastStateAt: number;
  quality: number;
  reduction: number;
  oversizeAtFloor: number;
  inputWindowStart: number;
  inputRequests: number;
  focusTimer: ReturnType<typeof setTimeout> | null;
  focusPoll: ReturnType<typeof setInterval> | null;
  focusProbing: boolean;
}

interface Browser {
  id: string;
  engine: RemoteBrowserEngine;
  generation: number;
  attachment: Attachment | null;
  viewport: RemoteBrowserViewport;
  maxPixelRatio: number;
  quality: number;
  createdAt: number;
  detachTimer: ReturnType<typeof setTimeout> | null;
  queueTail: Promise<void>;
  queued: number;
  closed: boolean;
  unsubscribe: Array<() => void>;
}

function renderScale(viewport: RemoteBrowserViewport, maxPixelRatio: number): number {
  return Math.max(1, Math.min(viewport.deviceScaleFactor, maxPixelRatio));
}

function failure(type: ResponseType, requestId: string, error: RemoteBrowserOpError) {
  const payload = {
    requestId,
    ok: false as const,
    error: { code: error.code, message: error.message },
  };
  switch (type) {
    case "browser.remote.open.response":
      return { type, payload } satisfies SessionOutboundMessage;
    case "browser.remote.attach.response":
      return { type, payload } satisfies SessionOutboundMessage;
    case "browser.remote.detach.response":
      return { type, payload } satisfies SessionOutboundMessage;
    case "browser.remote.close.response":
      return { type, payload } satisfies SessionOutboundMessage;
    case "browser.remote.list.response":
      return { type, payload } satisfies SessionOutboundMessage;
    case "browser.remote.navigate.response":
      return { type, payload } satisfies SessionOutboundMessage;
    case "browser.remote.dispatch_input.response":
      return { type, payload } satisfies SessionOutboundMessage;
    case "browser.remote.resize.response":
      return { type, payload } satisfies SessionOutboundMessage;
    case "browser.remote.set_visibility.response":
      return { type, payload } satisfies SessionOutboundMessage;
  }
}

function asOpError(error: unknown): RemoteBrowserOpError {
  if (error instanceof RemoteBrowserOpError) return error;
  if (error instanceof RemoteBrowserInputError || error instanceof RangeError) {
    return new RemoteBrowserOpError("invalid_request", error.message);
  }
  if (error instanceof RemoteBrowserLimitError) {
    return new RemoteBrowserOpError("resource_limit", error.message);
  }
  if (error instanceof RemoteBrowserUnavailableError) {
    return new RemoteBrowserOpError("browser_unavailable", error.message);
  }
  if (error instanceof CdpError) {
    if (error.kind === "aborted") return STALE();
    if (error.kind === "busy") return new RemoteBrowserOpError("resource_limit", error.message);
  }
  return new RemoteBrowserOpError("internal_error", "The remote browser failed");
}

/**
 * Remote browsers of one daemon Session (principal + client). Ownership is the Session; every
 * attachment operation must name the current attachment (subscription ID + generation) from the
 * socket that holds it, and every CDP step re-checks that right before it is written.
 */
export class RemoteBrowserSession {
  private readonly host: RemoteBrowserSessionHost;
  private readonly logger: pino.Logger;
  private readonly launcher: RemoteBrowserLauncher;
  private readonly limits: RemoteBrowserSessionLimits;
  private readonly browsers = new Map<string, Browser>();
  private readonly attachments = new Map<string, Attachment>();
  private readonly tombstones = new WeakMap<object, string[]>();
  private opening = 0;

  constructor(options: RemoteBrowserSessionOptions) {
    this.host = options.host;
    this.logger = options.logger.child({ module: "remote-browser-session" });
    this.launcher = options.launcher;
    this.limits = { ...DEFAULT_REMOTE_BROWSER_SESSION_LIMITS, ...options.limits };
  }

  get browserCount(): number {
    return this.browsers.size;
  }

  private get announcedLimits(): RemoteBrowserLimits {
    const {
      maxFramesInFlight,
      maxFrameBytes,
      maxImageEdge,
      maxImagePixels,
      maxInputEventsPerRequest,
      maxInputRequestsPerSecond,
      detachedTimeoutMs,
      frameAckTimeoutMs,
    } = this.limits;
    return {
      maxFramesInFlight,
      maxFrameBytes,
      maxImageEdge,
      maxImagePixels,
      maxInputEventsPerRequest,
      maxInputRequestsPerSecond,
      detachedTimeoutMs,
      frameAckTimeoutMs,
    };
  }

  // ---------------------------------------------------------------------------
  // Session-level management
  // ---------------------------------------------------------------------------

  async handleOpen(request: Inbound<"browser.remote.open.request">): Promise<void> {
    const type = "browser.remote.open.response";
    try {
      const source = this.requireModernSource();
      if (!this.launcher.available) {
        throw new RemoteBrowserOpError("browser_unavailable", "No usable browser on this host");
      }
      if (this.browsers.size + this.opening >= this.limits.maxBrowsers) {
        throw new RemoteBrowserOpError(
          "resource_limit",
          "Too many remote browsers for this client",
        );
      }
      const initialUrl = request.url === undefined ? null : parseNavigableUrl(request.url);
      if (request.url !== undefined && !initialUrl) {
        throw new RemoteBrowserOpError("invalid_request", "Only http and https URLs can be opened");
      }
      const maxPixelRatio = request.frames?.maxPixelRatio ?? DEFAULT_PIXEL_RATIO;
      this.opening += 1;
      let engine: RemoteBrowserEngine;
      try {
        engine = await this.launcher.launch({
          viewport: request.viewport,
          renderScale: renderScale(request.viewport, maxPixelRatio),
          initialUrl,
        });
      } finally {
        this.opening -= 1;
      }
      if (!this.host.allowsNetworkProxy()) {
        await this.launcher.closeBrowser(engine);
        throw new RemoteBrowserOpError("permission_denied", "The session lost network.proxy");
      }
      const browser: Browser = {
        id: randomUUID(),
        engine,
        generation: 0,
        attachment: null,
        viewport: request.viewport,
        maxPixelRatio,
        quality: request.frames?.quality ?? DEFAULT_QUALITY,
        createdAt: Date.now(),
        detachTimer: null,
        queueTail: Promise.resolve(),
        queued: 0,
        closed: false,
        unsubscribe: [],
      };
      this.browsers.set(browser.id, browser);
      browser.unsubscribe.push(
        engine.onFrame((frame) => this.onEngineFrame(browser, frame)),
        engine.onStateChange(() => {
          if (browser.attachment) this.scheduleState(browser.attachment);
        }),
        engine.onExit((reason) => this.onEngineExit(browser, reason)),
      );
      try {
        await this.attach(type, request.requestId, browser, source, null);
      } catch (error) {
        // Nobody can attach to a browser whose opener never received it.
        await this.closeBrowser(browser, null);
        throw error;
      }
    } catch (error) {
      this.host.emit(failure(type, request.requestId, asOpError(error)));
    }
  }

  async handleAttach(request: Inbound<"browser.remote.attach.request">): Promise<void> {
    const type = "browser.remote.attach.response";
    try {
      const source = this.requireModernSource();
      const browser = this.requireBrowser(request.browserId);
      if (request.frames?.maxPixelRatio !== undefined) {
        browser.maxPixelRatio = request.frames.maxPixelRatio;
      }
      if (request.frames?.quality !== undefined) browser.quality = request.frames.quality;
      await this.attach(type, request.requestId, browser, source, request.viewport ?? null);
    } catch (error) {
      this.host.emit(failure(type, request.requestId, asOpError(error)));
    }
  }

  async handleClose(request: Inbound<"browser.remote.close.request">): Promise<void> {
    const type = "browser.remote.close.response";
    try {
      this.requirePermission();
      const browser = this.requireBrowser(request.browserId);
      if (
        request.expectedGeneration !== undefined &&
        request.expectedGeneration !== browser.generation
      ) {
        throw STALE();
      }
      const closing = this.closeBrowser(browser, "closed");
      this.host.emit({
        type,
        payload: { requestId: request.requestId, ok: true, browserId: browser.id },
      });
      await closing;
    } catch (error) {
      this.host.emit(failure(type, request.requestId, asOpError(error)));
    }
  }

  handleList(request: Inbound<"browser.remote.list.request">): void {
    const type = "browser.remote.list.response";
    try {
      this.requirePermission();
      this.host.emit({
        type,
        payload: {
          requestId: request.requestId,
          ok: true,
          browsers: [...this.browsers.values()].map((browser) => {
            const state = this.stateOf(browser);
            return {
              browserId: browser.id,
              url: state.url,
              title: state.title,
              attached: browser.attachment !== null,
              generation: Math.max(1, browser.generation),
              createdAt: browser.createdAt,
            };
          }),
        },
      });
    } catch (error) {
      this.host.emit(failure(type, request.requestId, asOpError(error)));
    }
  }

  // ---------------------------------------------------------------------------
  // Attachment operations
  // ---------------------------------------------------------------------------

  async handleDetach(request: Inbound<"browser.remote.detach.request">): Promise<void> {
    const type = "browser.remote.detach.response";
    try {
      const attachment = this.requireAttachment(request);
      this.endAttachment(attachment, null);
      this.host.emit({
        type,
        payload: { requestId: request.requestId, ok: true, browserId: request.browserId },
      });
    } catch (error) {
      this.host.emit(failure(type, request.requestId, asOpError(error)));
    }
  }

  async handleNavigate(request: Inbound<"browser.remote.navigate.request">): Promise<void> {
    const type = "browser.remote.navigate.response";
    try {
      const attachment = this.requireAttachment(request);
      await this.enqueue(attachment, () =>
        attachment.browser.engine.navigate(request.navigation, attachment.abort.signal),
      );
      this.host.emit({ type, payload: { requestId: request.requestId, ok: true } });
    } catch (error) {
      this.host.emit(failure(type, request.requestId, asOpError(error)));
    }
  }

  async handleDispatchInput(
    request: Inbound<"browser.remote.dispatch_input.request">,
  ): Promise<void> {
    const type = "browser.remote.dispatch_input.response";
    try {
      const attachment = this.requireAttachment(request);
      this.takeInputBudget(attachment);
      if (request.events.length > this.limits.maxInputEventsPerRequest) {
        throw new RemoteBrowserOpError("invalid_request", "Too many input events");
      }
      // Validate the whole batch before anything reaches the page.
      const viewport = attachment.browser.viewport;
      const steps = request.events.map((event) => ({
        commands: mapInputEvent(event, viewport),
        focusId: event.kind === "text" || event.kind === "composition" ? event.focusId : undefined,
      }));
      let dispatched: number;
      try {
        dispatched = await this.enqueue(attachment, async () => {
          let count = 0;
          for (const step of steps) {
            if (step.focusId !== undefined) await this.requireFocus(attachment, step.focusId);
            await this.dispatchStep(attachment, step.commands);
            count += 1;
          }
          return count;
        });
      } finally {
        // Input can move focus (taps, Tab, page scripts reacting to keys); report it promptly.
        this.scheduleFocusRefresh(attachment);
      }
      this.host.emit({ type, payload: { requestId: request.requestId, ok: true, dispatched } });
    } catch (error) {
      this.host.emit(failure(type, request.requestId, asOpError(error)));
    }
  }

  async handleResize(request: Inbound<"browser.remote.resize.request">): Promise<void> {
    const type = "browser.remote.resize.response";
    try {
      const attachment = this.requireAttachment(request);
      const browser = attachment.browser;
      await this.enqueue(attachment, async () => {
        await browser.engine.setViewport(
          request.viewport,
          renderScale(request.viewport, browser.maxPixelRatio),
          attachment.abort.signal,
        );
        browser.viewport = request.viewport;
        if (attachment.visible) await this.startScreencast(attachment);
      });
      this.scheduleState(attachment);
      this.host.emit({
        type,
        payload: { requestId: request.requestId, ok: true, viewport: browser.viewport },
      });
    } catch (error) {
      this.host.emit(failure(type, request.requestId, asOpError(error)));
    }
  }

  async handleSetVisibility(
    request: Inbound<"browser.remote.set_visibility.request">,
  ): Promise<void> {
    const type = "browser.remote.set_visibility.response";
    try {
      const attachment = this.requireAttachment(request);
      await this.enqueue(attachment, async () => {
        if (attachment.visible === request.visible) return;
        attachment.visible = request.visible;
        this.syncFocusPolling(attachment);
        if (request.visible) {
          this.armAckTimer(attachment, true);
          await this.startScreencast(attachment);
        } else {
          this.clearAckTimer(attachment);
          this.releasePending(attachment);
          await attachment.browser.engine.stopScreencast();
        }
      });
      this.scheduleState(attachment);
      this.host.emit({
        type,
        payload: { requestId: request.requestId, ok: true, visible: request.visible },
      });
    } catch (error) {
      this.host.emit(failure(type, request.requestId, asOpError(error)));
    }
  }

  /** Binary FrameAck from a client socket. Runs before the workspace permission gate. */
  async handleFrameAck(frame: RemoteBrowserBinaryFrame, source: object): Promise<void> {
    if (frame.opcode !== RemoteBrowserOpcode.FrameAck) {
      throw new TunnelProtocolError("Clients do not send remote browser frames");
    }
    if (!this.host.allowsNetworkProxy()) {
      await this.revoke();
      return;
    }
    const attachment = this.attachments.get(frame.subscriptionId);
    if (!attachment) {
      if (this.tombstones.get(source)?.includes(frame.subscriptionId)) return;
      throw new TunnelProtocolError("Remote browser ack does not belong to an owned subscription");
    }
    if (attachment.source !== source) {
      throw new TunnelProtocolError("Remote browser ack came from another socket");
    }
    if (frame.generation !== attachment.generation || !attachment.unacked.delete(frame.seq)) {
      this.logger.warn(
        { subscriptionId: frame.subscriptionId },
        "Remote browser ack violation; detaching",
      );
      this.endAttachment(attachment, "protocol_error");
      return;
    }
    if (attachment.pending) {
      const pending = attachment.pending;
      attachment.pending = null;
      this.sendFrame(attachment, pending);
    }
    this.armAckTimer(attachment, true);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Call before the session drops network.proxy: the closed notices need that permission to
   * leave, and they are emitted synchronously before the first await.
   */
  revoke(): Promise<void> {
    return Promise.all(
      [...this.browsers.values()].map((browser) => this.closeBrowser(browser, "revoked")),
    ).then(() => undefined);
  }

  /** Session cleanup: the client is gone, so nothing is emitted. */
  closeAll(): Promise<void> {
    return Promise.all(
      [...this.browsers.values()].map((browser) => this.closeBrowser(browser, null)),
    ).then(() => undefined);
  }

  private async attach(
    type: "browser.remote.open.response" | "browser.remote.attach.response",
    requestId: string,
    browser: Browser,
    source: object,
    viewport: RemoteBrowserViewport | null,
  ): Promise<void> {
    // Throws when the requesting socket is already gone; nothing has changed yet.
    const owner = this.host.begin(() => {
      const current = this.attachments.get(owner.id);
      if (current) this.endAttachment(current, null);
    });
    if (browser.attachment) this.endAttachment(browser.attachment, "superseded");
    if (browser.detachTimer) {
      clearTimeout(browser.detachTimer);
      browser.detachTimer = null;
    }
    browser.generation += 1;
    const attachment: Attachment = {
      owner,
      browser,
      generation: browser.generation,
      source,
      abort: new AbortController(),
      ready: false,
      visible: true,
      ended: false,
      nextSeq: 0,
      unacked: new Set(),
      pending: null,
      ackTimer: null,
      stateTimer: null,
      stateDirty: false,
      lastStateAt: 0,
      quality: browser.quality,
      reduction: 1,
      oversizeAtFloor: 0,
      inputWindowStart: 0,
      inputRequests: 0,
      focusTimer: null,
      focusPoll: null,
      focusProbing: false,
    };
    browser.attachment = attachment;
    this.attachments.set(owner.id, attachment);
    if (viewport) {
      try {
        await this.enqueue(attachment, () =>
          browser.engine.setViewport(
            viewport,
            renderScale(viewport, browser.maxPixelRatio),
            attachment.abort.signal,
          ),
        );
      } catch (error) {
        this.endAttachment(attachment, null);
        throw error;
      }
      browser.viewport = viewport;
    }
    // A takeover, revoke or close while the viewport was applied ended this attachment.
    if (!this.isCurrent(attachment)) throw STALE();
    const payload = {
      requestId,
      ok: true as const,
      browserId: browser.id,
      subscriptionId: owner.id,
      generation: attachment.generation,
      limits: this.announcedLimits,
      state: this.stateOf(browser),
    };
    // The reply leaves before any frame, so the client has registered the attachment first.
    if (type === "browser.remote.open.response") this.host.emit({ type, payload });
    else this.host.emit({ type, payload });
    attachment.ready = true;
    attachment.lastStateAt = Date.now();
    this.syncFocusPolling(attachment);
    await this.startScreencast(attachment).catch((error) =>
      this.logger.warn({ err: error }, "Remote browser screencast failed to start"),
    );
  }

  /** Ends an attachment; the browser keeps running for the detach grace. */
  private endAttachment(attachment: Attachment, reason: RemoteBrowserDetachReason | null): void {
    if (attachment.ended) return;
    if (reason) {
      attachment.owner.emit({
        type: "browser.remote.detached",
        payload: {
          subscriptionId: attachment.owner.id,
          browserId: attachment.browser.id,
          generation: attachment.generation,
          reason,
        },
      });
    }
    this.retire(attachment);
    const browser = attachment.browser;
    if (!browser.closed && browser.attachment === null) {
      void browser.engine.stopScreencast().catch(() => {});
      browser.detachTimer = setTimeout(() => {
        browser.detachTimer = null;
        void this.closeBrowser(browser, "detached_timeout");
      }, this.limits.detachedTimeoutMs);
      browser.detachTimer.unref?.();
    }
  }

  /** Stops everything an attachment owns. Idempotent. */
  private retire(attachment: Attachment): void {
    if (attachment.ended) return;
    attachment.ended = true;
    attachment.abort.abort();
    this.clearAckTimer(attachment);
    if (attachment.stateTimer) clearTimeout(attachment.stateTimer);
    attachment.stateTimer = null;
    if (attachment.focusTimer) clearTimeout(attachment.focusTimer);
    attachment.focusTimer = null;
    this.syncFocusPolling(attachment);
    this.releasePending(attachment);
    attachment.unacked.clear();
    this.attachments.delete(attachment.owner.id);
    if (attachment.browser.attachment === attachment) attachment.browser.attachment = null;
    const retired = this.tombstones.get(attachment.source) ?? [];
    retired.push(attachment.owner.id);
    if (retired.length > this.limits.tombstonesPerSource) retired.shift();
    this.tombstones.set(attachment.source, retired);
    void attachment.owner.release().catch(() => {});
  }

  private async closeBrowser(
    browser: Browser,
    reason: RemoteBrowserCloseReason | null,
  ): Promise<void> {
    if (browser.closed) return;
    browser.closed = true;
    this.browsers.delete(browser.id);
    if (browser.detachTimer) clearTimeout(browser.detachTimer);
    browser.detachTimer = null;
    const attachment = browser.attachment;
    if (attachment && reason) {
      attachment.owner.emit({
        type: "browser.remote.closed",
        payload: { subscriptionId: attachment.owner.id, browserId: browser.id, reason },
      });
    }
    if (attachment) this.retire(attachment);
    for (const unsubscribe of browser.unsubscribe) unsubscribe();
    browser.unsubscribe = [];
    await this.launcher
      .closeBrowser(browser.engine)
      .catch((error) => this.logger.warn({ err: error }, "Remote browser close failed"));
  }

  private onEngineExit(browser: Browser, reason: EngineExitReason): void {
    const closeReasons: Record<EngineExitReason, RemoteBrowserCloseReason> = {
      memory_limit: "memory_limit",
      crashed: "crashed",
      internal_error: "internal_error",
    };
    const closeReason = closeReasons[reason];
    void this.closeBrowser(browser, closeReason);
  }

  // ---------------------------------------------------------------------------
  // Frames
  // ---------------------------------------------------------------------------

  private async startScreencast(attachment: Attachment): Promise<void> {
    if (attachment.ended || !attachment.visible) return;
    const browser = attachment.browser;
    const size = screencastSize({
      viewport: browser.viewport,
      maxPixelRatio: browser.maxPixelRatio,
      ceiling: this.limits,
      reduction: attachment.reduction,
    });
    await browser.engine.startScreencast(
      { quality: attachment.quality, maxWidth: size.maxWidth, maxHeight: size.maxHeight },
      attachment.abort.signal,
    );
  }

  private onEngineFrame(browser: Browser, frame: EngineFrame): void {
    const attachment = browser.attachment;
    if (!attachment || !attachment.ready || !attachment.visible || attachment.ended) {
      frame.release();
      return;
    }
    // Reject by encoded size before decoding anything.
    if (Math.floor((frame.base64.length * 3) / 4) > this.limits.maxFrameBytes + 2) {
      this.oversized(attachment, frame);
      return;
    }
    const image = Buffer.from(frame.base64, "base64");
    const dimensions = jpegDimensions(image);
    if (
      !dimensions ||
      image.length > this.limits.maxFrameBytes ||
      !withinRaster(dimensions, this.limits) ||
      frame.cssWidth < 1 ||
      frame.cssHeight < 1 ||
      frame.cssWidth > 0xffff ||
      frame.cssHeight > 0xffff
    ) {
      this.oversized(attachment, frame);
      return;
    }
    attachment.oversizeAtFloor = 0;
    const pending: PendingFrame = {
      image,
      width: dimensions.width,
      height: dimensions.height,
      cssWidth: frame.cssWidth,
      cssHeight: frame.cssHeight,
      source: frame,
    };
    if (attachment.unacked.size < this.limits.maxFramesInFlight) {
      this.sendFrame(attachment, pending);
      return;
    }
    // Window full: hold only the newest frame and withhold Chromium's ack so it stops producing.
    this.releasePending(attachment);
    attachment.pending = pending;
  }

  private sendFrame(attachment: Attachment, frame: PendingFrame): void {
    const seq = attachment.nextSeq;
    attachment.nextSeq += 1;
    attachment.unacked.add(seq);
    attachment.owner.emitBinary(
      encodeRemoteBrowserFrame({
        opcode: RemoteBrowserOpcode.Frame,
        subscriptionId: attachment.owner.id,
        generation: attachment.generation,
        seq,
        cssWidth: frame.cssWidth,
        cssHeight: frame.cssHeight,
        imageWidth: frame.width,
        imageHeight: frame.height,
        format: RemoteBrowserImageFormat.Jpeg,
        image: frame.image,
      }),
    );
    frame.source.release();
    this.armAckTimer(attachment, false);
  }

  private oversized(attachment: Attachment, frame: EngineFrame): void {
    frame.release();
    if (attachment.quality > MIN_QUALITY) {
      attachment.quality = Math.max(MIN_QUALITY, attachment.quality - QUALITY_STEP);
    } else if (attachment.reduction > MIN_OVERSIZE_FACTOR) {
      attachment.reduction = Math.max(
        MIN_OVERSIZE_FACTOR,
        attachment.reduction * OVERSIZE_FACTOR_STEP,
      );
    } else {
      attachment.oversizeAtFloor += 1;
      if (attachment.oversizeAtFloor >= this.limits.oversizeFramesAtFloor) {
        this.endAttachment(attachment, "resource_limit");
        return;
      }
      return;
    }
    void this.startScreencast(attachment).catch(() => {});
  }

  private releasePending(attachment: Attachment): void {
    attachment.pending?.source.release();
    attachment.pending = null;
  }

  /** Visible attachments with frames out must ack within the timeout; hidden ones pause it. */
  private armAckTimer(attachment: Attachment, restart: boolean): void {
    if (attachment.ended) return;
    if (!attachment.visible || attachment.unacked.size === 0) {
      this.clearAckTimer(attachment);
      return;
    }
    if (attachment.ackTimer && !restart) return;
    this.clearAckTimer(attachment);
    attachment.ackTimer = setTimeout(() => {
      attachment.ackTimer = null;
      this.logger.debug({ subscriptionId: attachment.owner.id }, "Remote browser ack timeout");
      this.endAttachment(attachment, "protocol_error");
    }, this.limits.frameAckTimeoutMs);
    attachment.ackTimer.unref?.();
  }

  private clearAckTimer(attachment: Attachment): void {
    if (attachment.ackTimer) clearTimeout(attachment.ackTimer);
    attachment.ackTimer = null;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  /** Bounded per field and by serialized bytes: replies carry it as well as state events. */
  private stateOf(browser: Browser): RemoteBrowserState {
    return budgetedState({
      ...browser.engine.state,
      viewport: browser.viewport,
      visible: browser.attachment?.visible ?? false,
    });
  }

  /** Latest-wins, at most one message per interval per attachment, nothing queued. */
  private scheduleState(attachment: Attachment): void {
    if (attachment.ended || !attachment.ready) return;
    attachment.stateDirty = true;
    if (attachment.stateTimer) return;
    const wait = Math.max(0, attachment.lastStateAt + this.limits.stateIntervalMs - Date.now());
    attachment.stateTimer = setTimeout(() => {
      attachment.stateTimer = null;
      if (attachment.ended || !attachment.stateDirty) return;
      attachment.stateDirty = false;
      attachment.lastStateAt = Date.now();
      attachment.owner.emit(
        buildStateMessage({
          subscriptionId: attachment.owner.id,
          browserId: attachment.browser.id,
          generation: attachment.generation,
          state: this.stateOf(attachment.browser),
        }),
      );
    }, wait);
    attachment.stateTimer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------

  private requirePermission(): void {
    if (!this.host.allowsNetworkProxy()) {
      throw new RemoteBrowserOpError(
        "permission_denied",
        "Session lacks the network.proxy permission",
      );
    }
  }

  private requireModernSource(): object {
    this.requirePermission();
    const source = this.host.currentSource();
    if (!source || !this.host.isModernSource(source)) {
      throw new RemoteBrowserOpError(
        "unsupported_capability",
        "The remote browser requires the owned_subscriptions capability",
      );
    }
    return source;
  }

  private requireBrowser(browserId: string): Browser {
    const browser = this.browsers.get(browserId);
    // Same answer for foreign and unknown IDs: no existence oracle.
    if (!browser || browser.closed) {
      throw new RemoteBrowserOpError("not_found", "Unknown remote browser");
    }
    return browser;
  }

  private requireAttachment(request: {
    browserId: string;
    subscriptionId: string;
    generation: number;
  }): Attachment {
    this.requirePermission();
    const browser = this.requireBrowser(request.browserId);
    const attachment = browser.attachment;
    if (
      !attachment ||
      attachment.ended ||
      attachment.owner.id !== request.subscriptionId ||
      attachment.generation !== request.generation ||
      attachment.source !== this.host.currentSource()
    ) {
      throw STALE();
    }
    return attachment;
  }

  private isCurrent(attachment: Attachment): boolean {
    return (
      !attachment.ended &&
      !attachment.browser.closed &&
      attachment.browser.attachment === attachment &&
      this.host.allowsNetworkProxy()
    );
  }

  /** One serial queue per browser; a task never starts for an attachment that is no longer current. */
  private enqueue<T>(attachment: Attachment, task: () => Promise<T>): Promise<T> {
    const browser = attachment.browser;
    if (browser.queued >= this.limits.maxQueuedOperations) {
      return Promise.reject(
        new RemoteBrowserOpError("resource_limit", "Too many queued operations"),
      );
    }
    browser.queued += 1;
    const run = browser.queueTail.then(async () => {
      try {
        if (!this.isCurrent(attachment)) throw STALE();
        return await task();
      } finally {
        browser.queued -= 1;
      }
    });
    browser.queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Re-checks the attachment immediately before each command is written to the pipe. */
  private async dispatchStep(attachment: Attachment, commands: CdpCommand[]): Promise<void> {
    for (const command of commands) {
      if (!this.isCurrent(attachment)) throw STALE();
      await attachment.browser.engine.dispatch(command, attachment.abort.signal);
    }
  }

  /**
   * Focus-bound input (text, composition) goes out only while the field the client composed for
   * is still focused, so a page that moves focus never receives the previous field's text.
   */
  private async requireFocus(attachment: Attachment, focusId: number): Promise<void> {
    if (!this.isCurrent(attachment)) throw STALE();
    const current = await attachment.browser.engine.refreshFocus(attachment.abort.signal);
    if (current !== focusId) {
      throw new RemoteBrowserOpError("focus_changed", "The focused field changed");
    }
  }

  /** At most one focus probe per interval per attachment, trailing; never queued behind input. */
  private scheduleFocusRefresh(attachment: Attachment): void {
    if (attachment.ended || attachment.focusTimer) return;
    attachment.focusTimer = setTimeout(() => {
      attachment.focusTimer = null;
      void this.refreshFocusNow(attachment);
    }, this.limits.stateIntervalMs);
    attachment.focusTimer.unref?.();
  }

  private async refreshFocusNow(attachment: Attachment): Promise<void> {
    if (attachment.ended || attachment.focusProbing) return;
    attachment.focusProbing = true;
    try {
      // The engine reports a change through onStateChange, which schedules the state message.
      await attachment.browser.engine.refreshFocus(attachment.abort.signal);
    } catch {
      // A failed probe leaves the last known focus; the next tick or input retries.
    } finally {
      attachment.focusProbing = false;
    }
  }

  /** While visible, page scripts can move focus without input; poll at a bounded rate. */
  private syncFocusPolling(attachment: Attachment): void {
    const wanted = attachment.ready && attachment.visible && !attachment.ended;
    if (wanted && !attachment.focusPoll) {
      attachment.focusPoll = setInterval(
        () => void this.refreshFocusNow(attachment),
        this.limits.focusPollMs,
      );
      attachment.focusPoll.unref?.();
    } else if (!wanted && attachment.focusPoll) {
      clearInterval(attachment.focusPoll);
      attachment.focusPoll = null;
    }
  }

  private takeInputBudget(attachment: Attachment): void {
    const now = Date.now();
    if (now - attachment.inputWindowStart >= MAX_INPUT_REQUESTS_WINDOW_MS) {
      attachment.inputWindowStart = now;
      attachment.inputRequests = 0;
    }
    attachment.inputRequests += 1;
    if (attachment.inputRequests > this.limits.maxInputRequestsPerSecond) {
      throw new RemoteBrowserOpError("resource_limit", "Too many input requests");
    }
  }
}
