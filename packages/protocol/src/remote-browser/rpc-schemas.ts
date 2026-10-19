import { z } from "zod";

/**
 * Remote browser: a sandboxed Chromium running on the daemon host, streamed to the client as
 * JPEG frames and driven by a closed set of input and navigation operations. Every operation on
 * an attached browser names the attachment (`subscriptionId`) and its `generation`, so input
 * queued by a replaced attachment is rejected even when it arrives on the same socket.
 */

export const REMOTE_BROWSER_VIEWPORT_MIN = 200;
export const REMOTE_BROWSER_VIEWPORT_MAX = 4096;
export const REMOTE_BROWSER_MAX_URL_LENGTH = 8192;
export const REMOTE_BROWSER_MAX_INPUT_EVENTS = 64;
export const REMOTE_BROWSER_MAX_TEXT_LENGTH = 1024;
export const REMOTE_BROWSER_MAX_COMPOSITION_LENGTH = 256;
export const REMOTE_BROWSER_MAX_TOUCH_POINTS = 5;
export const REMOTE_BROWSER_MAX_WHEEL_DELTA = 10000;
/**
 * Frame ceilings. The daemon never announces limits above these, and clients refuse an attachment
 * whose announced limits exceed them or a frame that exceeds its announced limits.
 */
export const REMOTE_BROWSER_MAX_FRAMES_IN_FLIGHT = 2;
export const REMOTE_BROWSER_MAX_FRAME_BYTES = 1048576;
export const REMOTE_BROWSER_MAX_IMAGE_EDGE = 1920;
export const REMOTE_BROWSER_MAX_IMAGE_PIXELS = 4194304;
/** Page-controlled strings are truncated by the daemon to these lengths before they leave it. */
export const REMOTE_BROWSER_MAX_TITLE_LENGTH = 1024;
export const REMOTE_BROWSER_MAX_MESSAGE_LENGTH = 1024;
export const REMOTE_BROWSER_MAX_HINT_LENGTH = 32;
export const REMOTE_BROWSER_MAX_CODE_LENGTH = 64;
/** Upper bound of one serialized `browser.remote.state` message, measured on its UTF-8 JSON bytes. */
export const REMOTE_BROWSER_MAX_STATE_BYTES = 32768;

/** Named keys the daemon maps to virtual key codes; any other key must be one printable character. */
export const REMOTE_BROWSER_NAMED_KEYS = [
  "Backspace",
  "Delete",
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
] as const;
export type RemoteBrowserNamedKey = (typeof REMOTE_BROWSER_NAMED_KEYS)[number];

/**
 * Codes that can grow travel as strings so an older client still parses a newer daemon. These
 * lists are what this version emits; consumers treat any other value as the generic case.
 */
export const REMOTE_BROWSER_ERROR_CODES = [
  "permission_denied",
  "unsupported_capability",
  "browser_unavailable",
  "resource_limit",
  "not_found",
  "stale_attachment",
  "invalid_request",
  "internal_error",
] as const;
export type RemoteBrowserErrorCode = (typeof REMOTE_BROWSER_ERROR_CODES)[number];

export const REMOTE_BROWSER_LOAD_ERROR_CODES = [
  "policy_denied",
  "host_not_found",
  "connection_refused",
  "network_unreachable",
  "timeout",
  "tls_error",
  "aborted",
  "crashed",
  "failed",
] as const;
export type RemoteBrowserLoadErrorCode = (typeof REMOTE_BROWSER_LOAD_ERROR_CODES)[number];

export const REMOTE_BROWSER_NOTICE_KINDS = [
  "download_blocked",
  "file_chooser_blocked",
  "dialog_dismissed",
  "popup_opened_in_place",
  "permission_denied",
] as const;
export type RemoteBrowserNoticeKind = (typeof REMOTE_BROWSER_NOTICE_KINDS)[number];

export const REMOTE_BROWSER_DETACH_REASONS = [
  "superseded",
  "revoked",
  "resource_limit",
  "protocol_error",
] as const;
export type RemoteBrowserDetachReason = (typeof REMOTE_BROWSER_DETACH_REASONS)[number];

