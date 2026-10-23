import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  createFiniteManifest,
  evidenceHash,
  finiteSchedule,
  METRICS,
  parseEvidence,
  parseManifest,
  type EvidenceManifest,
  type EvidenceSample,
  type ManifestInput,
  type Metric,
} from "../../e2e/support/web-proxy-performance/contract";
import { createEvidenceRecorder } from "../../e2e/support/web-proxy-performance/recorder";
import {
  analyzeMemoryPlateau,
  compareWarmLoads,
  consumePerformanceAnalysis,
  isPerformanceAnalysisCurrent,
  summarizeSeries,
} from "../../e2e/support/web-proxy-performance/analysis";
import { createSyntheticFixture } from "../../e2e/support/web-proxy-performance/fixture";

const artifactHash = "a".repeat(64);
const cycles = Array.from({ length: 20 }, (_, index) => index + 1);

function manifestInput(metric: Metric = "event_handler_ms"): ManifestInput {
  const visual = metric === "content_load_ms" || metric === "display_latency_ms";
  const actions = {
    event_handler_ms: "typing",
    display_latency_ms: "click",
    content_load_ms: "load",
    data_ready_ms: "load",
    raf_gap_ms: "observer",
    long_task_ms: "observer",
    flow_bytes: "traffic",
    cpu_percent: "cpu",
    phone_pss_bytes: "memory",
    host_rss_bytes: "memory",
  } as const;
  return {
    version: 1,
    cellId: "synthetic-cell",
    origin: "synthetic",
    stage: "calibration",
    productCommit: "a".repeat(40),
    fixtureSha256: artifactHash,
    scriptSha256: artifactHash,
    analyzerSha256: artifactHash,
    environmentSha256: artifactHash,
    adjudicationSha256: artifactHash,
    warmComparison: {
      rttMs: 20,
      rttUncertaintyMs: 0.01,
      marginMs: 100,
      rttEvidenceSha256: artifactHash,
    },
    limits: { maxRecords: 1000, durationMs: 1000 },
    series: [
      {
        id: "observations",
        metric,
        action: actions[metric],
        phase: "warm",
        cycles,
        expectedPerCycle: 1,
        bindings: finiteSchedule().map((slot) => ({
          runId: slot.id,
          clock: {
            id: `clock-${slot.id}`,
            scope: "cycle",
            kind: visual ? "video-timeline" : "document-monotonic",
            resolutionMs: 0.01,
          },
          source: {
            id: `source-${slot.id}`,
            side: metric === "host_rss_bytes" ? "host" : "phone",
            producerSha256: artifactHash,
            artifactSha256: artifactHash,
            method: METRICS[metric].method,
            flow:
              metric === "flow_bytes"
                ? { id: "flow-one", direction: "outbound", layer: "protocol-frame" }
                : null,
          },
        })),
      },
    ],
  };
}

function sampleFor(
  manifest: EvidenceManifest,
  runId = "run-1-d",
  cycle = 1,
  value = 10,
): EvidenceSample {
  const series = manifest.series[0]!;
  const slot = manifest.schedule.find((candidate) => candidate.id === runId)!;
  const binding = series.bindings.find((candidate) => candidate.runId === runId)!;
  const definition = METRICS[series.metric];
  return {
    version: 1,
    manifestSha256: manifest.sha256,
    runId,
    path: slot.path,
    seriesId: series.id,
    phase: series.phase,
    cycle,
    sequence: 1,
    metric: series.metric,
    unit: definition.unit,
    boundary: definition.boundary,
    status: "ok",
    value,
    start: { clockId: `${binding.clock.id}-c${cycle}`, timeMs: 0 },
    end: { clockId: `${binding.clock.id}-c${cycle}`, timeMs: definition.unit === "ms" ? value : 1 },
    uncertaintyMs: 0.01,
    source: structuredClone(binding.source),
  };
}

function completeCapture(
  manifest: EvidenceManifest,
  value: (cycle: number, path: "D" | "J" | "P", warmup: boolean) => number = (cycle) => cycle,
) {
  const recorder = createEvidenceRecorder(manifest, { now: () => 0 });
  for (const slot of manifest.schedule) {
    for (const cycle of manifest.series[0]!.cycles) {
      recorder.record(sampleFor(manifest, slot.id, cycle, value(cycle, slot.path, slot.warmup)));
      recorder.declareCoverage({
        runId: slot.id,
        seriesId: "observations",
        cycle,
        produced: 1,
        dropped: 0,
        supported: true,
        complete: true,
      });
    }
  }
  return { recorder, bundle: recorder.finish() };
}

