import { describe, expect, it, vi } from "vitest";
import {
  BRIDGE_CHANNEL_LIMITS,
  BRIDGE_SUBPROTOCOL,
  BridgeChannelError,
  BridgeChannelUsageError,
  openBridgeChannel,
  type BridgeConnection,
  type BridgeSocket,
  type BridgeSocketHandlers,
  type NetworkFetchChannelHandlers,
} from "./bridge-channel";

const TOKEN = "SyntheticBridgeTokenForUnitTestsOnly0123456";
const URL_WITHOUT_TOKEN = "ws://127.0.0.1:4100/bridge";
// Synthetic test CA shape only; no real certificate or key.
const CA_PEM =
  "-----BEGIN CERTIFICATE-----\nTUlJQnN6Q0NBVm1nQXdJQkFnSVU=\n-----END CERTIFICATE-----\n";
const FIXTURE = {
  http: { origin: "http://127.0.0.1:4200" },
  https: {
    origin: "https://127.0.0.1:4201",
    caPem: CA_PEM,
    serverNames: ["localhost", "127.0.0.1", "::1"],
  },
  httpsVariants: {
    wrongHost: "https://127.0.0.1:4202",
    expired: "https://127.0.0.1:4203",
    selfSigned: "https://127.0.0.1:4204",
  },
  canary: { origin: "http://127.0.0.1:4205" },
};
const READY = { type: "harness.ready", fixture: FIXTURE };

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// A JSON payload of exactly `target` UTF-8 bytes whose padding is mostly two-byte characters,
// so it has far fewer characters than bytes.
function multibytePayload(target: number, build: (pad: string) => object): string {
  const remaining = target - utf8Bytes(JSON.stringify(build("")));
  const pad = "é".repeat(Math.floor(remaining / 2)) + "a".repeat(remaining % 2);
  const payload = JSON.stringify(build(pad));
  expect(utf8Bytes(payload)).toBe(target);
  expect(payload.length).toBeLessThan(target);
  return payload;
}