export const REMOTE_BROWSER_CLOSE_REASONS = [
  "closed",
  "revoked",
  "crashed",
  "detached_timeout",
  "resource_limit",
  "memory_limit",
  "internal_error",
] as const;
export type RemoteBrowserCloseReason = (typeof REMOTE_BROWSER_CLOSE_REASONS)[number];

const RequestIdSchema = z.string().min(1);
const BrowserIdSchema = z.uuid();
const SubscriptionIdSchema = z.uuid();
const GenerationSchema = z.number().int().min(1).max(0xffffffff);
const CoordinateSchema = z.number().finite().min(0).max(REMOTE_BROWSER_VIEWPORT_MAX);
const ModifiersSchema = z.number().int().min(0).max(15);

const CodeSchema = z.string().max(REMOTE_BROWSER_MAX_CODE_LENGTH);
const UrlSchema = z.string().max(REMOTE_BROWSER_MAX_URL_LENGTH);
const HintSchema = z.string().max(REMOTE_BROWSER_MAX_HINT_LENGTH);

export const RemoteBrowserRpcErrorSchema = z.object({
  code: CodeSchema,
  message: z.string().max(REMOTE_BROWSER_MAX_MESSAGE_LENGTH),
});

export const RemoteBrowserViewportSchema = z.object({
  width: z.number().int().min(REMOTE_BROWSER_VIEWPORT_MIN).max(REMOTE_BROWSER_VIEWPORT_MAX),
  height: z.number().int().min(REMOTE_BROWSER_VIEWPORT_MIN).max(REMOTE_BROWSER_VIEWPORT_MAX),
  deviceScaleFactor: z.number().finite().min(1).max(4),
  mobile: z.boolean(),
  touch: z.boolean(),
});

export const RemoteBrowserFrameOptionsSchema = z.object({
  quality: z.number().int().min(30).max(90).optional(),
  maxPixelRatio: z.number().finite().min(1).max(3).optional(),
});

export const RemoteBrowserLimitsSchema = z.object({
  maxFramesInFlight: z.number().int().positive(),
  maxFrameBytes: z.number().int().positive(),
  maxImageEdge: z.number().int().positive(),
  maxImagePixels: z.number().int().positive(),
  maxInputEventsPerRequest: z.number().int().positive(),
  maxInputRequestsPerSecond: z.number().int().positive(),
  detachedTimeoutMs: z.number().int().positive(),
  frameAckTimeoutMs: z.number().int().positive(),
});

export const RemoteBrowserLoadErrorSchema = z.object({
  code: CodeSchema,
  url: UrlSchema,
  message: z.string().max(REMOTE_BROWSER_MAX_MESSAGE_LENGTH),
});

export const RemoteBrowserFocusedEditableSchema = z.object({
  inputMode: HintSchema,
  inputType: HintSchema,
  enterKeyHint: HintSchema,
});

export const RemoteBrowserNoticeSchema = z.object({
  kind: CodeSchema,
  at: z.number().int().nonnegative(),
});

export const RemoteBrowserStateSchema = z.object({
  url: UrlSchema,
  title: z.string().max(REMOTE_BROWSER_MAX_TITLE_LENGTH),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  loading: z.boolean(),
  error: RemoteBrowserLoadErrorSchema.nullable(),
  focusedEditable: RemoteBrowserFocusedEditableSchema.nullable(),
  viewport: RemoteBrowserViewportSchema,
  visible: z.boolean(),
  notice: RemoteBrowserNoticeSchema.nullable(),
});

export const RemoteBrowserNavigationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: z.string().min(1).max(REMOTE_BROWSER_MAX_URL_LENGTH) }),
  z.object({ kind: z.literal("back") }),
  z.object({ kind: z.literal("forward") }),
  z.object({ kind: z.literal("reload") }),
  z.object({ kind: z.literal("stop") }),
]);

const TouchPointSchema = z.object({
  id: z.number().int().min(0).max(9),
  x: CoordinateSchema,
  y: CoordinateSchema,
});

