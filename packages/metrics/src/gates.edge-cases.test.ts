import { describe, expect, it } from "vitest";
import type { CohortMetrics, CohortStats } from "./aggregate.js";
import {
  DEFAULT_GATE_POLICY,
  MAX_LATENCY_LIMIT_MS,
  MAX_MIN_SAMPLE,
  describeBlock,
  evaluateGates,
  gatePolicyProblems,
  type GateCheck,
  type GatePolicy,
  type GateRule,
} from "./gates.js";

/**
 * Boundary behaviour of the release gates: limits are inclusive, float noise
 * never flips a verdict, the smaller cohort decides the sample, and a missing
 * measurement can block but never pass.
 */

function cohort(
  requests: number,
  subjects: number,
  errors: number,
  p95Ms: number | null = 200,
): CohortStats {
  return {
    requests,
    subjects,
    errors,
    errorRate: requests === 0 ? null : errors / requests,
    latency:
      requests === 0 || p95Ms === null
        ? null
        : { samples: requests, p50Ms: 100, p95Ms, maxMs: p95Ms + 50 },
  };
}

function report(treatment: CohortStats, control: CohortStats): CohortMetrics {
  return {
    schemaVersion: 1,
    windowMinutes: 15,
    eventCount: treatment.requests + control.requests,
    firstEventAt: "2026-01-12T09:00:00.000Z",
    lastEventAt: "2026-01-12T09:59:00.000Z",
    sourceDigest: "b".repeat(64),
    totals: { treatment, control },
    windows: [],
  };
}

const base: GatePolicy = { ...DEFAULT_GATE_POLICY };

/** A policy with only the sample minimums and the one limit under test. */
function only(rule: Partial<GatePolicy>, sample = { subjects: 100, requests: 200 }): GatePolicy {
  return {
    minSubjectsPerCohort: sample.subjects,
    minRequestsPerCohort: sample.requests,
    maxErrorRate: null,
    maxErrorRateIncrease: null,
    maxP95LatencyMs: null,
    maxP95LatencyIncreaseMs: null,
    ...rule,
  };
}

function check(result: ReturnType<typeof evaluateGates>, rule: GateRule): GateCheck {
  const found = result.checks.find((c) => c.rule === rule);
  if (!found) throw new Error(`no ${rule} check`);
  return found;
}

describe("absolute error-rate limit", () => {
  const policy = only({ maxErrorRate: 0.02 });
  const control = cohort(1000, 500, 0);

  it.each([
    ["one error below the limit", 3, "pass"],
    ["exactly at the limit", 4, "pass"],
    ["one error above the limit", 5, "fail"],
  ] as const)("%s (%i errors in 200 requests)", (_label, errors, verdict) => {
    const result = evaluateGates(report(cohort(200, 100, errors), control), policy);
    expect(check(result, "max_error_rate")).toMatchObject({ verdict, observed: errors / 200 });
    expect(result.verdict).toBe(verdict);
  });

  it("treats a limit within float tolerance of the observed rate as met", () => {
    // A limit a hair below the observed 30 % (e.g. from rounding) is still met.
    const result = evaluateGates(
      report(cohort(200, 100, 60), control),
      only({ maxErrorRate: 0.3 - 1e-12 }),
    );
    expect(check(result, "max_error_rate").verdict).toBe("pass");
    const clear = evaluateGates(
      report(cohort(200, 100, 60), control),
      only({ maxErrorRate: 0.3 - 1e-6 }),
    );
    expect(check(clear, "max_error_rate").verdict).toBe("fail");
  });

  it("with a zero limit, allows no errors at all", () => {
    const zero = only({ maxErrorRate: 0 });
    expect(evaluateGates(report(cohort(200, 100, 0), control), zero).verdict).toBe("pass");
    expect(evaluateGates(report(cohort(200, 100, 1), control), zero).verdict).toBe("fail");
  });

  it("with a limit of 1, passes even when every request fails", () => {
    const result = evaluateGates(report(cohort(200, 100, 200), control), only({ maxErrorRate: 1 }));
    expect(result.verdict).toBe("pass");
  });
});