function pemOfLength(length: number): string {
  const lines: string[] = [];
  for (let offset = 0; offset < length; offset += 64) {
    lines.push("A".repeat(Math.min(64, length - offset)));
  }
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

// A valid harness.ready of exactly `target` bytes: the PEM body grows by 66 bytes per full line
// (64 characters and an escaped newline); one extra server name covers the 2-byte gap.
function readyOfBytes(target: number): string {
  const build = (pemLength: number, extraName: string | null) =>
    JSON.stringify({
      ...READY,
      fixture: {
        ...FIXTURE,
        https: {
          ...FIXTURE.https,
          caPem: pemOfLength(pemLength),
          serverNames:
            extraName === null
              ? FIXTURE.https.serverNames
              : [...FIXTURE.https.serverNames, extraName],
        },
      },
    });
  const shortfall = target - utf8Bytes(build(1, null));
  const fullLines = Math.floor(shortfall / 66);
  const rest = shortfall - fullLines * 66;
  const payload =
    rest <= 63 ? build(1 + fullLines * 64 + rest, null) : build(1 + fullLines * 64 + rest - 4, "a");
  expect(utf8Bytes(payload)).toBe(target);
  return payload;
}

interface FakeSocket {
  socket: BridgeSocket;
  sent: string[];
  closes: number[];
  urls: string[];
  driver(): BridgeSocketHandlers;
  buffered: { bytes: number };
  failSends: { error: Error | null };
}

function createFakeSocket(protocol: string = BRIDGE_SUBPROTOCOL): FakeSocket {
  const sent: string[] = [];
  const closes: number[] = [];
  const urls: string[] = [];
  const buffered = { bytes: 0 };
  const failSends: { error: Error | null } = { error: null };
  let handlers: BridgeSocketHandlers | null = null;
  return {
    sent,
    closes,
    urls,
    buffered,
    failSends,
    driver() {
      if (handlers === null) throw new Error("socket not observed");
      return handlers;
    },
    socket: {
      protocol: () => protocol,
      bufferedAmount: () => buffered.bytes,
      send(data) {
        if (failSends.error !== null) throw failSends.error;
        sent.push(data);
      },
      close(code) {
        closes.push(code);
      },
      observe(next) {
        handlers = next;
      },
    },
  };
}

function start(fake: FakeSocket, readyTimeoutMs = 1000): Promise<BridgeConnection> {
  return openBridgeChannel({
    url: URL_WITHOUT_TOKEN,
    token: TOKEN,
    readyTimeoutMs,
    createSocket: (url) => {
      fake.urls.push(url);
      return fake.socket;
    },
  });
}

interface Listening {
  connection: BridgeConnection;
  fake: FakeSocket;
  frames: unknown[];
  lost: { count: number };
}

async function connect(): Promise<Listening> {
  const fake = createFakeSocket();
  const pending = start(fake);
  fake.driver().open();
  fake.driver().message(JSON.stringify(READY));
  const connection = await pending;
  const frames: unknown[] = [];
  const lost = { count: 0 };
  const handlers: NetworkFetchChannelHandlers = {
    frame: (frame) => frames.push(frame),
    lost: () => {
      lost.count += 1;
    },
  };
  connection.channel.listen(handlers);
  return { connection, fake, frames, lost };
}

function receive(listening: Listening, frame: object): void {
  listening.fake.driver().message(JSON.stringify(frame));
}

function openSession(listening: Listening, maxChunkBytes: number): void {
  receive(listening, { type: "session.opened", limits: { maxChunkBytes } });
}

describe("opening", () => {
  it("sends only the hello, after open, and keeps the token nowhere else", async () => {
    const fake = createFakeSocket();
    const pending = start(fake);
    expect(fake.sent).toEqual([]);
    fake.driver().open();
    expect(fake.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: "harness.hello", token: TOKEN },
    ]);
    fake.driver().message(JSON.stringify(READY));
    const connection = await pending;

    expect(fake.urls).toEqual([URL_WITHOUT_TOKEN]);
    expect(connection.harness.fixture).toEqual(FIXTURE);
    expect(JSON.stringify(connection)).not.toContain(TOKEN);
  });

  it("refuses a server that did not take the bridge subprotocol", async () => {
    const fake = createFakeSocket("");
    const pending = start(fake);
    fake.driver().open();
    await expect(pending).rejects.toEqual(new BridgeChannelError("subprotocol"));
    expect(fake.sent).toEqual([]);
    expect(fake.closes).toEqual([4008]);
  });

  it("accepts listeners the fixture reports as null", async () => {
    const fake = createFakeSocket();
    const pending = start(fake);
    fake.driver().open();
    const fixture = { ...FIXTURE, https: null, httpsVariants: null, canary: null };
    fake.driver().message(JSON.stringify({ type: "harness.ready", fixture }));
    expect((await pending).harness.fixture).toEqual(fixture);
  });

  const privateKey = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
  it.each([
    ["a domain frame", { type: "session.opened", limits: {} }],
    ["a ready with extra fields", { ...READY, token: TOKEN }],
    ["a missing listener", { type: "harness.ready", fixture: { ...FIXTURE, canary: undefined } }],
    ["an extra listener", { type: "harness.ready", fixture: { ...FIXTURE, extra: null } }],
    ["a null http listener", { type: "harness.ready", fixture: { ...FIXTURE, http: null } }],
    [
      "an http listener on https",
      {
        type: "harness.ready",
        fixture: { ...FIXTURE, http: { origin: "https://127.0.0.1:4200" } },
      },
    ],
    [
      "a non-canonical origin",
      {
        type: "harness.ready",
        fixture: { ...FIXTURE, http: { origin: "http://127.0.0.1:4200/" } },
      },
    ],
    [
      "an origin with a path",
      {
        type: "harness.ready",
        fixture: { ...FIXTURE, canary: { origin: "http://127.0.0.1:1/x" } },
      },
    ],
    [
      "a variant on http",
      {
        type: "harness.ready",
        fixture: {
          ...FIXTURE,
          httpsVariants: { ...FIXTURE.httpsVariants, expired: "http://127.0.0.1:4203" },
        },
      },
    ],
    [
      "a private key instead of the CA",
      {
        type: "harness.ready",
        fixture: { ...FIXTURE, https: { ...FIXTURE.https, caPem: privateKey } },
      },
    ],
    [
      "a key after the CA certificate",
      {
        type: "harness.ready",
        fixture: { ...FIXTURE, https: { ...FIXTURE.https, caPem: CA_PEM + privateKey } },
      },
    ],
    [
      "no server names",
      {
        type: "harness.ready",
        fixture: { ...FIXTURE, https: { ...FIXTURE.https, serverNames: [] } },
      },
    ],
    [
      "a server name with a path",
      {
        type: "harness.ready",
        fixture: { ...FIXTURE, https: { ...FIXTURE.https, serverNames: ["localhost/x"] } },
      },
    ],
  ])("fails the open on %s before harness.ready", async (_label, frame) => {
    const fake = createFakeSocket();
    const pending = start(fake);
    fake.driver().open();
    fake.driver().message(JSON.stringify(frame));
    await expect(pending).rejects.toEqual(new BridgeChannelError("violation"));
    expect(fake.closes).toEqual([4008]);
  });

  it("accepts a ready of exactly its byte limit and refuses one byte more", async () => {
    const exact = createFakeSocket();
    const accepted = start(exact);
    exact.driver().open();
    exact.driver().message(readyOfBytes(BRIDGE_CHANNEL_LIMITS.maxReadyBytes));
    expect((await accepted).harness.fixture.http).toEqual(FIXTURE.http);

    const over = createFakeSocket();
    const refused = start(over);
    over.driver().open();
    over
      .driver()
      .message(
        multibytePayload(BRIDGE_CHANNEL_LIMITS.maxReadyBytes + 1, (pad) => ({ ...READY, pad })),
      );
    await expect(refused).rejects.toEqual(new BridgeChannelError("violation"));
  });

  it("fails the open when the host never answers or the socket closes", async () => {
    const silent = createFakeSocket();
    const timedOut = start(silent, 20);
    silent.driver().open();
    await expect(timedOut).rejects.toEqual(new BridgeChannelError("timeout"));
    expect(silent.closes).toEqual([4008]);

    const dropped = createFakeSocket();
    const closed = start(dropped);
    dropped.driver().close();
    await expect(closed).rejects.toEqual(new BridgeChannelError("closed"));
  });
});

