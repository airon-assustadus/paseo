import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeRemoteBrowserFrame,
  RemoteBrowserOpcode,
  type RemoteBrowserBinaryFrame,
} from "@getpaseo/protocol/binary-frames/index";
import {
  REMOTE_BROWSER_MAX_STATE_BYTES,
  type RemoteBrowserNavigation,
  type RemoteBrowserViewport,
} from "@getpaseo/protocol/remote-browser/rpc-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { SessionOutboundMessageSchema } from "../messages.js";
import { TunnelProtocolError } from "../network-tunnel/network-tunnel-session.js";
import { SessionDelivery } from "../session/owned-subscriptions/index.js";
import type {
  EngineExitReason,
  EngineFrame,
  EngineMetrics,
  EnginePageState,
  RemoteBrowserEngine,
  ScreencastParams,
} from "./engine.js";
import { CdpError } from "./cdp-connection.js";
import type { CdpCommand } from "./input-mapping.js";
import {
  REMOTE_BROWSER_FAMILY,
  RemoteBrowserSession,
  type RemoteBrowserSessionLimits,
} from "./remote-browser-session.js";

const VIEWPORT: RemoteBrowserViewport = {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
  touch: true,
};

interface Write {
  method: string;
  params?: unknown;
}

/** A browser whose CDP writes are recorded and can be held to force races. */
class ScriptedEngine implements RemoteBrowserEngine {
  state: EnginePageState = {
    url: "about:blank",
    title: "",
    canGoBack: false,
    canGoForward: false,
    loading: false,
    error: null,
    focusedEditable: null,
    notice: null,
  };
  readonly writes: Write[] = [];
  readonly released: number[] = [];
  closed = false;
  private readonly holds = new Map<string, Array<() => void>>();
  private readonly holdNext = new Set<string>();
  private readonly stateListeners = new Set<() => void>();
  private readonly frameListeners = new Set<(frame: EngineFrame) => void>();
  private readonly exitListeners = new Set<(reason: EngineExitReason) => void>();
  private frameCounter = 0;

  /** The next write of `method` is recorded, then waits until `release(method)`. */
  hold(method: string): void {
    this.holdNext.add(method);
  }

  release(method: string): void {
    for (const resume of this.holds.get(method)?.splice(0) ?? []) resume();
  }

  methods(): string[] {
    return this.writes.map((write) => write.method);
  }

