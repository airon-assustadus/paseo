import { page } from "@vitest/browser/context";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type TestContext,
} from "vitest";
import {
  createFixtureTransport,
  FIXTURE_BIG_BODY_BYTES,
  FIXTURE_DESTINATION_ORIGIN,
  type FixtureIndex,
  type FixtureTransport,
} from "./__fixtures__/fixture-transport";
import { HARNESS, harnessContentOrigin } from "./__fixtures__/shell/harness";
import { DEFAULT_BRIDGE_LIMITS, createLifecycleToken } from "./bridge-messages";
import {
  attachWebProxyBroker,
  WebProxyBrokerSetupError,
  type WebProxyBroker,
  type WebProxyBrokerState,
  type WebProxyPurgeOutcome,
} from "./broker.web";

// Control = this test page on "localhost"; content = "wp-a.localhost"; adversary =
// "wp-b.localhost". Separate origins on one server: this proves origin checks and forwarding,
// not site isolation, Brave's partitioning or a physical Android device.
const CONTENT_A = harnessContentOrigin("wp-a", location);
const CONTENT_B = harnessContentOrigin("wp-b", location);
const SLOW = { timeout: 15_000, interval: 50 };

interface ReceivedMessage {
  origin: string;
  data: unknown;
}

let received: ReceivedMessage[] = [];
let container: HTMLDivElement;
let mounted: WebProxyBroker[] = [];

function record(event: MessageEvent): void {
  received.push({ origin: event.origin, data: event.data });
}

function typeOf(data: unknown): unknown {
  return typeof data === "object" && data !== null && "type" in data ? data.type : null;
}

function messagesOf(origin: string, type: string): unknown[] {
  return received
    .filter((message) => message.origin === origin && typeOf(message.data) === type)
    .map((message) => message.data);
}

async function waitForMessages(origin: string, type: string, count: number): Promise<unknown[]> {
  return vi.waitFor(() => {
    const matching = messagesOf(origin, type);
    if (matching.length < count) throw new Error(`waiting for ${count} × ${type} from ${origin}`);
    return matching;
  }, SLOW);
}

function mount(input: {
  index: FixtureIndex;
  bootstrapPath?: string;
  handshakeTimeoutMs?: number;
  contentOrigin?: string;
}): { broker: WebProxyBroker; transport: FixtureTransport; states: WebProxyBrokerState[] } {
  const transport = createFixtureTransport({ index: input.index });
  const states: WebProxyBrokerState[] = [];
  const broker = attachWebProxyBroker({
    capability: {
      contentOrigin: input.contentOrigin ?? CONTENT_A,
      destinationOrigin: FIXTURE_DESTINATION_ORIGIN,
      pathPrefix: "/",
    },
    transport,
    container,
    bootstrapPath: input.bootstrapPath ?? HARNESS.bootstrapPath,
    handshakeTimeoutMs: input.handshakeTimeoutMs ?? 10_000,
    onStateChange: (state) => states.push(state),
  });
  mounted.push(broker);
  return { broker, transport, states };
}

function buttonPosition(report: unknown): { x: number; y: number } {
  if (typeof report !== "object" || report === null || !("button" in report)) {
    throw new Error("report without a button position");
  }
  const { button } = report;
  if (typeof button !== "object" || button === null || !("x" in button) || !("y" in button)) {
    throw new Error("malformed button position");
  }
  const { x, y } = button;
  if (typeof x !== "number" || typeof y !== "number") throw new Error("malformed button position");
  return { x, y };
}

function currentFrame(broker: WebProxyBroker): HTMLIFrameElement {
  const frame = broker.getFrame();
  if (frame === null) throw new Error("broker has no frame in this generation");
  return frame;
}

function requestedUrls(transport: FixtureTransport): string[] {
  return transport.requests.map((request) => request.url);
}

// Lifecycle updates republish a granted state; each generation is granted once.
function grantedGenerations(states: WebProxyBrokerState[]): number[] {
  const granted = states.filter((state) => state.status === "granted");
  return [...new Set(granted.map((state) => state.generation))];
}

function appendFrame(src: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.src = src;
  container.append(frame);
  return frame;
}

beforeAll(() => {
  expect(location.hostname).toBe("localhost");
});

beforeEach(() => {
  received = [];
  window.addEventListener("message", record);
  container = document.createElement("div");
  const sizing = document.createElement("style");
  sizing.textContent = "iframe { width: 800px; height: 600px; }";
  container.append(sizing);
  document.body.append(container);
});

afterEach(() => {
  for (const broker of mounted) broker.dispose();
  mounted = [];
  window.removeEventListener("message", record);
  container.remove();
});

