import { test, expect, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { startProductHarness } from "../support/web-proxy-product/harness";
import { waitForTabBar } from "../support/helpers/launcher";
import {
  NAVIGATION_LIMITS,
  parseNavigationToBroker,
  type NavigationState,
} from "../../src/web-proxy/navigation-messages";
import { CONTROL } from "../support/web-proxy-product/network";

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

async function openProductMenu(harness: ProductHarness) {
  const { page } = harness;
  await page.goto("/");
  const workspace = page.getByTestId(
    `sidebar-workspace-row-${harness.serverId}:${harness.workspaceId}`,
  );
  await expect(workspace).toBeVisible({ timeout: 30_000 });
  await workspace.click();
  await waitForTabBar(page);
  await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
}

async function openProductPanel(harness: ProductHarness) {
  await openProductMenu(harness);
  const { page } = harness;
  await page
    .getByTestId("workspace-new-tab-menu-browser")
    .filter({ visible: true })
    .first()
    .click();
}

async function openInitialDocument(harness: ProductHarness) {
  await openProductPanel(harness);
  const { page } = harness;
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

function observedNavigationStates(harness: ProductHarness): NavigationState[] {
  return (harness.observation?.messages ?? []).flatMap(({ message }) => {
    const parsed = parseNavigationToBroker(message);
    return parsed?.type === "paseo.web.navigation.state" ? [parsed.state] : [];
  });
}

async function expectObservedState(harness: ProductHarness, destination: string) {
  const target = new URL(destination);
  const latest = () => observedNavigationStates(harness).at(-1);
  await expect
    .poll(() => {
      const state = latest();
      if (!state) return null;
      const url = new URL(state.url);
      return `${url.pathname}${url.search}${url.hash}`;
    })
    .toBe(`${target.pathname}${target.search}${target.hash}`);
  const state = latest();
  if (!state) throw new Error("No observed navigation state");
  expect(state.documentId).not.toBe("");
  expect(state.entryKey).not.toBe("");
  return state;
}

function expectAdmittedNetworkState(harness: ProductHarness, state: NavigationState) {
  expect(state.commit.kind).toBe("network");
  if (state.commit.kind !== "network") throw new Error("Expected a network document commit");
  const requestId = state.commit.requestId;
  expect(
    harness.observation?.messages.some(
      ({ frameUrl, message }) =>
        new URL(frameUrl).origin === CONTROL &&
        message.type === "paseo.web.response.head" &&
        message.requestId === requestId,
    ),
  ).toBe(true);
}

function assertNoProductOpen(harness: ProductHarness) {
  expect(harness.observation?.overflow()).toBe(false);
  expect(harness.observation?.rpcTypes).toContain("hello");
  expect(harness.observation?.rpcTypes.filter((type) => type.startsWith("network.fetch."))).toEqual(
    [],
  );
  expect(harness.evidence().served).toEqual([]);
  expect(harness.requests).toEqual([]);
}

function observedNavigationResults(harness: ProductHarness) {
  return (harness.observation?.messages ?? []).flatMap(({ message }) => {
    const parsed = parseNavigationToBroker(message);
    return parsed?.type === "paseo.web.navigation.result" ? [parsed.outcome] : [];
  });
}

test("E5 rejects destination paths and redirects outside the admitted scope", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120_000);
  const harness = await startProductHarness(testInfo.outputPath("product-assets"), {
    scenario: "boundary",
    observeChannels: true,
  });
  try {
    const { pane, input } = await openInitialDocument(harness);
    const admitted = await expectObservedState(harness, harness.targetUrl);
    const outside = new URL(`/outside?proof=${harness.proof}`, harness.targetUrl).href;
    await input.fill(outside);
    await pane.getByRole("button", { name: "Go", exact: true }).click();
    await expect(pane.getByTestId("dom-proxy-status")).toContainText(
      "Couldn't complete this browser action.",
    );
    expect(harness.requests).toHaveLength(1);
    expect(observedNavigationStates(harness).at(-1)?.documentId).toBe(admitted.documentId);
    const redirect = new URL(`/app/redirect?proof=${harness.proof}`, harness.targetUrl).href;
    await input.fill(redirect);
    await pane.getByRole("button", { name: "Go", exact: true }).click();
    await expect
      .poll(() => observedNavigationResults(harness).at(-1)?.status, { timeout: 30_000 })
      .toBe("failed");
    await expect(pane.getByTestId("dom-proxy-status")).toContainText(
      "Couldn't complete this browser action.",
    );
    expect(harness.requests.map((request) => request.path)).toEqual([
      `/app/start?proof=${harness.proof}`,
      `/app/redirect?proof=${harness.proof}`,
    ]);
    expect(observedNavigationStates(harness).at(-1)?.documentId).toBe(admitted.documentId);
    expect(harness.observation?.overflow()).toBe(false);
    assertProductEgress(harness);
  } finally {
    await finishProductProof(harness, testInfo);
  }
});