export const RemoteBrowserInputEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("touch"),
    phase: z.enum(["start", "move", "end", "cancel"]),
    points: z.array(TouchPointSchema).max(REMOTE_BROWSER_MAX_TOUCH_POINTS),
  }),
  z.object({
    kind: z.literal("mouse"),
    phase: z.enum(["move", "down", "up"]),
    x: CoordinateSchema,
    y: CoordinateSchema,
    button: z.enum(["none", "left", "middle", "right"]),
    clickCount: z.number().int().min(0).max(3),
    modifiers: ModifiersSchema,
  }),
  z.object({
    kind: z.literal("wheel"),
    x: CoordinateSchema,
    y: CoordinateSchema,
    deltaX: z
      .number()
      .finite()
      .min(-REMOTE_BROWSER_MAX_WHEEL_DELTA)
      .max(REMOTE_BROWSER_MAX_WHEEL_DELTA),
    deltaY: z
      .number()
      .finite()
      .min(-REMOTE_BROWSER_MAX_WHEEL_DELTA)
      .max(REMOTE_BROWSER_MAX_WHEEL_DELTA),
    modifiers: ModifiersSchema,
  }),
  z.object({
    kind: z.literal("key"),
    phase: z.enum(["down", "up", "press"]),
    // A named key from REMOTE_BROWSER_NAMED_KEYS or one printable character; checked by the daemon.
    key: z.string().min(1).max(16),
    modifiers: ModifiersSchema,
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string().min(1).max(REMOTE_BROWSER_MAX_TEXT_LENGTH),
  }),
  z.object({
    kind: z.literal("composition"),
    text: z.string().max(REMOTE_BROWSER_MAX_COMPOSITION_LENGTH),
    selectionStart: z.number().int().min(0).max(REMOTE_BROWSER_MAX_COMPOSITION_LENGTH),
    selectionEnd: z.number().int().min(0).max(REMOTE_BROWSER_MAX_COMPOSITION_LENGTH),
  }),
]);

const AttachmentFields = {
  requestId: RequestIdSchema,
  browserId: BrowserIdSchema,
  subscriptionId: SubscriptionIdSchema,
  generation: GenerationSchema,
};

const FailurePayloadSchema = z.object({
  requestId: RequestIdSchema,
  ok: z.literal(false),
  error: RemoteBrowserRpcErrorSchema,
});

const AttachedPayloadSchema = z.object({
  requestId: RequestIdSchema,
  ok: z.literal(true),
  browserId: BrowserIdSchema,
  subscriptionId: SubscriptionIdSchema,
  generation: GenerationSchema,
  limits: RemoteBrowserLimitsSchema,
  state: RemoteBrowserStateSchema,
});

export const RemoteBrowserOpenRequestSchema = z.object({
  type: z.literal("browser.remote.open.request"),
  requestId: RequestIdSchema,
  viewport: RemoteBrowserViewportSchema,
  url: z.string().min(1).max(REMOTE_BROWSER_MAX_URL_LENGTH).optional(),
  frames: RemoteBrowserFrameOptionsSchema.optional(),
});

// zod-aot 0.20.4 stringifies boolean discriminators, so ok/failure payloads use a sequential
// union like network.tunnel.* (protocol-validation.md).
export const RemoteBrowserOpenResponseSchema = z.object({
  type: z.literal("browser.remote.open.response"),
  payload: z.union([AttachedPayloadSchema, FailurePayloadSchema]),
});

export const RemoteBrowserAttachRequestSchema = z.object({
  type: z.literal("browser.remote.attach.request"),
  requestId: RequestIdSchema,
  browserId: BrowserIdSchema,
  viewport: RemoteBrowserViewportSchema.optional(),
  frames: RemoteBrowserFrameOptionsSchema.optional(),
});

export const RemoteBrowserAttachResponseSchema = z.object({
  type: z.literal("browser.remote.attach.response"),
  payload: z.union([AttachedPayloadSchema, FailurePayloadSchema]),
});

