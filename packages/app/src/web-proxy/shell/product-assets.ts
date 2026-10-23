import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import type { ShellWorkerConfig } from "./worker.web";

export interface ProductShellAssetOptions {
  appRoot: string;
  controlOrigin: string;
  assetVersion: string;
  sessionReplyTimeoutMs: number;
  worker: Pick<
    ShellWorkerConfig,
    | "headTimeoutMs"
    | "idleChunkTimeoutMs"
    | "maxRequestBodyBytes"
    | "ticketTtlMs"
    | "formationTtlMs"
    | "resyncTimeoutMs"
  >;
}

export interface ProductShellAsset {
  path: string;
  contentType: string;
  bytes: Uint8Array;
  sha256: string;
  headers: Record<string, string>;
}

export interface ProductShellManifest {
  v: 1;
  assetVersion: string;
  controlOrigin: string;
  bootstrapPath: string;
  workerPath: string;
  enterPath: string;
  workerScope: "/";
  assets: Array<{ path: string; sha256: string; contentType: string }>;
}

export interface ProductShellAssets {
  manifest: ProductShellManifest;
  manifestSha256: string;
  assets: ProductShellAsset[];
}

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateOptions(options: ProductShellAssetOptions): void {
  const origin = new URL(options.controlOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.controlOrigin) {
    throw new Error("Product shell requires an exact HTTPS control origin");
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(options.assetVersion) || !path.isAbsolute(options.appRoot)) {
    throw new Error("Invalid product shell version or app root");
  }
  for (const value of [options.sessionReplyTimeoutMs, ...Object.values(options.worker)]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2 ** 31 - 1) {
      throw new Error("Invalid product shell bound");
    }
  }
}

export async function buildProductShellAssets(
  options: ProductShellAssetOptions,
): Promise<ProductShellAssets> {
  validateOptions(options);
  const directory = `/__paseo/${options.assetVersion}`;
  const bootstrapPath = `${directory}/bootstrap.html`;
  const scriptPath = `${directory}/bootstrap.js`;
  const workerPath = `${directory}/worker.js`;
  const enterPath = `${directory}/enter`;
  const bootstrapOptions = {
    controlOrigin: options.controlOrigin,
    workerUrl: workerPath,
    workerScope: "/",
    workerType: "classic",
    enterPath,
    sessionReplyTimeoutMs: options.sessionReplyTimeoutMs,
    navigation: { assetVersion: options.assetVersion },
  };
  const workerOptions = {
    ...options.worker,
    controlOrigin: options.controlOrigin,
    shellPathPrefix: "/__paseo/",
    bootstrapPath,
    enterPath,
    mountPath: "/",
    navigation: { assetVersion: options.assetVersion },
  };
  const sourcePath = (file: string) =>
    JSON.stringify(path.join(options.appRoot, "src/web-proxy/shell", file));
  const sources = [
    {
      path: scriptPath,
      source: `import { startShellBootstrap } from ${sourcePath("bootstrap.web.ts")};\nvoid startShellBootstrap({ window, ...${JSON.stringify(bootstrapOptions)} });`,
    },
    {
      path: workerPath,
      source: `import { installShellWorker } from ${sourcePath("worker.web.ts")};\ninstallShellWorker(globalThis, ${JSON.stringify(workerOptions)});`,
    },
  ];
  const esbuild: typeof import("esbuild") = createRequire(
    path.join(options.appRoot, "package.json"),
  )("esbuild");
  const assets: ProductShellAsset[] = [];
  for (const source of sources) {
    const built = await esbuild.build({
      stdin: {
        contents: source.source,
        resolveDir: options.appRoot,
        sourcefile: source.path,
        loader: "ts",
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "es2022",
      write: false,
      sourcemap: false,
      logLevel: "silent",
    });
    const bytes = built.outputFiles[0]?.contents;
    if (bytes === undefined) throw new Error("Product shell bundle missing");
    assets.push({
      path: source.path,
      contentType: "text/javascript; charset=utf-8",
      bytes,
      sha256: digest(bytes),
      headers: { "Cache-Control": "no-store", "Service-Worker-Allowed": "/" },
    });
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;width:100%;height:100%}iframe{border:0;width:100%;height:100%}</style></head><body><script src="${scriptPath}"></script></body></html>`;
  const bytes = new TextEncoder().encode(html);
  assets.push({
    path: bootstrapPath,
    contentType: "text/html; charset=utf-8",
    bytes,
    sha256: digest(bytes),
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors ${options.controlOrigin}; object-src 'none'; base-uri 'none'`,
    },
  });
  const manifest: ProductShellManifest = {
    v: 1,
    assetVersion: options.assetVersion,
    controlOrigin: options.controlOrigin,
    bootstrapPath,
    workerPath,
    enterPath,
    workerScope: "/",
    assets: assets.map(({ path: assetPath, sha256, contentType }) => ({
      path: assetPath,
      sha256,
      contentType,
    })),
  };
  return { manifest, manifestSha256: digest(JSON.stringify(manifest)), assets };
}
