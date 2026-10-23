import { randomUUID } from "node:crypto";
import {
  coverageSchema,
  evidenceRevision,
  parseEvidence,
  parseManifest,
  sampleKey,
  type EvidenceBundle,
  type EvidenceManifest,
  type EvidenceRevision,
} from "./contract";

export interface EvidenceClock {
  now(): number;
}

export function createEvidenceRecorder(input: EvidenceManifest, clock: EvidenceClock) {
  const manifest = parseManifest(input);
  const started = clock.now();
  if (!Number.isFinite(started) || started < 0) throw new Error("Invalid capture clock");
  let previous = started;
  const sequences = new Set<string>();
  const covered = new Set<string>();
  const bundle: EvidenceBundle = {
    version: 1,
    captureId: randomUUID(),
    revision: 0,
    closure: "open",
    manifestSha256: manifest.sha256,
    samples: [],
    coverage: [],
    attempted: 0,
    accepted: 0,
    rejected: 0,
    dropped: 0,
    finished: false,
    reasons: [],
  };

  function invalidate(reason: EvidenceBundle["reasons"][number]): void {
    bundle.closure = "invalidated";
    if (!bundle.reasons.includes(reason)) bundle.reasons.push(reason);
  }

  function advance(): void {
    if (bundle.revision === Number.MAX_SAFE_INTEGER) throw new Error("Evidence revision overflow");
    bundle.revision += 1;
  }

  function withinDeadline(): boolean {
    const now = clock.now();
    if (!Number.isFinite(now) || now < previous) {
      invalidate("clock_regression");
      return false;
    }
    previous = now;
    if (now - started > manifest.limits.durationMs) {
      invalidate("deadline");
      return false;
    }
    return true;
  }

  function record(inputSample: unknown): boolean {
    advance();
    bundle.attempted += 1;
    if (bundle.finished) {
      bundle.rejected += 1;
      invalidate("late_record");
      return false;
    }
    if (!withinDeadline()) {
      bundle.rejected += 1;
      return false;
    }
    if (bundle.attempted > manifest.limits.maxRecords) {
      bundle.dropped += 1;
      invalidate("overflow");
      return false;
    }
    try {
      const sample = parseEvidence(manifest, inputSample);
      const key = `${sampleKey(sample)}/${sample.sequence}`;
      if (sequences.has(key)) throw new Error("Duplicate performance sample");
      sequences.add(key);
      bundle.samples.push(sample);
      bundle.accepted += 1;
      return true;
    } catch {
      bundle.rejected += 1;
      invalidate("invalid_sample");
      return false;
    }
  }

  function declareCoverage(inputCoverage: unknown): boolean {
    advance();
    if (bundle.finished) {
      invalidate("late_record");
      return false;
    }
    if (!withinDeadline()) return false;
    const parsed = coverageSchema.safeParse(inputCoverage);
    if (!parsed.success) {
      invalidate("invalid_coverage");
      return false;
    }
    const coverage = parsed.data;
    const series = manifest.series.find((candidate) => candidate.id === coverage.seriesId);
    const key = sampleKey(coverage);
    if (
      !series?.cycles.includes(coverage.cycle) ||
      !manifest.schedule.some((slot) => slot.id === coverage.runId) ||
      covered.has(key)
    ) {
      invalidate("invalid_coverage");
      return false;
    }
    covered.add(key);
    bundle.coverage.push(coverage);
    return true;
  }

  function finish(): EvidenceBundle {
    if (!bundle.finished) {
      advance();
      withinDeadline();
      if (bundle.closure === "open") bundle.closure = "finished";
    }
    bundle.finished = true;
    return structuredClone(bundle);
  }

  function matchesRevision(expected: EvidenceRevision): boolean {
    const current = evidenceRevision(bundle);
    return (
      bundle.finished &&
      current.closure === "finished" &&
      current.revision === expected.revision &&
      current.bundleSha256 === expected.bundleSha256 &&
      expected.closure === "finished"
    );
  }

  return { record, declareCoverage, finish, matchesRevision };
}

export type EvidenceRecorder = ReturnType<typeof createEvidenceRecorder>;
