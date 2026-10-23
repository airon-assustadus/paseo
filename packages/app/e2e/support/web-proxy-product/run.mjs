import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Environment isolation must precede Playwright's globalSetup and its dotenv read.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const appRoot = path.join(repoRoot, "packages/app");
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
