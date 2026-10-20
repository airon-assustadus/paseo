/**
 * What the fixture saw, for tests to assert against. Events carry the per-request nonce so a test
 * can correlate one attempt end to end (page → transport → fixture) without relying on timing or
 * source addresses. Events never hold cookie values, credentials, or request bodies: only names,
 * counts, and the synthetic probe report.
 */

export type FixtureListenerName =
  | "http"
  | "https"
  | "https:wrongHost"
  | "https:expired"
  | "https:selfSigned"
  | "canary";

export interface SafeRequestHeaders {
  host: string | null;
  origin: string | null;
  referer: string | null;
  userAgent: string | null;
  secFetchSite: string | null;
  secFetchMode: string | null;
  secFetchDest: string | null;
}

interface FixtureEventBase {
  at: number;
  listener: FixtureListenerName;
  nonce: string;
}

export interface RequestEvent extends FixtureEventBase {
  kind: "request";
  method: string;
  path: string;
  remoteAddress: string;
  /** Lower-cased, de-duplicated, sorted: proves whether hop-by-hop headers reached the origin. */
  headerNames: string[];
  cookieNames: string[];
  headers: SafeRequestHeaders;
}

export interface CanaryHitEvent extends FixtureEventBase {
  kind: "canary.hit";
  token: string;
  vector: string | null;
  method: string;
  remoteAddress: string;
  userAgent: string | null;
  origin: string | null;
  referer: string | null;
}

export interface SlowClosedEvent extends FixtureEventBase {
  kind: "slow.closed";
  completed: boolean;
  bytesSent: number;
}

export interface LargeClosedEvent extends FixtureEventBase {
  kind: "large.closed";
  completed: boolean;
  bytesSent: number;
  /** Peak `writableLength` while streaming: evidence that backpressure kept the body out of memory. */
  maxBuffered: number;
}

export interface UploadFinishedEvent extends FixtureEventBase {
  kind: "upload.finished";
  completed: boolean;
  bytesReceived: number;
  rejected: "too_large" | null;
}

export interface SseClosedEvent extends FixtureEventBase {
  kind: "sse.closed";
  completed: boolean;
  eventsSent: number;
  resumedAfter: number | null;
}

export interface WsOpenedEvent extends FixtureEventBase {
  kind: "ws.opened";
  path: string;
  origin: string | null;
  subprotocol: string | null;
}

export interface WsClosedEvent extends FixtureEventBase {
  kind: "ws.closed";
  path: string;
  code: number;
  reason: string;
}

export interface RedirectLandingEvent extends FixtureEventBase {
  kind: "redirect.landing";
  method: string;
  bodyBytes: number;
}

export interface ProbeReportEvent extends FixtureEventBase {
  kind: "probe.report";
  report: unknown;
}

export interface PostCountEvent extends FixtureEventBase {
  kind: "post.count";
  token: string;
  count: number;
}

export type FixtureEvent =
  | RequestEvent
  | CanaryHitEvent
  | SlowClosedEvent
  | LargeClosedEvent
  | UploadFinishedEvent
  | SseClosedEvent
  | WsOpenedEvent
  | WsClosedEvent
  | RedirectLandingEvent
  | ProbeReportEvent
  | PostCountEvent;

export type FixtureEventKind = FixtureEvent["kind"];
export type FixtureEventOf<K extends FixtureEventKind> = Extract<FixtureEvent, { kind: K }>;
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type FixtureEventInput = DistributiveOmit<FixtureEvent, "at">;

export class FixtureWaitTimeoutError extends Error {
  constructor(
    public readonly kind: FixtureEventKind,
    public readonly waitedMs: number,
    public readonly seenKinds: readonly FixtureEventKind[],
  ) {
    super(
      `No "${kind}" event matched within ${waitedMs}ms; seen kinds: ${seenKinds.join(", ") || "none"}`,
    );
    this.name = "FixtureWaitTimeoutError";
  }
}

interface Waiter {
  kind: FixtureEventKind;
  accept(event: FixtureEvent): boolean;
}

export class FixtureRecorder {
  private readonly events: FixtureEvent[] = [];
  private readonly waiters = new Set<Waiter>();
  private droppedCount = 0;

  constructor(private readonly maxEvents: number) {}

  /** Events discarded because the buffer was full; a test that sees this grew past its own limit. */
  get dropped(): number {
    return this.droppedCount;
  }

  record(input: FixtureEventInput): FixtureEvent {
    const event = { ...input, at: Date.now() } as FixtureEvent;
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
      this.droppedCount += 1;
    }
    for (const waiter of this.waiters) {
      if (waiter.kind === event.kind && waiter.accept(event)) this.waiters.delete(waiter);
    }
    return event;
  }

  list(): readonly FixtureEvent[] {
    return this.events;
  }

  ofKind<K extends FixtureEventKind>(kind: K): FixtureEventOf<K>[] {
    return this.events.filter((event): event is FixtureEventOf<K> => event.kind === kind);
  }

  waitFor<K extends FixtureEventKind>(
    kind: K,
    predicate: (event: FixtureEventOf<K>) => boolean = () => true,
    timeoutMs = 5000,
  ): Promise<FixtureEventOf<K>> {
    const existing = this.ofKind(kind).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        kind,
        accept: (event) => {
          const typed = event as FixtureEventOf<K>;
          if (!predicate(typed)) return false;
          clearTimeout(timer);
          resolve(typed);
          return true;
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(
          new FixtureWaitTimeoutError(kind, timeoutMs, [
            ...new Set(this.events.map((e) => e.kind)),
          ]),
        );
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  clear(): void {
    this.events.length = 0;
    this.droppedCount = 0;
  }
}
