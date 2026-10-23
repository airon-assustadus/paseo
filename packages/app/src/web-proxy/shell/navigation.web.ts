import {
  type NavigationCommandMessage,
  type NavigationCommit,
  type NavigationFailureReason,
  type NavigationOutcome,
  type NavigationState,
  type NavigationToBrokerMessage,
} from "../navigation-messages";
import type { ControlMessage, RequestMessage } from "../bridge-messages";

interface HistoryEntry {
  key: string;
  index: number;
  url: string | null;
}

interface FrameNavigation extends EventTarget {
  currentEntry: HistoryEntry | null;
  entries(): HistoryEntry[];
  navigate(url: string, options?: { info: unknown }): { finished: Promise<unknown> };
  reload(): { finished: Promise<unknown> };
  traverseTo(key: string): { finished: Promise<unknown> };
}

interface DocumentRecord {
  id: string;
  method: string;
  generation: number;
}

interface Attempt {
  kind: string | null;
  entryKey: string | null;
  operationId: number | null;
  initial: Document | null;
  expectedUrl: string;
  requestId: number | null;
  method: string;
  completed: boolean;
  redirectUrl: string | null;
  timer: ReturnType<typeof setTimeout>;
}

function frameNavigation(frame: HTMLIFrameElement): FrameNavigation | null {
  return (
    (frame.contentWindow as (Window & { navigation?: FrameNavigation }) | null)?.navigation ?? null
  );
}

function titleText(title: string): string {
  let result = "";
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const character of title) {
    const scalar = character.codePointAt(0) ?? 0;
    if (scalar >= 0xd800 && scalar <= 0xdfff) continue;
    bytes += encoder.encode(character).byteLength;
    if (bytes > 1024) break;
    result += character;
  }
  return result;
}

