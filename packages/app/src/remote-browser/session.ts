import {
  RemoteBrowserRpcError,
  type RemoteBrowserAttachment,
  type RemoteBrowserEnd,
  type RemoteBrowserFrame,
  type RemoteBrowserFrameOptions,
  type RemoteBrowserInputEvent,
  type RemoteBrowserNavigation,
  type RemoteBrowserState,
  type RemoteBrowserViewport,
} from "@getpaseo/client";
import { createFramePipeline, type FramePipeline } from "./frames";
import type { RemoteBrowserBinding } from "./registry";
import { viewportsEqual } from "./viewport";

/** The part of `DaemonClient` the session uses; the real client satisfies it structurally. */
export interface RemoteBrowserClient {
  openRemoteBrowser(options: {
    viewport: RemoteBrowserViewport;
    url?: string;
    frames?: RemoteBrowserFrameOptions;
  }): Promise<RemoteBrowserAttachment>;
  attachRemoteBrowser(
    browserId: string,
    options?: { viewport?: RemoteBrowserViewport; frames?: RemoteBrowserFrameOptions },
  ): Promise<RemoteBrowserAttachment>;
  closeRemoteBrowser(browserId: string, options?: { expectedGeneration?: number }): Promise<void>;
  getConnectionState(): { status: string };
  subscribeConnectionStatus(listener: () => void): () => void;
}

export type RemoteBrowserPhase =
  | { kind: "idle" }
  | { kind: "opening" }
  | { kind: "ready" }
  | { kind: "reconnecting" }
  | { kind: "ended"; end: RemoteBrowserEnd }
  | { kind: "failed"; error: RemoteBrowserRpcError | Error };

export interface RemoteBrowserSessionSnapshot {
  phase: RemoteBrowserPhase;
  /** Increments on every attachment installed; the pane re-syncs its keyboard on change. */
  attachmentEpoch: number;
  browserState: RemoteBrowserState | null;
  frame: RemoteBrowserFrame | null;
  /** The last navigation/input/resize failure the user should see; cleared by the next success. */
  operationError: Error | null;
}

/** This device could not decode or draw the daemon's frames; the attachment was given up. The pane shows translated copy for it. */
export class RemoteBrowserPresentationError extends Error {
  constructor() {
    super("remote browser frames could not be presented");
    this.name = "RemoteBrowserPresentationError";
  }
}

// A corrupt frame is retried by re-attaching (the daemon sends a fresh keyframe); past this many
// consecutive failures the pane shows an error and waits for the user.
const MAX_PRESENTATION_RETRIES = 2;

export interface RemoteBrowserSession {
  subscribe(listener: () => void): () => void;
  getSnapshot(): RemoteBrowserSessionSnapshot;
  start(): void;
  setViewport(viewport: RemoteBrowserViewport | null): void;
  setVisible(visible: boolean): void;
  navigate(navigation: RemoteBrowserNavigation): void;
  dispatch(events: RemoteBrowserInputEvent[]): void;
  framePainted(frame: RemoteBrowserFrame): void;
  /** The presenter could not decode or draw `frame`. It is never acked; the attachment restarts. */
  framePresentationFailed(frame: RemoteBrowserFrame): void;
  /** After `ended` or `failed`: attach again if the browser may still exist, otherwise open anew. */
  retry(): void;
  /** Pane unmount: detach and keep the browser alive for the daemon's grace. */
  dispose(): void;
  /**
   * Tab closed: close the browser unless a newer attachment took it over. Never rejects; a close
   * that fails because the socket is gone leaves the daemon's detach grace to finish the job.
   */
  closeBrowser(): void;
}

// Default from the daemon; frames never get sharper than this, and a 3x phone would triple bytes.
const FRAME_OPTIONS: RemoteBrowserFrameOptions = { maxPixelRatio: 2 };
const RESIZE_DEBOUNCE_MS = 150;

function isStale(error: unknown): boolean {
  return error instanceof RemoteBrowserRpcError && error.code === "stale_attachment";
}

function isNotFound(error: unknown): boolean {
  return error instanceof RemoteBrowserRpcError && error.code === "not_found";
}

