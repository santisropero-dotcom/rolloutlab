import { describe, expect, it } from "vitest";
import type { CohortMetrics, CohortStats } from "./aggregate.js";
import {
  DEFAULT_GATE_POLICY,
  describeBlock,
  evaluateGates,
  gatePolicyProblems,
  type GatePolicy,
} from "./gates.js";

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
    latency: p95Ms === null ? null : { samples: requests, p50Ms: 100, p95Ms, maxMs: p95Ms + 50 },
  };
}

function report(treatment: CohortStats, control: CohortStats): CohortMetrics {
  return {
    schemaVersion: 1,
    windowMinutes: 15,
    eventCount: treatment.requests + control.requests,
    firstEventAt: "2026-01-12T09:00:00.000Z",
    lastEventAt: "2026-01-12T09:59:00.000Z",
    sourceDigest: "a".repeat(64),
    totals: { treatment, control },
    windows: [],
  };
}

const policy: GatePolicy = { ...DEFAULT_GATE_POLICY };

describe("evaluateGates", () => {
  it("passes a healthy canary and lists every check", () => {
    const result = evaluateGates(report(cohort(300, 104, 3), cohort(2700, 896, 27)), policy);
    expect(result.verdict).toBe("pass");
    expect(result.breached).toEqual([]);
    expect(result.checks.map((c) => [c.rule, c.verdict])).toEqual([
      ["min_subjects", "pass"],
      ["min_requests", "pass"],
      ["max_error_rate", "pass"],
      ["max_error_rate_increase", "pass"],
      ["max_p95_latency_increase", "pass"],
    ]);
    expect(result).toMatchObject({ sourceDigest: "a".repeat(64), eventCount: 3000 });
    expect(describeBlock(result)).toBeNull();
  });

  it("fails a degraded canary and names the rules it breached", () => {
    // 16 errors in 312 requests (5.13 %) against a 1.04 % control.
    const result = evaluateGates(report(cohort(312, 104, 16), cohort(2688, 896, 28)), policy);
    expect(result.verdict).toBe("fail");
    expect(result.breached).toEqual(["max_error_rate", "max_error_rate_increase"]);
    const errorRate = result.checks.find((c) => c.rule === "max_error_rate");
    expect(errorRate).toMatchObject({ observed: 16 / 312, threshold: 0.02 });
    expect(errorRate?.message).toBe("Treatment error rate 5.13 % is above the 2 % limit");
    expect(describeBlock(result)).toBe(
      "Release gate breached: Treatment error rate 5.13 % is above the 2 % limit; " +
        "Treatment errors exceed control by 4.09 pp, more than the 1 pp allowed",
    );
  });

  it("fails on latency regressions", () => {
    const result = evaluateGates(
      report(cohort(300, 120, 0, 450), cohort(300, 120, 0, 300)),
      { ...policy, maxP95LatencyMs: 400 },
    );
    expect(result.breached).toEqual(["max_p95_latency", "max_p95_latency_increase"]);
    expect(result.checks.at(-1)?.message).toBe(
      "Treatment p95 latency is 150 ms slower than control, more than the 100 ms allowed",
    );
  });

  it("reports insufficient data while either cohort is below the minimum sample", () => {
    // The canary is clearly degraded, but 40 subjects are too few to judge.
    const result = evaluateGates(report(cohort(120, 40, 30), cohort(2880, 960, 29)), policy);
    expect(result.verdict).toBe("insufficient_data");
    expect(result.breached).toEqual([]);
    expect(result.checks[0]).toMatchObject({
      rule: "min_subjects",
      verdict: "insufficient_data",
      observed: 40,
      threshold: 100,
    });
    expect(result.checks.find((c) => c.rule === "max_error_rate")).toMatchObject({
      verdict: "insufficient_data",
      observed: 0.25,
    });
    expect(describeBlock(result)).toMatch(/^Not enough telemetry to judge the release gates: /);
  });

  it("treats missing metrics as insufficient data, never as a pass", () => {
    const result = evaluateGates(null, policy);
    expect(result.verdict).toBe("insufficient_data");
    expect(result).toMatchObject({ sourceDigest: null, eventCount: 0 });
    expect(result.checks.every((c) => c.verdict === "insufficient_data")).toBe(true);
  });

  it("cannot judge latency rules when no latency was reported", () => {
    const result = evaluateGates(
      report(cohort(300, 120, 0, null), cohort(300, 120, 0, null)),
      policy,
    );
    expect(result.verdict).toBe("insufficient_data");
    expect(result.checks.at(-1)).toMatchObject({
      rule: "max_p95_latency_increase",
      verdict: "insufficient_data",
      observed: null,
    });
  });

  it("skips rules whose limit is null", () => {
    const result = evaluateGates(report(cohort(300, 120, 30), cohort(300, 120, 0)), {
      ...policy,
      maxErrorRate: null,
      maxErrorRateIncrease: null,
    });
    expect(result.verdict).toBe("pass");
    expect(result.checks.map((c) => c.rule)).toEqual([
      "min_subjects",
      "min_requests",
      "max_p95_latency_increase",
    ]);
  });
});

describe("gatePolicyProblems", () => {
  it("accepts the default policy", () => {
    expect(gatePolicyProblems({ ...DEFAULT_GATE_POLICY })).toEqual([]);
  });

  it.each([
    ["a non-object", 42, "policy must be an object"],
    ["an unknown field", { ...DEFAULT_GATE_POLICY, extra: 1 }, "unknown field extra"],
    [
      "a fractional sample size",
      { ...DEFAULT_GATE_POLICY, minSubjectsPerCohort: 1.5 },
      "minSubjectsPerCohort must be a whole number from 1 to 1000000",
    ],
    [
      "a missing field",
      { ...DEFAULT_GATE_POLICY, maxErrorRate: undefined },
      "maxErrorRate must be null or a number from 0 to 1",
    ],
    [
      "a string limit",
      { ...DEFAULT_GATE_POLICY, maxErrorRate: "0.02" },
      "maxErrorRate must be null or a number from 0 to 1",
    ],
    [
      "no limits at all",
      {
        ...DEFAULT_GATE_POLICY,
        maxErrorRate: null,
        maxErrorRateIncrease: null,
        maxP95LatencyMs: null,
        maxP95LatencyIncreaseMs: null,
      },
      "at least one limit must be set",
    ],
  ])("rejects %s", (_label, input, problem) => {
    expect(gatePolicyProblems(input)).toContain(problem);
  });
});
