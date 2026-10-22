import { randomUUID } from "node:crypto";

export type BridgeTraceKind =
  | "request"
  | "body"
  | "endBody"
  | "cancel"
  | "grantCredit"
  | "head"
  | "end"
  | "fail"
  | "uploadCredit"
  | "cancelled"
  | "closed"
  | "protocol_error"
  | "connection"
  | "transport_close"
  | "terminate"
  | "shutdown";

interface BridgeTraceEvent {
  sequence: number;
  at: number;
  connection: number;
  phase: "in" | "attempt" | "accepted" | "threw" | "lifecycle";
  kind: BridgeTraceKind;
  requestId: number | null;
  bytes: number | null;
}

export interface BridgeTraceSnapshot {
  enabled: boolean;
  instance: string;
  clock: "host_monotonic_ms";
  dropped: number;
  saturated: boolean;
  events: BridgeTraceEvent[];
}

/** Node-side only. No frame objects, payloads, URLs or free-form reasons enter the recorder. */
export function createBridgeTrace(enabled: boolean, now = () => performance.now()) {
  const instance = randomUUID();
  const events: BridgeTraceEvent[] = [];
  let sequence = 0;
  let dropped = 0;
  let saturated = false;
  return {
    record(event: Omit<BridgeTraceEvent, "sequence" | "at">): void {
      if (!enabled || saturated) return;
      if (sequence === Number.MAX_SAFE_INTEGER) {
        saturated = true;
        return;
      }
      sequence += 1;
      if (events.length === 512) {
        events.shift();
        dropped += 1;
      }
      events.push({
        sequence,
        at: Math.max(0, Math.floor(now())),
        connection: event.connection,
        phase: event.phase,
        kind: event.kind,
        requestId: event.requestId,
        bytes: event.bytes,
      });
    },
    snapshot(): BridgeTraceSnapshot {
      return {
        enabled,
        instance,
        clock: "host_monotonic_ms",
        dropped,
        saturated,
        // The operator may retain or mutate a snapshot; recorder entries remain private.
        // eslint-disable-next-line no-map-spread
        events: events.map((event) => ({ ...event })),
      };
    },
  };
}

export type BridgeTrace = ReturnType<typeof createBridgeTrace>;
