import { aggregateCohortMetrics, DEFAULT_GATE_POLICY } from "@rolloutlab/metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USER_HEADER } from "../auth.js";
import { syntheticCheckoutTelemetry } from "../domain/telemetry-fixture.js";
import { normaliseEvent } from "../domain/telemetry.js";
import { demoSeed } from "../seed.js";
import { buildServer } from "../server.js";
import { MemoryStore } from "../store.js";

type App = ReturnType<typeof buildServer>;

const fixedNow = () => new Date("2026-01-12T10:00:00.000Z");
const rolloutUrl = (workspace: string, flag: string, environment: string) =>
  `/workspaces/${workspace}/flags/${flag}/environments/${environment}/rollout`;
const production = rolloutUrl("storefront", "new-checkout", "production");
const gates = `${production}/gates`;
const evaluation = `${gates}/evaluation`;

function as(user: string) {
  return { [USER_HEADER]: user };
}

const scope = { workspaceId: "storefront", flagKey: "new-checkout", environmentKey: "production" };

/** The 10 % canary from the replay fixture, with the chosen error rates. */
function canaryMetrics(treatmentErrorRate: number, subjects = 1000) {
  return aggregateCohortMetrics(
    syntheticCheckoutTelemetry({
      flagKey: "new-checkout",
      salt: "new-checkout",
      percentage: 10,
      subjects,
      start: "2026-01-12T09:00:00.000Z",
      treatmentErrorRate,
      controlErrorRate: 0.01,
    }).map((e) => normaliseEvent(scope, e, fixedNow())),
  );
}