describe("error-rate increase over control", () => {
  const policy = only({ maxErrorRateIncrease: 0.01 });

  it("passes exactly at the limit even when the subtraction lands just above it", () => {
    // 0.07 - 0.06 = 0.010000000000000009
    expect(0.07 - 0.06).toBeGreaterThan(0.01);
    const result = evaluateGates(report(cohort(200, 100, 14), cohort(200, 100, 12)), policy);
    expect(check(result, "max_error_rate_increase")).toMatchObject({ verdict: "pass" });
    expect(check(result, "max_error_rate_increase").observed).toBeCloseTo(0.01, 12);
  });

  it("fails one error past the limit", () => {
    const result = evaluateGates(report(cohort(200, 100, 15), cohort(200, 100, 12)), policy);
    expect(result.breached).toEqual(["max_error_rate_increase"]);
    expect(describeBlock(result)).toBe(
      "Release gate breached: Treatment errors exceed control by 1.5 pp, more than the 1 pp allowed",
    );
  });

  it("passes when the treatment is healthier than control", () => {
    const result = evaluateGates(report(cohort(200, 100, 0), cohort(200, 100, 20)), policy);
    expect(check(result, "max_error_rate_increase")).toMatchObject({
      verdict: "pass",
      observed: -0.1,
    });
    expect(check(result, "max_error_rate_increase").message).toBe(
      "Treatment errors differ from control by -10 pp, within the 1 pp allowed",
    );
  });

  it("compares rates, not error counts, when cohorts differ in size", () => {
    // 3 / 200 = 1.5 % vs 30 / 3000 = 1 %: ten times fewer errors, still a 0.5 pp increase.
    const result = evaluateGates(
      report(cohort(200, 100, 3), cohort(3000, 900, 30)),
      only({ maxErrorRateIncrease: 0.004 }),
    );
    expect(result.breached).toEqual(["max_error_rate_increase"]);
  });
});

describe("latency limits", () => {
  const control = cohort(200, 100, 0, 300);

  it.each([
    [399, "pass"],
    [400, "pass"],
    [401, "fail"],
  ] as const)("absolute p95 of %i ms against a 400 ms limit → %s", (p95, verdict) => {
    const result = evaluateGates(
      report(cohort(200, 100, 0, p95), control),
      only({ maxP95LatencyMs: 400 }),
    );
    expect(check(result, "max_p95_latency")).toMatchObject({ verdict, observed: p95 });
  });

  it.each([
    [400, "pass"],
    [401, "fail"],
  ] as const)("p95 of %i ms against a 300 ms control and a 100 ms increase → %s", (p95, verdict) => {
    const result = evaluateGates(
      report(cohort(200, 100, 0, p95), control),
      only({ maxP95LatencyIncreaseMs: 100 }),
    );
    expect(check(result, "max_p95_latency_increase").verdict).toBe(verdict);
  });

  it("passes a faster treatment with a zero increase limit", () => {
    const result = evaluateGates(
      report(cohort(200, 100, 0, 250), control),
      only({ maxP95LatencyIncreaseMs: 0 }),
    );
    expect(check(result, "max_p95_latency_increase")).toMatchObject({
      verdict: "pass",
      observed: -50,
    });
  });

  it("cannot compare with control when only the treatment reported latency", () => {
    const result = evaluateGates(
      report(cohort(200, 100, 0, 250), cohort(200, 100, 0, null)),
      only({ maxP95LatencyIncreaseMs: 100 }),
    );
    expect(check(result, "max_p95_latency_increase")).toMatchObject({
      verdict: "insufficient_data",
      observed: null,
      message: "No latency data to check max_p95_latency_increase",
    });
    expect(result.verdict).toBe("insufficient_data");
  });
});