describe("finite performance evidence contract", () => {
  it("pins eighteen slots, five alternating measured blocks and twenty warm cycles", () => {
    const manifest = createFiniteManifest(manifestInput());
    expect(manifest.schedule).toHaveLength(18);
    expect(manifest.schedule.filter((slot) => slot.warmup).map((slot) => slot.path)).toEqual([
      "D",
      "J",
      "P",
    ]);
    expect(
      manifest.schedule
        .filter((slot) => !slot.warmup)
        .map((slot) => slot.path)
        .join(""),
    ).toBe("DJPPJDDJPPJDDJP");
    expect(manifest.series[0]!.cycles).toHaveLength(20);
    expect(parseManifest(manifest)).toEqual(manifest);
    expect(createFiniteManifest(manifestInput()).sha256).toBe(manifest.sha256);
    expect(evidenceHash({ first: 1, second: 2 })).toBe(evidenceHash({ second: 2, first: 1 }));
  });

  it.each(["denominator", "schedule", "margin"])(
    "rejects post-capture %s mutations without a new manifest",
    (field) => {
      const manifest = createFiniteManifest(manifestInput());
      if (field === "denominator") manifest.series[0]!.expectedPerCycle = 2;
      if (field === "schedule") manifest.schedule.reverse();
      if (field === "margin") manifest.warmComparison!.marginMs = 999;
      expect(() => parseManifest(manifest)).toThrow();
    },
  );

  it("requires adjudication for acceptance without treating its hash as chronology proof", () => {
    const input = manifestInput();
    input.stage = "acceptance";
    input.adjudicationSha256 = null;
    expect(() => createFiniteManifest(input)).toThrow();
  });

  it.each([NaN, Infinity, -1])("rejects invalid values %s", (value) => {
    const manifest = createFiniteManifest(manifestInput());
    expect(() => parseEvidence(manifest, { ...sampleFor(manifest), value })).toThrow();
  });

  it.each([
    { unit: "bytes" },
    { boundary: "input-to-display" },
    { path: "P" },
    { phase: "cold" },
    { cycle: 0 },
    { manifestSha256: "b".repeat(64) },
    { url: "https://must-not-be-captured.invalid" },
    { value: 0 },
  ])("rejects mismatched or extra sample fields %j", (patch) => {
    const manifest = createFiniteManifest(manifestInput());
    expect(() => parseEvidence(manifest, { ...sampleFor(manifest), ...patch })).toThrow();
  });

  it("rejects cross-clock subtraction, source swaps and proxy methods", () => {
    const manifest = createFiniteManifest(manifestInput());
    const sample = sampleFor(manifest);
    expect(() =>
      parseEvidence(manifest, { ...sample, end: { clockId: "other-document", timeMs: 10 } }),
    ).toThrow();
    expect(() =>
      parseEvidence(manifest, { ...sample, source: { ...sample.source, id: "other-source" } }),
    ).toThrow();
    const input = manifestInput("cpu_percent");
    input.series[0]!.bindings[0]!.source.method = "performance-now";
    expect(() => createFiniteManifest(input)).toThrow();
  });

  it("does not permit host JPEG receipt to masquerade as phone display", () => {
    const input = manifestInput("content_load_ms");
    input.series[0]!.bindings[0]!.source.side = "host";
    expect(() => createFiniteManifest(input)).toThrow();
  });

  it("assigns a separate clock domain to each reopen cycle", () => {
    const manifest = createFiniteManifest(manifestInput());
    const previous = sampleFor(manifest, "run-1-d", 1);
    const current = sampleFor(manifest, "run-1-d", 2);
    expect(current.start.clockId).not.toBe(previous.start.clockId);
    expect(() =>
      parseEvidence(manifest, { ...current, start: previous.start, end: previous.end }),
    ).toThrow();
  });

  it("requires an explicit flow boundary and integral byte count", () => {
    const input = manifestInput("flow_bytes");
    const manifest = createFiniteManifest(input);
    expect(() => parseEvidence(manifest, sampleFor(manifest, "run-1-d", 1, 0))).not.toThrow();
    expect(() => parseEvidence(manifest, sampleFor(manifest, "run-1-d", 1, 1.5))).toThrow();
    input.series[0]!.bindings[0]!.source.flow = null;
    expect(() => createFiniteManifest(input)).toThrow();
  });
});

