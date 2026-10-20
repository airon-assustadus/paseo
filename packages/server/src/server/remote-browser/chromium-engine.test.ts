import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchChromiumEngine } from "./chromium-engine.js";
import { RemoteBrowserUnavailableError } from "./engine.js";
import { createLinuxProcessTable } from "./process-tree.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Running means present and not a zombie (an exited child awaiting its reaper). */
function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform !== "linux")("launchChromiumEngine containment", () => {
  it("terminates a browser whose CDP pipe never answers, with its children, proxy and profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-rb-engine-test-"));
    dirs.push(root);
    const pidFile = path.join(root, "child.pid");
    const executable = path.join(root, "silent-browser.sh");
    // Keeps fd 3/4 open, never speaks CDP, and leaves a child behind like a zygote would.
    await writeFile(executable, `#!/bin/sh\nsleep 300 &\necho $! > '${pidFile}'\nexec sleep 300\n`);
    await chmod(executable, 0o755);
    const tempRoot = path.join(root, "tmp");
    await mkdir(tempRoot);
    const ports: Array<[number, boolean]> = [];
    const launching = launchChromiumEngine(
      {
        executable,
        logger: pino({ level: "silent" }),
        processTable: createLinuxProcessTable(),
        deniedProxyPorts: () => new Set(),
        onProxyPort: (port, active) => ports.push([port, active]),
        tempRoot,
        launchTimeoutMs: 500,
        closeGraceMs: 200,
        terminateGraceMs: 1000,
      },
      {
        viewport: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, touch: true },
        renderScale: 2,
        initialUrl: null,
      },
    );
    await expect(launching).rejects.toBeInstanceOf(RemoteBrowserUnavailableError);
    const childPid = Number((await readFile(pidFile, "utf8")).trim());
    expect(childPid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(alive(childPid)).toBe(false), { timeout: 5000 });
    expect(await readdir(tempRoot)).toEqual([]);
    // Policy proxy and deny-all browser proxy: each opened once and released once.
    const opened = ports
      .filter(([, active]) => active)
      .map(([port]) => port)
      .sort();
    const released = ports
      .filter(([, active]) => !active)
      .map(([port]) => port)
      .sort();
    expect(opened).toHaveLength(2);
    expect(released).toEqual(opened);
  });

  it("confirms every process is gone before close resolves, even when SIGTERM is ignored", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-rb-engine-test-"));
    dirs.push(root);
    const pidFile = path.join(root, "child.pid");
    const executable = path.join(root, "stubborn-browser.sh");
    // Root and child ignore SIGTERM; only the verified SIGKILL ends them.
    await writeFile(
      executable,
      `#!/bin/sh\ntrap '' TERM\n(trap '' TERM; exec sleep 300) &\necho $! > '${pidFile}'\nexec sleep 300\n`,
    );
    await chmod(executable, 0o755);
    const tempRoot = path.join(root, "tmp");
    await mkdir(tempRoot);
    const launching = launchChromiumEngine(
      {
        executable,
        logger: pino({ level: "silent" }),
        processTable: createLinuxProcessTable(),
        deniedProxyPorts: () => new Set(),
        onProxyPort: () => {},
        tempRoot,
        launchTimeoutMs: 300,
        closeGraceMs: 100,
        terminateGraceMs: 500,
      },
      {
        viewport: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, touch: true },
        renderScale: 2,
        initialUrl: null,
      },
    );
    await expect(launching).rejects.toBeInstanceOf(RemoteBrowserUnavailableError);
    // No waiting here: close only resolved after the exit was confirmed.
    const childPid = Number((await readFile(pidFile, "utf8")).trim());
    expect(running(childPid)).toBe(false);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("reports a missing executable as unavailable and leaves nothing behind", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-rb-engine-test-"));
    dirs.push(root);
    await expect(
      launchChromiumEngine(
        {
          executable: path.join(root, "missing-browser"),
          logger: pino({ level: "silent" }),
          processTable: createLinuxProcessTable(),
          deniedProxyPorts: () => new Set(),
          onProxyPort: () => {},
          tempRoot: root,
          launchTimeoutMs: 500,
          closeGraceMs: 100,
          terminateGraceMs: 100,
        },
        {
          viewport: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, touch: true },
          renderScale: 2,
          initialUrl: null,
        },
      ),
    ).rejects.toBeInstanceOf(RemoteBrowserUnavailableError);
    expect(await readdir(root)).toEqual([]);
  });
});
