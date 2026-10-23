import type { NetworkFetchErrorCode } from "@getpaseo/protocol/binary-frames/network-fetch";
export type { NetworkFetchErrorCode } from "@getpaseo/protocol/binary-frames/network-fetch";

/** A failure of one request. The message never carries the URL query, headers, or body. */
export class NetworkFetchError extends Error {
  constructor(
    readonly code: NetworkFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NetworkFetchError";
  }
}

export type NetworkFetchProtocolViolation =
  | "replayed"
  | "unknown_request"
  | "session_closed"
  | "body_not_expected"
  | "credit_overflow";

/** The caller broke the session contract; the request it named is not affected. */
export class NetworkFetchProtocolError extends Error {
  constructor(
    readonly violation: NetworkFetchProtocolViolation,
    message: string,
  ) {
    super(message);
    this.name = "NetworkFetchProtocolError";
  }
}

export type NetworkFetchOpenFailure =
  | "permission_denied"
  | "allowlist_not_found"
  | "revision_conflict"
  | "invalid_configuration"
  | "scope_not_allowlisted";

export class NetworkFetchOpenError extends Error {
  constructor(
    readonly code: NetworkFetchOpenFailure,
    message: string,
  ) {
    super(message);
    this.name = "NetworkFetchOpenError";
  }
}
