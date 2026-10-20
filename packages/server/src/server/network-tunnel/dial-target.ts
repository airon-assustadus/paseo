import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { TunnelCloseReason } from "@getpaseo/protocol/binary-frames/index";
import {
  TunnelTargetError,
  approveAddresses,
  closeReasonForError,
  loopbackForLocalhostName,
  normalizeAddress,
  type ResolvedTunnelAddress,
  type TunnelHost,
} from "./target-policy.js";

/**
 * The host-side egress path shared by network tunnels and the remote browser's proxy: resolve the
 * name on this host, approve every answer with the target policy, then dial the approved literal.
 * No second resolution happens, so a name cannot rebind between the check and the connection.
 */

// dns.lookup shares libuv's worker pool with filesystem work. Keep two default-pool
// workers available to the rest of the daemon, across every caller of this module.
const MAX_CONCURRENT_LOOKUPS = 2;
let activeLookups = 0;
const lookupWaiters = new Set<() => void>();

export type TunnelLookup = (hostname: string) => Promise<ResolvedTunnelAddress[]>;

export interface TunnelDialInput {
  address: ResolvedTunnelAddress;
  port: number;
  deadline: number;
  signal: AbortSignal;
}

export type TunnelDial = (input: TunnelDialInput) => Promise<net.Socket>;

export interface DialTargetInput {
  host: TunnelHost;
  port: number;
  deadline: number;
  signal: AbortSignal;
  lookup?: TunnelLookup;
  dial?: TunnelDial;
  /** Extra denial on top of the target policy, checked against every approved address. */
  isDenied?: (address: ResolvedTunnelAddress, port: number) => boolean;
}

export async function defaultLookup(hostname: string): Promise<ResolvedTunnelAddress[]> {
  const results = await dnsLookup(hostname, { all: true });
  return results.map((entry) => normalizeAddress(entry.address));
}

/** Resolves (when needed), approves every candidate, and dials an approved address. */
export async function dialTarget(input: DialTargetInput): Promise<net.Socket> {
  const lookup = input.lookup ?? defaultLookup;
  const candidates =
    input.host.kind === "literal"
      ? [input.host.address]
      : (loopbackForLocalhostName(input.host.hostname) ??
        (await lookupWithDeadline(lookup, input.host.hostname, input.deadline, input.signal)));
  const approved = approveAddresses(candidates);
  if (input.isDenied && approved.some((address) => input.isDenied?.(address, input.port))) {
    throw new TunnelTargetError(TunnelCloseReason.PolicyDenied, "Target address is denied");
  }
  return dialAny({
    addresses: approved,
    port: input.port,
    deadline: input.deadline,
    signal: input.signal,
    dialAddress: input.dial ?? dial,
  });
}

function acquireLookupSlot(deadline: number, signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new TunnelTargetError(TunnelCloseReason.Ok, "Stream cancelled"));
      return;
    }
    if (Date.now() >= deadline) {
      reject(new TunnelTargetError(TunnelCloseReason.Timeout, "Timed out resolving host"));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      lookupWaiters.delete(grant);
    };
    const grant = () => {
      cleanup();
      activeLookups += 1;
      resolve(() => {
        activeLookups -= 1;
        lookupWaiters.values().next().value?.();
      });
    };
    const onAbort = () => {
      cleanup();
      reject(new TunnelTargetError(TunnelCloseReason.Ok, "Stream cancelled"));
    };
    const timer = setTimeout(
      () => {
        cleanup();
        reject(new TunnelTargetError(TunnelCloseReason.Timeout, "Timed out resolving host"));
      },
      Math.max(0, deadline - Date.now()),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (activeLookups < MAX_CONCURRENT_LOOKUPS) grant();
    else lookupWaiters.add(grant);
  });
}

async function lookupWithDeadline(
  lookup: TunnelLookup,
  hostname: string,
  deadline: number,
  signal: AbortSignal,
): Promise<ResolvedTunnelAddress[]> {
  const release = await acquireLookupSlot(deadline, signal);
  // Only the actual resolver completion releases the worker slot. Expiration or
  // cancellation of the stream stops waiting but cannot cancel system DNS work.
  const pending = (async () => {
    try {
      if (signal.aborted) throw new TunnelTargetError(TunnelCloseReason.Ok, "Stream cancelled");
      if (Date.now() >= deadline) {
        throw new TunnelTargetError(TunnelCloseReason.Timeout, "Timed out resolving host");
      }
      return await lookup(hostname);
    } finally {
      release();
    }
  })();
  return withDeadline(pending, deadline, signal);
}

async function withDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    // Observe the resolver even when cancellation won before the guard was installed.
    void promise.catch(() => {});
    throw new TunnelTargetError(TunnelCloseReason.Ok, "Stream cancelled");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new TunnelTargetError(TunnelCloseReason.Timeout, "Timed out resolving host")),
      Math.max(0, deadline - Date.now()),
    );
    onAbort = () => reject(new TunnelTargetError(TunnelCloseReason.Ok, "Stream cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

interface DialAnyInput extends Omit<TunnelDialInput, "address"> {
  addresses: readonly ResolvedTunnelAddress[];
  dialAddress: TunnelDial;
}

/** `localhost` often resolves to ::1 first while the service listens on 127.0.0.1; try every approved answer. */
async function dialAny({
  addresses,
  port,
  deadline,
  signal,
  dialAddress,
}: DialAnyInput): Promise<net.Socket> {
  let lastError: unknown;
  for (const [index, address] of addresses.entries()) {
    if (signal.aborted) throw new TunnelTargetError(TunnelCloseReason.Ok, "Stream cancelled");
    const now = Date.now();
    const remaining = deadline - now;
    if (remaining <= 0) {
      throw new TunnelTargetError(TunnelCloseReason.Timeout, "Connect timed out");
    }
    const attemptDeadline = now + Math.ceil(remaining / (addresses.length - index));
    try {
      return await dialAddress({ address, port, deadline: attemptDeadline, signal });
    } catch (error) {
      lastError = error;
      const reason = closeReasonForError(error);
      if (reason === TunnelCloseReason.Ok) break;
    }
  }
  throw lastError;
}

/** Dials the approved literal only; no second resolution can swap the target underneath the policy check. */
function dial({ address, port, deadline, signal }: TunnelDialInput): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const remaining = Math.max(1, deadline - Date.now());
    const socket = net.connect({ host: address.address, port, family: address.family });
    const settle = (outcome: { socket: net.Socket } | { error: unknown }) => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
      signal.removeEventListener("abort", onAbort);
      if ("socket" in outcome) {
        resolve(outcome.socket);
        return;
      }
      socket.destroy();
      reject(outcome.error);
    };
    const onConnect = () => settle({ socket });
    const onError = (error: Error) => settle({ error });
    const onTimeout = () =>
      settle({ error: new TunnelTargetError(TunnelCloseReason.Timeout, "Connect timed out") });
    const onAbort = () =>
      settle({ error: new TunnelTargetError(TunnelCloseReason.Ok, "Stream cancelled") });
    socket.setTimeout(remaining);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
