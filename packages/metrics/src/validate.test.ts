import { describe, expect, it } from "vitest";
import { aggregateCohortMetrics, type CohortMetrics } from "./aggregate.js";
import { cohortMetricsProblems, MAX_METRICS_WINDOWS } from "./validate.js";

function sample(): CohortMetrics {
  return aggregateCohortMetrics([
    {
      eventId: "a",
      subjectKey: "s-1",
      value: true,
      outcome: "error",
      latencyMs: 120,
      occurredAt: "2026-01-12T09:01:00.000Z",
    },
    {
      eventId: "b",
      subjectKey: "s-2",
      value: false,
      outcome: "success",
      latencyMs: 90,
      occurredAt: "2026-01-12T09:20:00.000Z",
    },
  ]);
}

/** A JSON round trip, like a report sent over HTTP. */
function wire(metrics: CohortMetrics): Record<string, unknown> {
  return JSON.parse(JSON.stringify(metrics)) as Record<string, unknown>;
}

describe("cohortMetricsProblems", () => {
  it("accepts what the aggregator produces after a JSON round trip", () => {
    expect(cohortMetricsProblems(wire(sample()))).toEqual([]);
  });

  it("rejects non-objects and wrong schema versions", () => {
    expect(cohortMetricsProblems(null)).toEqual(["metrics must be an object"]);
    expect(cohortMetricsProblems([])).toEqual(["metrics must be an object"]);
    expect(cohortMetricsProblems({ ...wire(sample()), schemaVersion: 2 })).toContain(
      "schemaVersion must be 1",
    );
  });

  it("rejects a bad digest, window length or timestamp", () => {
    const problems = cohortMetricsProblems({
      ...wire(sample()),
      sourceDigest: "ABC",
      windowMinutes: 0,
      firstEventAt: "2026-01-12",
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        "sourceDigest must be a lowercase SHA-256 hex digest",
        "windowMinutes must be a whole number from 1 to 1440",
        "firstEventAt must be a UTC ISO timestamp or null",
      ]),
    );
  });

  it("rejects totals that don't match the event count or the windows", () => {
    const metrics = sample();
    metrics.eventCount = 3;
    expect(cohortMetricsProblems(wire(metrics))).toContain(
      "totals requests must add up to eventCount",
    );

    const other = sample();
    other.windows = other.windows.slice(1);
    expect(cohortMetricsProblems(wire(other))).toContain(
      "windows treatment requests must add up to totals",
    );
  });

  it("rejects an error rate that doesn't match the counts", () => {
    const metrics = sample();
    metrics.totals.treatment.errorRate = 0.5;
    expect(cohortMetricsProblems(wire(metrics))).toContain(
      "totals.treatment.errorRate must be errors / requests (null without requests)",
    );
  });

  it("rejects unordered latency percentiles and more errors than requests", () => {
    const metrics = sample();
    metrics.totals.control.latency = { samples: 1, p50Ms: 100, p95Ms: 90, maxMs: 100 };
    metrics.totals.control.errors = 5;
    const problems = cohortMetricsProblems(wire(metrics));
    expect(problems).toContain(
      "totals.control.latency must be null or ordered whole-millisecond percentiles",
    );
    expect(problems).toContain("totals.control errors and subjects cannot exceed requests");
  });

  it("rejects windows out of order or of the wrong length", () => {
    const metrics = sample();
    metrics.windows.reverse();
    expect(cohortMetricsProblems(wire(metrics))).toContain("windows[1] is out of order");

    const short = sample();
    const first = short.windows[0];
    if (first) first.end = "2026-01-12T09:10:00.000Z";
    expect(cohortMetricsProblems(wire(short))).toContain("windows[0] must span windowMinutes");
  });

  it("caps the number of windows", () => {
    const metrics = wire(sample());
    metrics.windows = Array.from({ length: MAX_METRICS_WINDOWS + 1 }, () => ({}));
    expect(cohortMetricsProblems(metrics)).toContain(
      `windows may hold at most ${MAX_METRICS_WINDOWS} entries`,
    );
  });
});