describe("minimum sample", () => {
  const policy = only({ maxErrorRate: 0.02 });

  it("passes with exactly the minimum in both cohorts", () => {
    const result = evaluateGates(report(cohort(200, 100, 0), cohort(200, 100, 0)), policy);
    expect(result.verdict).toBe("pass");
    expect(check(result, "min_subjects")).toMatchObject({ verdict: "pass", observed: 100 });
    expect(check(result, "min_requests")).toMatchObject({ verdict: "pass", observed: 200 });
  });

  it("is short by a single subject", () => {
    const result = evaluateGates(report(cohort(200, 99, 0), cohort(200, 100, 0)), policy);
    expect(result.verdict).toBe("insufficient_data");
    expect(check(result, "min_subjects")).toMatchObject({
      verdict: "insufficient_data",
      observed: 99,
      message: "Each cohort needs 100 subjects; treatment has 99, control 100",
    });
    expect(check(result, "min_requests").verdict).toBe("pass");
  });

  it("lets the smaller cohort decide, even when that is control", () => {
    const result = evaluateGates(report(cohort(5000, 2000, 0), cohort(199, 150, 0)), policy);
    expect(check(result, "min_requests")).toMatchObject({
      verdict: "insufficient_data",
      observed: 199,
    });
    expect(result.verdict).toBe("insufficient_data");
  });

  it("holds back a failing limit until the sample is large enough", () => {
    const small = evaluateGates(report(cohort(199, 100, 199), cohort(200, 100, 0)), policy);
    expect(small.verdict).toBe("insufficient_data");
    expect(small.breached).toEqual([]);
    expect(check(small, "max_error_rate").message).toBe(
      "Treatment error rate 100 % is above the 2 % limit, but the sample is too small to judge yet",
    );

    const enough = evaluateGates(report(cohort(200, 100, 200), cohort(200, 100, 0)), policy);
    expect(enough.verdict).toBe("fail");
  });

  it("reports a cohort with no traffic as insufficient data", () => {
    const result = evaluateGates(
      report(cohort(0, 0, 0), cohort(3000, 1000, 10)),
      only({ maxErrorRate: 0.02, maxErrorRateIncrease: 0.01 }),
    );
    expect(result.verdict).toBe("insufficient_data");
    expect(check(result, "max_error_rate")).toMatchObject({
      observed: null,
      message: "No request data to check max_error_rate",
    });
    expect(check(result, "max_error_rate_increase").observed).toBeNull();
  });

  it("accepts a minimum of one", () => {
    const result = evaluateGates(
      report(cohort(1, 1, 0), cohort(1, 1, 0)),
      only({ maxErrorRate: 0 }, { subjects: 1, requests: 1 }),
    );
    expect(result.verdict).toBe("pass");
  });
});

describe("overall verdict", () => {
  it("prefers fail over insufficient data and only explains the failures", () => {
    // Error rate breached; latency was never reported.
    const result = evaluateGates(
      report(cohort(200, 100, 10, null), cohort(200, 100, 0, null)),
      base,
    );
    expect(result.verdict).toBe("fail");
    expect(result.breached).toEqual(["max_error_rate", "max_error_rate_increase"]);
    expect(check(result, "max_p95_latency_increase").verdict).toBe("insufficient_data");
    expect(describeBlock(result)).not.toContain("latency");
  });

  it("lists breached rules in rule order", () => {
    const result = evaluateGates(report(cohort(200, 100, 100, 900), cohort(200, 100, 0, 100)), {
      ...base,
      maxP95LatencyMs: 500,
    });
    expect(result.breached).toEqual([
      "max_error_rate",
      "max_error_rate_increase",
      "max_p95_latency",
      "max_p95_latency_increase",
    ]);
  });

  it("is deterministic and leaves its inputs untouched", () => {
    const metrics = report(cohort(312, 104, 16), cohort(2688, 896, 28));
    const policy = { ...base };
    const before = JSON.stringify([metrics, policy]);
    const first = evaluateGates(metrics, policy);
    expect(evaluateGates(metrics, policy)).toEqual(first);
    expect(JSON.stringify([metrics, policy])).toBe(before);
  });

  it("rounds messages to two decimals", () => {
    const result = evaluateGates(
      report(cohort(300, 100, 100), cohort(300, 100, 0)),
      only({ maxErrorRate: 0.02 }),
    );
    expect(check(result, "max_error_rate").message).toBe(
      "Treatment error rate 33.33 % is above the 2 % limit",
    );
  });
});