  setState(patch: Partial<EnginePageState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.stateListeners) listener();
  }

  emitFrame(options: { width?: number; height?: number; bytes?: number } = {}): number {
    const id = this.frameCounter++;
    const frame: EngineFrame = {
      base64: Buffer.from(
        jpeg(options.width ?? 780, options.height ?? 1688, options.bytes ?? 32),
      ).toString("base64"),
      cssWidth: 390,
      cssHeight: 844,
      release: () => {
        if (!this.released.includes(id)) this.released.push(id);
      },
    };
    for (const listener of this.frameListeners) listener(frame);
    return id;
  }

  exit(reason: EngineExitReason): void {
    for (const listener of this.exitListeners) listener(reason);
  }

  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onFrame(listener: (frame: EngineFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onExit(listener: (reason: EngineExitReason) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async navigate(navigation: RemoteBrowserNavigation, signal: AbortSignal): Promise<void> {
    await this.write("Page.navigate", navigation, signal);
  }

  async dispatch(command: CdpCommand, signal: AbortSignal): Promise<void> {
    await this.write(command.method, command.params, signal);
  }

  focusProbes = 0;

  async refreshFocus(signal: AbortSignal): Promise<number | null> {
    await this.write("Runtime.evaluate", "focus-probe", signal);
    this.focusProbes += 1;
    return this.state.focusedEditable?.focusId ?? null;
  }

  async setViewport(viewport: RemoteBrowserViewport, _scale: number, signal: AbortSignal) {
    await this.write("Emulation.setDeviceMetricsOverride", viewport, signal);
    await this.write("Emulation.setTouchEmulationEnabled", viewport.touch, signal);
  }

  async startScreencast(params: ScreencastParams, signal: AbortSignal): Promise<void> {
    await this.write("Page.stopScreencast", undefined, signal);
    await this.write("Page.startScreencast", params, signal);
  }

  async stopScreencast(): Promise<void> {
    await this.write("Page.stopScreencast", "browser", new AbortController().signal);
  }

  metrics(): EngineMetrics {
    return {
      rssBytes: 0,
      pssBytes: null,
      memoryBytes: 0,
      cpuMs: 0,
      processCount: 0,
      proxyBytesUp: 0,
      proxyBytesDown: 0,
      proxyConnections: 0,
      proxyRequestShapes: { connects: 0, plainRequests: 0, upgrades: {} },
      proxyRecentDials: [],
      browserInternalRefused: [],
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Like CdpConnection.send: an aborted signal writes nothing. */
  private write(method: string, params: unknown, signal: AbortSignal): Promise<void> {
    if (signal.aborted)
      return Promise.reject(new CdpError(method, "aborted", "Operation was cancelled"));
    this.writes.push({ method, params });
    if (!this.holdNext.delete(method)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiting = this.holds.get(method) ?? [];
      waiting.push(resolve);
      this.holds.set(method, waiting);
    });
  }
}

function jpeg(width: number, height: number, total: number): Uint8Array {
  const header = [
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
  ];
  const bytes = new Uint8Array(Math.max(total, header.length + 2));
  bytes.set(header);
  return bytes;
}

interface Harness {
  session: RemoteBrowserSession;
  delivery: SessionDelivery;
  socket: object;
  engines: ScriptedEngine[];
  messages: SessionOutboundMessage[];
  frames: RemoteBrowserBinaryFrame[];
  setAllowed(allowed: boolean): void;
  request<T extends SessionInboundMessage>(
    message: T,
    socket?: object,
  ): Promise<SessionOutboundMessage>;
  start(request: SessionInboundMessage, socket?: object): Promise<void>;
  responseTo(requestId: string): SessionOutboundMessage | undefined;
  open(): Promise<{ browserId: string; subscriptionId: string; generation: number }>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const harness of harnesses.splice(0)) {
    await harness.delivery.close();
    await harness.session.closeAll();
  }
});

function createHarness(limits: Partial<RemoteBrowserSessionLimits> = {}): Harness {
  const messages: SessionOutboundMessage[] = [];
  const frames: RemoteBrowserBinaryFrame[] = [];
  const engines: ScriptedEngine[] = [];
  let allowed = true;
  const delivery = new SessionDelivery(
    (_source, message) => messages.push(message),
    (_source, bytes) => {
      const frame = decodeRemoteBrowserFrame(bytes);
      if (!frame) throw new Error("Undecodable remote browser frame");
      frames.push(frame);
    },
  );
  const socket = {};
  delivery.attach(socket, true);
  const session = new RemoteBrowserSession({
    host: {
      emit: (message) => {
        if (!delivery.reply(message)) messages.push(message);
      },
      begin: (stop) => delivery.begin(REMOTE_BROWSER_FAMILY, undefined, stop),
      currentSource: () => delivery.currentSource,
      isModernSource: (source) => delivery.isModern(source),
      allowsNetworkProxy: () => allowed,
    },
    logger: pino({ level: "silent" }),
    launcher: {
      available: true,
      launch: async () => {
        const engine = new ScriptedEngine();
        engines.push(engine);
        return engine;
      },
      closeBrowser: (engine) => engine.close(),
    },
    limits,
  });
  let counter = 0;
  const dispatch = (message: SessionInboundMessage): Promise<void> => {
    switch (message.type) {
      case "browser.remote.open.request":
        return session.handleOpen(message);
      case "browser.remote.attach.request":
        return session.handleAttach(message);
      case "browser.remote.detach.request":
        return session.handleDetach(message);
      case "browser.remote.close.request":
        return session.handleClose(message);
      case "browser.remote.list.request":
        session.handleList(message);
        return Promise.resolve();
      case "browser.remote.navigate.request":
        return session.handleNavigate(message);
      case "browser.remote.dispatch_input.request":
        return session.handleDispatchInput(message);
      case "browser.remote.resize.request":
        return session.handleResize(message);
      case "browser.remote.set_visibility.request":
        return session.handleSetVisibility(message);
      default:
        throw new Error(`Unexpected ${message.type}`);
    }
  };
  const harness: Harness = {
    session,
    delivery,
    socket,
    engines,
    messages,
    frames,
    setAllowed: (value) => {
      allowed = value;
    },
    start: (message, requestSocket = socket) =>
      delivery.request(requestSocket, message, () => dispatch(message)),
    responseTo: (requestId) =>
      messages.find(
        (message) =>
          "payload" in message &&
          typeof message.payload === "object" &&
          message.payload !== null &&
          "requestId" in message.payload &&
          message.payload.requestId === requestId,
      ),
    request: async (message, requestSocket = socket) => {
      await harness.start(message, requestSocket);
      const response = harness.responseTo((message as { requestId: string }).requestId);
      if (!response) throw new Error(`No response to ${message.type}`);
      return response;
    },
    open: async () => {
      const response = await harness.request({
        type: "browser.remote.open.request",
        requestId: `open-${++counter}`,
        viewport: VIEWPORT,
      });
      if (response.type !== "browser.remote.open.response" || !response.payload.ok) {
        throw new Error(`Open failed: ${JSON.stringify(response)}`);
      }
      const { browserId, subscriptionId, generation } = response.payload;
      return { browserId, subscriptionId, generation };
    },
  };
  harnesses.push(harness);
  return harness;
}

function payloadOf(message: SessionOutboundMessage | undefined): Record<string, unknown> {
  if (!message || !("payload" in message)) throw new Error("No payload");
  return message.payload as Record<string, unknown>;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

let requestCounter = 0;
function nextId(prefix: string): string {
  requestCounter += 1;
  return `${prefix}-${requestCounter}`;
}

describe("RemoteBrowserSession ownership", () => {
  it("opens a browser, replies before any frame, and announces limits and state", async () => {
    const harness = createHarness();
    const triple = await harness.open();
    expect(triple.generation).toBe(1);
    const engine = harness.engines[0];
    expect(engine.methods()).toEqual(["Page.stopScreencast", "Page.startScreencast"]);
    const openIndex = harness.messages.findIndex(
      (message) => message.type === "browser.remote.open.response",
    );
    expect(openIndex).toBeGreaterThanOrEqual(0);
    engine.emitFrame();
    expect(harness.frames).toHaveLength(1);
    expect(harness.frames[0]).toMatchObject({
      subscriptionId: triple.subscriptionId,
      generation: 1,
      seq: 0,
      imageWidth: 780,
    });
  });

  it("denies without network.proxy, legacy sources and foreign IDs", async () => {
    const harness = createHarness();
    harness.setAllowed(false);
    const denied = await harness.request({
      type: "browser.remote.open.request",
      requestId: nextId("o"),
      viewport: VIEWPORT,
    });
    expect(payloadOf(denied)).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    harness.setAllowed(true);
    const legacy = {};
    harness.delivery.attach(legacy, false);
    const unsupported = await harness.request(
      { type: "browser.remote.open.request", requestId: nextId("o"), viewport: VIEWPORT },
      legacy,
    );
    expect(payloadOf(unsupported)).toMatchObject({
      ok: false,
      error: { code: "unsupported_capability" },
    });
    const foreign = await harness.request({
      type: "browser.remote.attach.request",
      requestId: nextId("a"),
      browserId: "99999999-9999-4999-8999-999999999999",
    });
    expect(payloadOf(foreign)).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("limits browsers per session", async () => {
    const harness = createHarness({ maxBrowsers: 1 });
    await harness.open();
    const second = await harness.request({
      type: "browser.remote.open.request",
      requestId: nextId("o"),
      viewport: VIEWPORT,
    });
    expect(payloadOf(second)).toMatchObject({ ok: false, error: { code: "resource_limit" } });
  });

  it("never dispatches the rest of a batch after a same-socket takeover", async () => {
    const harness = createHarness();
    const triple = await harness.open();
    const engine = harness.engines[0];
    engine.hold("Input.insertText");
    const batchId = nextId("input");
    const batch = harness.start({
      type: "browser.remote.dispatch_input.request",
      requestId: batchId,
      ...triple,
      events: [
        { kind: "text", text: "a" },
        { kind: "text", text: "b" },
        { kind: "text", text: "c" },
      ],
    });
    await flush();
    const takeover = await harness.request({
      type: "browser.remote.attach.request",
      requestId: nextId("a"),
      browserId: triple.browserId,
    });
    expect(payloadOf(takeover)).toMatchObject({ ok: true, generation: 2 });
    engine.release("Input.insertText");
    await batch;
    expect(engine.writes.filter((write) => write.method === "Input.insertText")).toHaveLength(1);
    expect(payloadOf(harness.responseTo(batchId))).toMatchObject({
      ok: false,
      error: { code: "stale_attachment" },
    });
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "browser.remote.detached",
        payload: expect.objectContaining({ reason: "superseded", generation: 1 }),
      }),
    );
  });

  it("drops queued operations of a replaced attachment and rejects its triple", async () => {
    const harness = createHarness();
    const triple = await harness.open();
    const engine = harness.engines[0];
    engine.hold("Page.navigate");
    const first = harness.start({
      type: "browser.remote.navigate.request",
      requestId: nextId("n"),
      ...triple,
      navigation: { kind: "reload" },
    });
    const queuedId = nextId("n");
    const queued = harness.start({
      type: "browser.remote.navigate.request",
      requestId: queuedId,
      ...triple,
      navigation: { kind: "back" },
    });
    await flush();
    await harness.request({
      type: "browser.remote.attach.request",
      requestId: nextId("a"),
      browserId: triple.browserId,
    });
    engine.release("Page.navigate");
    await Promise.all([first, queued]);
    expect(engine.writes.filter((write) => write.method === "Page.navigate")).toHaveLength(1);
    expect(payloadOf(harness.responseTo(queuedId))).toMatchObject({
      ok: false,
      error: { code: "stale_attachment" },
    });
    const stale = await harness.request({
      type: "browser.remote.set_visibility.request",
      requestId: nextId("v"),
      ...triple,
      visible: false,
    });
    expect(payloadOf(stale)).toMatchObject({ ok: false, error: { code: "stale_attachment" } });
  });

  it("never writes the second viewport command after a takeover between them", async () => {
    const harness = createHarness();
    const triple = await harness.open();
    const engine = harness.engines[0];
    engine.hold("Emulation.setDeviceMetricsOverride");
    const resizeId = nextId("r");
    const resize = harness.start({
      type: "browser.remote.resize.request",
      requestId: resizeId,
      ...triple,
      viewport: { ...VIEWPORT, width: 400 },
    });
    await flush();
    await harness.request({
      type: "browser.remote.attach.request",
      requestId: nextId("a"),
      browserId: triple.browserId,
    });
    engine.release("Emulation.setDeviceMetricsOverride");
    await resize;
    expect(
      engine.methods().filter((method) => method === "Emulation.setTouchEmulationEnabled"),
    ).toHaveLength(0);
    expect(payloadOf(harness.responseTo(resizeId))).toMatchObject({ ok: false });
  });

  it("never starts the old screencast after a takeover between stop and start", async () => {
    const harness = createHarness();
    const triple = await harness.open();
    const engine = harness.engines[0];
    await harness.request({
      type: "browser.remote.set_visibility.request",
      requestId: nextId("v"),
      ...triple,
      visible: false,
    });
    const before = engine.writes.length;
    engine.hold("Page.stopScreencast");
    const visible = harness.start({
      type: "browser.remote.set_visibility.request",
      requestId: nextId("v"),
      ...triple,
      visible: true,
    });
    await flush();
    const takeover = harness.start({
      type: "browser.remote.attach.request",
      requestId: nextId("a"),
      browserId: triple.browserId,
    });
    await flush();
    engine.release("Page.stopScreencast");
    await Promise.all([visible, takeover]);
    const starts = engine.writes
      .slice(before)
      .filter((write) => write.method === "Page.startScreencast");
    // Only the new attachment's screencast starts.
    expect(starts).toHaveLength(1);
  });

  it("does not make an attachment ready when revoke lands while it applies the viewport", async () => {
    const harness = createHarness();
    const triple = await harness.open();
    const engine = harness.engines[0];
    await harness.request({
      type: "browser.remote.detach.request",
      requestId: nextId("d"),
      ...triple,
    });
    engine.hold("Emulation.setDeviceMetricsOverride");
    const attachId = nextId("a");
    const attach = harness.start({
      type: "browser.remote.attach.request",
      requestId: attachId,
      browserId: triple.browserId,
      viewport: VIEWPORT,
    });
    await flush();
    const writesBefore = engine.writes.length;
    const revoking = harness.session.revoke();
    harness.setAllowed(false);
    engine.release("Emulation.setDeviceMetricsOverride");
    await Promise.all([attach, revoking]);
    const after = engine.writes.slice(writesBefore).map((write) => write.method);
    expect(after).not.toContain("Emulation.setTouchEmulationEnabled");
    expect(after).not.toContain("Page.startScreencast");
    expect(payloadOf(harness.responseTo(attachId))).toMatchObject({ ok: false });
    expect(engine.closed).toBe(true);
  });

  it("closes only with the current generation when one is expected", async () => {
    const harness = createHarness();
    const triple = await harness.open();
    await harness.request({
      type: "browser.remote.attach.request",
      requestId: nextId("a"),
      browserId: triple.browserId,
    });
    const stale = await harness.request({
      type: "browser.remote.close.request",
      requestId: nextId("c"),
      browserId: triple.browserId,
      expectedGeneration: 1,
    });
    expect(payloadOf(stale)).toMatchObject({ ok: false, error: { code: "stale_attachment" } });
    expect(harness.engines[0].closed).toBe(false);
    const closed = await harness.request({
      type: "browser.remote.close.request",
      requestId: nextId("c"),
      browserId: triple.browserId,
      expectedGeneration: 2,
    });
    expect(payloadOf(closed)).toMatchObject({ ok: true });
    expect(harness.engines[0].closed).toBe(true);
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "browser.remote.closed",
        payload: expect.objectContaining({ reason: "closed" }),
      }),
    );
  });

  it("closes a detached browser after the grace, via detach RPC or generic release", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const harness = createHarness({ detachedTimeoutMs: 1000 });
    const first = await harness.open();
    await harness.request({
      type: "browser.remote.detach.request",
      requestId: nextId("d"),
      ...first,
    });
    const second = await harness.open();
    await harness.delivery.request(
      harness.socket,
      {
        type: "subscription.release.request",
        requestId: nextId("rel"),
        subscriptionId: second.subscriptionId,
      },
      () => harness.delivery.release(second.subscriptionId),
    );
    expect(harness.engines.map((engine) => engine.closed)).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.engines.map((engine) => engine.closed)).toEqual([true, true]);
  });

  it("detaches on socket loss and keeps the page for re-attach within the grace", async () => {
    const harness = createHarness();
    const other = {};
    harness.delivery.attach(other, true);
    const triple = await harness.open();
    await harness.delivery.detach(harness.socket);
    const attach = await harness.request(
      {
        type: "browser.remote.attach.request",
        requestId: nextId("a"),
        browserId: triple.browserId,
      },
      other,
    );
    expect(payloadOf(attach)).toMatchObject({ ok: true, generation: 2 });
    expect(harness.engines[0].closed).toBe(false);
  });

  it("closes browsers whose engine exits and reports the reason", async () => {
    const harness = createHarness();
    await harness.open();
    harness.engines[0].exit("memory_limit");
    await flush();
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "browser.remote.closed",
        payload: expect.objectContaining({ reason: "memory_limit" }),
      }),
    );
  });
});