describe("web proxy broker and shell", () => {
  it("renders a known app as local DOM through the bridge, within the capability", async () => {
    const { broker, transport, states } = mount({ index: "app" });

    const [report] = await waitForMessages(CONTENT_A, "fixture.report", 1);
    expect(report).toEqual({
      type: "fixture.report",
      heading: "Fixture app",
      headingRendered: true,
      status: "script-ran",
      color: "rgb(1, 2, 3)",
      echoStatus: 200,
      echo: "POST ?q=1 hello bridge",
      echoSetCookie: null,
      echoHsts: null,
      cookie: "",
      topAccess: "SecurityError",
      escape: "blocked",
      redirect: { path: `${HARNESS.mountPath}new`, text: "redirected" },
      cross: { status: 502, code: "redirect_blocked" },
      bigBytes: FIXTURE_BIG_BODY_BYTES,
      button: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    });

    // A real pointer click from the browser, aimed at the button inside the proxied document.
    // Vitest's frame locator enters one frame level; the app frame is clicked at the position
    // the app reported for its own button.
    const shell = page.frameLocator(page.elementLocator(currentFrame(broker)));
    const position = buttonPosition(report);
    await shell.getByTestId("paseo-web-proxy-app").click({ position });
    expect(await waitForMessages(CONTENT_A, "fixture.clicked", 1)).toEqual([
      { type: "fixture.clicked", count: 1, echo: "POST ?click=1 click" },
    ]);

    // The app re-sent hello from the bootstrap's realm and its own: one grant only.
    expect(grantedGenerations(states)).toEqual([1]);
    expect(broker.getState()).toMatchObject({ status: "granted", generation: 1 });
    // The shell accepted the lifecycle and armed its worker on the side port.
    await vi.waitFor(
      () => expect(broker.getState()).toMatchObject({ lifecycle: "ready", workerArmed: true }),
      SLOW,
    );

    // Subresources race each other through the worker; the set is what the app asked for.
    const paths = transport.requests.map((request) => new URL(request.url).pathname);
    expect(paths.toSorted()).toEqual(
      [
        "/",
        "/style.css",
        "/app.js",
        "/api/echo",
        "/old",
        "/new",
        "/cross",
        "/big",
        // The click posts once more.
        "/api/echo",
      ].toSorted(),
    );
    for (const request of transport.requests) {
      expect(request.url.startsWith(`${FIXTURE_DESTINATION_ORIGIN}/`)).toBe(true);
      expect(request.initiator.boundOrigin).toBe(FIXTURE_DESTINATION_ORIGIN);
      expect(request.initiator.generation).toBe(1);
      const names = request.headers.map(([name]) => name);
      const leaked = names.filter(
        (name) => ["cookie", "origin", "referer", "host"].includes(name) || name.startsWith("sec-"),
      );
      expect(leaked).toEqual([]);
    }
    const byPath = new Map(
      transport.requests.map((request) => [new URL(request.url).pathname, request]),
    );
    expect(byPath.get("/")?.initiator.mode).toBe("navigate");
    const echo = transport.requests.find((request) => request.url.endsWith("/api/echo?q=1"));
    expect(echo?.bodyText).toBe("hello bridge");
  }, 30_000);

  it("serves the app's own frame chain, refuses frames outside it and keeps the destination's CSP", async () => {
    const { transport } = mount({ index: "framing" });

    // A new frame created by the app has no observable initiator: refused before the transport.
    expect(await waitForMessages(CONTENT_A, "fixture.child", 1)).toEqual([
      { type: "fixture.child", text: "Paseo web proxy: client_not_admitted" },
    ]);
    // The app navigating itself keeps its session (C → K → K); img-src 'none' still applies.
    const [own] = await waitForMessages(CONTENT_A, "fixture.framed", 1);
    expect(own).toEqual({ type: "fixture.framed", via: "self", blocked: "img-src" });

    // C → wp-b → K: a frame placed by a foreign page never reaches the transport.
    const target = `${CONTENT_A}${HARNESS.mountPath}framed?via=foreign`;
    const relay = `${CONTENT_B}${HARNESS.shellPathPrefix}relay.html?target=${encodeURIComponent(target)}`;
    appendFrame(relay);
    // Absence can only be observed by waiting; a served page reports within milliseconds.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(messagesOf(CONTENT_A, "fixture.framed")).toEqual([own]);
    const urls = requestedUrls(transport);
    expect(urls.filter((url) => url.includes("via=foreign") || url.includes("via=child"))).toEqual(
      [],
    );
    expect(urls.map((url) => new URL(url).pathname)).not.toContain("/pixel.png");
  }, 30_000);

  it("routes two views of one destination to their own transports, also after one is revoked", async () => {
    const first = mount({ index: "app" });
    const second = mount({ index: "app" });
    const reports = await waitForMessages(CONTENT_A, "fixture.report", 2);
    for (const view of [first, second]) {
      const paths = view.transport.requests.map((request) => new URL(request.url).pathname);
      expect(paths.filter((path) => path === "/app.js")).toEqual(["/app.js"]);
    }

    first.broker.revoke("disposed");
    const firstCount = first.transport.requests.length;
    const shell = page.frameLocator(page.elementLocator(currentFrame(second.broker)));
    await shell.getByTestId("paseo-web-proxy-app").click({ position: buttonPosition(reports[0]) });
    expect(await waitForMessages(CONTENT_A, "fixture.clicked", 1)).toEqual([
      { type: "fixture.clicked", count: 1, echo: "POST ?click=1 click" },
    ]);
    expect(requestedUrls(second.transport)).toContain(
      `${FIXTURE_DESTINATION_ORIGIN}/api/echo?click=1`,
    );
    expect(first.transport.requests).toHaveLength(firstCount);
  }, 45_000);

  it("refuses the control origin as content origin before creating a frame or a port", () => {
    const transport = createFixtureTransport({ index: "app" });
    expect(() =>
      attachWebProxyBroker({
        capability: {
          contentOrigin: location.origin,
          destinationOrigin: FIXTURE_DESTINATION_ORIGIN,
          pathPrefix: "/",
        },
        transport,
        container,
        bootstrapPath: HARNESS.bootstrapPath,
        handshakeTimeoutMs: 1_000,
      }),
    ).toThrow(new WebProxyBrokerSetupError("content_origin_is_control"));
    expect(container.querySelector("iframe")).toBeNull();
    expect(transport.requests).toEqual([]);
  });

  it("fails with handshake_timeout when the bootstrap origin never answers", async () => {
    const states: WebProxyBrokerState[] = [];
    const broker = attachWebProxyBroker({
      // Nothing listens on port 9 of the loopback: the frame never runs a bootstrap.
      capability: {
        contentOrigin: "http://wp-a.localhost:9",
        destinationOrigin: FIXTURE_DESTINATION_ORIGIN,
        pathPrefix: "/",
      },
      transport: createFixtureTransport({ index: "app" }),
      container,
      bootstrapPath: HARNESS.bootstrapPath,
      handshakeTimeoutMs: 2_000,
      onStateChange: (state) => states.push(state),
    });
    mounted.push(broker);
    await vi.waitFor(
      () =>
        expect(broker.getState()).toEqual({
          status: "failed",
          generation: 1,
          reason: "handshake_timeout",
        }),
      SLOW,
    );
    expect(grantedGenerations(states)).toEqual([]);
    expect(broker.getFrame()).toBeNull();
  }, 30_000);

  it("ignores hellos from another origin and from another frame of the content origin", async () => {
    const { broker, transport } = mount({
      index: "app",
      bootstrapPath: `${HARNESS.shellPathPrefix}silent.html`,
      handshakeTimeoutMs: 6_000,
    });
    await vi.waitFor(() => expect(broker.getState().status).toBe("awaiting_hello"), SLOW);

    appendFrame(`${CONTENT_B}${HARNESS.shellPathPrefix}hostile.html`);
    appendFrame(`${CONTENT_A}${HARNESS.shellPathPrefix}hostile.html`);
    await waitForMessages(CONTENT_B, "fixture.hostile.sent", 1);
    await waitForMessages(CONTENT_A, "fixture.hostile.sent", 1);

    expect(broker.getState()).toEqual({ status: "awaiting_hello", generation: 1 });
    await vi.waitFor(
      () =>
        expect(broker.getState()).toEqual({
          status: "failed",
          generation: 1,
          reason: "handshake_timeout",
        }),
      SLOW,
    );
    expect(transport.requests).toEqual([]);
  }, 30_000);

  it("refuses to start a session when its parent is not the configured control origin", async () => {
    // The harness derives the control origin by dropping the first label, so this bootstrap
    // expects "wp-a.localhost" as its parent while it is framed by "localhost".
    const foreign = `${location.protocol}//foreign.wp-a.${location.hostname}:${location.port}`;
    const frame = appendFrame(`${foreign}${HARNESS.bootstrapPath}`);
    const bootstrap = page.frameLocator(page.elementLocator(frame));
    // expect.element reads the DOM from this page, which cannot see into a cross-origin frame.
    // A provider-side action can: it fails unless the text is there and visible.
    await bootstrap.getByText("no_session").click();
    expect(received.filter((message) => typeOf(message.data) === "paseo.web.hello")).toEqual([]);
  }, 30_000);

  it("ends the grant when the content navigates its own top frame", async () => {
    const { broker, transport, states } = mount({ index: "navigate-parent" });
    await vi.waitFor(
      () =>
        expect(broker.getState()).toEqual({
          status: "revoked",
          generation: 1,
          reason: "frame_navigated",
        }),
      SLOW,
    );
    expect(broker.getFrame()).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(grantedGenerations(states)).toEqual([1]);
    expect(broker.getState().status).toBe("revoked");
    expect(transport.requests.map((request) => new URL(request.url).pathname)).toEqual(["/"]);
  }, 30_000);

  it("aborts the host request and removes the frame on revocation", async () => {
    const { broker, transport } = mount({ index: "hang" });
    await transport.waitForHangRequest();
    broker.revoke("disposed");
    await transport.waitForHangAbort();
    expect(broker.getState()).toEqual({ status: "revoked", generation: 1, reason: "disposed" });
    expect(broker.getFrame()).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  }, 30_000);

  it("answers bridge_timeout to the page and cancels the host request when no head arrives", async () => {
    const { broker, transport } = mount({ index: "hang" });
    const [result] = await waitForMessages(CONTENT_A, "fixture.hang", 1);
    expect(result).toEqual({ type: "fixture.hang", status: 504, code: "bridge_timeout" });
    await transport.waitForHangAbort();
    expect(broker.getState()).toMatchObject({ status: "granted", generation: 1 });
  }, 30_000);

  it("hands out a new generation on reopen and never reuses the previous port", async () => {
    const { broker, transport, states } = mount({ index: "app" });
    await waitForMessages(CONTENT_A, "fixture.report", 1);
    broker.revoke("disposed");
    broker.reopen();
    await waitForMessages(CONTENT_A, "fixture.report", 2);
    expect(grantedGenerations(states)).toEqual([1, 2]);
    const generations = new Set(transport.requests.map((request) => request.initiator.generation));
    expect(generations).toEqual(new Set([1, 2]));
    const last = transport.requests.at(-1);
    expect(last?.initiator.generation).toBe(2);
  }, 45_000);
});

