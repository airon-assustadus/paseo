import { z } from "zod";
import { CLIENT_CAPS } from "../client-capabilities.js";

export const NETWORK_FETCH_CAPABILITY = CLIENT_CAPS.networkFetch;
export const NETWORK_FETCH_MAX_METADATA_BYTES = 65536;
export const NETWORK_FETCH_MAX_CHUNK_BYTES = 65536;
export const NETWORK_FETCH_MAX_FETCH_ID = 0xffffffff;

export const NetworkFetchEpochSchema = z.string().regex(/^(0|[1-9][0-9]*)(?![\s\S])/);
export const NetworkFetchDestinationIdSchema = z
  .string()
  .length(52)
  .regex(/^[a-z2-7]{52}$/);
export const NetworkFetchConfigurationSchema = z.object({
  dedicatedContentDomain: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?![\s\S])/),
  assetVersion: z.string().min(1).max(256),
  bootstrapPath: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^\/(?!\/)[^\\?#\s]*(?![\s\S])/),
  pathPrefix: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^\/(?!\/)[^\\?#\s]*(?![\s\S])/),
  ttlMs: z.number().int().min(1).max(2147483647),
  handshakeTimeoutMs: z.number().int().min(1).max(2147483647),
});
export const NetworkFetchSubscriptionIdSchema = z.string().min(1).max(255);
export const NetworkFetchScopeSchema = z.strictObject({
  origin: z.string().min(1).max(8192),
  pathPrefix: z.string().min(1).max(8192),
});
export const NetworkFetchDescriptorSchema = z.object({
  destinationId: NetworkFetchDestinationIdSchema,
  origin: z.string().min(1).max(8192),
  pathPrefix: z.string().min(1).max(8192),
  allowlistRevision: z.number().int().nonnegative(),
  authorityEpoch: NetworkFetchEpochSchema,
  cleanupRequiredEpoch: NetworkFetchEpochSchema.nullable(),
  contentOrigin: z.string().min(1).max(8192),
  assetVersion: z.string().min(1).max(256),
});
export const NetworkFetchRpcErrorSchema = z.object({
  code: z.enum([
    "permission_denied",
    "unsupported_capability",
    "invalid_configuration",
    "scope_not_allowlisted",
    "allowlist_not_found",
    "revision_conflict",
    "epoch_conflict",
    "cleanup_pending",
    "identity_unavailable",
    "limit_exceeded",
    "durability_unavailable",
  ]),
  message: z.string().max(1024),
});
export const NetworkFetchLimitsSchema = z.object({
  initialWindowBytes: z.number().int().min(1).max(262144),
  maxChunkBytes: z.number().int().min(1).max(NETWORK_FETCH_MAX_CHUNK_BYTES),
  maxConcurrentRequests: z.number().int().min(1).max(64),
  connectTimeoutMs: z.number().int().min(1).max(10000),
  maxRequestHeadBytes: z.number().int().min(1).max(NETWORK_FETCH_MAX_METADATA_BYTES),
  maxResponseHeadBytes: z.number().int().min(1).max(NETWORK_FETCH_MAX_METADATA_BYTES),
  responseHeadTimeoutMs: z.number().int().min(1).max(30000),
  maxRequestBodyBytes: z.number().int().min(0).max(67108864),
  maxResponseBodyBytes: z.number().int().min(0).max(67108864),
  maxRedirects: z.number().int().min(0).max(20),
});
export const NETWORK_FETCH_LIMITS: NetworkFetchLimits = {
  initialWindowBytes: 262144,
  maxChunkBytes: 65536,
  maxConcurrentRequests: 64,
  connectTimeoutMs: 10000,
  maxRequestHeadBytes: 65536,
  maxResponseHeadBytes: 65536,
  responseHeadTimeoutMs: 30000,
  maxRequestBodyBytes: 67108864,
  maxResponseBodyBytes: 67108864,
  maxRedirects: 20,
};
const RequestIdSchema = z.string().min(1);
const FailureSchema = z.object({
  requestId: RequestIdSchema,
  ok: z.literal(false),
  error: NetworkFetchRpcErrorSchema,
});
export const NetworkFetchResolveDestinationRequestSchema = z.strictObject({
  type: z.literal("network.fetch.resolve_destination.request"),
  requestId: RequestIdSchema,
  origin: z.string().min(1).max(8192),
  pathPrefix: z.string().min(1).max(8192),
});
export const NetworkFetchResolveDestinationResponseSchema = z.object({
  type: z.literal("network.fetch.resolve_destination.response"),
  payload: z.union([
    z.object({
      requestId: RequestIdSchema,
      ok: z.literal(true),
      descriptor: NetworkFetchDescriptorSchema,
    }),
    FailureSchema,
  ]),
});
export const NetworkFetchReconcileDestinationRequestSchema = z.strictObject({
  type: z.literal("network.fetch.reconcile_destination.request"),
  requestId: RequestIdSchema,
  destinationId: NetworkFetchDestinationIdSchema,
  knownEpoch: NetworkFetchEpochSchema,
});
export const NetworkFetchReconciliationSchema = z.object({
  descriptor: NetworkFetchDescriptorSchema,
  state: z.enum(["active", "revoked", "removed"]),
  cleanupRequiredEpoch: NetworkFetchEpochSchema.nullable(),
});
export const NetworkFetchReconcileDestinationResponseSchema = z.object({
  type: z.literal("network.fetch.reconcile_destination.response"),
  payload: z.union([
    NetworkFetchReconciliationSchema.extend({ requestId: RequestIdSchema, ok: z.literal(true) }),
    FailureSchema,
  ]),
});
export const NetworkFetchOpenRequestSchema = z.strictObject({
  type: z.literal("network.fetch.open.request"),
  requestId: RequestIdSchema,
  destinationId: NetworkFetchDestinationIdSchema,
  expectedAuthorityEpoch: NetworkFetchEpochSchema,
  allowlistRevision: z.number().int().nonnegative(),
  scope: NetworkFetchScopeSchema,
  ttlMs: z.number().int().min(1).max(2147483647),
  limits: NetworkFetchLimitsSchema.partial().optional(),
});
export const NetworkFetchOpenedSchema = z.object({
  subscriptionId: NetworkFetchSubscriptionIdSchema,
  descriptor: NetworkFetchDescriptorSchema,
  limits: NetworkFetchLimitsSchema,
});
export const NetworkFetchOpenResponseSchema = z.object({
  type: z.literal("network.fetch.open.response"),
  payload: z.union([
    NetworkFetchOpenedSchema.extend({ requestId: RequestIdSchema, ok: z.literal(true) }),
    FailureSchema,
  ]),
});
export const NetworkFetchCloseRequestSchema = z.strictObject({
  type: z.literal("network.fetch.close.request"),
  requestId: RequestIdSchema,
  subscriptionId: NetworkFetchSubscriptionIdSchema,
});
export const NetworkFetchCloseResponseSchema = z.object({
  type: z.literal("network.fetch.close.response"),
  payload: z.union([
    z.object({
      requestId: RequestIdSchema,
      ok: z.literal(true),
      subscriptionId: NetworkFetchSubscriptionIdSchema,
    }),
    FailureSchema,
  ]),
});
export const NetworkFetchRequestCleanupRequestSchema = z.strictObject({
  type: z.literal("network.fetch.request_cleanup.request"),
  requestId: RequestIdSchema,
  destinationId: NetworkFetchDestinationIdSchema,
  expectedAuthorityEpoch: NetworkFetchEpochSchema,
});
export const NetworkFetchCleanupPendingSchema = z.strictObject({
  destinationId: NetworkFetchDestinationIdSchema,
  authorityEpoch: NetworkFetchEpochSchema,
  cleanupRequiredEpoch: NetworkFetchEpochSchema,
  status: z.literal("cleanup_pending"),
});
export const NetworkFetchRequestCleanupResponseSchema = z.object({
  type: z.literal("network.fetch.request_cleanup.response"),
  payload: z.union([
    NetworkFetchCleanupPendingSchema.extend({ requestId: RequestIdSchema, ok: z.literal(true) }),
    FailureSchema,
  ]),
});
export const NetworkFetchClosedReasonSchema = z.enum([
  "closed",
  "revoked",
  "expired",
  "allowlist_changed",
]);
/** Persistent owned observation after open's response, not a finite RPC stream. */
export const NetworkFetchClosedMessageSchema = z.object({
  type: z.literal("network.fetch.closed.update"),
  payload: z.object({
    subscriptionId: NetworkFetchSubscriptionIdSchema,
    reason: NetworkFetchClosedReasonSchema,
  }),
});

