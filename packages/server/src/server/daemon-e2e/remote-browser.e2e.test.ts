/* eslint-disable max-nested-callbacks */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  RemoteBrowserAttachment,
  RemoteBrowserFrame,
  RemoteBrowserState,
} from "@getpaseo/client/internal/daemon-client";
import { findRemoteBrowserExecutable } from "../remote-browser/chromium-executable.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

/**
 * The whole path: isolated in-process daemon on an ephemeral port, the real client SDK, a real
 * sandboxed Chromium and loopback fixtures. No user data, no port 6767.
 */

const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, touch: true };
const EVIDENCE_DIR = process.env.PASEO_RB_EVIDENCE_DIR;
const canRun =
  process.platform === "linux" &&
  findRemoteBrowserExecutable({ platform: process.platform, env: process.env }).kind === "found";

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0} .hit{display:block;width:100%;height:120px;background:#0a7}</style></head><body>${body}</body></html>`;
}

function chromiumProfilesInTmp(): string[] {
  return readdirSync(os.tmpdir()).filter((name) => name.startsWith("paseo-remote-browser-"));
}

function liveBrowserProcesses(profiles: string[]): number {
  let count = 0;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8");
      if (profiles.some((profile) => cmdline.includes(profile))) count += 1;
    } catch {
      // The process exited while we looked.
    }
  }
  return count;
}

