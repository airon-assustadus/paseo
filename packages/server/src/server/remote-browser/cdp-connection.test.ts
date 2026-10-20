import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpConnection, CdpError, type CdpEvent } from "./cdp-connection.js";

interface Harness {
  connection: CdpConnection;
  written: Array<{ id: number; method: string; params: unknown; sessionId?: string }>;
  reply(raw: string | Buffer): void;
  unresponsive: ReturnType<typeof vi.fn>;
  listenerErrors: ReturnType<typeof vi.fn>;
}

function createHarness(
  options: { maxInFlight?: number; maxConsecutiveTimeouts?: number } = {},
): Harness {
  const output = new PassThrough();
  const input = new PassThrough();
  const written: Harness["written"] = [];
  let pending = "";
  output.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    let index = pending.indexOf("\0");
    while (index !== -1) {
      written.push(JSON.parse(pending.slice(0, index)));
      pending = pending.slice(index + 1);
      index = pending.indexOf("\0");
    }
  });
  const unresponsive = vi.fn();
  const listenerErrors = vi.fn();
  const connection = new CdpConnection({
    output,
    input,
    maxInFlight: options.maxInFlight ?? 4,
    defaultTimeoutMs: 1000,
    maxConsecutiveTimeouts: options.maxConsecutiveTimeouts ?? 3,
    onUnresponsive: unresponsive,
    onListenerError: listenerErrors,
  });
  return {
    connection,
    written,
    reply: (raw) => input.write(raw),
    unresponsive,
    listenerErrors,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CdpConnection", () => {
  it("correlates results, routes events and handles several messages in one chunk", async () => {
    const harness = createHarness();
    const events: CdpEvent[] = [];
    harness.connection.onEvent((event) => events.push(event));
    const first = harness.connection.send("Browser.getVersion");
    const second = harness.connection.send("Page.enable", {}, { sessionId: "S1" });
    await flush();
    expect(harness.written.map((message) => message.method)).toEqual([
      "Browser.getVersion",
      "Page.enable",
    ]);
    expect(harness.written[1].sessionId).toBe("S1");
    harness.reply(
      `${JSON.stringify({ id: 2, result: {} })}\0${JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "S1" })}\0${JSON.stringify({ id: 1, result: { product: "Chrome/155" } })}\0`,
    );
    await expect(first).resolves.toEqual({ product: "Chrome/155" });
    await expect(second).resolves.toEqual({});
    expect(events).toEqual([
      { method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "S1" },
    ]);
  });

  it("reassembles a message split across chunks", async () => {
    const harness = createHarness();
    const result = harness.connection.send("Target.createTarget");
    await flush();
    const raw = Buffer.from(`${JSON.stringify({ id: 1, result: { targetId: "T" } })}\0`);
    harness.reply(raw.subarray(0, 5));
    harness.reply(raw.subarray(5));
    await expect(result).resolves.toEqual({ targetId: "T" });
  });

  it("rejects protocol errors without closing", async () => {
    const harness = createHarness();
    const result = harness.connection.send("Page.navigate");
    await flush();
    harness.reply(`${JSON.stringify({ id: 1, error: { message: "Cannot navigate" } })}\0`);
    await expect(result).rejects.toMatchObject({ kind: "protocol", message: "Cannot navigate" });
    expect(harness.connection.closed).toBe(false);
  });

  it.each(["null", "42", '"text"', "[1,2]", "{not json"])(
    "closes on a non-object message %s without throwing",
    async (raw) => {
      const harness = createHarness();
      const pending = harness.connection.send("Browser.getVersion");
      await flush();
      expect(() => harness.reply(`${raw}\0`)).not.toThrow();
      await expect(pending).rejects.toMatchObject({ kind: "closed" });
      expect(harness.connection.closed).toBe(true);
      expect(harness.unresponsive).toHaveBeenCalledTimes(1);
    },
  );

  it("enforces the size limit on a message terminated in the same chunk", async () => {
    const harness = createHarness();
    const pending = harness.connection.send("Browser.getVersion");
    await flush();
    const big = Buffer.alloc(32 * 1024 * 1024 + 1, 0x20);
    harness.reply(Buffer.concat([big, Buffer.from([0])]));
    await expect(pending).rejects.toMatchObject({ kind: "closed" });
    expect(harness.unresponsive).toHaveBeenCalledTimes(1);
  });

  it("enforces the size limit across chunks before the terminator arrives", async () => {
    const harness = createHarness();
    harness.reply(Buffer.alloc(16 * 1024 * 1024, 0x20));
    harness.reply(Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    expect(harness.connection.closed).toBe(true);
    expect(harness.unresponsive).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing event listener", () => {
    const harness = createHarness();
    const seen: string[] = [];
    harness.connection.onEvent(() => {
      throw new Error("listener bug");
    });
    harness.connection.onEvent((event) => seen.push(event.method));
    expect(() => harness.reply(`${JSON.stringify({ method: "A", params: {} })}\0`)).not.toThrow();
    expect(seen).toEqual(["A"]);
    expect(harness.listenerErrors).toHaveBeenCalledTimes(1);
    expect(harness.connection.closed).toBe(false);
  });

  it("bounds commands in flight", async () => {
    const harness = createHarness({ maxInFlight: 2 });
    void harness.connection.send("A").catch(() => {});
    void harness.connection.send("B").catch(() => {});
    await expect(harness.connection.send("C")).rejects.toMatchObject({ kind: "busy" });
  });

  it("writes nothing for an aborted signal", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      harness.connection.send("Input.insertText", { text: "x" }, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(CdpError);
    await flush();
    expect(harness.written).toEqual([]);
  });

  it("times out commands and reports an unresponsive peer after consecutive timeouts", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ maxConsecutiveTimeouts: 2 });
    const first = harness.connection.send("A", {}, { timeoutMs: 100 });
    const second = harness.connection.send("B", {}, { timeoutMs: 100 });
    const assertions = Promise.all([
      expect(first).rejects.toMatchObject({ kind: "timeout" }),
      expect(second).rejects.toMatchObject({ kind: "timeout" }),
    ]);
    await vi.advanceTimersByTimeAsync(100);
    await assertions;
    expect(harness.unresponsive).toHaveBeenCalledTimes(1);
    expect(harness.connection.inFlight).toBe(0);
  });

  it("rejects pending commands when the pipe closes", async () => {
    const harness = createHarness();
    const pending = harness.connection.send("A");
    harness.connection.close("browser exited");
    await expect(pending).rejects.toMatchObject({ kind: "closed", message: "browser exited" });
    await expect(harness.connection.send("B")).rejects.toMatchObject({ kind: "closed" });
  });
});