describe("web proxy broker lifecycle", () => {
  const SCRIPTED = `${HARNESS.shellPathPrefix}scripted.html`;
  const DEADLINE_MS = 2000;

  interface ScriptedReport {
    type: "fixture.scripted";
    event: string;
    port?: string;
    data?: Record<string, unknown>;
  }

  function scripted(query: Record<string, string> = {}) {
    const params = new URLSearchParams(query).toString();
    const view = mount({
      index: "app",
      bootstrapPath: params === "" ? SCRIPTED : `${SCRIPTED}?${params}`,
      handshakeTimeoutMs: DEADLINE_MS,
    });
    return { ...view, candidate: createFixtureTransport({ index: "app" }) };
  }

  function reports(): ScriptedReport[] {
    return messagesOf(CONTENT_A, "fixture.scripted").filter(
      (data): data is ScriptedReport => typeof data === "object" && data !== null,
    );
  }

  function sideMessages(): Record<string, unknown>[] {
    return reports().flatMap((report) =>
      report.event === "side" && report.data !== undefined ? [report.data] : [],
    );
  }

  async function ready(broker: WebProxyBroker): Promise<void> {
    await vi.waitFor(() => expect(broker.getState()).toMatchObject({ lifecycle: "ready" }), SLOW);
  }

  async function suspended(broker: WebProxyBroker): Promise<void> {
    await ready(broker);
    expect(broker.suspend("channel_lost")).toBe(true);
  }

  function signalAck(broker: WebProxyBroker): void {
    currentFrame(broker).contentWindow?.postMessage({ type: "fixture.scripted.ack" }, CONTENT_A);
  }

  it("fences synchronously, keeps the frame without input and tells the shell", async () => {
    const { broker, transport } = scripted();
    await suspended(broker);
    expect(broker.getState()).toMatchObject({
      status: "suspended",
      generation: 1,
      reason: "channel_lost",
      lastResumeFailure: null,
    });
    const frame = currentFrame(broker);
    expect(frame.isConnected).toBe(true);
    expect(frame.inert).toBe(true);
    await vi.waitFor(() => expect(broker.getState()).toMatchObject({ documentKept: true }), SLOW);
    expect(sideMessages()).toEqual([
      {
        type: "paseo.web.lifecycle.ready",
        v: 1,
        generation: 1,
        offer: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      },
      // Asked once after ready (lifecycle contract §5.9); the shell answers, it never announces.
      {
        type: "paseo.web.purge.query",
        v: 1,
        nonce: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      },
      { type: "paseo.web.suspend", v: 1, generation: 1, reason: "channel_lost" },
    ]);
    expect(broker.suspend("expired")).toBe(false);
    expect(transport.requests).toEqual([]);
  }, 30_000);

  it("marks the lifecycle unavailable when the shell ignores the offer, and suspend refuses", async () => {
    const { broker } = scripted({ lifecycle: "ignore" });
    await vi.waitFor(
      () =>
        expect(broker.getState()).toMatchObject({ status: "granted", lifecycle: "unavailable" }),
      SLOW,
    );
    expect(broker.suspend("channel_lost")).toBe(false);
    broker.revoke("transport_closed");
    expect(broker.getState()).toEqual({
      status: "revoked",
      generation: 1,
      reason: "transport_closed",
    });
    expect(broker.getFrame()).toBeNull();
  }, 30_000);

  it("resumes on the candidate transport, which only serves after the acknowledgement", async () => {
    const { broker, transport, candidate, states } = scripted({ afterAck: "request" });
    await suspended(broker);
    expect(await broker.resume({ transport: candidate })).toEqual({
      kind: "resumed",
      previous: 1,
      generation: 2,
      documentPreserved: true,
    });
    expect(broker.getState()).toMatchObject({ status: "granted", generation: 2 });
    expect(currentFrame(broker).inert).toBe(false);
    expect(states.some((state) => state.status === "resuming")).toBe(true);
    await vi.waitFor(() => expect(candidate.requests).toHaveLength(1), SLOW);
    expect(candidate.requests[0]?.initiator.generation).toBe(2);
    expect(transport.requests).toEqual([]);
    expect(sideMessages().at(-1)).toMatchObject({
      type: "paseo.web.resume",
      previous: 1,
      generation: 2,
    });

    // A loss after the success point is a new suspension, not a failed resume.
    expect(broker.suspend("channel_lost")).toBe(true);
    expect(broker.getState()).toMatchObject({
      status: "suspended",
      generation: 2,
      lastResumeFailure: null,
    });
  }, 30_000);

  it("ends suspended on the new generation when the candidate is lost before the acknowledgement", async () => {
    const { broker, candidate, states } = scripted({ ackOn: "signal", afterAck: "request" });
    await suspended(broker);
    const result = broker.resume({ transport: candidate });
    expect(broker.getState()).toMatchObject({ status: "resuming", previous: 1, generation: 2 });
    expect(broker.suspend("expired")).toBe(true);
    expect(broker.getState()).toMatchObject({ status: "resuming" });
    signalAck(broker);

    expect(await result).toEqual({ kind: "failed", reason: "transport_lost" });
    expect(broker.getState()).toMatchObject({
      status: "suspended",
      generation: 2,
      reason: "expired",
      lastResumeFailure: "transport_lost",
    });
    expect(grantedGenerations(states)).toEqual([1]);
    expect(currentFrame(broker).inert).toBe(true);
    await vi.waitFor(
      () =>
        expect(reports()).toContainEqual({
          type: "fixture.scripted",
          event: "received",
          port: "resumed",
          data: expect.objectContaining({ type: "paseo.web.response.head", status: 204 }),
        }),
      SLOW,
    );
    expect(candidate.requests).toEqual([]);
    expect(sideMessages().at(-1)).toEqual({
      type: "paseo.web.suspend",
      v: 1,
      generation: 2,
      reason: "expired",
    });
  }, 30_000);

  it.each([
    { ack: "request-first", cause: "ack_invalid", reason: "protocol_error" },
    { ack: "wrong-generation", cause: "ack_invalid", reason: "protocol_error" },
    { ack: "wrong-previous", cause: "ack_invalid", reason: "protocol_error" },
    { ack: "silent", cause: "ack_timeout", reason: "protocol_error" },
  ] as const)(
    "ends the view on an acknowledgement that is $ack",
    async ({ ack, cause, reason }) => {
      const { broker, candidate } = scripted({ ack });
      await suspended(broker);
      expect(await broker.resume({ transport: candidate })).toEqual({
        kind: "failed",
        reason: cause,
      });
      expect(broker.getState()).toEqual({ status: "revoked", generation: 1, reason, cause });
      expect(broker.getFrame()).toBeNull();
      expect(candidate.requests).toEqual([]);
    },
    30_000,
  );

  // Measured on Playwright's Chromium headless shell 1208: a port closed by the shell does not
  // dispatch "close" on the broker's end, so the deadline ends the view instead.
  it("ends the view when the shell closes the new port instead of acknowledging", async () => {
    const { broker, candidate } = scripted({ ack: "close" });
    await suspended(broker);
    const result = await broker.resume({ transport: candidate });
    if (result.kind !== "failed") throw new Error("a closed port must not resume");
    const wireReason = result.reason === "ack_port_closed" ? "port_closed" : "protocol_error";
    expect(["ack_port_closed", "ack_timeout"]).toContain(result.reason);
    expect(broker.getState()).toEqual({
      status: "revoked",
      generation: 1,
      reason: wireReason,
      cause: result.reason,
    });
    expect(candidate.requests).toEqual([]);
  }, 30_000);

  it("ends the view on a second acknowledgement and on one sent on the old port", async () => {
    const duplicate = scripted({ ack: "duplicate" });
    await suspended(duplicate.broker);
    expect(await duplicate.broker.resume({ transport: duplicate.candidate })).toMatchObject({
      kind: "resumed",
    });
    await vi.waitFor(
      () =>
        expect(duplicate.broker.getState()).toEqual({
          status: "revoked",
          generation: 2,
          reason: "protocol_error",
        }),
      SLOW,
    );

    const oldPort = scripted({ ack: "old-port" });
    await suspended(oldPort.broker);
    expect(await oldPort.broker.resume({ transport: oldPort.candidate })).toEqual({
      kind: "failed",
      reason: "terminal",
    });
    expect(oldPort.broker.getState()).toEqual({
      status: "revoked",
      generation: 1,
      reason: "protocol_error",
    });
  }, 30_000);

  it("settles a pending resume as terminal on revoke and on dispose", async () => {
    const revoked = scripted({ ackOn: "signal" });
    await suspended(revoked.broker);
    const result = revoked.broker.resume({ transport: revoked.candidate });
    revoked.broker.revoke("disposed");
    expect(await result).toEqual({ kind: "failed", reason: "terminal" });
    expect(revoked.broker.getState()).toEqual({
      status: "revoked",
      generation: 1,
      reason: "disposed",
    });
    expect(revoked.broker.getFrame()).toBeNull();

    const disposed = scripted({ ackOn: "signal" });
    await suspended(disposed.broker);
    const pending = disposed.broker.resume({ transport: disposed.candidate });
    disposed.broker.dispose();
    expect(await pending).toEqual({ kind: "failed", reason: "terminal" });
    expect(disposed.candidate.requests).toEqual([]);
  }, 30_000);

  it("refuses to resume outside suspended and revokes a suspended view at once", async () => {
    const { broker, candidate } = scripted();
    await ready(broker);
    expect(await broker.resume({ transport: candidate })).toEqual({
      kind: "failed",
      reason: "not_suspended",
    });
    expect(broker.suspend("channel_lost")).toBe(true);
    broker.reopen();
    expect(broker.getState()).toMatchObject({ status: "suspended" });
    broker.revoke("transport_closed");
    expect(broker.getState()).toEqual({
      status: "revoked",
      generation: 1,
      reason: "transport_closed",
    });
    expect(container.querySelector("iframe")).toBeNull();
  }, 30_000);
});