export type NetworkFetchDescriptor = z.infer<typeof NetworkFetchDescriptorSchema>;
export type NetworkFetchConfiguration = z.infer<typeof NetworkFetchConfigurationSchema>;
export type NetworkFetchScope = z.infer<typeof NetworkFetchScopeSchema>;
export type NetworkFetchLimits = z.infer<typeof NetworkFetchLimitsSchema>;
export type NetworkFetchRpcFailure = z.infer<typeof NetworkFetchRpcErrorSchema>;
export type NetworkFetchReconciliation = z.infer<typeof NetworkFetchReconciliationSchema>;
export type NetworkFetchOpened = z.infer<typeof NetworkFetchOpenedSchema>;
export type NetworkFetchCleanupPending = z.infer<typeof NetworkFetchCleanupPendingSchema>;
export type NetworkFetchClosedReason = z.infer<typeof NetworkFetchClosedReasonSchema>;
export type NetworkFetchResolveDestinationRequest = z.infer<
  typeof NetworkFetchResolveDestinationRequestSchema
>;
export type NetworkFetchResolveDestinationResponse = z.infer<
  typeof NetworkFetchResolveDestinationResponseSchema
>;
export type NetworkFetchReconcileDestinationRequest = z.infer<
  typeof NetworkFetchReconcileDestinationRequestSchema
>;
export type NetworkFetchReconcileDestinationResponse = z.infer<
  typeof NetworkFetchReconcileDestinationResponseSchema
>;
export type NetworkFetchOpenRequest = z.infer<typeof NetworkFetchOpenRequestSchema>;
export type NetworkFetchOpenResponse = z.infer<typeof NetworkFetchOpenResponseSchema>;
export type NetworkFetchCloseRequest = z.infer<typeof NetworkFetchCloseRequestSchema>;
export type NetworkFetchCloseResponse = z.infer<typeof NetworkFetchCloseResponseSchema>;
export type NetworkFetchRequestCleanupRequest = z.infer<
  typeof NetworkFetchRequestCleanupRequestSchema
>;
export type NetworkFetchRequestCleanupResponse = z.infer<
  typeof NetworkFetchRequestCleanupResponseSchema
>;
export type NetworkFetchClosedMessage = z.infer<typeof NetworkFetchClosedMessageSchema>;
