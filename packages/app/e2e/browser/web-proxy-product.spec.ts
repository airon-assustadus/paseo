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
import { NetworkFetchOpcode } from "@getpaseo/protocol/binary-frames/network-fetch";
import type { NetworkFetchDescriptor } from "@getpaseo/protocol/network-fetch/rpc-schemas";
import type { FetchObservation } from "../support/web-proxy-product/observation";

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

function fetchEvents(
  harness: ProductHarness,
  type: string,
  direction: FetchObservation["direction"] = "received",
) {
  return (harness.observation?.fetchEvents ?? []).filter(
    (event) => event.type === type && event.direction === direction,
  );
}

async function lifecycleIdentity(harness: ProductHarness) {
  const scope = { origin: new URL(harness.targetUrl).origin, pathPrefix: "/app/" };
  const descriptor = await harness.authority.resolveNetworkFetchDestination(scope);
  const reconciled = await harness.authority.reconcileNetworkFetchDestination({
    destinationId: descriptor.destinationId,
    knownEpoch: descriptor.authorityEpoch,
  });
  expect(reconciled.cleanupRequiredEpoch).toBeNull();
  return {
    scope,
    descriptor,
    open: {
      scope,
      destinationId: descriptor.destinationId,
      expectedAuthorityEpoch: descriptor.authorityEpoch,
      allowlistRevision: descriptor.allowlistRevision,
      ttlMs: 120_000,
    },
  };
}

function assertViewIdentity(
  harness: ProductHarness,
  descriptor: NetworkFetchDescriptor,
  count: number,
) {
  const opened = fetchEvents(harness, "network.fetch.open.response").filter(
    (event) => event.fields.ok === true,
  );
  expect(opened).toHaveLength(count);
  for (const { fields } of opened) {
    for (const key of [
      "destinationId",
      "authorityEpoch",
      "allowlistRevision",
      "contentOrigin",
      "assetVersion",
    ] as const)
      expect(fields[key]).toBe(descriptor[key]);
  }
  expect(new Set(opened.map((event) => event.fields.subscriptionId)).size).toBe(count);
  return opened;
}

async function retainDocument(
  harness: ProductHarness,
  document: Awaited<ReturnType<typeof openInitialDocument>>["document"],
) {
  const outer = await harness.page
    .getByTestId("dom-proxy-resident-surface")
    .last()
    .locator(":scope > iframe")
    .elementHandle();
  if (!outer) throw new Error("No settled resident iframe");
  const original = await document.locator("body").evaluateHandle((body) => body.ownerDocument);
  await original.evaluate((doc, token) => {
    const input = doc.createElement("input");
    input.id = "e67-unpersisted";
    input.value = token;
    doc.body.append(input);
  }, harness.proof);
  return {
    original,
    outer,
    async assertPreserved() {
      expect(await outer.evaluate((node) => node.isConnected)).toBe(true);
      expect(await original.evaluate((doc) => doc === globalThis.document)).toBe(true);
      expect(
        await original.evaluate(
          (doc) => (doc.getElementById("e67-unpersisted") as HTMLInputElement).value,
        ),
      ).toBe(harness.proof);
    },
  };
}

async function beginHeldFetch(
  harness: ProductHarness,
  retained: Awaited<ReturnType<typeof retainDocument>>,
  key: string,
  method: "GET" | "POST",
) {
  harness.fixture.hold(key, { method, maxBodyBytes: 1024 });
  const requestPath = `/app/hold?proof=${harness.proof}&key=${key}`;
  await retained.original.evaluate(
    (doc, input) => {
      const marker = doc.createElement("output");
      marker.id = "e67-fetch-result";
      marker.dataset.settled = "0";
      doc.body.append(marker);
      const finish = (result: string) => {
        marker.dataset.settled = String(Number(marker.dataset.settled) + 1);
        marker.textContent = result;
      };
      void doc
        .defaultView!.fetch(input.path, {
          method: input.method,
          ...(input.method === "POST" ? { body: "finite-post" } : {}),
        })
        .then((response) => response.text())
        .then(
          () => finish("resolved"),
          () => finish("rejected"),
        );
    },
    { path: requestPath, method },
  );
  await expect
    .poll(() => harness.fixture.snapshot().find((held) => held.key === key)?.bodyComplete)
    .toBe(true);
  return requestPath;
}