describe("bounded capture", () => {
  it("counts rejected records and rejects duplicate sequences", () => {
    const manifest = createFiniteManifest(manifestInput());
    const recorder = createEvidenceRecorder(manifest, { now: () => 0 });
    expect(recorder.record(sampleFor(manifest))).toBe(true);
    expect(recorder.record(sampleFor(manifest))).toBe(false);
    expect(recorder.record({})).toBe(false);
    expect(recorder.finish()).toMatchObject({ attempted: 3, accepted: 1, rejected: 2, dropped: 0 });
  });

  it("caps capture and never overwrites accepted samples", () => {
    const input = manifestInput();
    input.limits.maxRecords = 1;
    const manifest = createFiniteManifest(input);
    const recorder = createEvidenceRecorder(manifest, { now: () => 0 });
    recorder.record(sampleFor(manifest));
    recorder.record(sampleFor(manifest, "run-1-d", 2));
    const bundle = recorder.finish();
    expect(bundle).toMatchObject({ attempted: 2, accepted: 1, dropped: 1, reasons: ["overflow"] });
    expect(bundle.samples[0]!.cycle).toBe(1);
  });

  it.each([
    [-1, "clock_regression"],
    [1001, "deadline"],
    [Infinity, "clock_regression"],
  ])("invalidates capture clock %s", (time, reason) => {
    const manifest = createFiniteManifest(manifestInput());
    let now = 0;
    const recorder = createEvidenceRecorder(manifest, { now: () => now });
    now = Number(time);
    expect(recorder.record(sampleFor(manifest))).toBe(false);
    expect(recorder.finish().reasons).toContain(reason);
  });

  it("checks deadline on finish even with no further records", () => {
    let now = 0;
    const recorder = createEvidenceRecorder(createFiniteManifest(manifestInput()), {
      now: () => now,
    });
    now = 1001;
    expect(recorder.finish().reasons).toContain("deadline");
  });

  it("late records invalidate consumption of the previously captured revision", () => {
    const manifest = createFiniteManifest(manifestInput());
    const { recorder, bundle } = completeCapture(manifest);
    const summary = summarizeSeries(manifest, bundle, "observations");
    expect(summary).toMatchObject({ status: "provisional", integrity: "complete" });
    expect(consumePerformanceAnalysis(recorder, summary).status).toBe("complete");
    recorder.record(sampleFor(manifest));
    const current = recorder.finish();
    expect(current.reasons).toContain("late_record");
    expect(current.attempted).toBe(current.accepted + current.rejected + current.dropped);
    expect(current.revision).toBeGreaterThan(bundle.revision);
    expect(consumePerformanceAnalysis(recorder, summary).status).toBe("INC");
    expect(summarizeSeries(manifest, current, "observations").integrity).toBe("INC");
  });

  it("late coverage also invalidates completeness", () => {
    const manifest = createFiniteManifest(manifestInput());
    const { recorder } = completeCapture(manifest);
    expect(recorder.declareCoverage({})).toBe(false);
    expect(recorder.finish().reasons).toContain("late_record");
  });
});

describe("CP2 normative workload barriers", () => {
  it.each([1, 19])("rejects a warm workload with only %s cycles", (length) => {
    const input = manifestInput();
    input.series[0]!.cycles = cycles.slice(0, length);
    expect(() => createFiniteManifest(input)).toThrow();
  });

  it("does not let a variable denominator legitimize one warm cycle", () => {
    const input = manifestInput("raf_gap_ms");
    input.series[0]!.action = "observer";
    input.series[0]!.cycles = [1];
    input.series[0]!.expectedPerCycle = null;
    expect(() => createFiniteManifest(input)).toThrow();
  });

  it.each([null, 0, 2])("rejects a typing denominator of %s per cycle", (expectedPerCycle) => {
    const input = manifestInput();
    input.series[0]!.expectedPerCycle = expectedPerCycle;
    expect(() => createFiniteManifest(input)).toThrow();
  });

  it("requires twelve memory points and a fixed single cold observation", () => {
    const memory = manifestInput("phone_pss_bytes");
    memory.series[0]!.cycles = [5, ...cycles.slice(10)];
    expect(() => createFiniteManifest(memory)).toThrow();
    const cold = manifestInput("content_load_ms");
    cold.series[0]!.phase = "cold";
    cold.series[0]!.cycles = [0];
    cold.series[0]!.expectedPerCycle = null;
    expect(() => createFiniteManifest(cold)).toThrow();
  });

  it("requires coverage of every warm cycle even for variable observer counts", () => {
    const input = manifestInput("raf_gap_ms");
    input.series[0]!.expectedPerCycle = null;
    const manifest = createFiniteManifest(input);
    const { bundle } = completeCapture(manifest);
    bundle.coverage = bundle.coverage.filter((entry) => entry.cycle !== 20);
    expect(summarizeSeries(manifest, bundle, "observations").integrity).toBe("INC");
  });
});

