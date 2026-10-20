import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

/**
 * A process is identified by its PID **and** its start time exactly as observed. A PID number,
 * a PGID number or "started after spawn" alone cannot prove identity once a process has exited
 * and its number was reused.
 */
export interface ProcessIdentity {
  pid: number;
  startTime: string;
}

export interface ProcessEntry extends ProcessIdentity {
  ppid: number;
  pgid: number;
  /** Exited but not yet reaped: holds no memory and runs nothing. */
  zombie?: boolean;
  rssBytes: number;
  cpuMs: number;
}

export interface ProcessTable {
  list(): Promise<ProcessEntry[]>;
  read(pid: number): Promise<ProcessEntry | null>;
  /**
   * Proportional set size: shared pages split among the processes that map them. Summing RSS
   * across a browser's processes counts its shared libraries and shared memory many times.
   */
  pss?(pid: number): Promise<number | null>;
}

export interface ProcessTreeSample {
  rootAlive: boolean;
  processCount: number;
  rssBytes: number;
  /** Diagnostic only; null when any verified process's PSS could not be read. */
  pssBytes: number | null;
  cpuMs: number;
}

/**
 * Tracks the processes of one Chromium instance. The verified set starts with the root recorded
 * at spawn; a process joins only when its parent is a live verified identity, or while the
 * verified root is alive and it shares the root's process group (sandbox helpers that reparent).
 * Nothing is adopted by number after the root exited.
 */
export class ProcessTreeTracker {
  private readonly verified = new Map<number, string>();

  constructor(
    private readonly root: ProcessIdentity,
    private readonly table: ProcessTable,
  ) {
    this.verified.set(root.pid, root.startTime);
  }

  get identities(): ProcessIdentity[] {
    return [...this.verified].map(([pid, startTime]) => ({ pid, startTime }));
  }

  async sample(): Promise<ProcessTreeSample> {
    const entries = await this.table.list();
    const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
    for (const [pid, startTime] of this.verified) {
      if (byPid.get(pid)?.startTime !== startTime) this.verified.delete(pid);
    }
    const rootAlive = await this.adopt(entries);
    return { rootAlive, processCount: this.verified.size, ...(await this.usage(byPid)) };
  }

  /** Adds descendants (and root-group members while the root lives); returns whether it lives. */
  private async adopt(entries: readonly ProcessEntry[]): Promise<boolean> {
    let rootAlive = this.verified.get(this.root.pid) === this.root.startTime;
    let adopted = true;
    while (adopted) {
      adopted = false;
      for (const entry of entries) {
        if (this.verified.has(entry.pid)) continue;
        const viaParent = this.verified.has(entry.ppid);
        if (!viaParent && !(rootAlive && entry.pgid === this.root.pid)) continue;
        const anchor = viaParent ? entry.ppid : this.root.pid;
        if (await this.confirmChild(entry, anchor, viaParent)) {
          this.verified.set(entry.pid, entry.startTime);
          adopted = true;
        } else if (anchor === this.root.pid && !this.verified.has(anchor)) {
          rootAlive = false;
        }
      }
    }
    return rootAlive;
  }

  /**
   * /proc is not read atomically: the anchor may have exited and its number been reused while
   * the list was collected. Re-read the anchor before and after confirming the child.
   */
  private async confirmChild(
    entry: ProcessEntry,
    anchor: number,
    viaParent: boolean,
  ): Promise<boolean> {
    if (!(await this.anchorStillVerified(anchor))) return false;
    const child = await this.table.read(entry.pid);
    if (!child || child.startTime !== entry.startTime) return false;
    const stillLinked = viaParent ? child.ppid === anchor : child.pgid === anchor;
    return stillLinked && (await this.anchorStillVerified(anchor));
  }

  private async usage(
    byPid: ReadonlyMap<number, ProcessEntry>,
  ): Promise<{ rssBytes: number; pssBytes: number | null; cpuMs: number }> {
    let rssBytes = 0;
    let cpuMs = 0;
    let pssBytes: number | null = this.table.pss ? 0 : null;
    for (const pid of this.verified.keys()) {
      const entry = byPid.get(pid);
      if (!entry) continue;
      rssBytes += entry.rssBytes;
      cpuMs += entry.cpuMs;
      if (pssBytes !== null && this.table.pss) {
        const pss = await this.table.pss(pid);
        pssBytes = pss === null ? null : pssBytes + pss;
      }
    }
    return { rssBytes, pssBytes, cpuMs };
  }

