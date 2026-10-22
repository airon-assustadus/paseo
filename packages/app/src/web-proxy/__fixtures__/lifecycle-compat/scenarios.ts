import assert from "node:assert/strict";
import type { Frame, Page } from "playwright";
import { CONTENT, type BenchView, type LifecycleBench, type Selection } from "./bench";

export interface Proof {
  id: string;
  evidence: Record<string, unknown>;
}

interface ResumeSample {
  controlState: string;
  broker: string;
  operation: string | null;
  transport: string;
  generation: number;
  overlay: boolean;
  disabled: boolean;
  inert: boolean;
}

export async function state(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const target = window as unknown as {
      __paseoLab?: { state(): Record<string, unknown> };
      __lifecycleProbe?: { state(): Record<string, unknown> };
    };
    const api = target.__paseoLab ?? target.__lifecycleProbe;
    if (!api) throw new Error("control not loaded");
    const { diagnostics: _diagnostics, browser: _browser, ...publicState } = api.state();
    const wire = (
      window as unknown as { __lifecycleWire: Array<{ type: string; reason?: string }> }
    ).__lifecycleWire;
    return {
      ...publicState,
      protocolRevokes: wire.filter(
        (message) => message.type === "paseo.web.revoke" && message.reason === "protocol_error",
      ).length,
    };
  });
}

export async function waitState(
  page: Page,
  wanted: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await page.waitForFunction(
    (expected) => {
      const target = window as unknown as {
        __paseoLab?: { state(): Record<string, unknown> };
        __lifecycleProbe?: { state(): Record<string, unknown> };
      };
      const current = (target.__paseoLab ?? target.__lifecycleProbe)?.state();
      return current && Object.entries(expected).every(([key, value]) => current[key] === value);
    },
    wanted,
    { timeout: 30_000 },
  );
  return state(page);
}

export async function frames(page: Page): Promise<{ shell: Frame; app: Frame }> {
  const element = await page.locator("#frame > iframe").elementHandle();
  assert(element);
  const shell = await element.contentFrame();
  assert(shell);
  const nested = await shell.locator('[data-testid="paseo-web-proxy-app"]').elementHandle();
  assert(nested);
  const app = await nested.contentFrame();
  assert(app);
  await app.waitForLoadState("domcontentloaded");
  return { shell, app };
}

export async function probePreservation(bench: LifecycleBench): Promise<Proof[]> {
  const proofs: Proof[] = [];
  for (const method of ["GET", "POST"] as const) {
    const view = await bench.open({ control: "probe", shell: "new", worker: "old" });
    try {
      await waitState(view.page, { status: "granted", lifecycle: "ready", workerArmed: false });
      const { app } = await frames(view.page);
      await app.locator("#draft").fill(`published-${method}`);
      const document = await app.evaluateHandle(() => window.document);
      const response = view.page.waitForResponse(
        (value) => value.url() === `${CONTENT}/hold` && value.request().method() === method,
      );
      await app.evaluate((verb) => {
        if (verb === "GET") (window.document.getElementById("get") as HTMLAnchorElement).click();
        else (window.document.querySelector("form") as HTMLFormElement).requestSubmit();
      }, method);
      await view.page.waitForFunction(() =>
        (
          window as unknown as { __lifecycleProbe: { requests: Array<{ path: string }> } }
        ).__lifecycleProbe.requests.some((request) => request.path === "/hold"),
      );
      await view.page.evaluate(() =>
        (
          window as unknown as { __lifecycleProbe: { suspend(): boolean } }
        ).__lifecycleProbe.suspend(),
      );
      const result = await response;
      assert.equal(result.status(), 204);
      assert(result.fromServiceWorker());
      const after = await waitState(view.page, { status: "suspended", documentKept: true });
      assert(await document.evaluate((previous) => previous === window.document));
      assert.equal(await app.locator("#draft").inputValue(), `published-${method}`);
      assert.equal(await app.evaluate(() => window.document.activeElement?.id), "draft");
      proofs.push({
        id: `P1-published-${method}`,
        evidence: {
          status: 204,
          serviceWorker: true,
          sameDocument: true,
          textPreserved: true,
          focusPreserved: true,
          state: after,
        },
      });
    } finally {
      await view.close();
    }
  }
  return proofs;
}