async function expectSettledOnce(retained: Awaited<ReturnType<typeof retainDocument>>) {
  await expect
    .poll(() =>
      retained.original.evaluate((doc) => doc.getElementById("e67-fetch-result")?.dataset.settled),
    )
    .toBe("1");
}

async function resumeWithoutReplay(
  harness: ProductHarness,
  retained: Awaited<ReturnType<typeof retainDocument>>,
  beforeCount: number,
) {
  const before = harness.observation?.fetchEvents.length ?? 0;
  const opens = fetchEvents(harness, "network.fetch.open.response").length;
  const pane = harness.page.getByTestId("dom-proxy-pane").filter({ visible: true }).last();
  await pane.getByRole("button", { name: "Resume", exact: true }).click();
  await expect
    .poll(() => fetchEvents(harness, "network.fetch.open.response").length)
    .toBe(opens + 1);
  await expect
    .poll(() =>
      retained.outer.evaluate((node) => (node instanceof HTMLElement ? node.inert : null)),
    )
    .toBe(false);
  const requests = (harness.observation?.fetchEvents.slice(before) ?? []).filter(
    (event) => event.direction === "sent",
  );
  const reconcile = requests.findIndex(
    (event) => event.type === "network.fetch.reconcile_destination.request",
  );
  const open = requests.findIndex((event) => event.type === "network.fetch.open.request");
  expect(reconcile).toBeGreaterThanOrEqual(0);
  expect(open).toBeGreaterThan(reconcile);
  const owners = fetchEvents(harness, "network.fetch.open.response");
  expect(owners.at(-1)?.fields.subscriptionId).not.toBe(owners.at(-2)?.fields.subscriptionId);
  expect(owners.at(-1)?.fields.authorityEpoch).toBe(owners.at(-2)?.fields.authorityEpoch);
  await retained.assertPreserved();
  expect(harness.requests).toHaveLength(beforeCount);
  await expectSettledOnce(retained);
}

async function reconnectWithoutOpen(harness: ProductHarness) {
  const info = fetchEvents(harness, "server_info").length;
  const opens = fetchEvents(harness, "network.fetch.open.request", "sent").length;
  const requestCount = harness.requests.length;
  harness.daemonLinks.unblock();
  await expect
    .poll(() => fetchEvents(harness, "server_info").length, { timeout: 15_000 })
    .toBeGreaterThan(info);
  expect(fetchEvents(harness, "network.fetch.open.request", "sent")).toHaveLength(opens);
  expect(harness.requests).toHaveLength(requestCount);
}

async function finishLifecycleProof(
  harness: ProductHarness,
  testInfo: TestInfo,
  results: Record<string, unknown>,
) {
  // Capture post-cleanup evidence too; an IPC acknowledgement alone cannot pass cleanup.
  try {
    await finishProductProof(harness, testInfo);
  } finally {
    await writeFile(
      testInfo.outputPath("lifecycle-evidence.json"),
      JSON.stringify({ results, ...harness.evidence() }, null, 2),
    );
  }
}

function assertLifecycleEvidence(harness: ProductHarness) {
  const evidence = harness.evidence();
  expect(evidence.daemonLinks.failure).toBeNull();
  expect(evidence.fixture.failure).toBeNull();
  expect(evidence.controlSources.every((source) => !source.overflow)).toBe(true);
  assertProductEgress(harness);
}

test("E6 preserves a settled Document on channel loss without replaying its POST", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120_000);
  const harness = await startProductHarness(testInfo.outputPath("product-assets"), {
    observeChannels: true,
  });
  const results: Record<string, unknown> = {};
  try {
    const { document } = await openInitialDocument(harness);
    const identity = await lifecycleIdentity(harness);
    results.identity = identity.descriptor;
    assertViewIdentity(harness, identity.descriptor, 1);
    const retained = await retainDocument(harness, document);
    const requestPath = await beginHeldFetch(harness, retained, "loss-post", "POST");
    const requestCount = harness.requests.length;
    await harness.daemonLinks.cutAndBlock();
    await expect
      .poll(() =>
        retained.outer.evaluate((node) => (node instanceof HTMLElement ? node.inert : null)),
      )
      .toBe(true);
    await expectSettledOnce(retained);
    await retained.assertPreserved();
    harness.fixture.release("loss-post");
    await reconnectWithoutOpen(harness);
    await expect(harness.page.getByTestId("dom-proxy-status")).toContainText(
      "The page is suspended.",
    );
    await resumeWithoutReplay(harness, retained, requestCount);
    expect(
      harness.requests.filter(
        (request) => request.path === requestPath && request.method === "POST",
      ),
    ).toHaveLength(1);
    const debt = await harness.authority.reconcileNetworkFetchDestination({
      destinationId: identity.descriptor.destinationId,
      knownEpoch: identity.descriptor.authorityEpoch,
    });
    expect(debt.cleanupRequiredEpoch).toBeNull();
    results.reconciliation = debt;
    results.documentPreserved = true;
    results.fetchSettledCount = 1;
    assertLifecycleEvidence(harness);
  } finally {
    await finishLifecycleProof(harness, testInfo, results);
  }
});

