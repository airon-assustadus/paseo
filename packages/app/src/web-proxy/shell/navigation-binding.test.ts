import { afterEach, describe, expect, it } from "vitest";
import { createClientBinding, type ShellClient, type ShellPurgeHost } from "./client-binding.web";
import {
  parseShellNavigationQuery,
  parseShellNavigationReady,
  parseShellNavigationTicket,
} from "./navigation-binding";
import { parseSessionPortMessage } from "./relay-messages";

const ports: MessagePort[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
});

function channel() {
  const created = new MessageChannel();
  ports.push(created.port1, created.port2);
  return created;
}

function receive(port: MessagePort): Promise<unknown> {
  return new Promise((resolve) => {
    port.addEventListener("message", (event) => resolve(event.data), { once: true });
    port.start();
  });
}

async function harness(version: string | null = "nav-v1") {
  const bootstrap: ShellClient = {
    id: "bootstrap",
    url: "https://destination.ticket04-content.test/__paseo/nav-v1/bootstrap.html",
    frameType: "nested",
    postMessage() {},
  };
  const clients = new Map([[bootstrap.id, bootstrap]]);
  const purgeHost: ShellPurgeHost = {
    caches: { keys: async () => [], delete: async () => true },
    indexedDB: { databases: async () => [], deleteDatabase: () => ({ addEventListener() {} }) },
    unregister: async () => true,
  };
  const clock = { now: 0 };
  const binding = createClientBinding({
    config: {
      origin: "https://destination.ticket04-content.test",
      bootstrapPath: "/__paseo/nav-v1/bootstrap.html",
      shellPathPrefix: "/__paseo/",
      mountPath: "/",
      ticketTtlMs: 5000,
      formationTtlMs: 5000,
      resyncTimeoutMs: 1000,
      ...(version === null ? {} : { navigation: { assetVersion: version } }),
    },
    clients: { get: async (id) => clients.get(id), matchAll: async () => [...clients.values()] },
    purgeHost,
    now: () => clock.now,
  });
  const session = channel();
  const ready = receive(session.port1);
  binding.handleMessage({
    data: { type: "paseo.shell.session.open" },
    sourceId: "bootstrap",
    ports: [session.port2],
    waitUntil() {},
  });
  expect(await ready).toEqual({ type: "paseo.shell.session.ready" });
  async function negotiate(assetVersion = "nav-v1", sourceId = "bootstrap") {
    const exchange = channel();
    const response = receive(exchange.port1);
    binding.handleMessage({
      data: { type: "paseo.shell.navigation.query", v: 1, nonce: "query-one", assetVersion },
      sourceId,
      ports: [exchange.port2],
      waitUntil() {},
    });
    return parseShellNavigationReady(await response);
  }
  async function prepare(target: string | null) {
    const response = receive(session.port1);
    session.port1.postMessage(
      target === null
        ? { type: "paseo.shell.ticket.prepare", ticket: "a".repeat(22) }
        : { type: "paseo.shell.navigation.ticket.prepare", v: 1, ticket: "a".repeat(22), target },
    );
    return response;
  }
  return { binding, clock, negotiate, prepare, clients };
}

describe("navigation ticket negotiation", () => {
  it("preserves strict legacy tickets and separates the extension", () => {
    const legacy = { type: "paseo.shell.ticket.prepare", ticket: "a".repeat(22) };
    expect(parseSessionPortMessage(legacy)).toEqual(legacy);
    expect(parseSessionPortMessage({ ...legacy, target: "/page" })).toBeNull();
    expect(parseShellNavigationTicket(legacy)).toBeNull();
    expect(
      parseShellNavigationQuery({
        type: "paseo.shell.navigation.query",
        v: 1,
        nonce: "n",
        assetVersion: "v",
        extra: true,
      }),
    ).toBeNull();
  });

  it("requires the current worker version before admitting a target ticket", async () => {
    const test = await harness();
    expect(await test.prepare("/page")).toMatchObject({ type: "paseo.shell.refused" });
    expect(await test.negotiate("nav-v2")).toMatchObject({ supported: false });
    expect(await test.negotiate()).toMatchObject({ supported: true });
    expect(await test.prepare("/allowed/page?q=1#section")).toMatchObject({
      type: "paseo.shell.ticket.ready",
    });
    const input = { ticket: "a".repeat(22), clientId: "", resultingClientId: "document-one" };
    expect(await test.binding.enterTarget(input)).toBe("/allowed/page?q=1#section");
    expect(await test.binding.enterTarget(input)).toBeNull();
  });

  it("keeps legacy root entry working without navigation support", async () => {
    const test = await harness(null);
    expect(await test.negotiate()).toMatchObject({ supported: false });
    expect(await test.prepare(null)).toMatchObject({ type: "paseo.shell.ticket.ready" });
    expect(
      await test.binding.enter({
        ticket: "a".repeat(22),
        clientId: "",
        resultingClientId: "document-one",
      }),
    ).toBe(true);
  });

  it("refuses reserved paths and tickets that expire or lose their bootstrap", async () => {
    const test = await harness();
    await test.negotiate();
    expect(await test.prepare("/__paseo/worker.js")).toMatchObject({ type: "paseo.shell.refused" });
    await test.prepare("/page");
    test.clock.now = 5001;
    expect(
      await test.binding.enterTarget({
        ticket: "a".repeat(22),
        clientId: "",
        resultingClientId: "document-one",
      }),
    ).toBeNull();
    await test.prepare("/page");
    test.clients.clear();
    expect(
      await test.binding.enterTarget({
        ticket: "a".repeat(22),
        clientId: "",
        resultingClientId: "document-two",
      }),
    ).toBeNull();
  });

  it("does not negotiate for a source without the live session", async () => {
    const test = await harness();
    expect(await test.negotiate("nav-v1", "unowned")).toMatchObject({ supported: false });
  });

  it.each(["//outside.test/path", "/with space", "/\\outside", "/page\n", "a".repeat(8193)])(
    "rejects noncanonical ticket target %j",
    (target) => {
      expect(
        parseShellNavigationTicket({
          type: "paseo.shell.navigation.ticket.prepare",
          v: 1,
          ticket: "a".repeat(22),
          target,
        }),
      ).toBeNull();
    },
  );
});
