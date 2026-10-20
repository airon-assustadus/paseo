import type { RemoteBrowserEnd } from "@getpaseo/client";
import {
  REMOTE_BROWSER_LOAD_ERROR_CODES,
  REMOTE_BROWSER_NOTICE_KINDS,
} from "@getpaseo/protocol/remote-browser/rpc-schemas";

const REASON_KEYS = [
  "permission_denied",
  "resource_limit",
  "memory_limit",
  "browser_unavailable",
  "disconnected",
  "superseded",
  "revoked",
  "detached_timeout",
  "crashed",
  "presentation",
] as const;

type ReasonKey = (typeof REASON_KEYS)[number] | "generic";

const REASONS = new Set<string>(REASON_KEYS);
const LOAD_ERRORS = new Set<string>(REMOTE_BROWSER_LOAD_ERROR_CODES);
const NOTICES = new Set<string>(REMOTE_BROWSER_NOTICE_KINDS);

function isReasonKey(code: string): code is (typeof REASON_KEYS)[number] {
  return REASONS.has(code);
}

/** The translation key for a daemon error or close reason. Unknown codes get the generic line. */
export function remoteBrowserReasonKey(
  code: string,
): `workspace.browser.remote.reason.${ReasonKey}` {
  const key: ReasonKey = isReasonKey(code) ? code : "generic";
  return `workspace.browser.remote.reason.${key}`;
}

/** `unsupported_*` codes mean the host runs an older daemon; the pane shows the update notice. */
export function isHostUpdateRequired(code: string): boolean {
  return code === "unsupported_feature" || code === "unsupported_capability";
}

export function remoteBrowserEndKey(end: RemoteBrowserEnd): string {
  return remoteBrowserReasonKey(end.kind === "disconnected" ? "disconnected" : end.reason);
}

export function remoteBrowserLoadErrorKey(code: string): string {
  const key = LOAD_ERRORS.has(code) ? code : "failed";
  return `workspace.browser.remote.loadError.${key}`;
}

export function remoteBrowserNoticeKey(kind: string): string | null {
  return NOTICES.has(kind) ? `workspace.browser.remote.notice.${kind}` : null;
}