test("E5 keeps title text bounded and rejects old or forged shell metadata", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120_000);
  const harness = await startProductHarness(testInfo.outputPath("product-assets"), {
    scenario: "boundary",
    observeChannels: true,
    observeReceipts: true,
  });
  try {
    const { pane, input, document } = await openInitialDocument(harness);
    await expectObservedState(harness, harness.targetUrl);
    const original = harness.observation?.messages.find(
      ({ message }) => message.type === "paseo.web.navigation.state",
    )?.message;
    if (!original) throw new Error("Initial shell metadata was not observed");
    const literal = '<img src=x onerror="globalThis.__titleExecuted=true">';
    await document.locator("#product-title-html").click();
    await expect.poll(() => observedNavigationStates(harness).at(-1)?.title).toBe(literal);
    const tabs = harness.page.locator('[data-testid^="workspace-tab-"]').filter({ visible: true });
    await expect(tabs.filter({ hasText: literal })).toBeVisible();
    expect(await harness.page.evaluate(() => "__titleExecuted" in globalThis)).toBe(false);
    expect(await document.locator("body").evaluate(() => "__titleExecuted" in globalThis)).toBe(
      false,
    );
    await document.locator("#product-title-long").click();
    const bounded = "é".repeat(NAVIGATION_LIMITS.maxTitleBytes / 2);
    await expect.poll(() => observedNavigationStates(harness).at(-1)?.title).toBe(bounded);
    await expect(tabs.filter({ hasText: bounded })).toBeVisible();
    const latest = harness.observation?.messages.findLast(
      ({ message }) => message.type === "paseo.web.navigation.state",
    )?.message;
    if (!latest) throw new Error("Bounded title state was not observed");
    const parsed = parseNavigationToBroker(latest);
    if (parsed?.type !== "paseo.web.navigation.state") throw new Error("Invalid observed state");
    const shell = harness.page
      .frames()
      .find((frame) => frame.url().includes(harness.evidence().manifest.bootstrapPath));
    if (!shell) throw new Error("Actual shell frame missing");
    const attacks = [
      original,
      { ...latest, generation: parsed.generation + 1, sequence: parsed.sequence + 1 },
      {
        ...latest,
        sequence: parsed.sequence + 1,
        state: {
          ...parsed.state,
          documentId: "forged-document",
          entryKey: "forged-entry",
          title: "FORGED",
          commit: { kind: "network", requestId: 2 ** 31 - 1 },
        },
      },
    ];
    for (const attack of attacks) {
      await shell.evaluate((message) => {
        (
          window as unknown as { __productReplayNavigation(value: unknown): void }
        ).__productReplayNavigation(message);
      }, attack);
    }
    await expect
      .poll(() =>
        harness.observation?.messages.some(({ frameUrl, message }) => {
          if (
            new URL(frameUrl).origin !== CONTROL ||
            message.type !== "product.test.navigation.received"
          )
            return false;
          const received = parseNavigationToBroker(message.received);
          return (
            received?.type === "paseo.web.navigation.state" &&
            received.state.documentId === "forged-document"
          );
        }),
      )
      .toBe(true);
    await expect(input).toHaveValue(harness.targetUrl);
    await expect(tabs.filter({ hasText: bounded })).toBeVisible();
    await expect(tabs.filter({ hasText: "FORGED" })).toHaveCount(0);
    const malformed = {
      ...latest,
      sequence: parsed.sequence + 2,
      state: { ...parsed.state, title: "é".repeat(1025) },
    };
    await shell.evaluate((message) => {
      (
        window as unknown as { __productReplayNavigation(value: unknown): void }
      ).__productReplayNavigation(message);
    }, malformed);
    await expect(
      harness.page.getByTestId("dom-proxy-resident-surface").locator("iframe"),
    ).toHaveCount(0);
    await expect(pane.getByTestId("dom-proxy-status")).toContainText(
      "Couldn't complete this browser action.",
    );
    expect(harness.requests).toHaveLength(1);
    expect(harness.observation?.overflow()).toBe(false);
    assertProductEgress(harness);
    await writeFile(
      testInfo.outputPath("adversarial-controls.json"),
      JSON.stringify(
        {
          attacks: [...attacks, malformed],
          confirmedTitleBytes: new TextEncoder().encode(bounded).byteLength,
          scope: "test-only replay on the observed shell port; no authority is supplied",
        },
        null,
        2,
      ),
    );
  } finally {
    await finishProductProof(harness, testInfo);
  }
});

