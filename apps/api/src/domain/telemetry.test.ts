import { describe, expect, it } from "vitest";
import { syntheticCheckoutTelemetry } from "./telemetry-fixture.js";
import { compareEvents, eventProblems, normaliseEvent, type TelemetryEventInput } from "./telemetry.js";

const now = new Date("2026-01-12T10:00:00.000Z");
const scope = { workspaceId: "w", flagKey: "new-checkout", environmentKey: "production" };

function event(overrides: Partial<TelemetryEventInput> = {}): TelemetryEventInput {
  return {
    eventId: "evt-1",
    subjectKey: "synthetic-0001",
    value: true,
    outcome: "success",
    latencyMs: 120,
    occurredAt: "2026-01-12T09:30:00.000Z",
    ...overrides,
  };
}

describe("eventProblems", () => {
  it("accepts a well-formed event", () => {
    expect(eventProblems(event(), now)).toEqual([]);
    expect(eventProblems(event({ latencyMs: undefined }), now)).toEqual([]);
  });

  it.each([
    ["empty event id", { eventId: "" }, "eventId"],
    ["event id with spaces", { eventId: "evt 1" }, "eventId"],
    ["over-long event id", { eventId: "e".repeat(129) }, "eventId"],
    ["empty subject", { subjectKey: "" }, "subjectKey"],
    ["subject with a newline", { subjectKey: "a\nb" }, "subjectKey"],
    ["negative latency", { latencyMs: -1 }, "latencyMs"],
    ["fractional latency", { latencyMs: 1.5 }, "latencyMs"],
    ["huge latency", { latencyMs: 600_001 }, "latencyMs"],
    ["date without time", { occurredAt: "2026-01-12" }, "occurredAt"],
    ["timestamp without zone", { occurredAt: "2026-01-12T09:30:00" }, "occurredAt"],
    ["impossible date", { occurredAt: "2026-02-30T09:30:00Z" }, "occurredAt"],
    ["far future", { occurredAt: "2026-01-12T10:05:01.000Z" }, "future"],
  ])("rejects %s", (_name, overrides, fragment) => {
    const problems = eventProblems(event(overrides), now);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(fragment);
  });

  it("allows a few minutes of clock skew", () => {
    expect(eventProblems(event({ occurredAt: "2026-01-12T10:05:00.000Z" }), now)).toEqual([]);
  });
});

describe("normaliseEvent", () => {
  it("stores the time in UTC and a missing latency as null", () => {
    const stored = normaliseEvent(
      scope,
      event({ occurredAt: "2026-01-12T11:30:00+02:00", latencyMs: undefined }),
      now,
    );
    expect(stored).toMatchObject({
      ...scope,
      occurredAt: "2026-01-12T09:30:00.000Z",
      latencyMs: null,
      receivedAt: "2026-01-12T10:00:00.000Z",
    });
  });

  it("gives equivalent events the same fingerprint", () => {
    const a = normaliseEvent(scope, event(), now);
    const b = normaliseEvent(
      scope,
      event({ occurredAt: "2026-01-12T10:30:00+01:00" }),
      new Date("2026-01-12T11:00:00Z"),
    );
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it("gives different content a different fingerprint", () => {
    const base = normaliseEvent(scope, event(), now).fingerprint;
    for (const change of [
      { outcome: "error" as const },
      { value: false },
      { latencyMs: 121 },
      { subjectKey: "synthetic-0002" },
      { occurredAt: "2026-01-12T09:30:00.001Z" },
    ]) {
      expect(normaliseEvent(scope, event(change), now).fingerprint).not.toBe(base);
    }
  });
});

describe("compareEvents", () => {
  it("orders by time, then event id", () => {
    const sorted = [
      { occurredAt: "2026-01-12T09:00:00.000Z", eventId: "b" },
      { occurredAt: "2026-01-12T08:00:00.000Z", eventId: "z" },
      { occurredAt: "2026-01-12T09:00:00.000Z", eventId: "a" },
    ].sort(compareEvents);
    expect(sorted.map((e) => e.eventId)).toEqual(["z", "a", "b"]);
  });
});

describe("syntheticCheckoutTelemetry", () => {
  const options = {
    flagKey: "new-checkout",
    salt: "new-checkout",
    percentage: 10,
    start: "2026-01-12T09:00:00.000Z",
    treatmentErrorRate: 0.06,
    controlErrorRate: 0.01,
  };

  it("is identical on every run", () => {
    expect(syntheticCheckoutTelemetry(options)).toEqual(syntheticCheckoutTelemetry(options));
  });

  it("produces valid events for 1,000 subjects inside the window", () => {
    const events = syntheticCheckoutTelemetry(options);
    expect(events).toHaveLength(3000);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(3000);
    for (const e of events) {
      expect(eventProblems(e, now)).toEqual([]);
      expect(e.occurredAt >= "2026-01-12T09:00:00.000Z").toBe(true);
      expect(e.occurredAt < "2026-01-12T10:00:00.000Z").toBe(true);
    }
  });

  it("puts the same subjects in treatment as the evaluator's 10 % cohort", () => {
    const treated = new Set(
      syntheticCheckoutTelemetry(options)
        .filter((e) => e.value)
        .map((e) => e.subjectKey),
    );
    // Matches the bucketing figure documented in the API README.
    expect(treated.size).toBe(104);
  });

  it("raises the treatment error rate above the control rate", () => {
    const events = syntheticCheckoutTelemetry(options);
    const rate = (value: boolean) => {
      const cohort = events.filter((e) => e.value === value);
      return cohort.filter((e) => e.outcome === "error").length / cohort.length;
    };
    expect(rate(true)).toBeGreaterThan(0.03);
    expect(rate(false)).toBeLessThan(0.02);
  });
});
