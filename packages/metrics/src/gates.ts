import type { CohortMetrics, CohortStats } from "./aggregate.js";

/**
 * Release gates: rules a rollout's cohort metrics must meet before it may
 * widen to the next stage.
 *
 * Every rule compares the treatment cohort (served `true`) with a fixed limit
 * or with the control cohort. Before any limit is judged, both cohorts need a
 * minimum sample; with less data than that the verdict is
 * `insufficient_data`, which blocks expansion just like a failure does, so a
 * quiet canary can never be promoted by default.
 */

export const GATE_RULES = [
  "min_subjects",
  "min_requests",
  "max_error_rate",
  "max_error_rate_increase",
  "max_p95_latency",
  "max_p95_latency_increase",
] as const;
export type GateRule = (typeof GATE_RULES)[number];

export const GATE_VERDICTS = ["pass", "fail", "insufficient_data"] as const;
export type GateVerdict = (typeof GATE_VERDICTS)[number];

export interface GatePolicy {
  /** Distinct subjects each cohort needs before limits are judged. */
  minSubjectsPerCohort: number;
  /** Requests each cohort needs before limits are judged. */
  minRequestsPerCohort: number;
  /** Highest treatment error rate allowed, 0–1; `null` turns the rule off. */
  maxErrorRate: number | null;
  /** Highest treatment − control error rate allowed, 0–1; `null` = off. */
  maxErrorRateIncrease: number | null;
  /** Highest treatment p95 latency allowed, in ms; `null` = off. */
  maxP95LatencyMs: number | null;
  /** Highest treatment − control p95 latency allowed, in ms; `null` = off. */
  maxP95LatencyIncreaseMs: number | null;
}

/** Used until someone saves a policy for the flag and environment. */
export const DEFAULT_GATE_POLICY: Readonly<GatePolicy> = Object.freeze({
  minSubjectsPerCohort: 100,
  minRequestsPerCohort: 200,
  maxErrorRate: 0.02,
  maxErrorRateIncrease: 0.01,
  maxP95LatencyMs: null,
  maxP95LatencyIncreaseMs: 100,
});

export const MAX_MIN_SAMPLE = 1_000_000;
export const MAX_LATENCY_LIMIT_MS = 600_000;

export interface GateCheck {
  rule: GateRule;
  verdict: GateVerdict;
  /** The measured value the limit was compared with, when there is one. */
  observed: number | null;
  /** The limit from the policy. */
  threshold: number;
  /** One sentence a person can act on. */
  message: string;
}

export interface GateEvaluation {
  /** `fail` if any check fails, else `insufficient_data` if any lacks data, else `pass`. */
  verdict: GateVerdict;
  checks: GateCheck[];
  /** The checks that failed, in rule order; empty unless the verdict is `fail`. */
  breached: GateRule[];
  /** Which metrics were judged: the report's `sourceDigest`, or `null` without one. */
  sourceDigest: string | null;
  eventCount: number;
}

/**
 * Error rates are ratios of whole numbers, so tiny float noise must not turn
 * "exactly at the limit" into a breach. Limits are inclusive.
 */
const EPSILON = 1e-9;

function exceeds(observed: number, limit: number): boolean {
  return observed - limit > EPSILON;
}

function percent(value: number): string {
  return `${Number((value * 100).toFixed(2))} %`;
}

function pp(value: number): string {
  return `${Number((value * 100).toFixed(2))} pp`;
}

/**
 * Judges `metrics` against `policy`. Pure and deterministic: the same report
 * and policy always give the same evaluation. `metrics` may be `null` when
 * nothing has been computed yet.
 */
export function evaluateGates(metrics: CohortMetrics | null, policy: GatePolicy): GateEvaluation {
  const treatment = metrics?.totals.treatment ?? null;
  const control = metrics?.totals.control ?? null;
  const checks: GateCheck[] = [
    sampleCheck("min_subjects", "subjects", policy.minSubjectsPerCohort, treatment, control),
    sampleCheck("min_requests", "requests", policy.minRequestsPerCohort, treatment, control),
  ];
  const enoughData = checks.every((c) => c.verdict === "pass");

  if (policy.maxErrorRate !== null) {
    const limit = policy.maxErrorRate;
    const observed = treatment?.errorRate ?? null;
    checks.push(
      judge("max_error_rate", observed, limit, enoughData, (v) =>
        exceeds(v, limit)
          ? `Treatment error rate ${percent(v)} is above the ${percent(limit)} limit`
          : `Treatment error rate ${percent(v)} is within the ${percent(limit)} limit`,
      ),
    );
  }

  if (policy.maxErrorRateIncrease !== null) {
    const limit = policy.maxErrorRateIncrease;
    const t = treatment?.errorRate ?? null;
    const c = control?.errorRate ?? null;
    const observed = t !== null && c !== null ? t - c : null;
    checks.push(
      judge("max_error_rate_increase", observed, limit, enoughData, (v) =>
        exceeds(v, limit)
          ? `Treatment errors exceed control by ${pp(v)}, more than the ${pp(limit)} allowed`
          : `Treatment errors differ from control by ${pp(v)}, within the ${pp(limit)} allowed`,
      ),
    );
  }

  if (policy.maxP95LatencyMs !== null) {
    const limit = policy.maxP95LatencyMs;
    const observed = treatment?.latency?.p95Ms ?? null;
    checks.push(
      judge("max_p95_latency", observed, limit, enoughData, (v) =>
        exceeds(v, limit)
          ? `Treatment p95 latency ${v} ms is above the ${limit} ms limit`
          : `Treatment p95 latency ${v} ms is within the ${limit} ms limit`,
      ),
    );
  }

  if (policy.maxP95LatencyIncreaseMs !== null) {
    const limit = policy.maxP95LatencyIncreaseMs;
    const t = treatment?.latency?.p95Ms;
    const c = control?.latency?.p95Ms;
    const observed = t !== undefined && c !== undefined ? t - c : null;
    checks.push(
      judge("max_p95_latency_increase", observed, limit, enoughData, (v) =>
        exceeds(v, limit)
          ? `Treatment p95 latency is ${v} ms slower than control, more than the ${limit} ms allowed`
          : `Treatment p95 latency is ${v} ms off control, within the ${limit} ms allowed`,
      ),
    );
  }

  const breached = checks.filter((c) => c.verdict === "fail").map((c) => c.rule);
  const verdict: GateVerdict =
    breached.length > 0
      ? "fail"
      : checks.some((c) => c.verdict === "insufficient_data")
        ? "insufficient_data"
        : "pass";

  return {
    verdict,
    checks,
    breached,
    sourceDigest: metrics?.sourceDigest ?? null,
    eventCount: metrics?.eventCount ?? 0,
  };
}

