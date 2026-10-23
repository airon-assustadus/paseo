export interface ShellNavigationQuery {
  type: "paseo.shell.navigation.query";
  v: 1;
  nonce: string;
  assetVersion: string;
}

export interface ShellNavigationReady {
  type: "paseo.shell.navigation.ready";
  v: 1;
  nonce: string;
  assetVersion: string;
  supported: boolean;
}

export interface ShellNavigationTicket {
  type: "paseo.shell.navigation.ticket.prepare";
  v: 1;
  ticket: string;
  target: string;
}

function record(data: unknown): data is Record<string, unknown> {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}

function keys(data: Record<string, unknown>, expected: string[]): boolean {
  return (
    Reflect.ownKeys(data).length === expected.length &&
    expected.every((key) => Object.hasOwn(data, key))
  );
}

function token(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

export function parseShellNavigationQuery(data: unknown): ShellNavigationQuery | null {
  if (!record(data) || data.type !== "paseo.shell.navigation.query" || data.v !== 1) return null;
  if (
    !keys(data, ["type", "v", "nonce", "assetVersion"]) ||
    !token(data.nonce) ||
    !token(data.assetVersion)
  )
    return null;
  return {
    type: "paseo.shell.navigation.query",
    v: 1,
    nonce: data.nonce,
    assetVersion: data.assetVersion,
  };
}

export function parseShellNavigationReady(data: unknown): ShellNavigationReady | null {
  if (!record(data) || data.type !== "paseo.shell.navigation.ready" || data.v !== 1) return null;
  if (!keys(data, ["type", "v", "nonce", "assetVersion", "supported"])) return null;
  if (!token(data.nonce) || !token(data.assetVersion) || typeof data.supported !== "boolean")
    return null;
  return {
    type: "paseo.shell.navigation.ready",
    v: 1,
    nonce: data.nonce,
    assetVersion: data.assetVersion,
    supported: data.supported,
  };
}

export function parseShellNavigationTicket(data: unknown): ShellNavigationTicket | null {
  if (!record(data) || data.type !== "paseo.shell.navigation.ticket.prepare" || data.v !== 1)
    return null;
  if (!keys(data, ["type", "v", "ticket", "target"])) return null;
  if (typeof data.ticket !== "string" || !/^[A-Za-z0-9_-]{22}$/u.test(data.ticket)) return null;
  if (typeof data.target !== "string" || data.target.length > 8192) return null;
  if (
    !data.target.startsWith("/") ||
    data.target.startsWith("//") ||
    data.target.includes("\\") ||
    [...data.target].some(
      (character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f,
    )
  )
    return null;
  return {
    type: "paseo.shell.navigation.ticket.prepare",
    v: 1,
    ticket: data.ticket,
    target: data.target,
  };
}
