import { test, expect } from "@playwright/test";
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
    const document = pane
      .getByTestId("dom-proxy-surface")
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
