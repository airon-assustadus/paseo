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
const READY = {
  type: "harness.ready",
  fixture: { http: { origin: "http://127.0.0.1:4200" }, https: null, canary: null },
};

interface FakeSocket {
  socket: BridgeSocket;
  sent: string[];
  closes: number[];
  urls: string[];
  driver(): BridgeSocketHandlers;
  buffered: { bytes: number };
  failSends: { enabled: boolean };
}

function createFakeSocket(protocol: string = BRIDGE_SUBPROTOCOL): FakeSocket {
  const sent: string[] = [];
  const closes: number[] = [];
  const urls: string[] = [];
  const buffered = { bytes: 0 };
  const failSends = { enabled: false };
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
        if (failSends.enabled) throw new DOMException("closing", "InvalidStateError");
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
    expect(connection.harness.fixture).toEqual({
      httpOrigin: "http://127.0.0.1:4200",
      listeners: READY.fixture,
    });
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

  it.each([
    ["a domain frame", { type: "session.opened", limits: {} }],
    ["a ready without an http origin", { type: "harness.ready", fixture: { http: {} } }],
    ["a ready with extra fields", { ...READY, token: TOKEN }],
  ])("fails the open on %s before harness.ready", async (_label, frame) => {
    const fake = createFakeSocket();
    const pending = start(fake);
    fake.driver().open();
    fake.driver().message(JSON.stringify(frame));
    await expect(pending).rejects.toEqual(new BridgeChannelError("violation"));
    expect(fake.closes).toEqual([4008]);
  });

  it("fails the open on a ready above its size limit", async () => {
    const fake = createFakeSocket();
    const pending = start(fake);
    fake.driver().open();
    const padded = {
      ...READY,
      fixture: { ...READY.fixture, note: "x".repeat(BRIDGE_CHANNEL_LIMITS.maxReadyChars) },
    };
    fake.driver().message(JSON.stringify(padded));
    await expect(pending).rejects.toEqual(new BridgeChannelError("violation"));
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

  it("never throws from send, before or after the channel ends", async () => {
    const listening = await connect();
    listening.fake.failSends.enabled = true;
    listening.connection.channel.send({ type: "cancel", requestId: 1 });
    expect(listening.lost.count).toBe(1);
    expect(listening.fake.closes).toEqual([1000]);
    listening.fake.failSends.enabled = false;
    listening.connection.channel.send({ type: "cancel", requestId: 2 });
    expect(listening.fake.sent).toHaveLength(1);
  });
});

describe("inbound frames", () => {
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
