import {
  encodeNetworkFetchFrame,
  NetworkFetchOpcode,
  type NetworkFetchClientFrame,
  type NetworkFetchServerFrame,
} from "@getpaseo/protocol/binary-frames/index";
import {
  NETWORK_FETCH_LIMITS,
  NetworkFetchLimitsSchema,
  type NetworkFetchClosedReason,
  type NetworkFetchOpened,
  type NetworkFetchOpenRequest,
  type NetworkFetchRpcFailure,
} from "@getpaseo/protocol/network-fetch/rpc-schemas";

export type {
  NetworkFetchDescriptor,
  NetworkFetchScope,
  NetworkFetchLimits,
  NetworkFetchReconciliation,
  NetworkFetchCleanupPending,
  NetworkFetchRpcFailure,
} from "@getpaseo/protocol/network-fetch/rpc-schemas";
export type {
  NetworkFetchClientFrame,
  NetworkFetchServerFrame,
  NetworkFetchRequestMetadata,
  NetworkFetchResponseHead,
  NetworkFetchFailure,
} from "@getpaseo/protocol/binary-frames/index";
export { NetworkFetchOpcode } from "@getpaseo/protocol/binary-frames/index";
export type NetworkFetchOpenOptions = Omit<NetworkFetchOpenRequest, "type" | "requestId">;
export type NetworkFetchOperation =
  | "resolve_destination"
  | "reconcile_destination"
  | "open"
  | "close"
  | "request_cleanup";
export type NetworkFetchEnd = NetworkFetchClosedReason | "channel_lost" | "protocol_error";
export type NetworkFetchSendFrame = NetworkFetchClientFrame extends infer Frame
  ? Frame extends NetworkFetchClientFrame
    ? Omit<Frame, "subscriptionId">
    : never
  : never;
export class NetworkFetchRpcError extends Error {
  constructor(
    readonly operation: NetworkFetchOperation,
    readonly code: NetworkFetchRpcFailure["code"] | "channel_lost" | "protocol_error",
  ) {
    super(`Network fetch ${operation}: ${code}`);
    this.name = "NetworkFetchRpcError";
  }
}
export interface NetworkFetch extends NetworkFetchOpened {
  readonly ended: NetworkFetchEnd | null;
  send(frame: NetworkFetchSendFrame): void;
  onFrame(listener: (frame: NetworkFetchServerFrame) => void): () => void;
  onEnd(listener: (reason: NetworkFetchEnd) => void): () => void;
  close(): Promise<void>;
}
export interface NetworkFetchConnection {
  send(frame: Uint8Array): void;
  close(subscriptionId: string): Promise<void>;
  handlerError(): void;
}
interface Exchange {
  uploadRemaining: number;
  uploadTotal: number;
  uploadLength: number | null;
  uploadEnded: boolean;
  responseRemaining: number;
  responseTotal: number;
  headed: boolean;
  cancelling: boolean;
}
export function withinNetworkFetchLimits(
  limits: NetworkFetchOpened["limits"],
  requested: NetworkFetchOpenOptions["limits"],
): boolean {
  return (
    NetworkFetchLimitsSchema.safeParse(limits).success &&
    limits.maxChunkBytes <= limits.initialWindowBytes &&
    (Object.keys(NETWORK_FETCH_LIMITS) as (keyof typeof NETWORK_FETCH_LIMITS)[]).every(
      (key) => limits[key] <= (requested?.[key] ?? NETWORK_FETCH_LIMITS[key]),
    )
  );
}
class FetchHandle implements NetworkFetch {
  readonly subscriptionId: string;
  readonly descriptor: NetworkFetchOpened["descriptor"];
  readonly limits: NetworkFetchOpened["limits"];
  ended: NetworkFetchEnd | null = null;
  private lastFetchId = 0;
  private readonly exchanges = new Map<number, Exchange>();
  private readonly frameListeners = new Set<(frame: NetworkFetchServerFrame) => void>();
  private readonly endListeners = new Set<(reason: NetworkFetchEnd) => void>();
  private closing: Promise<void> | null = null;
  private readonly pendingFrames: NetworkFetchServerFrame[] = [];
  private delivering = false;

