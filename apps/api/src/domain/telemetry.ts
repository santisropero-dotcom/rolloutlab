import { createHash } from "node:crypto";
import { MAX_SUBJECT_KEY_LENGTH } from "@rolloutlab/evaluator";

/**
 * Health signals reported by the service that served a flag. Each event says
 * which value one subject was served and how their request went, so later
 * steps can compare the treatment cohort (`value: true`) with the control
 * cohort (`value: false`).
 */

export const OUTCOMES = ["success", "error"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const MAX_EVENTS_PER_BATCH = 1000;
export const MAX_EVENT_ID_LENGTH = 128;
export const MAX_LATENCY_MS = 600_000;
/** How far ahead of the server clock an event may be stamped. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export interface TelemetryEventInput {
  /** Chosen by the sender; sending the same id again is a no-op. */
  eventId: string;
  subjectKey: string;
  /** The flag value the subject was served. */
  value: boolean;
  outcome: Outcome;
  latencyMs?: number;
  occurredAt: string;
}

export interface TelemetryEvent {
  workspaceId: string;
  flagKey: string;
  environmentKey: string;
  eventId: string;
  subjectKey: string;
  value: boolean;
  outcome: Outcome;
  latencyMs: number | null;
  /** Normalised to UTC with milliseconds. */
  occurredAt: string;
  receivedAt: string;
  /** SHA-256 of the fields above that the sender controls. */
  fingerprint: string;
}

export type RejectionCode = "INVALID_EVENT" | "CONFLICTING_DUPLICATE";

export interface RejectedEvent {
  index: number;
  eventId: string | null;
  code: RejectionCode;
  message: string;
}

export interface IngestResult {
  received: number;
  accepted: number;
  /** Already stored with the same content, so ignored. */
  duplicates: number;
  rejected: RejectedEvent[];
}

/** Why an event can't be stored, or an empty list when it can. */
export function eventProblems(event: TelemetryEventInput, now: Date): string[] {
  const problems: string[] = [];
  if (
    event.eventId.length === 0 ||
    event.eventId.length > MAX_EVENT_ID_LENGTH ||
    !EVENT_ID_PATTERN.test(event.eventId)
  ) {
    problems.push(
      `eventId must be 1–${MAX_EVENT_ID_LENGTH} letters, digits, ".", "_", ":" or "-"`,
    );
  }
  if (
    event.subjectKey.length === 0 ||
    event.subjectKey.length > MAX_SUBJECT_KEY_LENGTH ||
    /[\r\n]/.test(event.subjectKey)
  ) {
    problems.push(`subjectKey must be 1–${MAX_SUBJECT_KEY_LENGTH} characters without newlines`);
  }
  if (
    event.latencyMs !== undefined &&
    (!Number.isInteger(event.latencyMs) || event.latencyMs < 0 || event.latencyMs > MAX_LATENCY_MS)
  ) {
    problems.push(`latencyMs must be a whole number from 0 to ${MAX_LATENCY_MS}`);
  }
  const occurred = parseTimestamp(event.occurredAt);
  if (occurred === undefined) {
    problems.push("occurredAt must be an ISO 8601 timestamp with a time zone");
  } else if (occurred.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) {
    problems.push("occurredAt is more than 5 minutes in the future");
  }
  return problems;
}

function parseTimestamp(value: string): Date | undefined {
  if (!ISO_TIMESTAMP.test(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * The stored form of a valid event. Equivalent inputs (the same instant in
 * another time zone, `latencyMs` left out vs. sent) give the same fingerprint.
 */
export function normaliseEvent(
  scope: { workspaceId: string; flagKey: string; environmentKey: string },
  event: TelemetryEventInput,
  receivedAt: Date,
): TelemetryEvent {
  const occurredAt = new Date(event.occurredAt).toISOString();
  const latencyMs = event.latencyMs ?? null;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        event.eventId,
        event.subjectKey,
        event.value,
        event.outcome,
        latencyMs,
        occurredAt,
      ]),
    )
    .digest("hex");
  return {
    ...scope,
    eventId: event.eventId,
    subjectKey: event.subjectKey,
    value: event.value,
    outcome: event.outcome,
    latencyMs,
    occurredAt,
    receivedAt: receivedAt.toISOString(),
    fingerprint,
  };
}

/** Oldest first; ties broken by event id, so replays list in the same order. */
export type EventPosition = Pick<TelemetryEvent, "occurredAt" | "eventId">;

export function compareEvents(a: EventPosition, b: EventPosition): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  if (a.eventId === b.eventId) return 0;
  return a.eventId < b.eventId ? -1 : 1;
}
