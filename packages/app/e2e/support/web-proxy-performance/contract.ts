import { createHash } from "node:crypto";
import { z } from "zod";

const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(100_000);
const finite = z.number().finite().nonnegative();

export const METRICS = {
  event_handler_ms: { unit: "ms", boundary: "javascript-handler", method: "performance-now" },
  display_latency_ms: { unit: "ms", boundary: "input-to-display", method: "visual-observation" },
  raf_gap_ms: { unit: "ms", boundary: "fixture-raf", method: "raf-callback" },
  long_task_ms: { unit: "ms", boundary: "fixture-longtask", method: "performance-observer" },
  data_ready_ms: { unit: "ms", boundary: "navigation-to-dom-marker", method: "performance-now" },
  content_load_ms: {
    unit: "ms",
    boundary: "opening-to-displayed-content",
    method: "visual-observation",
  },
  flow_bytes: { unit: "bytes", boundary: "flow-counter", method: "byte-counter" },
  cpu_percent: { unit: "percent", boundary: "process-window", method: "process-sampler" },
  phone_pss_bytes: { unit: "bytes", boundary: "phone-process-pss", method: "pss-sampler" },
  host_rss_bytes: { unit: "bytes", boundary: "host-process-rss", method: "rss-sampler" },
} as const;

const metricSchema = z.enum([
  "event_handler_ms",
  "display_latency_ms",
  "raf_gap_ms",
  "long_task_ms",
  "data_ready_ms",
  "content_load_ms",
  "flow_bytes",
  "cpu_percent",
  "phone_pss_bytes",
  "host_rss_bytes",
]);
export type Metric = z.infer<typeof metricSchema>;
const pathSchema = z.enum(["D", "J", "P"]);
const phaseSchema = z.enum(["cold", "warm"]);
const clockSchema = z.strictObject({
  id: identifier.max(43),
  scope: z.literal("cycle"),
  kind: z.enum(["document-monotonic", "process-monotonic", "video-timeline"]),
  resolutionMs: z.number().finite().positive(),
});
const sourceSchema = z.strictObject({
  id: identifier,
  side: z.enum(["phone", "host"]),
  producerSha256: hash,
  artifactSha256: hash,
  method: z.enum([
    "performance-now",
    "visual-observation",
    "raf-callback",
    "performance-observer",
    "byte-counter",
    "process-sampler",
    "pss-sampler",
    "rss-sampler",
  ]),
  flow: z
    .strictObject({
      id: identifier,
      direction: z.enum(["inbound", "outbound"]),
      layer: z.enum(["useful-payload", "protocol-frame", "asset", "network-encrypted"]),
    })
    .nullable(),
});
const bindingSchema = z.strictObject({
  runId: identifier,
  source: sourceSchema,
  clock: clockSchema,
});
const seriesSchema = z.strictObject({
  id: identifier,
  metric: metricSchema,
  action: z.enum(["typing", "click", "scroll", "load", "memory", "cpu", "traffic", "observer"]),
  phase: phaseSchema,
  cycles: z.array(z.number().int().min(0).max(20)).min(1).max(20),
  expectedPerCycle: count.nullable(),
  bindings: z.array(bindingSchema).length(18),
});
const inputSchema = z.strictObject({
  version: z.literal(1),
  cellId: identifier,
  origin: z.enum(["synthetic", "imported"]),
  stage: z.enum(["calibration", "acceptance"]),
  productCommit: z.string().regex(/^[a-f0-9]{40}$/),
  fixtureSha256: hash,
  scriptSha256: hash,
  analyzerSha256: hash,
  environmentSha256: hash,
  adjudicationSha256: hash.nullable(),
  warmComparison: z
    .strictObject({
      rttMs: finite,
      rttUncertaintyMs: finite,
      marginMs: finite,
      rttEvidenceSha256: hash,
    })
    .nullable(),
  limits: z.strictObject({
    maxRecords: count.min(1),
    durationMs: z.number().int().positive().max(2_147_483_647),
  }),
  series: z.array(seriesSchema).min(1).max(32),
});
export type ManifestInput = z.infer<typeof inputSchema>;
export type SeriesPlan = z.infer<typeof seriesSchema>;