/**
 * A one-line explanation of why an evaluation blocks expansion, naming the
 * breached rules first; `null` when it passes.
 */
export function describeBlock(evaluation: GateEvaluation): string | null {
  if (evaluation.verdict === "pass") return null;
  const wanted: GateVerdict = evaluation.verdict;
  const reasons = evaluation.checks.filter((c) => c.verdict === wanted).map((c) => c.message);
  const lead =
    wanted === "fail" ? "Release gate breached" : "Not enough telemetry to judge the release gates";
  return `${lead}: ${reasons.join("; ")}`;
}

function sampleCheck(
  rule: "min_subjects" | "min_requests",
  field: "subjects" | "requests",
  minimum: number,
  treatment: CohortStats | null,
  control: CohortStats | null,
): GateCheck {
  const t = treatment?.[field] ?? 0;
  const c = control?.[field] ?? 0;
  // The smaller cohort decides whether there is enough data.
  const observed = Math.min(t, c);
  const enough = observed >= minimum;
  return {
    rule,
    verdict: enough ? "pass" : "insufficient_data",
    observed,
    threshold: minimum,
    message: enough
      ? `Both cohorts have at least ${minimum} ${field} (treatment ${t}, control ${c})`
      : `Each cohort needs ${minimum} ${field}; treatment has ${t}, control ${c}`,
  };
}

function judge(
  rule: GateRule,
  observed: number | null,
  threshold: number,
  enoughData: boolean,
  describe: (observed: number) => string,
): GateCheck {
  if (observed === null) {
    return {
      rule,
      verdict: "insufficient_data",
      observed,
      threshold,
      message: `No ${rule.includes("latency") ? "latency" : "request"} data to check ${rule}`,
    };
  }
  if (!enoughData) {
    return {
      rule,
      verdict: "insufficient_data",
      observed,
      threshold,
      message: `${describe(observed)}, but the sample is too small to judge yet`,
    };
  }
  return {
    rule,
    verdict: exceeds(observed, threshold) ? "fail" : "pass",
    observed,
    threshold,
    message: describe(observed),
  };
}

/**
 * Problems with a policy received over the wire; empty when it is valid.
 * Every field must be present so a saved policy never depends on defaults
 * that might change later.
 */
export function gatePolicyProblems(input: unknown): string[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return ["policy must be an object"];
  }
  const policy = input as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set<string>(Object.keys(DEFAULT_GATE_POLICY));
  for (const key of Object.keys(policy)) {
    if (!known.has(key)) problems.push(`unknown field ${key}`);
  }

  const wholeNumber = (key: keyof GatePolicy, min: number, max: number) => {
    const value = policy[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      problems.push(`${key} must be a whole number from ${min} to ${max}`);
    }
  };
  const optional = (key: keyof GatePolicy, min: number, max: number, unit: string) => {
    const value = policy[key];
    if (value === null) return;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      problems.push(`${key} must be null or a number from ${min} to ${max}${unit}`);
    }
  };

  wholeNumber("minSubjectsPerCohort", 1, MAX_MIN_SAMPLE);
  wholeNumber("minRequestsPerCohort", 1, MAX_MIN_SAMPLE);
  optional("maxErrorRate", 0, 1, "");
  optional("maxErrorRateIncrease", 0, 1, "");
  optional("maxP95LatencyMs", 0, MAX_LATENCY_LIMIT_MS, " ms");
  optional("maxP95LatencyIncreaseMs", 0, MAX_LATENCY_LIMIT_MS, " ms");

  if (
    problems.length === 0 &&
    policy.maxErrorRate === null &&
    policy.maxErrorRateIncrease === null &&
    policy.maxP95LatencyMs === null &&
    policy.maxP95LatencyIncreaseMs === null
  ) {
    problems.push("at least one limit must be set");
  }
  return problems;
}
