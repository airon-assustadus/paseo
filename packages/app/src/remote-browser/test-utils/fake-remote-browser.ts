import type {
  RemoteBrowserAttachment,
  RemoteBrowserEnd,
  RemoteBrowserFrame,
  RemoteBrowserInputEvent,
  RemoteBrowserLimits,
  RemoteBrowserState,
  RemoteBrowserViewport,
} from "@getpaseo/client";
import type { RemoteBrowserClient } from "../session";

/** In-memory stand-ins for the client SDK: no socket, no daemon, every call recorded. */

export const VIEWPORT: RemoteBrowserViewport = {
  width: 400,
  height: 800,
  deviceScaleFactor: 2,
  mobile: true,
  touch: true,
};

export const LIMITS: RemoteBrowserLimits = {
  maxFramesInFlight: 2,
  maxFrameBytes: 1_048_576,
  maxImageEdge: 1920,
  maxImagePixels: 4_194_304,
  maxInputEventsPerRequest: 64,
  maxInputRequestsPerSecond: 120,
  detachedTimeoutMs: 60_000,
  frameAckTimeoutMs: 30_000,
};

export function state(overrides: Partial<RemoteBrowserState> = {}): RemoteBrowserState {
  return {
    url: "http://localhost:3000/",
    title: "Dev",
    canGoBack: false,
    canGoForward: false,
    loading: false,
    error: null,
    focusedEditable: null,
    viewport: VIEWPORT,
    visible: true,
    notice: null,
    ...overrides,
  };
}

export function frame(subscriptionId: string, generation: number, seq: number): RemoteBrowserFrame {
  return {
    subscriptionId,
    generation,
    seq,
    cssWidth: 400,
    cssHeight: 800,
    imageWidth: 800,
    imageHeight: 1600,
    mimeType: "image/jpeg",
    bytes: new Uint8Array([seq]),
  };
}

export interface FakeAttachment extends Omit<RemoteBrowserAttachment, "ended"> {
  ended: RemoteBrowserEnd | null;
  calls: string[];
  acked: number[];
  /** Every `dispatchInput` batch, in order. */
  inputs: RemoteBrowserInputEvent[][];
  emitFrame(frame: RemoteBrowserFrame): void;
  emitState(next: RemoteBrowserState): void;
  emitEnd(end: RemoteBrowserEnd): void;
}

export function createFakeAttachment(input: {
  browserId: string;
  generation: number;
  /** Frames the SDK buffered before any listener; replayed synchronously on `onFrame`. */
  bufferedFrames?: RemoteBrowserFrame[];
  /** Already ended when returned; `onEnd` reports it synchronously. */
  ended?: RemoteBrowserEnd;
  state?: RemoteBrowserState;
}): FakeAttachment {
  const frameListeners = new Set<(frame: RemoteBrowserFrame) => void>();
  const stateListeners = new Set<(next: RemoteBrowserState) => void>();
  const endListeners = new Set<(end: RemoteBrowserEnd) => void>();
  let buffered = input.bufferedFrames ?? [];
  let current = input.state ?? state();
  const attachment: FakeAttachment = {
    browserId: input.browserId,
    subscriptionId: `sub-${input.browserId}-${input.generation}`,
    generation: input.generation,
    limits: LIMITS,
    get state() {
      return current;
    },
    ended: input.ended ?? null,
    calls: [],
    acked: [],
    inputs: [],
    onFrame(listener) {
      frameListeners.add(listener);
      for (const pending of buffered.splice(0)) {
        listener(pending);
      }
      return () => frameListeners.delete(listener);
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onEnd(listener) {
      endListeners.add(listener);
      if (attachment.ended) {
        listener(attachment.ended);
      }
      return () => endListeners.delete(listener);
    },
    ackFrame(next) {
      attachment.acked.push(next.seq);
    },
    async navigate(navigation) {
      attachment.calls.push(`navigate:${navigation.kind}`);
    },
    async dispatchInput(events) {
      attachment.calls.push(`dispatch:${events.length}`);
      attachment.inputs.push(events);
    },
    async resize(viewport) {
      attachment.calls.push(`resize:${viewport.width}x${viewport.height}`);
      return viewport;
    },
    async setVisibility(visible) {
      attachment.calls.push(`visibility:${visible}`);
    },
    async detach() {
      attachment.calls.push("detach");
    },
    async close() {
      attachment.calls.push("close");
    },
    emitFrame(next) {
      for (const listener of frameListeners) listener(next);
    },
    emitState(next) {
      current = next;
      for (const listener of stateListeners) listener(next);
    },
    emitEnd(end) {
      attachment.ended = end;
      for (const listener of endListeners) listener(end);
    },
  };
  return attachment;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function createFakeClient() {
  const connectionListeners = new Set<() => void>();
  let status = "connected";
  const opens: Array<{
    url: string | undefined;
    viewport: RemoteBrowserViewport;
    result: Deferred<RemoteBrowserAttachment>;
  }> = [];
  const attaches: Array<{ browserId: string; result: Deferred<RemoteBrowserAttachment> }> = [];
  const closes: Array<{ browserId: string; expectedGeneration: number | undefined }> = [];
  const client: RemoteBrowserClient = {
    openRemoteBrowser(options) {
      const result = deferred<RemoteBrowserAttachment>();
      opens.push({ url: options.url, viewport: options.viewport, result });
      return result.promise;
    },
    attachRemoteBrowser(browserId) {
      const result = deferred<RemoteBrowserAttachment>();
      attaches.push({ browserId, result });
      return result.promise;
    },
    async closeRemoteBrowser(browserId, options) {
      closes.push({ browserId, expectedGeneration: options?.expectedGeneration });
    },
    getConnectionState: () => ({ status }),
    subscribeConnectionStatus(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
  };
  return {
    client,
    opens,
    attaches,
    closes,
    setStatus(next: string) {
      status = next;
      for (const listener of connectionListeners) listener();
    },
  };
}

export function createTimers() {
  const scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  return {
    schedule(callback: () => void, delayMs: number) {
      const entry = { callback, delayMs, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    fire(predicate?: (delayMs: number) => boolean) {
      for (const entry of scheduled.splice(0)) {
        if (entry.cancelled) continue;
        if (predicate && !predicate(entry.delayMs)) {
          scheduled.push(entry);
          continue;
        }
        entry.callback();
      }
    },
    pending() {
      return scheduled.filter((entry) => !entry.cancelled);
    },
  };
}