describe("outbound frames", () => {
  it("encodes frames as exact JSON with the body in base64", async () => {
    const listening = await connect();
    const { channel } = listening.connection;
    channel.send({
      type: "session.open",
      scope: { origin: "http://127.0.0.1:4200", pathPrefix: "/" },
      ttlMs: 60_000,
      limits: null,
    });
    channel.send({ type: "body", requestId: 1, data: new Uint8Array([0, 1, 255]) });
    channel.send({ type: "grantCredit", requestId: 1, bytes: 3 });
    expect(listening.fake.sent.slice(1).map((payload) => JSON.parse(payload))).toEqual([
      {
        type: "session.open",
        scope: { origin: "http://127.0.0.1:4200", pathPrefix: "/" },
        ttlMs: 60_000,
      },
      { type: "body", requestId: 1, data: "AAH/" },
      { type: "grantCredit", requestId: 1, bytes: 3 },
    ]);
  });

  it("closes and reports the loss when the socket's buffer is full or a frame is too large", async () => {
    const full = await connect();
    full.fake.buffered.bytes = BRIDGE_CHANNEL_LIMITS.maxBufferedBytes;
    full.connection.channel.send({ type: "cancel", requestId: 1 });
    expect(full.fake.closes).toEqual([4013]);
    expect(full.lost.count).toBe(1);

    const large = await connect();
    const data = new Uint8Array(BRIDGE_CHANNEL_LIMITS.maxFrameBytes);
    large.connection.channel.send({ type: "body", requestId: 1, data });
    expect(large.fake.sent).toHaveLength(1);
    expect(large.fake.closes).toEqual([4013]);
    expect(large.lost.count).toBe(1);
  });

  it("counts outbound size in bytes, as the host's payload limit does", async () => {
    const listening = await connect();
    // Under the limit in characters, over it in UTF-8 bytes.
    const value = "é".repeat(BRIDGE_CHANNEL_LIMITS.maxFrameBytes / 2);
    listening.connection.channel.send({
      type: "request",
      requestId: 1,
      method: "GET",
      url: "http://127.0.0.1:4200/",
      headers: [["x-note", value]],
      redirect: "manual",
      body: { kind: "none" },
    });
    expect(listening.fake.sent).toHaveLength(1);
    expect(listening.fake.closes).toEqual([4013]);
  });

  it("turns a socket that is not open into a loss and stays silent afterwards", async () => {
    const listening = await connect();
    listening.fake.failSends.error = new DOMException("not open", "InvalidStateError");
    listening.connection.channel.send({ type: "cancel", requestId: 1 });
    expect(listening.lost.count).toBe(1);
    expect(listening.fake.closes).toEqual([1000]);
    listening.fake.failSends.error = null;
    listening.connection.channel.send({ type: "cancel", requestId: 2 });
    expect(listening.fake.sent).toHaveLength(1);
  });

  it.each([
    ["a TypeError", new TypeError("bug")],
    ["another DOMException", new DOMException("bad", "SyntaxError")],
  ])("lets %s from the socket surface instead of hiding it", async (_label, error) => {
    const listening = await connect();
    listening.fake.failSends.error = error;
    expect(() => listening.connection.channel.send({ type: "cancel", requestId: 1 })).toThrow(
      error,
    );
    expect(listening.lost.count).toBe(0);
  });
});

