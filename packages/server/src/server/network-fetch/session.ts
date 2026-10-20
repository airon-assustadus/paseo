import {
  TUNNEL_CONNECT_TIMEOUT_MS,
  TUNNEL_INITIAL_WINDOW_BYTES,
  TUNNEL_MAX_DATA_BYTES,
  TUNNEL_MAX_STREAMS,
} from "@getpaseo/protocol/network-tunnel/rpc-schemas";
import type { TunnelDial, TunnelLookup } from "../network-tunnel/dial-target.js";
import {
  AllowlistEntryError,
  coversTarget,
  parseTrustedTarget,
  type AllowlistStore,
  type TrustedAllowlist,
  type TrustedTarget,
  type TrustedTargetInput,
} from "./allowlist.js";
import {
  NetworkFetchError,
  NetworkFetchOpenError,
  NetworkFetchProtocolError,
  type NetworkFetchErrorCode,
} from "./errors.js";
import {
  FetchExchange,
  validateRequest,
  type ExchangeEnvironment,
  type ExchangeEvents,
  type ExchangeRelease,
  type NetworkFetchLimits,
  type NetworkFetchRequest,
  type NetworkFetchResponseHead,
} from "./exchange.js";
import { hostInterfaceAddresses } from "./local-target.js";

/**
 * Provisional ceilings for the experiment. Transport-shaped limits reuse the network tunnel's
 * contract, head sizes follow the remote browser's egress proxy, the body ceiling is the smallest
 * power of two above the 50 MB validation case, and the redirect cap is the Fetch Standard's.
 */
export const DEFAULT_NETWORK_FETCH_LIMITS: NetworkFetchLimits = {
  initialWindowBytes: TUNNEL_INITIAL_WINDOW_BYTES,
  maxChunkBytes: TUNNEL_MAX_DATA_BYTES,
  maxConcurrentRequests: TUNNEL_MAX_STREAMS,
  connectTimeoutMs: TUNNEL_CONNECT_TIMEOUT_MS,
  maxRequestHeadBytes: 64 * 1024,
  maxResponseHeadBytes: 64 * 1024,
  responseHeadTimeoutMs: 30_000,
  maxRequestBodyBytes: 64 * 1024 * 1024,
  maxResponseBodyBytes: 64 * 1024 * 1024,
  maxRedirects: 20,
};

export type NetworkFetchClosedReason = "closed" | "revoked" | "expired" | "allowlist_changed";

/** See `ExchangeRelease`: `dnsPending` is the only residual a cancelled request can leave behind. */
export type RequestRelease = ExchangeRelease;

export interface NetworkFetchFailure {
  code: NetworkFetchErrorCode;
  message: string;
}

/** One-to-one with the response frames proposed for the protocol; nothing follows `closed`. */
export interface NetworkFetchSink {
  head(requestId: number, head: NetworkFetchResponseHead): void;
  body(requestId: number, chunk: Uint8Array): void;
  end(requestId: number): void;
  fail(requestId: number, failure: NetworkFetchFailure): void;
  uploadCredit(requestId: number, bytes: number): void;
  closed(reason: NetworkFetchClosedReason): void;
}

export interface AllowlistRef {
  id: string;
  revision: number;
}

export interface OpenNetworkFetchSessionOptions {
  allowlists: AllowlistStore;
  allowlistRef: AllowlistRef;
  /**
   * The page's capability: one destination origin and path, set by the trusted control. It must
   * equal or narrow an entry of the allowlist; every hop and redirect stays inside it.
   */
  scope: TrustedTargetInput;
  /** Whole milliseconds, 1 to 2^31 - 1 (the timer ceiling). */
  ttlMs: number;
  /** Each field can only lower the daemon's ceiling; out-of-domain values reject the open. */
  limits?: Partial<NetworkFetchLimits>;
  /**
   * The session's `network.proxy` authority. Polled before every operation, hop, dial, and
   * published event; the wiring still calls `revoke()` when it drops the permission.
   */
  isAuthorized(): boolean;
  /** Ports of the daemon's own listeners; dialing them on this host is refused. */
  protectedLocalPorts(): ReadonlySet<number>;
  localAddresses?: () => readonly string[];
  lookup?: TunnelLookup;
  dial?: TunnelDial;
  tlsCa?: readonly string[] | null;
  sink: NetworkFetchSink;
}

export function openNetworkFetchSession(
  options: OpenNetworkFetchSessionOptions,
): NetworkFetchSession {
  if (!options.isAuthorized()) {
    throw new NetworkFetchOpenError("permission_denied", "Session lacks network authority");
  }
  const allowlist = options.allowlists.get(options.allowlistRef.id);
  if (!allowlist) {
    throw new NetworkFetchOpenError("allowlist_not_found", "Allowlist does not exist");
  }
  if (allowlist.revision !== options.allowlistRef.revision) {
    throw new NetworkFetchOpenError("revision_conflict", "Allowlist revision changed");
  }
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1 || options.ttlMs > MAX_TIMER_MS) {
    throw new NetworkFetchOpenError("invalid_configuration", "Session TTL is out of range");
  }
  const limits = agreeOnLimits(options.limits);
  const scope = parseScope(options.scope);
  if (!coversTarget(allowlist, scope)) {
    throw new NetworkFetchOpenError("scope_not_allowlisted", "Scope is outside the allowlist");
  }
  return new NetworkFetchSession({ options, allowlist, scope, limits });
}