export async function restartWindow(bench: LifecycleBench): Promise<Proof> {
  const view = await bench.open({ control: "probe", shell: "new", worker: "new" });
  try {
    await waitState(view.page, { status: "granted", lifecycle: "ready", workerArmed: true });
    const { shell, app } = await frames(view.page);
    await shell.evaluate(() => {
      const original = ServiceWorker.prototype.postMessage;
      const queued: Array<() => void> = [];
      let hold = true;
      ServiceWorker.prototype.postMessage = function (
        message: unknown,
        transfer?: Transferable[] | StructuredSerializeOptions,
      ) {
        const send = () => Reflect.apply(original, this, [message, transfer]);
        if (hold && (message as { type?: string })?.type === "paseo.shell.lifecycle.arm")
          queued.push(send);
        else send();
      };
      Object.defineProperty(window, "__releaseArm", {
        value: () => {
          hold = false;
          for (const send of queued.splice(0)) send();
        },
      });
      Object.defineProperty(window, "__heldArmCount", { get: () => queued.length });
    });
    const cdp = await view.context.newCDPSession(view.page);
    const running = new Promise<{ versionId: string }>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("CDP did not observe the running content worker")),
        5000,
      );
      cdp.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
        const active = versions.find(
          (version) =>
            version.scriptURL === `${CONTENT}/__paseo/sw.js` && version.runningStatus === "running",
        );
        if (active) {
          clearTimeout(deadline);
          resolve(active);
        }
      });
    });
    await cdp.send("ServiceWorker.enable");
    const active = await running;
    await cdp.send("ServiceWorker.stopWorker", { versionId: active.versionId });
    const before = view.page.waitForResponse((response) => response.url() === `${CONTENT}/hold`);
    await app.evaluate(() => {
      location.href = "/hold";
    });
    await shell.waitForFunction(
      () => (window as unknown as { __heldArmCount: number }).__heldArmCount > 0,
    );
    const unarmed = await waitState(view.page, { workerArmed: false });
    const first = await before;
    assert.equal(first.status(), 504);
    assert(first.fromServiceWorker());
    await shell.evaluate(() => (window as unknown as { __releaseArm(): void }).__releaseArm());
    const armed = await waitState(view.page, { workerArmed: true });
    await app.goto(`${CONTENT}/`);
    await app.locator("#draft").fill("after-restart");
    const document = await app.evaluateHandle(() => window.document);
    const after = view.page.waitForResponse((response) => response.url() === `${CONTENT}/hold`);
    await app.evaluate(() => (window.document.getElementById("get") as HTMLAnchorElement).click());
    const second = await after;
    assert.equal(second.status(), 204);
    assert(second.fromServiceWorker());
    assert(await document.evaluate((previous) => previous === window.document));
    assert.equal(await app.locator("#draft").inputValue(), "after-restart");
    return {
      id: "P7",
      evidence: {
        stoppedVersion: active.versionId,
        beforeStatus: 504,
        afterStatus: 204,
        unarmed,
        armed,
        afterSameDocument: true,
      },
    };
  } finally {
    await view.close();
  }
}

const MATRIX: Array<{ id: string; selection: Selection; lifecycle?: string; armed?: boolean }> = [
  { id: "M1", selection: { control: "old", shell: "old", worker: "old" } },
  {
    id: "M2",
    selection: { control: "new", shell: "old", worker: "old" },
    lifecycle: "unavailable",
    armed: false,
  },
  {
    id: "M3",
    selection: { control: "new", shell: "old", worker: "new" },
    lifecycle: "unavailable",
    armed: false,
  },
  {
    id: "M4",
    selection: { control: "new", shell: "new", worker: "old" },
    lifecycle: "ready",
    armed: false,
  },
  {
    id: "M5",
    selection: { control: "new", shell: "new", worker: "new" },
    lifecycle: "ready",
    armed: true,
  },
  { id: "M6-oldSW", selection: { control: "old", shell: "new", worker: "old" } },
  { id: "M6-newSW", selection: { control: "old", shell: "new", worker: "new" } },
];

