import type { Readable, Writable } from "node:stream";

/** One CDP message is NUL-terminated JSON on the pipe. Larger messages mean a broken peer. */
const MAX_INBOUND_MESSAGE_BYTES = 32 * 1024 * 1024;

export class CdpError extends Error {
  constructor(
    readonly method: string,
    readonly kind: "timeout" | "closed" | "protocol" | "busy" | "aborted",
    message: string,
  ) {
    super(message);
    this.name = "CdpError";
  }
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpSendOptions {
  sessionId?: string;
  timeoutMs?: number;
  /** Checked immediately before the command is written; an aborted signal writes nothing. */
  signal?: AbortSignal;
}

export interface CdpConnectionOptions {
  /** Daemon → Chromium (fd 3). */
  output: Writable;
  /** Chromium → daemon (fd 4). */
  input: Readable;
  maxInFlight: number;
  defaultTimeoutMs: number;
  /** Called after this many consecutive command timeouts; the owner closes the browser. */
  maxConsecutiveTimeouts: number;
  onUnresponsive: () => void;
  /** A throwing event listener is reported here and never escapes into the pipe's data handler. */
  onListenerError?: (error: unknown, method: string) => void;
}

interface Pending {
  method: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Chrome DevTools Protocol over `--remote-debugging-pipe`: only the daemon holds the pipe, so no
 * DevTools port exists. Commands are bounded in number and time.
 */
export class CdpConnection {
  private readonly output: Writable;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private readonly options: CdpConnectionOptions;
  private nextId = 1;
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private consecutiveTimeouts = 0;
  private closedReason: string | null = null;

  constructor(options: CdpConnectionOptions) {
    this.options = options;
    this.output = options.output;
    options.input.on("data", (chunk: Buffer) => this.receive(chunk));
    options.input.on("close", () => this.close("CDP pipe closed"));
    options.input.on("error", () => this.close("CDP pipe failed"));
    options.output.on("error", () => this.close("CDP pipe failed"));
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  get inFlight(): number {
    return this.pending.size;
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    options: CdpSendOptions = {},
  ): Promise<Record<string, unknown>> {
    if (this.closedReason) {
      return Promise.reject(new CdpError(method, "closed", this.closedReason));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new CdpError(method, "aborted", "Operation was cancelled"));
    }
    if (this.pending.size >= this.options.maxInFlight) {
      return Promise.reject(new CdpError(method, "busy", "Too many CDP commands in flight"));
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(method, "timeout", `${method} timed out after ${timeoutMs}ms`));
        this.consecutiveTimeouts += 1;
        if (this.consecutiveTimeouts >= this.options.maxConsecutiveTimeouts) {
          this.options.onUnresponsive();
        }
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      const message = {
        id,
        method,
        params,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      };
      this.output.write(`${JSON.stringify(message)}\0`);
    });
  }

  close(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CdpError(pending.method, "closed", reason));
      this.pending.delete(id);
    }
    this.buffered = [];
    this.bufferedBytes = 0;
    this.listeners.clear();
  }

  private receive(chunk: Buffer): void {
    if (this.closedReason) return;
    let start = 0;
    let end = chunk.indexOf(0, start);
    while (end !== -1) {
      if (this.bufferedBytes + (end - start) > MAX_INBOUND_MESSAGE_BYTES) {
        this.fail("CDP message exceeded the size limit");
        return;
      }
      this.buffered.push(chunk.subarray(start, end));
      const message = Buffer.concat(this.buffered).toString("utf8");
      this.buffered = [];
      this.bufferedBytes = 0;
      this.dispatch(message);
      if (this.closedReason) return;
      start = end + 1;
      end = chunk.indexOf(0, start);
    }
    if (start < chunk.length) {
      this.buffered.push(chunk.subarray(start));
      this.bufferedBytes += chunk.length - start;
      if (this.bufferedBytes > MAX_INBOUND_MESSAGE_BYTES) {
        this.fail("CDP message exceeded the size limit");
      }
    }
  }

  /** A peer that breaks framing cannot be trusted further: close and let the owner end the browser. */
  private fail(reason: string): void {
    this.close(reason);
    this.options.onUnresponsive();
  }

  private dispatch(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.fail("CDP sent malformed JSON");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.fail("CDP sent a message that is not an object");
      return;
    }
    const message = parsed as {
      id?: unknown;
      method?: unknown;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { message?: unknown };
      sessionId?: unknown;
    };
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      this.consecutiveTimeouts = 0;
      if (message.error) {
        pending.reject(
          new CdpError(
            pending.method,
            "protocol",
            typeof message.error.message === "string"
              ? message.error.message
              : "CDP command failed",
          ),
        );
        return;
      }
      const result = message.result;
      pending.resolve(
        typeof result === "object" && result !== null && !Array.isArray(result) ? result : {},
      );
      return;
    }
    if (typeof message.method !== "string") return;
    const params =
      typeof message.params === "object" &&
      message.params !== null &&
      !Array.isArray(message.params)
        ? message.params
        : {};
    const event: CdpEvent = {
      method: message.method,
      params,
      ...(typeof message.sessionId === "string" ? { sessionId: message.sessionId } : {}),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.options.onListenerError?.(error, event.method);
      }
    }
  }
}