test("E6 cancels a pending navigation on channel loss without confirming or replaying it", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120_000);
  const harness = await startProductHarness(testInfo.outputPath("product-assets"), {
    observeChannels: true,
  });
  const results: Record<string, unknown> = { preservationClaim: false };
  try {
    const { pane, input } = await openInitialDocument(harness);
    const initial = await expectObservedState(harness, harness.targetUrl);
    harness.fixture.hold("loss-navigation", { method: "GET", maxBodyBytes: 0 });
    const slowPath = `/app/slow-page?proof=${harness.proof}&key=loss-navigation`;
    await input.fill(new URL(slowPath, harness.targetUrl).href);
    await pane.getByRole("button", { name: "Go", exact: true }).click();
    await expect.poll(() => harness.fixture.snapshot()[0]?.bodyComplete).toBe(true);
    await harness.daemonLinks.cutAndBlock();
    await expect(pane.getByTestId("dom-proxy-status")).toBeVisible();
    harness.fixture.release("loss-navigation");
    await reconnectWithoutOpen(harness);
    await expect(pane.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
    expect(observedNavigationStates(harness).at(-1)?.documentId).toBe(initial.documentId);
    expect(
      observedNavigationResults(harness).filter((outcome) => outcome.status === "committed"),
    ).toHaveLength(1);
    const opens = fetchEvents(harness, "network.fetch.open.response").length;
    await pane.getByRole("button", { name: "Resume", exact: true }).click();
    await expect
      .poll(() => fetchEvents(harness, "network.fetch.open.response").length)
      .toBe(opens + 1);
    expect(harness.requests.filter((request) => request.path === slowPath)).toHaveLength(1);
    results.lateResponse = harness.fixture.snapshot();
    assertLifecycleEvidence(harness);
  } finally {
    await finishLifecycleProof(harness, testInfo, results);
  }
});

test("E6 expires the C timer with its channel intact and resumes the same Document", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120_000);
  const harness = await startProductHarness(testInfo.outputPath("product-assets"), {
    observeChannels: true,
    ttlMs: 30_000,
  });
  const results: Record<string, unknown> = { timerClaim: "C-path; not H-first" };
  try {
    const { document } = await openInitialDocument(harness);
    const retained = await retainDocument(harness, document);
    const identity = await lifecycleIdentity(harness);
    assertViewIdentity(harness, identity.descriptor, 1);
    const anchor = harness.observation?.browserOpenTimes[0];
    if (!anchor) throw new Error("No browser-clock open anchor");
    results.anchor = anchor;
    const age = await harness.page.evaluate((at) => performance.now() - at, anchor.at);
    expect(age).toBeLessThan(24_000);
    await harness.page.waitForFunction((at) => performance.now() - at >= 24_000, anchor.at, {
      timeout: 25_000,
    });
    await beginHeldFetch(harness, retained, "ttl-fetch", "GET");
    const count = harness.requests.length;
    await expect
      .poll(
        () => retained.outer.evaluate((node) => (node instanceof HTMLElement ? node.inert : null)),
        { timeout: 10_000 },
      )
      .toBe(true);
    await expectSettledOnce(retained);
    await expect(harness.page.getByTestId("dom-proxy-status")).toContainText(
      "The page is suspended.",
    );
    // A real lifecycle suspension reason, not just the generic suspended UI.
    expect(
      harness.observation?.messages.some(
        ({ message }) => message.type === "paseo.web.suspend" && message.reason === "expired",
      ),
    ).toBe(true);
    expect(
      harness.daemonLinks
        .snapshot()
        .filter((link) => !link.upstreamClosed && !link.downstreamClosed),
    ).toHaveLength(1);
    harness.fixture.release("ttl-fetch");
    await resumeWithoutReplay(harness, retained, count);
    const reconciled = await harness.authority.reconcileNetworkFetchDestination({
      destinationId: identity.descriptor.destinationId,
      knownEpoch: identity.descriptor.authorityEpoch,
    });
    expect(reconciled.cleanupRequiredEpoch).toBeNull();
    expect(reconciled.descriptor.authorityEpoch).toBe(identity.descriptor.authorityEpoch);
    results.reconciliation = reconciled;
    assertLifecycleEvidence(harness);
  } finally {
    await finishLifecycleProof(harness, testInfo, results);
  }
});