export async function matrix(bench: LifecycleBench, onlyPublished = false): Promise<Proof[]> {
  const proofs: Proof[] = [];
  for (const row of MATRIX.filter(
    (entry) => (entry.selection.control === "old") === onlyPublished,
  )) {
    const view = await bench.open({ ...row.selection });
    try {
      const wanted: Record<string, unknown> = { controlState: "granted", broker: "granted" };
      if (row.lifecycle)
        Object.assign(wanted, { lifecycle: row.lifecycle, workerArmed: row.armed });
      const granted = await waitState(view.page, wanted);
      const { app } = await frames(view.page);
      await app.locator('input[name="q"]').waitFor();
      const document = await app.evaluateHandle(() => window.document);
      bench.cutRelay();
      const suspends = row.lifecycle === "ready";
      const loss = await waitState(view.page, { broker: suspends ? "suspended" : "revoked" });
      assert.equal(loss.protocolRevokes, 0);
      if (suspends) assert(await document.evaluate((previous) => previous === window.document));
      proofs.push({
        id: row.id,
        evidence: { selection: row.selection, granted, loss, sameDocumentOnSuspend: suspends },
      });
      console.log(
        "lifecycle proof",
        row.id,
        JSON.stringify({
          granted: granted.broker,
          loss: loss.broker,
          lifecycle: granted.lifecycle,
          workerArmed: granted.workerArmed,
        }),
      );
    } finally {
      await view.close();
    }
  }
  return proofs;
}

async function updateWorker(view: BenchView): Promise<void> {
  const { shell } = await frames(view.page);
  await shell.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error("missing registration");
    Object.assign(window, { __previousWorker: registration.active });
    await registration.update();
  });
  await shell.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return (
      registration?.active &&
      registration.active !==
        (window as unknown as { __previousWorker: ServiceWorker }).__previousWorker &&
      registration.active.state === "activated"
    );
  });
}

export async function transitions(bench: LifecycleBench): Promise<Proof[]> {
  const view = await bench.open({ control: "new", shell: "new", worker: "old" });
  try {
    await waitState(view.page, { broker: "granted", lifecycle: "ready", workerArmed: false });
    const { shell, app } = await frames(view.page);
    const document = await app.evaluateHandle(() => window.document);
    view.selection.worker = "new";
    await updateWorker(view);
    await app.evaluate(() => fetch("/api/echo").then((response) => response.text()));
    const upgraded = await waitState(view.page, { workerArmed: true });
    assert(await document.evaluate((previous) => previous === window.document));
    view.selection.worker = "old";
    await updateWorker(view);
    await app.evaluate(() => fetch("/api/echo").then((response) => response.text()));
    const rolledBack = await waitState(view.page, { workerArmed: false });
    assert(await document.evaluate((previous) => previous === window.document));
    const response = view.page.waitForResponse((value) => value.url().includes("/post/rollback"));
    await app.evaluate(() => {
      const form = window.document.querySelector('[data-role="form-post"]') as HTMLFormElement;
      form.action = "/post/rollback?hold=1";
      form.requestSubmit();
    });
    assert.equal((await response).status(), 504);
    bench.releasePost("rollback");
    // The loaded bootstrap remains new while a second document receives old K from the server.
    view.selection.worker = "new";
    await updateWorker(view);
    await app.goto(`${CONTENT}/`);
    await waitState(view.page, { workerArmed: true });
    const shellDocument = await shell.evaluateHandle(() => window.document);
    view.selection.shell = "old";
    const mixed = await view.context.newPage();
    await mixed.goto("https://ssh.assustadus.tech");
    await mixed.locator("#code").fill("AAAAAAAAAAAAAAAAAAAA");
    await mixed.locator("#connect button").click();
    const mixedState = await waitState(mixed, {
      broker: "granted",
      lifecycle: "unavailable",
      workerArmed: false,
    });
    assert(await shellDocument.evaluate((previous) => previous === window.document));
    const stillNew = await state(view.page);
    assert.equal(stillNew.lifecycle, "ready");
    assert.equal(stillNew.workerArmed, true);
    assert.equal(mixedState.protocolRevokes, 0);
    return [
      { id: "P4-worker-upgrade", evidence: { upgraded, sameDocument: true } },
      { id: "P4-worker-rollback", evidence: { rolledBack, timeoutStatus: 504 } },
      {
        id: "P4-mixed-K",
        evidence: { mixedState, loadedState: stillNew, loadedShellUnchanged: true },
      },
    ];
  } finally {
    await view.close();
  }
}