/** setTimeout fires immediately for delays above this. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** A zero body or redirect limit is a meaningful policy; a zero window or timeout never progresses. */
const LIMIT_MINIMUMS: Record<keyof NetworkFetchLimits, number> = {
  initialWindowBytes: 1,
  maxChunkBytes: 1,
  maxConcurrentRequests: 1,
  connectTimeoutMs: 1,
  maxRequestHeadBytes: 1,
  maxResponseHeadBytes: 1,
  responseHeadTimeoutMs: 1,
  maxRequestBodyBytes: 0,
  maxResponseBodyBytes: 0,
  maxRedirects: 0,
};

function parseScope(input: TrustedTargetInput): TrustedTarget {
  try {
    return parseTrustedTarget(input);
  } catch (error) {
    if (!(error instanceof AllowlistEntryError)) throw error;
    throw new NetworkFetchOpenError("invalid_configuration", "Scope is not an exact target");
  }
}

function agreeOnLimits(requested: Partial<NetworkFetchLimits> = {}): NetworkFetchLimits {
  function lower(key: keyof NetworkFetchLimits): number {
    const ceiling = DEFAULT_NETWORK_FETCH_LIMITS[key];
    const value = requested[key];
    if (value === undefined) return ceiling;
    if (!Number.isSafeInteger(value) || value < LIMIT_MINIMUMS[key]) {
      throw new NetworkFetchOpenError("invalid_configuration", `Limit ${key} is out of range`);
    }
    return Math.min(ceiling, value);
  }
  const limits: NetworkFetchLimits = {
    initialWindowBytes: lower("initialWindowBytes"),
    maxChunkBytes: lower("maxChunkBytes"),
    maxConcurrentRequests: lower("maxConcurrentRequests"),
    connectTimeoutMs: lower("connectTimeoutMs"),
    maxRequestHeadBytes: lower("maxRequestHeadBytes"),
    maxResponseHeadBytes: lower("maxResponseHeadBytes"),
    responseHeadTimeoutMs: lower("responseHeadTimeoutMs"),
    maxRequestBodyBytes: lower("maxRequestBodyBytes"),
    maxResponseBodyBytes: lower("maxResponseBodyBytes"),
    maxRedirects: lower("maxRedirects"),
  };
  // Every chunk must fit the window, or an upload chunk could never be accepted.
  if (limits.maxChunkBytes > limits.initialWindowBytes) {
    throw new NetworkFetchOpenError("invalid_configuration", "Chunk limit exceeds the window");
  }
  return limits;
}

interface SessionInit {
  options: OpenNetworkFetchSessionOptions;
  allowlist: TrustedAllowlist;
  scope: TrustedTarget;
  limits: NetworkFetchLimits;
}

/**
 * One generation of web-proxy access for one client. Closing it, for any reason, announces
 * `closed` first and then cancels every request; nothing from this generation is emitted after.
 */
export class NetworkFetchSession {
  readonly limits: NetworkFetchLimits;
  private readonly options: OpenNetworkFetchSessionOptions;
  private readonly allowlist: TrustedAllowlist;
  private state: "open" | "closed" = "open";
  private lastRequestId = 0;
  private readonly exchanges = new Map<number, FetchExchange>();
  /** Release promises not yet resolved; entries remove themselves, so this never grows unbounded. */
  private readonly releases = new Set<Promise<ExchangeRelease>>();
  private readonly expiresAt: number;
  private readonly expiry: ReturnType<typeof setTimeout>;
  private readonly environment: ExchangeEnvironment;

