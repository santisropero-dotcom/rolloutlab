import { describe, expect, it } from "vitest";
import {
  firstMatchingRule,
  matchesCondition,
  matchesRule,
  ruleListProblems,
  type TargetingRule,
} from "./targeting.js";

const staff: TargetingRule = {
  id: "staff",
  description: "Internal staff",
  conditions: [{ attribute: "email", operator: "ends_with", values: ["@rolloutlab.test"] }],
  serve: true,
};

const blockedCountries: TargetingRule = {
  id: "blocked-countries",
  description: "Not launched here yet",
  conditions: [{ attribute: "country", operator: "in", values: ["NZ", "AU"] }],
  serve: false,
};

const proInColombia: TargetingRule = {
  id: "pro-co",
  description: "Pro plan in Colombia",
  conditions: [
    { attribute: "plan", operator: "in", values: ["pro"] },
    { attribute: "country", operator: "in", values: ["CO"] },
  ],
  serve: true,
};

describe("matchesCondition", () => {
  it.each([
    ["in", "CO", ["CO", "MX"], true],
    ["in", "AR", ["CO", "MX"], false],
    ["not_in", "AR", ["CO", "MX"], true],
    ["not_in", "CO", ["CO", "MX"], false],
    ["starts_with", "user-42", ["user-", "svc-"], true],
    ["starts_with", "admin-1", ["user-"], false],
    ["ends_with", "a@rolloutlab.test", ["@rolloutlab.test"], true],
    ["ends_with", "a@example.test", ["@rolloutlab.test"], false],
    ["contains", "beta-tester", ["beta"], true],
    ["contains", "tester", ["beta"], false],
  ] as const)("%s %s against %j is %s", (operator, actual, values, expected) => {
    const condition = { attribute: "x", operator, values: [...values] };
    expect(matchesCondition(condition, { x: actual })).toBe(expected);
  });

  it("compares numbers and booleans as strings", () => {
    expect(matchesCondition({ attribute: "age", operator: "in", values: ["30"] }, { age: 30 })).toBe(
      true,
    );
    expect(
      matchesCondition({ attribute: "beta", operator: "in", values: ["true"] }, { beta: true }),
    ).toBe(true);
  });

  it("never matches a missing or null attribute, even with not_in", () => {
    const condition = { attribute: "country", operator: "not_in" as const, values: ["CO"] };
    expect(matchesCondition(condition, {})).toBe(false);
    expect(matchesCondition(condition, { country: null })).toBe(false);
    expect(matchesCondition(condition, { country: undefined })).toBe(false);
  });

  it("ignores inherited properties", () => {
    const condition = { attribute: "toString", operator: "contains" as const, values: ["function"] };
    expect(matchesCondition(condition, {})).toBe(false);
  });
});

describe("matchesRule", () => {
  it("requires every condition to match", () => {
    expect(matchesRule(proInColombia, { plan: "pro", country: "CO" })).toBe(true);
    expect(matchesRule(proInColombia, { plan: "pro", country: "MX" })).toBe(false);
    expect(matchesRule(proInColombia, { plan: "free", country: "CO" })).toBe(false);
  });
});

describe("firstMatchingRule", () => {
  const rules = [staff, blockedCountries, proInColombia];

  it("returns the first rule that matches", () => {
    const context = { email: "ana@rolloutlab.test", country: "NZ" };
    expect(firstMatchingRule(rules, context)?.id).toBe("staff");
    expect(firstMatchingRule([blockedCountries, staff], context)?.id).toBe("blocked-countries");
  });

  it("returns undefined when nothing matches", () => {
    expect(firstMatchingRule(rules, { country: "MX", plan: "free" })).toBeUndefined();
    expect(firstMatchingRule([], { country: "CO" })).toBeUndefined();
  });
});

describe("ruleListProblems", () => {
  it("accepts unique ids", () => {
    expect(ruleListProblems([staff, blockedCountries])).toEqual([]);
  });

  it("reports duplicate ids", () => {
    expect(ruleListProblems([staff, { ...blockedCountries, id: "staff" }])).toEqual([
      'Duplicate rule id "staff"',
    ]);
  });
});