describe("RemoteBrowserSession frames", () => {
  async function opened(limits: Partial<RemoteBrowserSessionLimits> = {}) {
    const harness = createHarness(limits);
    const triple = await harness.open();
    return { harness, triple, engine: harness.engines[0] };
  }

  function ack(
    triple: { subscriptionId: string; generation: number },
    seq: number,
    generation = triple.generation,
  ) {
    return {
      opcode: RemoteBrowserOpcode.FrameAck,
      subscriptionId: triple.subscriptionId,
      generation,
      seq,
    } as const;
  }

  it("keeps at most the window unacknowledged and withholds Chromium's ack meanwhile", async () => {
    const { harness, triple, engine } = await opened();
    const f0 = engine.emitFrame();
    const f1 = engine.emitFrame();
    const f2 = engine.emitFrame();
    expect(harness.frames.map((frame) => frame.seq)).toEqual([0, 1]);
    expect(engine.released).toEqual([f0, f1]);
    await harness.session.handleFrameAck(ack(triple, 0), harness.socket);
    expect(harness.frames.map((frame) => frame.seq)).toEqual([0, 1, 2]);
    expect(engine.released).toEqual([f0, f1, f2]);
  });

  it("treats ack violations by kind", async () => {
    const { harness, triple, engine } = await opened();
    engine.emitFrame();
    await expect(harness.session.handleFrameAck(ack(triple, 0), {})).rejects.toBeInstanceOf(
      TunnelProtocolError,
    );
    await expect(
      harness.session.handleFrameAck(
        { ...ack(triple, 0), subscriptionId: "88888888-8888-4888-8888-888888888888" },
        harness.socket,
      ),
    ).rejects.toBeInstanceOf(TunnelProtocolError);
    await harness.session.handleFrameAck(ack(triple, 7), harness.socket);
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "browser.remote.detached",
        payload: expect.objectContaining({ reason: "protocol_error" }),
      }),
    );
    // The retired subscription is tombstoned: late acks are ignored.
    await expect(
      harness.session.handleFrameAck(ack(triple, 0), harness.socket),
    ).resolves.toBeUndefined();
  });

  it("detaches on a stale generation ack", async () => {
    const { harness, triple, engine } = await opened();
    engine.emitFrame();
    await harness.session.handleFrameAck(ack(triple, 0, 9), harness.socket);
    expect(harness.messages.some((message) => message.type === "browser.remote.detached")).toBe(
      true,
    );
  });

  it("pauses the ack deadline while hidden and restarts it in full when visible", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { harness, triple, engine } = await opened({ frameAckTimeoutMs: 1000 });
    engine.emitFrame();
    await vi.advanceTimersByTimeAsync(900);
    await harness.request({
      type: "browser.remote.set_visibility.request",
      requestId: nextId("v"),
      ...triple,
      visible: false,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(harness.messages.some((message) => message.type === "browser.remote.detached")).toBe(
      false,
    );
    await harness.request({
      type: "browser.remote.set_visibility.request",
      requestId: nextId("v"),
      ...triple,
      visible: true,
    });
    await vi.advanceTimersByTimeAsync(900);
    expect(harness.messages.some((message) => message.type === "browser.remote.detached")).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "browser.remote.detached",
        payload: expect.objectContaining({ reason: "protocol_error" }),
      }),
    );
  });

  it("drops oversized frames, steps quality and scale down, then ends at the floor", async () => {
    const { harness, engine } = await opened({ maxFrameBytes: 64 });
    // Quality 60→30 takes 3 frames, scale 1→0.5 takes 3, then 3 more at both floors.
    for (let index = 0; index < 9; index += 1) {
      engine.emitFrame({ bytes: 200 });
      await flush();
    }
    expect(harness.frames).toHaveLength(0);
    expect(engine.released).toHaveLength(9);
    const starts = engine.writes
      .filter((write) => write.method === "Page.startScreencast")
      .map((write) => write.params as ScreencastParams);
    expect(Math.min(...starts.map((start) => start.quality))).toBe(30);
    expect(Math.max(...starts.map((start) => start.maxWidth))).toBeLessThanOrEqual(780);
    expect(starts.at(-1)?.maxWidth).toBe(Math.floor(390 * 2 * 0.5));
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "browser.remote.detached",
        payload: expect.objectContaining({ reason: "resource_limit" }),
      }),
    );
  });

  it("drops frames above the raster ceiling", async () => {
    const { harness, engine } = await opened();
    engine.emitFrame({ width: 1921, height: 100 });
    expect(harness.frames).toHaveLength(0);
  });
});