describe("inbound frames", () => {
  it("accepts a frame of exactly the byte limit and refuses one byte more", async () => {
    const build = (pad: string) => ({ type: "end", requestId: 1, pad });
    const exact = await connect();
    exact.fake.driver().message(multibytePayload(BRIDGE_CHANNEL_LIMITS.maxFrameBytes, build));
    expect(exact.frames).toHaveLength(1);
    expect(exact.lost.count).toBe(0);

    const over = await connect();
    over.fake.driver().message(multibytePayload(BRIDGE_CHANNEL_LIMITS.maxFrameBytes + 1, build));
    expect(over.frames).toEqual([]);
    expect(over.lost.count).toBe(1);
    expect(over.fake.closes).toEqual([4008]);
  });

  it("hands domain frames to the adapter, with body data decoded", async () => {
    const listening = await connect();
    openSession(listening, 4);
    receive(listening, { type: "body", requestId: 1, data: "AAH/" });
    receive(listening, { type: "end", requestId: 1 });
    expect(listening.frames).toEqual([
      { type: "session.opened", limits: { maxChunkBytes: 4 } },
      { type: "body", requestId: 1, data: new Uint8Array([0, 1, 255]) },
      { type: "end", requestId: 1 },
    ]);
  });

  it.each([
    ["length not a multiple of 4", "AAH"],
    ["characters outside the alphabet", "AA-_"],
    ["a non-canonical spelling", "AAF="],
    ["no bytes", ""],
    ["more bytes than maxChunkBytes", "AAECAwQ="],
    ["a non-string value", 7],
  ])("ends the channel on a body with %s", async (_label, data) => {
    const listening = await connect();
    openSession(listening, 4);
    receive(listening, { type: "body", requestId: 1, data });
    expect(listening.lost.count).toBe(1);
    expect(listening.fake.closes).toEqual([4008]);
    expect(listening.frames).toHaveLength(1);
  });

  it("ends the channel on a body before the session is open", async () => {
    const listening = await connect();
    receive(listening, { type: "body", requestId: 1, data: "AA==" });
    expect(listening.lost.count).toBe(1);
    expect(listening.frames).toEqual([]);
  });

  it.each([
    ["a frame above the size limit", JSON.stringify({ type: "end", pad: "x".repeat(65_600) })],
    ["a binary frame", new ArrayBuffer(4)],
    ["text that is not JSON", "{not json"],
    ["an unknown type", JSON.stringify({ type: "harness.hello", token: TOKEN })],
    ["a harness result nobody asked for", JSON.stringify({ type: "harness.stats.result" })],
  ])("ends the channel on %s", async (_label, data) => {
    const listening = await connect();
    listening.fake.driver().message(data);
    expect(listening.lost.count).toBe(1);
    expect(listening.fake.closes).toEqual([4008]);
    expect(listening.frames).toEqual([]);
  });
});