test("E6 expires an H owner through the real SDK without a C transport timer", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120_000);
  const harness = await startProductHarness(testInfo.outputPath("product-assets"), {
    observeChannels: true,
  });
  const results: Record<string, unknown> = {};
  const closed: Array<{ subscriptionId: string; reason: string }> = [];
  const unsubscribe = harness.client.subscribeRawMessages((message) => {
    if (message.type === "network.fetch.closed.update") closed.push(message.payload);
  });
  try {
    const identity = await lifecycleIdentity(harness);
    harness.fixture.hold("h-ttl", { method: "GET", maxBodyBytes: 0 });
    const handle = await harness.authority.openNetworkFetch({ ...identity.open, ttlMs: 4_000 });
    const ends: string[] = [];
    handle.onFrame(() => undefined);
    handle.onEnd((reason) => ends.push(reason));
    try {
      handle.send({
        opcode: NetworkFetchOpcode.Request,
        fetchId: 1,
        request: {
          method: "GET",
          url: new URL(`/app/hold?proof=${harness.proof}&key=h-ttl`, harness.targetUrl).href,
          headers: [],
          redirect: "manual",
          body: { kind: "none" },
        },
      });
      await expect.poll(() => harness.fixture.snapshot()[0]?.bodyComplete).toBe(true);
      await expect.poll(() => ends, { timeout: 8_000 }).toEqual(["expired"]);
      expect(handle.ended).toBe("expired");
      expect(closed).toEqual([{ subscriptionId: handle.subscriptionId, reason: "expired" }]);
      await expect.poll(() => harness.fixture.snapshot()[0]?.closed).toBe(true);
      expect(() => handle.send({ opcode: NetworkFetchOpcode.Cancel, fetchId: 1 })).toThrow();
      results.ended = ends;
      results.closed = closed;
    } finally {
      await handle.close();
    }
    const reconciled = await harness.authority.reconcileNetworkFetchDestination({
      destinationId: identity.descriptor.destinationId,
      knownEpoch: identity.descriptor.authorityEpoch,
    });
    expect(reconciled.cleanupRequiredEpoch).toBeNull();
    expect(reconciled.descriptor.authorityEpoch).toBe(identity.descriptor.authorityEpoch);
    const next = await harness.authority.openNetworkFetch(identity.open);
    let terminal = false;
    next.onFrame((frame) => {
      if (frame.opcode === NetworkFetchOpcode.End) terminal = true;
    });
    next.onEnd(() => undefined);
    try {
      next.send({
        opcode: NetworkFetchOpcode.Request,
        fetchId: 1,
        request: {
          method: "GET",
          url: harness.targetUrl,
          headers: [],
          redirect: "manual",
          body: { kind: "none" },
        },
      });
      await expect.poll(() => terminal).toBe(true);
      expect(next.subscriptionId).not.toBe(handle.subscriptionId);
    } finally {
      await next.close();
    }
    results.reconciliation = reconciled;
    assertLifecycleEvidence(harness);
  } finally {
    unsubscribe();
    await finishLifecycleProof(harness, testInfo, results);
  }
});

async function secondBrowserView(harness: ProductHarness) {
  await harness.page
    .getByTestId("workspace-new-tab-button")
    .filter({ visible: true })
    .first()
    .click();
  await harness.page
    .getByTestId("workspace-new-tab-menu-browser")
    .filter({ visible: true })
    .first()
    .click();
  const pane = harness.page.getByTestId("dom-proxy-pane").filter({ visible: true }).last();
  await pane.getByTestId("dom-proxy-url").fill(harness.targetUrl);
  await pane.getByRole("button", { name: "Go", exact: true }).click();
  const document = harness.page
    .getByTestId("dom-proxy-resident-surface")
    .last()
    .frameLocator("iframe")
    .frameLocator("iframe");
  await expect(document.locator("#product-proof")).toHaveText(harness.proof, { timeout: 30_000 });
  return { pane, document };
}