export async function overlayResume(bench: LifecycleBench): Promise<Proof> {
  const view = await bench.open({ control: "new", shell: "new", worker: "new" });
  try {
    await waitState(view.page, { controlState: "granted", lifecycle: "ready", workerArmed: true });
    const { app } = await frames(view.page);
    const input = app.locator('input[name="q"]');
    await input.fill("p6-preserved");
    const document = await app.evaluateHandle(() => window.document);
    const box = await input.boundingBox();
    assert(box);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const heldResponse = view.page.waitForResponse((response) =>
      response.url().includes("/post/p6"),
    );
    await app.evaluate(() => {
      Object.assign(window, { __p6InputClicks: 0 });
      window.document.querySelector('input[name="q"]')!.addEventListener("click", () => {
        (window as unknown as { __p6InputClicks: number }).__p6InputClicks += 1;
      });
      const form = window.document.querySelector('[data-role="form-post"]') as HTMLFormElement;
      form.action = "/post/p6?hold=1";
      form.requestSubmit();
    });
    await bench.waitPost("p6");
    const rootsBefore = bench.requestCount("/");
    const postBefore = bench.postCount("p6");
    assert.equal(postBefore, 1);
    bench.cutRelay();
    assert.equal((await heldResponse).status(), 204);
    await waitState(view.page, {
      controlState: "suspended",
      broker: "suspended",
      documentKept: true,
    });
    const hit = await view.page.evaluate(({ x, y }) => {
      const overlay = window.document.querySelector('#frame > div[role="status"]') as HTMLElement;
      const iframe = window.document.querySelector("#frame > iframe") as HTMLIFrameElement;
      const target = window.document.elementFromPoint(x, y);
      const counts = { pointerdown: 0, click: 0 };
      overlay.addEventListener("pointerdown", () => (counts.pointerdown += 1));
      overlay.addEventListener("click", () => (counts.click += 1));
      Object.assign(window, { __p6OverlayCounts: counts });
      return {
        overlayHit: target === overlay || (target !== null && overlay.contains(target)),
        inert: iframe.inert,
        visible: !overlay.hidden,
      };
    }, point);
    console.log("P6_HIT", JSON.stringify(hit));
    assert.deepEqual(hit, { overlayHit: true, inert: true, visible: true });
    await view.page.mouse.click(point.x, point.y);
    const overlayCounts = await view.page.evaluate(
      () =>
        (window as unknown as { __p6OverlayCounts: { pointerdown: number; click: number } })
          .__p6OverlayCounts,
    );
    console.log("P6_OVERLAY_EVENTS", JSON.stringify(overlayCounts));
    assert.deepEqual(overlayCounts, { pointerdown: 1, click: 1 });
    assert.equal(
      await app.evaluate(() => (window as unknown as { __p6InputClicks: number }).__p6InputClicks),
      0,
    );
    assert.equal(bench.postCount("p6"), 1);
    assert.equal(bench.requestCount("/"), rootsBefore);
    await view.page.evaluate(() => {
      const samples: ResumeSample[] = [];
      const taskSamples: ResumeSample[] = [];
      const pendingTasks: Promise<void>[] = [];
      Object.assign(window, {
        __p6Resuming: samples,
        __p6DrainTasks: async () => {
          await Promise.all(pendingTasks);
          return taskSamples;
        },
      });
      const lab = (
        window as unknown as {
          __paseoLab: {
            reopen(): Promise<unknown>;
            state(): Omit<ResumeSample, "overlay" | "disabled" | "inert">;
          };
        }
      ).__paseoLab;
      const reopen = lab.reopen.bind(lab);
      lab.reopen = async () => {
        const outcome = await reopen();
        Object.assign(window, { __p6ResumeResult: outcome });
        return outcome;
      };
      const capture = (): ResumeSample => {
        const { controlState, broker, operation, transport, generation } = lab.state();
        return {
          controlState,
          broker,
          operation,
          transport,
          generation,
          overlay: !(window.document.querySelector('#frame > div[role="status"]') as HTMLElement)
            .hidden,
          disabled: (window.document.getElementById("reopen") as HTMLButtonElement).disabled,
          inert: (window.document.querySelector("#frame > iframe") as HTMLIFrameElement).inert,
        };
      };
      new MutationObserver(() => {
        if (window.document.body.dataset.controlState !== "resuming") return;
        samples.push(capture());
        pendingTasks.push(
          new Promise<void>((resolve) => {
            setTimeout(() => {
              taskSamples.push(capture());
              resolve();
            }, 0);
          }),
        );
      }).observe(window.document.body, {
        attributes: true,
        attributeFilter: ["data-control-state"],
      });
    });
    bench.restoreRelay();
    await view.page.getByRole("button", { name: "Retomar", exact: true }).click();
    const resumed = await waitState(view.page, {
      controlState: "granted",
      broker: "granted",
      transport: "open",
      operation: null,
      generation: 2,
    });
    const resuming = await view.page.evaluate(
      () => (window as unknown as { __p6Resuming: ResumeSample[] }).__p6Resuming,
    );
    await view.page.waitForFunction(() => "__p6ResumeResult" in window);
    const resumeResult = await view.page.evaluate(
      () =>
        (
          window as unknown as {
            __p6ResumeResult: {
              ok: boolean;
              flags: { resumed: boolean; documentPreserved: boolean };
              resume: { kind: string; previousGeneration: number; generation: number };
            };
          }
        ).__p6ResumeResult,
    );
    const taskSamples = await view.page.evaluate(() =>
      (window as unknown as { __p6DrainTasks(): Promise<ResumeSample[]> }).__p6DrainTasks(),
    );
    console.log("P6_RESUME", JSON.stringify({ resumed, resuming, taskSamples, resumeResult }));
    assert.equal(resumeResult.ok, true);
    assert.equal(resumeResult.flags.resumed, true);
    assert.equal(resumeResult.flags.documentPreserved, true);
    assert.equal(resumeResult.resume.kind, "resumed");
    assert.equal(resumeResult.resume.previousGeneration, 1);
    assert.equal(resumeResult.resume.generation, 2);
    assert(resuming.length > 0, "must observe resuming in this same execution");
    for (const sample of resuming) {
      assert.equal(sample.controlState, "resuming");
      assert(sample.overlay && sample.disabled);
      assert(["suspended", "resuming", "granted"].includes(sample.broker));
      // The broker clears inert on ACK, before the control publishes its resumed leg.
      if (sample.broker !== "granted") assert.equal(sample.inert, true);
    }
    assert.equal(taskSamples.length, resuming.length);
    assert(
      taskSamples.some(
        (sample) =>
          sample.controlState === "resuming" &&
          (sample.broker === "suspended" || sample.broker === "resuming"),
      ),
      "must observe the protected pre-ACK state in a separate task",
    );
    for (const sample of taskSamples) {
      if (sample.controlState === "resuming") {
        assert(sample.overlay && sample.disabled && sample.inert);
      }
    }
    assert.equal(await view.page.locator('#frame > div[role="status"]').isVisible(), false);
    assert.equal(
      await view.page
        .locator("#frame > iframe")
        .evaluate((element) => (element as HTMLIFrameElement).inert),
      false,
    );
    assert(await document.evaluate((previous) => previous === window.document));
    await view.page.mouse.click(point.x, point.y);
    await view.page.keyboard.press("End");
    await view.page.keyboard.type("-returned");
    console.log(
      "P6_INPUT",
      JSON.stringify({
        value: await input.inputValue(),
        clicks: await app.evaluate(
          () => (window as unknown as { __p6InputClicks: number }).__p6InputClicks,
        ),
        posts: bench.postCount("p6"),
        roots: bench.requestCount("/"),
      }),
    );
    assert.equal(await input.inputValue(), "p6-preserved-returned");
    assert.equal(
      await app.evaluate(
        () => window.document.activeElement === window.document.querySelector('input[name="q"]'),
      ),
      true,
    );
    assert.equal(
      await app.evaluate(() => (window as unknown as { __p6InputClicks: number }).__p6InputClicks),
      1,
    );
    assert.equal(bench.postCount("p6"), 1);
    assert.equal(bench.requestCount("/"), rootsBefore);
    bench.releasePost("p6");
    return {
      id: "P6",
      evidence: {
        hit,
        overlayCounts,
        resuming,
        taskSamples,
        resumeResult,
        resumed,
        sameDocument: true,
        textPreservedAndEditable: true,
        postCount: 1,
        rootsBefore,
        rootsAfter: bench.requestCount("/"),
      },
    };
  } finally {
    await view.close();
  }
}
