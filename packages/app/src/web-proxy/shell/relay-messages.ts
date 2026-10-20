// Messages between the shell's service worker and its bootstrap page. Both run on the content
// origin, so this channel is hygiene, not a boundary: the broker re-validates everything.
// Replies from the bootstrap to the worker are K3 control messages, forwarded as received.

import type { BridgeHeaders, BridgeMethod, BridgeRequestMode } from "../bridge-messages";

export interface ShellFetchRequest {
  method: BridgeMethod;
  path: string;
  headers: BridgeHeaders;
  body: ArrayBuffer | null;
  mode: BridgeRequestMode;
}

export interface ShellFetchMessage {
  type: "paseo.shell.fetch";
  request: ShellFetchRequest;
}

export interface ShellAckMessage {
  type: "paseo.shell.ack";
  bytes: number;
}

export interface ShellCancelMessage {
  type: "paseo.shell.cancel";
}

export type ShellRequestMessage = ShellAckMessage | ShellCancelMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Returns the raw request fields; the bootstrap completes them into a K3 request and runs the
// strict K3 parser over the result.
export function readShellFetchFields(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data) || data.type !== "paseo.shell.fetch") return null;
  if (Object.keys(data).length !== 2 || !isRecord(data.request)) return null;
  return data.request;
}

export function parseShellRequestMessage(data: unknown): ShellRequestMessage | null {
  if (!isRecord(data)) return null;
  if (data.type === "paseo.shell.cancel" && Object.keys(data).length === 1) {
    return { type: "paseo.shell.cancel" };
  }
  const isAck = data.type === "paseo.shell.ack" && Object.keys(data).length === 2;
  if (isAck && typeof data.bytes === "number" && Number.isSafeInteger(data.bytes)) {
    return { type: "paseo.shell.ack", bytes: data.bytes };
  }
  return null;
}
