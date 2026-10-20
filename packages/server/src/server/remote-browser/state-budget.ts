import {
  REMOTE_BROWSER_MAX_CODE_LENGTH,
  REMOTE_BROWSER_MAX_HINT_LENGTH,
  REMOTE_BROWSER_MAX_MESSAGE_LENGTH,
  REMOTE_BROWSER_MAX_STATE_BYTES,
  REMOTE_BROWSER_MAX_TITLE_LENGTH,
  REMOTE_BROWSER_MAX_URL_LENGTH,
  type RemoteBrowserState,
  type RemoteBrowserStateMessage,
} from "@getpaseo/protocol/remote-browser/rpc-schemas";

type PageControlledFields = Pick<
  RemoteBrowserState,
  "url" | "title" | "error" | "focusedEditable" | "notice"
>;

/** Truncates to at most `max` UTF-16 units without leaving half of a surrogate pair. */
export function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** Applies the per-field schema bounds to page-controlled strings. */
export function boundState(state: RemoteBrowserState): RemoteBrowserState {
  return boundPageState(state);
}

/** Per-field bounds for any state shape that carries the page-controlled fields. */
export function boundPageState<T extends PageControlledFields>(state: T): T {
  return {
    ...state,
    url: truncateText(state.url, REMOTE_BROWSER_MAX_URL_LENGTH),
    title: truncateText(state.title, REMOTE_BROWSER_MAX_TITLE_LENGTH),
    error: state.error
      ? {
          code: truncateText(state.error.code, REMOTE_BROWSER_MAX_CODE_LENGTH),
          url: truncateText(state.error.url, REMOTE_BROWSER_MAX_URL_LENGTH),
          message: truncateText(state.error.message, REMOTE_BROWSER_MAX_MESSAGE_LENGTH),
        }
      : null,
    focusedEditable: state.focusedEditable
      ? {
          // Keeps focusId and composing; only the page-controlled strings are bounded.
          ...state.focusedEditable,
          inputMode: truncateText(state.focusedEditable.inputMode, REMOTE_BROWSER_MAX_HINT_LENGTH),
          inputType: truncateText(state.focusedEditable.inputType, REMOTE_BROWSER_MAX_HINT_LENGTH),
          enterKeyHint: truncateText(
            state.focusedEditable.enterKeyHint,
            REMOTE_BROWSER_MAX_HINT_LENGTH,
          ),
        }
      : null,
    notice: state.notice
      ? { ...state.notice, kind: truncateText(state.notice.kind, REMOTE_BROWSER_MAX_CODE_LENGTH) }
      : null,
  };
}

function serializedBytes(message: RemoteBrowserStateMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

type ShrinkableField = "title" | "errorMessage" | "errorUrl" | "url";

function fieldValue(state: RemoteBrowserState, field: ShrinkableField): string {
  switch (field) {
    case "title":
      return state.title;
    case "url":
      return state.url;
    case "errorMessage":
      return state.error?.message ?? "";
    case "errorUrl":
      return state.error?.url ?? "";
  }
}

function withField(
  state: RemoteBrowserState,
  field: ShrinkableField,
  value: string,
): RemoteBrowserState {
  switch (field) {
    case "title":
      return { ...state, title: value };
    case "url":
      return { ...state, url: value };
    case "errorMessage":
      return state.error ? { ...state, error: { ...state.error, message: value } } : state;
    case "errorUrl":
      return state.error ? { ...state, error: { ...state.error, url: value } } : state;
  }
}

const SHRINKABLE: readonly ShrinkableField[] = ["title", "errorMessage", "errorUrl", "url"];

/** The page-controlled field that costs the most serialized bytes, or null when all are empty. */
function largestField(state: RemoteBrowserState): ShrinkableField | null {
  let largest: ShrinkableField | null = null;
  let largestBytes = 0;
  for (const field of SHRINKABLE) {
    const value = fieldValue(state, field);
    if (value.length === 0) continue;
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (bytes > largestBytes) {
      largest = field;
      largestBytes = bytes;
    }
  }
  return largest;
}

/**
 * Builds the state message within the serialized byte budget. Character bounds alone do not
 * bound bytes: JSON escapes and UTF-8 expand control and astral characters up to 12 bytes each.
 */
export function buildStateMessage(input: {
  subscriptionId: string;
  browserId: string;
  generation: number;
  state: RemoteBrowserState;
  maxBytes?: number;
}): RemoteBrowserStateMessage {
  const maxBytes = input.maxBytes ?? REMOTE_BROWSER_MAX_STATE_BYTES;
  let state = boundState(input.state);
  const build = (current: RemoteBrowserState): RemoteBrowserStateMessage => ({
    type: "browser.remote.state",
    payload: {
      subscriptionId: input.subscriptionId,
      browserId: input.browserId,
      generation: input.generation,
      state: current,
    },
  });
  let message = build(state);
  // Halve the most expensive field until the message fits; every field keeps a share.
  while (serializedBytes(message) > maxBytes) {
    const field = largestField(state);
    if (!field) break;
    const value = fieldValue(state, field);
    state = withField(state, field, truncateText(value, Math.floor(value.length / 2)));
    message = build(state);
  }
  return message;
}

/** The state as it may leave the daemon in any message: field bounds plus the serialized budget. */
export function budgetedState(state: RemoteBrowserState): RemoteBrowserState {
  return buildStateMessage({
    subscriptionId: "00000000-0000-4000-8000-000000000000",
    browserId: "00000000-0000-4000-8000-000000000000",
    generation: 1,
    state,
  }).payload.state;
}