export function createShellNavigation(options: {
  frame: HTMLIFrameElement;
  origin: string;
  assetVersion: string;
  timeoutMs: number;
  enter(target: string): Promise<boolean>;
  send(message: NavigationToBrokerMessage): void;
}) {
  const { frame } = options;
  let active = false;
  let generation = 0;
  let shellInstance = "";
  let sequence = 0;
  let operationWatermark = 0;
  let attempt: Attempt | null = null;
  let issuing = false;
  let observed: Document | null = null;
  let observer: MutationObserver | null = null;
  let stateTimer: ReturnType<typeof setTimeout> | null = null;
  let latest: NavigationState | null = null;
  const documents = new WeakMap<Document, DocumentRecord>();
  const entries = new Map<string, DocumentRecord>();
  const listeners = new Map<Document, () => void>();

  function envelope() {
    return { v: 1 as const, generation, shellInstance, sequence: ++sequence };
  }

  function outcome(result: NavigationOutcome): void {
    if (active)
      options.send({ type: "paseo.web.navigation.result", ...envelope(), outcome: result });
  }

  function finish(reason: NavigationFailureReason): void {
    const current = attempt;
    if (current === null) return;
    clearTimeout(current.timer);
    attempt = null;
    if (current.operationId !== null)
      outcome({ status: "failed", operationId: current.operationId, reason });
  }

  function deactivate(): void {
    finish("channel_lost");
    active = false;
    observer?.disconnect();
    if (stateTimer !== null) clearTimeout(stateTimer);
    stateTimer = null;
    latest = null;
  }

  function activate(input: { generation: number; shellInstance: string }): void {
    deactivate();
    active = true;
    generation = input.generation;
    shellInstance = input.shellInstance;
    operationWatermark = 0;
    entries.clear();
    options.send({
      type: "paseo.web.navigation.ready",
      ...envelope(),
      extension: "navigation.v1",
      assetVersion: options.assetVersion,
      operations:
        frameNavigation(frame) === null
          ? ["navigate", "reload"]
          : ["navigate", "reload", "back", "forward"],
    });
  }

  function safe(entry: HistoryEntry | undefined): boolean {
    const record = entry === undefined ? undefined : entries.get(entry.key);
    return record !== undefined && record.generation === generation && record.method === "GET";
  }

  function currentState(commit: NavigationCommit): NavigationState | null {
    const doc = frame.contentDocument;
    const navigation = frameNavigation(frame);
    const entry = navigation?.currentEntry;
    if (doc === null || entry == null || doc.location.origin !== options.origin) return null;
    const record = documents.get(doc);
    if (record === undefined || record.generation !== generation) return null;
    const history = navigation?.entries() ?? [];
    return {
      commit,
      documentId: record.id,
      entryKey: entry.key,
      url: doc.location.href,
      title: titleText(doc.title),
      canReload: record.method === "GET",
      canGoBack: safe(history.find((item) => item.index === entry.index - 1)),
      canGoForward: safe(history.find((item) => item.index === entry.index + 1)),
    };
  }

  function publish(commit: NavigationCommit): void {
    if (!active) return;
    const state = currentState(commit);
    if (state === null) return;
    latest = state;
    options.send({ type: "paseo.web.navigation.state", ...envelope(), state });
  }

  function scheduleMetadata(): void {
    if (!active || stateTimer !== null) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      if (latest !== null) publish(latest.commit);
    }, 100);
  }

  function bindDocument(doc: Document): void {
    observer?.disconnect();
    observer = new MutationObserver(scheduleMetadata);
    observer.observe(doc, { childList: true, subtree: true, characterData: true });
    observed = doc;
    if (listeners.has(doc)) return;
    const win = frame.contentWindow;
    const navigation = frameNavigation(frame);
    const changed = () => onSameDocument(doc);
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) onRestored(doc);
    };
    const navigating = (event: Event) => {
      if (!active || frame.contentDocument !== doc || issuing) return;
      const typed = event as Event & { navigationType?: string; destination?: HistoryEntry };
      if (typed.navigationType === "traverse" && !safe(typed.destination)) {
        event.preventDefault();
        finish("unsafe_replay");
        return;
      }
      if (typed.navigationType === "traverse" && attempt?.entryKey === typed.destination?.key)
        return;
      finish("superseded");
    };
    navigation?.addEventListener("currententrychange", changed);
    navigation?.addEventListener("navigate", navigating);
    win?.addEventListener("pageshow", restored);
    listeners.set(doc, () => {
      navigation?.removeEventListener("currententrychange", changed);
      navigation?.removeEventListener("navigate", navigating);
      win?.removeEventListener("pageshow", restored);
    });
    if (listeners.size > 128) {
      const oldest = listeners.keys().next().value;
      if (oldest !== undefined) {
        listeners.get(oldest)?.();
        listeners.delete(oldest);
      }
    }
  }

  function committed(commit: NavigationCommit, doc: Document): void {
    bindDocument(doc);
    const record = documents.get(doc);
    const key = frameNavigation(frame)?.currentEntry?.key;
    if (record === undefined || key === undefined) {
      finish("unsupported");
      return;
    }
    entries.set(key, record);
    if (entries.size > 128) entries.delete(entries.keys().next().value!);
    publish(commit);
    const current = attempt;
    if (current === null) return;
    clearTimeout(current.timer);
    attempt = null;
    if (current.operationId !== null)
      outcome({
        status: "committed",
        operationId: current.operationId,
        documentId: record.id,
        entryKey: key,
        commit,
      });
  }

  function onSameDocument(doc: Document): void {
    if (!active || doc !== frame.contentDocument || observed !== doc) return;
    const record = documents.get(doc);
    if (record?.generation !== generation) return;
    const current = attempt;
    if (current?.kind === "reload" || current?.requestId != null) return;
    if (current?.entryKey != null && frameNavigation(frame)?.currentEntry?.key !== current.entryKey)
      return;
    if (current !== null && (current.initial !== doc || current.expectedUrl !== doc.location.href))
      return;
    committed({ kind: "same_document" }, doc);
  }

  function onRestored(doc: Document): void {
    if (!active || doc !== frame.contentDocument) return;
    const record = documents.get(doc);
    if (record?.generation !== generation || record.method !== "GET") {
      finish("unsafe_replay");
      return;
    }
    if (attempt !== null && attempt.requestId !== null) return;
    if (
      attempt !== null &&
      (attempt.expectedUrl !== doc.location.href ||
        attempt.entryKey !== frameNavigation(frame)?.currentEntry?.key)
    )
      return;
    committed({ kind: "bfcache" }, doc);
  }

  function onLoad(): void {
    if (!active) return;
    const current = attempt;
    const doc = frame.contentDocument;
    if (
      current === null ||
      doc === null ||
      doc === current.initial ||
      !current.completed ||
      current.requestId === null
    )
      return;
    const navigationUrl = frame.contentWindow?.performance.getEntriesByType("navigation")[0]?.name;
    if (
      navigationUrl?.split("#")[0] !== current.expectedUrl.split("#")[0] ||
      doc.readyState !== "complete"
    )
      return;
    if (doc.location.origin !== options.origin) {
      finish("out_of_scope");
      return;
    }
    documents.set(doc, { id: crypto.randomUUID(), generation, method: current.method });
    committed({ kind: "network", requestId: current.requestId }, doc);
  }

  function startAttempt(operationId: number | null, url: string): Attempt {
    const started: Attempt = {
      kind: null,
      entryKey: null,
      operationId,
      expectedUrl: url,
      initial: frame.contentDocument,
      requestId: null,
      method: "GET",
      completed: false,
      redirectUrl: null,
      timer: setTimeout(() => {
        if (attempt === started) finish("timeout");
      }, options.timeoutMs),
    };
    attempt = started;
    return started;
  }

  function request(message: RequestMessage): void {
    if (!active || message.generation !== generation || message.mode !== "navigate") return;
    const url = new URL(message.path, options.origin).href;
    if (attempt !== null) {
      const expected = attempt.redirectUrl ?? attempt.expectedUrl.split("#")[0];
      if (url !== expected || (attempt.requestId !== null && attempt.redirectUrl === null))
        finish("superseded");
    }
    const current = attempt ?? startAttempt(null, url);
    current.expectedUrl = url;
    current.requestId = message.requestId;
    current.method = message.method;
    current.completed = false;
    current.redirectUrl = null;
  }

  function response(message: ControlMessage): void {
    const current = attempt;
    if (
      !active ||
      current === null ||
      message.generation !== generation ||
      message.type === "paseo.web.revoke"
    )
      return;
    if (message.requestId !== current.requestId) return;
    if (message.type === "paseo.web.response.error") {
      finish("protocol_error");
      return;
    }
    if (message.type === "paseo.web.response.head") {
      if (message.status === 204 || message.status === 205) {
        finish("protocol_error");
        return;
      }
      if (message.status >= 300 && message.status < 400) {
        const location = message.headers.find(([name]) => name.toLowerCase() === "location")?.[1];
        if (location !== undefined)
          current.redirectUrl = new URL(location, current.expectedUrl).href;
      }
    }
    if (message.type === "paseo.web.response.end") {
      current.completed = true;
      onLoad();
    }
  }

  function destination(message: NavigationCommandMessage): string | null {
    const operation = message.command;
    if (operation.kind === "navigate") return operation.url;
    const doc = frame.contentDocument;
    const record = doc === null ? undefined : documents.get(doc);
    if (record?.method !== "GET") return null;
    if (operation.kind === "reload") return doc?.location.href ?? null;
    const navigation = frameNavigation(frame);
    const offset = operation.kind === "back" ? -1 : 1;
    const index = navigation?.currentEntry?.index;
    const entry =
      index === undefined
        ? undefined
        : navigation?.entries().find((item) => item.index === index + offset);
    return safe(entry) ? (entry?.url ?? null) : null;
  }

  async function command(message: NavigationCommandMessage): Promise<void> {
    if (
      !active ||
      message.generation !== generation ||
      message.shellInstance !== shellInstance ||
      message.operationId <= operationWatermark
    )
      return;
    operationWatermark = message.operationId;
    if (attempt !== null) {
      outcome({ status: "failed", operationId: message.operationId, reason: "busy" });
      return;
    }
    const url = destination(message);
    if (url === null) {
      outcome({ status: "failed", operationId: message.operationId, reason: "unsafe_replay" });
      return;
    }
    const parsed = new URL(url);
    if (parsed.origin !== options.origin || parsed.pathname.startsWith("/__paseo/")) {
      outcome({ status: "failed", operationId: message.operationId, reason: "out_of_scope" });
      return;
    }
    const current = startAttempt(message.operationId, url);
    current.kind = message.command.kind;
    if (frame.contentDocument?.location.href === "about:blank") {
      if (
        !(await options.enter(`${parsed.pathname}${parsed.search}${parsed.hash}`)) &&
        attempt === current
      )
        finish("unsupported");
      return;
    }
    const navigation = frameNavigation(frame);
    if (navigation === null) {
      finish("unsupported");
      return;
    }
    issuing = true;
    try {
      let navigationResult: { finished: Promise<unknown> };
      if (message.command.kind === "navigate")
        navigationResult = navigation.navigate(url, { info: { operationId: message.operationId } });
      else if (message.command.kind === "reload") navigationResult = navigation.reload();
      else {
        const offset = message.command.kind === "back" ? -1 : 1;
        const index = navigation.currentEntry?.index;
        const entry = navigation
          .entries()
          .find((item) => index !== undefined && item.index === index + offset);
        if (entry === undefined) {
          finish("unsupported");
          return;
        }
        current.entryKey = entry.key;
        navigationResult = navigation.traverseTo(entry.key);
      }
      void navigationResult.finished.then(
        () => {
          if (attempt !== current) return null;
          const doc = frame.contentDocument;
          if (current.requestId !== null) onLoad();
          else if (doc === current.initial && doc !== null) onSameDocument(doc);
          else if (doc !== null) onRestored(doc);
          return null;
        },
        () => {
          if (attempt === current) finish("superseded");
          return null;
        },
      );
    } catch {
      finish("protocol_error");
    } finally {
      issuing = false;
    }
  }

  frame.addEventListener("load", onLoad);
  function dispose(): void {
    deactivate();
    frame.removeEventListener("load", onLoad);
    for (const detach of listeners.values()) detach();
    listeners.clear();
  }

  return { activate, deactivate, dispose, command, request, response };
}
