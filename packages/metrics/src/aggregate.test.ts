import { describe, expect, it } from "vitest";
import { aggregateCohortMetrics, percentile, type MetricsEvent } from "./aggregate.js";
import { cohortMetricsProblems } from "./validate.js";

function event(overrides: Partial<MetricsEvent> & { eventId: string }): MetricsEvent {
  return {
    subjectKey: "s-1",
    value: true,
    outcome: "success",
    latencyMs: 100,
    occurredAt: "2026-01-12T09:00:00.000Z",
    ...overrides,
  };
}

/** Deterministic synthetic traffic: 200 subjects × 4 requests over two hours. */
function fixture(): MetricsEvent[] {
  const events: MetricsEvent[] = [];
  for (let s = 0; s < 200; s += 1) {
    for (let r = 0; r < 4; r += 1) {
      const n = s * 4 + r;
      events.push({
        eventId: `fx-${s}-${r}`,
        subjectKey: `synthetic-${s}`,
        value: s % 10 === 0,
        outcome: (n * 7919) % 50 === 0 ? "error" : "success",
        latencyMs: r === 3 ? null : 80 + ((n * 37) % 400),
        occurredAt: new Date(Date.UTC(2026, 0, 12, 9) + ((n * 104729) % 7_200_000)).toISOString(),
      });
    }
  }
  return events;
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  let state = seed;
  for (let i = copy.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    const j = state % (i + 1);
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

describe("aggregateCohortMetrics", () => {
  it("splits treatment and control and counts requests, subjects and errors", () => {
    const metrics = aggregateCohortMetrics([
      event({ eventId: "a", subjectKey: "s-1", value: true, outcome: "error", latencyMs: 300 }),
      event({ eventId: "b", subjectKey: "s-1", value: true, latencyMs: 100 }),
      event({ eventId: "c", subjectKey: "s-2", value: true, latencyMs: 200 }),
      event({ eventId: "d", subjectKey: "s-3", value: false, latencyMs: null }),
    ]);
    expect(metrics.eventCount).toBe(4);
    expect(metrics.totals.treatment).toEqual({
      requests: 3,
      subjects: 2,
      errors: 1,
      errorRate: 1 / 3,
      latency: { samples: 3, p50Ms: 200, p95Ms: 300, maxMs: 300 },
    });
    expect(metrics.totals.control).toEqual({
      requests: 1,
      subjects: 1,
      errors: 0,
      errorRate: 0,
      latency: null,
    });
  });

  it("returns empty cohorts and no windows without events", () => {
    const metrics = aggregateCohortMetrics([]);
    expect(metrics.eventCount).toBe(0);
    expect(metrics.firstEventAt).toBeNull();
    expect(metrics.windows).toEqual([]);
    expect(metrics.totals.treatment).toEqual({
      requests: 0,
      subjects: 0,
      errors: 0,
      errorRate: null,
      latency: null,
    });
    expect(cohortMetricsProblems(metrics)).toEqual([]);
  });

  it("groups events into UTC-aligned windows and lists only windows with events", () => {
    const metrics = aggregateCohortMetrics(
      [
        event({ eventId: "a", occurredAt: "2026-01-12T09:14:59.999Z" }),
        event({ eventId: "b", occurredAt: "2026-01-12T09:15:00.000Z", value: false }),
        event({ eventId: "c", occurredAt: "2026-01-12T10:46:00+01:00" }),
      ],
      { windowMinutes: 15 },
    );
    expect(metrics.windows.map((w) => [w.start, w.end])).toEqual([
      ["2026-01-12T09:00:00.000Z", "2026-01-12T09:15:00.000Z"],
      ["2026-01-12T09:15:00.000Z", "2026-01-12T09:30:00.000Z"],
      ["2026-01-12T09:45:00.000Z", "2026-01-12T10:00:00.000Z"],
    ]);
    expect(metrics.windows[1]?.cohorts.control.requests).toBe(1);
    expect(metrics.windows[1]?.cohorts.treatment.requests).toBe(0);
    expect(metrics.firstEventAt).toBe("2026-01-12T09:14:59.999Z");
    expect(metrics.lastEventAt).toBe("2026-01-12T09:46:00.000Z");
  });

  it("gives identical metrics for the same fixture in any order", () => {
    const events = fixture();
    const reference = aggregateCohortMetrics(events);
    for (const seed of [1, 2, 3]) {
      expect(aggregateCohortMetrics(shuffled(events, seed))).toEqual(reference);
    }
    expect(JSON.stringify(aggregateCohortMetrics(events.slice().reverse()))).toBe(
      JSON.stringify(reference),
    );
    expect(reference.eventCount).toBe(800);
    expect(reference.totals.treatment.subjects).toBe(20);
    expect(reference.totals.control.subjects).toBe(180);
    expect(cohortMetricsProblems(reference)).toEqual([]);
  });

  it("ignores a repeated event id, whichever copy comes first", () => {
    const events = fixture();
    const reference = aggregateCohortMetrics(events);
    const withRepeats = [...events, ...events.slice(0, 50)];
    expect(aggregateCohortMetrics(withRepeats)).toEqual(reference);
  });

  it("changes the source digest when any event changes", () => {
    const events = fixture();
    const reference = aggregateCohortMetrics(events);
    const changed = events.map((e, i) => (i === 10 ? { ...e, latencyMs: 999 } : e));
    expect(aggregateCohortMetrics(changed).sourceDigest).not.toBe(reference.sourceDigest);
    expect(aggregateCohortMetrics(events.slice(1)).sourceDigest).not.toBe(reference.sourceDigest);
  });

  it("treats the same instant in another time zone as the same event", () => {
    const a = aggregateCohortMetrics([event({ eventId: "a", occurredAt: "2026-01-12T09:30:00Z" })]);
    const b = aggregateCohortMetrics([
      event({ eventId: "a", occurredAt: "2026-01-12T10:30:00.000+01:00" }),
    ]);
    expect(b).toEqual(a);
  });

  it("rejects unusable window lengths and timestamps", () => {
    expect(() => aggregateCohortMetrics([], { windowMinutes: 0 })).toThrow(RangeError);
    expect(() => aggregateCohortMetrics([], { windowMinutes: 2.5 })).toThrow(RangeError);
    expect(() => aggregateCohortMetrics([], { windowMinutes: 24 * 60 + 1 })).toThrow(RangeError);
    expect(() => aggregateCohortMetrics([event({ eventId: "a", occurredAt: "soon" })])).toThrow(
      /invalid occurredAt/,
    );
  });
});

describe("percentile", () => {
  it("uses the nearest rank", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile(values, 10)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
  });

  it("rejects empty input and out-of-range percentiles", () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});
