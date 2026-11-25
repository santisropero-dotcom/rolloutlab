import {
  COHORTS,
  MAX_WINDOW_MINUTES,
  METRICS_SCHEMA_VERSION,
  MIN_WINDOW_MINUTES,
  type CohortMetrics,
} from "./aggregate.js";

/** Upper bound on windows in one report, so a report stays a reasonable size. */
export const MAX_METRICS_WINDOWS = 2000;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Checks that a value received over the wire is a complete, self-consistent
 * metrics report. Returns the problems found, or an empty list.
 */
export function cohortMetricsProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(value)) return ["metrics must be an object"];

  if (value.schemaVersion !== METRICS_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${METRICS_SCHEMA_VERSION}`);
  }
  if (
    !isCount(value.windowMinutes) ||
    value.windowMinutes < MIN_WINDOW_MINUTES ||
    value.windowMinutes > MAX_WINDOW_MINUTES
  ) {
    problems.push(
      `windowMinutes must be a whole number from ${MIN_WINDOW_MINUTES} to ${MAX_WINDOW_MINUTES}`,
    );
  }
  if (!isCount(value.eventCount)) problems.push("eventCount must be a whole number");
  for (const field of ["firstEventAt", "lastEventAt"] as const) {
    if (value[field] !== null && !isTimestamp(value[field])) {
      problems.push(`${field} must be a UTC ISO timestamp or null`);
    }
  }
  if (typeof value.sourceDigest !== "string" || !SHA256_HEX.test(value.sourceDigest)) {
    problems.push("sourceDigest must be a lowercase SHA-256 hex digest");
  }
  checkBreakdown(value.totals, "totals", problems);

  if (!Array.isArray(value.windows)) {
    problems.push("windows must be an array");
  } else if (value.windows.length > MAX_METRICS_WINDOWS) {
    problems.push(`windows may hold at most ${MAX_METRICS_WINDOWS} entries`);
  } else {
    let previousStart = "";
    value.windows.forEach((window: unknown, index) => {
      const path = `windows[${index}]`;
      if (!isObject(window)) {
        problems.push(`${path} must be an object`);
        return;
      }
      if (!isTimestamp(window.start) || !isTimestamp(window.end)) {
        problems.push(`${path} start and end must be UTC ISO timestamps`);
      } else {
        if (window.start <= previousStart) problems.push(`${path} is out of order`);
        if (
          isCount(value.windowMinutes) &&
          Date.parse(window.end) - Date.parse(window.start) !== value.windowMinutes * 60_000
        ) {
          problems.push(`${path} must span windowMinutes`);
        }
        previousStart = window.start;
      }
      checkBreakdown(window.cohorts, `${path}.cohorts`, problems);
    });
  }

  if (problems.length === 0) {
    const metrics = value as unknown as CohortMetrics;
    const total = metrics.totals.treatment.requests + metrics.totals.control.requests;
    if (total !== metrics.eventCount) {
      problems.push("totals requests must add up to eventCount");
    }
    for (const cohort of COHORTS) {
      const inWindows = metrics.windows.reduce((sum, w) => sum + w.cohorts[cohort].requests, 0);
      if (inWindows !== metrics.totals[cohort].requests) {
        problems.push(`windows ${cohort} requests must add up to totals`);
      }
    }
  }
  return problems;
}

function checkBreakdown(value: unknown, path: string, problems: string[]): void {
  if (!isObject(value)) {
    problems.push(`${path} must be an object`);
    return;
  }
  for (const cohort of COHORTS) {
    const stats = value[cohort];
    const at = `${path}.${cohort}`;
    if (!isObject(stats)) {
      problems.push(`${at} must be an object`);
      continue;
    }
    const { requests, subjects, errors, errorRate, latency } = stats;
    if (!isCount(requests) || !isCount(subjects) || !isCount(errors)) {
      problems.push(`${at} requests, subjects and errors must be whole numbers`);
      continue;
    }
    if (errors > requests || subjects > requests) {
      problems.push(`${at} errors and subjects cannot exceed requests`);
    }
    if (requests === 0 ? errorRate !== null : errorRate !== errors / requests) {
      problems.push(`${at}.errorRate must be errors / requests (null without requests)`);
    }
    if (latency !== null) {
      if (
        !isObject(latency) ||
        !isCount(latency.samples) ||
        latency.samples === 0 ||
        latency.samples > requests ||
        !isCount(latency.p50Ms) ||
        !isCount(latency.p95Ms) ||
        !isCount(latency.maxMs) ||
        latency.p50Ms > latency.p95Ms ||
        latency.p95Ms > latency.maxMs
      ) {
        problems.push(`${at}.latency must be null or ordered whole-millisecond percentiles`);
      }
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}
