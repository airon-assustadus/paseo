import {
  encodeRemoteBrowserFrame,
  RemoteBrowserOpcode,
  type RemoteBrowserBinaryFrame,
} from "@getpaseo/protocol/binary-frames/index";
import {
  REMOTE_BROWSER_MAX_FRAME_BYTES,
  REMOTE_BROWSER_MAX_FRAMES_IN_FLIGHT,
  REMOTE_BROWSER_MAX_IMAGE_EDGE,
  REMOTE_BROWSER_MAX_IMAGE_PIXELS,
  REMOTE_BROWSER_VIEWPORT_MAX,
  type RemoteBrowserInputEvent,
  type RemoteBrowserLimits,
  type RemoteBrowserNavigation,
  type RemoteBrowserState,
  type RemoteBrowserViewport,
} from "@getpaseo/protocol/remote-browser/rpc-schemas";

export type {
  RemoteBrowserFrameOptions,
  RemoteBrowserInputEvent,
  RemoteBrowserLimits,
  RemoteBrowserNavigation,
  RemoteBrowserState,
  RemoteBrowserSummary,
  RemoteBrowserViewport,
} from "@getpaseo/protocol/remote-browser/rpc-schemas";

export type RemoteBrowserOperation =
  | "open"
  | "attach"
  | "detach"
  | "close"
  | "list"
  | "navigate"
  | "dispatch_input"
  | "resize"
  | "set_visibility";

export class RemoteBrowserRpcError extends Error {
  constructor(
    readonly operation: RemoteBrowserOperation,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RemoteBrowserRpcError";
  }
}

export interface RemoteBrowserFrame {
  readonly subscriptionId: string;
  readonly generation: number;
  readonly seq: number;
  /** CSS viewport the image shows. Map input with `x = imageX * cssWidth / imageWidth`. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly mimeType: "image/jpeg";
  readonly bytes: Uint8Array;
}

export type RemoteBrowserEnd =
  | { kind: "detached"; reason: string }
  | { kind: "closed"; reason: string }
  | { kind: "disconnected"; reason: "disconnected" };

export interface RemoteBrowserAttachment {
  readonly browserId: string;
  readonly subscriptionId: string;
  readonly generation: number;
  readonly limits: RemoteBrowserLimits;
  /** Latest state; `onState` reports each change. */
  readonly state: RemoteBrowserState;
  readonly ended: RemoteBrowserEnd | null;
  /**
   * Frames that arrived before the first listener are held in order (at most
   * `limits.maxFramesInFlight`, the daemon's unacknowledged window) and replayed to it, so a frame
   * delivered in the same turn as the open/attach reply is not lost.
   */
  onFrame(listener: (frame: RemoteBrowserFrame) => void): () => void;
  onState(listener: (state: RemoteBrowserState) => void): () => void;
  onEnd(listener: (end: RemoteBrowserEnd) => void): () => void;
  /**
   * Exact: call it once per frame after painting it. Paint and acknowledge every frame in order;
   * a frame that is never acknowledged keeps its credit until the daemon's ack timeout.
   */
  ackFrame(frame: RemoteBrowserFrame): void;
  navigate(navigation: RemoteBrowserNavigation): Promise<void>;
  dispatchInput(events: RemoteBrowserInputEvent[]): Promise<void>;
  resize(viewport: RemoteBrowserViewport): Promise<RemoteBrowserViewport>;
  setVisibility(visible: boolean): Promise<void>;
  /** Ends this attachment; the browser keeps running for `limits.detachedTimeoutMs`. No-op once ended. */
  detach(): Promise<void>;
  /**
   * Closes the browser only if no newer attachment took it over (`expectedGeneration`). Still
   * allowed after the attachment ended, so a pane can clean up after a disconnect.
   */
  close(): Promise<void>;
}

export interface RemoteBrowserAttachmentIdentity {
  browserId: string;
  subscriptionId: string;
  generation: number;
}

/** Daemon operations the registry needs; DaemonClient implements them over its session RPCs. */
export interface RemoteBrowserConnection {
  sendBinary(frame: Uint8Array): void;
  navigate(
    identity: RemoteBrowserAttachmentIdentity,
    navigation: RemoteBrowserNavigation,
  ): Promise<void>;
  dispatchInput(
    identity: RemoteBrowserAttachmentIdentity,
    events: RemoteBrowserInputEvent[],
  ): Promise<void>;
  resize(
    identity: RemoteBrowserAttachmentIdentity,
    viewport: RemoteBrowserViewport,
  ): Promise<RemoteBrowserViewport>;
  setVisibility(identity: RemoteBrowserAttachmentIdentity, visible: boolean): Promise<void>;
  detach(identity: RemoteBrowserAttachmentIdentity): Promise<void>;
  close(browserId: string, expectedGeneration: number): Promise<void>;
}

export interface RemoteBrowserAttachedPayload extends RemoteBrowserAttachmentIdentity {
  limits: RemoteBrowserLimits;
  state: RemoteBrowserState;
}

