import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USER_HEADER } from "../auth.js";
import { demoSeed } from "../seed.js";
import { buildServer } from "../server.js";
import { MemoryStore } from "../store.js";

type App = ReturnType<typeof buildServer>;

const fixedNow = () => new Date("2026-01-12T10:00:00.000Z");
const versionsUrl = (workspace: string, flag: string, environment: string) =>
  `/workspaces/${workspace}/flags/${flag}/environments/${environment}/rollout/versions`;
const storefrontProduction = versionsUrl("storefront", "new-checkout", "production");

function as(user: string) {
  return { [USER_HEADER]: user };
}

const widerPlan = {
  serve: true,
  stages: [{ percentage: 5 }, { percentage: 25 }, { percentage: 100 }],
  note: "Smaller canary after review.",
  baseVersion: 1,
};

describe("rollout versions API", () => {
  let app: App;

  beforeEach(async () => {
    app = buildServer({ store: MemoryStore.fromSeed(demoSeed, fixedNow), logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("lists the seeded version", async () => {
    const res = await app.inject({ method: "GET", url: storefrontProduction, headers: as("carol") });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.latestVersion).toBe(1);
    expect(body.items[0]).toMatchObject({
      version: 1,
      serve: true,
      stages: [{ percentage: 10 }, { percentage: 50 }, { percentage: 100 }],
      salt: "new-checkout",
      createdBy: "alice",
    });
  });

  it("returns an empty list where no rollout was planned", async () => {
    const res = await app.inject({
      method: "GET",
      url: versionsUrl("storefront", "new-checkout", "development"),
      headers: as("carol"),
    });
    expect(res.json()).toEqual({ items: [], latestVersion: 0 });
  });

  it("adds a new version and keeps the old one unchanged", async () => {
    const post = await app.inject({
      method: "POST",
      url: storefrontProduction,
      headers: as("bob"),
      payload: widerPlan,
    });
    expect(post.statusCode).toBe(201);
    expect(post.json()).toMatchObject({
      version: 2,
      stages: widerPlan.stages,
      note: widerPlan.note,
      createdBy: "bob",
      createdAt: "2026-01-12T10:00:00.000Z",
    });

    const first = await app.inject({
      method: "GET",
      url: `${storefrontProduction}/1`,
      headers: as("carol"),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().stages.map((s: { percentage: number }) => s.percentage)).toEqual([
      10, 50, 100,
    ]);

    const list = await app.inject({ method: "GET", url: storefrontProduction, headers: as("carol") });
    expect(list.json().items.map((v: { version: number }) => v.version)).toEqual([1, 2]);
  });

  it("refuses a version based on a stale plan", async () => {
    const res = await app.inject({
      method: "POST",
      url: storefrontProduction,
      headers: as("alice"),
      payload: { ...widerPlan, baseVersion: 0 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain("version 1, not 0");
  });

  it("refuses the second of two versions written against the same base", async () => {
    const first = await app.inject({
      method: "POST",
      url: storefrontProduction,
      headers: as("alice"),
      payload: widerPlan,
    });
    const second = await app.inject({
      method: "POST",
      url: storefrontProduction,
      headers: as("bob"),
      payload: widerPlan,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
  });

  it("records the salt in force when the version was written", async () => {
    await app.inject({
      method: "PATCH",
      url: "/workspaces/storefront/flags/new-checkout",
      headers: as("alice"),
      payload: { salt: "reshuffle-1" },
    });
    const post = await app.inject({
      method: "POST",
      url: storefrontProduction,
      headers: as("alice"),
      payload: widerPlan,
    });
    expect(post.json().salt).toBe("reshuffle-1");
    const first = await app.inject({
      method: "GET",
      url: `${storefrontProduction}/1`,
      headers: as("alice"),
    });
    expect(first.json().salt).toBe("new-checkout");
  });

  it.each([
    ["decreasing stages", { stages: [{ percentage: 50 }, { percentage: 10 }, { percentage: 100 }] }],
    ["a plan that never reaches 100 %", { stages: [{ percentage: 10 }, { percentage: 50 }] }],
    ["a zero stage", { stages: [{ percentage: 0 }, { percentage: 100 }] }],
    ["no stages", { stages: [] }],
    ["a non-boolean serve value", { serve: "on" }],
    ["a missing base version", { baseVersion: undefined }],
  ])("rejects %s", async (_label, change) => {
    const res = await app.inject({
      method: "POST",
      url: storefrontProduction,
      headers: as("alice"),
      payload: { ...widerPlan, ...change },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("does not let a viewer add a version", async () => {
    const res = await app.inject({
      method: "POST",
      url: storefrontProduction,
      headers: as("carol"),
      payload: widerPlan,
    });
    expect(res.statusCode).toBe(403);
  });

  it("does not let another workspace read or add versions", async () => {
    const read = await app.inject({ method: "GET", url: storefrontProduction, headers: as("dave") });
    const write = await app.inject({
      method: "POST",
      url: storefrontProduction,
      headers: as("dave"),
      payload: widerPlan,
    });
    expect(read.statusCode).toBe(404);
    expect(write.statusCode).toBe(404);

    const payments = await app.inject({
      method: "GET",
      url: versionsUrl("payments", "new-checkout", "production"),
      headers: as("dave"),
    });
    expect(payments.json()).toEqual({ items: [], latestVersion: 0 });
  });

  it("returns 404 for an unknown version, flag or environment", async () => {
    const urls = [
      `${storefrontProduction}/9`,
      versionsUrl("storefront", "missing", "production"),
      versionsUrl("storefront", "new-checkout", "staging"),
    ];
    for (const url of urls) {
      const res = await app.inject({ method: "GET", url, headers: as("alice") });
      expect(res.statusCode).toBe(404);
    }
  });

  it("refuses new versions on an archived flag", async () => {
    await app.inject({
      method: "PATCH",
      url: "/workspaces/storefront/flags/new-checkout",
      headers: as("alice"),
      payload: { archived: true },
    });
    const res = await app.inject({
      method: "POST",
      url: storefrontProduction,
      headers: as("alice"),
      payload: widerPlan,
    });
    expect(res.statusCode).toBe(409);
  });
});
