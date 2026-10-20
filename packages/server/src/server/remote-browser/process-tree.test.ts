/* eslint-disable max-nested-callbacks */
import { describe, expect, it, vi } from "vitest";
import {
  ProcessTreeTracker,
  parseLinuxProcess,
  parsePsOutput,
  type ProcessEntry,
  type ProcessTable,
} from "./process-tree.js";

function entry(
  pid: number,
  ppid: number,
  pgid: number,
  startTime: string,
  rssMb = 10,
): ProcessEntry {
  return { pid, ppid, pgid, startTime, rssBytes: rssMb * 1024 * 1024, cpuMs: 5 };
}

function table(initial: ProcessEntry[]): ProcessTable & { set(entries: ProcessEntry[]): void } {
  let entries = initial;
  return {
    async pss() {
      return 1024;
    },
    set(next) {
      entries = next;
    },
    async list() {
      return entries;
    },
    async read(pid) {
      return entries.find((candidate) => candidate.pid === pid) ?? null;
    },
  };
}

describe("ProcessTreeTracker", () => {
  it("adopts descendants and same-group helpers while the root is alive", async () => {
    const processes = table([
      entry(100, 1, 100, "1000"),
      entry(101, 100, 100, "1001"),
      entry(102, 101, 102, "1002"), // sandboxed renderer in its own group, verified parent
      entry(103, 1, 100, "1003"), // reparented helper in the root's group
      entry(200, 1, 200, "1004"), // unrelated
    ]);
    const tracker = new ProcessTreeTracker({ pid: 100, startTime: "1000" }, processes);
    const sample = await tracker.sample();
    expect(sample).toMatchObject({
      rootAlive: true,
      processCount: 4,
      rssBytes: 40 * 1024 * 1024,
      pssBytes: 4 * 1024,
    });
    expect(tracker.identities.map((identity) => identity.pid).sort()).toEqual([100, 101, 102, 103]);
  });

  it("never signals recycled root, group or child numbers", async () => {
    const processes = table([entry(100, 1, 100, "1000"), entry(101, 100, 100, "1001")]);
    const tracker = new ProcessTreeTracker({ pid: 100, startTime: "1000" }, processes);
    await tracker.sample();
    // Everything exited; unrelated processes now carry the same numbers with later start times.
    processes.set([
      entry(100, 1, 100, "9000"),
      entry(101, 1, 100, "9001"),
      entry(300, 100, 100, "9002"),
    ]);
    const sample = await tracker.sample();
    expect(sample).toMatchObject({ rootAlive: false, processCount: 0 });
    const kill = vi.fn();
    expect(await tracker.signal("SIGKILL", kill)).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not adopt by group number after the root exited", async () => {
    const processes = table([entry(100, 1, 100, "1000"), entry(101, 100, 100, "1001")]);
    const tracker = new ProcessTreeTracker({ pid: 100, startTime: "1000" }, processes);
    await tracker.sample();
    processes.set([entry(101, 1, 100, "1001"), entry(400, 1, 100, "5000")]);
    const sample = await tracker.sample();
    expect(sample).toMatchObject({ rootAlive: false, processCount: 1 });
    const kill = vi.fn();
    expect(await tracker.signal("SIGTERM", kill)).toBe(1);
    expect(kill).toHaveBeenCalledWith(101, "SIGTERM");
  });

  it("re-reads identity right before signalling", async () => {
    const processes = table([entry(100, 1, 100, "1000")]);
    const tracker = new ProcessTreeTracker({ pid: 100, startTime: "1000" }, processes);
    await tracker.sample();
    processes.set([entry(100, 1, 100, "2000")]);
    const kill = vi.fn();
    expect(await tracker.signal("SIGKILL", kill)).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("ProcessTreeTracker during a non-atomic sample", () => {
  /** list() shows a stale snapshot; read() answers from a scripted sequence per PID. */
  function racyTable(
    listed: ProcessEntry[],
    reads: Record<number, Array<ProcessEntry | null>>,
  ): ProcessTable {
    return {
      async list() {
        return listed;
      },
      async read(pid) {
        const sequence = reads[pid];
        if (!sequence || sequence.length === 0)
          return listed.find((candidate) => candidate.pid === pid) ?? null;
        return sequence.length > 1 ? (sequence.shift() ?? null) : sequence[0];
      },
    };
  }

  it("does not adopt a child of a root recycled while the list was collected", async () => {
    const stale = [entry(100, 1, 100, "1000"), entry(101, 100, 100, "9001")];
    const tracker = new ProcessTreeTracker(
      { pid: 100, startTime: "1000" },
      racyTable(stale, { 100: [entry(100, 1, 100, "9000")] }),
    );
    const sample = await tracker.sample();
    expect(sample.processCount).toBeLessThanOrEqual(1);
    expect(tracker.identities.map((identity) => identity.pid)).not.toContain(101);
    const kill = vi.fn();
    await tracker.signal("SIGKILL", kill);
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not adopt when the anchor is recycled between the two confirmations", async () => {
    const stale = [entry(100, 1, 100, "1000"), entry(101, 100, 100, "1001")];
    const tracker = new ProcessTreeTracker(
      { pid: 100, startTime: "1000" },
      racyTable(stale, { 100: [entry(100, 1, 100, "1000"), entry(100, 1, 100, "9000")] }),
    );
    await tracker.sample();
    expect(tracker.identities.map((identity) => identity.pid)).not.toContain(101);
    const kill = vi.fn();
    await tracker.signal("SIGKILL", kill);
    expect(kill).not.toHaveBeenCalledWith(101, "SIGKILL");
    expect(kill).not.toHaveBeenCalledWith(100, "SIGKILL");
  });

  it("does not adopt a group member through a recycled root group", async () => {
    const stale = [entry(100, 1, 100, "1000"), entry(300, 1, 100, "9002")];
    const tracker = new ProcessTreeTracker(
      { pid: 100, startTime: "1000" },
      racyTable(stale, { 100: [entry(100, 1, 100, "9000")] }),
    );
    await tracker.sample();
    expect(tracker.identities.map((identity) => identity.pid)).not.toContain(300);
  });
});

describe("process table parsing", () => {
  it("parses Linux stat with spaces and parentheses in the command", () => {
    const stat =
      "4242 (chrome (renderer) x) S 4200 4100 4100 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 1 0 987654 1000 0";
    expect(
      parseLinuxProcess({
        pid: 4242,
        stat,
        status: "Name:\tchrome\nVmRSS:\t  2048 kB\n",
        ticks: 100,
      }),
    ).toEqual({
      pid: 4242,
      ppid: 4200,
      pgid: 4100,
      startTime: "987654",
      rssBytes: 2048 * 1024,
      cpuMs: 3000,
    });
  });

  it("parses macOS ps output", () => {
    expect(
      parsePsOutput("  501   1   501  10240   0:01.50 Mon Oct 19 20:00:00 2026\nbad line\n"),
    ).toEqual([
      {
        pid: 501,
        ppid: 1,
        pgid: 501,
        rssBytes: 10240 * 1024,
        cpuMs: 1500,
        startTime: "Mon Oct 19 20:00:00 2026",
      },
    ]);
  });
});
