import {
  bundleSchema,
  evidenceHash,
  parseEvidence,
  parseManifest,
  sampleKey,
  type EvidenceBundle,
  type EvidenceManifest,
  type EvidenceSample,
  type EvidenceCoverage,
  type SeriesPlan,
} from "./contract";

export interface Distribution {
  count: number;
  p50: number;
  p95: number;
  maximum: number;
}

export interface SeriesSummary {
  manifestSha256: string;
  runId: string;
  path: "D" | "J" | "P";
  seriesId: string;
  phase: "cold" | "warm";
  status: "complete" | "INC";
  expected: number | null;
  observed: number;
  failed: number;
  distribution: Distribution | null;
  singleObservation: number | null;
  reasons: string[];
}

function distribution(values: readonly number[]): Distribution | null {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0))
    return null;
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    maximum: sorted[sorted.length - 1]!,
  };
}

function validateBundle(manifest: EvidenceManifest, input: unknown): EvidenceBundle {
  const parsed = bundleSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid performance bundle");
  const bundle = parsed.data;
  if (
    bundle.manifestSha256 !== manifest.sha256 ||
    bundle.accepted !== bundle.samples.length ||
    bundle.attempted !== bundle.accepted + bundle.rejected + bundle.dropped ||
    bundle.accepted > manifest.limits.maxRecords ||
    (bundle.attempted > manifest.limits.maxRecords &&
      !bundle.reasons.includes("overflow") &&
      !bundle.reasons.includes("late_record"))
  )
    throw new Error("Performance bundle count mismatch");
  const keys = new Set<string>();
  for (const inputSample of bundle.samples) {
    const sample = parseEvidence(manifest, inputSample);
    const key = `${sampleKey(sample)}/${sample.sequence}`;
    if (keys.has(key)) throw new Error("Duplicate performance sample");
    keys.add(key);
  }
  const coverageKeys = new Set<string>();
  for (const coverage of bundle.coverage) {
    const series = manifest.series.find((candidate) => candidate.id === coverage.seriesId);
    const key = sampleKey(coverage);
    if (
      coverageKeys.has(key) ||
      !series?.cycles.includes(coverage.cycle) ||
      !manifest.schedule.some((slot) => slot.id === coverage.runId)
    ) {
      throw new Error("Invalid performance coverage");
    }
    coverageKeys.add(key);
  }
  return bundle;
}

function validateCycle(
  group: EvidenceSample[],
  coverage: EvidenceCoverage | undefined,
  fixedCount: number | null,
  reasons: Set<string>,
): number | null {
  const planned = fixedCount ?? coverage?.produced ?? null;
  if (!coverage?.supported || !coverage.complete || coverage.dropped !== 0)
    reasons.add("coverage_incomplete");
  if (planned === null || group.length !== planned || coverage?.produced !== group.length)
    reasons.add("count_mismatch");
  const sequence = group.map((sample) => sample.sequence).sort((left, right) => left - right);
  if (sequence.some((value, index) => value !== index + 1)) reasons.add("sequence_gap");
  return planned;
}

function summarizeRun(
  manifest: EvidenceManifest,
  bundle: EvidenceBundle,
  series: SeriesPlan,
  slot: EvidenceManifest["schedule"][number],
): SeriesSummary {
  const samples = bundle.samples.filter(
    (sample) => sample.runId === slot.id && sample.seriesId === series.id,
  );
  const reasons = new Set<string>(bundle.reasons);
  if (!bundle.finished || bundle.rejected > 0 || bundle.dropped > 0)
    reasons.add("capture_incomplete");
  let expected: number | null = 0;
  for (const cycle of series.cycles) {
    const group = samples.filter((sample) => sample.cycle === cycle);
    const coverage = bundle.coverage.find(
      (entry) => entry.runId === slot.id && entry.seriesId === series.id && entry.cycle === cycle,
    );
    const planned = validateCycle(group, coverage, series.expectedPerCycle, reasons);
    expected = expected === null || planned === null ? null : expected + planned;
  }
  const failed = samples.filter((sample) => sample.status !== "ok").length;
  if (failed > 0) reasons.add("failed_observations");
  const values = samples.flatMap((sample) =>
    sample.status === "ok" && sample.value !== null ? [sample.value] : [],
  );
  if (values.length === 0) reasons.add("no_observations");
  const status = reasons.size === 0 ? "complete" : "INC";
  const singleCold = series.phase === "cold" && values.length === 1;
  return {
    manifestSha256: manifest.sha256,
    runId: slot.id,
    path: slot.path,
    seriesId: series.id,
    phase: series.phase,
    status,
    expected,
    observed: samples.length,
    failed,
    distribution: status === "complete" && !singleCold ? distribution(values) : null,
    singleObservation: status === "complete" && singleCold ? values[0]! : null,
    reasons: [...reasons],
  };
}

export function summarizeSeries(manifestInput: unknown, bundleInput: unknown, seriesId: string) {
  try {
    const manifest = parseManifest(manifestInput);
    const bundle = validateBundle(manifest, bundleInput);
    const series = manifest.series.find((candidate) => candidate.id === seriesId);
    if (!series) throw new Error("Unknown performance series");
    const runs = manifest.schedule
      .filter((slot) => !slot.warmup)
      .map((slot) => summarizeRun(manifest, bundle, series, slot));
    const warmups = manifest.schedule
      .filter((slot) => slot.warmup)
      .map((slot) => summarizeRun(manifest, bundle, series, slot));
    return {
      status: [...runs, ...warmups].every((run) => run.status === "complete")
        ? ("complete" as const)
        : ("INC" as const),
      productVerdict: "not_evaluated" as const,
      manifestSha256: manifest.sha256,
      plannedRuns: 15,
      plannedWarmups: 3,
      observedWarmups: new Set(
        bundle.samples
          .filter((sample) =>
            manifest.schedule.some((slot) => slot.warmup && slot.id === sample.runId),
          )
          .map((sample) => sample.runId),
      ).size,
      runs,
      warmups,
      reasons: [] as string[],
    };
  } catch {
    return {
      status: "INC" as const,
      productVerdict: "not_evaluated" as const,
      manifestSha256: null,
      plannedRuns: 15,
      plannedWarmups: 3,
      observedWarmups: 0,
      runs: [] as SeriesSummary[],
      warmups: [] as SeriesSummary[],
      reasons: ["invalid_contract_or_bundle"],
    };
  }
}

