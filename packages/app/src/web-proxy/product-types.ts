export type WebProxyProductPhase =
  | "unavailable"
  | "opening"
  | "active"
  | "suspended"
  | "closed"
  | "cleanup_pending"
  | "cleanup_partial"
  | "blocked";

export type WebProxyProductErrorCode =
  | "disabled"
  | "permission_denied"
  | "unsupported_capability"
  | "invalid_configuration"
  | "invalid_url"
  | "scope_not_allowlisted"
  | "allowlist_not_found"
  | "revision_conflict"
  | "epoch_conflict"
  | "cleanup_pending"
  | "identity_unavailable"
  | "limit_exceeded"
  | "durability_unavailable"
  | "persistence_unavailable"
  | "channel_lost"
  | "expired"
  | "protocol_error"
  | "navigation_unavailable"
  | "resume_failed";

export interface WebProxyProductError {
  code: WebProxyProductErrorCode;
}

export interface WebProxyProductCleanup {
  status: "unknown" | "not_requested" | "pending_local" | "pending_host" | "partial";
  requiredEpoch: string | null;
}

export interface WebProxyProductSnapshot {
  phase: WebProxyProductPhase;
  url: string | null;
  title: string | null;
  canNavigate: boolean;
  canReload: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  canResume: boolean;
  canRequestClear: boolean;
  error: WebProxyProductError | null;
  cleanup: WebProxyProductCleanup;
}

export interface WebProxyProductViewIdentity {
  serverId: string;
  workspaceId: string;
  browserId: string;
}

export interface WebProxyProductController {
  subscribe(listener: () => void): () => void;
  getSnapshot(): WebProxyProductSnapshot;
  open(url: string): Promise<void>;
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  stop(): void;
  resume(): Promise<void>;
  closeView(): void;
  requestClear(): Promise<void>;
}