  /** True when the anchor is verified and its current identity still matches; prunes it otherwise. */
  private async anchorStillVerified(pid: number): Promise<boolean> {
    const expected = this.verified.get(pid);
    if (expected === undefined) return false;
    const current = await this.table.read(pid);
    if (current?.startTime === expected) return true;
    this.verified.delete(pid);
    return false;
  }

  /**
   * Waits until no verified process is running (a zombie counts as exited); returns the
   * identities still running at the deadline. Only exact identities are checked.
   */
  async waitUntilGone(timeoutMs: number, pollMs = 50): Promise<ProcessIdentity[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const running: ProcessIdentity[] = [];
      for (const [pid, startTime] of this.verified) {
        const current = await this.table.read(pid);
        if (current?.startTime === startTime && !current.zombie) running.push({ pid, startTime });
        else this.verified.delete(pid);
      }
      if (running.length === 0 || Date.now() >= deadline) return running;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** Signals each verified process whose start time still matches; returns how many were signalled. */
  async signal(
    signal: NodeJS.Signals,
    kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
  ): Promise<number> {
    let signalled = 0;
    for (const [pid, startTime] of this.verified) {
      const current = await this.table.read(pid);
      if (current?.startTime !== startTime) {
        this.verified.delete(pid);
        continue;
      }
      try {
        kill(pid, signal);
        signalled += 1;
      } catch {
        this.verified.delete(pid);
      }
    }
    return signalled;
  }
}

/** Linux: `/proc/<pid>/stat` for identity, group, parent and CPU; `status` for resident memory. */
export function createLinuxProcessTable(
  options: { clockTicksPerSecond?: number } = {},
): ProcessTable {
  const ticks = options.clockTicksPerSecond ?? 100;
  async function read(pid: number): Promise<ProcessEntry | null> {
    try {
      const [stat, status] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile(`/proc/${pid}/status`, "utf8"),
      ]);
      return parseLinuxProcess({ pid, stat, status, ticks });
    } catch {
      return null;
    }
  }
  return {
    read,
    async pss(pid) {
      try {
        const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
        const kb = /^Pss:\s+(\d+)\s+kB$/m.exec(rollup)?.[1];
        return kb === undefined ? null : Number(kb) * 1024;
      } catch {
        return null;
      }
    },
    async list() {
      const names = await readdir("/proc");
      const pids = names.filter((name) => /^\d+$/.test(name)).map(Number);
      const entries = await Promise.all(pids.map((pid) => read(pid)));
      return entries.filter((entry): entry is ProcessEntry => entry !== null);
    },
  };
}

export function parseLinuxProcess(input: {
  pid: number;
  stat: string;
  status: string;
  ticks: number;
}): ProcessEntry | null {
  // The command name may contain spaces and parentheses; fields resume after the last ')'.
  const close = input.stat.lastIndexOf(")");
  if (close === -1) return null;
  const fields = input.stat
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // fields[0] is field 3 (state); field N is fields[N - 3].
  const zombie = fields[0] === "Z" || fields[0] === "X";
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const startTime = fields[19];
  if (!startTime || !Number.isInteger(ppid) || !Number.isInteger(pgid)) return null;
  const rssKb = /^VmRSS:\s+(\d+)\s+kB$/m.exec(input.status)?.[1];
  return {
    pid: input.pid,
    ppid,
    pgid,
    startTime,
    rssBytes: rssKb ? Number(rssKb) * 1024 : 0,
    cpuMs: ((utime + stime) * 1000) / input.ticks,
    ...(zombie ? { zombie } : {}),
  };
}

const PS_FIELDS = "pid=,ppid=,pgid=,rss=,time=,lstart=";

function runPs(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ps", args, { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error && !stdout) reject(error);
      else resolve(stdout);
    });
  });
}

/** macOS: one bounded `ps` read per sample; `lstart` is the start time identity. */
export function createDarwinProcessTable(): ProcessTable {
  return {
    async list() {
      return parsePsOutput(await runPs(["-A", "-o", PS_FIELDS]));
    },
    async read(pid) {
      try {
        return parsePsOutput(await runPs(["-o", PS_FIELDS, "-p", String(pid)]))[0] ?? null;
      } catch {
        return null;
      }
    },
  };
}

export function parsePsOutput(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      rssBytes: Number(match[4]) * 1024,
      cpuMs: parsePsTime(match[5]),
      startTime: match[6],
    });
  }
  return entries;
}

function parsePsTime(value: string): number {
  const [clock, fraction = "0"] = value.split(".");
  const parts = clock.split(":").map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds * 1000 + Number(`0.${fraction}`) * 1000;
}

export function createProcessTable(platform: NodeJS.Platform): ProcessTable {
  return platform === "darwin" ? createDarwinProcessTable() : createLinuxProcessTable();
}