  constructor({ options, allowlist, scope, limits }: SessionInit) {
    this.options = options;
    this.allowlist = allowlist;
    this.limits = limits;
    this.expiresAt = Date.now() + options.ttlMs;
    this.expiry = setTimeout(() => this.shutdown("expired"), options.ttlMs);
    this.environment = {
      scope,
      assertCurrent: () => this.assertOpen(),
      protectedLocalPorts: options.protectedLocalPorts,
      localAddresses: options.localAddresses ?? hostInterfaceAddresses,
      lookup: options.lookup,
      dial: options.dial,
      tlsCa: options.tlsCa ?? null,
      limits: this.limits,
    };
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  get activeRequests(): number {
    return this.exchanges.size;
  }

  /** Requests of this generation whose sockets have not all closed yet. */
  get pendingReleases(): number {
    return this.releases.size;
  }

  request(request: NetworkFetchRequest): void {
    this.assertOpen();
    const { requestId } = request;
    if (!Number.isSafeInteger(requestId) || requestId <= this.lastRequestId) {
      throw new NetworkFetchProtocolError("replayed", "Request id was already used");
    }
    this.lastRequestId = requestId;
    try {
      if (this.exchanges.size >= this.limits.maxConcurrentRequests) {
        throw new NetworkFetchError("stream_limit", "Too many concurrent requests");
      }
      const url = validateRequest(request, this.limits);
      const exchange: FetchExchange = new FetchExchange(
        request,
        url,
        this.environment,
        this.eventsFor(requestId, () => exchange),
      );
      this.exchanges.set(requestId, exchange);
      this.trackRelease(exchange);
      exchange.start();
    } catch (error) {
      if (!(error instanceof NetworkFetchError)) throw error;
      this.options.sink.fail(requestId, { code: error.code, message: error.message });
    }
  }

  writeBody(requestId: number, chunk: Uint8Array): void {
    this.exchangeFor(requestId)?.writeBody(chunk);
  }

  endBody(requestId: number): void {
    this.exchangeFor(requestId)?.endBody();
  }

  grantCredit(requestId: number, bytes: number): void {
    this.exchangeFor(requestId)?.grantCredit(bytes);
  }

  /**
   * Stops a request. Validation still throws synchronously; `null` is a late id. The promise resolves
   * once the request's work stopped and every socket it held emitted `close`.
   */
  cancel(requestId: number): Promise<RequestRelease> | null {
    const exchange = this.exchangeFor(requestId);
    if (!exchange) return null;
    this.exchanges.delete(requestId);
    return exchange.cancel();
  }

  /** Resolves when every request of this generation released its sockets; idempotent snapshot. */
  released(): Promise<void> {
    return Promise.all(this.releases).then(() => undefined);
  }

  private trackRelease(exchange: FetchExchange): void {
    const { released } = exchange;
    this.releases.add(released);
    void released.then(() => {
      this.releases.delete(released);
      return undefined;
    });
  }

  close(): void {
    this.shutdown("closed");
  }

  /** Call before the authority goes away: the notice leaves first, then every request stops. */
  revoke(reason: Exclude<NetworkFetchClosedReason, "closed"> = "revoked"): void {
    this.shutdown(reason);
  }

  /**
   * `null` for an id at or below the watermark that is no longer active: a late frame for a
   * finished, cancelled, or never-opened lower id is dropped, not punished. The session keeps no
   * record of which ids were opened; the watermark only rejects late effects.
   */
  private exchangeFor(requestId: number): FetchExchange | null {
    this.assertOpen();
    const exchange = this.exchanges.get(requestId);
    if (exchange) return exchange;
    if (Number.isSafeInteger(requestId) && requestId > 0 && requestId <= this.lastRequestId) {
      return null;
    }
    throw new NetworkFetchProtocolError("unknown_request", "Request id was never opened");
  }

  private assertOpen(): void {
    if (!this.isCurrent()) {
      throw new NetworkFetchProtocolError("session_closed", "Network fetch session is closed");
    }
  }

  /** Closes the session the first time it finds the authority, TTL, or revision lapsed. */
  private isCurrent(): boolean {
    if (this.state === "closed") return false;
    const lapse = this.lapse();
    if (lapse) this.shutdown(lapse);
    return lapse === null;
  }

  private lapse(): Exclude<NetworkFetchClosedReason, "closed"> | null {
    if (!this.options.isAuthorized()) return "revoked";
    if (Date.now() >= this.expiresAt) return "expired";
    const current = this.options.allowlists.get(this.allowlist.id);
    if (current?.revision !== this.allowlist.revision) return "allowlist_changed";
    return null;
  }

  private shutdown(reason: NetworkFetchClosedReason): void {
    if (this.state === "closed") return;
    this.state = "closed";
    clearTimeout(this.expiry);
    this.options.sink.closed(reason);
    const exchanges = [...this.exchanges.values()];
    this.exchanges.clear();
    for (const exchange of exchanges) exchange.cancel();
  }

  private eventsFor(requestId: number, exchange: () => FetchExchange): ExchangeEvents {
    const { sink } = this.options;
    // Results that resolve after a lapse are dropped even when no frame arrived in between.
    const isLive = () => this.isCurrent() && this.exchanges.get(requestId) === exchange();
    const settle = () => {
      const live = isLive();
      if (live) this.exchanges.delete(requestId);
      return live;
    };
    return {
      head: (head: NetworkFetchResponseHead) => {
        if (isLive()) sink.head(requestId, head);
      },
      body: (chunk: Uint8Array) => {
        if (isLive()) sink.body(requestId, chunk);
      },
      uploadCredit: (bytes: number) => {
        if (isLive()) sink.uploadCredit(requestId, bytes);
      },
      end: () => {
        if (settle()) sink.end(requestId);
      },
      fail: (error: NetworkFetchError) => {
        if (settle()) sink.fail(requestId, { code: error.code, message: error.message });
      },
    };
  }
}