test("E5 incompatible local assets cannot confirm or request the destination", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120_000);
  const harness = await startProductHarness(testInfo.outputPath("product-assets"), {
    mixedAssets: true,
    observeChannels: true,
  });
  try {
    await openProductPanel(harness);
    const pane = harness.page.getByTestId("dom-proxy-pane");
    await pane.getByTestId("dom-proxy-url").fill(harness.targetUrl);
    await pane.getByRole("button", { name: "Go", exact: true }).click();
    await expect(pane.getByTestId("dom-proxy-status")).toContainText(
      "does not support page navigation yet",
      { timeout: 30_000 },
    );
    expect(harness.requests).toEqual([]);
    expect(observedNavigationStates(harness)).toEqual([]);
    expect(
      observedNavigationResults(harness).filter((outcome) => outcome.status === "committed"),
    ).toEqual([]);
    expect(
      harness.observation?.messages.some(
        ({ message }) =>
          message.type === "paseo.web.navigation.query" &&
          message.assetVersion !== harness.evidence().manifest.assetVersion,
      ),
    ).toBe(true);
    expect(
      harness.observation?.messages.some(
        ({ message }) => message.type === "paseo.web.navigation.ready",
      ),
    ).toBe(false);
    expect(harness.evidence().served.length).toBeGreaterThan(0);
    expect(harness.observation?.overflow()).toBe(false);
    assertProductEgress(harness);
  } finally {
    await finishProductProof(harness, testInfo);
  }
});

for (const networkMode of ["disabled", "absent"] as const) {
  test(`E8 ${networkMode} host configuration cannot create a browser when both renderers are unavailable`, async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBe("chromium");
    test.setTimeout(120_000);
    const harness = await startProductHarness(testInfo.outputPath("product-assets"), {
      networkMode,
      observeChannels: true,
      imageUnavailable: true,
    });
    try {
      expect(harness.evidence().hostNetworkFetch).toEqual({ supported: false, configured: false });
      await openProductMenu(harness);
      const { page } = harness;
      await expect(
        page.getByTestId("workspace-new-tab-menu-agent").filter({ visible: true }).first(),
      ).toBeVisible();
      await expect(page.getByTestId("workspace-new-tab-menu-browser")).toHaveCount(0);
      await expect(page.getByTestId("dom-proxy-pane")).toHaveCount(0);
      await expect(page.getByTestId("remote-browser-unsupported")).toHaveCount(0);
      await expect(page.getByTestId("dom-proxy-resident-surface")).toHaveCount(0);
      assertNoProductOpen(harness);
      assertProductEgress(harness);
    } finally {
      await finishProductProof(harness, testInfo);
    }
  });
}

test("E8 persisted opt-out keeps the image flow until the user explicitly selects DOM", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120_000);
  const harness = await startProductHarness(testInfo.outputPath("product-assets"), {
    domOptIn: false,
    imageUnavailable: true,
    observeChannels: true,
  });
  try {
    expect(harness.evidence().hostNetworkFetch).toEqual({ supported: true, configured: true });
    await openProductPanel(harness);
    const { page } = harness;
    await expect(page.getByTestId("remote-browser-unsupported")).toBeVisible();
    await expect(page.getByTestId("dom-proxy-pane")).toHaveCount(0);
    assertNoProductOpen(harness);
    await page
      .getByRole("button", { name: "Use local browser (experimental)", exact: true })
      .click();
    await expect(page.getByTestId("dom-proxy-pane")).toBeVisible();
    await expect(page.getByTestId("remote-browser-unsupported")).toHaveCount(0);
    assertNoProductOpen(harness);
    await page.getByRole("button", { name: "Use image browser", exact: true }).click();
    await expect(page.getByTestId("remote-browser-unsupported")).toBeVisible();
    await expect(page.getByTestId("dom-proxy-resident-surface")).toHaveCount(0);
    assertNoProductOpen(harness);
    assertProductEgress(harness);
  } finally {
    await finishProductProof(harness, testInfo);
  }
});