async function expectAllViewsFenced(harness: ProductHarness) {
  await expect
    .poll(() =>
      harness.page
        .getByTestId("dom-proxy-resident-surface")
        .locator(":scope > iframe")
        .evaluateAll((frames) =>
          frames.every((frame) => frame instanceof HTMLElement && frame.inert),
        ),
    )
    .toBe(true);
}

async function readLocalPending(harness: ProductHarness, targetId: string) {
  return harness.page.evaluate(
    async ({ serverId, destinationId }) =>
      new Promise<unknown>((resolve, reject) => {
        const opening = indexedDB.open("paseo-web-proxy-product", 1);
        opening.onupgradeneeded = () => {
          opening.transaction?.abort();
          reject(new Error("Product persistence missing"));
        };
        opening.addEventListener("error", () =>
          reject(new Error("Product persistence unavailable")),
        );
        opening.onsuccess = () => {
          const database = opening.result;
          const transaction = database.transaction("destinations", "readonly");
          const request = transaction.objectStore("destinations").get([serverId, destinationId]);
          transaction.oncomplete = () => {
            database.close();
            resolve(request.result);
          };
          transaction.addEventListener("abort", () => {
            database.close();
            reject(new Error("Product persistence read failed"));
          });
        };
      }),
    { serverId: harness.serverId, destinationId: targetId },
  );
}

test("E7 fences two local views and rejects real old response bytes delivered after H debt", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120_000);
  const harness = await startProductHarness(testInfo.outputPath("product-assets"), {
    observeChannels: true,
  });
  const results: Record<string, unknown> = {};
  try {
    const first = await openInitialDocument(harness);
    const retainedFirst = await retainDocument(harness, first.document);
    const second = await secondBrowserView(harness);
    const retained = await retainDocument(harness, second.document);
    expect(
      await retained.outer.evaluate((node, other) => node !== other, retainedFirst.outer),
    ).toBe(true);
    const identity = await lifecycleIdentity(harness);
    const owners = assertViewIdentity(harness, identity.descriptor, 2);
    const links = harness.daemonLinks
      .snapshot()
      .filter((link) => !link.downstreamClosed && !link.upstreamClosed);
    expect(links).toHaveLength(1);
    const before = harness.observation?.fetchEvents.length ?? 0;
    await beginHeldFetch(harness, retained, "late-response", "GET");
    const request = (harness.observation?.fetchEvents.slice(before) ?? []).find(
      (event) =>
        event.direction === "sent" &&
        event.type === "binary" &&
        event.fields.opcode === NetworkFetchOpcode.Request,
    );
    if (!request) throw new Error("Missing admitted request correlation");
    const lease = harness.daemonLinks.holdDownstream(links[0].id);
    const requests = harness.requests.length;
    try {
      harness.fixture.release("late-response");
      await expect.poll(lease.queuedBytes).toBeGreaterThan(0);
      await second.pane
        .getByRole("button", {
          name: "Request cleanup for all views of this destination",
          exact: true,
        })
        .click();
      await expectAllViewsFenced(harness);
      await expect
        .poll(
          async () =>
            (
              (await readLocalPending(harness, identity.descriptor.destinationId)) as {
                status?: string;
              }
            )?.status,
        )
        .toBe("cleanup_pending");
      const epoch = String(BigInt(identity.descriptor.authorityEpoch) + 1n);
      await expect
        .poll(
          async () =>
            (
              await harness.authority.reconcileNetworkFetchDestination({
                destinationId: identity.descriptor.destinationId,
                knownEpoch: identity.descriptor.authorityEpoch,
              })
            ).cleanupRequiredEpoch,
        )
        .toBe(epoch);
      const debtObservedAt = performance.now();
      const cleanupRequest = fetchEvents(
        harness,
        "network.fetch.request_cleanup.request",
        "sent",
      ).at(-1);
      if (!cleanupRequest) throw new Error("No actual C cleanup request");
      lease.release();
      await expect
        .poll(() =>
          fetchEvents(harness, "binary").some(
            (event) =>
              event.at > debtObservedAt &&
              event.fields.subscriptionId === request.fields.subscriptionId &&
              event.fields.fetchId === request.fields.fetchId &&
              [NetworkFetchOpcode.Head, NetworkFetchOpcode.Body, NetworkFetchOpcode.End].includes(
                event.fields.opcode as 0x45 | 0x41 | 0x42,
              ),
          ),
        )
        .toBe(true);
      await expect
        .poll(() =>
          fetchEvents(harness, "network.fetch.request_cleanup.response").some(
            (event) =>
              event.fields.requestId === cleanupRequest.fields.requestId &&
              event.fields.ok === true,
          ),
        )
        .toBe(true);
      results.debtObservedAt = debtObservedAt;
      results.oldRequest = request;
      const duplicate = await harness.authority.requestNetworkFetchCleanup({
        destinationId: identity.descriptor.destinationId,
        expectedAuthorityEpoch: identity.descriptor.authorityEpoch,
      });
      expect(duplicate.authorityEpoch).toBe(epoch);
      expect(duplicate.cleanupRequiredEpoch).toBe(epoch);
      await expect(harness.authority.openNetworkFetch(identity.open)).rejects.toMatchObject({
        code: "epoch_conflict",
      });
      await expect(
        harness.authority.openNetworkFetch({ ...identity.open, expectedAuthorityEpoch: epoch }),
      ).rejects.toMatchObject({ code: "cleanup_pending" });
      const tabs = harness.page
        .locator('[data-testid^="workspace-tab-"]')
        .filter({ hasText: `Product first ${harness.proof}` })
        .filter({ visible: true });
      expect(await tabs.count()).toBe(2);
      const tabIds = await tabs.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-testid")),
      );
      expect(new Set(tabIds).size).toBe(2);
      results.tabIds = tabIds;
      await tabs.first().click();
      await expectAllViewsFenced(harness);
      expect(
        fetchEvents(harness, "network.fetch.open.response").filter(
          (event) => event.fields.ok === true,
        ),
      ).toHaveLength(owners.length);
      expect(harness.requests).toHaveLength(requests);
      assertLifecycleEvidence(harness);
    } finally {
      lease.discard();
    }
  } finally {
    await finishLifecycleProof(harness, testInfo, results);
  }
});