describe("web proxy lifecycle through the real shell", () => {
  interface Point {
    x: number;
    y: number;
  }

  interface LifecycleReport {
    kind: string;
    page: string;
    identity: string;
    note: string;
    focused: string | null;
    press: Point;
    notePosition: Point;
    text?: string;
  }

  function isLifecycleReport(data: unknown): data is LifecycleReport {
    return typeof data === "object" && data !== null && "kind" in data && "identity" in data;
  }

  function lifecycleReports(): LifecycleReport[] {
    return messagesOf(CONTENT_A, "fixture.lifecycle").filter(isLifecycleReport);
  }

  function reportsOfKind(kind: string, pageName?: string): LifecycleReport[] {
    return lifecycleReports().filter(
      (report) => report.kind === kind && (pageName === undefined || report.page === pageName),
    );
  }

  async function nextReport(kind: string, pageName?: string): Promise<LifecycleReport> {
    const seen = reportsOfKind(kind, pageName).length;
    return vi.waitFor(() => {
      const report = reportsOfKind(kind, pageName)[seen];
      if (report === undefined) throw new Error(`waiting for a ${kind} report`);
      return report;
    }, SLOW);
  }

  async function firstReport(kind: string, pageName: string): Promise<LifecycleReport> {
    return vi.waitFor(() => {
      const [report] = reportsOfKind(kind, pageName);
      if (report === undefined) throw new Error(`waiting for a ${kind} report of ${pageName}`);
      return report;
    }, SLOW);
  }

  // The app frame is the shell's only frame; a cross-origin window still exposes its frames.
  function command(broker: WebProxyBroker, name: string, extra: Record<string, string> = {}) {
    const app = currentFrame(broker).contentWindow?.frames[0];
    if (app === undefined) throw new Error("the shell has no app frame");
    app.postMessage({ type: "fixture.lifecycle.command", name, ...extra }, CONTENT_A);
  }

  async function probe(broker: WebProxyBroker): Promise<LifecycleReport> {
    const next = nextReport("probe");
    command(broker, "probe");
    return next;
  }

  function pathsOf(transport: FixtureTransport): string[] {
    return transport.requests.map((request) => new URL(request.url).pathname);
  }

  async function waitForPath(transport: FixtureTransport, path: string): Promise<void> {
    await vi.waitFor(() => expect(pathsOf(transport)).toContain(path), SLOW);
  }

  async function loaded(bootstrapPath?: string) {
    const view = mount({ index: "lifecycle", bootstrapPath });
    const first = await firstReport("loaded", "A");
    await vi.waitFor(
      () => expect(view.broker.getState()).toMatchObject({ lifecycle: "ready", workerArmed: true }),
      SLOW,
    );
    return { ...view, first };
  }

  async function typed(broker: WebProxyBroker, text: string): Promise<void> {
    const next = nextReport("type");
    command(broker, "type", { text });
    expect(await next).toMatchObject({ note: text, focused: "note" });
  }

  function clickApp(broker: WebProxyBroker, position: Point): Promise<void> {
    const shell = page.frameLocator(page.elementLocator(currentFrame(broker)));
    return shell.getByTestId("paseo-web-proxy-app").click({ position, force: true });
  }

  async function settle(ms = 500): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("P1: keeps the document, its text and focus when a protected link loses its head", async () => {
    const { broker, transport, first: loadedPage } = await loaded();
    await typed(broker, "kept text");
    command(broker, "link");
    await waitForPath(transport, "/hold");
    // The harness worker's head deadline is 2 s; armed, it answers 204 and says so.
    await vi.waitFor(
      () =>
        expect(broker.getState()).toMatchObject({
          navigationDrops: { head_timeout: 1, transport_closed: 0, suspended: 0 },
        }),
      SLOW,
    );
    expect(await probe(broker)).toMatchObject({
      page: "A",
      identity: loadedPage.identity,
      note: "kept text",
      focused: "note",
    });
    expect(pathsOf(transport).filter((path) => path === "/hold")).toHaveLength(1);
  }, 45_000);

  it("P1/P3: keeps the document over a suspended form POST and resumes without a replay", async () => {
    const { broker, transport, first: loadedPage } = await loaded();
    await typed(broker, "before loss");
    command(broker, "post");
    await waitForPath(transport, "/hold-post");
    const beforeLoss = transport.requests.length;

    expect(broker.suspend("channel_lost")).toBe(true);
    await vi.waitFor(() => expect(broker.getState()).toMatchObject({ documentKept: true }), SLOW);
    expect(await probe(broker)).toMatchObject({
      page: "A",
      identity: loadedPage.identity,
      note: "before loss",
    });

    const candidate = createFixtureTransport({ index: "lifecycle" });
    expect(await broker.resume({ transport: candidate })).toEqual({
      kind: "resumed",
      previous: 1,
      generation: 2,
      documentPreserved: true,
    });
    const fetched = nextReport("fetched");
    command(broker, "fetch", { path: "api/echo?after=resume" });
    expect((await fetched).text).toMatch(/^GET \?after=resume/);
    expect(await probe(broker)).toMatchObject({ identity: loadedPage.identity });

    expect(transport.requests).toHaveLength(beforeLoss);
    expect(candidate.requests.map((request) => request.initiator.generation)).toEqual([2]);
    expect(pathsOf(candidate)).not.toContain("/");
    const posts = [...pathsOf(transport), ...pathsOf(candidate)].filter(
      (path) => path === "/hold-post",
    );
    expect(posts).toHaveLength(1);
  }, 45_000);

  it("P2: reports the document lost when the loss comes in a navigation's body phase", async () => {
    const { broker } = await loaded();
    command(broker, "go", { path: "b-stream" });
    await firstReport("loaded", "B");
    expect(broker.suspend("channel_lost")).toBe(true);
    await vi.waitFor(() => expect(broker.getState()).toMatchObject({ documentKept: false }), SLOW);
  }, 45_000);

  it("P2: anchors a new reference after a navigation that completed and loaded", async () => {
    const { broker, first } = await loaded();
    command(broker, "go", { path: "b" });
    const second = await firstReport("load", "B");
    expect(second.identity).not.toBe(first.identity);
    expect(broker.suspend("channel_lost")).toBe(true);
    await vi.waitFor(() => expect(broker.getState()).toMatchObject({ documentKept: true }), SLOW);
    expect(await probe(broker)).toMatchObject({ page: "B", identity: second.identity });
  }, 45_000);

  function orderPath(hold: string): string {
    return `${HARNESS.bootstrapPath}?deliveryOrder=${hold}`;
  }

  async function delivered(kind: string, message: string): Promise<void> {
    await vi.waitFor(
      () =>
        expect(messagesOf(CONTENT_A, "fixture.lifecycle.order")).toContainEqual({
          type: "fixture.lifecycle.order",
          kind,
          message,
        }),
      SLOW,
    );
  }

  it.each(["head", "suspend"])(
    "P2: preserves a pending navigation with %s delivery delayed",
    async (hold) => {
      const { broker, transport, first } = await loaded(orderPath(hold));
      await typed(broker, "ordered text");
      command(broker, "link");
      await waitForPath(transport, "/hold");
      expect(broker.suspend("channel_lost")).toBe(true);
      const held = hold === "head" ? "paseo.web.response.head" : "paseo.web.suspend";
      const passed = hold === "head" ? "paseo.web.suspend" : "paseo.web.response.head";
      await delivered("held", held);
      await delivered("delivered", passed);
      expect(await probe(broker)).toMatchObject({ identity: first.identity, note: "ordered text" });
      currentFrame(broker).contentWindow?.postMessage("fixture.release", CONTENT_A);
      await delivered("delivered", held);
      await vi.waitFor(() => expect(broker.getState()).toMatchObject({ documentKept: true }), SLOW);
      expect(await probe(broker)).toMatchObject({ identity: first.identity, note: "ordered text" });
      expect(pathsOf(transport).filter((path) => path === "/hold")).toHaveLength(1);
    },
    45_000,
  );

  it("P2: retains the failed navigation mark after its pending request was removed", async () => {
    const { broker, transport } = await loaded(orderPath("none"));
    command(broker, "go", { path: "b-error" });
    await firstReport("loaded", "B");
    transport.failNavigationBody();
    await delivered("delivered", "paseo.web.response.error");
    expect(broker.suspend("channel_lost")).toBe(true);
    await vi.waitFor(() => expect(broker.getState()).toMatchObject({ documentKept: false }), SLOW);
  }, 45_000);

  it("P2: refuses a preservation claim before any document reference exists", async () => {
    const { broker, transport } = mount({ index: "lifecycle", bootstrapPath: orderPath("none") });
    // Fence in the first request's continuation, before its head can be delivered to K.
    const original = transport.request.bind(transport);
    transport.request = async (request, signal) => {
      const response = await original(request, signal);
      broker.suspend("channel_lost");
      return response;
    };
    await vi.waitFor(
      () => expect(broker.getState()).toMatchObject({ status: "suspended", documentKept: false }),
      SLOW,
    );
    expect(pathsOf(transport)).toEqual(["/"]);
  }, 45_000);

  it("P2: preserves the old document when K intercepts a replacement head before forwarding", async () => {
    const { broker, first } = await loaded(orderPath("navigation-head"));
    await typed(broker, "before replacement");
    command(broker, "go", { path: "b" });
    await delivered("held", "paseo.web.response.head");
    expect(broker.suspend("channel_lost")).toBe(true);
    await vi.waitFor(() => expect(broker.getState()).toMatchObject({ documentKept: true }), SLOW);
    expect(await probe(broker)).toMatchObject({
      identity: first.identity,
      note: "before replacement",
    });
    currentFrame(broker).contentWindow?.postMessage("fixture.release", CONTENT_A);
    await vi.waitFor(
      () => expect(broker.getState()).toMatchObject({ navigationDrops: { suspended: 1 } }),
      SLOW,
    );
    expect(await probe(broker)).toMatchObject({
      identity: first.identity,
      note: "before replacement",
    });
    expect(reportsOfKind("loaded", "B")).toEqual([]);
  }, 45_000);

  it("P5: ends a suspended or resuming view at once, and on a navigation of the shell frame", async () => {
    const revoked = await loaded();
    expect(revoked.broker.suspend("channel_lost")).toBe(true);
    const started = performance.now();
    revoked.broker.revoke("transport_closed");
    expect(revoked.broker.getFrame()).toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);

    const resuming = await loaded();
    expect(resuming.broker.suspend("expired")).toBe(true);
    const result = resuming.broker.resume({
      transport: createFixtureTransport({ index: "lifecycle" }),
    });
    resuming.broker.revoke("disposed");
    expect(await result).toEqual({ kind: "failed", reason: "terminal" });
    expect(resuming.broker.getState()).toEqual({
      status: "revoked",
      generation: 1,
      reason: "disposed",
    });

    const navigated = await loaded();
    expect(navigated.broker.suspend("channel_lost")).toBe(true);
    command(navigated.broker, "navigate-parent");
    await vi.waitFor(
      () =>
        expect(navigated.broker.getState()).toEqual({
          status: "revoked",
          generation: 1,
          reason: "frame_navigated",
        }),
      SLOW,
    );

    const disposed = await loaded();
    expect(disposed.broker.suspend("channel_lost")).toBe(true);
    disposed.broker.dispose();
    expect(disposed.broker.getState()).toMatchObject({ status: "revoked", reason: "disposed" });
    expect(container.querySelector("iframe")).toBeNull();
  }, 90_000);

  it("P6: blocks pointer input and focus while suspended", async () => {
    const { broker, first: loadedPage } = await loaded();
    // The same click reaches the page before the suspension, so its absence later means something.
    const reached = nextReport("pressed");
    await clickApp(broker, loadedPage.press);
    await reached;
    expect(broker.suspend("channel_lost")).toBe(true);
    await clickApp(broker, loadedPage.notePosition);
    await clickApp(broker, loadedPage.press);
    await settle();
    expect(reportsOfKind("focused")).toEqual([]);
    expect(reportsOfKind("pressed")).toHaveLength(1);
  }, 45_000);

  // Measured on Playwright's Chromium headless shell 1208: once a click was aimed at the inert
  // frame, later clicks never reach the app, also after inert is cleared and also with a bare
  // inert toggle and no lifecycle code. This case clears inert without such a click; the
  // control's overlay is what keeps taps away from the inert frame on a device.
  it("P6: gives pointer input back on resume", async () => {
    const { broker, first: loadedPage } = await loaded();
    expect(broker.suspend("channel_lost")).toBe(true);
    const candidate = createFixtureTransport({ index: "lifecycle" });
    expect(await broker.resume({ transport: candidate })).toMatchObject({ kind: "resumed" });
    expect(currentFrame(broker).inert).toBe(false);
    const pressed = nextReport("pressed");
    await clickApp(broker, loadedPage.press);
    expect(await pressed).toMatchObject({ identity: loadedPage.identity });
  }, 45_000);
});