  constructor(
    opened: NetworkFetchOpened,
    private readonly connection: NetworkFetchConnection,
    private readonly release: () => void,
  ) {
    this.subscriptionId = opened.subscriptionId;
    this.descriptor = Object.freeze({ ...opened.descriptor });
    this.limits = Object.freeze({ ...opened.limits });
  }
  onFrame(listener: (frame: NetworkFetchServerFrame) => void): () => void {
    if (!this.ended) this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }
  onEnd(listener: (reason: NetworkFetchEnd) => void): () => void {
    if (this.ended) this.deliver(() => listener(this.ended!));
    else this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }
  send(frame: NetworkFetchSendFrame): void {
    if (this.ended) throw new NetworkFetchRpcError("open", "channel_lost");
    const bytes = encodeNetworkFetchFrame(
      { ...frame, subscriptionId: this.subscriptionId },
      "client_to_host",
    );
    const exchange = this.exchanges.get(frame.fetchId);
    if (frame.opcode === NetworkFetchOpcode.Request) {
      this.beginRequest(
        frame,
        bytes.length - 6 - new TextEncoder().encode(this.subscriptionId).length,
      );
    } else {
      if (!exchange || exchange.cancelling)
        throw new NetworkFetchRpcError("open", "protocol_error");
      switch (frame.opcode) {
        case NetworkFetchOpcode.Body:
          if (
            exchange.uploadEnded ||
            frame.data.length > this.limits.maxChunkBytes ||
            frame.data.length > exchange.uploadRemaining ||
            exchange.uploadTotal + frame.data.length >
              Math.min(exchange.uploadLength ?? Infinity, this.limits.maxRequestBodyBytes)
          ) {
            throw new NetworkFetchRpcError("open", "limit_exceeded");
          }
          exchange.uploadRemaining -= frame.data.length;
          exchange.uploadTotal += frame.data.length;
          break;
        case NetworkFetchOpcode.End:
          if (
            exchange.uploadEnded ||
            (exchange.uploadLength !== null && exchange.uploadTotal !== exchange.uploadLength)
          )
            throw new NetworkFetchRpcError("open", "protocol_error");
          exchange.uploadEnded = true;
          break;
        case NetworkFetchOpcode.Credit:
          if (exchange.responseRemaining + frame.bytes > this.limits.initialWindowBytes)
            throw new NetworkFetchRpcError("open", "protocol_error");
          exchange.responseRemaining += frame.bytes;
          break;
        case NetworkFetchOpcode.Cancel:
          exchange.cancelling = true;
          break;
      }
    }
    try {
      this.connection.send(bytes);
    } catch {
      this.finish("channel_lost");
      throw new NetworkFetchRpcError("open", "channel_lost");
    }
  }
  private beginRequest(
    frame: Extract<NetworkFetchSendFrame, { opcode: typeof NetworkFetchOpcode.Request }>,
    metadataBytes: number,
  ): void {
    if (!this.frameListeners.size || frame.fetchId <= this.lastFetchId)
      throw new NetworkFetchRpcError("open", "protocol_error");
    if (
      this.exchanges.size >= this.limits.maxConcurrentRequests ||
      metadataBytes > this.limits.maxRequestHeadBytes ||
      (frame.request.body.kind === "stream" &&
        (frame.request.body.length ?? 0) > this.limits.maxRequestBodyBytes)
    ) {
      throw new NetworkFetchRpcError("open", "limit_exceeded");
    }
    this.lastFetchId = frame.fetchId;
    this.exchanges.set(frame.fetchId, {
      uploadRemaining: this.limits.initialWindowBytes,
      uploadTotal: 0,
      uploadLength: frame.request.body.kind === "stream" ? frame.request.body.length : 0,
      uploadEnded: frame.request.body.kind === "none",
      responseRemaining: this.limits.initialWindowBytes,
      responseTotal: 0,
      headed: false,
      cancelling: false,
    });
  }
  receive(frame: NetworkFetchServerFrame): boolean {
    if (this.ended) return true;
    if (!this.frameListeners.size || this.pendingFrames.length >= 256) return false;
    const exchange = this.exchanges.get(frame.fetchId);
    if (!exchange) return frame.fetchId <= this.lastFetchId;
    if (
      exchange.cancelling &&
      frame.opcode !== NetworkFetchOpcode.Cancelled &&
      frame.opcode !== NetworkFetchOpcode.End &&
      frame.opcode !== NetworkFetchOpcode.Fail
    )
      return true;
    if (!this.acceptFrame(frame, exchange)) return false;
    this.pendingFrames.push(frame);
    this.drainFrames();
    return true;
  }
  private acceptFrame(frame: NetworkFetchServerFrame, exchange: Exchange): boolean {
    switch (frame.opcode) {
      case NetworkFetchOpcode.Head:
        if (
          exchange.headed ||
          new TextEncoder().encode(JSON.stringify(frame.head)).length >
            this.limits.maxResponseHeadBytes
        )
          return false;
        exchange.headed = true;
        break;
      case NetworkFetchOpcode.Body:
        if (
          !exchange.headed ||
          frame.data.length > this.limits.maxChunkBytes ||
          frame.data.length > exchange.responseRemaining ||
          exchange.responseTotal + frame.data.length > this.limits.maxResponseBodyBytes
        )
          return false;
        exchange.responseRemaining -= frame.data.length;
        exchange.responseTotal += frame.data.length;
        break;
      case NetworkFetchOpcode.Credit:
        if (exchange.uploadRemaining + frame.bytes > this.limits.initialWindowBytes) return false;
        exchange.uploadRemaining += frame.bytes;
        break;
      case NetworkFetchOpcode.End:
        if (!exchange.headed && !exchange.cancelling) return false;
        this.exchanges.delete(frame.fetchId);
        break;
      case NetworkFetchOpcode.Cancelled:
        if (!exchange.cancelling) return false;
        this.exchanges.delete(frame.fetchId);
        break;
      case NetworkFetchOpcode.Fail:
        this.exchanges.delete(frame.fetchId);
        break;
    }
    return true;
  }
  private drainFrames(): void {
    if (this.delivering) return;
    this.delivering = true;
    try {
      while (this.pendingFrames.length && !this.ended) {
        const pending = this.pendingFrames.shift()!;
        const listeners = Array.from(this.frameListeners);
        for (const listener of listeners) {
          if (this.ended) break;
          this.deliver(() => listener(pending));
        }
      }
    } finally {
      this.delivering = false;
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.ended) return Promise.resolve();
    this.finish("closed");
    this.closing = this.connection.close(this.subscriptionId);
    return this.closing;
  }
  finish(reason: NetworkFetchEnd): void {
    if (this.ended) return;
    this.ended = reason;
    this.exchanges.clear();
    this.pendingFrames.length = 0;
    this.frameListeners.clear();
    this.release();
    for (const listener of this.endListeners) this.deliver(() => listener(reason));
    this.endListeners.clear();
  }
  private deliver(callback: () => void): void {
    try {
      callback();
    } catch {
      this.connection.handlerError();
    }
  }
}
export class NetworkFetchRegistry {
  private readonly handles = new Map<string, FetchHandle>();
  private readonly retired = new Set<string>();
  constructor(private readonly connection: NetworkFetchConnection) {}
  open(opened: NetworkFetchOpened): NetworkFetch {
    encodeNetworkFetchFrame({
      opcode: NetworkFetchOpcode.End,
      subscriptionId: opened.subscriptionId,
      fetchId: 1,
    });
    if (this.handles.has(opened.subscriptionId) || this.retired.has(opened.subscriptionId))
      throw new NetworkFetchRpcError("open", "protocol_error");
    const handle = new FetchHandle(opened, this.connection, () => {
      this.handles.delete(opened.subscriptionId);
      this.retired.add(opened.subscriptionId);
      if (this.retired.size > 256) this.retired.delete(this.retired.values().next().value!);
    });
    this.handles.set(opened.subscriptionId, handle);
    return handle;
  }
  receive(frame: NetworkFetchServerFrame): boolean {
    return (
      this.handles.get(frame.subscriptionId)?.receive(frame) ??
      this.retired.has(frame.subscriptionId)
    );
  }
  closed(subscriptionId: string, reason: NetworkFetchClosedReason): boolean {
    const handle = this.handles.get(subscriptionId);
    if (!handle) return this.retired.has(subscriptionId);
    handle.finish(reason);
    return true;
  }
  disconnected(): void {
    for (const handle of this.handles.values()) handle.finish("channel_lost");
    this.retired.clear();
  }
}