describe("release gates API", () => {
  let app: App;
  let store: MemoryStore;

  beforeEach(async () => {
    store = MemoryStore.fromSeed(demoSeed, fixedNow);
    app = buildServer({ store, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function move(action: string, baseSequence: number, extra: object = {}) {
    return app.inject({
      method: "POST",
      url: `${production}/transitions`,
      headers: as("bob"),
      payload: { action, baseSequence, ...extra },
    });
  }

  function putPolicy(payload: unknown, user = "bob") {
    return app.inject({ method: "PUT", url: gates, headers: as(user), payload: payload as object });
  }

  it("serves the default policy until one is saved", async () => {
    const res = await app.inject({ method: "GET", url: gates, headers: as("carol") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ...scope,
      policy: DEFAULT_GATE_POLICY,
      source: "default",
      updatedAt: null,
      updatedBy: null,
    });
  });

  it("saves a policy for one flag and environment", async () => {
    const policy = { ...DEFAULT_GATE_POLICY, minSubjectsPerCohort: 50, maxP95LatencyMs: 400 };
    const res = await putPolicy(policy);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      policy,
      source: "custom",
      updatedAt: "2026-01-12T10:00:00.000Z",
      updatedBy: "bob",
    });
    const other = await app.inject({
      method: "GET",
      url: `${rolloutUrl("storefront", "new-checkout", "development")}/gates`,
      headers: as("carol"),
    });
    expect(other.json().source).toBe("default");
  });

  it("rejects an invalid policy without changing the saved one", async () => {
    const res = await putPolicy({ ...DEFAULT_GATE_POLICY, maxErrorRate: "0.02" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({
      code: "VALIDATION_FAILED",
      message: "maxErrorRate must be null or a number from 0 to 1",
    });
    const after = await app.inject({ method: "GET", url: gates, headers: as("carol") });
    expect(after.json().source).toBe("default");
  });

  it("lets only editors and owners change the policy", async () => {
    expect((await putPolicy(DEFAULT_GATE_POLICY, "carol")).statusCode).toBe(403);
    expect((await putPolicy(DEFAULT_GATE_POLICY, "dave")).statusCode).toBe(404);
    expect((await putPolicy(DEFAULT_GATE_POLICY, "alice")).statusCode).toBe(200);
  });

  it("evaluates the stored metrics against the policy", async () => {
    store.putCohortMetrics("storefront", "new-checkout", "production", canaryMetrics(0.06), "bob");
    const res = await app.inject({ method: "GET", url: evaluation, headers: as("carol") });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.evaluation.verdict).toBe("fail");
    expect(body.evaluation.breached).toEqual(["max_error_rate", "max_error_rate_increase"]);
    expect(body.evaluation.eventCount).toBe(3000);
    expect(body).toMatchObject({
      metricsComputedAt: "2026-01-12T10:00:00.000Z",
      evaluatedAt: "2026-01-12T10:00:00.000Z",
      policy: { source: "default" },
    });
  });

  it("blocks a degraded canary from expanding and explains the breached rule", async () => {
    await move("start", 0);
    store.putCohortMetrics("storefront", "new-checkout", "production", canaryMetrics(0.06), "bob");

    const res = await move("advance", 1);
    expect(res.statusCode).toBe(409);
    const { error } = res.json();
    expect(error.code).toBe("GATE_BLOCKED");
    expect(error.message).toMatch(
      /^Cannot advance: Release gate breached: Treatment error rate [\d.]+ % is above the 2 % limit; /,
    );
    expect(error.details.gate.breached).toEqual(["max_error_rate", "max_error_rate_increase"]);

    const progress = await app.inject({ method: "GET", url: production, headers: as("carol") });
    expect(progress.json().state).toMatchObject({ status: "running", percentage: 10, sequence: 1 });
    // Pausing and rolling back stay available while the gate is red.
    expect((await move("roll_back", 1, { reason: "Canary breached the error gate" })).statusCode).toBe(
      200,
    );
  });

  it("blocks expansion until both cohorts reach the minimum sample", async () => {
    await move("start", 0);
    const blocked = await move("advance", 1);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.details.gate.verdict).toBe("insufficient_data");

    // 300 subjects at 10 % put about 30 in the treatment cohort.
    store.putCohortMetrics(
      "storefront",
      "new-checkout",
      "production",
      canaryMetrics(0.01, 300),
      "bob",
    );
    const small = await move("advance", 1);
    expect(small.json().error.message).toContain("Each cohort needs 100 subjects");
  });

  it("advances a healthy canary and records the evaluation in the history", async () => {
    await move("start", 0);
    store.putCohortMetrics("storefront", "new-checkout", "production", canaryMetrics(0.01), "bob");
    const res = await move("advance", 1);
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toMatchObject({ percentage: 50 });
    expect(res.json().transition.gate).toMatchObject({ verdict: "pass", eventCount: 3000 });

    const progress = await app.inject({ method: "GET", url: production, headers: as("carol") });
    const [start, advance] = progress.json().history;
    expect(start.gate).toBeUndefined();
    expect(advance.gate.verdict).toBe("pass");
  });

  it("uses a saved policy when judging", async () => {
    await move("start", 0);
    store.putCohortMetrics("storefront", "new-checkout", "production", canaryMetrics(0.06), "bob");
    await putPolicy({
      ...DEFAULT_GATE_POLICY,
      maxErrorRate: 0.1,
      maxErrorRateIncrease: 0.1,
    });
    expect((await move("advance", 1)).statusCode).toBe(200);
  });

  describe("threshold edge cases", () => {
    it("advances when the canary sits exactly on every limit and blocks just below it", async () => {
      await move("start", 0);
      const metrics = canaryMetrics(0.03);
      store.putCohortMetrics("storefront", "new-checkout", "production", metrics, "bob");
      const { treatment, control } = metrics.totals;
      const errorRate = treatment.errorRate as number;
      const increase = errorRate - (control.errorRate as number);
      const sample = {
        minSubjectsPerCohort: Math.min(treatment.subjects, control.subjects),
        minRequestsPerCohort: Math.min(treatment.requests, control.requests),
      };

      const tight = { ...DEFAULT_GATE_POLICY, ...sample, maxErrorRate: errorRate - 0.0001 };
      expect((await putPolicy({ ...tight, maxErrorRateIncrease: increase })).statusCode).toBe(200);
      const blocked = await move("advance", 1);
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error.details.gate.breached).toEqual(["max_error_rate"]);

      const exact = { ...DEFAULT_GATE_POLICY, ...sample, maxErrorRate: errorRate };
      expect((await putPolicy({ ...exact, maxErrorRateIncrease: increase })).statusCode).toBe(200);
      const res = await move("advance", 1);
      expect(res.statusCode).toBe(200);
      expect(res.json().transition.gate.verdict).toBe("pass");
    });

    it("blocks when the sample is one subject short of the minimum", async () => {
      await move("start", 0);
      const metrics = canaryMetrics(0.01);
      store.putCohortMetrics("storefront", "new-checkout", "production", metrics, "bob");
      const smallest = Math.min(metrics.totals.treatment.subjects, metrics.totals.control.subjects);
      await putPolicy({ ...DEFAULT_GATE_POLICY, minSubjectsPerCohort: smallest + 1 });

      const res = await move("advance", 1);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details.gate).toMatchObject({ verdict: "insufficient_data", breached: [] });
    });

    it("judges every stage again with the latest metrics", async () => {
      await move("start", 0);
      store.putCohortMetrics("storefront", "new-checkout", "production", canaryMetrics(0.01), "bob");
      expect((await move("advance", 1)).statusCode).toBe(200);

      // The 50 % stage turns red: the next widening is refused.
      store.putCohortMetrics("storefront", "new-checkout", "production", canaryMetrics(0.06, 1500), "bob");
      const res = await move("advance", 2);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("GATE_BLOCKED");
      const progress = await app.inject({ method: "GET", url: production, headers: as("carol") });
      expect(progress.json().state).toMatchObject({ percentage: 50, sequence: 2 });
    });

    it("never gates pausing and resuming, even while the gate is red", async () => {
      await move("start", 0);
      store.putCohortMetrics("storefront", "new-checkout", "production", canaryMetrics(0.06), "bob");
      expect((await move("pause", 1, { reason: "Investigating checkout errors" })).statusCode).toBe(200);
      const resumed = await move("resume", 2);
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json().transition.gate).toBeUndefined();
      expect((await move("advance", 3)).statusCode).toBe(409);
    });
  });
});
