import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { hash } from "bcryptjs";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import type { PaseoDaemonConfig } from "../../../../server/dist/server/server/bootstrap.js";

// Test-only daemon entrypoint: no supervisor, provider discovery or personal state.
async function main() {
  if (process.env.PASEO_PRODUCT_E2E_ISOLATED !== "1" || !process.send) {
    throw new Error("Product proof daemon requires the isolated IPC harness");
  }
  // The app package is CommonJS; the daemon and its provider dependencies are ESM.
  const { createPaseoDaemon } = await import("../../../../server/dist/server/server/bootstrap.js");
  const { BuiltinPluginLoader } =
    await import("../../../../server/dist/server/server/plugins/builtin/index.js");
  const input = JSON.parse(await readFile(process.argv[2], "utf8")) as {
    root: string;
    password: string;
    controlOrigin: string;
    networkFetch?: PaseoDaemonConfig["networkFetch"];
  };
  const paseoHome = path.join(input.root, "daemon");
  const staticDir = path.join(input.root, "static");
  await mkdir(paseoHome, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  const daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome,
      staticDir,
      corsAllowedOrigins: [input.controlOrigin],
      hostnames: true,
      mcpEnabled: false,
      mcpDebug: false,
      pluginsEnabled: false,
      relayEnabled: false,
      browserToolsEnabled: false,
      enableTerminalAgentHooks: false,
      isDev: true,
      agentClients: {},
      providerOverrides: Object.fromEntries(
        BUILTIN_PROVIDER_IDS.map((provider) => [provider, { enabled: false }]),
      ),
      agentStoragePath: path.join(paseoHome, "agents"),
      worktreesRoot: path.join(input.root, "worktrees"),
      auth: { password: await hash(input.password, 10) },
      networkFetch: input.networkFetch,
    },
    pino({ level: "error" }),
    { builtinPlugins: new BuiltinPluginLoader(undefined, []) },
  );
  let stopping = false;
  async function stop(requestId?: string) {
    if (stopping) return;
    stopping = true;
    try {
      await daemon.stop();
      if (requestId && process.connected)
        await new Promise<void>((resolve, reject) => {
          process.send?.({ type: "stopped", requestId, ok: true }, (error: Error | null) => {
            if (error) reject(error);
            else resolve();
          });
        });
    } finally {
      process.disconnect?.();
    }
  }
  process.on("message", (message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const command = message as Record<string, unknown>;
    if (
      Object.keys(command).length !== 2 ||
      command.type !== "stop" ||
      typeof command.requestId !== "string" ||
      !/^[a-zA-Z0-9-]{1,128}$/u.test(command.requestId)
    )
      return;
    void stop(command.requestId).catch(() => {
      process.exitCode = 1;
    });
  });
  process.once("disconnect", () => void stop());
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  await daemon.start();
  const target = daemon.getListenTarget();
  if (!target || target.type !== "tcp" || [6767, 6768, 61680].includes(target.port)) {
    await stop();
    throw new Error("Product proof daemon did not bind an isolated port");
  }
  process.send({ type: "ready", port: target.port, serverId: daemon.getServerId() });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Private daemon startup failed"}\n`,
  );
  process.exitCode = 1;
  process.disconnect?.();
});
