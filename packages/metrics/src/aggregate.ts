import { createHash } from "node:crypto";

/**
 * Cohort metrics for one flag in one environment.
 *
 * Telemetry says which value each subject was served and how the request
 * went. Events served `true` form the treatment cohort, events served `false`
 * the control cohort. The result only depends on the set of events, never on
 * the order they arrive in, so replaying the same fixture gives exactly the
 * same metrics.
 */

export const METRICS_SCHEMA_VERSION = 1;
export const MIN_WINDOW_MINUTES = 1;
export const MAX_WINDOW_MINUTES = 24 * 60;
export const DEFAULT_WINDOW_MINUTES = 15;

export const COHORTS = ["treatment", "control"] as const;
export type Cohort = (typeof COHORTS)[number];

/** A stored telemetry event, as the API lists it. */
export interface MetricsEvent {
  eventId: string;
  subjectKey: string;
  value: boolean;
  outcome: "success" | "error";
  latencyMs: number | null;
  /** UTC ISO timestamp. */
  occurredAt: string;
}

export interface LatencySummary {
  /** Requests that reported a latency. */
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface CohortStats {
  requests: number;
  /** Distinct subjects with at least one request in this cohort. */
  subjects: number;
  errors: number;
  /** `errors / requests`, or `null` without requests. */
  errorRate: number | null;
  /** `null` when no request reported a latency. */
  latency: LatencySummary | null;
}

export type CohortBreakdown = Record<Cohort, CohortStats>;

export interface MetricsWindow {
  /** Inclusive start, aligned to the window length in UTC. */
  start: string;
  /** Exclusive end. */
  end: string;
  cohorts: CohortBreakdown;
}

export interface CohortMetrics {
  schemaVersion: typeof METRICS_SCHEMA_VERSION;
  windowMinutes: number;
  eventCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  /**
   * SHA-256 over the events that went in, sorted by id. Equal digests mean
   * the metrics were computed from the same telemetry.
   */
  sourceDigest: string;
  totals: CohortBreakdown;
  /** Windows that contain at least one event, oldest first. */
  windows: MetricsWindow[];
}

export interface AggregateOptions {
  windowMinutes?: number;
}

export function cohortOf(event: Pick<MetricsEvent, "value">): Cohort {
  return event.value ? "treatment" : "control";
}

export function aggregateCohortMetrics(
  events: readonly MetricsEvent[],
  options: AggregateOptions = {},
): CohortMetrics {
  const windowMinutes = options.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  if (
    !Number.isInteger(windowMinutes) ||
    windowMinutes < MIN_WINDOW_MINUTES ||
    windowMinutes > MAX_WINDOW_MINUTES
  ) {
    throw new RangeError(
      `windowMinutes must be a whole number from ${MIN_WINDOW_MINUTES} to ${MAX_WINDOW_MINUTES}`,
    );
  }
  const windowMs = windowMinutes * 60_000;

  // The API never stores an id twice; if a caller passes one twice anyway,
  // the copy that sorts first by content wins so the order still can't matter.
  const unique = new Map<string, MetricsEvent>();
  for (const event of events) {
    const time = Date.parse(event.occurredAt);
    if (Number.isNaN(time)) {
      throw new RangeError(`Event "${event.eventId}" has an invalid occurredAt`);
    }
    const existing = unique.get(event.eventId);
    if (!existing || eventKey(event) < eventKey(existing)) unique.set(event.eventId, event);
  }
  const sorted = [...unique.values()].sort((a, b) =>
    a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0,
  );

  const digest = createHash("sha256");
  const totals = emptyAccumulators();
  const windows = new Map<number, Record<Cohort, Accumulator>>();
  let first: number | null = null;
  let last: number | null = null;

  for (const event of sorted) {
    digest.update(eventKey(event)).update("\n");
    const time = Date.parse(event.occurredAt);
    first = first === null ? time : Math.min(first, time);
    last = last === null ? time : Math.max(last, time);
    const windowStart = Math.floor(time / windowMs) * windowMs;
    let window = windows.get(windowStart);
    if (!window) {
      window = emptyAccumulators();
      windows.set(windowStart, window);
    }
    const cohort = cohortOf(event);
    add(totals[cohort], event);
    add(window[cohort], event);
  }

  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    windowMinutes,
    eventCount: sorted.length,
    firstEventAt: first === null ? null : new Date(first).toISOString(),
    lastEventAt: last === null ? null : new Date(last).toISOString(),
    sourceDigest: digest.digest("hex"),
    totals: finish(totals),
    windows: [...windows.entries()]
      .sort(([a], [b]) => a - b)
      .map(([start, cohorts]) => ({
        start: new Date(start).toISOString(),
        end: new Date(start + windowMs).toISOString(),
        cohorts: finish(cohorts),
      })),
  };
}

/**
 * Nearest-rank percentile of values sorted ascending: the smallest value with
 * at least `p` percent of the values at or below it.
 */
export function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) throw new RangeError("No values");
  if (p <= 0 || p > 100) throw new RangeError("p must be in (0, 100]");
  const rank = Math.ceil((p / 100) * sortedValues.length);
  return sortedValues[rank - 1] as number;
}

interface Accumulator {
  requests: number;
  errors: number;
  subjects: Set<string>;
  latencies: number[];
}

function emptyAccumulators(): Record<Cohort, Accumulator> {
  return {
    treatment: { requests: 0, errors: 0, subjects: new Set(), latencies: [] },
    control: { requests: 0, errors: 0, subjects: new Set(), latencies: [] },
  };
}

function add(acc: Accumulator, event: MetricsEvent): void {
  acc.requests += 1;
  if (event.outcome === "error") acc.errors += 1;
  acc.subjects.add(event.subjectKey);
  if (event.latencyMs !== null) acc.latencies.push(event.latencyMs);
}

function finish(accs: Record<Cohort, Accumulator>): CohortBreakdown {
  return { treatment: stats(accs.treatment), control: stats(accs.control) };
}

function stats(acc: Accumulator): CohortStats {
  const latencies = [...acc.latencies].sort((a, b) => a - b);
  return {
    requests: acc.requests,
    subjects: acc.subjects.size,
    errors: acc.errors,
    errorRate: acc.requests === 0 ? null : acc.errors / acc.requests,
    latency:
      latencies.length === 0
        ? null
        : {
            samples: latencies.length,
            p50Ms: percentile(latencies, 50),
            p95Ms: percentile(latencies, 95),
            maxMs: latencies[latencies.length - 1] as number,
          },
  };
}

function eventKey(event: MetricsEvent): string {
  return JSON.stringify([
    event.eventId,
    event.subjectKey,
    event.value,
    event.outcome,
    event.latencyMs,
    new Date(event.occurredAt).toISOString(),
  ]);
}