describe("web proxy lifecycle R3", () => {
  const token = "AAAAAAAAAAAAAAAAAAAAAA";
  const scriptedPath = `${HARNESS.shellPathPrefix}scripted.html`;
  type Message = Record<string, unknown>;
  interface Report {
    event: string;
    data: Message;
  }

  function reports(event: string): Report[] {
    return messagesOf(CONTENT_A, "fixture.r3").filter(
      (item): item is Report =>
        typeof item === "object" && item !== null && "event" in item && item.event === event,
    );
  }

  async function realShell(offer = true, holdArm = false) {
    const frame = appendFrame(`${CONTENT_A}${scriptedPath}?real=r3${holdArm ? "&holdArm=1" : ""}`);
    const requests: Message[] = [];
    const sideMessages: Message[] = [];
    let generation = 1;
    let requestPort: MessagePort;
    const ports: MessagePort[] = [];
    function openPort() {
      const channel = new MessageChannel();
      ports.push(channel.port1);
      requestPort = channel.port1;
      requestPort.addEventListener("message", (event) => requests.push(event.data));
      requestPort.start();
      return channel.port2;
    }
    await vi.waitFor(() => {
      expect(messagesOf(CONTENT_A, "paseo.web.hello").length).toBeGreaterThan(0);
    }, SLOW);
    frame.contentWindow?.postMessage(
      { type: "paseo.web.port", v: 1, generation, limits: DEFAULT_BRIDGE_LIMITS },
      CONTENT_A,
      [openPort()],
    );
    await vi.waitFor(() => expect(reports("bootstrap")).toHaveLength(1), SLOW);
    const lateral = new MessageChannel();
    ports.push(lateral.port1);
    lateral.port1.addEventListener("message", (event) => sideMessages.push(event.data));
    lateral.port1.start();
    if (offer) {
      requestPort!.postMessage(
        { type: "paseo.web.lifecycle.offer", v: 1, generation, offer: token },
        [lateral.port2],
      );
      await vi.waitFor(
        () =>
          expect(sideMessages).toContainEqual({
            type: "paseo.web.lifecycle.accept",
            v: 1,
            generation,
            offer: token,
          }),
        SLOW,
      );
    } else lateral.port2.close();
    function command(name: string, label = "") {
      frame.contentWindow?.postMessage({ type: "fixture.r3.command", name, label }, CONTENT_A);
    }
    async function workerMessage(label: string, type: string) {
      await vi.waitFor(
        () =>
          expect(
            reports("worker").some((entry) => {
              const data = entry.data;
              return data.label === label && (data.message as Message).type === type;
            }),
          ).toBe(true),
        SLOW,
      );
    }
    async function request(label: string) {
      command("fetch", label);
      return vi.waitFor(() => {
        const message = requests.find(
          (item) => item.type === "paseo.web.request" && item.path === `/r3-${label}`,
        );
        if (message === undefined) throw new Error("waiting for the scripted navigation");
        return message.requestId;
      }, SLOW);
    }
    async function head(label: string, requestId: unknown, status = 200) {
      requestPort!.postMessage(
        {
          type: "paseo.web.response.head",
          v: 1,
          generation,
          requestId,
          status,
          statusText: "",
          headers: [],
        },
        [],
      );
      await workerMessage(label, "paseo.web.response.head");
    }
    async function complete(label: string) {
      const requestId = await request(label);
      await head(label, requestId);
      requestPort!.postMessage({ type: "paseo.web.response.end", v: 1, generation, requestId }, []);
      await workerMessage(label, "paseo.web.response.end");
      const before = reports("load").length;
      command("load");
      await vi.waitFor(() => expect(reports("load")).toHaveLength(before + 1), SLOW);
    }
    function ready(overrides: Message = {}) {
      lateral.port1.postMessage({
        type: "paseo.web.lifecycle.ready",
        v: 1,
        generation: 1,
        offer: token,
        ...overrides,
      });
    }
    async function confirm() {
      ready();
      await vi.waitFor(
        () =>
          expect(sideMessages).toContainEqual({
            type: "paseo.web.lifecycle.state",
            v: 1,
            workerArmed: true,
          }),
        SLOW,
      );
    }
    async function suspend() {
      const before = sideMessages.length;
      lateral.port1.postMessage({
        type: "paseo.web.suspend",
        v: 1,
        generation,
        reason: "channel_lost",
      });
      return vi.waitFor(() => {
        const reply = sideMessages
          .slice(before)
          .find((item) => item.type === "paseo.web.suspended");
        if (reply === undefined) throw new Error("waiting for the suspended report");
        return reply;
      }, SLOW);
    }
    async function resume() {
      const previous = generation++;
      lateral.port1.postMessage(
        { type: "paseo.web.resume", v: 1, previous, generation, limits: DEFAULT_BRIDGE_LIMITS },
        [openPort()],
      );
      await vi.waitFor(
        () =>
          expect(requests).toContainEqual({
            type: "paseo.web.resumed",
            v: 1,
            previous,
            generation,
            documentKept: false,
          }),
        SLOW,
      );
    }
    return {
      requests,
      sideMessages,
      command,
      workerMessage,
      request,
      head,
      complete,
      ready,
      confirm,
      suspend,
      resume,
      close: () => {
        for (const port of ports) port.close();
        frame.remove();
      },
    };
  }

  it("sends the correlated ready only for an accepted offer, never for an accept after its deadline", async () => {
    const good = mount({ index: "app", bootstrapPath: scriptedPath });
    await vi.waitFor(
      () =>
        expect(messagesOf(CONTENT_A, "fixture.scripted")).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: "side",
              data: expect.objectContaining({
                type: "paseo.web.lifecycle.ready",
                v: 1,
                generation: 1,
              }),
            }),
          ]),
        ),
      SLOW,
    );
    good.broker.dispose();
    received = [];
    const late = mount({
      index: "app",
      bootstrapPath: `${scriptedPath}?acceptOn=signal`,
      handshakeTimeoutMs: 1500,
    });
    await vi.waitFor(
      () =>
        expect(late.broker.getState()).toMatchObject({
          status: "granted",
          lifecycle: "unavailable",
        }),
      SLOW,
    );
    currentFrame(late.broker).contentWindow?.postMessage(
      { type: "fixture.scripted.accept" },
      CONTENT_A,
    );
    await vi.waitFor(
      () =>
        expect(messagesOf(CONTENT_A, "fixture.scripted")).toEqual(
          expect.arrayContaining([expect.objectContaining({ event: "accepted" })]),
        ),
      SLOW,
    );
    expect(
      messagesOf(CONTENT_A, "fixture.scripted").some(
        (item) => (item as { data?: Message }).data?.type === "paseo.web.lifecycle.ready",
      ),
    ).toBe(false);
    expect(late.broker.getState()).toMatchObject({ lifecycle: "unavailable" });
  }, 30_000);

  it("waits for matching ready even without a close event, ignores wrong and duplicate ready", async () => {
    const shell = await realShell();
    try {
      expect(reports("arm")).toHaveLength(0);
      shell.ready({ generation: 2 });
      shell.ready({ offer: "BBBBBBBBBBBBBBBBBBBBBB" });
      const requestId = await shell.request("unconfirmed");
      shell.command("drop", "unconfirmed");
      await vi.waitFor(
        () =>
          expect(shell.requests).toContainEqual({
            type: "paseo.web.cancel",
            v: 1,
            generation: 1,
            requestId,
          }),
        SLOW,
      );
      expect(reports("arm")).toHaveLength(0);
      expect(shell.sideMessages).toHaveLength(1); // only accept; no state/dropped before ready
      await shell.confirm();
      shell.ready();
      shell.ready({ generation: 2 });
      await shell.complete("barrier");
      expect(reports("arm")).toHaveLength(1);
    } finally {
      shell.close();
    }
  });

  it("releases a dropped request when the real shell has no lateral port", async () => {
    const shell = await realShell(false);
    try {
      const requestId = await shell.request("no-side");
      shell.command("drop", "no-side");
      await vi.waitFor(
        () =>
          expect(shell.requests).toContainEqual({
            type: "paseo.web.cancel",
            v: 1,
            generation: 1,
            requestId,
          }),
        SLOW,
      );
      expect(shell.sideMessages).toEqual([]);
      expect(reports("arm")).toHaveLength(0);
    } finally {
      shell.close();
    }
  });

  it("disables the lifecycle on delivered lateral close and ignores an outstanding ARM reply", async () => {
    const shell = await realShell(true, true);
    try {
      shell.ready();
      await vi.waitFor(() => expect(reports("arm")).toHaveLength(1), SLOW);
      shell.command("lateral-close");
      await vi.waitFor(() => expect(reports("lateral-closed")).toHaveLength(1), SLOW);
      shell.command("arm-reply");
      await vi.waitFor(() => expect(reports("arm-replied")).toHaveLength(1), SLOW);
      await shell.complete("after-close");
      expect(reports("sent")).toHaveLength(0);
      expect(reports("arm")).toHaveLength(1);
    } finally {
      shell.close();
    }
  });

  for (const ending of ["cancel", "close", "suspend"] as const) {
    it(`marks a body navigation failed on ${ending} so a later complete document becomes the reference`, async () => {
      const shell = await realShell();
      try {
        await shell.confirm();
        await shell.complete("initial");
        const requestId = await shell.request("interrupted");
        await shell.head("interrupted", requestId);
        if (ending === "suspend") {
          expect(await shell.suspend()).toMatchObject({ documentKept: false });
          await shell.workerMessage("interrupted", "paseo.web.response.error");
          await shell.resume();
        } else {
          shell.command(ending, "interrupted");
          await vi.waitFor(
            () =>
              expect(shell.requests).toContainEqual({
                type: "paseo.web.cancel",
                v: 1,
                generation: 1,
                requestId,
              }),
            SLOW,
          );
        }
        await shell.complete("replacement");
        expect(await shell.suspend()).toMatchObject({ documentKept: true });
      } finally {
        shell.close();
      }
    });
  }

  it("does not mark the worker's expected cancel after a bodyless 204 as a failed navigation", async () => {
    const shell = await realShell();
    try {
      await shell.confirm();
      await shell.complete("initial");
      const requestId = await shell.request("empty");
      await shell.head("empty", requestId, 204);
      shell.command("cancel", "empty");
      await vi.waitFor(
        () =>
          expect(shell.requests).toContainEqual({
            type: "paseo.web.cancel",
            v: 1,
            generation: 1,
            requestId,
          }),
        SLOW,
      );
      expect(await shell.suspend()).toMatchObject({ documentKept: true });
    } finally {
      shell.close();
    }
  });
});

