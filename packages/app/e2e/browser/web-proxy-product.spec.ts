import { test, expect, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { startProductHarness } from "../support/web-proxy-product/harness";
import { waitForTabBar } from "../support/helpers/launcher";

test("E1 opens a host URL through the actual workspace browser panel", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120_000);
  const harness = await startProductHarness(testInfo.outputPath("product-assets"));
  const { page } = harness;
  try {
    await page.goto("/");
    const workspace = page.getByTestId(
      `sidebar-workspace-row-${harness.serverId}:${harness.workspaceId}`,
    );
    await expect(workspace).toBeVisible({ timeout: 30_000 });
    await workspace.click();
    await waitForTabBar(page);
    await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
    await page
      .getByTestId("workspace-new-tab-menu-browser")
      .filter({ visible: true })
      .first()
      .click();
    const pane = page.getByTestId("dom-proxy-pane");
    await expect(pane).toBeVisible();
    const input = pane.getByTestId("dom-proxy-url");
    await input.fill(harness.targetUrl);
    await pane.getByRole("button", { name: "Go", exact: true }).click();
    await expect
      .poll(
        () =>
          harness.requests.some(
            (request) =>
              request.method === "GET" && request.path === `/app/start?proof=${harness.proof}`,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    const document = page
      .getByTestId("dom-proxy-resident-surface")
      .frameLocator("iframe")
      .frameLocator("iframe");
    await expect(document.locator("#product-proof")).toHaveText(harness.proof, { timeout: 30_000 });
    await expect(document.locator("#product-path")).toHaveText(`/app/start?proof=${harness.proof}`);
    await expect(input).toHaveValue(harness.targetUrl);
    // Expo's web camera imports this decoder during app startup. The isolated proxy must
    // deny that attempt; it is neither a fetched dependency nor a product destination.
    const cameraDecoder = "https://cdn.jsdelivr.net/npm/jsqr@1.2.0/dist/jsQR.min.js";
    expect(harness.unexpectedRequests.filter((url) => url !== cameraDecoder)).toEqual([]);
    if (harness.unexpectedRequests.includes(cameraDecoder)) {
      expect(harness.evidence().denied).toContain("cdn.jsdelivr.net:443");
    }
    await expect(
      page
        .locator('[data-testid^="workspace-tab-"]')
        .filter({ hasText: `Product first ${harness.proof}` })
        .filter({ visible: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("E1-real-workspace-browser.png"),
      fullPage: true,
    });
  } finally {
    try {
      const evidence = JSON.stringify(harness.evidence(), null, 2);
      await writeFile(testInfo.outputPath("E1-private-evidence.json"), evidence);
      await writeFile(
        testInfo.outputPath("E1-final-page.txt"),
        await page.locator("body").innerText({ timeout: 5_000 }),
      );
      await page.screenshot({
        path: testInfo.outputPath("E1-final-state.png"),
        fullPage: true,
        timeout: 5_000,
      });
      await testInfo.attach("E1-private-evidence", {
        body: evidence,
        contentType: "application/json",
      });
    } finally {
      await harness.close();
    }
  }
});

type ProductHarness = Awaited<ReturnType<typeof startProductHarness>>;

async function openInitialDocument(harness: ProductHarness) {
  const { page } = harness;
  await page.goto("/");
  const workspace = page.getByTestId(
    `sidebar-workspace-row-${harness.serverId}:${harness.workspaceId}`,
  );
  await expect(workspace).toBeVisible({ timeout: 30_000 });
  await workspace.click();
  await waitForTabBar(page);
  await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
  await page
    .getByTestId("workspace-new-tab-menu-browser")
    .filter({ visible: true })
    .first()
    .click();
  const pane = page.getByTestId("dom-proxy-pane");
  const input = pane.getByTestId("dom-proxy-url");
  await input.fill(harness.targetUrl);
  await pane.getByRole("button", { name: "Go", exact: true }).click();
  const document = page
    .getByTestId("dom-proxy-resident-surface")
    .frameLocator("iframe")
    .frameLocator("iframe");
  await expect(document.locator("#product-proof")).toHaveText(harness.proof, { timeout: 30_000 });
  return { pane, input, document };
}

async function finishProductProof(harness: ProductHarness, testInfo: TestInfo) {
  try {
    await writeFile(
      testInfo.outputPath("private-evidence.json"),
      JSON.stringify(harness.evidence(), null, 2),
    );
    await writeFile(
      testInfo.outputPath("final-page.txt"),
      await harness.page.locator("body").innerText({ timeout: 5_000 }),
    );
    await harness.page.screenshot({
      path: testInfo.outputPath("final-state.png"),
      fullPage: true,
      timeout: 5_000,
    });
  } finally {
    await harness.close();
  }
}

function assertProductEgress(harness: ProductHarness) {
  const decoder = "https://cdn.jsdelivr.net/npm/jsqr@1.2.0/dist/jsQR.min.js";
  expect(harness.unexpectedRequests.filter((url) => url !== decoder)).toEqual([]);
  if (harness.unexpectedRequests.includes(decoder)) {
    expect(harness.evidence().denied).toContain("cdn.jsdelivr.net:443");
  }
}

test("E2 follows a real content link and confirms metadata and responsive frame bounds", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120_000);
  const harness = await startProductHarness(testInfo.outputPath("product-assets"));
  try {
    const { pane, input, document } = await openInitialDocument(harness);
    await document.locator("#product-next").click();
    const secondPath = `/app/second?proof=${harness.proof}`;
    await expect(document.locator("#product-path")).toHaveText(secondPath, { timeout: 30_000 });
    await expect(input).toHaveValue(new URL(secondPath, harness.targetUrl).href);
    await expect(
      harness.page
        .locator('[data-testid^="workspace-tab-"]')
        .filter({ hasText: `Product second ${harness.proof}` })
        .filter({ visible: true }),
    ).toBeVisible();
    expect(
      harness.requests.filter((request) => request.method === "GET" && request.path === secondPath),
    ).toHaveLength(1);
    const residentSurface = harness.page.getByTestId("dom-proxy-resident-surface");
    const originalFrame = await residentSurface.locator(":scope > iframe").elementHandle();
    if (!originalFrame) throw new Error("Resident frame missing before resize");
    const originalDocument = await document
      .locator("body")
      .evaluateHandle((body) => body.ownerDocument);
    const marker = `unpersisted-${harness.proof}`;
    await document.locator("body").evaluate((body, value) => {
      const stateInput = body.ownerDocument.createElement("input");
      stateInput.id = "lifetime-unpersisted";
      stateInput.value = value;
      body.append(stateInput);
    }, marker);
    const requestsBeforeResize = harness.requests.length;
    for (const [index, viewport] of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
      { width: 1280, height: 900 },
    ].entries()) {
      await harness.page.setViewportSize(viewport);
      const surface = pane.getByTestId("dom-proxy-surface");
      await expect(surface).toBeVisible();
      await expect
        .poll(async () => {
          const parent = await surface.boundingBox();
          const frame = await residentSurface.locator(":scope > iframe").boundingBox();
          return (
            parent !== null &&
            frame !== null &&
            parent.width === frame.width &&
            parent.height === frame.height
          );
        })
        .toBe(true);
      expect(await originalFrame.evaluate((node) => node.isConnected)).toBe(true);
      expect(
        await residentSurface
          .locator(":scope > iframe")
          .evaluate((node, original) => node === original, originalFrame),
      ).toBe(true);
      expect(await originalDocument.evaluate((original) => original === globalThis.document)).toBe(
        true,
      );
      await expect(document.locator("#lifetime-unpersisted")).toHaveValue(marker);
      expect(harness.requests).toHaveLength(requestsBeforeResize);
      await harness.page.screenshot({
        path: testInfo.outputPath(`E2-${index}-${viewport.width}.png`),
        fullPage: true,
        timeout: 5_000,
      });
    }
    await originalDocument.dispose();
    await originalFrame.dispose();
    assertProductEgress(harness);
  } finally {
    await finishProductProof(harness, testInfo);
  }
});

