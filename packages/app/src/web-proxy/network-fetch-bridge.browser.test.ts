import { commands, page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_CHANNEL_LIMITS,
  openBridgeChannel,
  type BridgeConnection,
  type BridgeHarness,
  type FixtureEventKind,
} from "./__fixtures__/bridge-channel";
import { DEFAULT_BRIDGE_LIMITS, type BridgeLimits, type RequestMessage } from "./bridge-messages";
import { attachWebProxyBroker, type WebProxyBroker } from "./broker.web";
import { openNetworkFetchTransport, type NetworkFetchTransport } from "./network-fetch-transport";
import { startPortSession } from "./port-session.web";
import type { WebProxyCapability } from "./request-policy";

// L-bridge: the real shell, broker, adapter and channel against the real bridge host, transport
// core and fixture, all on this machine (bridge-browser-plan.md). Proves local DOM through the
// stack; not the relay, E2EE, the daemon's permissions, Android, Brave or a separate site.

const SLOW = { timeout: 20_000, interval: 100 };
const BOOTSTRAP_PATH = "/__paseo/bootstrap.html";
// adapter-contract.md §4: the K3 limits of the harness, below the core's 8 requests.
const HARNESS_K3_LIMITS: BridgeLimits = {
  ...DEFAULT_BRIDGE_LIMITS,
  windowBytes: 65_536,
  maxChunkBytes: 16_384,
  maxConcurrentRequests: 6,
};
const CORE_WINDOW_BYTES = 65_536;
// Within the lab host's TTL ceiling (BF-3); the core itself accepts more.
const SESSION_TTL_MS = 60_000;
const LARGE_BYTES = 4_194_304;

describe("published lifecycle compatibility", () => {
  it("P1 published SW preserves GET and POST documents", async () => {
    const result = await commands.webProxyLifecycleCompat("probe");
    expect(result.proofs.map((proof) => proof.id)).toEqual([
      "P1-published-GET",
      "P1-published-POST",
    ]);
  }, 180_000);

  it("P7 restarted worker ARM window", async () => {
    const result = await commands.webProxyLifecycleCompat("restart");
    expect(result.proofs.map((proof) => proof.id)).toEqual(["P7"]);
  }, 180_000);

  it("P4 published control M1 and M6", async () => {
    const result = await commands.webProxyLifecycleCompat("published");
    expect(result.proofs.map((proof) => proof.id)).toEqual(["M1", "M6-oldSW", "M6-newSW"]);
  }, 240_000);

  it("P4 candidate control M2 to M5 with published bytes", async () => {
    const result = await commands.webProxyLifecycleCompat("matrix");
    expect(result.proofs.map((proof) => proof.id)).toEqual(["M2", "M3", "M4", "M5"]);
  }, 360_000);

  it("P4 worker rollback and mixed bootstrap cache", async () => {
    const result = await commands.webProxyLifecycleCompat("transitions");
    expect(result.proofs.map((proof) => proof.id)).toEqual([
      "P4-worker-upgrade",
      "P4-worker-rollback",
      "P4-mixed-K",
    ]);
  }, 180_000);

  it("P6 real control overlay and ordinary input after resume", async () => {
    const result = await commands.webProxyLifecycleCompat("overlay");
    expect(result.proofs.map((proof) => proof.id)).toEqual(["P6"]);
  }, 180_000);
});

interface Stack {
  connection: BridgeConnection;
  transport: NetworkFetchTransport;
  capability: WebProxyCapability;
  closedReasons: string[];
}

interface RequestEventView {
  method: string;
  path: string;
  nonce: string;
  origin: string | null;
  referer: string | null;
  cookieNames: unknown;
}

const opened: Stack[] = [];
const brokers: WebProxyBroker[] = [];
let container: HTMLDivElement | null = null;

