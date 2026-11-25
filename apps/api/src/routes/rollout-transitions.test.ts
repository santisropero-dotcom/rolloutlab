import { aggregateCohortMetrics } from "@rolloutlab/metrics";
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
const transitions = `${production}/transitions`;

function as(user: string) {
  return { [USER_HEADER]: user };
}

// Both cohorts at the same 1 % error rate, so the release gates pass and
// these tests exercise the state machine alone (gates have their own suite).
const scope = { workspaceId: "storefront", flagKey: "new-checkout", environmentKey: "production" };
const healthyMetrics = aggregateCohortMetrics(
  syntheticCheckoutTelemetry({
    flagKey: "new-checkout",
    salt: "new-checkout",
    percentage: 50,
    start: "2026-01-12T09:00:00.000Z",
    treatmentErrorRate: 0.01,
    controlErrorRate: 0.01,
  }).map((e) => normaliseEvent(scope, e, fixedNow())),
);

describe("rollout transitions API", () => {
  let app: App;

  beforeEach(async () => {
    const store = MemoryStore.fromSeed(demoSeed, fixedNow);
    store.putCohortMetrics("storefront", "new-checkout", "production", healthyMetrics, "bob");
    app = buildServer({ store, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function move(action: string, baseSequence: number, extra: object = {}, user = "bob") {
    return app.inject({
      method: "POST",
      url: transitions,
      headers: as(user),
      payload: { action, baseSequence, ...extra },
    });
  }

  it("starts in not_started with no history", async () => {
    const res = await app.inject({ method: "GET", url: production, headers: as("carol") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      state: { status: "not_started", version: null, stageIndex: null, percentage: 0, sequence: 0 },
      history: [],
    });
  });

  it("moves through the seeded plan and records each step", async () => {
    expect((await move("start", 0)).json().state).toMatchObject({ status: "running", percentage: 10 });
    expect((await move("advance", 1)).json().state).toMatchObject({ percentage: 50 });
    const done = await move("advance", 2);
    expect(done.statusCode).toBe(200);
    expect(done.json().state).toMatchObject({ status: "completed", percentage: 100, sequence: 3 });

    const res = await app.inject({ method: "GET", url: production, headers: as("carol") });
    const { history } = res.json();
    expect(history.map((t: { action: string }) => t.action)).toEqual([
      "start",
      "advance",
      "advance",
    ]);
    expect(history[1]).toMatchObject({
      sequence: 2,
      from: { status: "running", percentage: 10 },
      to: { status: "running", percentage: 50 },
      actor: "bob",
      at: "2026-01-12T10:00:00.000Z",
    });
  });

  it("rejects an invalid stage transition and leaves the rollout as it was", async () => {
    await move("start", 0);
    const res = await move("resume", 1);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toEqual({
      code: "INVALID_TRANSITION",
      message: "Cannot resume: Only a paused rollout can resume (it is running)",
    });
    const after = await app.inject({ method: "GET", url: production, headers: as("carol") });
    expect(after.json().state).toMatchObject({ status: "running", percentage: 10, sequence: 1 });
    expect(after.json().history).toHaveLength(1);
  });

  it("rejects advancing past the last stage", async () => {
    await move("start", 0);
    await move("advance", 1);
    await move("advance", 2);
    const res = await move("advance", 3);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INVALID_TRANSITION");
  });

  it("rejects starting where no version was published", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${rolloutUrl("storefront", "new-checkout", "development")}/transitions`,
      headers: as("bob"),
      payload: { action: "start", baseSequence: 0 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain("Publish a rollout version");
  });

  it("refuses a transition based on a stale sequence", async () => {
    await move("start", 0);
    const res = await move("advance", 0, {}, "alice");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "CONFLICT" });
    expect(res.json().error.message).toContain("transition 1, not 0");
  });

  it("requires a reason to pause or roll back and keeps it in the history", async () => {
    await move("start", 0);
    const blank = await move("pause", 1, { reason: "   " });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().error.message).toBe("A reason is required to pause");

    const paused = await move("pause", 1, { reason: "Checkout errors above baseline" });
    expect(paused.json().transition).toMatchObject({
      action: "pause",
      reason: "Checkout errors above baseline",
    });
    const rolledBack = await move("roll_back", 2, { reason: "Errors kept rising" });
    expect(rolledBack.json().state).toMatchObject({ status: "rolled_back", percentage: 0 });
  });

  it.each([
    ["an unknown action", { action: "skip", baseSequence: 0 }],
    ["a missing base sequence", { action: "start" }],
    ["a negative base sequence", { action: "start", baseSequence: -1 }],
  ])("rejects %s", async (_label, payload) => {
    const res = await app.inject({
      method: "POST",
      url: transitions,
      headers: as("bob"),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("only lets an archived flag pause or roll back", async () => {
    await move("start", 0);
    await app.inject({
      method: "PATCH",
      url: "/workspaces/storefront/flags/new-checkout",
      headers: as("alice"),
      payload: { archived: true },
    });
    expect((await move("advance", 1)).statusCode).toBe(409);
    expect((await move("roll_back", 1, { reason: "Flag retired" })).statusCode).toBe(200);
  });

  it("does not let a viewer or another workspace move the rollout", async () => {
    expect((await move("start", 0, {}, "carol")).statusCode).toBe(403);
    expect((await move("start", 0, {}, "dave")).statusCode).toBe(404);
    const read = await app.inject({ method: "GET", url: production, headers: as("dave") });
    expect(read.statusCode).toBe(404);
  });

  it("returns 404 for an unknown flag or environment", async () => {
    for (const url of [
      rolloutUrl("storefront", "missing", "production"),
      rolloutUrl("storefront", "new-checkout", "staging"),
    ]) {
      const res = await app.inject({ method: "GET", url, headers: as("alice") });
      expect(res.statusCode).toBe(404);
    }
  });
});