export function analyzeMemoryPlateau(
  manifestInput: unknown,
  bundleInput: unknown,
  seriesId: string,
  runId: string,
) {
  const incomplete = {
    status: "INC" as const,
    productVerdict: "not_evaluated" as const,
    slopeBytesPerCycle: null,
    finalToBaseline: null,
  };
  try {
    const manifest = parseManifest(manifestInput);
    const bundle = validateBundle(manifest, bundleInput);
    const series = manifest.series.find((candidate) => candidate.id === seriesId);
    const slot = manifest.schedule.find((candidate) => candidate.id === runId && !candidate.warmup);
    if (
      !series ||
      !slot ||
      !["phone_pss_bytes", "host_rss_bytes"].includes(series.metric) ||
      series.phase !== "warm" ||
      series.expectedPerCycle !== 1
    )
      return incomplete;
    const cycles = [5, ...Array.from({ length: 11 }, (_, index) => index + 10)];
    if (
      evidenceHash([...series.cycles].sort((left, right) => left - right)) !== evidenceHash(cycles)
    )
      return incomplete;
    if (summarizeRun(manifest, bundle, series, slot).status !== "complete") return incomplete;
    const samples = bundle.samples.filter(
      (sample) => sample.runId === runId && sample.seriesId === seriesId,
    );
    const baseline = samples.find((sample) => sample.cycle === 5)?.value;
    const finalValue = samples.find((sample) => sample.cycle === 20)?.value;
    if (!baseline || finalValue === null || finalValue === undefined) return incomplete;
    const points = samples.filter((sample) => sample.cycle >= 10);
    const average = points.reduce((total, sample) => total + sample.value!, 0) / 11;
    const numerator = points.reduce(
      (total, sample) => total + (sample.cycle - 15) * (sample.value! - average),
      0,
    );
    const slope = numerator / 110;
    const ratio = finalValue / baseline;
    if (!Number.isFinite(slope) || !Number.isFinite(ratio)) return incomplete;
    return {
      status: "complete" as const,
      productVerdict: "not_evaluated" as const,
      slopeBytesPerCycle: slope,
      finalToBaseline: ratio,
    };
  } catch {
    return incomplete;
  }
}

export function compareWarmLoads(manifestInput: unknown, bundleInput: unknown, seriesId: string) {
  const incomplete = {
    status: "INC" as const,
    productVerdict: "not_evaluated" as const,
    comparison: null,
  };
  try {
    const manifest = parseManifest(manifestInput);
    const series = manifest.series.find((candidate) => candidate.id === seriesId);
    const adjudication = manifest.warmComparison;
    if (series?.metric !== "content_load_ms" || series.phase !== "warm" || adjudication === null)
      return incomplete;
    const summary = summarizeSeries(manifest, bundleInput, seriesId);
    if (summary.status !== "complete") return incomplete;
    const median = (path: "D" | "J" | "P") =>
      distribution(
        summary.runs.filter((run) => run.path === path).map((run) => run.distribution!.p95),
      )!.p50;
    const directMs = median("D");
    const jpegMs = median("J");
    const domMs = median("P");
    const directRttMarginMs = directMs + adjudication.rttMs + adjudication.marginMs;
    if (!Number.isFinite(directRttMarginMs)) return incomplete;
    const bundle = validateBundle(manifest, bundleInput);
    const uncertainty = (path: "D" | "J" | "P") =>
      Math.max(
        ...bundle.samples
          .filter(
            (sample) =>
              sample.path === path &&
              sample.seriesId === seriesId &&
              !sample.runId.startsWith("warmup-"),
          )
          .map(
            (sample) =>
              sample.uncertaintyMs +
              series.bindings.find((binding) => binding.runId === sample.runId)!.clock.resolutionMs,
          ),
      );
    const jpegComparisonUncertaintyMs = uncertainty("P") + uncertainty("J");
    const directComparisonUncertaintyMs =
      uncertainty("P") + uncertainty("D") + adjudication.rttUncertaintyMs;
    const distinguishable =
      Math.abs(domMs - jpegMs) > jpegComparisonUncertaintyMs &&
      Math.abs(domMs - directRttMarginMs) > directComparisonUncertaintyMs;
    return {
      status: distinguishable ? ("complete" as const) : ("INC" as const),
      productVerdict: "not_evaluated" as const,
      comparison: {
        directMs,
        jpegMs,
        domMs,
        domMinusJpegMs: domMs - jpegMs,
        directRttMarginMs,
        domMinusDirectRttMarginMs: domMs - directRttMarginMs,
        runsPerPath: 5,
        adjudicationSha256: manifest.adjudicationSha256,
        rttEvidenceSha256: adjudication.rttEvidenceSha256,
        jpegComparisonUncertaintyMs,
        directComparisonUncertaintyMs,
      },
    };
  } catch {
    return incomplete;
  }
}