export function finiteSchedule() {
  const paths = ["D", "J", "P"] as const;
  const warmups = paths.map((path) => ({
    id: `warmup-${path.toLowerCase()}`,
    path,
    warmup: true,
    block: 0,
  }));
  const measured = Array.from({ length: 5 }, (_, index) => {
    const order = index % 2 === 0 ? paths : paths.toReversed();
    return order.map((path) => ({
      id: `run-${index + 1}-${path.toLowerCase()}`,
      path,
      warmup: false,
      block: index + 1,
    }));
  }).flat();
  return [...warmups, ...measured];
}

const slotSchema = z.strictObject({
  id: identifier,
  path: pathSchema,
  warmup: z.boolean(),
  block: z.number().int().min(0).max(5),
});
const manifestSchema = inputSchema.extend({
  schedule: z.array(slotSchema).length(18),
  sha256: hash,
});
export type EvidenceManifest = z.infer<typeof manifestSchema>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => Number(left > right) - Number(left < right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function evidenceHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function requireCondition(condition: boolean): void {
  if (!condition) throw new Error("Invalid performance evidence contract");
}

function validateSeries(series: SeriesPlan, schedule: ReturnType<typeof finiteSchedule>): void {
  const memory = ["phone_pss_bytes", "host_rss_bytes"].includes(series.metric);
  let requiredCycles = Array.from({ length: 20 }, (_, index) => index + 1);
  if (memory) requiredCycles = [5, ...requiredCycles.slice(9)];
  if (series.phase === "cold") requiredCycles = [0];
  requireCondition(evidenceHash(series.cycles) === evidenceHash(requiredCycles));
  const unitary = ["event_handler_ms", "display_latency_ms", "data_ready_ms", "content_load_ms"];
  if (memory || series.phase === "cold" || unitary.includes(series.metric)) {
    requireCondition(series.expectedPerCycle === 1);
  }
  if (memory) requireCondition(series.phase === "warm" && series.action === "memory");
  requireCondition(new Set(series.bindings.map((binding) => binding.runId)).size === 18);
  for (const binding of series.bindings) {
    requireCondition(schedule.some((slot) => slot.id === binding.runId));
    requireCondition(binding.source.method === METRICS[series.metric].method);
    requireCondition((series.metric === "flow_bytes") === (binding.source.flow !== null));
    if (series.metric === "phone_pss_bytes") requireCondition(binding.source.side === "phone");
    if (series.metric === "host_rss_bytes") requireCondition(binding.source.side === "host");
    if (series.metric === "display_latency_ms" || series.metric === "content_load_ms") {
      requireCondition(binding.source.side === "phone" && binding.clock.kind === "video-timeline");
    }
  }
}

export function createFiniteManifest(input: unknown): EvidenceManifest {
  const parsed = inputSchema.safeParse(input);
  requireCondition(parsed.success);
  if (!parsed.success) throw new Error("Invalid performance manifest");
  const schedule = finiteSchedule();
  const config = parsed.data;
  requireCondition(config.stage !== "acceptance" || config.adjudicationSha256 !== null);
  requireCondition(config.warmComparison === null || config.adjudicationSha256 !== null);
  requireCondition(new Set(config.series.map((series) => series.id)).size === config.series.length);
  config.series.forEach((series) => validateSeries(series, schedule));
  const body = { ...config, schedule };
  return { ...body, sha256: evidenceHash(body) };
}

export function parseManifest(input: unknown): EvidenceManifest {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid performance manifest");
  const { schedule, sha256, ...config } = parsed.data;
  const expected = createFiniteManifest(config);
  requireCondition(
    evidenceHash(schedule) === evidenceHash(expected.schedule) && sha256 === expected.sha256,
  );
  return expected;
}

const markerSchema = z.strictObject({ clockId: identifier, timeMs: finite });
export const sampleSchema = z.strictObject({
  version: z.literal(1),
  manifestSha256: hash,
  runId: identifier,
  path: pathSchema,
  seriesId: identifier,
  phase: phaseSchema,
  cycle: z.number().int().min(0).max(20),
  sequence: count.min(1),
  metric: metricSchema,
  unit: z.enum(["ms", "bytes", "percent"]),
  boundary: z.enum([
    "javascript-handler",
    "input-to-display",
    "fixture-raf",
    "fixture-longtask",
    "navigation-to-dom-marker",
    "opening-to-displayed-content",
    "flow-counter",
    "process-window",
    "phone-process-pss",
    "host-process-rss",
  ]),
  status: z.enum(["ok", "failed", "unsupported"]),
  value: finite.nullable(),
  start: markerSchema,
  end: markerSchema,
  uncertaintyMs: finite,
  source: sourceSchema,
});
export type EvidenceSample = z.infer<typeof sampleSchema>;

export function parseEvidence(manifest: EvidenceManifest, input: unknown): EvidenceSample {
  const parsed = sampleSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid performance sample");
  const sample = parsed.data;
  const slot = manifest.schedule.find((candidate) => candidate.id === sample.runId);
  const series = manifest.series.find((candidate) => candidate.id === sample.seriesId);
  const binding = series?.bindings.find((candidate) => candidate.runId === sample.runId);
  requireCondition(sample.manifestSha256 === manifest.sha256 && slot?.path === sample.path);
  if (!series || !binding) throw new Error("Unknown performance series");
  const definition = METRICS[series.metric];
  requireCondition(
    sample.metric === series.metric &&
      sample.phase === series.phase &&
      series.cycles.includes(sample.cycle),
  );
  requireCondition(sample.unit === definition.unit && sample.boundary === definition.boundary);
  requireCondition(evidenceHash(sample.source) === evidenceHash(binding.source));
  requireCondition(
    sample.start.clockId === `${binding.clock.id}-c${sample.cycle}` &&
      sample.end.clockId === sample.start.clockId,
  );
  requireCondition(sample.end.timeMs >= sample.start.timeMs);
  requireCondition(sample.status === "ok" ? sample.value !== null : sample.value === null);
  if (sample.unit === "bytes" && sample.value !== null)
    requireCondition(Number.isSafeInteger(sample.value));
  if (sample.unit === "ms" && sample.value !== null)
    requireCondition(sample.value === sample.end.timeMs - sample.start.timeMs);
  return sample;
}

export const coverageSchema = z.strictObject({
  runId: identifier,
  seriesId: identifier,
  cycle: z.number().int().min(0).max(20),
  produced: count,
  dropped: count,
  supported: z.boolean(),
  complete: z.boolean(),
});
export type EvidenceCoverage = z.infer<typeof coverageSchema>;
export const bundleSchema = z.strictObject({
  version: z.literal(1),
  captureId: z.uuid(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  closure: z.enum(["open", "finished", "invalidated"]),
  manifestSha256: hash,
  samples: z.array(sampleSchema).max(100_000),
  coverage: z.array(coverageSchema).max(11_520),
  attempted: count,
  accepted: count,
  rejected: count,
  dropped: count,
  finished: z.boolean(),
  reasons: z
    .array(
      z.enum([
        "invalid_sample",
        "overflow",
        "deadline",
        "clock_regression",
        "late_record",
        "invalid_coverage",
      ]),
    )
    .max(6),
});
export type EvidenceBundle = z.infer<typeof bundleSchema>;

export interface EvidenceRevision {
  revision: number;
  closure: EvidenceBundle["closure"];
  bundleSha256: string;
}

export function evidenceRevision(bundle: EvidenceBundle): EvidenceRevision {
  return {
    revision: bundle.revision,
    closure: bundle.closure,
    bundleSha256: evidenceHash(bundle),
  };
}

export function sampleKey(sample: Pick<EvidenceSample, "runId" | "seriesId" | "cycle">): string {
  return `${sample.runId}/${sample.seriesId}/${sample.cycle}`;
}