// The synthetic bench's authoritative entry (lifecycle contract §5.9, R6): a registry per page,
// views kept as tombstones with their evidence, admission refused while an operation is pending
// or uncertain, and an uncertain guard that never releases.
type BenchGuard = "idle" | "pending" | "released" | "purge_uncertain";

interface BenchPurgeReport {
  op: string | null;
  targeted: number;
  sentAny: boolean;
  docConfirmedAll: boolean;
  swConfirmedAll: boolean;
  guard: Exclude<BenchGuard, "pending">;
}

interface BenchView {
  broker: WebProxyBroker;
  recorded: WebProxyPurgeOutcome | null;
}

interface BenchDestination {
  guard: BenchGuard;
  views: BenchView[];
  pending: Promise<BenchPurgeReport> | null;
}

function isDocConfirmed(outcome: WebProxyPurgeOutcome): boolean {
  return outcome.kind === "purged" && outcome.localStorage && outcome.sessionStorage;
}

function isWorkerConfirmed(outcome: WebProxyPurgeOutcome): boolean {
  return outcome.kind === "purged" && outcome.caches && outcome.indexedDB && outcome.unregistered;
}

function reportOf(
  op: string | null,
  outcomes: WebProxyPurgeOutcome[],
  guard: Exclude<BenchGuard, "pending">,
): BenchPurgeReport {
  const confirmedAll = (check: (outcome: WebProxyPurgeOutcome) => boolean) =>
    outcomes.length > 0 && outcomes.every(check);
  return {
    op,
    targeted: outcomes.length,
    sentAny: outcomes.some((outcome) => outcome.sent),
    docConfirmedAll: confirmedAll(isDocConfirmed),
    swConfirmedAll: confirmedAll(isWorkerConfirmed),
    guard,
  };
}

