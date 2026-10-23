import { describe, expect, it } from "vitest";
import { DEFAULT_BRIDGE_LIMITS, parseHello, parsePortGrant } from "./bridge-messages";
import {
  NAVIGATION_EXTENSION,
  NAVIGATION_LIMITS,
  NAVIGATION_VERSION,
  parseNavigationToBroker,
  parseNavigationToShell,
  type NavigationCommand,
  type NavigationCommandMessage,
  type NavigationCommit,
  type NavigationEnvelope,
  type NavigationFailureReason,
  type NavigationReadyMessage,
  type NavigationResultMessage,
  type NavigationStateMessage,
} from "./navigation-messages";
import { parseSessionPortMessage } from "./shell/relay-messages";

const envelope: NavigationEnvelope = {
  v: NAVIGATION_VERSION,
  generation: 1,
  shellInstance: "shell-1",
  sequence: 1,
};

const command: NavigationCommandMessage = {
  type: "paseo.web.navigation.command",
  ...envelope,
  operationId: 1,
  command: { kind: "navigate", url: "https://destination.ticket04-content.test/path?q=1#section" },
};

const ready: NavigationReadyMessage = {
  type: "paseo.web.navigation.ready",
  ...envelope,
  extension: NAVIGATION_EXTENSION,
  assetVersion: "ticket04-product-nav-v1",
  operations: ["navigate", "reload", "back", "forward"],
};

const result: NavigationResultMessage = {
  type: "paseo.web.navigation.result",
  ...envelope,
  outcome: {
    status: "committed",
    operationId: 1,
    documentId: "document-1",
    entryKey: "entry-1",
    commit: { kind: "network", requestId: 1 },
  },
};

const state: NavigationStateMessage = {
  type: "paseo.web.navigation.state",
  ...envelope,
  state: {
    commit: { kind: "network", requestId: 1 },
    documentId: "document-1",
    entryKey: "entry-1",
    url: "https://destination.ticket04-content.test/path?q=1#section",
    title: "Page title",
    canReload: true,
    canGoBack: false,
    canGoForward: false,
  },
};

describe("navigation envelope and direction", () => {
  it.each([ready, result, state])("accepts $type only toward the broker", (message) => {
    expect(parseNavigationToBroker(message)).toEqual(message);
    expect(parseNavigationToShell(message)).toBeNull();
  });

  it("accepts commands only toward the shell", () => {
    expect(parseNavigationToShell(command)).toEqual(command);
    expect(parseNavigationToBroker(command)).toBeNull();
  });

  it.each([null, undefined, [], true, 1, "navigation.v1", {}].map((value) => ({ value })))(
    "rejects non-messages: $value",
    ({ value }) => {
      expect(parseNavigationToShell(value)).toBeNull();
      expect(parseNavigationToBroker(value)).toBeNull();
    },
  );

  it.each([
    { v: 2 },
    { generation: 0 },
    { generation: -1 },
    { generation: 1.5 },
    { generation: "1" },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { sequence: 0 },
    { sequence: NaN },
    { sequence: Infinity },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { shellInstance: "" },
    { shellInstance: "shell 1" },
    { shellInstance: "shell\u0000" },
    { shellInstance: "a".repeat(129) },
    { shellInstance: "é".repeat(65) },
    { shellInstance: "\ud800" },
    { unexpected: true },
    { type: "paseo.web.navigation.unknown" },
  ])("rejects invalid envelope %j in both directions", (patch) => {
    expect(parseNavigationToShell({ ...command, ...patch })).toBeNull();
    for (const message of [ready, result, state]) {
      expect(parseNavigationToBroker({ ...message, ...patch })).toBeNull();
    }
  });

  it("accepts safe integer and UTF-8 identifier boundaries without coercion", () => {
    const message = {
      ...command,
      generation: Number.MAX_SAFE_INTEGER,
      sequence: Number.MAX_SAFE_INTEGER,
      operationId: Number.MAX_SAFE_INTEGER,
      shellInstance: "é".repeat(64),
    };
    expect(parseNavigationToShell(message)).toEqual(message);
  });

  it("rejects missing, inherited and symbol envelope fields", () => {
    const { shellInstance: _shellInstance, ...missing } = command;
    const inherited = Object.assign(Object.create({ shellInstance: "shell-1" }), missing);
    expect(parseNavigationToShell(missing)).toBeNull();
    expect(parseNavigationToShell(inherited)).toBeNull();
    expect(parseNavigationToShell({ ...command, [Symbol("extra")]: true })).toBeNull();
  });

  it("validates structure without claiming replay or current-grant verification", () => {
    expect(parseNavigationToBroker(result)).toEqual(result);
    expect(parseNavigationToBroker(result)).toEqual(result);
    expect(parseNavigationToBroker({ ...result, generation: 2 })).toEqual({
      ...result,
      generation: 2,
    });
  });
});