export const RemoteBrowserDetachRequestSchema = z.object({
  type: z.literal("browser.remote.detach.request"),
  ...AttachmentFields,
});

export const RemoteBrowserDetachResponseSchema = z.object({
  type: z.literal("browser.remote.detach.response"),
  payload: z.union([
    z.object({ requestId: RequestIdSchema, ok: z.literal(true), browserId: BrowserIdSchema }),
    FailurePayloadSchema,
  ]),
});

/**
 * Session-level close: works attached or detached. Pane cleanup passes `expectedGeneration` so it
 * cannot close a browser that a newer attachment took over.
 */
export const RemoteBrowserCloseRequestSchema = z.object({
  type: z.literal("browser.remote.close.request"),
  requestId: RequestIdSchema,
  browserId: BrowserIdSchema,
  expectedGeneration: GenerationSchema.optional(),
});

export const RemoteBrowserCloseResponseSchema = z.object({
  type: z.literal("browser.remote.close.response"),
  payload: z.union([
    z.object({ requestId: RequestIdSchema, ok: z.literal(true), browserId: BrowserIdSchema }),
    FailurePayloadSchema,
  ]),
});

export const RemoteBrowserSummarySchema = z.object({
  browserId: BrowserIdSchema,
  url: UrlSchema,
  title: z.string().max(REMOTE_BROWSER_MAX_TITLE_LENGTH),
  attached: z.boolean(),
  generation: GenerationSchema,
  createdAt: z.number().int().nonnegative(),
});

export const RemoteBrowserListRequestSchema = z.object({
  type: z.literal("browser.remote.list.request"),
  requestId: RequestIdSchema,
});

export const RemoteBrowserListResponseSchema = z.object({
  type: z.literal("browser.remote.list.response"),
  payload: z.union([
    z.object({
      requestId: RequestIdSchema,
      ok: z.literal(true),
      browsers: z.array(RemoteBrowserSummarySchema),
    }),
    FailurePayloadSchema,
  ]),
});

export const RemoteBrowserNavigateRequestSchema = z.object({
  type: z.literal("browser.remote.navigate.request"),
  ...AttachmentFields,
  navigation: RemoteBrowserNavigationSchema,
});

export const RemoteBrowserNavigateResponseSchema = z.object({
  type: z.literal("browser.remote.navigate.response"),
  payload: z.union([
    z.object({ requestId: RequestIdSchema, ok: z.literal(true) }),
    FailurePayloadSchema,
  ]),
});

export const RemoteBrowserDispatchInputRequestSchema = z.object({
  type: z.literal("browser.remote.dispatch_input.request"),
  ...AttachmentFields,
  events: z.array(RemoteBrowserInputEventSchema).min(1).max(REMOTE_BROWSER_MAX_INPUT_EVENTS),
});

export const RemoteBrowserDispatchInputResponseSchema = z.object({
  type: z.literal("browser.remote.dispatch_input.response"),
  payload: z.union([
    z.object({
      requestId: RequestIdSchema,
      ok: z.literal(true),
      dispatched: z.number().int().nonnegative(),
    }),
    FailurePayloadSchema,
  ]),
});

export const RemoteBrowserResizeRequestSchema = z.object({
  type: z.literal("browser.remote.resize.request"),
  ...AttachmentFields,
  viewport: RemoteBrowserViewportSchema,
});

export const RemoteBrowserResizeResponseSchema = z.object({
  type: z.literal("browser.remote.resize.response"),
  payload: z.union([
    z.object({
      requestId: RequestIdSchema,
      ok: z.literal(true),
      viewport: RemoteBrowserViewportSchema,
    }),
    FailurePayloadSchema,
  ]),
});

export const RemoteBrowserSetVisibilityRequestSchema = z.object({
  type: z.literal("browser.remote.set_visibility.request"),
  ...AttachmentFields,
  visible: z.boolean(),
});

export const RemoteBrowserSetVisibilityResponseSchema = z.object({
  type: z.literal("browser.remote.set_visibility.response"),
  payload: z.union([
    z.object({ requestId: RequestIdSchema, ok: z.literal(true), visible: z.boolean() }),
    FailurePayloadSchema,
  ]),
});