type FrameMessage = Extract<RemoteBrowserBinaryFrame, { opcode: typeof RemoteBrowserOpcode.Frame }>;

/** Announced limits above the protocol ceilings would let the daemon overrun this client's buffers. */
export function withinRemoteBrowserCeilings(limits: RemoteBrowserLimits): boolean {
  return (
    limits.maxFramesInFlight <= REMOTE_BROWSER_MAX_FRAMES_IN_FLIGHT &&
    limits.maxFrameBytes <= REMOTE_BROWSER_MAX_FRAME_BYTES &&
    limits.maxImageEdge <= REMOTE_BROWSER_MAX_IMAGE_EDGE &&
    limits.maxImagePixels <= REMOTE_BROWSER_MAX_IMAGE_PIXELS
  );
}

function frameWithinLimits(frame: FrameMessage, limits: RemoteBrowserLimits): boolean {
  return (
    frame.image.length <= limits.maxFrameBytes &&
    frame.imageWidth <= limits.maxImageEdge &&
    frame.imageHeight <= limits.maxImageEdge &&
    frame.imageWidth * frame.imageHeight <= limits.maxImagePixels &&
    frame.cssWidth <= REMOTE_BROWSER_VIEWPORT_MAX &&
    frame.cssHeight <= REMOTE_BROWSER_VIEWPORT_MAX
  );
}

class Attachment implements RemoteBrowserAttachment {
  readonly browserId: string;
  readonly subscriptionId: string;
  readonly generation: number;
  readonly limits: RemoteBrowserLimits;
  state: RemoteBrowserState;
  ended: RemoteBrowserEnd | null = null;
  private readonly frameListeners = new Set<(frame: RemoteBrowserFrame) => void>();
  private readonly stateListeners = new Set<(state: RemoteBrowserState) => void>();
  private readonly endListeners = new Set<(end: RemoteBrowserEnd) => void>();
  /** Frames received while nobody listened, oldest first; replayed to the first listener. */
  private held: RemoteBrowserFrame[] = [];
  /** Sequences handed to listeners and not yet acknowledged; each is acknowledged at most once. */
  private readonly unacked = new Set<number>();
  private lastSeq = -1;

  constructor(
    payload: RemoteBrowserAttachedPayload,
    private readonly connection: RemoteBrowserConnection,
    private readonly onEnded: (attachment: Attachment) => void,
  ) {
    this.browserId = payload.browserId;
    this.subscriptionId = payload.subscriptionId;
    this.generation = payload.generation;
    this.limits = payload.limits;
    this.state = payload.state;
  }

  private get identity(): RemoteBrowserAttachmentIdentity {
    return {
      browserId: this.browserId,
      subscriptionId: this.subscriptionId,
      generation: this.generation,
    };
  }

  onFrame(listener: (frame: RemoteBrowserFrame) => void): () => void {
    if (this.ended) return () => {};
    this.frameListeners.add(listener);
    const held = this.held;
    this.held = [];
    for (const frame of held) this.deliver(frame);
    return () => this.frameListeners.delete(listener);
  }