test("E7 fences two distinct C sources of the same principal without shared BroadcastChannel", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120_000);
  const harness = await startProductHarness(testInfo.outputPath("product-assets"), {
    observeChannels: true,
  });
  const results: Record<string, unknown> = {};
  try {
    await openInitialDocument(harness);
    const extra = await harness.newControlContext();
    const other = { ...harness, ...extra };
    await openInitialDocument(other);
    const identity = await lifecycleIdentity(harness);
    const one = assertViewIdentity(harness, identity.descriptor, 1)[0];
    const two = assertViewIdentity(other, identity.descriptor, 1)[0];
    expect(one.fields.subscriptionId).not.toBe(two.fields.subscriptionId);
    const ids = [harness, other].map(
      (source) => fetchEvents(source, "hello", "sent").at(-1)?.fields.clientId,
    );
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(ids[0]).not.toBe(ids[1]);
    results.clientIds = ids;
    const requests = harness.requests.length;
    const debt = await harness.authority.requestNetworkFetchCleanup({
      destinationId: identity.descriptor.destinationId,
      expectedAuthorityEpoch: identity.descriptor.authorityEpoch,
    });
    results.debt = debt;
    for (const [index, source] of [harness, other].entries()) {
      await expect
        .poll(() =>
          fetchEvents(source, "network.fetch.closed.update").some(
            (event) =>
              event.fields.subscriptionId === [one, two][index].fields.subscriptionId &&
              event.fields.reason === "revoked",
          ),
        )
        .toBe(true);
      await expectAllViewsFenced(source);
      const pane = source.page.getByTestId("dom-proxy-pane");
      const resume = pane.getByRole("button", { name: "Resume", exact: true });
      if (await resume.isEnabled()) await resume.click();
      else {
        await pane.getByTestId("dom-proxy-url").fill(harness.targetUrl);
        await pane.getByRole("button", { name: "Go", exact: true }).click();
      }
      await expect(pane.getByTestId("dom-proxy-status")).toContainText(/pending|incomplete/u);
      await expectAllViewsFenced(source);
      expect(
        fetchEvents(source, "network.fetch.open.response").filter(
          (event) => event.fields.ok === true,
        ),
      ).toHaveLength(1);
      expect(
        fetchEvents(source, "network.fetch.reconcile_destination.response").at(-1)?.fields
          .cleanupRequiredEpoch,
      ).toBe(debt.cleanupRequiredEpoch);
    }
    expect(harness.requests).toHaveLength(requests);
    assertLifecycleEvidence(harness);
  } finally {
    await finishLifecycleProof(harness, testInfo, results);
  }
});

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