/** Subscription event: full state snapshot after each change; the newest one wins. */
export const RemoteBrowserStateMessageSchema = z.object({
  type: z.literal("browser.remote.state"),
  payload: z.object({
    subscriptionId: SubscriptionIdSchema,
    browserId: BrowserIdSchema,
    generation: GenerationSchema,
    state: RemoteBrowserStateSchema,
  }),
});

/** Subscription event: this attachment ended; the browser may keep running (re-attach by browserId). */
export const RemoteBrowserDetachedMessageSchema = z.object({
  type: z.literal("browser.remote.detached"),
  payload: z.object({
    subscriptionId: SubscriptionIdSchema,
    browserId: BrowserIdSchema,
    generation: GenerationSchema,
    reason: CodeSchema,
  }),
});

/** Subscription event: the browser is gone. Terminal; no frames follow. */
export const RemoteBrowserClosedMessageSchema = z.object({
  type: z.literal("browser.remote.closed"),
  payload: z.object({
    subscriptionId: SubscriptionIdSchema,
    browserId: BrowserIdSchema,
    reason: CodeSchema,
  }),
});

export type RemoteBrowserRpcError = z.infer<typeof RemoteBrowserRpcErrorSchema>;
export type RemoteBrowserViewport = z.infer<typeof RemoteBrowserViewportSchema>;
export type RemoteBrowserFrameOptions = z.infer<typeof RemoteBrowserFrameOptionsSchema>;
export type RemoteBrowserLimits = z.infer<typeof RemoteBrowserLimitsSchema>;
export type RemoteBrowserLoadError = z.infer<typeof RemoteBrowserLoadErrorSchema>;
export type RemoteBrowserFocusedEditable = z.infer<typeof RemoteBrowserFocusedEditableSchema>;
export type RemoteBrowserNotice = z.infer<typeof RemoteBrowserNoticeSchema>;
export type RemoteBrowserState = z.infer<typeof RemoteBrowserStateSchema>;
export type RemoteBrowserNavigation = z.infer<typeof RemoteBrowserNavigationSchema>;
export type RemoteBrowserInputEvent = z.infer<typeof RemoteBrowserInputEventSchema>;
export type RemoteBrowserSummary = z.infer<typeof RemoteBrowserSummarySchema>;
export type RemoteBrowserOpenRequest = z.infer<typeof RemoteBrowserOpenRequestSchema>;
export type RemoteBrowserOpenResponse = z.infer<typeof RemoteBrowserOpenResponseSchema>;
export type RemoteBrowserAttachRequest = z.infer<typeof RemoteBrowserAttachRequestSchema>;
export type RemoteBrowserAttachResponse = z.infer<typeof RemoteBrowserAttachResponseSchema>;
export type RemoteBrowserDetachRequest = z.infer<typeof RemoteBrowserDetachRequestSchema>;
export type RemoteBrowserCloseRequest = z.infer<typeof RemoteBrowserCloseRequestSchema>;
export type RemoteBrowserListRequest = z.infer<typeof RemoteBrowserListRequestSchema>;
export type RemoteBrowserNavigateRequest = z.infer<typeof RemoteBrowserNavigateRequestSchema>;
export type RemoteBrowserDispatchInputRequest = z.infer<
  typeof RemoteBrowserDispatchInputRequestSchema
>;
export type RemoteBrowserResizeRequest = z.infer<typeof RemoteBrowserResizeRequestSchema>;
export type RemoteBrowserSetVisibilityRequest = z.infer<
  typeof RemoteBrowserSetVisibilityRequestSchema
>;
export type RemoteBrowserStateMessage = z.infer<typeof RemoteBrowserStateMessageSchema>;
export type RemoteBrowserDetachedMessage = z.infer<typeof RemoteBrowserDetachedMessageSchema>;
export type RemoteBrowserClosedMessage = z.infer<typeof RemoteBrowserClosedMessageSchema>;