test("U1 preserves the resident document behind menus, drawers and inactive tabs until Stop", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120_000);
  const harness = await startProductHarness(testInfo.outputPath("product-assets"));
  const { page } = harness;
  try {
    const { pane, document } = await openInitialDocument(harness);
    const originalDocument = await document
      .locator("body")
      .evaluateHandle((body) => body.ownerDocument);
    const resident = page.getByTestId("dom-proxy-resident-window");
    const requests = harness.requests.length;
    const originalFrame = await resident.locator(":scope > div > iframe").elementHandle();
    if (!originalFrame) throw new Error("Resident iframe missing");
    async function assertPreserved() {
      expect(await originalDocument.evaluate((value) => value === globalThis.document)).toBe(true);
      expect(await originalFrame!.evaluate((value) => value.isConnected)).toBe(true);
      expect(harness.requests).toHaveLength(requests);
    }
    async function expectFence(inert: boolean) {
      await expect(resident).toHaveJSProperty("inert", inert);
      if (inert) await expect(resident).toHaveCSS("visibility", "hidden");
      else await expect(resident).toHaveCSS("visibility", "visible");
    }
    const addTab = page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first();
    await addTab.click();
    await expect(
      page.getByTestId("workspace-new-tab-menu").filter({ visible: true }),
    ).toBeVisible();
    await expectFence(true);
    await assertPreserved();
    await page.keyboard.press("Escape");
    await expectFence(false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectFence(false);
    await page.getByTestId("menu-button").filter({ visible: true }).first().click();
    await expect(page.getByTestId("agent-list-backdrop")).toBeVisible();
    await expectFence(true);
    await assertPreserved();
    await page.getByTestId("sidebar-close").click();
    await expectFence(false);
    await assertPreserved();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expectFence(false);
    await addTab.click();
    await page
      .getByTestId("workspace-new-tab-menu-browser")
      .filter({ visible: true })
      .first()
      .click();
    // The blank second browser owns a separate surface. The first remains connected but inert.
    await expect(page.getByTestId("dom-proxy-resident-window")).toHaveCount(2);
    await expect(page.getByTestId("dom-proxy-resident-window").first()).toHaveJSProperty(
      "inert",
      true,
    );
    await assertPreserved();
    await page
      .locator('[data-testid^="workspace-tab-"]')
      .filter({ hasText: `Product first ${harness.proof}` })
      .filter({ visible: true })
      .click();
    await expect(page.getByTestId("dom-proxy-resident-window").first()).toHaveJSProperty(
      "inert",
      false,
    );
    await assertPreserved();
    await pane.filter({ visible: true }).getByRole("button", { name: "Stop", exact: true }).click();
    await expect.poll(() => originalFrame!.evaluate((value) => value.isConnected)).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(
      page.getByTestId("dom-proxy-resident-window").first().locator("iframe"),
    ).toHaveCount(0);
    expect(harness.requests).toHaveLength(requests);
    await page.screenshot({
      path: testInfo.outputPath("U1-stopped-no-reopen.png"),
      fullPage: true,
    });
    await originalFrame.dispose();
    await originalDocument.dispose();
    assertProductEgress(harness);
  } finally {
    await finishProductProof(harness, testInfo);
  }
});

