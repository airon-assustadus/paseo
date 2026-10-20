import {
  TUNNEL_CONNECT_TIMEOUT_MS,
  TUNNEL_INITIAL_WINDOW_BYTES,
  TUNNEL_MAX_DATA_BYTES,
  TUNNEL_MAX_STREAMS,
} from "@getpaseo/protocol/network-tunnel/rpc-schemas";
import type { TunnelDial, TunnelLookup } from "../network-tunnel/dial-target.js";
import { isAllowedOrigin, type AllowlistStore, type TrustedAllowlist } from "./allowlist.js";
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
  ttlMs: number;
  /** Each field can only lower the daemon's ceiling. */
  limits?: Partial<NetworkFetchLimits>;
  /** The session's `network.proxy` authority, rechecked on every operation. */
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
  return new NetworkFetchSession(options, allowlist);
}

function agreeOnLimits(requested: Partial<NetworkFetchLimits> = {}): NetworkFetchLimits {
  function lower(key: keyof NetworkFetchLimits): number {
    const ceiling = DEFAULT_NETWORK_FETCH_LIMITS[key];
    return Math.min(ceiling, requested[key] ?? ceiling);
  }
  return {
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
}

/**
 * One generation of web-proxy access for one client. Closing it, for any reason, announces
 * `closed` first and then cancels every request; nothing from this generation is emitted after.
 */
export class NetworkFetchSession {
  readonly limits: NetworkFetchLimits;
  private state: "open" | "closed" = "open";
  private lastRequestId = 0;
  private readonly exchanges = new Map<number, FetchExchange>();
  private readonly expiresAt: number;
  private readonly expiry: ReturnType<typeof setTimeout>;
  private readonly environment: ExchangeEnvironment;

  constructor(
    private readonly options: OpenNetworkFetchSessionOptions,
    private readonly allowlist: TrustedAllowlist,
  ) {
    this.limits = agreeOnLimits(options.limits);
    this.expiresAt = Date.now() + options.ttlMs;
    this.expiry = setTimeout(() => this.shutdown("expired"), options.ttlMs);
    this.environment = {
      allowlist: () => {
        this.assertOpen();
        return this.allowlist;
      },
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
      const origin = request.initiatorOrigin;
      if (origin !== null && !isAllowedOrigin(this.allowlist, origin)) {
        throw new NetworkFetchError("not_allowlisted", "Initiator origin is not a target");
      }
      const url = validateRequest(request, this.limits);
      const exchange = new FetchExchange(
        request,
        url,
        this.environment,
        this.eventsFor(requestId, () => exchange),
      );
      this.exchanges.set(requestId, exchange);
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

  cancel(requestId: number): void {
    const exchange = this.exchangeFor(requestId);
    if (!exchange) return;
    this.exchanges.delete(requestId);
    exchange.cancel();
  }

  close(): void {
    this.shutdown("closed");
  }

  /** Call before the authority goes away: the notice leaves first, then every request stops. */
  revoke(reason: Exclude<NetworkFetchClosedReason, "closed"> = "revoked"): void {
    this.shutdown(reason);
  }

  /** `null` for a request that already finished: its late frames are dropped, not punished. */
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
    if (this.state === "open") {
      const current = this.options.allowlists.get(this.allowlist.id);
      if (!this.options.isAuthorized()) this.shutdown("revoked");
      else if (Date.now() >= this.expiresAt) this.shutdown("expired");
      else if (current?.revision !== this.allowlist.revision) this.shutdown("allowlist_changed");
    }
    if (this.state === "closed") {
      throw new NetworkFetchProtocolError("session_closed", "Network fetch session is closed");
    }
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
    const isLive = () => this.state === "open" && this.exchanges.get(requestId) === exchange();
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
