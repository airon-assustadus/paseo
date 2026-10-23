export const NAVIGATION_VERSION = 1;
export const NAVIGATION_EXTENSION = "navigation.v1";

export const NAVIGATION_LIMITS = {
  maxIdBytes: 128,
  maxUrlBytes: 8192,
  maxTitleBytes: 1024,
  maxRequestId: 2 ** 31 - 1,
} as const;

export type NavigationOperation = "navigate" | "reload" | "back" | "forward";

export type NavigationCommand =
  | { kind: "navigate"; url: string }
  | { kind: "reload" }
  | { kind: "back" }
  | { kind: "forward" };

export type NavigationFailureReason =
  | "unsupported"
  | "out_of_scope"
  | "busy"
  | "timeout"
  | "channel_lost"
  | "superseded"
  | "unsafe_replay"
  | "protocol_error";

export type NavigationCommit =
  | { kind: "network"; requestId: number }
  | { kind: "same_document" }
  | { kind: "bfcache" };

export type NavigationOutcome =
  | {
      status: "committed";
      operationId: number;
      documentId: string;
      entryKey: string;
      commit: NavigationCommit;
    }
  | { status: "failed"; operationId: number; reason: NavigationFailureReason };

export interface NavigationState {
  commit: NavigationCommit;
  documentId: string;
  entryKey: string;
  url: string;
  title: string;
  canReload: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface NavigationEnvelope {
  v: typeof NAVIGATION_VERSION;
  generation: number;
  shellInstance: string;
  sequence: number;
}

export interface NavigationReadyMessage extends NavigationEnvelope {
  type: "paseo.web.navigation.ready";
  extension: typeof NAVIGATION_EXTENSION;
  assetVersion: string;
  operations: NavigationOperation[];
}

export interface NavigationCommandMessage extends NavigationEnvelope {
  type: "paseo.web.navigation.command";
  operationId: number;
  command: NavigationCommand;
}

export interface NavigationQueryMessage extends NavigationEnvelope {
  type: "paseo.web.navigation.query";
  assetVersion: string;
}

export interface NavigationResultMessage extends NavigationEnvelope {
  type: "paseo.web.navigation.result";
  outcome: NavigationOutcome;
}

export interface NavigationStateMessage extends NavigationEnvelope {
  type: "paseo.web.navigation.state";
  state: NavigationState;
}

export type NavigationToShellMessage = NavigationCommandMessage | NavigationQueryMessage;
export type NavigationToBrokerMessage =
  | NavigationReadyMessage
  | NavigationResultMessage
  | NavigationStateMessage;

const ENVELOPE_KEYS = ["type", "v", "generation", "shellInstance", "sequence"];
const OPERATIONS: readonly NavigationOperation[] = ["navigate", "reload", "back", "forward"];
const FAILURE_REASONS: readonly NavigationFailureReason[] = [
  "unsupported",
  "out_of_scope",
  "busy",
  "timeout",
  "channel_lost",
  "superseded",
  "unsafe_replay",
  "protocol_error",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Reflect.ownKeys(record).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  );
}

function isPositiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function isOneOf<Value extends string>(value: unknown, values: readonly Value[]): value is Value {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function scalarBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function isBoundedText(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || value.length > maximum) return false;
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return false;
    bytes += scalarBytes(codePoint);
    if (bytes > maximum) return false;
  }
  return true;
}

function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isIdentifier(value: unknown): value is string {
  return (
    isBoundedText(value, NAVIGATION_LIMITS.maxIdBytes) &&
    value.length > 0 &&
    !hasUnsafeCharacter(value)
  );
}