test("E4 correlates real history traversal and same-document changes without panel replay", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120_000);
  const harness = await startProductHarness(testInfo.outputPath("product-assets"), {
    scenario: "history",
    observeChannels: true,
  });
  try {
    const { pane, input, document } = await openInitialDocument(harness);
    const controlUrl = harness.page.url();
    const first = await expectObservedState(harness, harness.targetUrl);
    expectAdmittedNetworkState(harness, first);
    const secondUrl = new URL(`/app/second?proof=${harness.proof}`, harness.targetUrl).href;
    await document.locator("#product-next").click();
    await expect(input).toHaveValue(secondUrl);
    const second = await expectObservedState(harness, secondUrl);
    expectAdmittedNetworkState(harness, second);
    expect(second.documentId).not.toBe(first.documentId);
    expect(second.entryKey).not.toBe(first.entryKey);

    await pane.getByRole("button", { name: "Back", exact: true }).click();
    await expect(input).toHaveValue(harness.targetUrl);
    await expect(document.locator("#product-path")).toHaveText(`/app/start?proof=${harness.proof}`);
    const back = await expectObservedState(harness, harness.targetUrl);
    expectAdmittedNetworkState(harness, back);
    expect(back.entryKey).toBe(first.entryKey);
    expect(back.documentId).not.toBe(first.documentId);
    await pane.getByRole("button", { name: "Forward", exact: true }).click();
    await expect(input).toHaveValue(secondUrl);
    const forward = await expectObservedState(harness, secondUrl);
    expectAdmittedNetworkState(harness, forward);
    expect(forward.entryKey).toBe(second.entryKey);
    expect(forward.documentId).not.toBe(second.documentId);

    const currentDocument = await document
      .locator("body")
      .evaluateHandle((body) => body.ownerDocument);
    await document.locator("body").evaluate((body, proof) => {
      const marker = body.ownerDocument.createElement("input");
      marker.id = "history-unpersisted";
      marker.value = proof;
      body.append(marker);
    }, harness.proof);
    const beforeSameDocument = harness.requests.length;
    const steps: Array<[string, string]> = [
      ["product-hash", "section"],
      ["product-push", "pushed"],
      ["product-replace", "replaced"],
    ];
    const entries: string[] = [];
    for (const [id, hash] of steps) {
      await document.locator(`#${id}`).click();
      await expect(input).toHaveValue(`${secondUrl}#${hash}`);
      const state = await expectObservedState(harness, `${secondUrl}#${hash}`);
      expect(state.commit).toEqual({ kind: "same_document" });
      expect(state.documentId).toBe(forward.documentId);
      expect(await currentDocument.evaluate((original) => original === globalThis.document)).toBe(
        true,
      );
      await expect(document.locator("#history-unpersisted")).toHaveValue(harness.proof);
      expect(harness.requests).toHaveLength(beforeSameDocument);
      entries.push(state.entryKey);
    }
    expect(entries[0]).not.toBe(forward.entryKey);
    expect(entries[1]).not.toBe(entries[0]);
    expect(entries[2]).toBe(entries[1]);
    expect(harness.page.url()).toBe(controlUrl);
    expect(harness.observation?.overflow()).toBe(false);
    const committed = harness.observation?.messages.flatMap(({ message }) => {
      const parsed = parseNavigationToBroker(message);
      return parsed?.type === "paseo.web.navigation.result" ? [parsed.outcome] : [];
    });
    expect(committed?.filter((outcome) => outcome.status === "failed")).toEqual([]);
    expect(committed?.filter((outcome) => outcome.status === "committed")).toHaveLength(3);
    await currentDocument.dispose();
    assertProductEgress(harness);
  } finally {
    await finishProductProof(harness, testInfo);
  }
});

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