describe.skipIf(!canRun)("remote browser through the daemon and the client SDK", () => {
  let daemon: TestPaseoDaemon;
  let client: DaemonClient;
  let fixture: http.Server;
  let origin = "";
  const evidence: Record<string, unknown> = {};

  beforeAll(async () => {
    fixture = http.createServer((request, response) => {
      const html = (body: string) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(body);
      };
      if (request.url === "/") {
        return html(
          page(
            "Home",
            `<a class="hit" href="/next">next</a><input id="f" style="display:block;height:80px;width:100%;font-size:30px" oninput="document.title='typed:'+this.value">`,
          ),
        );
      }
      if (request.url === "/next") return html(page("Next", ""));
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(fixture.address() as net.AddressInfo).port}`;
    daemon = await createTestPaseoDaemon({
      logger: pino({ level: process.env.PASEO_RB_E2E_LOG ?? "silent" }, pino.destination(2)),
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.11.5" });
    await client.connect();
  }, 60_000);

  afterAll(async () => {
    if (EVIDENCE_DIR) {
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      writeFileSync(
        path.join(EVIDENCE_DIR, "daemon-sdk-e2e.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
    }
    await client?.close();
    await daemon?.close();
    fixture?.closeAllConnections();
    await new Promise<void>((resolve) => fixture?.close(() => resolve()));
  }, 60_000);

  function nextState(
    attachment: RemoteBrowserAttachment,
    predicate: (state: RemoteBrowserState) => boolean,
  ): Promise<RemoteBrowserState> {
    if (predicate(attachment.state)) return Promise.resolve(attachment.state);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`Timed out; last ${JSON.stringify(attachment.state).slice(0, 300)}`)),
        15_000,
      );
      const off = attachment.onState((state) => {
        if (!predicate(state)) return;
        clearTimeout(timer);
        off();
        resolve(state);
      });
    });
  }

  it("opens, streams, navigates, types, re-attaches and closes through the SDK", async () => {
    expect(client.isRemoteBrowserSupported()).toBe(true);
    const profilesBefore = chromiumProfilesInTmp();
    const openStart = Date.now();
    const attachment = await client.openRemoteBrowser({ viewport: VIEWPORT, url: `${origin}/` });
    evidence.openMs = Date.now() - openStart;
    expect(attachment.generation).toBe(1);

    const frames: Array<{ at: number; bytes: number }> = [];
    let firstFrameAt = 0;
    attachment.onFrame((frame: RemoteBrowserFrame) => {
      if (!firstFrameAt) firstFrameAt = Date.now();
      frames.push({ at: Date.now(), bytes: frame.bytes.length });
      expect(frame.imageWidth).toBeLessThanOrEqual(attachment.limits.maxImageEdge);
      attachment.ackFrame(frame);
    });
    await nextState(attachment, (state) => state.title === "Home" && !state.loading);
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), { timeout: 10_000 });
    evidence.firstFrameMs = firstFrameAt - openStart;

    const tapAt = Date.now();
    const framesBeforeTap = frames.length;
    await attachment.dispatchInput([
      { kind: "touch", phase: "start", points: [{ id: 0, x: 100, y: 60 }] },
      { kind: "touch", phase: "end", points: [] },
    ]);
    const next = await nextState(attachment, (state) => state.title === "Next" && !state.loading);
    expect(next.url).toBe(`${origin}/next`);
    evidence.tapToNextStateMs = Date.now() - tapAt;
    const frameAfterTap = frames.slice(framesBeforeTap).find((frame) => frame.at >= tapAt);
    evidence.tapToFrameMs = frameAfterTap ? frameAfterTap.at - tapAt : null;

    await attachment.navigate({ kind: "back" });
    await nextState(attachment, (state) => state.title === "Home" && !state.loading);
    await attachment.dispatchInput([
      { kind: "touch", phase: "start", points: [{ id: 0, x: 100, y: 160 }] },
      { kind: "touch", phase: "end", points: [] },
    ]);
    const focused = await nextState(
      attachment,
      (state) => state.focusedEditable?.focusId !== undefined,
    );
    const focusId = focused.focusedEditable?.focusId;
    await attachment.dispatchInput([
      { kind: "composition", text: "ol", selectionStart: 2, selectionEnd: 2, focusId },
      { kind: "text", text: "olá", focusId },
    ]);
    await nextState(attachment, (state) => state.title === "typed:olá");
    await expect(
      attachment.dispatchInput([{ kind: "text", text: "x", focusId: (focusId ?? 0) + 1000 }]),
    ).rejects.toMatchObject({ code: "focus_changed" });

    await attachment.setVisibility(false);
    await attachment.setVisibility(true);

    // A second attach supersedes the first; the old object can no longer act.
    const second = await client.attachRemoteBrowser(attachment.browserId);
    expect(second.generation).toBe(2);
    expect(second.state.url).toBe(`${origin}/`);
    expect(attachment.ended?.kind).toBe("detached");
    await expect(attachment.navigate({ kind: "reload" })).rejects.toMatchObject({
      code: "stale_attachment",
    });
    await expect(
      client.closeRemoteBrowser(attachment.browserId, { expectedGeneration: 1 }),
    ).rejects.toMatchObject({
      code: "stale_attachment",
    });
    const listed = await client.listRemoteBrowsers();
    expect(listed).toEqual([
      expect.objectContaining({ browserId: attachment.browserId, attached: true, generation: 2 }),
    ]);

    evidence.frames = {
      count: frames.length,
      bytes: frames.reduce((total, frame) => total + frame.bytes, 0),
      windowMs: frames.length > 1 ? frames[frames.length - 1].at - frames[0].at : 0,
    };
    const profiles = chromiumProfilesInTmp().filter((name) => !profilesBefore.includes(name));
    expect(profiles).toHaveLength(1);
    expect(liveBrowserProcesses(profiles)).toBeGreaterThan(0);

    const closeStart = Date.now();
    await second.close();
    await vi.waitFor(
      () => {
        expect(liveBrowserProcesses(profiles)).toBe(0);
        expect(chromiumProfilesInTmp().filter((name) => !profilesBefore.includes(name))).toEqual(
          [],
        );
      },
      { timeout: 15_000 },
    );
    evidence.closeToCleanMs = Date.now() - closeStart;
    expect(await client.listRemoteBrowsers()).toEqual([]);
  }, 120_000);
});
