import { describe, it, expect, vi } from "vitest";
import {
  createClientChannel,
  createDaemonChannel,
  EncryptedChannel,
  Transport,
} from "./encrypted-channel.js";
import {
  deriveSharedKey,
  encrypt,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
} from "./crypto.js";
import { arrayBufferToBase64 } from "./base64.js";

/**
 * Creates a pair of connected mock transports.
 * Messages sent on one are received on the other.
 */
function createMockTransportPair(): [Transport, Transport] {
  const transportA: Transport = {
    send: vi.fn(),
    close: vi.fn(),
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  const transportB: Transport = {
    send: vi.fn(),
    close: vi.fn(),
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  // Wire them together
  (transportA.send as ReturnType<typeof vi.fn>).mockImplementation((data: string | ArrayBuffer) => {
    setTimeout(() => transportB.onmessage?.({ data, isBinary: data instanceof ArrayBuffer }), 0);
  });

  (transportB.send as ReturnType<typeof vi.fn>).mockImplementation((data: string | ArrayBuffer) => {
    setTimeout(() => transportA.onmessage?.({ data, isBinary: data instanceof ArrayBuffer }), 0);
  });

  return [transportA, transportB];
}

async function waitForAsyncDelivery(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("EncryptedChannel", () => {
  it("rejects the daemon handshake when the ready frame fails to send", async () => {
    const daemonKeyPair = generateKeyPair();
    const clientKeyPair = generateKeyPair();
    const transport: Transport = {
      send: () => Promise.reject(new Error("ready send failed")),
      close: () => undefined,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const channel = createDaemonChannel(transport, daemonKeyPair);

    transport.onmessage?.({
      data: JSON.stringify({
        type: "e2ee_hello",
        key: exportPublicKey(clientKeyPair.publicKey),
      }),
      isBinary: false,
    });

    await expect(channel).rejects.toThrow("ready send failed");
  });

  it("waits for transport send completion", async () => {
    let completeSend: (() => void) | undefined;
    const transport: Transport = {
      send: () =>
        new Promise<void>((resolve) => {
          completeSend = resolve;
        }),
      close: () => undefined,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const first = generateKeyPair();
    const second = generateKeyPair();
    const channel = new EncryptedChannel(
      transport,
      deriveSharedKey(first.secretKey, second.publicKey),
      {},
      { binaryCiphertext: true },
    );
    channel.setState("open");
    let completed = false;

    const sending = channel.send(new Uint8Array([1, 2, 3]).buffer).then(() => {
      completed = true;
      return undefined;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    completeSend?.();
    await sending;
    expect(completed).toBe(true);
  });

  it("establishes encrypted channel between daemon and client", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();

    // Daemon generates keypair (public key goes in QR)
    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

    let clientOpenedResolve: (() => void) | null = null;
    const clientOpened = new Promise<void>((resolve) => {
      clientOpenedResolve = resolve;
    });

    // Start daemon waiting for client
    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair);

    // Client connects (scanned QR, got daemon's public key)
    const clientChannel = await createClientChannel(clientTransport, daemonPubKeyB64, {
      onopen: () => clientOpenedResolve?.(),
    });

    // Daemon receives hello and completes handshake
    const daemonChannel = await daemonChannelPromise;
    await clientOpened;

    expect(clientChannel.isOpen()).toBe(true);
    expect(daemonChannel.isOpen()).toBe(true);
  });

  it("exchanges encrypted messages bidirectionally", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();

    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

    const daemonMessages: (string | ArrayBuffer)[] = [];
    const clientMessages: (string | ArrayBuffer)[] = [];

    let clientOpenedResolve: (() => void) | null = null;
    const clientOpened = new Promise<void>((resolve) => {
      clientOpenedResolve = resolve;
    });

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair, {
      onmessage: (data) => daemonMessages.push(data),
    });

    const clientChannel = await createClientChannel(clientTransport, daemonPubKeyB64, {
      onmessage: (data) => clientMessages.push(data),
      onopen: () => clientOpenedResolve?.(),
    });

    const daemonChannel = await daemonChannelPromise;
    await clientOpened;

    // Send messages both directions
    await clientChannel.send("Hello from client");
    await daemonChannel.send("Hello from daemon");
    await clientChannel.send("Second message from client");

    // Wait for async delivery
    await waitForAsyncDelivery();

    expect(daemonMessages).toEqual(["Hello from client", "Second message from client"]);
    expect(clientMessages).toEqual(["Hello from daemon"]);
  });

  it("encrypted messages are opaque to transport", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();

    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

    let clientOpenedResolve: (() => void) | null = null;
    const clientOpened = new Promise<void>((resolve) => {
      clientOpenedResolve = resolve;
    });

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair);
    const clientChannel = await createClientChannel(clientTransport, daemonPubKeyB64, {
      onopen: () => clientOpenedResolve?.(),
    });
    await daemonChannelPromise;
    await clientOpened;

    // Clear mock call history
    (clientTransport.send as ReturnType<typeof vi.fn>).mockClear();

    // Send a plaintext message
    const plaintext = "Secret message";
    await clientChannel.send(plaintext);

    // Check what was actually sent over the transport
    expect(clientTransport.send).toHaveBeenCalledTimes(1);
    const sentData = (clientTransport.send as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // Should be base64 string (encrypted)
    expect(typeof sentData).toBe("string");
    // Should NOT contain the plaintext
    expect(sentData).not.toContain(plaintext);
    // Should be significantly longer than plaintext (IV + auth tag overhead)
    expect(sentData.length).toBeGreaterThan(plaintext.length + 20);
  });

  it("does not throw uncaught when handshake hello retry send fails", async () => {
    vi.useFakeTimers();
    try {
      const daemonKeyPair = generateKeyPair();
      const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

      const transport: Transport = {
        send: vi.fn(),
        close: vi.fn(),
        onmessage: null,
        onclose: null,
        onerror: null,
      };

      let sendAttempts = 0;
      (transport.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
        sendAttempts += 1;
        if (sendAttempts >= 2) {
          throw new Error("WebSocket not open (readyState=2)");
        }
      });

      const onerror = vi.fn();
      await createClientChannel(transport, daemonPubKeyB64, { onerror });

      expect(() => {
        vi.advanceTimersByTime(1000);
      }).not.toThrow();

      expect(onerror).toHaveBeenCalledTimes(1);
      expect(onerror.mock.calls[0][0]).toBeInstanceOf(Error);
      expect((onerror.mock.calls[0][0] as Error).message).toContain("WebSocket not open");

      // Close the transport to stop retry timer.
      transport.onclose?.(1000, "closed");
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports rejected handshake hello sends", async () => {
    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);
    const transport: Transport = {
      send: () => Promise.reject(new Error("hello send failed")),
      close: vi.fn(),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const onerror = vi.fn();

    await createClientChannel(transport, daemonPubKeyB64, { onerror });
    await Promise.resolve();

    expect(onerror).toHaveBeenCalledTimes(1);
    expect((onerror.mock.calls[0][0] as Error).message).toBe("hello send failed");
    transport.onclose?.(1000, "closed");
  });

  it("reports rejected sends while flushing the handshake backlog", async () => {
    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);
    let sendAttempts = 0;
    const transport: Transport = {
      send: () => {
        sendAttempts += 1;
        return sendAttempts === 1 ? undefined : Promise.reject(new Error("backlog send failed"));
      },
      close: vi.fn(),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const onerror = vi.fn();
    const channel = await createClientChannel(transport, daemonPubKeyB64, { onerror });
    await channel.send(new ArrayBuffer(8));

    transport.onmessage?.({
      data: JSON.stringify({
        type: "e2ee_ready",
        capabilities: { binaryCiphertext: true },
      }),
      isBinary: false,
    });
    await waitForAsyncDelivery();

    expect(onerror).toHaveBeenCalledTimes(1);
    expect((onerror.mock.calls[0][0] as Error).message).toBe("backlog send failed");
    expect(transport.close).toHaveBeenCalledWith(4011, "backlog send failed");
  });

  it("fails handshake on invalid hello", async () => {
    const [daemonTransport] = createMockTransportPair();

    const daemonKeyPair = generateKeyPair();

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair);

    // Send invalid hello
    setTimeout(() => {
      daemonTransport.onmessage?.({ data: '{"type":"invalid"}', isBinary: false });
    }, 0);

    await expect(daemonChannelPromise).rejects.toThrow("Invalid hello message");
  });

  it("accepts duplicate hello from the same client without re-keying", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();

    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);
    const daemonMessages: (string | ArrayBuffer)[] = [];

    let clientOpenedResolve: (() => void) | null = null;
    const clientOpened = new Promise<void>((resolve) => {
      clientOpenedResolve = resolve;
    });

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair, {
      onmessage: (data) => daemonMessages.push(data),
    });

    const clientChannel = await createClientChannel(clientTransport, daemonPubKeyB64, {
      onopen: () => clientOpenedResolve?.(),
    });

    await daemonChannelPromise;
    await clientOpened;

    const firstHello = (clientTransport.send as ReturnType<typeof vi.fn>).mock.calls.find(
      ([data]) => typeof data === "string" && data.includes('"type":"e2ee_hello"'),
    )?.[0];
    expect(typeof firstHello).toBe("string");

    daemonTransport.onmessage?.({ data: firstHello as string, isBinary: false });
    await waitForAsyncDelivery();

    expect(daemonTransport.close).not.toHaveBeenCalled();

    await clientChannel.send("still encrypted with original key");
    await waitForAsyncDelivery();

    expect(daemonMessages).toEqual(["still encrypted with original key"]);
  });

  it("closes an open daemon channel when a different client key sends hello", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();

    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

    let clientOpenedResolve: (() => void) | null = null;
    const clientOpened = new Promise<void>((resolve) => {
      clientOpenedResolve = resolve;
    });

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair);

    await createClientChannel(clientTransport, daemonPubKeyB64, {
      onopen: () => clientOpenedResolve?.(),
    });

    await daemonChannelPromise;
    await clientOpened;

    const attackerKeyPair = generateKeyPair();
    const attackerHello = JSON.stringify({
      type: "e2ee_hello",
      key: exportPublicKey(attackerKeyPair.publicKey),
    });

    daemonTransport.onmessage?.({ data: attackerHello, isBinary: false });
    await waitForAsyncDelivery();

    expect(daemonTransport.close).toHaveBeenCalledWith(1008, "E2EE re-handshake key mismatch");
  });

  it("preserves ASCII-only binary frames in negotiated mode", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();
    const daemonKeyPair = generateKeyPair();
    const daemonMessages: (string | ArrayBuffer)[] = [];
    let resolveOpen: (() => void) | null = null;
    const opened = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair, {
      onmessage: (data) => daemonMessages.push(data),
    });
    const clientChannel = await createClientChannel(
      clientTransport,
      exportPublicKey(daemonKeyPair.publicKey),
      { onopen: () => resolveOpen?.() },
    );
    await daemonChannelPromise;
    await opened;

    const binary = new TextEncoder().encode("ASCII terminal output").buffer;
    (clientTransport.send as ReturnType<typeof vi.fn>).mockClear();
    await clientChannel.send(binary);
    await waitForAsyncDelivery();

    const ciphertext = (clientTransport.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(ciphertext).toBeInstanceOf(ArrayBuffer);
    expect((ciphertext as ArrayBuffer).byteLength).toBe(binary.byteLength + 40);
    expect(daemonMessages[0]).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(daemonMessages[0] as ArrayBuffer)).toEqual(new Uint8Array(binary));
  });

  it("keeps negotiated text as base64 text frames", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();
    const daemonKeyPair = generateKeyPair();
    const daemonMessages: (string | ArrayBuffer)[] = [];
    let resolveOpen: (() => void) | null = null;
    const opened = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });
    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair, {
      onmessage: (data) => daemonMessages.push(data),
    });
    const clientChannel = await createClientChannel(
      clientTransport,
      exportPublicKey(daemonKeyPair.publicKey),
      { onopen: () => resolveOpen?.() },
    );
    await daemonChannelPromise;
    await opened;

    (clientTransport.send as ReturnType<typeof vi.fn>).mockClear();
    await clientChannel.send("text payload");
    await waitForAsyncDelivery();

    expect(typeof (clientTransport.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "string",
    );
    expect(daemonMessages).toEqual(["text payload"]);
  });

  it("new client stays base64-only when an old daemon does not accept the capability", async () => {
    const daemonKeyPair = generateKeyPair();
    const clientTransport: Transport = {
      send: vi.fn(),
      close: vi.fn(),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    let resolveOpen: (() => void) | null = null;
    const opened = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });
    const clientChannel = await createClientChannel(
      clientTransport,
      exportPublicKey(daemonKeyPair.publicKey),
      { onopen: () => resolveOpen?.() },
    );

    const hello = JSON.parse(
      (clientTransport.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string,
    ) as { key: string };
    expect(hello).toMatchObject({ capabilities: { binaryCiphertext: true } });
    clientTransport.onmessage?.({ data: JSON.stringify({ type: "e2ee_ready" }), isBinary: false });
    await opened;

    (clientTransport.send as ReturnType<typeof vi.fn>).mockClear();
    await clientChannel.send(new TextEncoder().encode("legacy binary").buffer);
    expect(typeof (clientTransport.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "string",
    );
  });

  it("new daemon stays base64-only for an old client and drains pipelined traffic", async () => {
    const daemonKeyPair = generateKeyPair();
    const clientKeyPair = generateKeyPair();
    const daemonMessages: (string | ArrayBuffer)[] = [];
    const daemonTransport: Transport = {
      send: vi.fn(),
      close: vi.fn(),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const channelPromise = createDaemonChannel(daemonTransport, daemonKeyPair, {
      onmessage: (data) => daemonMessages.push(data),
    });
    const sharedKey = deriveSharedKey(
      clientKeyPair.secretKey,
      importPublicKey(exportPublicKey(daemonKeyPair.publicKey)),
    );
    daemonTransport.onmessage?.({
      data: JSON.stringify({
        type: "e2ee_hello",
        key: exportPublicKey(clientKeyPair.publicKey),
      }),
      isBinary: false,
    });
    daemonTransport.onmessage?.({
      data: arrayBufferToBase64(encrypt(sharedKey, "pipelined legacy text")),
      isBinary: false,
    });

    const daemonChannel = await channelPromise;
    await waitForAsyncDelivery();
    expect(daemonMessages).toEqual(["pipelined legacy text"]);
    expect(
      JSON.parse((daemonTransport.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]),
    ).toEqual({
      type: "e2ee_ready",
    });

    (daemonTransport.send as ReturnType<typeof vi.fn>).mockClear();
    await daemonChannel.send(new Uint8Array([1, 2, 3]).buffer);
    expect(typeof (daemonTransport.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "string",
    );
  });
});

// A browser never puts a bad close on the wire: WebSocket.close() throws before it. The fakes
// below reproduce that algorithm and ws's, so a code or reason the runtime refuses fails here.
interface RecordedClose {
  code: number | undefined;
  reason: string | undefined;
}

interface RecordingTransport extends Transport {
  closes: RecordedClose[];
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// WHATWG WebSocket "close": InvalidAccessError unless code is 1000 or 3000..4999, SyntaxError when
// the reason exceeds 123 UTF-8 bytes. A second close() on a closing socket is a no-op.
function browserLikeTransport(): RecordingTransport {
  const closes: RecordedClose[] = [];
  return {
    closes,
    send: vi.fn(),
    close(code, reason) {
      if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
        throw new DOMException(
          `The code must be either 1000, or between 3000 and 4999. ${code} is neither.`,
          "InvalidAccessError",
        );
      }
      if (reason !== undefined && utf8Bytes(reason) > 123) {
        throw new DOMException(
          "The close reason must not be greater than 123 UTF-8 bytes.",
          "SyntaxError",
        );
      }
      if (closes.length === 0) closes.push({ code, reason });
    },
    onmessage: null,
    onclose: null,
    onerror: null,
  };
}

// Node's ws (lib/validation.js isValidStatusCode, lib/sender.js): 1000..1014 except 1004..1006,
// plus 3000..4999; RangeError when the reason exceeds 123 bytes.
function wsLikeTransport(): RecordingTransport {
  const closes: RecordedClose[] = [];
  return {
    closes,
    send: vi.fn(),
    close(code, reason) {
      const valid =
        code === undefined ||
        (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
        (code >= 3000 && code <= 4999);
      if (!valid) throw new TypeError(`Invalid WebSocket frame: invalid status code ${code}`);
      if (reason !== undefined && utf8Bytes(reason) > 123) {
        throw new RangeError("The message must not be greater than 123 bytes");
      }
      if (closes.length === 0) closes.push({ code, reason });
    },
    onmessage: null,
    onclose: null,
    onerror: null,
  };
}

// Negotiated binary frames decrypt to bytes; compare deliveries as text either way.
function asText(entry: string | ArrayBuffer): string {
  return typeof entry === "string" ? entry : new TextDecoder().decode(entry);
}

// Resolves with the handleMessage promise, so a close that throws inside it is seen here.
function deliver(transport: Transport, data: string | ArrayBuffer): Promise<void> {
  return Promise.resolve(transport.onmessage?.({ data, isBinary: data instanceof ArrayBuffer }));
}

const READY_WITH_BINARY = JSON.stringify({
  type: "e2ee_ready",
  capabilities: { binaryCiphertext: true },
});

// Opens a client channel over `transport` and returns the key the daemon side would hold.
async function openClient(
  transport: RecordingTransport,
  onerror?: (error: Error) => void,
): Promise<{ channel: EncryptedChannel; sharedKey: Uint8Array }> {
  const daemonKeyPair = generateKeyPair();
  let resolveOpen: (() => void) | null = null;
  const opened = new Promise<void>((resolve) => {
    resolveOpen = resolve;
  });
  const channel = await createClientChannel(transport, exportPublicKey(daemonKeyPair.publicKey), {
    onopen: () => resolveOpen?.(),
    ...(onerror ? { onerror } : {}),
  });
  const hello = JSON.parse(
    (transport.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string,
  ) as { key: string };
  await deliver(transport, READY_WITH_BINARY);
  await opened;
  return {
    channel,
    sharedKey: deriveSharedKey(daemonKeyPair.secretKey, importPublicKey(hello.key)),
  };
}

describe("EncryptedChannel close codes", () => {
  it("client closes a browser socket after a decryption failure, with a code the browser sends", async () => {
    const transport = browserLikeTransport();
    const { channel } = await openClient(transport);

    await expect(deliver(transport, new Uint8Array(64).buffer)).resolves.toBeUndefined();

    expect(transport.closes).toEqual([{ code: 4011, reason: "Decryption failed" }]);
    expect(channel.isOpen()).toBe(false);
    await expect(channel.send("after close")).rejects.toThrow("Channel not open");
  });

  it("client stops delivering frames once a decryption failure closed it", async () => {
    const transport = browserLikeTransport();
    const received: (string | ArrayBuffer)[] = [];
    const daemonKeyPair = generateKeyPair();
    let resolveOpen: (() => void) | null = null;
    const opened = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });
    const channel = await createClientChannel(transport, exportPublicKey(daemonKeyPair.publicKey), {
      onopen: () => resolveOpen?.(),
      onmessage: (data) => received.push(data),
    });
    const hello = JSON.parse(
      (transport.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string,
    ) as { key: string };
    const sharedKey = deriveSharedKey(daemonKeyPair.secretKey, importPublicKey(hello.key));
    await deliver(transport, READY_WITH_BINARY);
    await opened;

    await deliver(transport, encrypt(sharedKey, "before"));
    await deliver(transport, new Uint8Array(64).buffer);
    await deliver(transport, encrypt(sharedKey, "after"));

    expect(received.map(asText)).toEqual(["before"]);
    expect(channel.isOpen()).toBe(false);
    expect(transport.closes).toHaveLength(1);
  });

  it("client closes a browser socket when the handshake backlog fails to send", async () => {
    const transport = browserLikeTransport();
    let sendAttempts = 0;
    (transport.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      sendAttempts += 1;
      return sendAttempts === 1 ? undefined : Promise.reject(new Error("backlog send failed"));
    });
    const onerror = vi.fn();
    const daemonKeyPair = generateKeyPair();
    const channel = await createClientChannel(transport, exportPublicKey(daemonKeyPair.publicKey), {
      onerror,
    });
    await channel.send(new ArrayBuffer(8));

    await expect(deliver(transport, READY_WITH_BINARY)).resolves.toBeUndefined();
    await waitForAsyncDelivery();

    expect(onerror).toHaveBeenCalledTimes(1);
    expect(transport.closes).toEqual([{ code: 4011, reason: "backlog send failed" }]);
    expect(channel.isOpen()).toBe(false);
  });

  it("client bounds the close reason to 123 UTF-8 bytes at a character boundary", async () => {
    const transport = browserLikeTransport();
    // 60 three-byte characters: 180 bytes, and byte 123 falls inside a character.
    const message = "ç".repeat(10) + "€".repeat(60);
    let sendAttempts = 0;
    (transport.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      sendAttempts += 1;
      return sendAttempts === 1 ? undefined : Promise.reject(new Error(message));
    });
    const daemonKeyPair = generateKeyPair();
    const channel = await createClientChannel(transport, exportPublicKey(daemonKeyPair.publicKey), {
      onerror: () => undefined,
    });
    await channel.send(new ArrayBuffer(8));

    await expect(deliver(transport, READY_WITH_BINARY)).resolves.toBeUndefined();
    await waitForAsyncDelivery();

    expect(transport.closes).toHaveLength(1);
    const reason = transport.closes[0].reason ?? "";
    expect(utf8Bytes(reason)).toBeLessThanOrEqual(123);
    expect(reason.length).toBeGreaterThan(0);
    expect(message.startsWith(reason)).toBe(true);
    expect(reason.endsWith("�")).toBe(false);
  });

  it("daemon keeps the RFC 6455 codes its ws socket accepts", async () => {
    const transport = wsLikeTransport();
    const received: (string | ArrayBuffer)[] = [];
    const daemonKeyPair = generateKeyPair();
    const clientKeyPair = generateKeyPair();
    const channelPromise = createDaemonChannel(transport, daemonKeyPair, {
      onmessage: (data) => received.push(data),
    });
    await deliver(
      transport,
      JSON.stringify({
        type: "e2ee_hello",
        key: exportPublicKey(clientKeyPair.publicKey),
        capabilities: { binaryCiphertext: true },
      }),
    );
    const channel = await channelPromise;
    const sharedKey = deriveSharedKey(clientKeyPair.secretKey, daemonKeyPair.publicKey);

    await deliver(transport, encrypt(sharedKey, "before"));
    await expect(deliver(transport, new Uint8Array(64).buffer)).resolves.toBeUndefined();
    await deliver(transport, encrypt(sharedKey, "after"));

    expect(received.map(asText)).toEqual(["before"]);
    expect(transport.closes).toEqual([{ code: 1011, reason: "Decryption failed" }]);
    expect(channel.isOpen()).toBe(false);
  });
});