afterEach(() => {
  for (const broker of brokers.splice(0)) broker.dispose();
  for (const stack of opened.splice(0)) {
    stack.transport.close();
    stack.connection.channel.close();
  }
  container?.remove();
  container = null;
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRequestEvent(event: unknown): RequestEventView | null {
  if (!isRecord(event) || event.kind !== "request" || !isRecord(event.headers)) return null;
  const { method, path, nonce, cookieNames } = event;
  const { origin, referer } = event.headers;
  if (typeof method !== "string" || typeof path !== "string" || typeof nonce !== "string") {
    return null;
  }
  const originValue = typeof origin === "string" ? origin : null;
  const refererValue = typeof referer === "string" ? referer : null;
  return { method, path, nonce, origin: originValue, referer: refererValue, cookieNames };
}

function createNonce(): string {
  return `n${crypto.getRandomValues(new Uint32Array(2)).join("")}`;
}

async function openStack(): Promise<Stack> {
  const bridge = await commands.webProxyBridge();
  const connection = await openBridgeChannel({
    url: bridge.url,
    token: bridge.token,
    readyTimeoutMs: 10_000,
  });
  // The command and the authenticated hello describe the same fixture.
  expect(connection.harness.fixture).toEqual(bridge.fixture);
  const contentOrigin = bridge.shell.origins.a;
  const capability: WebProxyCapability = {
    contentOrigin,
    destinationOrigin: connection.harness.fixture.http.origin,
    pathPrefix: "/",
  };
  const closedReasons: string[] = [];
  const transport = await openNetworkFetchTransport({
    channel: connection.channel,
    capability,
    ttlMs: SESSION_TTL_MS,
    limits: {},
    onClosed: (reason) => closedReasons.push(reason),
  });
  const stack: Stack = { connection, transport, capability, closedReasons };
  opened.push(stack);
  return stack;
}

// Reads every recorded event of one kind, following the absolute cursor (D-HOST-7).
async function eventsOf(harness: BridgeHarness, kind: FixtureEventKind): Promise<unknown[]> {
  const events: unknown[] = [];
  let after = 0;
  for (;;) {
    const result = await harness.events({ kind, after });
    events.push(...result.events);
    if (!result.more) return events;
    after = result.next;
  }
}

function waitForRequest(
  harness: BridgeHarness,
  matches: (event: RequestEventView) => boolean,
): Promise<RequestEventView> {
  return vi.waitFor(async () => {
    const requests = (await eventsOf(harness, "request")).map(asRequestEvent);
    const found = requests.find((event) => event !== null && matches(event));
    if (found === undefined || found === null) throw new Error("request not recorded yet");
    return found;
  }, SLOW);
}

interface K3Content {
  send(message: unknown): void;
  next(): Promise<unknown>;
  received: unknown[];
}

// The broker's port session, driven directly: the same policy the shell gets, without the SW.
function openK3(stack: Stack, limits: BridgeLimits): K3Content {
  const channel = new MessageChannel();
  startPortSession({
    port: channel.port1,
    generation: 1,
    capability: stack.capability,
    limits,
    transport: stack.transport,
    onRevoked: () => {},
    onRedirectBlocked: () => {},
  });
  const received: unknown[] = [];
  let cursor = 0;
  channel.port2.addEventListener("message", (event) => received.push(event.data));
  channel.port2.start();
  return {
    received,
    send: (message) => channel.port2.postMessage(message, []),
    next: () =>
      vi.waitFor(() => {
        const message = received[cursor];
        if (message === undefined) throw new Error("no K3 message yet");
        cursor += 1;
        return message;
      }, SLOW),
  };
}

function k3Request(requestId: number, path: string): RequestMessage {
  return {
    type: "paseo.web.request",
    v: 1,
    generation: 1,
    requestId,
    method: "GET",
    path,
    headers: [],
    body: null,
    mode: "subresource",
  };
}

function k3Post(requestId: number, path: string, body: string): RequestMessage {
  return {
    ...k3Request(requestId, path),
    method: "POST",
    headers: [["content-type", "text/plain"]],
    body: new TextEncoder().encode(body).buffer,
  };
}

function typeOf(message: unknown): unknown {
  return isRecord(message) ? message.type : null;
}

function chunkBytes(message: unknown): number {
  return isRecord(message) && message.chunk instanceof ArrayBuffer ? message.chunk.byteLength : 0;
}

// Reads a whole K3 response, acknowledging each chunk as the service worker would.
async function readK3Body(content: K3Content, requestId: number): Promise<string> {
  const parts: Uint8Array[] = [];
  for (;;) {
    const message = await content.next();
    if (typeOf(message) === "paseo.web.response.end") break;
    if (!isRecord(message) || !(message.chunk instanceof ArrayBuffer)) {
      throw new Error(`unexpected K3 message ${JSON.stringify(message)}`);
    }
    parts.push(new Uint8Array(message.chunk));
    const bytes = message.chunk.byteLength;
    content.send({ type: "paseo.web.ack", v: 1, generation: 1, requestId, bytes });
  }
  const decoder = new TextDecoder();
  return parts.map((part) => decoder.decode(part, { stream: true })).join("") + decoder.decode();
}

function mountContainer(): HTMLDivElement {
  const element = document.createElement("div");
  const sizing = document.createElement("style");
  sizing.textContent = "iframe { width: 800px; height: 600px; }";
  element.append(sizing);
  document.body.append(element);
  container = element;
  return element;
}

describe("web proxy over the bridge host", () => {
  it("renders the fixture as local DOM and posts its form through the host", async () => {
    const stack = await openStack();
    const { harness } = stack.connection;
    const broker = attachWebProxyBroker({
      capability: stack.capability,
      transport: stack.transport,
      container: mountContainer(),
      bootstrapPath: BOOTSTRAP_PATH,
      handshakeTimeoutMs: 15_000,
      // Below the core's 8 requests, so the broker refuses before the host does (contract §4).
      limits: HARNESS_K3_LIMITS,
    });
    brokers.push(broker);
    await vi.waitFor(() => expect(broker.getState().status).toBe("granted"), SLOW);

    const root = await waitForRequest(
      harness,
      (event) => event.method === "GET" && event.path === "/",
    );
    const frame = broker.getFrame();
    if (frame === null) throw new Error("broker lost its frame");
    const shell = page.frameLocator(page.elementLocator(frame));
    const app = page.frameLocator(shell.getByTestId("paseo-web-proxy-app"));
    // Provider-side actions: they fail unless the text is in the proxied document's DOM. The
    // document-origin field is filled by the page's own script with location.origin, so it
    // shows the page ran on the content origin, not on the destination.
    await app.getByText(root.nonce, { exact: true }).click();
    await app.getByText(stack.capability.contentOrigin, { exact: true }).click();

    await app.getByRole("button", { name: "POST" }).click();
    const post = await waitForRequest(
      harness,
      (event) =>
        event.method === "POST" && event.path === "/api/echo" && event.nonce === root.nonce,
    );
    // The upstream sees the destination as Origin (set by the core), never the content origin.
    expect(post.origin).toBe(stack.capability.destinationOrigin);
    expect(post.referer).toBeNull();
    expect(post.cookieNames).toEqual([]);
  }, 60_000);

  it("serves GET, follows a redirect inside the scope and refuses one to another origin", async () => {
    const stack = await openStack();
    const { harness } = stack.connection;
    const canary = harness.fixture.canary;
    if (canary === null) throw new Error("the host did not start the fixture canary");
    const content = openK3(stack, HARNESS_K3_LIMITS);
    const nonce = createNonce();

    content.send(k3Request(1, `/api/echo?n=${nonce}&q=${encodeURIComponent("ação")}`));
    expect(await content.next()).toMatchObject({ type: "paseo.web.response.head", status: 200 });
    const echo: unknown = JSON.parse(await readK3Body(content, 1));
    expect(echo).toMatchObject({
      method: "GET",
      path: "/api/echo",
      query: { n: [nonce], q: ["ação"] },
    });

    const landing = `/redirect/landing?n=${nonce}`;
    content.send(k3Request(2, `/redirect/302?n=${nonce}&to=${encodeURIComponent(landing)}`));
    expect(await content.next()).toMatchObject({
      type: "paseo.web.response.head",
      status: 302,
      headers: expect.arrayContaining([["location", landing]]),
    });
    await readK3Body(content, 2);
    content.send(k3Request(3, landing));
    expect(await content.next()).toMatchObject({ type: "paseo.web.response.head", status: 200 });
    await readK3Body(content, 3);
    await vi.waitFor(async () => {
      const landed = await eventsOf(harness, "redirect.landing");
      expect(landed).toContainEqual(expect.objectContaining({ nonce }));
    }, SLOW);

    // E is in the host's allowlist but outside this capability: the core does not follow,
    // the adapter reports the decision, nothing reaches E.
    const token = createNonce();
    const target = `${canary.origin}/canary/${token}`;
    content.send(k3Request(4, `/redirect/302?n=${nonce}&to=${encodeURIComponent(target)}`));
    expect(await content.next()).toEqual({
      type: "paseo.web.response.error",
      v: 1,
      generation: 1,
      requestId: 4,
      code: "redirect_blocked",
      reason: "not_allowed",
    });
    const hits = await eventsOf(harness, "canary.hit");
    expect(hits.filter((hit) => isRecord(hit) && hit.token === token)).toEqual([]);
  }, 60_000);

  it("holds the core's window until the page consumes, and cancels without leftovers", async () => {
    // A fresh session: this request is the core's request 1, which harness.stats is keyed by.
    const stack = await openStack();
    const { harness } = stack.connection;
    const content = openK3(stack, HARNESS_K3_LIMITS);
    const nonce = createNonce();
    content.send(k3Request(1, `/large?bytes=${LARGE_BYTES}&n=${nonce}`));
    expect(await content.next()).toMatchObject({ type: "paseo.web.response.head", status: 200 });

    // No ack from the content: the broker stops at its K3 window and the adapter stops crediting
    // the core, which then holds exactly its own window.
    await vi.waitFor(async () => {
      const stats = await harness.stats(1);
      expect(stats.delivered - stats.credited).toBe(CORE_WINDOW_BYTES);
    }, SLOW);
    const delivered = content.received.reduce<number>(
      (sum, message) => sum + chunkBytes(message),
      0,
    );
    expect(delivered).toBe(HARNESS_K3_LIMITS.windowBytes);
    const stalled = await harness.stats(1);
    expect(stalled.delivered - stalled.credited).toBe(CORE_WINDOW_BYTES);

    content.send({ type: "paseo.web.cancel", v: 1, generation: 1, requestId: 1 });
    await vi.waitFor(async () => {
      const closed = await eventsOf(harness, "large.closed");
      expect(closed).toContainEqual(expect.objectContaining({ nonce, completed: false }));
    }, SLOW);
    await vi.waitFor(async () => expect((await harness.stats(1)).active).toBe(0), SLOW);
    // Nothing beyond the K3 window reached the content, before or after the cancel.
    expect(content.received.reduce<number>((sum, message) => sum + chunkBytes(message), 0)).toBe(
      HARNESS_K3_LIMITS.windowBytes,
    );
    expect(stack.closedReasons).toEqual([]);
  }, 60_000);

  it("finishes a POST the fixture held once the harness releases it, on a live session", async () => {
    expect(SESSION_TTL_MS).toBeLessThanOrEqual(BRIDGE_CHANNEL_LIMITS.maxSessionTtlMs);
    const stack = await openStack();
    const { harness } = stack.connection;
    const content = openK3(stack, HARNESS_K3_LIMITS);
    const token = createNonce();
    content.send(k3Post(1, `/post/${token}?hold=1&n=${token}`, "held body"));

    await vi.waitFor(async () => {
      const arrived = await eventsOf(harness, "post.arrived");
      expect(arrived).toContainEqual(expect.objectContaining({ token, held: true }));
    }, SLOW);
    // The fixture holds the response: nothing has reached the content yet.
    expect(content.received).toEqual([]);

    expect(await harness.release(token)).toBe(1);
    expect(await content.next()).toMatchObject({ type: "paseo.web.response.head", status: 200 });
    expect(JSON.parse(await readK3Body(content, 1))).toEqual({ token, count: 1, held: true });
    await vi.waitFor(async () => {
      const released = await eventsOf(harness, "post.released");
      expect(released).toContainEqual(expect.objectContaining({ token, delivered: true }));
    }, SLOW);

    // The release closed nothing: the same session and channel keep serving.
    content.send(k3Request(2, `/api/echo?n=${token}`));
    expect(await content.next()).toMatchObject({ type: "paseo.web.response.head", status: 200 });
    expect(JSON.parse(await readK3Body(content, 2))).toMatchObject({ method: "GET" });
    expect(await harness.release(token)).toBe(0);
    const counted = await eventsOf(harness, "post.count");
    expect(counted.filter((event) => isRecord(event) && event.token === token)).toHaveLength(1);
    expect(stack.closedReasons).toEqual([]);
  }, 60_000);
});
