import { createServer } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright";
import { expect, it } from "vitest";

it.each(["timeout", "deactivate"])(
  "ignores a late ticket after %s without consuming the next attempt reply",
  async (failure) => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      if (request.url === "/") {
        response.end('<!doctype html><iframe id="app"></iframe>');
        return;
      }
      requests.push(request.url ?? "");
      response.end("<!doctype html><title>Entered</title>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let browser: Browser | null = null;
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing listener");
      browser = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        args: ["--no-proxy-server"],
      });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}`);
      const sourcePath = fileURLToPath(new URL("./navigation.web.ts", import.meta.url));
      const entryPath = fileURLToPath(new URL("./navigation-entry.web.ts", import.meta.url));
      const source = `
      import { createShellNavigation } from ${JSON.stringify(sourcePath)};
      import { enterProductNavigation } from ${JSON.stringify(entryPath)};
      const frame = document.getElementById("app");
      const channel = new MessageChannel();
      const messages = [];
      const tickets = [];
      let ticketId = 0;
      channel.port2.onmessage = (event) => tickets.push(event.data.ticket);
      const navigation = createShellNavigation({ frame, origin: location.origin, assetVersion: "entry-v1", timeoutMs: 200,
        enter: (target, authority) => enterProductNavigation({ frame, port: channel.port1, target,
          ticket: String(++ticketId).padStart(22, "0"), enterPath: "/enter", timeoutMs: 5000, ...authority }),
        send: (message) => messages.push(message) });
      navigation.activate({ generation: 1, shellInstance: "entry" });
      let operationId = 0;
      window.entryTest = { messages, tickets, command: () => {
        const id = ++operationId;
        void navigation.command({ type: "paseo.web.navigation.command", v: 1, generation: 1, shellInstance: "entry",
          sequence: id, operationId: id, command: { kind: "navigate", url: location.origin + "/page" } });
      }, deactivate: () => { navigation.deactivate(); navigation.activate({ generation: 1, shellInstance: "entry" }); },
        ready: (index) => channel.port2.postMessage({ type: "paseo.shell.ticket.ready", ticket: tickets[index] }),
        stop: () => { navigation.dispose(); channel.port1.close(); channel.port2.close(); } };
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
      await page.evaluate(() =>
        (window as unknown as { entryTest: { command(): void } }).entryTest.command(),
      );
      await page.waitForFunction(
        () =>
          (window as unknown as { entryTest: { tickets: string[] } }).entryTest.tickets.length ===
          1,
      );
      if (failure === "deactivate")
        await page.evaluate(() =>
          (window as unknown as { entryTest: { deactivate(): void } }).entryTest.deactivate(),
        );
      await page.waitForFunction(() =>
        (
          window as unknown as { entryTest: { messages: Array<{ outcome?: { status: string } }> } }
        ).entryTest.messages.some((message) => message.outcome?.status === "failed"),
      );
      await page.evaluate(() =>
        (window as unknown as { entryTest: { command(): void } }).entryTest.command(),
      );
      await page.waitForFunction(
        () =>
          (window as unknown as { entryTest: { tickets: string[] } }).entryTest.tickets.length ===
          2,
      );
      await page.evaluate(() =>
        (window as unknown as { entryTest: { ready(index: number): void } }).entryTest.ready(0),
      );
      await page.waitForTimeout(20);
      expect(await page.locator("#app").getAttribute("src")).toBeNull();
      expect(requests.filter((url) => url.startsWith("/enter"))).toEqual([]);
      await page.evaluate(() =>
        (window as unknown as { entryTest: { ready(index: number): void } }).entryTest.ready(1),
      );
      await page.waitForFunction(() =>
        document.querySelector("iframe")?.getAttribute("src")?.includes("0000000000000000000002"),
      );
      await expect
        .poll(() => requests.filter((url) => url.startsWith("/enter")))
        .toEqual(["/enter?t=0000000000000000000002"]);
      await page.evaluate(() =>
        (window as unknown as { entryTest: { stop(): void } }).entryTest.stop(),
      );
    } finally {
      await browser?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
    }
  },
  30_000,
);