describe("CP2 revision consumption barriers", () => {
  it.each(["finished_without_end", "open_after_end", "finished_with_loss"])(
    "rejects inconsistent closure %s",
    (mutation) => {
      const manifest = createFiniteManifest(manifestInput());
      const { recorder, bundle } = completeCapture(manifest);
      if (mutation === "finished_without_end") bundle.finished = false;
      if (mutation === "open_after_end") bundle.closure = "open";
      if (mutation === "finished_with_loss") bundle.reasons.push("late_record");
      const result = summarizeSeries(manifest, bundle, "observations");
      expect(result.integrity).toBe("INC");
      expect(consumePerformanceAnalysis(recorder, result).status).toBe("INC");
    },
  );

  it.each(["record", "coverage"])("rejects saved analyses and exports after late %s", (late) => {
    const manifest = createFiniteManifest(manifestInput());
    const { recorder, bundle } = completeCapture(manifest);
    const summary = summarizeSeries(manifest, bundle, "observations");
    const serializedSummary = JSON.stringify(summary);
    expect(summary.status).toBe("provisional");
    const exported = consumePerformanceAnalysis(recorder, summary);
    const serializedExport = JSON.stringify(exported);
    expect(exported).toMatchObject({
      status: "complete",
      scope: "offline-integrity-as-of-revision",
      currentness: "revalidate-before-consumption",
      productVerdict: "not_evaluated",
    });
    expect(isPerformanceAnalysisCurrent(recorder, exported)).toBe(true);
    if (late === "record") recorder.record(sampleFor(manifest));
    else recorder.declareCoverage({});
    expect(recorder.finish().closure).toBe("invalidated");
    expect(isPerformanceAnalysisCurrent(recorder, summary)).toBe(false);
    expect(isPerformanceAnalysisCurrent(recorder, exported)).toBe(false);
    expect(consumePerformanceAnalysis(recorder, summary).status).toBe("INC");
    expect(consumePerformanceAnalysis(recorder, exported).status).toBe("INC");
    expect(JSON.stringify(summary)).toBe(serializedSummary);
    expect(JSON.stringify(exported)).toBe(serializedExport);
    expect(JSON.parse(serializedSummary).status).toBe("provisional");
    expect(isPerformanceAnalysisCurrent(recorder, JSON.parse(serializedExport))).toBe(false);
  });

  it("does not accept another recorder or a changed offline copy as live authority", () => {
    const manifest = createFiniteManifest(manifestInput());
    const first = completeCapture(manifest);
    const second = completeCapture(manifest);
    const summary = summarizeSeries(manifest, first.bundle, "observations");
    expect(consumePerformanceAnalysis(second.recorder, summary).status).toBe("INC");
    const copied = structuredClone(first.bundle);
    copied.samples[0]!.value = 99;
    copied.samples[0]!.end.timeMs = 99;
    const altered = summarizeSeries(manifest, copied, "observations");
    expect(altered.integrity).toBe("complete");
    expect(consumePerformanceAnalysis(first.recorder, altered).status).toBe("INC");
  });

  it("rejects unfinished revisions, detached summaries and mutated results", () => {
    const manifest = createFiniteManifest(manifestInput());
    const { recorder, bundle } = completeCapture(manifest);
    const summary = summarizeSeries(manifest, bundle, "observations");
    expect(consumePerformanceAnalysis(recorder, structuredClone(summary)).status).toBe("INC");
    summary.runs[0]!.distribution!.p95 = 0;
    expect(consumePerformanceAnalysis(recorder, summary).status).toBe("INC");
    bundle.finished = false;
    bundle.closure = "open";
    const unfinished = summarizeSeries(manifest, bundle, "observations");
    expect(unfinished.integrity).toBe("INC");
    expect(consumePerformanceAnalysis(recorder, unfinished).status).toBe("INC");
  });

  it.each(["memory", "comparison"])("applies the same live barrier to %s", (kind) => {
    const input = manifestInput(kind === "memory" ? "phone_pss_bytes" : "content_load_ms");
    if (kind === "memory") input.series[0]!.cycles = [5, ...cycles.slice(9)];
    const manifest = createFiniteManifest(input);
    const { recorder, bundle } = completeCapture(
      manifest,
      (_cycle, path) => ({ D: 100, J: 300, P: 250 })[path],
    );
    const analysis =
      kind === "memory"
        ? analyzeMemoryPlateau(manifest, bundle, "observations", "run-1-d")
        : compareWarmLoads(manifest, bundle, "observations");
    expect(analysis).toMatchObject({ status: "provisional", integrity: "complete" });
    expect(consumePerformanceAnalysis(recorder, analysis).status).toBe("complete");
    recorder.declareCoverage({});
    expect(consumePerformanceAnalysis(recorder, analysis).status).toBe("INC");
  });
});

