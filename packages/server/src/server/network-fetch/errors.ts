export type NetworkFetchErrorCode =
  | "invalid_request"
  | "not_allowlisted"
  | "credentials_unsupported"
  | "request_head_too_large"
  | "request_body_too_large"
  | "stream_limit"
  | "policy_denied"
  | "self_target_denied"
  | "host_not_found"
  | "connection_refused"
  | "network_unreachable"
  | "timeout"
  | "tls_certificate_invalid"
  | "tls_hostname_mismatch"
  | "tls_error"
  | "redirect_not_allowlisted"
  | "redirect_limit"
  | "redirect_body_unreplayable"
  | "redirect_error_mode"
  | "response_head_too_large"
  | "response_body_too_large"
  | "unsupported_encoding"
  | "credit_exceeded"
  | "upstream_error";

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
  | "revision_conflict";

export class NetworkFetchOpenError extends Error {
  constructor(
    readonly code: NetworkFetchOpenFailure,
    message: string,
  ) {
    super(message);
    this.name = "NetworkFetchOpenError";
  }
}
