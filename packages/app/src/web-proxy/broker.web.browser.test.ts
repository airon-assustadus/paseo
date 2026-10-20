import { page } from "@vitest/browser/context";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFixtureTransport,
  FIXTURE_BIG_BODY_BYTES,
  FIXTURE_DESTINATION_ORIGIN,
  type FixtureIndex,
  type FixtureTransport,
} from "./__fixtures__/fixture-transport";
import { HARNESS, harnessContentOrigin } from "./__fixtures__/shell/harness";
import {
  attachWebProxyBroker,
  WebProxyBrokerSetupError,
  type WebProxyBroker,
  type WebProxyBrokerState,
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
}): { broker: WebProxyBroker; transport: FixtureTransport; states: WebProxyBrokerState[] } {
  const transport = createFixtureTransport({ index: input.index });
  const states: WebProxyBrokerState[] = [];
  const broker = attachWebProxyBroker({
    capability: {
      contentOrigin: CONTENT_A,
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

function grants(states: WebProxyBrokerState[]): WebProxyBrokerState[] {
  return states.filter((state) => state.status === "granted");
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
    expect(grants(states)).toEqual([{ status: "granted", generation: 1 }]);
    expect(broker.getState()).toEqual({ status: "granted", generation: 1 });

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
    expect(grants(states)).toEqual([]);
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
    expect(grants(states)).toEqual([{ status: "granted", generation: 1 }]);
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
    expect(broker.getState()).toEqual({ status: "granted", generation: 1 });
  }, 30_000);

  it("hands out a new generation on reopen and never reuses the previous port", async () => {
    const { broker, transport, states } = mount({ index: "app" });
    await waitForMessages(CONTENT_A, "fixture.report", 1);
    broker.revoke("disposed");
    broker.reopen();
    await waitForMessages(CONTENT_A, "fixture.report", 2);
    expect(grants(states)).toEqual([
      { status: "granted", generation: 1 },
      { status: "granted", generation: 2 },
    ]);
    const generations = new Set(transport.requests.map((request) => request.initiator.generation));
    expect(generations).toEqual(new Set([1, 2]));
    const last = transport.requests.at(-1);
    expect(last?.initiator.generation).toBe(2);
  }, 45_000);
});