describe("RemoteBrowserSession state", () => {
  it("coalesces state floods and keeps every message within the byte budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const harness = createHarness();
    await harness.open();
    const engine = harness.engines[0];
    for (let index = 0; index < 1000; index += 1) {
      engine.setState({
        title: `${'😀\u0001"'.repeat(400)}${index}`,
        url: `http://x/${"\\".repeat(9000)}`,
      });
      if (index % 100 === 0) await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(200);
    const states = harness.messages.filter((message) => message.type === "browser.remote.state");
    expect(states.length).toBeLessThanOrEqual(4);
    for (const message of states) {
      expect(Buffer.byteLength(JSON.stringify(message), "utf8")).toBeLessThanOrEqual(
        REMOTE_BROWSER_MAX_STATE_BYTES,
      );
      expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it("bounds attach and list replies for hostile pages", async () => {
    const harness = createHarness();
    const triple = await harness.open();
    harness.engines[0].setState({
      title: "😀".repeat(5000),
      url: `http://x/${"\u0002".repeat(20000)}`,
      error: { code: "failed", url: "\u0003".repeat(20000), message: '"'.repeat(5000) },
    });
    const attach = await harness.request({
      type: "browser.remote.attach.request",
      requestId: nextId("a"),
      browserId: triple.browserId,
    });
    expect(Buffer.byteLength(JSON.stringify(attach), "utf8")).toBeLessThanOrEqual(
      REMOTE_BROWSER_MAX_STATE_BYTES + 2048,
    );
    expect(SessionOutboundMessageSchema.safeParse(attach).success).toBe(true);
    const list = await harness.request({
      type: "browser.remote.list.request",
      requestId: nextId("l"),
    });
    expect(SessionOutboundMessageSchema.safeParse(list).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(list), "utf8")).toBeLessThanOrEqual(
      REMOTE_BROWSER_MAX_STATE_BYTES * 2,
    );
  });
});

describe("RemoteBrowserSession focus", () => {
  const field = (focusId: number) => ({
    inputMode: "",
    inputType: "text",
    enterKeyHint: "",
    focusId,
    composing: false,
  });

  it("writes focus-guarded composition only while that field is focused", async () => {
    const harness = createHarness();
    const triple = await harness.open();
    const engine = harness.engines[0];
    engine.setState({ focusedEditable: field(1) });
    const ok = await harness.request({
      type: "browser.remote.dispatch_input.request",
      requestId: nextId("i"),
      ...triple,
      events: [{ kind: "composition", text: "ol", selectionStart: 2, selectionEnd: 2, focusId: 1 }],
    });
    expect(payloadOf(ok)).toMatchObject({ ok: true, dispatched: 1 });
    // A page script moved focus to another field of the same type.
    engine.setState({ focusedEditable: field(2) });
    const before = engine.methods().filter((method) => method === "Input.imeSetComposition").length;
    const moved = await harness.request({
      type: "browser.remote.dispatch_input.request",
      requestId: nextId("i"),
      ...triple,
      events: [
        { kind: "composition", text: "olá", selectionStart: 3, selectionEnd: 3, focusId: 1 },
        { kind: "text", text: "olá", focusId: 1 },
      ],
    });
    expect(payloadOf(moved)).toMatchObject({ ok: false, error: { code: "focus_changed" } });
    expect(engine.methods().filter((method) => method === "Input.imeSetComposition")).toHaveLength(
      before,
    );
    expect(engine.methods()).not.toContain("Input.insertText");
  });

  it("probes focus while visible at a bounded rate, and stops when hidden or ended", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const harness = createHarness({ focusPollMs: 300 });
    const triple = await harness.open();
    const engine = harness.engines[0];
    await vi.advanceTimersByTimeAsync(3000);
    expect(engine.focusProbes).toBeGreaterThanOrEqual(9);
    expect(engine.focusProbes).toBeLessThanOrEqual(11);
    await harness.request({
      type: "browser.remote.set_visibility.request",
      requestId: nextId("v"),
      ...triple,
      visible: false,
    });
    const hidden = engine.focusProbes;
    await vi.advanceTimersByTimeAsync(3000);
    expect(engine.focusProbes).toBe(hidden);
    await harness.request({
      type: "browser.remote.set_visibility.request",
      requestId: nextId("v"),
      ...triple,
      visible: true,
    });
    await harness.request({
      type: "browser.remote.detach.request",
      requestId: nextId("d"),
      ...triple,
    });
    const detached = engine.focusProbes;
    await vi.advanceTimersByTimeAsync(3000);
    expect(engine.focusProbes).toBe(detached);
  });
});