describe("navigation readiness", () => {
  it("query negotiates the extension only toward the shell", () => {
    const query = { type: "paseo.web.navigation.query", ...envelope, assetVersion: "nav-v1" };
    expect(parseNavigationToShell(query)).toEqual(query);
    expect(parseNavigationToBroker(query)).toBeNull();
    expect(parseNavigationToShell({ ...query, authorityEpoch: "1" })).toBeNull();
    expect(parseNavigationToShell({ ...query, assetVersion: "" })).toBeNull();
  });
  it.each([{ operations: [] }, { operations: ["navigate"] }, { operations: ["back", "forward"] }])(
    "accepts bounded operation subsets $operations",
    ({ operations }) => {
      expect(parseNavigationToBroker({ ...ready, operations })).toEqual({ ...ready, operations });
    },
  );

  it.each([
    { extension: "navigation.v2" },
    { extension: undefined },
    { assetVersion: "" },
    { assetVersion: "a".repeat(129) },
    { operations: "navigate" },
    { operations: ["navigate", "navigate"] },
    { operations: ["purge"] },
    { operations: ["navigate", "reload", "back", "forward", "navigate"] },
    { operations: [null] },
    { workerNegotiated: true },
  ])("rejects invalid readiness %j", (patch) => {
    expect(parseNavigationToBroker({ ...ready, ...patch })).toBeNull();
  });

  it("copies operations rather than sharing the received array", () => {
    const message = { ...ready, operations: [...ready.operations] };
    const parsed = parseNavigationToBroker(message);
    message.operations.length = 0;
    expect(parsed).toEqual(ready);
  });
});

describe("navigation commands", () => {
  const commands: NavigationCommand[] = [
    { kind: "navigate", url: "http://127.0.0.1:1234/path" },
    { kind: "reload" },
    { kind: "back" },
    { kind: "forward" },
  ];

  it.each(commands)("accepts $kind", (operation) => {
    const message = { ...command, command: operation };
    expect(parseNavigationToShell(message)).toEqual(message);
  });

  it.each([
    {},
    { kind: "navigate" },
    { kind: "navigate", url: null },
    { kind: "navigate", url: "https://content.test/", body: "secret" },
    { kind: "reload", url: "https://content.test/" },
    { kind: "back", delta: -1 },
    { kind: "forward", entryKey: "entry-2" },
    { kind: "purge" },
  ])("rejects malformed operation %j", (operation) => {
    expect(parseNavigationToShell({ ...command, command: operation })).toBeNull();
  });

  it.each([undefined, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1])(
    "rejects operationId %j",
    (operationId) => {
      expect(parseNavigationToShell({ ...command, operationId })).toBeNull();
    },
  );

  it("does not alias the received command", () => {
    const message = { ...command, command: { kind: "navigate", url: "https://content.test/" } };
    const parsed = parseNavigationToShell(message);
    message.command.url = "https://changed.test/";
    expect(parsed?.type === "paseo.web.navigation.command" && parsed.command).toEqual({
      kind: "navigate",
      url: "https://content.test/",
    });
  });
});

describe("navigation URLs", () => {
  it.each([
    "",
    "/relative",
    "//content.test/path",
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp/document",
    "https://user:password@content.test/",
    "https://user@content.test/",
    "https://content.test/with space",
    "https://content.test/\npath",
    "https:\\content.test/path",
    "https://[invalid/",
    "https://content.test/\udfff",
  ])("rejects invalid URL %j in commands and state", (url) => {
    expect(parseNavigationToShell({ ...command, command: { kind: "navigate", url } })).toBeNull();
    expect(parseNavigationToBroker({ ...state, state: { ...state.state, url } })).toBeNull();
  });

  it("enforces UTF-8 URL bytes, including non-ASCII fragments", () => {
    const prefix = "https://content.test/#";
    const remaining = NAVIGATION_LIMITS.maxUrlBytes - prefix.length;
    const url = prefix + "é".repeat(Math.floor(remaining / 2)) + "a".repeat(remaining % 2);
    const message = { ...command, command: { kind: "navigate", url } };
    expect(parseNavigationToShell(message)).toEqual(message);
    expect(
      parseNavigationToShell({ ...message, command: { kind: "navigate", url: url + "a" } }),
    ).toBeNull();
  });
});