describe("offline analysis", () => {
  it("keeps run denominators, excludes warmups and uses nearest rank", () => {
    const manifest = createFiniteManifest(manifestInput());
    const { bundle } = completeCapture(manifest, (cycle, _path, warmup) => (warmup ? 900 : cycle));
    const summary = summarizeSeries(manifest, bundle, "observations");
    expect(summary).toMatchObject({
      status: "provisional",
      integrity: "complete",
      productVerdict: "not_evaluated",
      plannedRuns: 15,
      observedWarmups: 3,
    });
    expect(summary.runs).toHaveLength(15);
    expect(summary.runs[0]).toMatchObject({
      expected: 20,
      observed: 20,
      failed: 0,
      distribution: { count: 20, p50: 10, p95: 19, maximum: 20 },
    });
  });

  it("empty evidence is INC with no measured zero", () => {
    const manifest = createFiniteManifest(manifestInput());
    const recorder = createEvidenceRecorder(manifest, { now: () => 0 });
    const summary = summarizeSeries(manifest, recorder.finish(), "observations");
    expect(summary.integrity).toBe("INC");
    expect(
      summary.runs.every((run) => run.distribution === null && run.singleObservation === null),
    ).toBe(true);
  });

  it.each([
    "missing",
    "false_count",
    "failed",
    "unsupported",
    "gap",
    "coverage_loss",
    "coverage_absent",
    "unfinished",
    "duplicate",
  ])("retains %s as incomplete", (mutation) => {
    const manifest = createFiniteManifest(manifestInput());
    const bundle = structuredClone(completeCapture(manifest).bundle);
    const index = bundle.samples.findIndex((sample) => sample.runId === "run-1-d");
    if (mutation === "missing") {
      bundle.samples.splice(index, 1);
      bundle.accepted -= 1;
      bundle.attempted -= 1;
    }
    if (mutation === "false_count") bundle.accepted += 1;
    if (mutation === "failed" || mutation === "unsupported") {
      bundle.samples[index]!.status = mutation;
      bundle.samples[index]!.value = null;
    }
    if (mutation === "gap") bundle.samples[index]!.sequence = 2;
    if (mutation === "coverage_loss")
      bundle.coverage.find((entry) => entry.runId === "run-1-d")!.dropped = 1;
    if (mutation === "coverage_absent") bundle.coverage = [];
    if (mutation === "unfinished") bundle.finished = false;
    if (mutation === "duplicate") {
      bundle.samples.push(bundle.samples[index]!);
      bundle.accepted += 1;
      bundle.attempted += 1;
    }
    const summary = summarizeSeries(manifest, bundle, "observations");
    expect(summary.integrity).toBe("INC");
    if (mutation === "failed")
      expect(summary.runs[0]).toMatchObject({ observed: 20, failed: 1, distribution: null });
  });

  it("variable series require declared count and coverage", () => {
    const input = manifestInput("raf_gap_ms");
    input.series[0]!.expectedPerCycle = null;
    const manifest = createFiniteManifest(input);
    const bundle = structuredClone(completeCapture(manifest).bundle);
    expect(summarizeSeries(manifest, bundle, "observations").integrity).toBe("complete");
    bundle.coverage = [];
    expect(summarizeSeries(manifest, bundle, "observations").runs[0]!.expected).toBeNull();
  });

  it("reports missing warmups separately without silently accepting their absence", () => {
    const manifest = createFiniteManifest(manifestInput());
    const bundle = structuredClone(completeCapture(manifest).bundle);
    bundle.samples = bundle.samples.filter((sample) => !sample.runId.startsWith("warmup-"));
    bundle.accepted = bundle.samples.length;
    bundle.attempted = bundle.samples.length;
    const result = summarizeSeries(manifest, bundle, "observations");
    expect(result.integrity).toBe("INC");
    expect(result.runs.every((run) => run.status === "complete")).toBe(true);
    expect(result.warmups.every((run) => run.status === "INC")).toBe(true);
  });

  it("publishes five cold observations per path without per-run tail estimates", () => {
    const input = manifestInput("data_ready_ms");
    input.series[0]!.phase = "cold";
    input.series[0]!.cycles = [0];
    const manifest = createFiniteManifest(input);
    const summary = summarizeSeries(
      manifest,
      completeCapture(manifest, () => 42).bundle,
      "observations",
    );
    expect(summary.integrity).toBe("complete");
    expect(summary.runs.filter((run) => run.path === "D")).toHaveLength(5);
    expect(
      summary.runs.every((run) => run.singleObservation === 42 && run.distribution === null),
    ).toBe(true);
  });

  it("computes OLS on eleven late cycles and the independent cycle-five ratio", () => {
    const input = manifestInput("phone_pss_bytes");
    input.series[0]!.cycles = [5, ...cycles.slice(9)];
    input.series[0]!.action = "memory";
    const manifest = createFiniteManifest(input);
    const bundle = completeCapture(manifest, (cycle) => 1000 + 2 * cycle).bundle;
    expect(analyzeMemoryPlateau(manifest, bundle, "observations", "run-1-d")).toMatchObject({
      status: "provisional",
      integrity: "complete",
      productVerdict: "not_evaluated",
      slopeBytesPerCycle: 2,
      finalToBaseline: 1040 / 1010,
    });
  });

  it.each(["missing", "zero_baseline", "mixed_source"])("rejects memory %s", (mutation) => {
    const input = manifestInput("host_rss_bytes");
    input.series[0]!.cycles = [5, ...cycles.slice(9)];
    const manifest = createFiniteManifest(input);
    const bundle = structuredClone(completeCapture(manifest, () => 1000).bundle);
    const index = bundle.samples.findIndex((sample) => sample.runId === "run-1-d");
    if (mutation === "missing") {
      bundle.samples.splice(index, 1);
      bundle.accepted -= 1;
      bundle.attempted -= 1;
    }
    if (mutation === "zero_baseline") bundle.samples[index]!.value = 0;
    if (mutation === "mixed_source") bundle.samples[index]!.source.id = "another-process-tree";
    expect(analyzeMemoryPlateau(manifest, bundle, "observations", "run-1-d").integrity).toBe("INC");
  });

  it("publishes both warm comparisons without choosing the more favorable one", () => {
    const manifest = createFiniteManifest(manifestInput("content_load_ms"));
    const bundle = completeCapture(
      manifest,
      (_cycle, path) => ({ D: 100, J: 300, P: 250 })[path],
    ).bundle;
    expect(compareWarmLoads(manifest, bundle, "observations")).toMatchObject({
      status: "provisional",
      integrity: "complete",
      productVerdict: "not_evaluated",
      comparison: {
        directMs: 100,
        jpegMs: 300,
        domMs: 250,
        domMinusJpegMs: -50,
        directRttMarginMs: 220,
        domMinusDirectRttMarginMs: 30,
        runsPerPath: 5,
      },
    });
  });

  it("rejects absent adjudication and a missing run rather than pooling remaining samples", () => {
    const input = manifestInput("content_load_ms");
    input.warmComparison = null;
    const manifest = createFiniteManifest(input);
    expect(
      compareWarmLoads(manifest, completeCapture(manifest).bundle, "observations").integrity,
    ).toBe("INC");
    const valid = createFiniteManifest(manifestInput("content_load_ms"));
    const bundle = structuredClone(completeCapture(valid).bundle);
    bundle.samples = bundle.samples.filter((sample) => sample.runId !== "run-5-p");
    bundle.accepted = bundle.samples.length;
    bundle.attempted = bundle.samples.length;
    expect(compareWarmLoads(valid, bundle, "observations").integrity).toBe("INC");
  });

  it("retains both numeric comparisons but marks unresolved precision INC", () => {
    const manifest = createFiniteManifest(manifestInput("content_load_ms"));
    const bundle = structuredClone(
      completeCapture(manifest, (_cycle, path) => ({ D: 100, J: 300, P: 250 })[path]).bundle,
    );
    bundle.samples.forEach((sample) => {
      sample.uncertaintyMs = 100;
    });
    expect(compareWarmLoads(manifest, bundle, "observations")).toMatchObject({
      status: "provisional",
      integrity: "INC",
      comparison: { domMinusJpegMs: -50, domMinusDirectRttMarginMs: 30 },
    });
  });
});

