import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildProductShellAssets, type ProductShellAssetOptions } from "./product-assets";

const options: ProductShellAssetOptions = {
  appRoot: fileURLToPath(new URL("../../../", import.meta.url)),
  controlOrigin: "https://control.ticket04-control.test",
  assetVersion: "ticket04-product-nav-v1",
  sessionReplyTimeoutMs: 1000,
  worker: {
    headTimeoutMs: 30000,
    idleChunkTimeoutMs: 30000,
    maxRequestBodyBytes: 1048576,
    ticketTtlMs: 5000,
    formationTtlMs: 5000,
    resyncTimeoutMs: 1000,
  },
};

describe("product shell assets", () => {
  it("bundles product sources with exact origins, versioned paths and content hashes", async () => {
    const result = await buildProductShellAssets(options);
    expect(result.manifest.bootstrapPath).toBe("/__paseo/ticket04-product-nav-v1/bootstrap.html");
    expect(result.manifest.workerScope).toBe("/");
    expect(result.assets).toHaveLength(3);
    expect(result.manifestSha256).toBe(
      createHash("sha256").update(JSON.stringify(result.manifest)).digest("hex"),
    );
    for (const asset of result.assets) {
      expect(asset.sha256).toBe(createHash("sha256").update(asset.bytes).digest("hex"));
      const source = new TextDecoder().decode(asset.bytes);
      expect(source).not.toContain("__fixtures__");
      expect(source).not.toContain("HARNESS");
      if (asset.path.endsWith(".js")) expect(source).toContain(options.controlOrigin);
      else expect(asset.headers["Content-Security-Policy"]).toContain(options.controlOrigin);
    }
    const worker = result.assets.find((asset) => asset.path === result.manifest.workerPath);
    expect(worker?.headers["Service-Worker-Allowed"]).toBe("/");
    expect(result.assets.some((asset) => asset.path === result.manifest.enterPath)).toBe(false);
  });

  it.each([
    { controlOrigin: "http://control.test" },
    { controlOrigin: "https://control.test/path" },
    { assetVersion: "../old" },
    { appRoot: "relative" },
    { sessionReplyTimeoutMs: 0 },
  ])("rejects invalid product options before build: %j", async (patch) => {
    await expect(buildProductShellAssets({ ...options, ...patch })).rejects.toThrow();
  });
});