describe("navigation results", () => {
  const commits: NavigationCommit[] = [
    { kind: "network", requestId: 1 },
    { kind: "network", requestId: NAVIGATION_LIMITS.maxRequestId },
    { kind: "same_document" },
    { kind: "bfcache" },
  ];

  it.each(commits)("accepts an explicit $kind commit", (commit) => {
    const message = { ...result, outcome: { ...result.outcome, commit } };
    expect(parseNavigationToBroker(message)).toEqual(message);
  });

  it.each([
    { kind: "network" },
    { kind: "network", requestId: 0 },
    { kind: "network", requestId: 1.5 },
    { kind: "network", requestId: NAVIGATION_LIMITS.maxRequestId + 1 },
    { kind: "same_document", requestId: 1 },
    { kind: "bfcache", requestId: 1 },
    { kind: "bfcache", requestId: null },
    { kind: "network", requestId: 1, authorityEpoch: "1" },
    { kind: "load" },
    { kind: "head" },
  ])("rejects invalid or fictitious request evidence %j", (commit) => {
    expect(
      parseNavigationToBroker({ ...result, outcome: { ...result.outcome, commit } }),
    ).toBeNull();
  });

  it.each([
    { operationId: 0 },
    { documentId: "" },
    { documentId: "a".repeat(129) },
    { entryKey: "" },
    { entryKey: "é".repeat(65) },
    { status: "loaded" },
    { commit: undefined },
    { reason: "timeout" },
    { authorityEpoch: "1" },
  ])("rejects malformed committed result %j", (patch) => {
    expect(
      parseNavigationToBroker({ ...result, outcome: { ...result.outcome, ...patch } }),
    ).toBeNull();
  });

  const reasons: NavigationFailureReason[] = [
    "unsupported",
    "out_of_scope",
    "busy",
    "timeout",
    "channel_lost",
    "superseded",
    "unsafe_replay",
    "protocol_error",
  ];

  it.each(reasons)("accepts closed failure reason %s", (reason) => {
    const message = { ...result, outcome: { status: "failed", operationId: 1, reason } };
    expect(parseNavigationToBroker(message)).toEqual(message);
  });

  it.each([
    { status: "failed", operationId: 1, reason: "arbitrary socket error" },
    { status: "failed", operationId: 1, reason: "timeout", message: "private data" },
    { status: "failed", operationId: 1, reason: "timeout", documentId: "document-1" },
    { status: "failed", operationId: 0, reason: "timeout" },
  ])("rejects malformed failure %j", (outcome) => {
    expect(parseNavigationToBroker({ ...result, outcome })).toBeNull();
  });

  it("copies nested commit data", () => {
    const commit = { kind: "network", requestId: 1 };
    const message = { ...result, outcome: { ...result.outcome, commit } };
    const parsed = parseNavigationToBroker(message);
    commit.requestId = 2;
    expect(parsed).toEqual(result);
  });
});

describe("navigation document metadata", () => {
  it.each(["", "<img src=x onerror=alert(1)>", "é".repeat(512), "🚀".repeat(256)])(
    "preserves bounded title text without treating it as authority or markup: %j",
    (title) => {
      const message = { ...state, state: { ...state.state, title } };
      expect(parseNavigationToBroker(message)).toEqual(message);
    },
  );

  it.each([
    { title: "a".repeat(1025) },
    { title: "é".repeat(513) },
    { title: "🚀".repeat(257) },
    { title: "\ud800" },
    { title: null },
    { documentId: "" },
    { entryKey: null },
    { canReload: 1 },
    { canGoBack: "false" },
    { canGoForward: null },
    { cleanupRequiredEpoch: null },
  ])("rejects malformed document metadata %j", (patch) => {
    expect(parseNavigationToBroker({ ...state, state: { ...state.state, ...patch } })).toBeNull();
  });

  it("copies document metadata", () => {
    const message = { ...state, state: { ...state.state } };
    const parsed = parseNavigationToBroker(message);
    message.state.title = "Changed after parsing";
    expect(parsed).toEqual(state);
  });
});

describe("legacy message separation", () => {
  it("leaves legacy hello and grant shapes unchanged", () => {
    const hello = { type: "paseo.web.hello", v: 1 };
    const grant = { type: "paseo.web.port", v: 1, generation: 1, limits: DEFAULT_BRIDGE_LIMITS };
    expect(parseHello(hello)).toEqual(hello);
    expect(parsePortGrant(grant)).toEqual(grant);
    expect(parseNavigationToBroker(hello)).toBeNull();
    expect(parseNavigationToShell(grant)).toBeNull();
    expect(parseHello(ready)).toBeNull();
    expect(parsePortGrant(command)).toBeNull();
  });

  it("does not extend the legacy ticket parser or imply SW negotiation", () => {
    const ticket = { type: "paseo.shell.ticket.prepare", ticket: "a".repeat(22) };
    expect(parseSessionPortMessage(ticket)).toEqual(ticket);
    expect(parseSessionPortMessage({ ...ticket, target: "/path" })).toBeNull();
    expect(parseSessionPortMessage(ready)).toBeNull();
    expect(parseNavigationToBroker(ticket)).toBeNull();
    expect(parseNavigationToShell(ticket)).toBeNull();
  });
});
