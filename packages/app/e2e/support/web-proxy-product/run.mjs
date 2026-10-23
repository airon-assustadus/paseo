import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Environment isolation must precede Playwright's globalSetup and its dotenv read.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const appRoot = path.join(repoRoot, "packages/app");
async function runBrowserScenario() {
  const filter = process.argv[2] ?? "E1";
  const output = process.argv[3];
  const assetVersion = process.argv[4];
  const caseTitle = process.argv[5];
  if (!/^(?:E[1-8]|U[12])$/u.test(filter)) throw new Error("Select one E1..E8 or U1..U2 scenario");
  if (caseTitle !== undefined && (!caseTitle.startsWith(`${filter} `) || caseTitle.length > 256))
    throw new Error("Case title must belong to the selected scenario");
  const grep = caseTitle ? `${caseTitle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$` : filter;
  if (!output || !path.isAbsolute(output) || existsSync(output))
    throw new Error("Provide a new absolute evidence directory");
  if (!assetVersion || !/^ticket04-product-nav-v[1-9]\d*$/u.test(assetVersion))
    throw new Error("Provide an explicit immutable product asset version");
  for (const directory of [repoRoot, appRoot]) {
    const dotenvFiles = readdirSync(directory).filter(
      (name) => /^\.env(?:\.|$)/u.test(name) && !/\.(example|sample|template)$/u.test(name),
    );
    if (dotenvFiles.length)
      throw new Error(`E1 requires a checkout without dotenv inputs: ${directory}`);
  }
  if (!existsSync(path.join(repoRoot, "node_modules")))
    throw new Error("Private dependencies missing");
  const temporary = mkdtempSync(path.join(tmpdir(), "paseo-product-e2e-env-"));
  mkdirSync(output, { recursive: true });
  const environment = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "PLAYWRIGHT_BROWSERS_PATH"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  Object.assign(environment, {
    EXPO_NO_DOTENV: "1",
    EXPO_OFFLINE: "1",
    EXPO_NO_TELEMETRY: "1",
    __UNSAFE_EXPO_HOME_DIRECTORY: path.join(temporary, "expo"),
    npm_config_userconfig: "/dev/null",
    npm_config_update_notifier: "false",
    npm_config_cache: path.join(temporary, "npm-cache"),
    APP_VARIANT: "development",
    E2E_WORKERS: "1",
    CI: "1",
    PASEO_PRODUCT_E2E_ISOLATED: "1",
    PASEO_PRODUCT_BIND_LOG: path.join(temporary, "binds.jsonl"),
    PASEO_PRODUCT_ASSET_VERSION: assetVersion,
    NODE_OPTIONS: `--require=${JSON.stringify(path.join(appRoot, "e2e/support/web-proxy-product/loopback-only.cjs"))}`,
    NO_COLOR: "1",
  });
  const child = spawn(
    "npm",
    [
      "run",
      "test:e2e",
      "--workspace=@getpaseo/app",
      "--",
      "e2e/browser/web-proxy-product.spec.ts",
      "--grep",
      grep,
      "--output",
      output,
      "--retries=0",
      ...(["E6", "E7"].includes(filter) ? ["--max-failures=1"] : []),
    ],
    { cwd: repoRoot, env: environment, stdio: "inherit" },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode) => resolve(exitCode ?? 1));
    });
    process.exitCode = code;
  } finally {
    const bindLog = path.join(temporary, "binds.jsonl");
    if (existsSync(bindLog)) {
      mkdirSync(output, { recursive: true });
      copyFileSync(bindLog, path.join(output, "listener-addresses.jsonl"));
    }
    rmSync(temporary, { recursive: true, force: true });
  }
}

// This diagnostic uses Playwright's actual worker/transform loader without globalSetup.
async function runLoadCheck(mode, output) {
  if (!["static", "static-negative", "esm"].includes(mode)) throw new Error("Unknown load control");
  if (!output || !path.isAbsolute(output) || existsSync(output))
    throw new Error("Provide a new absolute load evidence directory");
  mkdirSync(output, { mode: 0o700 });
  const temporary = mkdtempSync(path.join(appRoot, ".product-load-"));
  try {
    const loader = path.join(appRoot, "e2e/support/helpers/daemon-client-loader.ts");
    const observation = path.join(appRoot, "e2e/support/web-proxy-product/observation.ts");
    const imports =
      mode === "esm"
        ? `import { loadProductFetchProtocol } from ${JSON.stringify(observation)};`
        : 'import { decodeNetworkFetchFrame, NetworkFetchOpcode } from "@getpaseo/protocol/binary-frames/network-fetch";';
    const source = `import { test, expect } from "@playwright/test";
import { loadDaemonClientConstructor } from ${JSON.stringify(loader)};
${imports}
test("canonical protocol and SDK load: ${mode}", async () => {
  ${mode === "esm" ? "const { decodeNetworkFetchFrame, NetworkFetchOpcode } = await loadProductFetchProtocol();" : ""}
  expect(typeof decodeNetworkFetchFrame).toBe("function");
  expect(typeof NetworkFetchOpcode.Request).toBe("number");
  expect(decodeNetworkFetchFrame(new Uint8Array(0), "host_to_client")).toBeNull();
  ${
    mode === "static-negative"
      ? `await expect(loadDaemonClientConstructor()).rejects.toThrow("does not provide an export named 'CLIENT_CAPS'");`
      : 'expect(typeof await loadDaemonClientConstructor()).toBe("function");'
  }
  process.stdout.write(JSON.stringify({ control: ${JSON.stringify(mode)}, decoder: true, opcodes: true, sdk: ${JSON.stringify(mode === "static-negative" ? "expected-rejection" : "loaded")}, browserRequested: false, globalSetup: false }) + "\\n");
});
`;
    const config = `module.exports = ${JSON.stringify({ testDir: temporary, testMatch: "load.spec.ts", workers: 1, retries: 0, maxFailures: 1, timeout: 15000, globalTimeout: 30000, reporter: [["list"], ["json", { outputFile: path.join(output, "result.json") }]], outputDir: path.join(output, "artifacts") })};\n`;
    writeFileSync(path.join(temporary, "load.spec.ts"), source, { mode: 0o600 });
    writeFileSync(path.join(temporary, "playwright.config.cjs"), config, { mode: 0o600 });
    writeFileSync(path.join(output, "load.spec.ts"), source, { mode: 0o600 });
    writeFileSync(path.join(output, "playwright.config.cjs"), config, { mode: 0o600 });
    const environment = {};
    for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TZ"]) {
      if (process.env[key] !== undefined) environment[key] = process.env[key];
    }
    Object.assign(environment, {
      CI: "1",
      NO_COLOR: "1",
      PWTEST_CACHE_DIR: path.join(output, "transform-cache"),
    });
    const args = [
      path.join(repoRoot, "node_modules/playwright/cli.js"),
      "test",
      "--config",
      path.join(temporary, "playwright.config.cjs"),
    ];
    process.stdout.write(
      JSON.stringify({ executable: process.execPath, args, cwd: appRoot, mode, output }) + "\n",
    );
    const child = spawn(process.execPath, args, {
      cwd: appRoot,
      env: environment,
      stdio: "inherit",
    });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    process.stdout.write(JSON.stringify({ loadTemporaryRemoved: !existsSync(temporary) }) + "\n");
  }
}

if (process.argv[2] === "LOAD") await runLoadCheck(process.argv[3], process.argv[4]);
else await runBrowserScenario();
