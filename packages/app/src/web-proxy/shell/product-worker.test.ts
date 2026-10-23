import { afterEach, expect, it } from "vitest";
import { createShellWorker } from "./worker.web";
import type { ShellClient } from "./client-binding.web";

const ports: MessagePort[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
});

function receive(port: MessagePort, transferred = false): Promise<MessageEvent> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent) => {
      if (transferred && event.ports.length === 0) return;
      port.removeEventListener("message", listener);
      resolve(event);
    };
    port.addEventListener("message", listener);
    port.start();
  });
}

it.each([false, true])(
  "preserves legacy tickets and isolates product document caching: %s",
  async (product) => {
    const origin = "https://destination.ticket04-content.test";
    const bootstrap: ShellClient = {
      id: "bootstrap",
      url: `${origin}/__paseo/v1/bootstrap.html`,
      frameType: "nested",
      postMessage() {},
    };
    const worker = createShellWorker({
      origin,
      config: {
        controlOrigin: "https://control.ticket04-control.test",
        shellPathPrefix: "/__paseo/",
        bootstrapPath: "/__paseo/v1/bootstrap.html",
        enterPath: "/__paseo/v1/enter",
        mountPath: "/",
        headTimeoutMs: 1000,
        idleChunkTimeoutMs: 1000,
        maxRequestBodyBytes: 1024,
        ticketTtlMs: 5000,
        formationTtlMs: 5000,
        resyncTimeoutMs: 1000,
        ...(product ? { navigation: { assetVersion: "v1" } } : {}),
      },
      clients: {
        get: async (id) => (id === bootstrap.id ? bootstrap : undefined),
        matchAll: async () => [bootstrap],
      },
      purgeHost: {
        caches: { keys: async () => [], delete: async () => true },
        indexedDB: { databases: async () => [], deleteDatabase: () => ({ addEventListener() {} }) },
        unregister: async () => true,
      },
    });
    const channel = new MessageChannel();
    ports.push(channel.port1, channel.port2);
    const opened = receive(channel.port1);
    worker.message({
      data: { type: "paseo.shell.session.open" },
      sourceId: "bootstrap",
      ports: [channel.port2],
      waitUntil() {},
    });
    expect((await opened).data).toEqual({ type: "paseo.shell.session.ready" });
    const ticket = "a".repeat(22);
    const prepared = receive(channel.port1);
    channel.port1.postMessage({ type: "paseo.shell.ticket.prepare", ticket });
    expect((await prepared).data).toEqual({ type: "paseo.shell.ticket.ready", ticket });
    function navigate(path: string) {
      const request = new Request(`${origin}${path}`);
      Object.defineProperty(request, "mode", { value: "navigate" });
      Object.defineProperty(request, "destination", { value: "iframe" });
      const decision = worker.fetch({ request, clientId: "", resultingClientId: "document" });
      if (decision.kind !== "respond") throw new Error("Expected intercepted document");
      return decision.response;
    }
    const enter = await navigate(`/__paseo/v1/enter?t=${ticket}`);
    expect(enter.headers.get("location")).toBe(`${origin}/`);
    const forwarded = receive(channel.port1, true);
    const document = navigate("/");
    const event = await forwarded;
    const responsePort = event.ports[0]!;
    ports.push(responsePort);
    responsePort.postMessage(
      {
        type: "paseo.web.response.head",
        v: 1,
        generation: 1,
        requestId: 1,
        status: 200,
        statusText: "OK",
        headers: [["cache-control", "public, max-age=600"]],
      },
      [],
    );
    responsePort.postMessage(
      { type: "paseo.web.response.end", v: 1, generation: 1, requestId: 1 },
      [],
    );
    const response = await document;
    expect(response.headers.get("cache-control")).toBe(
      product ? "no-store" : "public, max-age=600",
    );
    await response.text();
  },
);