function isNavigationUrl(value: unknown): value is string {
  if (!isBoundedText(value, NAVIGATION_LIMITS.maxUrlBytes)) return false;
  if (!/^https?:\/\//u.test(value) || hasUnsafeCharacter(value) || value.includes("\\"))
    return false;
  try {
    const url = new URL(value);
    return url.hostname.length > 0 && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function parseEnvelope(data: Record<string, unknown>): NavigationEnvelope | null {
  if (data.v !== NAVIGATION_VERSION || !isPositiveInteger(data.generation)) return null;
  if (!isIdentifier(data.shellInstance) || !isPositiveInteger(data.sequence)) return null;
  return {
    v: NAVIGATION_VERSION,
    generation: data.generation,
    shellInstance: data.shellInstance,
    sequence: data.sequence,
  };
}

function parseCommand(data: unknown): NavigationCommand | null {
  if (!isRecord(data)) return null;
  if (data.kind === "navigate") {
    if (!hasExactKeys(data, ["kind", "url"]) || !isNavigationUrl(data.url)) return null;
    return { kind: "navigate", url: data.url };
  }
  if (!hasExactKeys(data, ["kind"])) return null;
  if (data.kind === "reload" || data.kind === "back" || data.kind === "forward") {
    return { kind: data.kind };
  }
  return null;
}

function parseCommit(data: unknown): NavigationCommit | null {
  if (!isRecord(data)) return null;
  if (data.kind === "network") {
    if (!hasExactKeys(data, ["kind", "requestId"])) return null;
    if (!isPositiveInteger(data.requestId, NAVIGATION_LIMITS.maxRequestId)) return null;
    return { kind: "network", requestId: data.requestId };
  }
  if (!hasExactKeys(data, ["kind"])) return null;
  if (data.kind === "same_document" || data.kind === "bfcache") return { kind: data.kind };
  return null;
}

function parseOutcome(data: unknown): NavigationOutcome | null {
  if (!isRecord(data) || !isPositiveInteger(data.operationId)) return null;
  if (data.status === "failed") {
    if (!hasExactKeys(data, ["status", "operationId", "reason"])) return null;
    if (!isOneOf(data.reason, FAILURE_REASONS)) return null;
    return { status: "failed", operationId: data.operationId, reason: data.reason };
  }
  if (data.status !== "committed") return null;
  if (!hasExactKeys(data, ["status", "operationId", "documentId", "entryKey", "commit"]))
    return null;
  if (!isIdentifier(data.documentId) || !isIdentifier(data.entryKey)) return null;
  const commit = parseCommit(data.commit);
  if (commit === null) return null;
  return {
    status: "committed",
    operationId: data.operationId,
    documentId: data.documentId,
    entryKey: data.entryKey,
    commit,
  };
}

function parseState(data: unknown): NavigationState | null {
  if (!isRecord(data)) return null;
  const keys = [
    "commit",
    "documentId",
    "entryKey",
    "url",
    "title",
    "canReload",
    "canGoBack",
    "canGoForward",
  ];
  if (!hasExactKeys(data, keys)) return null;
  if (!isIdentifier(data.documentId) || !isIdentifier(data.entryKey)) return null;
  if (!isNavigationUrl(data.url) || !isBoundedText(data.title, NAVIGATION_LIMITS.maxTitleBytes))
    return null;
  if (typeof data.canReload !== "boolean") return null;
  if (typeof data.canGoBack !== "boolean" || typeof data.canGoForward !== "boolean") return null;
  const commit = parseCommit(data.commit);
  if (commit === null) return null;
  return {
    commit,
    documentId: data.documentId,
    entryKey: data.entryKey,
    url: data.url,
    title: data.title,
    canReload: data.canReload,
    canGoBack: data.canGoBack,
    canGoForward: data.canGoForward,
  };
}

function parseReady(
  data: Record<string, unknown>,
  envelope: NavigationEnvelope,
): NavigationReadyMessage | null {
  if (!hasExactKeys(data, [...ENVELOPE_KEYS, "extension", "assetVersion", "operations"]))
    return null;
  if (data.extension !== NAVIGATION_EXTENSION || !isIdentifier(data.assetVersion)) return null;
  if (!Array.isArray(data.operations) || data.operations.length > OPERATIONS.length) return null;
  const operations: NavigationOperation[] = [];
  for (const operation of data.operations) {
    if (!isOneOf(operation, OPERATIONS) || operations.includes(operation)) return null;
    operations.push(operation);
  }
  return {
    type: "paseo.web.navigation.ready",
    ...envelope,
    extension: NAVIGATION_EXTENSION,
    assetVersion: data.assetVersion,
    operations,
  };
}

export function parseNavigationToShell(data: unknown): NavigationToShellMessage | null {
  if (!isRecord(data)) return null;
  const envelope = parseEnvelope(data);
  if (envelope === null) return null;
  if (data.type === "paseo.web.navigation.query") {
    if (!hasExactKeys(data, [...ENVELOPE_KEYS, "assetVersion"]) || !isIdentifier(data.assetVersion))
      return null;
    return { type: "paseo.web.navigation.query", ...envelope, assetVersion: data.assetVersion };
  }
  if (data.type !== "paseo.web.navigation.command") return null;
  if (!hasExactKeys(data, [...ENVELOPE_KEYS, "operationId", "command"])) return null;
  if (!isPositiveInteger(data.operationId)) return null;
  const command = parseCommand(data.command);
  if (command === null) return null;
  return {
    type: "paseo.web.navigation.command",
    ...envelope,
    operationId: data.operationId,
    command,
  };
}

export function parseNavigationToBroker(data: unknown): NavigationToBrokerMessage | null {
  if (!isRecord(data)) return null;
  const envelope = parseEnvelope(data);
  if (envelope === null) return null;
  switch (data.type) {
    case "paseo.web.navigation.ready":
      return parseReady(data, envelope);
    case "paseo.web.navigation.result": {
      if (!hasExactKeys(data, [...ENVELOPE_KEYS, "outcome"])) return null;
      const outcome = parseOutcome(data.outcome);
      return outcome === null
        ? null
        : { type: "paseo.web.navigation.result", ...envelope, outcome };
    }
    case "paseo.web.navigation.state": {
      if (!hasExactKeys(data, [...ENVELOPE_KEYS, "state"])) return null;
      const state = parseState(data.state);
      return state === null ? null : { type: "paseo.web.navigation.state", ...envelope, state };
    }
    default:
      return null;
  }
}
