import { describe, expect, it } from "vitest";
import { evaluateFlag, type Evaluation, type FlagConfig } from "./evaluation.js";
import type { EvaluationContext, TargetingRule } from "./targeting.js";

/**
 * Bucketing stability and rule order, checked end to end through
 * `evaluateFlag` on a fixed synthetic population.
 *
 * Expected counts were computed with an independent SHA-256 implementation
 * of the bucketing formula, so a change to hashing, scaling or rule order
 * shows up here as a different number.
 */

const COUNTRIES = ["CO", "MX", "NZ", "US"] as const;

// A type alias, not an interface, so it fits EvaluationContext's index signature.
type Shopper = {
  targetingKey: string;
  country: (typeof COUNTRIES)[number];
  email: string;
};

/** 1,000 synthetic shoppers: countries in rotation, every 50th is staff. */
const shoppers: Shopper[] = Array.from({ length: 1000 }, (_, i) => {
  const targetingKey = `synthetic-${String(i).padStart(4, "0")}`;
  return {
    targetingKey,
    country: COUNTRIES[i % COUNTRIES.length]!,
    email: i % 50 === 0 ? `${targetingKey}@rolloutlab.test` : `${targetingKey}@example.test`,
  };
});

function rollout(id: string, percentage: number, serve = true, country?: string): TargetingRule {
  return {
    id,
    description: `${percentage} %${country ? ` of ${country}` : ""}`,
    conditions: country ? [{ attribute: "country", operator: "in", values: [country] }] : [],
    serve,
    rollout: { percentage },
  };
}

const staff: TargetingRule = {
  id: "staff",
  description: "Internal staff",
  conditions: [{ attribute: "email", operator: "ends_with", values: ["@rolloutlab.test"] }],
  serve: true,
};

const blockedInNz: TargetingRule = {
  id: "blocked-nz",
  description: "Not launched in New Zealand",
  conditions: [{ attribute: "country", operator: "in", values: ["NZ"] }],
  serve: false,
};

function config(rules: TargetingRule[]): FlagConfig {
  return {
    key: "new-checkout",
    type: "boolean",
    defaultValue: false,
    salt: "new-checkout",
    archived: false,
    rules,
  };
}

function evaluateAll(flag: FlagConfig, people: readonly EvaluationContext[] = shoppers) {
  return people.map((context) => evaluateFlag("new-checkout", flag, context, false));
}

/** Number of results per `ruleId` (or reason, when no rule decided). */
function tally(results: readonly Evaluation<boolean>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    const key = result.ruleId ?? result.reason;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

const keysWhere = (results: readonly Evaluation<boolean>[], ruleId: string) =>
  new Set(shoppers.filter((_, i) => results[i]!.ruleId === ruleId).map((s) => s.targetingKey));

describe("bucketing stability through evaluateFlag", () => {
  const flag = config([rollout("co-ten", 10, true, "CO")]);

  it("serves a fixed cohort of the matching shoppers", () => {
    expect(tally(evaluateAll(flag))).toEqual({ "co-ten": 23, DEFAULT: 977 });
  });

  it("gives identical results across runs and freshly built configs", () => {
    const first = evaluateAll(flag);
    expect(evaluateAll(flag)).toEqual(first);
    expect(evaluateAll(config([rollout("co-ten", 10, true, "CO")]))).toEqual(first);
  });

  it("ignores attribute order and unrelated attributes", () => {
    const first = evaluateAll(flag);
    const reshaped = shoppers.map(({ targetingKey, country, email }) => ({
      email,
      plan: "pro",
      country,
      targetingKey,
    }));
    expect(evaluateAll(flag, reshaped)).toEqual(first);
  });

  it.each([
    [1, 3],
    [5, 10],
    [10, 23],
    [25, 53],
    [50, 120],
    [100, 250],
  ])("serves %s%% of the 250 Colombian shoppers to %i of them", (percentage, expected) => {
    const results = evaluateAll(config([rollout("co", percentage, true, "CO")]));
    expect(tally(results)["co"]).toBe(expected);
  });

  it("only adds shoppers as the rollout grows", () => {
    let previous = new Set<string>();
    for (const percentage of [0, 1, 5, 10, 25, 50, 100]) {
      const current = keysWhere(evaluateAll(config([rollout("co", percentage, true, "CO")])), "co");
      for (const key of previous) expect(current.has(key)).toBe(true);
      previous = current;
    }
  });
});

describe("rule order", () => {
  it("lets a later rollout serve only the shoppers the earlier one skipped", () => {
    const results = evaluateAll(config([rollout("ten", 10), rollout("half", 50, false)]));
    expect(tally(results)).toEqual({ ten: 104, half: 418, DEFAULT: 478 });
  });

  it("starves a narrower rollout placed after a wider one on the same flag", () => {
    // Both rules bucket on the same flag and salt, so the 10 % cohort is a
    // subset of the 50 % one and the second rule never wins.
    const results = evaluateAll(config([rollout("half", 50, false), rollout("ten", 10)]));
    expect(tally(results)).toEqual({ half: 522, DEFAULT: 478 });
  });

  it("serves staff from a targeting rule placed before a rollout", () => {
    const results = evaluateAll(config([staff, rollout("co-ten", 10, true, "CO")]));
    expect(tally(results)).toEqual({ staff: 20, "co-ten": 22, DEFAULT: 958 });
    for (const result of results.filter((r) => r.ruleId === "staff")) {
      expect(result).toMatchObject({ value: true, reason: "TARGETING_MATCH" });
    }
  });

  it("serves staff inside the cohort from a rollout placed before the staff rule", () => {
    const results = evaluateAll(config([rollout("co-ten", 10, true, "CO"), staff]));
    expect(tally(results)).toEqual({ "co-ten": 23, staff: 19, DEFAULT: 958 });
    for (const result of results.filter((r) => r.ruleId === "co-ten")) {
      expect(result).toMatchObject({ value: true, reason: "SPLIT" });
    }
  });

  it("keeps a blocked country off even under a later 100 % rollout", () => {
    const results = evaluateAll(config([blockedInNz, rollout("everyone", 100)]));
    expect(tally(results)).toEqual({ "blocked-nz": 250, everyone: 750 });
    shoppers.forEach((shopper, i) => {
      expect(results[i]!.value).toBe(shopper.country !== "NZ");
    });
  });

  it("serves the blocked country once the rollout moves above the block", () => {
    const results = evaluateAll(config([rollout("everyone", 100), blockedInNz]));
    expect(tally(results)).toEqual({ everyone: 1000 });
  });
});