describe("synthetic fixture bytes", () => {
  function fixturePorts() {
    interface FixtureResult {
      status: string;
      attempted: number;
      accepted: number;
      dropped: number;
      late: number;
      deadlineExceeded: boolean;
      samples: unknown[];
    }
    interface FixtureApi {
      begin(clockId: string, capacity: number, durationMs: number): void;
      finish(): FixtureResult;
    }
    const handlers = new Map<string, (event: { preventDefault(): void }) => void>();
    const selectors = [
      "#synthetic-input",
      "#synthetic-output",
      "#synthetic-click",
      "#synthetic-state",
      "#synthetic-form",
    ];
    const elements = new Map(
      selectors.map((selector) => [
        selector,
        {
          value: "synthetic-input-not-exported",
          textContent: "",
          addEventListener(name: string, handler: (event: { preventDefault(): void }) => void) {
            handlers.set(`${selector}/${name}`, handler);
          },
        },
      ]),
    );
    const documentPort = {
      querySelector: (selector: string) => elements.get(selector),
      documentElement: { dataset: {} },
    };
    const windowPort: { p05SyntheticFixture?: FixtureApi } = {};
    let now = 0;
    runInNewContext(createSyntheticFixture().script, {
      document: documentPort,
      window: windowPort,
      performance: { now: () => now },
    });
    return {
      api: windowPort.p05SyntheticFixture!,
      setTime: (value: number) => {
        now = value;
      },
      emit: (selector: string, name: string) =>
        handlers.get(`${selector}/${name}`)!({ preventDefault() {} }),
    };
  }

  it("records handler-only evidence through injected ports without exporting typed text", () => {
    const ports = fixturePorts();
    ports.api.begin("synthetic-document", 2, 100);
    ports.emit("#synthetic-input", "input");
    ports.emit("#synthetic-click", "click");
    const result = ports.api.finish();
    expect(result).toMatchObject({ status: "complete", attempted: 2, accepted: 2 });
    expect(JSON.stringify(result)).not.toContain("synthetic-input-not-exported");
    expect(result.samples).toHaveLength(2);
    ports.emit("#synthetic-click", "click");
    expect(result).toMatchObject({ status: "INC", attempted: 3, late: 1 });
  });

  it.each(["capacity", "deadline"])("marks fixture %s losses incomplete", (kind) => {
    const ports = fixturePorts();
    ports.api.begin("synthetic-document", 1, 100);
    ports.emit("#synthetic-click", "click");
    if (kind === "deadline") ports.setTime(101);
    ports.emit("#synthetic-click", "click");
    expect(ports.api.finish()).toMatchObject({
      status: "INC",
      attempted: 2,
      accepted: 1,
      dropped: 1,
    });
  });

  it("is deterministic, bounded and contains no external collection mechanism", () => {
    const fixture = createSyntheticFixture();
    expect(fixture).toEqual(createSyntheticFixture());
    expect(fixture.byteLength).toBe(48_000);
    expect(Buffer.byteLength(fixture.html)).toBe(fixture.byteLength);
    expect(fixture.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.html).toContain('maxlength="128"');
    expect(fixture.html).toContain('dataset.ready = "true"');
    expect(fixture.html).toContain("event.preventDefault()");
    expect(fixture.html).not.toMatch(
      /fetch\(|XMLHttpRequest|WebSocket|sendBeacon|document\.cookie|localStorage|https?:\/\//,
    );
    expect(fixture.html).toContain('boundary: "javascript-handler"');
    expect(fixture.html).not.toContain("input-to-display");
  });
});
