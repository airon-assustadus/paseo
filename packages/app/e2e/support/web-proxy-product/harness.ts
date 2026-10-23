import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { chromium, type Page } from "@playwright/test";
import type { DaemonClient, DaemonClientConfig } from "@getpaseo/client/internal/daemon-client";
import { buildProductShellAssets } from "../../../src/web-proxy/shell/product-assets";
import { loadDaemonClientConstructor } from "../helpers/daemon-client-loader";
import { createNodeWebSocketFactory } from "../helpers/node-ws-factory";
import { buildSeededHost } from "../helpers/daemon-registry";
import { spawnTsx, killProcessTree } from "../helpers/spawn-node";
import { observeProductChannels } from "./observation";
import {
  CONTENT_DOMAIN,
  CONTROL,
  startBrowserEgress,
  startHostFixture,
  startProductGateway,
} from "./network";

interface HostReady {
  type: "ready";
  port: number;
  serverId: string;
}

function waitForHost(child: ChildProcess): Promise<HostReady> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Private daemon startup timed out")), 30_000);
    const failed = () => finish(new Error("Private daemon exited before readiness"));
    const message = (value: unknown) => {
      if (!value || typeof value !== "object" || !("type" in value) || value.type !== "ready")
        return;
      if (
        !("port" in value) ||
        typeof value.port !== "number" ||
        !("serverId" in value) ||
        typeof value.serverId !== "string"
      ) {
        finish(new Error("Invalid private daemon readiness"));
        return;
      }
      finish(null, { type: "ready", port: value.port, serverId: value.serverId });
    };
    function finish(error: Error | null, ready?: HostReady) {
      clearTimeout(timer);
      child.off("error", failed);
      child.off("exit", failed);
      child.off("message", message);
      if (error || !ready) reject(error ?? new Error("Missing daemon readiness"));
      else resolve(ready);
    }
    child.once("error", failed);
    child.once("exit", failed);
    child.on("message", message);
  });
}

async function readMetroBinding(metroPort: number) {
  const bindingLog = process.env.PASEO_PRODUCT_BIND_LOG;
  if (!bindingLog || process.env.PASEO_PRODUCT_E2E_ISOLATED !== "1") {
    throw new Error("Run product E2E through its isolated launcher under heavy");
  }
  const bindings = (await readFile(bindingLog, "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          pid: number;
          argv: string[];
          address: { address: string; port: number };
        },
    );
  const binding = bindings.find(
    (item) =>
      item.address.port === metroPort && item.argv.some((arg) => /expo[/\\]bin[/\\]cli/u.test(arg)),
  );
  if (!binding || !["127.0.0.1", "::1"].includes(binding.address.address)) {
    throw new Error("No kernel-address evidence for the private Metro listener");
  }
  return binding;
}

async function seedControl(page: Page, serverId: string, password: string, domOptIn: boolean) {
  const host = {
    ...buildSeededHost({
      serverId,
      endpoint: `${new URL(CONTROL).hostname}:443`,
      nowIso: new Date().toISOString(),
      label: "Product proof host",
    }),
    password,
  };
  const connection = host.connections[0];
  const seeded = { ...host, connections: [{ ...connection, useTls: true }] };
  await page.addInitScript(
    ({ origin, daemon, optIn }) => {
      if (location.origin !== origin) return;
      if (localStorage.getItem("@paseo:product-proof-seeded")) return;
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([daemon]));
      // E1 starts with a persisted per-host user opt-in; E8 owns the opt-in UI proof.
      localStorage.setItem(
        "workspace-web-proxy-preferences",
        JSON.stringify({ state: { domByHost: { [daemon.serverId]: optIn } } }),
      );
      localStorage.setItem("@paseo:product-proof-seeded", "1");
    },
    { origin: CONTROL, daemon: seeded, optIn: domOptIn },
  );
}

export interface ProductHarnessOptions {
  scenario?: "history" | "boundary";
  observeChannels?: boolean;
  networkMode?: "enabled" | "disabled" | "absent";
  domOptIn?: boolean;
  mixedAssets?: boolean;
  imageUnavailable?: boolean;
  observeReceipts?: boolean;
}

