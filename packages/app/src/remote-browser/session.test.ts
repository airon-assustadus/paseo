import { describe, expect, it } from "vitest";
import {
  RemoteBrowserRpcError,
  type RemoteBrowserState,
  type RemoteBrowserViewport,
} from "@getpaseo/client";
import type { RemoteBrowserBinding } from "./registry";
import { createRemoteBrowserSession } from "./session";
import {
  createFakeAttachment,
  createFakeClient,
  createTimers,
  deferred,
  frame,
  state,
  VIEWPORT,
} from "./test-utils/fake-remote-browser";

function harness(options: { binding?: RemoteBrowserBinding | null; connected?: boolean } = {}) {
  const fake = createFakeClient();
  if (options.connected === false) fake.setStatus("connecting");
  const timers = createTimers();
  const bindings: Array<RemoteBrowserBinding | null> = [];
  const states: RemoteBrowserState[] = [];
  const session = createRemoteBrowserSession({
    client: fake.client,
    initialUrl: "http://localhost:3000/",
    binding: options.binding ?? null,
    onBinding: (binding) => bindings.push(binding),
    onBrowserState: (next) => states.push(next),
    schedule: timers.schedule,
  });
  return { ...fake, timers, bindings, states, session };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("remote browser session", () => {
  it("waits for a viewport, then opens with the initial URL and becomes ready", async () => {
    const h = harness();
    h.session.start();
    expect(h.session.getSnapshot().phase).toEqual({ kind: "idle" });
    expect(h.opens).toHaveLength(0);
    h.session.setViewport(VIEWPORT);
    expect(h.session.getSnapshot().phase).toEqual({ kind: "opening" });
    expect(h.opens[0].url).toBe("http://localhost:3000/");
    const attachment = createFakeAttachment({ browserId: "b1", generation: 1 });
    h.opens[0].result.resolve(attachment);
    await flush();
    expect(h.session.getSnapshot().phase).toEqual({ kind: "ready" });
    expect(h.session.getSnapshot().attachmentEpoch).toBe(1);
    expect(h.states).toHaveLength(1);
    expect(h.bindings.at(-1)).toEqual({
      browserId: "b1",
      generation: 1,
      detachedTimeoutMs: 60_000,
    });
  });

  it("presents frames replayed synchronously on subscription and acks them after paint", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    const attachment = createFakeAttachment({
      browserId: "b1",
      generation: 1,
      bufferedFrames: [frame("sub-b1-1", 1, 1), frame("sub-b1-1", 1, 2)],
    });
    h.opens[0].result.resolve(attachment);
    await flush();
    const first = h.session.getSnapshot().frame;
    expect(first?.seq).toBe(1);
    expect(attachment.acked).toEqual([]);
    h.session.framePainted(first!);
    expect(attachment.acked).toEqual([1]);
    expect(h.session.getSnapshot().frame?.seq).toBe(2);
    h.session.framePainted(h.session.getSnapshot().frame!);
    expect(attachment.acked).toEqual([1, 2]);
  });

  it("ends immediately when the attachment already ended with its reply, never resurrecting ready", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    const attachment = createFakeAttachment({
      browserId: "b1",
      generation: 1,
      ended: { kind: "closed", reason: "revoked" },
      bufferedFrames: [frame("sub-b1-1", 1, 1)],
    });
    h.opens[0].result.resolve(attachment);
    await flush();
    const { phase, frame: shown } = h.session.getSnapshot();
    expect(phase).toEqual({ kind: "ended", end: { kind: "closed", reason: "revoked" } });
    expect(shown).toBeNull();
    expect(attachment.acked).toEqual([]);
    expect(attachment.calls).toEqual([]);
    expect(h.bindings.at(-1)).toBeNull();
    attachment.emitFrame(frame("sub-b1-1", 1, 2));
    expect(h.session.getSnapshot().frame).toBeNull();
  });

  it("re-attaches to the same browser after a disconnect inside the grace", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    const first = createFakeAttachment({ browserId: "b1", generation: 1 });
    h.opens[0].result.resolve(first);
    await flush();
    first.emitEnd({ kind: "disconnected", reason: "disconnected" });
    expect(h.session.getSnapshot().phase).toEqual({ kind: "reconnecting" });
    expect(h.timers.pending().map((entry) => entry.delayMs)).toEqual([60_000]);
    h.setStatus("connecting");
    h.setStatus("connected");
    expect(h.attaches.map((entry) => entry.browserId)).toEqual(["b1"]);
    expect(h.timers.pending()).toHaveLength(0);
    const second = createFakeAttachment({ browserId: "b1", generation: 2 });
    h.attaches[0].result.resolve(second);
    await flush();
    expect(h.session.getSnapshot().phase).toEqual({ kind: "ready" });
    expect(h.session.getSnapshot().attachmentEpoch).toBe(2);
    expect(h.opens).toHaveLength(1);
    // Frames from the dead attachment's generation are not acked against the new one.
    second.emitFrame(frame("sub-b1-1", 1, 7));
    expect(h.session.getSnapshot().frame).toBeNull();
  });

  it("opens a new browser with the last URL once the detach grace has expired", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    const first = createFakeAttachment({ browserId: "b1", generation: 1 });
    h.opens[0].result.resolve(first);
    await flush();
    first.emitState(state({ url: "http://localhost:3000/settings" }));
    first.emitEnd({ kind: "disconnected", reason: "disconnected" });
    h.timers.fire();
    expect(h.bindings.at(-1)).toBeNull();
    h.setStatus("connected");
    expect(h.attaches).toHaveLength(0);
    expect(h.opens).toHaveLength(2);
    expect(h.opens[1].url).toBe("http://localhost:3000/settings");
  });

  it("falls back to open when the daemon no longer knows the bound browser", async () => {
    const h = harness({ binding: { browserId: "old", generation: 3, detachedTimeoutMs: 60_000 } });
    h.session.start();
    h.session.setViewport(VIEWPORT);
    expect(h.attaches[0].browserId).toBe("old");
    h.attaches[0].result.reject(new RemoteBrowserRpcError("attach", "not_found", "gone"));
    await flush();
    expect(h.bindings).toContainEqual(null);
    expect(h.opens).toHaveLength(1);
    expect(h.session.getSnapshot().phase).toEqual({ kind: "opening" });
  });

  it("reports an open failure and retries on demand", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    const error = new RemoteBrowserRpcError("open", "resource_limit", "Too many browsers");
    h.opens[0].result.reject(error);
    await flush();
    expect(h.session.getSnapshot().phase).toEqual({ kind: "failed", error });
    h.session.retry();
    expect(h.opens).toHaveLength(2);
  });

  it("detaches an attachment that arrives after the pane unmounted and never closes it", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    h.session.dispose();
    const late = createFakeAttachment({ browserId: "b1", generation: 1 });
    h.opens[0].result.resolve(late);
    await flush();
    expect(late.calls).toEqual(["detach"]);
    expect(h.session.getSnapshot().phase).toEqual({ kind: "opening" });
  });

  it("detaches on dispose and keeps the binding for the next mount", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    const attachment = createFakeAttachment({ browserId: "b1", generation: 1 });
    h.opens[0].result.resolve(attachment);
    await flush();
    h.session.dispose();
    expect(attachment.calls).toEqual(["detach"]);
    expect(h.bindings.at(-1)).toEqual({
      browserId: "b1",
      generation: 1,
      detachedTimeoutMs: 60_000,
    });
    attachment.emitEnd({ kind: "detached", reason: "detached" });
    expect(h.session.getSnapshot().phase).toEqual({ kind: "ready" });
  });

  it("closes the browser through the attachment on tab close and forgets the binding", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    const attachment = createFakeAttachment({ browserId: "b1", generation: 1 });
    h.opens[0].result.resolve(attachment);
    await flush();
    h.session.closeBrowser();
    expect(attachment.calls).toEqual(["close"]);
    expect(h.closes).toEqual([]);
    expect(h.bindings.at(-1)).toBeNull();
  });

  it("closes a detached browser generation-safely when the tab closes while reconnected", () => {
    const h = harness({ binding: { browserId: "b1", generation: 4, detachedTimeoutMs: 60_000 } });
    h.session.start();
    h.session.closeBrowser();
    expect(h.closes).toEqual([{ browserId: "b1", expectedGeneration: 4 }]);
  });

  it("swallows a close that fails because the connection dropped and still forgets the tab", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    const attachment = createFakeAttachment({ browserId: "b1", generation: 1 });
    attachment.close = async () => {
      attachment.calls.push("close");
      throw new Error("Transport not connected");
    };
    h.opens[0].result.resolve(attachment);
    await flush();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      h.session.closeBrowser();
      attachment.emitEnd({ kind: "disconnected", reason: "disconnected" });
      await flush();
      await flush();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(attachment.calls).toEqual(["close"]);
    expect(h.bindings.at(-1)).toBeNull();
    expect(h.session.getSnapshot().phase.kind).not.toBe("ready");
  });

  it("stays in ended after a takeover and attaches again only on retry", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    const attachment = createFakeAttachment({ browserId: "b1", generation: 1 });
    h.opens[0].result.resolve(attachment);
    await flush();
    attachment.emitEnd({ kind: "detached", reason: "superseded" });
    expect(h.session.getSnapshot().phase).toEqual({
      kind: "ended",
      end: { kind: "detached", reason: "superseded" },
    });
    expect(h.bindings.at(-1)).toEqual({
      browserId: "b1",
      generation: 1,
      detachedTimeoutMs: 60_000,
    });
    h.session.retry();
    expect(h.attaches.map((entry) => entry.browserId)).toEqual(["b1"]);
  });

  it("pauses frames and tells the daemon when hidden, resumes when visible", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    const attachment = createFakeAttachment({ browserId: "b1", generation: 1 });
    h.opens[0].result.resolve(attachment);
    await flush();
    const first = frame("sub-b1-1", 1, 1);
    attachment.emitFrame(first);
    h.session.setVisible(false);
    expect(attachment.calls).toEqual(["visibility:false"]);
    attachment.emitFrame(frame("sub-b1-1", 1, 2));
    // The paint already under way completes after the hide and still returns its credit.
    h.session.framePainted(first);
    expect(attachment.acked).toEqual([1]);
    expect(h.session.getSnapshot().frame?.seq).toBe(1);
    h.session.setVisible(true);
    expect(attachment.calls).toEqual(["visibility:false", "visibility:true"]);
    expect(h.session.getSnapshot().frame?.seq).toBe(2);
  });

  it("applies hidden visibility to an attachment installed while hidden", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    h.session.setVisible(false);
    const attachment = createFakeAttachment({
      browserId: "b1",
      generation: 1,
      bufferedFrames: [frame("sub-b1-1", 1, 1)],
    });
    h.opens[0].result.resolve(attachment);
    await flush();
    expect(attachment.calls).toEqual(["visibility:false"]);
    expect(h.session.getSnapshot().frame).toBeNull();
    h.session.setVisible(true);
    expect(h.session.getSnapshot().frame?.seq).toBe(1);
  });

  it("debounces resizes and skips a viewport the page already has", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    const attachment = createFakeAttachment({ browserId: "b1", generation: 1 });
    h.opens[0].result.resolve(attachment);
    await flush();
    h.session.setViewport({ ...VIEWPORT, height: 700 });
    h.session.setViewport({ ...VIEWPORT, height: 600 });
    expect(attachment.calls).toEqual([]);
    h.timers.fire();
    expect(attachment.calls).toEqual(["resize:400x600"]);
    h.session.setViewport({ ...VIEWPORT, height: 600 });
    h.session.setViewport(VIEWPORT);
    h.timers.fire();
    expect(attachment.calls).toEqual(["resize:400x600"]);
  });

  it("never acks a frame that failed to present, re-attaches, and gives up after repeated failures", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    const first = createFakeAttachment({
      browserId: "b1",
      generation: 1,
      bufferedFrames: [frame("sub-b1-1", 1, 1)],
    });
    h.opens[0].result.resolve(first);
    await flush();
    const bad = h.session.getSnapshot().frame!;
    h.session.framePresentationFailed(bad);
    expect(first.acked).toEqual([]);
    expect(first.calls).toEqual(["detach"]);
    expect(h.session.getSnapshot().frame).toBeNull();
    expect(h.attaches.map((entry) => entry.browserId)).toEqual(["b1"]);
    const second = createFakeAttachment({
      browserId: "b1",
      generation: 2,
      bufferedFrames: [frame("sub-b1-2", 2, 1)],
    });
    h.attaches[0].result.resolve(second);
    await flush();
    h.session.framePresentationFailed(h.session.getSnapshot().frame!);
    const third = createFakeAttachment({
      browserId: "b1",
      generation: 3,
      bufferedFrames: [frame("sub-b1-3", 3, 1)],
    });
    h.attaches[1].result.resolve(third);
    await flush();
    h.session.framePresentationFailed(h.session.getSnapshot().frame!);
    expect(h.attaches).toHaveLength(2);
    const { phase } = h.session.getSnapshot();
    expect(phase.kind).toBe("failed");
    expect(phase.kind === "failed" && phase.error.name).toBe("RemoteBrowserPresentationError");
    expect([first, second, third].flatMap((attachment) => attachment.acked)).toEqual([]);
    // A successful paint resets the budget.
    h.session.retry();
    const fourth = createFakeAttachment({
      browserId: "b1",
      generation: 4,
      bufferedFrames: [frame("sub-b1-4", 4, 1)],
    });
    h.attaches[2].result.resolve(fourth);
    await flush();
    h.session.framePainted(h.session.getSnapshot().frame!);
    expect(fourth.acked).toEqual([1]);
  });

  it("turns a plain error from a pending operation into UI state, and drops it once the attachment ended", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    const attachment = createFakeAttachment({ browserId: "b1", generation: 1 });
    const pendingResize = deferred<RemoteBrowserViewport>();
    const pendingDispatch = deferred<void>();
    attachment.resize = () => pendingResize.promise;
    attachment.dispatchInput = () => pendingDispatch.promise;
    h.opens[0].result.resolve(attachment);
    await flush();
    h.session.setViewport({ ...VIEWPORT, height: 600 });
    h.timers.fire();
    pendingResize.reject(new Error("Transport not connected"));
    await flush();
    expect(h.session.getSnapshot().operationError?.message).toBe("Transport not connected");
    h.session.dispatch([{ kind: "key", phase: "press", key: "Tab", modifiers: 0 }]);
    attachment.emitEnd({ kind: "disconnected", reason: "disconnected" });
    expect(h.session.getSnapshot().phase).toEqual({ kind: "reconnecting" });
    pendingDispatch.reject(new Error("socket closed"));
    await flush();
    expect(h.session.getSnapshot().operationError?.message).toBe("Transport not connected");
  });

  it("closes a browser whose open completes after the tab closed and never installs it", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    h.session.closeBrowser();
    const late = createFakeAttachment({ browserId: "b1", generation: 1 });
    h.opens[0].result.resolve(late);
    await flush();
    expect(late.calls).toEqual(["close"]);
    expect(h.session.getSnapshot().phase).toEqual({
      kind: "ended",
      end: { kind: "closed", reason: "closed" },
    });
    expect(h.bindings.at(-1)).toBeNull();
    h.session.retry();
    h.setStatus("connecting");
    h.setStatus("connected");
    expect(h.opens).toHaveLength(1);
  });

  it("does not detach again when the pane unmounts right after the tab closed", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    const attachment = createFakeAttachment({ browserId: "b1", generation: 1 });
    h.opens[0].result.resolve(attachment);
    await flush();
    h.session.closeBrowser();
    h.session.dispose();
    expect(attachment.calls).toEqual(["close"]);
  });

  it("surfaces navigation failures other than stale attachments and clears them on success", async () => {
    const h = harness();
    h.session.start();
    h.session.setViewport(VIEWPORT);
    const attachment = createFakeAttachment({ browserId: "b1", generation: 1 });
    const failure = new RemoteBrowserRpcError("navigate", "invalid_request", "bad url");
    attachment.navigate = async (navigation) => {
      if (navigation.kind === "url" && navigation.url.startsWith("ftp:")) throw failure;
      attachment.calls.push(`navigate:${navigation.kind}`);
    };
    h.opens[0].result.resolve(attachment);
    await flush();
    h.session.navigate({ kind: "url", url: "ftp://nope" });
    await flush();
    expect(h.session.getSnapshot().operationError).toBe(failure);
    h.session.navigate({ kind: "reload" });
    await flush();
    expect(h.session.getSnapshot().operationError).toBeNull();
    attachment.dispatchInput = async () => {
      throw new RemoteBrowserRpcError("dispatch_input", "stale_attachment", "replaced");
    };
    h.session.dispatch([{ kind: "key", phase: "press", key: "Enter", modifiers: 0 }]);
    await flush();
    expect(h.session.getSnapshot().operationError).toBeNull();
  });
});