  onState(listener: (state: RemoteBrowserState) => void): () => void {
    if (this.ended) return () => {};
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onEnd(listener: (end: RemoteBrowserEnd) => void): () => void {
    if (this.ended) {
      listener(this.ended);
      return () => {};
    }
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  ackFrame(frame: RemoteBrowserFrame): void {
    if (this.ended || frame.subscriptionId !== this.subscriptionId) return;
    if (frame.generation !== this.generation) return;
    // Only frames handed to a listener can be acknowledged, and each sequence at most once.
    if (!this.unacked.delete(frame.seq)) return;
    this.connection.sendBinary(
      encodeRemoteBrowserFrame({
        opcode: RemoteBrowserOpcode.FrameAck,
        subscriptionId: this.subscriptionId,
        generation: this.generation,
        seq: frame.seq,
      }),
    );
  }

  navigate(navigation: RemoteBrowserNavigation): Promise<void> {
    return this.whileLive("navigate", () => this.connection.navigate(this.identity, navigation));
  }

  dispatchInput(events: RemoteBrowserInputEvent[]): Promise<void> {
    return this.whileLive("dispatch_input", () =>
      this.connection.dispatchInput(this.identity, events),
    );
  }

  resize(viewport: RemoteBrowserViewport): Promise<RemoteBrowserViewport> {
    return this.whileLive("resize", () => this.connection.resize(this.identity, viewport));
  }

  setVisibility(visible: boolean): Promise<void> {
    return this.whileLive("set_visibility", () =>
      this.connection.setVisibility(this.identity, visible),
    );
  }

  async detach(): Promise<void> {
    if (this.ended) return;
    await this.connection.detach(this.identity);
    this.end({ kind: "detached", reason: "detached" });
  }

  async close(): Promise<void> {
    // A detached browser keeps the generation of its last attachment, so this still closes the
    // browser this pane owned after a disconnect, and never one a newer attachment took over.
    await this.connection.close(this.browserId, this.generation);
    this.end({ kind: "closed", reason: "closed" });
  }

  /** Returns false when the frame breaks the announced limits; the caller ends the attachment. */
  receiveFrame(frame: FrameMessage): boolean {
    if (this.ended || frame.generation !== this.generation) return true;
    if (!frameWithinLimits(frame, this.limits)) return false;
    // Sequences only grow within an attachment; anything else is a replay or reordering.
    if (frame.seq <= this.lastSeq) return false;
    // The daemon never has more than maxFramesInFlight unacknowledged frames out.
    if (this.unacked.size + this.held.length >= this.limits.maxFramesInFlight) return false;
    this.lastSeq = frame.seq;
    const delivered: RemoteBrowserFrame = {
      subscriptionId: frame.subscriptionId,
      generation: frame.generation,
      seq: frame.seq,
      cssWidth: frame.cssWidth,
      cssHeight: frame.cssHeight,
      imageWidth: frame.imageWidth,
      imageHeight: frame.imageHeight,
      mimeType: "image/jpeg",
      bytes: frame.image,
    };
    if (this.frameListeners.size === 0) {
      this.held.push(delivered);
      return true;
    }
    this.deliver(delivered);
    return true;
  }

  receiveState(generation: number, state: RemoteBrowserState): void {
    if (this.ended || generation !== this.generation) return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  end(end: RemoteBrowserEnd): void {
    if (this.ended) return;
    this.ended = end;
    this.held = [];
    this.unacked.clear();
    this.frameListeners.clear();
    this.stateListeners.clear();
    this.onEnded(this);
    const listeners = [...this.endListeners];
    this.endListeners.clear();
    for (const listener of listeners) listener(end);
  }

  private deliver(frame: RemoteBrowserFrame): void {
    this.unacked.add(frame.seq);
    for (const listener of this.frameListeners) listener(frame);
  }

  private whileLive<T>(operation: RemoteBrowserOperation, run: () => Promise<T>): Promise<T> {
    if (this.ended) {
      return Promise.reject(
        new RemoteBrowserRpcError(operation, "stale_attachment", "This attachment has ended."),
      );
    }
    return run();
  }
}

/**
 * Routes daemon frames and events to live attachments by subscription ID. An attachment object
 * never outlives its subscription: after it ends, attachment operations reject, `detach()` is a
 * no-op, and only the generation-guarded `close()` still reaches the daemon. A re-attach returns a
 * new object with a new subscription ID and generation.
 */
export class RemoteBrowserRegistry {
  private readonly attachments = new Map<string, Attachment>();

  constructor(private readonly connection: RemoteBrowserConnection) {}

  /** Registers the attachment, or returns null when the announced limits exceed the ceilings. */
  attach(payload: RemoteBrowserAttachedPayload): RemoteBrowserAttachment | null {
    if (!withinRemoteBrowserCeilings(payload.limits)) return null;
    const attachment = new Attachment(payload, this.connection, (ended) => this.forget(ended));
    this.attachments.set(payload.subscriptionId, attachment);
    return attachment;
  }

  /** Detaches an attachment the client refused to register; failures leave it to the ack timeout. */
  async detachUnregistered(identity: RemoteBrowserAttachmentIdentity): Promise<void> {
    await this.connection
      .detach({
        browserId: identity.browserId,
        subscriptionId: identity.subscriptionId,
        generation: identity.generation,
      })
      .catch(() => {});
  }

  receiveFrame(frame: RemoteBrowserBinaryFrame): void {
    if (frame.opcode !== RemoteBrowserOpcode.Frame) return;
    // Frames sent before the daemon processed a detach can still arrive; they carry no authority.
    const attachment = this.attachments.get(frame.subscriptionId);
    if (!attachment || attachment.receiveFrame(frame)) return;
    attachment.end({ kind: "detached", reason: "protocol_error" });
    void this.detachUnregistered(attachment);
  }

  receiveState(subscriptionId: string, generation: number, state: RemoteBrowserState): void {
    this.attachments.get(subscriptionId)?.receiveState(generation, state);
  }

  receiveDetached(subscriptionId: string, reason: string): void {
    this.attachments.get(subscriptionId)?.end({ kind: "detached", reason });
  }

  receiveClosed(subscriptionId: string, reason: string): void {
    this.attachments.get(subscriptionId)?.end({ kind: "closed", reason });
  }

  /** The daemon detaches every attachment of a lost socket; the browsers survive the detach grace. */
  disconnected(): void {
    for (const attachment of this.attachments.values()) {
      attachment.end({ kind: "disconnected", reason: "disconnected" });
    }
  }

  private forget(attachment: Attachment): void {
    if (this.attachments.get(attachment.subscriptionId) === attachment) {
      this.attachments.delete(attachment.subscriptionId);
    }
  }
}
