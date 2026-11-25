import { createHash } from "node:crypto";
import { bucketFor, isInRollout } from "@rolloutlab/evaluator";
import type { TelemetryEventInput } from "./telemetry.js";

export interface CheckoutFixtureOptions {
  flagKey: string;
  salt: string;
  /** Share of subjects served `true`, as in the rollout stage. */
  percentage: number;
  subjects?: number;
  requestsPerSubject?: number;
  /** Start of the window the events are spread over. */
  start: string;
  windowMinutes?: number;
  treatmentErrorRate: number;
  controlErrorRate: number;
  /** Prefix for event ids, so two fixtures can share a flag. */
  runId?: string;
}

/**
 * Synthetic checkout telemetry for `synthetic-0000`, `synthetic-0001`, …
 *
 * Who is in the treatment cohort comes from the same bucketing the evaluator
 * uses. Errors, latencies and timestamps come from a hash of each event id,
 * so the same options always give exactly the same events, in the same order.
 */
export function syntheticCheckoutTelemetry(options: CheckoutFixtureOptions): TelemetryEventInput[] {
  const subjects = options.subjects ?? 1000;
  const requestsPerSubject = options.requestsPerSubject ?? 3;
  const windowMs = (options.windowMinutes ?? 60) * 60_000;
  const start = new Date(options.start).getTime();
  const runId = options.runId ?? "checkout";
  const events: TelemetryEventInput[] = [];
  for (let s = 0; s < subjects; s += 1) {
    const subjectKey = `synthetic-${String(s).padStart(4, "0")}`;
    const bucket = bucketFor({ flagKey: options.flagKey, salt: options.salt, subjectKey });
    const value = isInRollout(bucket, options.percentage);
    const errorRate = value ? options.treatmentErrorRate : options.controlErrorRate;
    for (let r = 0; r < requestsPerSubject; r += 1) {
      const eventId = `${runId}-${subjectKey}-${r}`;
      const outcome = unit(eventId, "outcome") < errorRate ? "error" : "success";
      events.push({
        eventId,
        subjectKey,
        value,
        outcome,
        latencyMs: 80 + Math.floor(unit(eventId, "latency") * 400),
        occurredAt: new Date(start + Math.floor(unit(eventId, "time") * windowMs)).toISOString(),
      });
    }
  }
  return events;
}

/** A number in [0, 1) derived from the event id and a label. */
function unit(eventId: string, label: string): number {
  const digest = createHash("sha256").update(`${label}\n${eventId}`).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}