function createBenchRegistry() {
  const destinations = new Map<string, BenchDestination>();

  function destinationOf(name: string): BenchDestination {
    const existing = destinations.get(name);
    if (existing !== undefined) return existing;
    const created: BenchDestination = { guard: "idle", views: [], pending: null };
    destinations.set(name, created);
    return created;
  }

  function settledGuard(outcomes: WebProxyPurgeOutcome[]): "released" | "purge_uncertain" {
    const isClean = (outcome: WebProxyPurgeOutcome) =>
      !outcome.sent || (isDocConfirmed(outcome) && isWorkerConfirmed(outcome));
    return outcomes.every(isClean) ? "released" : "purge_uncertain";
  }

  async function finish(
    destination: BenchDestination,
    op: string,
    targets: Array<{ view: BenchView; result: Promise<WebProxyPurgeOutcome> }>,
  ): Promise<BenchPurgeReport> {
    const outcomes = await Promise.all(targets.map(({ result }) => result));
    targets.forEach(({ view }, index) => {
      view.recorded = outcomes[index] ?? null;
    });
    const guard = settledGuard(outcomes);
    destination.guard = guard;
    destination.pending = null;
    return reportOf(op, outcomes, guard);
  }

  return {
    mount(name: string, create: () => WebProxyBroker): WebProxyBroker | "refused" {
      const destination = destinationOf(name);
      if (destination.guard === "pending" || destination.guard === "purge_uncertain") {
        return "refused";
      }
      const broker = create();
      destination.views.push({ broker, recorded: null });
      return broker;
    },
    guard: (name: string): BenchGuard => destinationOf(name).guard,
    revokeAuthorityBench(name: string): Promise<BenchPurgeReport> {
      const destination = destinationOf(name);
      if (destination.pending !== null) return destination.pending;
      if (destination.guard === "purge_uncertain") {
        return Promise.resolve(reportOf(null, [], "purge_uncertain"));
      }
      const idle = destination.guard === "released" ? "released" : "idle";
      const views = destination.views.filter((view) => view.recorded === null);
      if (views.length === 0) return Promise.resolve(reportOf(null, [], idle));
      // One synchronous turn: one op, the guard pending, and every view fenced before any await.
      const op = createLifecycleToken();
      destination.guard = "pending";
      const targets = views.map((view) => ({ view, result: view.broker.purge({ op }) }));
      destination.pending = finish(destination, op, targets);
      return destination.pending;
    },
  };
}

