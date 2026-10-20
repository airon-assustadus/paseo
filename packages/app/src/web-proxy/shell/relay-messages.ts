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

// Session binding (see shell-client-binding-plan.md). The worker learns the bootstrap's client
// id from the message source, never from a field; ids and tickets here are correlation only.

export type ShellRefusalReason =
  | "bad_source"
  | "duplicate_session"
  | "session_closed"
  | "session_limit"
  | "ticket_limit"
  | "protocol_error";

export const MAX_ADMITTED_CLIENTS = 64;
const MAX_CLIENT_ID_LENGTH = 128;
// 16 random bytes, base64url without padding.
const TICKET = /^[A-Za-z0-9_-]{22}$/;

export interface ShellSessionOpenMessage {
  type: "paseo.shell.session.open";
}

export interface ShellTicketPrepareMessage {
  type: "paseo.shell.ticket.prepare";
  ticket: string;
}

export interface ShellSessionCloseMessage {
  type: "paseo.shell.session.close";
}

export interface ShellResyncReplyMessage {
  type: "paseo.shell.resync.reply";
  admitted: string[];
}

export type ShellSessionPortMessage = ShellTicketPrepareMessage | ShellSessionCloseMessage;

export interface ShellSessionReadyMessage {
  type: "paseo.shell.session.ready";
}

export interface ShellTicketReadyMessage {
  type: "paseo.shell.ticket.ready";
  ticket: string;
}

export interface ShellRefusedMessage {
  type: "paseo.shell.refused";
  reason: ShellRefusalReason;
}

export interface ShellAdmittedMessage {
  type: "paseo.shell.admitted";
  clientIds: string[];
}

export interface ShellResyncMessage {
  type: "paseo.shell.resync";
}

export type ShellWorkerToBootstrapMessage =
  | ShellSessionReadyMessage
  | ShellTicketReadyMessage
  | ShellRefusedMessage
  | ShellAdmittedMessage;

const REFUSAL_REASONS: readonly ShellRefusalReason[] = [
  "bad_source",
  "duplicate_session",
  "session_closed",
  "session_limit",
  "ticket_limit",
  "protocol_error",
];

function hasKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => key in record);
}

export function isTicket(value: unknown): value is string {
  return typeof value === "string" && TICKET.test(value);
}

function isClientIdList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_ADMITTED_CLIENTS) return false;
  return value.every(
    (id) => typeof id === "string" && id.length > 0 && id.length <= MAX_CLIENT_ID_LENGTH,
  );
}

export function isSessionOpen(data: unknown): data is ShellSessionOpenMessage {
  return isRecord(data) && hasKeys(data, ["type"]) && data.type === "paseo.shell.session.open";
}

export function isResync(data: unknown): data is ShellResyncMessage {
  return isRecord(data) && hasKeys(data, ["type"]) && data.type === "paseo.shell.resync";
}

export function parseSessionPortMessage(data: unknown): ShellSessionPortMessage | null {
  if (!isRecord(data)) return null;
  if (data.type === "paseo.shell.session.close" && hasKeys(data, ["type"])) {
    return { type: "paseo.shell.session.close" };
  }
  const isPrepare = data.type === "paseo.shell.ticket.prepare" && hasKeys(data, ["type", "ticket"]);
  if (isPrepare && isTicket(data.ticket)) {
    return { type: "paseo.shell.ticket.prepare", ticket: data.ticket };
  }
  return null;
}

export function parseResyncReply(data: unknown): ShellResyncReplyMessage | null {
  if (!isRecord(data) || !hasKeys(data, ["type", "admitted"])) return null;
  if (data.type !== "paseo.shell.resync.reply" || !isClientIdList(data.admitted)) return null;
  return { type: "paseo.shell.resync.reply", admitted: [...data.admitted] };
}

export function parseWorkerToBootstrapMessage(data: unknown): ShellWorkerToBootstrapMessage | null {
  if (!isRecord(data)) return null;
  if (data.type === "paseo.shell.session.ready" && hasKeys(data, ["type"])) {
    return { type: "paseo.shell.session.ready" };
  }
  const isTicketReady =
    data.type === "paseo.shell.ticket.ready" && hasKeys(data, ["type", "ticket"]);
  if (isTicketReady && isTicket(data.ticket)) {
    return { type: "paseo.shell.ticket.ready", ticket: data.ticket };
  }
  const isRefused = data.type === "paseo.shell.refused" && hasKeys(data, ["type", "reason"]);
  const reason = REFUSAL_REASONS.find((candidate) => candidate === data.reason);
  if (isRefused && reason !== undefined) return { type: "paseo.shell.refused", reason };
  const isAdmitted = data.type === "paseo.shell.admitted" && hasKeys(data, ["type", "clientIds"]);
  if (isAdmitted && isClientIdList(data.clientIds)) {
    return { type: "paseo.shell.admitted", clientIds: [...data.clientIds] };
  }
  return null;
}
