import {
  parseNavigationToBroker,
  type NavigationCommand,
  type NavigationFailureReason,
  type NavigationOperation,
  type NavigationOutcome,
  type NavigationState,
  type NavigationToShellMessage,
} from "./navigation-messages";
import { resolveDestinationUrl, type WebProxyCapability } from "./request-policy";
import type { RequestMessage } from "./bridge-messages";

export interface WebProxyNavigationSnapshot {
  ready: boolean;
  operations: readonly NavigationOperation[];
  document: NavigationState | null;
}

interface PendingNavigation {
  operationId: number;
  command: NavigationCommand;
  minimumRequestId: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(outcome: NavigationOutcome): void;
  sent: boolean;
}

export function createBrokerNavigation(options: {
  capability: WebProxyCapability;
  assetVersion: string | null;
  timeoutMs: number;
  onState(snapshot: WebProxyNavigationSnapshot): void;
}) {
  let snapshot: WebProxyNavigationSnapshot = { ready: false, operations: [], document: null };
  let generation = 0;
  let shellInstance = "";
  let sequence = 0;
  let receivedSequence = 0;
  let nextOperation = 1;
  let requestWatermark = 0;
  let send: ((message: NavigationToShellMessage) => void) | null = null;
  let pending: PendingNavigation | null = null;
  const requests = new Map<number, string>();
  const documents = new Set<string>();

  function publish(next: WebProxyNavigationSnapshot): void {
    snapshot = next;
    options.onState(getSnapshot());
  }

  function getSnapshot(): WebProxyNavigationSnapshot {
    return {
      ...snapshot,
      operations: [...snapshot.operations],
      document:
        snapshot.document === null
          ? null
          : { ...snapshot.document, commit: { ...snapshot.document.commit } },
    };
  }

  function settle(outcome: NavigationOutcome): void {
    const current = pending;
    if (current === null || outcome.operationId !== current.operationId) return;
    pending = null;
    clearTimeout(current.timer);
    current.resolve(outcome);
  }

  function fail(reason: NavigationFailureReason): void {
    if (pending !== null) settle({ status: "failed", operationId: pending.operationId, reason });
  }

  function reset(reason: NavigationFailureReason = "channel_lost"): void {
    send = null;
    fail(reason);
    requests.clear();
    documents.clear();
    publish({ ready: false, operations: [], document: null });
  }

  function envelope() {
    return { v: 1 as const, generation, shellInstance, sequence: ++sequence };
  }

  function activate(input: {
    generation: number;
    shellInstance: string;
    send(message: NavigationToShellMessage): void;
  }): void {
    reset();
    if (options.assetVersion === null) return;
    generation = input.generation;
    shellInstance = input.shellInstance;
    receivedSequence = 0;
    sequence = 0;
    requestWatermark = 0;
    send = input.send;
    send({ type: "paseo.web.navigation.query", ...envelope(), assetVersion: options.assetVersion });
  }

  function contentUrl(url: string, fromContent: boolean): string | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const origin = fromContent
      ? options.capability.contentOrigin
      : options.capability.destinationOrigin;
    if (parsed.origin !== origin || parsed.username !== "" || parsed.password !== "") return null;
    if (parsed.pathname.startsWith("/__paseo/")) return null;
    const resolved = resolveDestinationUrl(
      options.capability,
      `${parsed.pathname}${parsed.search}`,
    );
    if (resolved.kind !== "ok") return null;
    return `${options.capability.contentOrigin}${resolved.url.pathname}${resolved.url.search}${parsed.hash}`;
  }

  function dispatch(): void {
    if (pending === null || pending.sent || !snapshot.ready || send === null) return;
    if (!snapshot.operations.includes(pending.command.kind)) {
      fail("unsupported");
      return;
    }
    pending.sent = true;
    pending.minimumRequestId = requestWatermark;
    send({
      type: "paseo.web.navigation.command",
      ...envelope(),
      operationId: pending.operationId,
      command: pending.command,
    });
  }

  function run(command: NavigationCommand): Promise<NavigationOutcome> {
    const operationId = nextOperation++;
    const failure = (reason: NavigationFailureReason): Promise<NavigationOutcome> =>
      Promise.resolve({ status: "failed", operationId, reason });
    if (pending !== null) return failure("busy");
    if (send === null) return failure("unsupported");
    let mapped = command;
    if (command.kind === "navigate") {
      const url = contentUrl(command.url, false);
      if (url === null) return failure("out_of_scope");
      mapped = { kind: "navigate", url };
    }
    return new Promise((resolve) => {
      pending = {
        operationId,
        command: mapped,
        minimumRequestId: requestWatermark,
        resolve,
        sent: false,
        timer: setTimeout(
          () => fail(snapshot.ready ? "timeout" : "unsupported"),
          options.timeoutMs,
        ),
      };
      dispatch();
    });
  }

  function observeRequest(request: RequestMessage): void {
    if (send === null || request.generation !== generation || request.mode !== "navigate") return;
    const resolved = resolveDestinationUrl(options.capability, request.path);
    if (resolved.kind !== "ok") return;
    requestWatermark = Math.max(requestWatermark, request.requestId);
    requests.set(
      request.requestId,
      `${options.capability.contentOrigin}${resolved.url.pathname}${resolved.url.search}`,
    );
    if (requests.size > 128) requests.delete(requests.keys().next().value!);
  }

  function acceptDocument(document: NavigationState): boolean {
    const url = contentUrl(document.url, true);
    if (url === null) return false;
    if (document.commit.kind === "network") {
      const requested = requests.get(document.commit.requestId);
      if (requested !== url.split("#")[0]) return false;
      documents.add(document.documentId);
      if (documents.size > 128) documents.delete(documents.values().next().value!);
      return true;
    }
    return documents.has(document.documentId);
  }

  function receive(data: unknown): boolean {
    const message = parseNavigationToBroker(data);
    if (message === null) return false;
    if (
      send === null ||
      message.generation !== generation ||
      message.shellInstance !== shellInstance
    )
      return true;
    if (message.sequence <= receivedSequence) return true;
    receivedSequence = message.sequence;
    if (message.type === "paseo.web.navigation.ready") {
      if (message.assetVersion !== options.assetVersion) {
        fail("unsupported");
        return true;
      }
      publish({ ...snapshot, ready: true, operations: [...message.operations] });
      dispatch();
      return true;
    }
    if (!snapshot.ready) return true;
    if (message.type === "paseo.web.navigation.state") {
      if (acceptDocument(message.state)) publish({ ...snapshot, document: message.state });
      return true;
    }
    const outcome = message.outcome;
    if (pending === null || outcome.operationId !== pending.operationId) return true;
    if (outcome.status === "committed") {
      const document = snapshot.document;
      if (document?.documentId !== outcome.documentId || document.entryKey !== outcome.entryKey) {
        fail("protocol_error");
        return true;
      }
      if (
        outcome.commit.kind === "network" &&
        outcome.commit.requestId <= pending.minimumRequestId
      ) {
        fail("protocol_error");
        return true;
      }
      if (JSON.stringify(document.commit) !== JSON.stringify(outcome.commit)) {
        fail("protocol_error");
        return true;
      }
    }
    settle(outcome);
    return true;
  }

  return { activate, reset, run, receive, observeRequest, getSnapshot };
}