describe("authoritative purge on the synthetic bench", () => {
  const SCRIPTED = `${HARNESS.shellPathPrefix}scripted.html`;

  interface ProbeReport {
    action: string;
    localStorage?: string | null;
    sessionStorage?: string | null;
    cache?: boolean;
    database?: boolean;
    cookie?: boolean;
    registrations?: number;
  }

  function isProbeReport(data: unknown): data is ProbeReport {
    return typeof data === "object" && data !== null && "action" in data;
  }

  function probeReports(origin: string, action: string): ProbeReport[] {
    return messagesOf(origin, "fixture.probe")
      .filter(isProbeReport)
      .filter((report) => report.action === action);
  }

  // A sentinel probe on the content origin, framed by this page so it shares the shells' partition.
  async function probe(origin: string, action: "seed" | "read" | "hold") {
    const before = probeReports(origin, action).length;
    const frame = document.createElement("iframe");
    frame.src = `${origin}${HARNESS.shellPathPrefix}probe.html?action=${action}`;
    container.append(frame);
    const report = await vi.waitFor(() => {
      const found = probeReports(origin, action)[before];
      if (found === undefined) throw new Error(`waiting for the ${action} probe`);
      return found;
    }, SLOW);
    if (action !== "hold") frame.remove();
    return { frame, report };
  }

  const statesOf = new Map<WebProxyBroker, WebProxyBrokerState[]>();

  function remember(view: { broker: WebProxyBroker; states: WebProxyBrokerState[] }) {
    statesOf.set(view.broker, view.states);
    return view.broker;
  }

  function scriptedView(query: Record<string, string> = {}): () => WebProxyBroker {
    const params = new URLSearchParams(query).toString();
    const bootstrapPath = params === "" ? SCRIPTED : `${SCRIPTED}?${params}`;
    return () => remember(mount({ index: "app", bootstrapPath, handshakeTimeoutMs: 2000 }));
  }

  function realView(contentOrigin: string): () => WebProxyBroker {
    return () => remember(mount({ index: "lifecycle", contentOrigin }));
  }

  function admit(
    registry: ReturnType<typeof createBenchRegistry>,
    name: string,
    create: () => WebProxyBroker,
  ) {
    const broker = registry.mount(name, create);
    if (broker === "refused") throw new Error(`mount of ${name} refused`);
    return broker;
  }

  async function capable(broker: WebProxyBroker): Promise<void> {
    await vi.waitFor(
      () => expect(broker.getState()).toMatchObject({ lifecycle: "ready", purgeCapable: true }),
      SLOW,
    );
  }

  async function ready(broker: WebProxyBroker): Promise<void> {
    await vi.waitFor(() => expect(broker.getState()).toMatchObject({ lifecycle: "ready" }), SLOW);
  }

  function signal(broker: WebProxyBroker, type: string): void {
    currentFrame(broker).contentWindow?.postMessage({ type }, CONTENT_A);
  }

  async function settle(ms = 200): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  function revokedOf(broker: WebProxyBroker) {
    const state = broker.getState();
    return state.status === "revoked" ? state : null;
  }

  it("R4/B4: a shell without the capability ends at once, unsupported, and releases the guard", async () => {
    const registry = createBenchRegistry();
    const broker = admit(registry, "scripted", scriptedView({ capable: "no" }));
    await ready(broker);
    const operation = registry.revokeAuthorityBench("scripted");
    expect(broker.getFrame()).toBeNull();
    const report = await operation;
    expect(report).toMatchObject({ targeted: 1, sentAny: false, guard: "released" });
    expect(report.docConfirmedAll).toBe(false);
    expect(revokedOf(broker)?.purge).toMatchObject({ kind: "unsupported", sent: false });
  }, 30_000);

  it("B5: fences every view of the destination in the same synchronous turn", async () => {
    const registry = createBenchRegistry();
    const first = admit(registry, "scripted", scriptedView());
    const second = admit(registry, "scripted", scriptedView());
    await capable(first);
    await capable(second);
    const operation = registry.revokeAuthorityBench("scripted");
    expect(first.getState().status).toBe("purging");
    expect(second.getState().status).toBe("purging");
    expect(currentFrame(first).inert).toBe(true);
    expect(await operation).toMatchObject({
      targeted: 2,
      sentAny: true,
      docConfirmedAll: true,
      swConfirmedAll: true,
      guard: "released",
    });
  }, 30_000);

  it("B4/G1/G2: one uncertain view keeps the destination uncertain, refused and never released", async () => {
    const registry = createBenchRegistry();
    const unsupported = admit(registry, "scripted", scriptedView({ capable: "no" }));
    const silent = admit(registry, "scripted", scriptedView({ purge: "silent" }));
    await ready(unsupported);
    await capable(silent);
    const operation = registry.revokeAuthorityBench("scripted");
    const created = { calls: 0 };
    const create = () => {
      created.calls += 1;
      return scriptedView()();
    };
    expect(registry.mount("scripted", create)).toBe("refused");
    expect(await operation).toMatchObject({ targeted: 2, sentAny: true, guard: "purge_uncertain" });
    expect(revokedOf(silent)?.purge).toMatchObject({ kind: "timeout", sent: true });
    expect(registry.mount("scripted", create)).toBe("refused");
    expect(created.calls).toBe(0);
    expect(await registry.revokeAuthorityBench("scripted")).toEqual({
      op: null,
      targeted: 0,
      sentAny: false,
      docConfirmedAll: false,
      swConfirmedAll: false,
      guard: "purge_uncertain",
    });
    const op = createLifecycleToken();
    expect(await silent.purge({ op })).toEqual({ kind: "interrupted", op, sent: true });
    expect(await unsupported.purge({ op })).toEqual({ kind: "interrupted", op, sent: false });
  }, 30_000);

  it("absorbs a loss while purging and ignores reports outside the purge or of another op", async () => {
    const registry = createBenchRegistry();
    const broker = admit(
      registry,
      "scripted",
      scriptedView({ stray: "yes", purgeOn: "signal", purge: "other-op-first" }),
    );
    await capable(broker);
    expect(broker.getState().status).toBe("granted");
    const operation = registry.revokeAuthorityBench("scripted");
    expect(broker.suspend("channel_lost")).toBe(true);
    broker.revoke("transport_closed");
    await settle();
    expect(broker.getState().status).toBe("purging");
    signal(broker, "fixture.scripted.purge");
    expect(await operation).toMatchObject({ guard: "released", swConfirmedAll: true });
    expect(revokedOf(broker)).toMatchObject({
      reason: "transport_closed",
      purge: { kind: "purged", sent: true },
    });
  }, 30_000);

  it.each(["violate-side", "violate-g"])(
    "G3: a violation (%s) closes no port and turns even a report into an interruption",
    async (purge) => {
      const registry = createBenchRegistry();
      const broker = admit(registry, "scripted", scriptedView({ purge, purgeOn: "signal" }));
      await capable(broker);
      const operation = registry.revokeAuthorityBench("scripted");
      await settle();
      expect(broker.getState().status).toBe("purging");
      expect(broker.getFrame()).not.toBeNull();
      signal(broker, "fixture.scripted.purge");
      expect(await operation).toMatchObject({ guard: "purge_uncertain" });
      expect(revokedOf(broker)).toMatchObject({
        reason: "protocol_error",
        purge: { kind: "interrupted", sent: true },
      });
    },
    30_000,
  );

  it("B1/G4: a purge while resuming ignores the late acknowledgement and settles the resume last", async () => {
    const registry = createBenchRegistry();
    const broker = admit(registry, "scripted", scriptedView({ closeOld: "yes" }));
    await capable(broker);
    expect(broker.suspend("channel_lost")).toBe(true);
    const atResume: string[] = [];
    const resumed = broker
      .resume({ transport: createFixtureTransport({ index: "app" }) })
      .then((result) => {
        atResume.push(broker.getState().status);
        return result;
      });
    expect(broker.getState().status).toBe("resuming");
    const operation = registry.revokeAuthorityBench("scripted");
    expect(broker.getState()).toMatchObject({ status: "purging", generation: 1 });
    expect(await operation).toMatchObject({ guard: "released" });
    expect(await resumed).toEqual({ kind: "failed", reason: "terminal" });
    // The resume settles only at the purge's terminal, never while purging.
    expect(atResume).toEqual(["revoked"]);
    const granted = (statesOf.get(broker) ?? []).filter((state) => state.status === "granted");
    expect(granted.map((state) => state.generation)).not.toContain(2);
  }, 30_000);

  it("G4: the pending resume stays pending until the purge's terminal", async () => {
    const registry = createBenchRegistry();
    const broker = admit(
      registry,
      "scripted",
      scriptedView({ ackOn: "signal", purgeOn: "signal" }),
    );
    await capable(broker);
    expect(broker.suspend("channel_lost")).toBe(true);
    const outcome = { resume: "pending" };
    const resumed = broker.resume({ transport: createFixtureTransport({ index: "app" }) });
    void resumed.finally(() => {
      outcome.resume = "settled";
    });
    const operation = registry.revokeAuthorityBench("scripted");
    await settle();
    expect(outcome.resume).toBe("pending");
    signal(broker, "fixture.scripted.purge");
    await operation;
    expect(await resumed).toEqual({ kind: "failed", reason: "terminal" });
  }, 30_000);

  // A green run must keep the measured values: printed to the console and attached to the test.
  async function keepMeasure(annotate: TestContext["annotate"], message: string): Promise<void> {
    console.info(message);
    await annotate(message);
  }

  // Measured from the fence (the purge call) to the frame's removal, against M7's 2 s. A timer is
  // margin, not a guarantee: an excess here is a measured M7 failure.
  function removalTimes(brokers: WebProxyBroker[]): () => number[] {
    const started = performance.now();
    const removed = new Map<WebProxyBroker, number>();
    const observer = new MutationObserver(() => {
      for (const broker of brokers) {
        if (!removed.has(broker) && broker.getFrame() === null) {
          removed.set(broker, performance.now() - started);
        }
      }
    });
    observer.observe(container, { childList: true });
    return () => {
      observer.disconnect();
      return brokers.map((broker) => removed.get(broker) ?? Number.POSITIVE_INFINITY);
    };
  }

  it("R1/R6/G8: purges wp-a's sentinels, leaves wp-b and the cookie, and removes frames within M7", async ({
    annotate,
  }) => {
    expect((await probe(CONTENT_A, "seed")).report).toMatchObject({ cookie: true });
    expect((await probe(CONTENT_B, "seed")).report).toMatchObject({ cookie: true });
    const registry = createBenchRegistry();
    const first = admit(registry, "wp-a", realView(CONTENT_A));
    const second = admit(registry, "wp-a", realView(CONTENT_A));
    const other = admit(registry, "wp-b", realView(CONTENT_B));
    for (const broker of [first, second, other]) await capable(broker);
    const times = removalTimes([first, second]);
    const report = await registry.revokeAuthorityBench("wp-a");
    const elapsed = times();
    const measured = elapsed.map((value) => value.toFixed(1)).join(" ms, ");
    await keepMeasure(annotate, `M7 R1 (fast path): fence to frame removal ${measured} ms`);
    expect(Math.max(...elapsed)).toBeLessThan(2000);
    expect(report).toMatchObject({ targeted: 2, docConfirmedAll: true, swConfirmedAll: true });
    expect(report.guard).toBe("released");
    expect(other.getState().status).toBe("granted");

    const purged = (await probe(CONTENT_A, "read")).report;
    expect(purged).toMatchObject({
      localStorage: null,
      sessionStorage: null,
      cache: false,
      database: false,
      cookie: true,
    });
    await keepMeasure(
      annotate,
      `G6 observation: wp-a registrations after the purge: ${purged.registrations}`,
    );
    expect((await probe(CONTENT_B, "read")).report).toMatchObject({
      localStorage: "1",
      sessionStorage: "1",
      cache: true,
      database: true,
      cookie: true,
    });
  }, 60_000);

  it("R2: closing a view cleans nothing", async () => {
    await probe(CONTENT_A, "seed");
    const registry = createBenchRegistry();
    const broker = admit(registry, "wp-a", realView(CONTENT_A));
    await capable(broker);
    broker.revoke("disposed");
    expect(registry.guard("wp-a")).toBe("idle");
    expect((await probe(CONTENT_A, "read")).report).toMatchObject({
      localStorage: "1",
      sessionStorage: "1",
      cache: true,
      database: true,
    });
  }, 60_000);

  it("R3: a suspended view receives the purge over its side port", async () => {
    await probe(CONTENT_A, "seed");
    const registry = createBenchRegistry();
    const broker = admit(registry, "wp-a", realView(CONTENT_A));
    await capable(broker);
    expect(broker.suspend("channel_lost")).toBe(true);
    expect(await registry.revokeAuthorityBench("wp-a")).toMatchObject({
      targeted: 1,
      docConfirmedAll: true,
      swConfirmedAll: true,
      guard: "released",
    });
    expect((await probe(CONTENT_A, "read")).report).toMatchObject({
      localStorage: null,
      database: false,
    });
  }, 60_000);

  it("B3/G5: a blocked database leaves every worker field unconfirmed before C's deadline", async ({
    annotate,
  }) => {
    await probe(CONTENT_A, "seed");
    const holder = await probe(CONTENT_A, "hold");
    const registry = createBenchRegistry();
    const broker = admit(registry, "wp-a", realView(CONTENT_A));
    await capable(broker);
    const times = removalTimes([broker]);
    const report = await registry.revokeAuthorityBench("wp-a");
    const [elapsed = Number.POSITIVE_INFINITY] = times();
    await keepMeasure(
      annotate,
      `M7 B3 (K budget 1300 ms, blocked database): fence to frame removal ${elapsed.toFixed(1)} ms`,
    );
    expect(elapsed).toBeLessThan(2000);
    expect(report).toMatchObject({ docConfirmedAll: true, swConfirmedAll: false });
    expect(report.guard).toBe("purge_uncertain");
    expect(revokedOf(broker)?.purge).toEqual(
      expect.objectContaining({
        kind: "purged",
        caches: false,
        indexedDB: false,
        unregistered: false,
      }),
    );
    holder.frame.remove();
  }, 60_000);

  it("G8/M7: a mute shell ends on the 1800 ms deadline and its frame still leaves within M7", async ({
    annotate,
  }) => {
    const registry = createBenchRegistry();
    const broker = admit(registry, "scripted", scriptedView({ purge: "silent" }));
    await capable(broker);
    const times = removalTimes([broker]);
    const report = await registry.revokeAuthorityBench("scripted");
    const [elapsed = Number.POSITIVE_INFINITY] = times();
    await keepMeasure(
      annotate,
      `M7 mute K (C deadline 1800 ms): fence to frame removal ${elapsed.toFixed(1)} ms`,
    );
    expect(revokedOf(broker)?.purge).toMatchObject({ kind: "timeout", sent: true });
    expect(report.guard).toBe("purge_uncertain");
    // The deadline path, not a fast one: the view ended on C's own timer.
    expect(elapsed).toBeGreaterThanOrEqual(1800);
    expect(elapsed).toBeLessThan(2000);
  }, 30_000);
});