test("U2 fences during an actual edge drag and preserves the document across viewport changes", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120_000);
  const harness = await startProductHarness(testInfo.outputPath("product-assets"));
  const { page } = harness;
  try {
    const { document, input } = await openInitialDocument(harness);
    const originalDocument = await document
      .locator("body")
      .evaluateHandle((body) => body.ownerDocument);
    const resident = page.getByTestId("dom-proxy-resident-window");
    const requests = harness.requests.length;
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(resident).toHaveJSProperty("inert", false);
    await page.mouse.move(2, 110);
    await page.mouse.down();
    try {
      await page.mouse.move(90, 110, { steps: 8 });
      await expect(resident).toHaveJSProperty("inert", true);
      await expect(resident).toHaveCSS("visibility", "hidden");
      // Still held: this samples gesture motion before the release commits a panel command.
      expect(await originalDocument.evaluate((value) => value === globalThis.document)).toBe(true);
      await page.mouse.move(330, 110, { steps: 12 });
    } finally {
      await page.mouse.up();
    }
    await expect(page.getByTestId("sidebar-close")).toBeVisible();
    await page.getByTestId("sidebar-close").click();
    await expect(resident).toHaveJSProperty("inert", false);
    await input.focus();
    await page.setViewportSize({ width: 390, height: 500 });
    await expect(resident).toHaveJSProperty("inert", false);
    const bounds = await resident.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(500);
    await expect(input).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(resident).toHaveJSProperty("inert", false);
    expect(await originalDocument.evaluate((value) => value === globalThis.document)).toBe(true);
    expect(harness.requests).toHaveLength(requests);
    await page.screenshot({
      path: testInfo.outputPath("U2-after-drag-viewport.png"),
      fullPage: true,
    });
    await originalDocument.dispose();
    assertProductEgress(harness);
  } finally {
    await finishProductProof(harness, testInfo);
  }
});

test("E3 refreshes through the real panel with a new GET and Document", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120_000);
  const harness = await startProductHarness(testInfo.outputPath("product-assets"));
  try {
    const { pane, input, document } = await openInitialDocument(harness);
    const firstDocument = await document.locator("body").evaluate(() => performance.timeOrigin);
    const path = `/app/start?proof=${harness.proof}`;
    expect(
      harness.requests.filter((request) => request.method === "GET" && request.path === path),
    ).toHaveLength(1);
    await pane.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect
      .poll(
        () =>
          harness.requests.filter((request) => request.method === "GET" && request.path === path)
            .length,
      )
      .toBe(2);
    await expect
      .poll(() => document.locator("body").evaluate(() => performance.timeOrigin))
      .not.toBe(firstDocument);
    await expect(document.locator("#product-proof")).toHaveText(harness.proof);
    await expect(document.locator("#product-path")).toHaveText(path);
    await expect(input).toHaveValue(harness.targetUrl);
    await expect(
      harness.page
        .locator('[data-testid^="workspace-tab-"]')
        .filter({ hasText: `Product first ${harness.proof}` })
        .filter({ visible: true }),
    ).toBeVisible();
    assertProductEgress(harness);
  } finally {
    await finishProductProof(harness, testInfo);
  }
});
