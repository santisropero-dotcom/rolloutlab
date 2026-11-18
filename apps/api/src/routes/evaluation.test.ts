import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USER_HEADER } from "../auth.js";
import { demoSeed } from "../seed.js";
import { buildServer } from "../server.js";
import { MemoryStore } from "../store.js";

type App = ReturnType<typeof buildServer>;

const evaluateUrl = (workspace: string, environment: string, flag: string) =>
  `/workspaces/${workspace}/environments/${environment}/flags/${flag}/evaluate`;

const as = (user: string) => ({ [USER_HEADER]: user });

describe("evaluation API", () => {
  let app: App;

  beforeEach(async () => {
    app = buildServer({ store: MemoryStore.fromSeed(demoSeed), logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function evaluate(
    payload: object,
    { user = "carol", environment = "development", flag = "new-checkout" } = {},
  ) {
    return app.inject({
      method: "POST",
      url: evaluateUrl("storefront", environment, flag),
      headers: as(user),
      payload,
    });
  }

  it("evaluates the seeded staff rule for any workspace member", async () => {
    const res = await evaluate({ defaultValue: false, context: { email: "a@rolloutlab.test" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      flagKey: "new-checkout",
      value: true,
      reason: "TARGETING_MATCH",
      ruleId: "internal-staff",
    });
  });

  it("serves the flag default outside the rules and in other environments", async () => {
    const shopper = { defaultValue: true, context: { email: "shopper@example.test" } };
    expect((await evaluate(shopper)).json()).toMatchObject({ value: false, reason: "DEFAULT" });
    const staffInProduction = { defaultValue: true, context: { email: "a@rolloutlab.test" } };
    const production = await evaluate(staffInProduction, { environment: "production" });
    expect(production.json()).toMatchObject({ value: false, reason: "DEFAULT" });
  });

  it("answers unknown flags and type mismatches with the caller default", async () => {
    const missing = await evaluate({ defaultValue: true }, { flag: "no-such-flag" });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toMatchObject({
      value: true,
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
    });

    const mismatch = await evaluate({ defaultValue: "classic" });
    expect(mismatch.statusCode).toBe(200);
    expect(mismatch.json()).toMatchObject({
      value: "classic",
      reason: "ERROR",
      errorCode: "TYPE_MISMATCH",
    });
  });

  it("applies saved rollout rules", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/workspaces/storefront/flags/new-checkout/environments/production/rules",
      headers: as("bob"),
      payload: {
        rules: [
          {
            id: "co-ten-percent",
            conditions: [{ attribute: "country", operator: "in", values: ["CO"] }],
            serve: true,
            rollout: { percentage: 10 },
          },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().rules[0].rollout).toEqual({ percentage: 10 });

    // user-4 is in bucket 628, user-1 in bucket 9287.
    const inside = await evaluate(
      { defaultValue: false, context: { country: "CO", targetingKey: "user-4" } },
      { environment: "production" },
    );
    expect(inside.json()).toMatchObject({ value: true, reason: "SPLIT" });
    const outside = await evaluate(
      { defaultValue: false, context: { country: "CO", targetingKey: "user-1" } },
      { environment: "production" },
    );
    expect(outside.json()).toMatchObject({ value: false, reason: "DEFAULT" });
  });

  it("rejects rollout percentages with more than two decimals", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/workspaces/storefront/flags/new-checkout/environments/production/rules",
      headers: as("bob"),
      payload: {
        rules: [
          {
            id: "tiny",
            conditions: [{ attribute: "country", operator: "in", values: ["CO"] }],
            serve: true,
            rollout: { percentage: 0.001 },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 404 for an unknown environment", async () => {
    const res = await evaluate({ defaultValue: false }, { environment: "staging" });
    expect(res.statusCode).toBe(404);
  });

  it("hides other workspaces and requires an identity", async () => {
    expect((await evaluate({ defaultValue: false }, { user: "dave" })).statusCode).toBe(404);
    const anonymous = await app.inject({
      method: "POST",
      url: evaluateUrl("storefront", "development", "new-checkout"),
      payload: { defaultValue: false },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("validates the request body", async () => {
    expect((await evaluate({})).statusCode).toBe(400);
    expect((await evaluate({ defaultValue: null })).statusCode).toBe(400);
    expect((await evaluate({ defaultValue: [true] })).statusCode).toBe(400);
    const nested = await evaluate({ defaultValue: false, context: { nested: { a: 1 } } });
    expect(nested.statusCode).toBe(400);
    const tooLong = await evaluate({ defaultValue: false, context: { email: "x".repeat(1001) } });
    expect(tooLong.statusCode).toBe(400);
  });
});
