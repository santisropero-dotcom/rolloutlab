import { aggregateCohortMetrics, type CohortMetrics } from "@rolloutlab/metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USER_HEADER } from "../auth.js";
import { syntheticCheckoutTelemetry } from "../domain/telemetry-fixture.js";
import { normaliseEvent } from "../domain/telemetry.js";
import { demoSeed } from "../seed.js";
import { buildServer } from "../server.js";
import { MemoryStore } from "../store.js";

type App = ReturnType<typeof buildServer>;

const fixedNow = () => new Date("2026-01-12T10:00:00.000Z");
const metricsUrl = (workspace: string, flag: string, environment: string) =>
  `/workspaces/${workspace}/flags/${flag}/environments/${environment}/telemetry/metrics`;
const production = metricsUrl("storefront", "new-checkout", "production");

function as(user: string) {
  return { [USER_HEADER]: user };
}

const scope = { workspaceId: "storefront", flagKey: "new-checkout", environmentKey: "production" };
const events = syntheticCheckoutTelemetry({
  flagKey: "new-checkout",
  salt: "new-checkout",
  percentage: 10,
  start: "2026-01-12T09:00:00.000Z",
  treatmentErrorRate: 0.06,
  controlErrorRate: 0.01,
}).map((e) => normaliseEvent(scope, e, fixedNow()));

function report(count = events.length): CohortMetrics {
  return aggregateCohortMetrics(events.slice(0, count));
}

describe("cohort metrics API", () => {
  let app: App;

  beforeEach(async () => {
    app = buildServer({ store: MemoryStore.fromSeed(demoSeed, fixedNow), logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function put(payload: unknown, user = "bob", url = production) {
    return app.inject({ method: "PUT", url, headers: as(user), payload: payload as object });
  }

  it("answers 404 until metrics have been computed", async () => {
    const response = await app.inject({ url: production, headers: as("carol") });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("stores a report and serves it to readers unchanged", async () => {
    const metrics = report();
    const stored = await put(metrics);
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toMatchObject({
      ...scope,
      computedAt: "2026-01-12T10:00:00.000Z",
      computedBy: "bob",
    });

    const read = await app.inject({ url: production, headers: as("carol") });
    expect(read.statusCode).toBe(200);
    expect(read.json().metrics).toEqual(JSON.parse(JSON.stringify(metrics)));
    expect(read.json().metrics.eventCount).toBe(3000);
  });

  it("only lets roles that send telemetry write metrics", async () => {
    const response = await put(report(), "carol");
    expect(response.statusCode).toBe(403);
    expect((await put(report(), "alice")).statusCode).toBe(200);
  });

  it("hides other workspaces and needs a user", async () => {
    expect((await put(report(), "dave")).statusCode).toBe(404);
    expect((await app.inject({ url: production, headers: as("dave") })).statusCode).toBe(404);
    expect((await app.inject({ url: production })).statusCode).toBe(401);
  });

  it("checks the flag and environment exist", async () => {
    expect((await put(report(), "bob", metricsUrl("storefront", "nope", "production"))).statusCode).toBe(404);
    expect((await put(report(), "bob", metricsUrl("storefront", "new-checkout", "nope"))).statusCode).toBe(404);
  });

  it("rejects a malformed or inconsistent report with every problem listed", async () => {
    const metrics = report();
    const response = await put({ ...metrics, eventCount: 1, sourceDigest: "x" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_FAILED");
    expect(response.json().error.message).toContain("sourceDigest");

    expect((await put([])).statusCode).toBe(400);
  });

  it("refuses a report built from fewer events than the stored one", async () => {
    expect((await put(report())).statusCode).toBe(200);
    const stale = await put(report(1500));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("STALE_METRICS");

    const read = await app.inject({ url: production, headers: as("carol") });
    expect(read.json().metrics.eventCount).toBe(3000);
  });

  it("keeps metrics per environment", async () => {
    expect((await put(report())).statusCode).toBe(200);
    const development = await app.inject({
      url: metricsUrl("storefront", "new-checkout", "development"),
      headers: as("carol"),
    });
    expect(development.statusCode).toBe(404);
  });
});
