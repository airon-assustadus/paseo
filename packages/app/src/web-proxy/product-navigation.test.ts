import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrokerNavigation } from "./broker-navigation.web";
import type { NavigationState, NavigationToShellMessage } from "./navigation-messages";

const capability = {
  contentOrigin: "https://destination.ticket04-content.test",
  destinationOrigin: "http://127.0.0.1:8123",
  pathPrefix: "/allowed/",
};

afterEach(() => vi.useRealTimers());

function harness() {
  const sent: NavigationToShellMessage[] = [];
  const navigation = createBrokerNavigation({
    capability,
    assetVersion: "nav-v1",
    timeoutMs: 1000,
    onState() {},
  });
  const envelope = { v: 1, generation: 1, shellInstance: "shell-one" };
  navigation.activate({
    generation: 1,
    shellInstance: "shell-one",
    send: (message) => sent.push(message),
  });
  let sequence = 0;
  function ready() {
    navigation.receive({
      ...envelope,
      sequence: ++sequence,
      type: "paseo.web.navigation.ready",
      extension: "navigation.v1",
      assetVersion: "nav-v1",
      operations: ["navigate", "reload", "back", "forward"],
    });
  }
  function observe(requestId = 1, path = "/allowed/page") {
    navigation.observeRequest({
      type: "paseo.web.request",
      v: 1,
      generation: 1,
      requestId,
      method: "GET",
      path,
      headers: [],
      body: null,
      mode: "navigate",
    });
  }
  function state(patch: Partial<NavigationState> = {}) {
    const document: NavigationState = {
      documentId: "document-one",
      entryKey: "entry-one",
      url: `${capability.contentOrigin}/allowed/page`,
      title: "Page",
      canReload: true,
      canGoBack: false,
      canGoForward: false,
      commit: { kind: "network", requestId: 1 },
      ...patch,
    };
    navigation.receive({
      ...envelope,
      sequence: ++sequence,
      type: "paseo.web.navigation.state",
      state: document,
    });
    return document;
  }
  function result(operationId: number, document: NavigationState) {
    navigation.receive({
      ...envelope,
      sequence: ++sequence,
      type: "paseo.web.navigation.result",
      outcome: {
        status: "committed",
        operationId,
        documentId: document.documentId,
        entryKey: document.entryKey,
        commit: document.commit,
      },
    });
  }
  return { navigation, envelope, ready, observe, state, result, sent };
}

describe("product navigation broker correlation", () => {
  it("queries before sending commands and maps D to K only inside the scope", async () => {
    const test = harness();
    const opened = test.navigation.run({
      kind: "navigate",
      url: `${capability.destinationOrigin}/allowed/page#part`,
    });
    expect(test.sent).toHaveLength(1);
    expect(test.sent[0]?.type).toBe("paseo.web.navigation.query");
    test.ready();
    expect(test.sent[1]).toMatchObject({
      type: "paseo.web.navigation.command",
      operationId: 1,
      command: { kind: "navigate", url: `${capability.contentOrigin}/allowed/page#part` },
    });
    test.observe();
    const document = test.state({ url: `${capability.contentOrigin}/allowed/page#part` });
    test.result(1, document);
    await expect(opened).resolves.toMatchObject({ status: "committed", operationId: 1 });
    await expect(
      test.navigation.run({ kind: "navigate", url: `${capability.destinationOrigin}/outside` }),
    ).resolves.toMatchObject({ status: "failed", reason: "out_of_scope" });
    test.navigation.reset();
  });

  it("requires a request observed on this generation and a matching Document/entry", async () => {
    const test = harness();
    test.ready();
    const opened = test.navigation.run({ kind: "reload" });
    const unadmitted = test.state();
    expect(test.navigation.getSnapshot().document).toBeNull();
    test.result(1, unadmitted);
    await expect(opened).resolves.toMatchObject({ status: "failed", reason: "protocol_error" });
    test.navigation.reset();
  });

  it("does not use a request from before the operation", async () => {
    const test = harness();
    test.ready();
    test.observe();
    const opened = test.navigation.run({ kind: "reload" });
    test.result(1, test.state());
    await expect(opened).resolves.toMatchObject({ status: "failed", reason: "protocol_error" });
    test.navigation.reset();
  });

  it("accepts BFCache for a known current-generation document without fabricating a request", async () => {
    const test = harness();
    test.ready();
    test.observe();
    test.state();
    const back = test.navigation.run({ kind: "back" });
    const document = test.state({ commit: { kind: "bfcache" } });
    test.result(1, document);
    await expect(back).resolves.toMatchObject({ status: "committed", commit: { kind: "bfcache" } });
    test.navigation.reset();
  });

  it("fences pending commands once and ignores late results and previous grants", async () => {
    const test = harness();
    test.ready();
    const opened = test.navigation.run({ kind: "reload" });
    test.observe();
    const document = test.state();
    test.navigation.reset();
    test.result(1, document);
    await expect(opened).resolves.toMatchObject({ status: "failed", reason: "channel_lost" });
    test.navigation.activate({
      generation: 2,
      shellInstance: "shell-one",
      send: (message) => test.sent.push(message),
    });
    test.ready();
    test.state({ commit: { kind: "bfcache" } });
    expect(test.navigation.getSnapshot()).toMatchObject({ ready: false, document: null });
    test.navigation.reset();
  });

  it("does not allow another operation or a superseded result to settle the current one", async () => {
    const test = harness();
    test.ready();
    const opened = test.navigation.run({ kind: "reload" });
    await expect(test.navigation.run({ kind: "reload" })).resolves.toMatchObject({
      reason: "busy",
    });
    test.observe();
    const document = test.state();
    test.result(2, document);
    test.result(1, document);
    await expect(opened).resolves.toMatchObject({ operationId: 1, status: "committed" });
    test.navigation.reset();
  });

  it("bounds waiting for an old shell without changing legacy lifecycle", async () => {
    vi.useFakeTimers();
    const test = harness();
    const opened = test.navigation.run({ kind: "reload" });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(opened).resolves.toMatchObject({ reason: "unsupported" });
    expect(test.navigation.getSnapshot().ready).toBe(false);
    test.navigation.reset();
  });

  it("rejects mismatched assets and metadata outside K/scope", async () => {
    const test = harness();
    const opened = test.navigation.run({ kind: "reload" });
    test.navigation.receive({
      ...test.envelope,
      sequence: 1,
      type: "paseo.web.navigation.ready",
      extension: "navigation.v1",
      assetVersion: "nav-v2",
      operations: ["navigate"],
    });
    await expect(opened).resolves.toMatchObject({ reason: "unsupported" });
    test.ready();
    test.ready();
    test.observe();
    test.state({ url: "https://outside.test/allowed/page" });
    expect(test.navigation.getSnapshot().document).toBeNull();
    test.navigation.reset();
  });
});
