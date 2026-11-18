import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USER_HEADER } from "../auth.js";
import { demoSeed } from "../seed.js";
import { buildServer } from "../server.js";
import { MemoryStore } from "../store.js";

type App = ReturnType<typeof buildServer>;

const fixedNow = () => new Date("2026-01-05T09:00:00.000Z");
const rulesUrl = (workspace: string, flag: string, environment: string) =>
  `/workspaces/${workspace}/flags/${flag}/environments/${environment}/rules`;

function as(user: string) {
  return { [USER_HEADER]: user };
}

const betaRule = {
  id: "beta-testers",
  description: "Opted into the beta",
  conditions: [{ attribute: "segment", operator: "in", values: ["beta"] }],
  serve: true,
};

const blockRule = {
  id: "blocked",
  conditions: [{ attribute: "country", operator: "in", values: ["NZ"] }],
  serve: false,
};

describe("targeting rules API", () => {
  let app: App;

  beforeEach(async () => {
    app = buildServer({ store: MemoryStore.fromSeed(demoSeed, fixedNow), logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns the seeded rules for an environment", async () => {
    const res = await app.inject({
      method: "GET",
      url: rulesUrl("storefront", "new-checkout", "development"),
      headers: as("carol"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rules.map((r: { id: string }) => r.id)).toEqual(["internal-staff"]);
  });

  it("returns an empty list where no rules were saved", async () => {
    const res = await app.inject({
      method: "GET",
      url: rulesUrl("storefront", "new-checkout", "production"),
      headers: as("carol"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rules: [], updatedAt: null });
  });

  it("replaces the rule list and keeps its order", async () => {
    const put = await app.inject({
      method: "PUT",
      url: rulesUrl("storefront", "new-checkout", "production"),
      headers: as("bob"),
      payload: { rules: [blockRule, betaRule] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().updatedAt).toBe("2026-01-05T09:00:00.000Z");

    const get = await app.inject({
      method: "GET",
      url: rulesUrl("storefront", "new-checkout", "production"),
      headers: as("carol"),
    });
    const rules = get.json().rules as Array<{ id: string; description: string }>;
    expect(rules.map((r) => r.id)).toEqual(["blocked", "beta-testers"]);
    expect(rules[0]?.description).toBe("");
  });

  it("keeps rules separate per environment", async () => {
    await app.inject({
      method: "PUT",
      url: rulesUrl("storefront", "new-checkout", "production"),
      headers: as("alice"),
      payload: { rules: [] },
    });
    const dev = await app.inject({
      method: "GET",
      url: rulesUrl("storefront", "new-checkout", "development"),
      headers: as("alice"),
    });
    expect(dev.json().rules).toHaveLength(1);
  });

  it("does not let a viewer change rules", async () => {
    const res = await app.inject({
      method: "PUT",
      url: rulesUrl("storefront", "new-checkout", "production"),
      headers: as("carol"),
      payload: { rules: [betaRule] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("does not let another workspace read or change rules", async () => {
    for (const method of ["GET", "PUT"] as const) {
      const res = await app.inject({
        method,
        url: rulesUrl("storefront", "new-checkout", "development"),
        headers: as("dave"),
        ...(method === "PUT" ? { payload: { rules: [] } } : {}),
      });
      expect(res.statusCode).toBe(404);
    }
    const own = await app.inject({
      method: "GET",
      url: rulesUrl("storefront", "new-checkout", "development"),
      headers: as("alice"),
    });
    expect(own.json().rules).toHaveLength(1);
  });

  it("returns 404 for an unknown flag or environment", async () => {
    const flag = await app.inject({
      method: "GET",
      url: rulesUrl("storefront", "missing", "production"),
      headers: as("alice"),
    });
    const env = await app.inject({
      method: "GET",
      url: rulesUrl("payments", "new-checkout", "development"),
      headers: as("dave"),
    });
    expect(flag.statusCode).toBe(404);
    expect(env.statusCode).toBe(404);
  });

  it.each([
    ["an unknown operator", { ...betaRule, conditions: [{ ...betaRule.conditions[0], operator: "regex" }] }],
    ["a rule without conditions", { ...betaRule, conditions: [] }],
    ["a condition without values", { ...betaRule, conditions: [{ ...betaRule.conditions[0], values: [] }] }],
    ["a non-boolean serve value", { ...betaRule, serve: "on" }],
  ])("rejects %s", async (_label, rule) => {
    const res = await app.inject({
      method: "PUT",
      url: rulesUrl("storefront", "new-checkout", "production"),
      headers: as("alice"),
      payload: { rules: [rule] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects duplicate rule ids", async () => {
    const res = await app.inject({
      method: "PUT",
      url: rulesUrl("storefront", "new-checkout", "production"),
      headers: as("alice"),
      payload: { rules: [betaRule, { ...blockRule, id: betaRule.id }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("Duplicate rule id");
  });

  it("refuses rule changes on an archived flag", async () => {
    await app.inject({
      method: "PATCH",
      url: "/workspaces/storefront/flags/new-checkout",
      headers: as("alice"),
      payload: { archived: true },
    });
    const res = await app.inject({
      method: "PUT",
      url: rulesUrl("storefront", "new-checkout", "production"),
      headers: as("alice"),
      payload: { rules: [betaRule] },
    });
    expect(res.statusCode).toBe(409);
  });
});