export function createRemoteBrowserSession(input: {
  client: RemoteBrowserClient;
  initialUrl: string;
  binding: RemoteBrowserBinding | null;
  onBinding: (binding: RemoteBrowserBinding | null) => void;
  onBrowserState: (state: RemoteBrowserState) => void;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}): RemoteBrowserSession {
  const schedule =
    input.schedule ??
    ((callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      return () => clearTimeout(handle);
    });
  const listeners = new Set<() => void>();
  let snapshot: RemoteBrowserSessionSnapshot = {
    phase: { kind: "idle" },
    attachmentEpoch: 0,
    browserState: null,
    frame: null,
    operationError: null,
  };
  let attachment: RemoteBrowserAttachment | null = null;
  let pipeline: FramePipeline | null = null;
  let unlistenAttachment: Array<() => void> = [];
  let binding = input.binding;
  let lastUrl = input.initialUrl;
  let viewport: RemoteBrowserViewport | null = null;
  let visible = true;
  let disposed = false;
  let attempt = 0;
  let closing = false;
  let presentationFailures = 0;
  let cancelResize: (() => void) | null = null;
  let cancelGrace: (() => void) | null = null;
  let unsubscribeConnection: (() => void) | null = null;

  function publish(patch: Partial<RemoteBrowserSessionSnapshot>): void {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) {
      listener();
    }
  }

  function setBinding(next: RemoteBrowserBinding | null): void {
    binding = next;
    input.onBinding(next);
  }

  function isConnected(): boolean {
    return input.client.getConnectionState().status === "connected";
  }

  function clearAttachment(): void {
    for (const unlisten of unlistenAttachment.splice(0)) {
      unlisten();
    }
    pipeline?.dispose();
    pipeline = null;
    attachment = null;
    cancelResize?.();
    cancelResize = null;
  }

  /** Input the daemon refused by design: a burst over the rate limit, or text for a field that lost focus. */
  function isExpectedInputRefusal(error: unknown): boolean {
    return (
      error instanceof RemoteBrowserRpcError &&
      error.operation === "dispatch_input" &&
      (error.code === "resource_limit" || error.code === "focus_changed")
    );
  }

  /**
   * Runs an attachment operation and turns its outcome into UI state. A failure of an attachment
   * that has since ended (disconnect, takeover) is not news to the user; a live one is shown until
   * the next operation succeeds. Nothing escapes as an unhandled rejection.
   */
  function run(current: RemoteBrowserAttachment, operation: () => Promise<unknown>): void {
    void settle(current, operation);
  }

  async function settle(
    current: RemoteBrowserAttachment,
    operation: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (attachment !== current || disposed || isStale(error) || isExpectedInputRefusal(error)) {
        return;
      }
      publish({ operationError: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    if (attachment === current && snapshot.operationError) {
      publish({ operationError: null });
    }
  }

  function applyState(state: RemoteBrowserState): void {
    lastUrl = state.url;
    publish({ browserState: state });
    input.onBrowserState(state);
  }

  function handleEnd(end: RemoteBrowserEnd): void {
    clearAttachment();
    if (disposed) {
      return;
    }
    if (end.kind === "disconnected") {
      publish({ phase: { kind: "reconnecting" }, frame: null });
      armGrace();
      return;
    }
    if (end.kind === "closed") {
      setBinding(null);
    }
    publish({ phase: { kind: "ended", end }, frame: null });
  }

  function armGrace(): void {
    cancelGrace?.();
    if (!binding) {
      return;
    }
    cancelGrace = schedule(() => {
      cancelGrace = null;
      // The daemon closed the detached browser; the next connection opens a new one.
      setBinding(null);
    }, binding.detachedTimeoutMs);
  }

  function listen(next: RemoteBrowserAttachment, subscribe: () => () => void): boolean {
    const unlisten = subscribe();
    if (attachment !== next) {
      unlisten();
      return false;
    }
    unlistenAttachment.push(unlisten);
    return true;
  }

  function install(next: RemoteBrowserAttachment): void {
    attachment = next;
    setBinding({
      browserId: next.browserId,
      generation: next.generation,
      detachedTimeoutMs: next.limits.detachedTimeoutMs,
    });
    const framePipeline = createFramePipeline({
      generation: next.generation,
      present: (frame) => publish({ frame }),
      ack: (frame) => next.ackFrame(frame),
    });
    framePipeline.setPaused(!visible);
    pipeline = framePipeline;
    publish({
      phase: { kind: "ready" },
      attachmentEpoch: snapshot.attachmentEpoch + 1,
      operationError: null,
    });
    applyState(next.state);
    // Listeners replay synchronously on subscription: the pipeline and phase above must already be
    // in place, and an attachment that ended in the same turn as its reply ends here, not later.
    unlistenAttachment = [];
    const live =
      listen(next, () => next.onFrame((frame) => framePipeline.receive(frame))) &&
      listen(next, () => next.onState((state) => applyState(state))) &&
      listen(next, () => next.onEnd((end) => handleEnd(end)));
    if (!live) {
      return;
    }
    if (!visible) {
      run(next, () => next.setVisibility(false));
    }
    if (viewport && !viewportsEqual(viewport, next.state.viewport)) {
      const requested = viewport;
      run(next, () => next.resize(requested));
    }
  }

  async function attachOrOpen(): Promise<void> {
    if (disposed || closing || attachment || !viewport || !isConnected()) {
      return;
    }
    cancelGrace?.();
    cancelGrace = null;
    const thisAttempt = ++attempt;
    const requestedViewport = viewport;
    publish({ phase: { kind: "opening" } });
    let next: RemoteBrowserAttachment;
    try {
      next = await requestAttachment(requestedViewport);
    } catch (error) {
      if (thisAttempt !== attempt || disposed) {
        return;
      }
      publish({
        phase: {
          kind: "failed",
          error: error instanceof Error ? error : new Error(String(error)),
        },
      });
      return;
    }
    if (closing) {
      // The tab closed while this open/attach was in flight: the browser must not outlive it.
      next.close().catch(() => {});
      return;
    }
    if (thisAttempt !== attempt || disposed) {
      // A newer attempt or the pane's unmount won the race: do not leak this attachment.
      next.detach().catch(() => {});
      return;
    }
    install(next);
  }

  async function requestAttachment(
    requestedViewport: RemoteBrowserViewport,
  ): Promise<RemoteBrowserAttachment> {
    if (binding) {
      try {
        return await input.client.attachRemoteBrowser(binding.browserId, {
          viewport: requestedViewport,
          frames: FRAME_OPTIONS,
        });
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
        setBinding(null);
      }
    }
    return input.client.openRemoteBrowser({
      viewport: requestedViewport,
      url: lastUrl,
      frames: FRAME_OPTIONS,
    });
  }

  function onConnectionChange(): void {
    if (disposed || attachment) {
      return;
    }
    const { kind } = snapshot.phase;
    if ((kind === "idle" || kind === "reconnecting") && isConnected()) {
      void attachOrOpen();
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
    start() {
      if (disposed || unsubscribeConnection) {
        return;
      }
      unsubscribeConnection = input.client.subscribeConnectionStatus(onConnectionChange);
      if (binding && !isConnected()) {
        publish({ phase: { kind: "reconnecting" } });
        armGrace();
        return;
      }
      void attachOrOpen();
    },
    setViewport(next) {
      const previous = viewport;
      viewport = next;
      if (!next) {
        return;
      }
      if (!attachment) {
        if (!previous && !disposed && unsubscribeConnection) {
          void attachOrOpen();
        }
        return;
      }
      const current = attachment;
      cancelResize?.();
      if (viewportsEqual(next, current.state.viewport)) {
        cancelResize = null;
        return;
      }
      cancelResize = schedule(() => {
        cancelResize = null;
        const requested = viewport;
        if (attachment !== current || !requested) {
          return;
        }
        run(current, () => current.resize(requested));
      }, RESIZE_DEBOUNCE_MS);
    },
    setVisible(next) {
      if (visible === next) {
        return;
      }
      visible = next;
      pipeline?.setPaused(!next);
      const current = attachment;
      if (current) {
        run(current, () => current.setVisibility(next));
      }
    },
    navigate(navigation) {
      const current = attachment;
      if (!current) {
        return;
      }
      if (navigation.kind === "url") {
        lastUrl = navigation.url;
      }
      run(current, () => current.navigate(navigation));
    },
    dispatch(events) {
      const current = attachment;
      if (!current || events.length === 0) {
        return;
      }
      run(current, () => current.dispatchInput(events));
    },
    framePainted(frame) {
      if (snapshot.frame === frame) {
        presentationFailures = 0;
      }
      pipeline?.painted(frame);
    },
    framePresentationFailed(frame) {
      const current = attachment;
      if (!current || snapshot.frame !== frame) {
        return;
      }
      presentationFailures += 1;
      clearAttachment();
      publish({ frame: null });
      current.detach().catch(() => {});
      if (presentationFailures <= MAX_PRESENTATION_RETRIES) {
        void attachOrOpen();
        return;
      }
      publish({ phase: { kind: "failed", error: new RemoteBrowserPresentationError() } });
    },
    retry() {
      const { kind } = snapshot.phase;
      if (disposed || closing || attachment || (kind !== "ended" && kind !== "failed")) {
        return;
      }
      presentationFailures = 0;
      if (!isConnected()) {
        publish({ phase: { kind: "reconnecting" } });
        return;
      }
      void attachOrOpen();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      attempt += 1;
      unsubscribeConnection?.();
      unsubscribeConnection = null;
      cancelGrace?.();
      cancelGrace = null;
      const current = attachment;
      clearAttachment();
      if (current) {
        current.detach().catch(() => {});
      }
    },
    closeBrowser() {
      closing = true;
      attempt += 1;
      cancelGrace?.();
      cancelGrace = null;
      const current = attachment;
      const bound = binding;
      setBinding(null);
      publish({
        phase: { kind: "ended", end: { kind: "closed", reason: "closed" } },
        frame: null,
      });
      if (current) {
        clearAttachment();
        current.close().catch(() => {});
        return;
      }
      if (bound && isConnected()) {
        input.client
          .closeRemoteBrowser(bound.browserId, { expectedGeneration: bound.generation })
          .catch(() => {});
      }
    },
  };
}