function privateHostEnvironment(root: string, options: ProductHarnessOptions) {
  return options.imageUnavailable
    ? { ...process.env, PASEO_REMOTE_BROWSER_EXECUTABLE: path.join(root, "unavailable-renderer") }
    : process.env;
}

function assertImageUnavailable(client: DaemonClient, options: ProductHarnessOptions) {
  if (
    options.imageUnavailable &&
    client.getLastServerInfoMessage()?.features?.remoteBrowser !== false
  ) {
    throw new Error("Private host did not disable the unavailable image renderer");
  }
}

export async function startProductHarness(
  artifactDirectory: string,
  options: ProductHarnessOptions = {},
) {
  const runtimeOptions = { domOptIn: true, observeReceipts: false, ...options };
  const metroPort = Number(process.env.E2E_METRO_PORT);
  if (!Number.isInteger(metroPort) || metroPort < 1)
    throw new Error("Existing Metro globalSetup is required");
  const metroBinding = await readMetroBinding(metroPort);
  const assetVersion = process.env.PASEO_PRODUCT_ASSET_VERSION;
  if (!assetVersion || !/^ticket04-product-nav-v[1-9]\d*$/u.test(assetVersion))
    throw new Error("Immutable product asset version required");
  const root = await mkdtemp(path.join(tmpdir(), "paseo-product-e1-"));
  const appRoot = path.resolve(__dirname, "../../..");
  const cleanup: Array<() => Promise<unknown>> = [() => rm(root, { recursive: true, force: true })];
  const errors: string[] = [];
  const close = async () => {
    const failures: unknown[] = [];
    for (const dispose of cleanup.toReversed()) {
      try {
        await dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    cleanup.length = 0;
    if (failures.length) throw new AggregateError(failures, "Private proof teardown failed");
  };
  try {
    const proof = randomBytes(12).toString("hex");
    const password = randomBytes(24).toString("hex");
    const fixture = await startHostFixture(proof, options.scenario);
    cleanup.push(fixture.close);
    const shell = await buildProductShellAssets({
      appRoot,
      controlOrigin: CONTROL,
      assetVersion: options.mixedAssets ? `${assetVersion}-mixed` : assetVersion,
      sessionReplyTimeoutMs: 10_000,
      worker: {
        headTimeoutMs: 10_000,
        idleChunkTimeoutMs: 10_000,
        maxRequestBodyBytes: 1_048_576,
        ticketTtlMs: 10_000,
        formationTtlMs: 10_000,
        resyncTimeoutMs: 5_000,
      },
    });
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      path.join(artifactDirectory, "manifest.json"),
      JSON.stringify({ manifest: shell.manifest, manifestSha256: shell.manifestSha256 }, null, 2),
    );
    for (const asset of shell.assets) {
      await writeFile(path.join(artifactDirectory, path.basename(asset.path)), asset.bytes);
    }
    const hostInput = path.join(root, "host.json");
    await writeFile(
      hostInput,
      JSON.stringify({
        root,
        password,
        controlOrigin: CONTROL,
        networkFetch:
          options.networkMode === "absent"
            ? undefined
            : {
                enabled: options.networkMode !== "disabled",
                dedicatedContentDomain: CONTENT_DOMAIN,
                controlOrigin: CONTROL,
                assetVersion,
                bootstrapPath: shell.manifest.bootstrapPath,
                pathPrefix: "/app/",
                ttlMs: 120_000,
                handshakeTimeoutMs: 20_000,
                allowlists: [
                  {
                    id: "product-proof",
                    revision: 1,
                    targets: [{ origin: fixture.origin, pathPrefix: "/app/" }],
                  },
                ],
              },
      }),
      { mode: 0o600 },
    );
    const child = spawnTsx(path.join(__dirname, "host.ts"), [hostInput], {
      cwd: path.resolve(appRoot, "../server"),
      env: privateHostEnvironment(root, options),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.stderr?.on("data", (data: Buffer) => {
      errors.push(data.toString());
      if (errors.length > 40) errors.shift();
    });
    cleanup.push(async () => {
      if (child.connected) child.send("stop");
      await killProcessTree(child);
    });
    const host = await waitForHost(child);
    const Client = await loadDaemonClientConstructor<DaemonClientConfig, DaemonClient>();
    const client = new Client({
      url: `ws://127.0.0.1:${host.port}/ws`,
      clientId: `product-proof-${proof}`,
      clientType: "cli",
      password,
      appVersion: JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8")).version,
      webSocketFactory: createNodeWebSocketFactory() as NonNullable<
        DaemonClientConfig["webSocketFactory"]
      >,
    });
    cleanup.push(() => client.close());
    await client.connect();
    await client.fetchAgents();
    assertImageUnavailable(client, options);
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    const created = await client.createWorkspace({
      source: { kind: "directory", path: workspacePath },
      title: "Product proof workspace",
    });
    if (!created.workspace || created.error)
      throw new Error(created.error ?? "Workspace was not created");
    const gateway = await startProductGateway({ root, metroPort, daemonPort: host.port, shell });
    cleanup.push(gateway.close);
    const egress = await startBrowserEgress(gateway.port);
    cleanup.push(egress.close);
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      args: [
        `--ignore-certificate-errors-spki-list=${gateway.certificatePin}`,
        `--proxy-server=http://127.0.0.1:${egress.port}`,
        "--proxy-bypass-list=<-loopback>",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      ],
    });
    cleanup.push(() => browser.close());
    const browserCdp = await browser.newBrowserCDPSession();
    const { arguments: argv } = await browserCdp.send("Browser.getBrowserCommandLine");
    await browserCdp.detach();
    if (
      argv.includes("--no-sandbox") ||
      argv.includes("--ignore-certificate-errors") ||
      !argv.includes(`--ignore-certificate-errors-spki-list=${gateway.certificatePin}`) ||
      !argv.includes("--proxy-bypass-list=<-loopback>")
    ) {
      throw new Error("Chromium runtime does not match sandbox/SPKI/egress isolation");
    }
    const context = await browser.newContext({
      baseURL: CONTROL,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    });
    const unexpectedRequests: string[] = [];
    context.on("request", (request) => {
      const url = new URL(request.url());
      if (!["http:", "https:"].includes(url.protocol)) return;
      if (
        url.origin === CONTROL ||
        (url.protocol === "https:" && /^[a-z0-9-]{1,63}\.ticket04-content\.test$/u.test(url.host))
      )
        return;
      unexpectedRequests.push(request.url());
    });
    const page = await context.newPage();
    const observation = options.observeChannels
      ? await observeProductChannels(page, runtimeOptions.observeReceipts)
      : null;
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(30_000);
    await seedControl(page, host.serverId, password, runtimeOptions.domOptIn);
    return {
      page,
      close,
      client,
      proof,
      workspaceId: created.workspace.id,
      serverId: host.serverId,
      targetUrl: `${fixture.origin}/app/start?proof=${proof}`,
      unexpectedRequests,
      requests: fixture.requests,
      observation,
      evidence: () => ({
        metroBinding,
        chromiumArgv: argv,
        manifest: shell.manifest,
        manifestSha256: shell.manifestSha256,
        scenario: options,
        hostNetworkFetch: {
          supported: client.isNetworkFetchSupported(),
          configured: client.getLastServerInfoMessage()?.networkFetchConfiguration !== undefined,
        },
        imageRendererSupported: client.getLastServerInfoMessage()?.features?.remoteBrowser === true,
        served: gateway.served,
        denied: egress.denied,
        unexpectedRequests,
        requests: fixture.requests,
        ...(observation && {
          portObservations: observation.messages,
          rpcTypes: observation.rpcTypes,
          observationOverflow: observation.overflow(),
        }),
      }),
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw new Error(
      `Product harness failed: ${error instanceof Error ? error.message : String(error)}\n${errors.join("")}`,
      { cause: error },
    );
  }
}
