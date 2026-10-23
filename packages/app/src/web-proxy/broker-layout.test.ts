import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("fills and shrinks with the flex surface, including a reopened frame", async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => route.abort());
    await page.setContent(
      '<!doctype html><div id="root" style="width:960px;height:540px;display:flex"><div id="surface" style="display:flex;flex-direction:column;flex:1;min-width:0;min-height:0"></div></div>',
    );
    const sourcePath = fileURLToPath(new URL("./broker.web.ts", import.meta.url));
    const bundled = await build({
      stdin: {
        contents: `
        import { attachWebProxyBroker } from ${JSON.stringify(sourcePath)};
        const surface = document.getElementById("surface");
        let calls = 0;
        const broker = attachWebProxyBroker({ container: surface,
          capability: { contentOrigin: "https://size.ticket04-content.test", destinationOrigin: "http://127.0.0.1:8123", pathPrefix: "/" },
          bootstrapPath: "/__paseo/size/bootstrap.html", handshakeTimeoutMs: 30000,
          transport: { request: async () => { calls++; throw new Error("Unexpected transport request"); } } });
        window.layoutTest = { snapshot: () => {
          const frame = broker.getFrame();
          const bounds = frame.getBoundingClientRect();
          const parent = surface.getBoundingClientRect();
          return { width: bounds.width, height: bounds.height, parentWidth: parent.width, parentHeight: parent.height,
            sandbox: frame.getAttribute("sandbox"), referrerPolicy: frame.referrerPolicy, border: getComputedStyle(frame).borderWidth, calls };
        }, resize: () => { Object.assign(document.getElementById("root").style, { width: "360px", height: "280px" }); },
          reopen: () => broker.reopen(), close: () => broker.dispose() };
      `,
        loader: "ts",
        resolveDir: dirname(sourcePath),
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      logLevel: "silent",
    });
    await page.addScriptTag({ content: bundled.outputFiles[0]!.text });
    async function snapshot() {
      return page.evaluate(() =>
        (
          window as unknown as { layoutTest: { snapshot(): Record<string, unknown> } }
        ).layoutTest.snapshot(),
      );
    }
    expect(await snapshot()).toMatchObject({
      width: 960,
      height: 540,
      parentWidth: 960,
      parentHeight: 540,
      border: "0px",
      calls: 0,
      sandbox: "allow-scripts allow-same-origin allow-forms",
      referrerPolicy: "no-referrer",
    });
    await page.evaluate(() =>
      (window as unknown as { layoutTest: { resize(): void } }).layoutTest.resize(),
    );
    expect(await snapshot()).toMatchObject({
      width: 360,
      height: 280,
      parentWidth: 360,
      parentHeight: 280,
    });
    await page.evaluate(() =>
      (window as unknown as { layoutTest: { reopen(): void } }).layoutTest.reopen(),
    );
    expect(await snapshot()).toMatchObject({
      width: 360,
      height: 280,
      parentWidth: 360,
      parentHeight: 280,
      calls: 0,
    });
    await page.evaluate(() =>
      (window as unknown as { layoutTest: { close(): void } }).layoutTest.close(),
    );
  } finally {
    await browser.close();
  }
}, 30_000);