describe("harness queries", () => {
  it("answers fixture and stats queries without passing them to the adapter", async () => {
    const listening = await connect();
    const { harness } = listening.connection;
    const events = harness.events({ kind: "request" });
    expect(JSON.parse(listening.fake.sent.at(-1) ?? "")).toEqual({
      type: "fixture.events",
      kind: "request",
    });
    receive(listening, {
      type: "fixture.events.result",
      events: [{ kind: "request" }],
      next: 1,
      more: false,
      dropped: 0,
    });
    expect(await events).toEqual({
      events: [{ kind: "request" }],
      next: 1,
      more: false,
      dropped: 0,
    });

    const stats = harness.stats(3);
    receive(listening, {
      type: "harness.stats.result",
      requestId: 3,
      delivered: 65_536,
      credited: 0,
      active: 1,
    });
    expect(await stats).toEqual({ requestId: 3, delivered: 65_536, credited: 0, active: 1 });
    expect(listening.frames).toEqual([]);
  });

  it("accepts an events page of exactly 32 KiB and refuses one byte more", async () => {
    const build = (pad: string) => ({
      type: "fixture.events.result",
      events: [{ kind: "request", note: pad }],
      next: 1,
      more: false,
      dropped: 0,
    });
    const exact = await connect();
    const accepted = exact.connection.harness.events({});
    exact.fake
      .driver()
      .message(multibytePayload(BRIDGE_CHANNEL_LIMITS.maxEventsResultBytes, build));
    expect((await accepted).events).toHaveLength(1);

    const over = await connect();
    const refused = over.connection.harness.events({});
    over.fake
      .driver()
      .message(multibytePayload(BRIDGE_CHANNEL_LIMITS.maxEventsResultBytes + 1, build));
    await expect(refused).rejects.toEqual(new BridgeChannelError("violation"));
    expect(over.lost.count).toBe(1);
  });

  it("follows the absolute cursor and refuses pages that break it", async () => {
    const listening = await connect();
    const { harness } = listening.connection;
    // after 10, but 12 events were already dropped: the page starts at 12.
    const page = harness.events({ after: 10 });
    receive(listening, {
      type: "fixture.events.result",
      events: [{ kind: "request" }],
      next: 13,
      more: true,
      dropped: 12,
    });
    expect(await page).toEqual({
      events: [{ kind: "request" }],
      next: 13,
      more: true,
      dropped: 12,
    });

    const backwards = harness.events({ after: 13 });
    receive(listening, {
      type: "fixture.events.result",
      events: [{ kind: "request" }],
      next: 13,
      more: false,
      dropped: 12,
    });
    await expect(backwards).rejects.toEqual(new BridgeChannelError("violation"));
  });

  it.each([
    ["without dropped", { events: [], next: 0, more: false }],
    ["with a negative dropped", { events: [], next: 0, more: false, dropped: -1 }],
    [
      "with too many events",
      { events: Array.from({ length: 129 }, () => ({})), next: 129, more: true, dropped: 0 },
    ],
  ])("refuses an events page %s", async (_label, result) => {
    const listening = await connect();
    const page = listening.connection.harness.events({});
    receive(listening, { type: "fixture.events.result", ...result });
    await expect(page).rejects.toEqual(new BridgeChannelError("violation"));
  });

  it("allows one pending query of each kind and rejects a malformed answer", async () => {
    const listening = await connect();
    const { harness } = listening.connection;
    const first = harness.stats(1);
    await expect(harness.stats(1)).rejects.toEqual(new BridgeChannelUsageError("query_pending"));
    receive(listening, {
      type: "harness.stats.result",
      requestId: 2,
      delivered: 0,
      credited: 0,
      active: 0,
    });
    await expect(first).rejects.toEqual(new BridgeChannelError("violation"));
    expect(listening.lost.count).toBe(1);
  });

  it("rejects pending queries when the socket closes", async () => {
    const listening = await connect();
    const release = listening.connection.harness.release("post-token");
    listening.fake.driver().close();
    await expect(release).rejects.toEqual(new BridgeChannelError("closed"));
    expect(listening.lost.count).toBe(1);
  });
});

describe("closing", () => {
  it("closes once and does not report a loss it caused", async () => {
    const listening = await connect();
    listening.connection.channel.close();
    listening.connection.channel.close();
    listening.fake.driver().close();
    expect(listening.fake.closes).toEqual([1000]);
    expect(listening.lost.count).toBe(0);
    listening.connection.channel.send({ type: "close" });
    expect(listening.fake.sent).toHaveLength(1);
  });

  it("reports a remote close exactly once", async () => {
    const listening = await connect();
    listening.fake.driver().close();
    listening.fake.driver().error();
    expect(listening.lost.count).toBe(1);
  });

  it("accepts one listener and tells a late one about an earlier loss", async () => {
    const fake = createFakeSocket();
    const pending = start(fake);
    fake.driver().open();
    fake.driver().message(JSON.stringify(READY));
    const { channel } = await pending;
    fake.driver().close();
    const lost = vi.fn();
    channel.listen({ frame: () => {}, lost });
    expect(() => channel.listen({ frame: () => {}, lost: () => {} })).toThrow(
      new BridgeChannelUsageError("listen_twice"),
    );
    await vi.waitFor(() => expect(lost).toHaveBeenCalledTimes(1));
  });
});
