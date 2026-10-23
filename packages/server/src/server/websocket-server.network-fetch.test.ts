import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import {
  parseServerInfoStatusPayload,
  type DaemonPermission,
  type SessionOutboundMessage,
  type WSOutboundMessage,
} from "@getpaseo/protocol/messages";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { DaemonConfigStore } from "./daemon-config-store.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { ScheduleService } from "./schedule/service.js";
import { createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import { VoiceAssistantWebSocketServer, type WebSocketLike } from "./websocket-server.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";

class TestSocket extends EventEmitter implements WebSocketLike {
  readyState = 1;
  bufferedAmount = 0;
  sent: WSOutboundMessage[] = [];
  send(data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void): void {
    if (typeof data === "string") this.sent.push(JSON.parse(data) as WSOutboundMessage);
    callback?.();
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function fixture(enabled = true) {
  const home = mkdtempSync(join(tmpdir(), "paseo-fetch-admission-"));
  const httpServer = createServer();
  const configStore = new DaemonConfigStore(home, {
    relay: { enabled: false },
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  });
  const server = new VoiceAssistantWebSocketServer(
    httpServer,
    pino({ level: "silent" }),
    "host-a",
    createStub<AgentManager>({
      setAgentAttentionCallback() {},
      subscribe: () => () => {},
      listAgents: () => [],
      listProviderSubagentActivity: () => [],
      getMetricsSnapshot: () => ({
        total: 0,
        byLifecycle: {},
        withActiveForegroundTurn: 0,
        timelineStats: { totalItems: 0, maxItemsPerAgent: 0 },
      }),
    }),
    createStub<AgentStorage>({}),
    createStub<DownloadTokenStore>({}),
    home,
    configStore,
    null,
    { allowedOrigins: new Set() },
    createStub<WorkspaceAutoName>({ scheduleForWorktree() {}, scheduleForDirectory() {} }),
    undefined,
    undefined,
    undefined,
    undefined,
    "1.2.3-test",
    undefined,
    undefined,
    undefined,
    createStub<ScheduleService>({}),
    createStub<CheckoutDiffManager>({
      subscribe() {},
      scheduleRefreshForCwd() {},
      dispose() {},
      getMetrics: () => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      }),
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createProviderSnapshotManagerStub().manager,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      enabled,
      dedicatedContentDomain: "content.example.test",
      controlOrigin: "https://control.example.test",
      assetVersion: "v1",
      bootstrapPath: "/bootstrap.html",
      pathPrefix: "/",
      ttlMs: 60_000,
      handshakeTimeoutMs: 10_000,
      allowlists: [
        { id: "local", revision: 1, targets: [{ origin: "https://target.test", pathPrefix: "/" }] },
      ],
    },
  );
  cleanup.push(async () => {
    await server.close();
    httpServer.close();
    rmSync(home, { recursive: true, force: true });
  });
  const attached = new Map<
    string,
    ReturnType<VoiceAssistantWebSocketServer["listSessions"]>[number]
  >();
  async function attach(
    principalId: string,
    permissions: DaemonPermission[],
    capable = true,
    modern = true,
  ) {
    const socket = new TestSocket();
    await server.attachExternalSocket(
      socket,
      { transport: "hub", hubDaemonId: principalId },
      { principalId, permissions },
      {
        type: "hello",
        clientId: `client-${principalId}`,
        clientType: "cli",
        protocolVersion: 1,
        capabilities: {
          [CLIENT_CAPS.ownedSubscriptions]: modern,
          ...(capable ? { [CLIENT_CAPS.networkFetch]: true } : {}),
        },
      },
    );
    const session = attached.get(principalId) ?? server.listSessions().at(-1)!;
    attached.set(principalId, session);
    return { socket, session };
  }
  return { server, attach };
}

function info(socket: TestSocket) {
  const message = socket.sent.find(
    (entry) =>
      entry.type === "session" &&
      entry.message.type === "status" &&
      entry.message.payload.status === "server_info",
  );
  return message?.type === "session" && message.message.type === "status"
    ? parseServerInfoStatusPayload(message.message.payload)
    : null;
}

describe("network fetch authenticated daemon wiring", () => {
  it("derives identities from admitted principals and rejects another principal's identity", async () => {
    const { attach } = fixture();
    const first = await attach("principal-a", ["daemon.read", "network.proxy"]);
    const second = await attach("principal-b", ["daemon.read", "network.proxy"]);
    const request = {
      type: "network.fetch.resolve_destination.request" as const,
      requestId: "resolve",
      origin: "https://target.test",
      pathPrefix: "/",
    };
    await first.session.handleMessage(request, first.socket);
    await second.session.handleMessage(request, second.socket);
    const resolve = (socket: TestSocket) =>
      socket.sent.findLast(
        (entry) =>
          entry.type === "session" &&
          entry.message.type === "network.fetch.resolve_destination.response",
      );
    const firstReply = resolve(first.socket);
    const secondReply = resolve(second.socket);
    if (
      firstReply?.type !== "session" ||
      firstReply.message.type !== "network.fetch.resolve_destination.response" ||
      !firstReply.message.payload.ok ||
      secondReply?.type !== "session" ||
      secondReply.message.type !== "network.fetch.resolve_destination.response" ||
      !secondReply.message.payload.ok
    )
      throw new Error("Missing resolution");
    expect(firstReply.message.payload.descriptor.destinationId).not.toBe(
      secondReply.message.payload.descriptor.destinationId,
    );
    await second.session.handleMessage(
      {
        type: "network.fetch.request_cleanup.request",
        requestId: "foreign",
        destinationId: firstReply.message.payload.descriptor.destinationId,
        expectedAuthorityEpoch: "1",
      },
      second.socket,
    );
    expect(second.socket.sent.at(-1)).toMatchObject({
      message: { payload: { ok: false, error: { code: "permission_denied" } } },
    });
  });

  it("filters initial and broadcast configuration per physical source and after revocation", async () => {
    const { server, attach } = fixture();
    const permitted = await attach("principal-a", ["daemon.read", "network.proxy"]);
    const restricted = await attach("principal-b", ["daemon.read"]);
    expect(info(permitted.socket)?.networkFetchConfiguration).toBeDefined();
    expect(info(restricted.socket)?.networkFetchConfiguration).toBeUndefined();
    const oldSource = await attach("principal-a", ["daemon.read", "network.proxy"], false, false);
    const payload = info(permitted.socket)!;
    const message: SessionOutboundMessage = { type: "status", payload };
    const permittedCount = permitted.socket.sent.length;
    server.broadcast({ type: "session", message });
    expect(restricted.socket.sent.at(-1)).not.toHaveProperty(
      "message.payload.networkFetchConfiguration",
    );
    expect(oldSource.socket.sent.at(-1)).not.toHaveProperty(
      "message.payload.networkFetchConfiguration",
    );
    server.updatePrincipalPermissions("principal-a", ["daemon.read"]);
    server.broadcast({ type: "session", message });
    expect(permitted.socket.sent).toHaveLength(permittedCount);
    expect(oldSource.socket.sent.at(-1)).not.toHaveProperty(
      "message.payload.networkFetchConfiguration",
    );
    const reconnected = await attach("principal-a", ["daemon.read"]);
    expect(info(reconnected.socket)?.networkFetchConfiguration).toBeUndefined();
  });

  it("does not advertise configuration when the host feature is disabled", async () => {
    const { attach } = fixture(false);
    const source = await attach("principal-a", ["daemon.read", "network.proxy"]);
    expect(info(source.socket)?.features.networkFetch).toBe(false);
    expect(info(source.socket)?.networkFetchConfiguration).toBeUndefined();
  });
});