describe("gatePolicyProblems at the bounds", () => {
  const valid = (patch: Partial<Record<keyof GatePolicy, unknown>>) => ({
    ...DEFAULT_GATE_POLICY,
    ...patch,
  });

  it.each([
    ["the smallest sample", { minSubjectsPerCohort: 1, minRequestsPerCohort: 1 }],
    ["the largest sample", { minSubjectsPerCohort: MAX_MIN_SAMPLE }],
    ["zero limits", { maxErrorRate: 0, maxErrorRateIncrease: 0, maxP95LatencyIncreaseMs: 0 }],
    ["an error rate of 1", { maxErrorRate: 1 }],
    ["the largest latency", { maxP95LatencyMs: MAX_LATENCY_LIMIT_MS }],
    ["a single limit", { maxErrorRate: null, maxErrorRateIncrease: null, maxP95LatencyIncreaseMs: null, maxP95LatencyMs: 1 }],
  ])("accepts %s", (_label, patch) => {
    expect(gatePolicyProblems(valid(patch))).toEqual([]);
  });

  it.each([
    ["a zero sample", { minRequestsPerCohort: 0 }, "minRequestsPerCohort must be a whole number from 1 to 1000000"],
    ["a sample above the maximum", { minSubjectsPerCohort: MAX_MIN_SAMPLE + 1 }, "minSubjectsPerCohort must be a whole number from 1 to 1000000"],
    ["a null sample", { minSubjectsPerCohort: null }, "minSubjectsPerCohort must be a whole number from 1 to 1000000"],
    ["a negative rate", { maxErrorRate: -0.01 }, "maxErrorRate must be null or a number from 0 to 1"],
    ["a rate above 1", { maxErrorRateIncrease: 1.01 }, "maxErrorRateIncrease must be null or a number from 0 to 1"],
    ["NaN", { maxErrorRate: Number.NaN }, "maxErrorRate must be null or a number from 0 to 1"],
    ["Infinity", { maxP95LatencyMs: Number.POSITIVE_INFINITY }, "maxP95LatencyMs must be null or a number from 0 to 600000 ms"],
    ["latency above the maximum", { maxP95LatencyIncreaseMs: MAX_LATENCY_LIMIT_MS + 1 }, "maxP95LatencyIncreaseMs must be null or a number from 0 to 600000 ms"],
  ])("rejects %s", (_label, patch, problem) => {
    expect(gatePolicyProblems(valid(patch))).toEqual([problem]);
  });

  it.each([null, [], "policy"])("rejects %j as a policy", (input) => {
    expect(gatePolicyProblems(input)).toEqual(["policy must be an object"]);
  });

  it("reports every problem at once and skips the no-limit check", () => {
    const problems = gatePolicyProblems({
      minSubjectsPerCohort: 0,
      minRequestsPerCohort: 0,
      maxErrorRate: null,
      maxErrorRateIncrease: null,
      maxP95LatencyMs: null,
      maxP95LatencyIncreaseMs: null,
      note: "x",
    });
    expect(problems).toEqual([
      "unknown field note",
      "minSubjectsPerCohort must be a whole number from 1 to 1000000",
      "minRequestsPerCohort must be a whole number from 1 to 1000000",
    ]);
  });
});
