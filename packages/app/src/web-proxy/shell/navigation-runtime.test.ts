import { createServer } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { expect, it } from "vitest";
import type { NavigationToBrokerMessage } from "../navigation-messages";

it("observes real Documents and history with admission signals supplied at the observer boundary", async () => {
  let page: Page | null = null;
  let requestId = 0;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://local.test").pathname;
    if (pathname === "/") {
      response.end(
        '<!doctype html><iframe id="app" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>',
      );
      return;
    }
    if (pathname !== "/a" && pathname !== "/b") {
      response.writeHead(404).end();
      return;
    }
    requests.push(pathname);
    const id = ++requestId;
    void page
      ?.evaluate(
        ({ id: admittedId, path }) => {
          const runtime = (
            window as unknown as { runtime: { admit(id: number, path: string): void } }
          ).runtime;
          runtime.admit(admittedId, path);
        },
        { id, path: request.url ?? pathname },
      )
      .then(
        () => {
          response.setHeader("Content-Type", "text/html");
          response.setHeader("Cache-Control", "no-store");
          response.end(
            `<!doctype html><title>${pathname}</title><p id="page">${pathname}</p><a href="/b">next</a>`,
          );
          return null;
        },
        () => response.writeHead(500).end(),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing local test listener");
  const origin = `http://127.0.0.1:${address.port}`;
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      args: ["--no-proxy-server"],
      ignoreDefaultArgs: ["--disable-back-forward-cache"],
    });
    page = await browser.newPage();
    await page.goto(origin);
    const sourcePath = fileURLToPath(new URL("./navigation.web.ts", import.meta.url));
    const source = `
      import { createShellNavigation } from ${JSON.stringify(sourcePath)};
      const frame = document.getElementById("app");
      const messages = [];
      const navigation = createShellNavigation({ frame, origin: location.origin, assetVersion: "runtime-v1", timeoutMs: 4000,
        enter: async (path) => { frame.src = path; return true; }, send: (message) => messages.push(message) });
      navigation.activate({ generation: 1, shellInstance: "runtime" });
      let operationId = 0;
      window.runtime = { messages, command: (kind, path) => {
        const command = kind === "navigate" ? { kind, url: new URL(path, location.origin).href } : { kind };
        void navigation.command({ type: "paseo.web.navigation.command", v: 1, generation: 1, shellInstance: "runtime", sequence: ++operationId, operationId, command });
        return operationId;
      }, admit: (requestId, path) => {
        navigation.request({ type: "paseo.web.request", v: 1, generation: 1, requestId, method: "GET", path, headers: [], body: null, mode: "navigate" });
        navigation.response({ type: "paseo.web.response.head", v: 1, generation: 1, requestId, status: 200, statusText: "OK", headers: [] });
        navigation.response({ type: "paseo.web.response.end", v: 1, generation: 1, requestId });
      }, stop: () => navigation.dispose() };
    `;
    const bundle = await build({
      stdin: { contents: source, loader: "ts", resolveDir: dirname(sourcePath) },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      logLevel: "silent",
    });
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    async function command(kind: string, path = "") {
      if (page === null) throw new Error("Page closed");
      const operationId = await page.evaluate(
        ({ kind: operation, path: target }) => {
          return (
            window as unknown as { runtime: { command(kind: string, path: string): number } }
          ).runtime.command(operation, target);
        },
        { kind, path },
      );
      await page.waitForFunction((id) => {
        const messages = (
          window as unknown as { runtime: { messages: NavigationToBrokerMessage[] } }
        ).runtime.messages;
        return messages.some(
          (message) =>
            message.type === "paseo.web.navigation.result" && message.outcome.operationId === id,
        );
      }, operationId);
      return page.evaluate((id) => {
        const messages = (
          window as unknown as { runtime: { messages: NavigationToBrokerMessage[] } }
        ).runtime.messages;
        return messages.find(
          (message) =>
            message.type === "paseo.web.navigation.result" && message.outcome.operationId === id,
        );
      }, operationId);
    }
    const first = await command("navigate", "/a?initial=1");
    expect(first).toMatchObject({
      outcome: { status: "committed", commit: { kind: "network", requestId: 1 } },
    });
    expect(await page.frames()[1]?.locator("#page").textContent()).toBe("/a");
    const second = await command("navigate", "/b");
    expect(second).toMatchObject({
      outcome: { status: "committed", commit: { kind: "network", requestId: 2 } },
    });
    const reloaded = await command("reload");
    expect(reloaded).toMatchObject({
      outcome: { status: "committed", commit: { kind: "network", requestId: 3 } },
    });
    if (
      second?.type === "paseo.web.navigation.result" &&
      reloaded?.type === "paseo.web.navigation.result" &&
      second.outcome.status === "committed" &&
      reloaded.outcome.status === "committed"
    ) {
      expect(reloaded.outcome.documentId).not.toBe(second.outcome.documentId);
      expect(reloaded.outcome.entryKey).toBe(second.outcome.entryKey);
    }
    const beforeBack = requests.length;
    const back = await command("back");
    const backObservation = await page.frames()[1]?.evaluate(() => ({
      url: location.href,
      timing: performance.getEntriesByType("navigation").map((entry) => entry.toJSON()),
    }));
    expect(back, JSON.stringify({ back, requests, backObservation })).toMatchObject({
      outcome: { status: "committed" },
    });
    expect(await page.frames()[1]?.locator("#page").textContent()).toBe("/a");
    if (
      back?.type === "paseo.web.navigation.result" &&
      back.outcome.status === "committed" &&
      back.outcome.commit.kind === "bfcache"
    )
      expect(requests).toHaveLength(beforeBack);
    const hash = await command("navigate", "/a?initial=1#section");
    expect(hash).toMatchObject({
      outcome: { status: "committed", commit: { kind: "same_document" } },
    });
    await page.evaluate(() => (window as unknown as { runtime: { stop(): void } }).runtime.stop());
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}, 30_000);
