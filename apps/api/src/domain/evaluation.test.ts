import { describe, expect, it } from "vitest";
import { evaluateFlag, valueTypeOf, type FlagConfig } from "./evaluation.js";
import type { TargetingRule } from "./targeting.js";

const staff: TargetingRule = {
  id: "staff",
  description: "Internal staff",
  conditions: [{ attribute: "email", operator: "ends_with", values: ["@rolloutlab.test"] }],
  serve: true,
};

const blocked: TargetingRule = {
  id: "blocked",
  description: "Not launched here yet",
  conditions: [{ attribute: "country", operator: "in", values: ["NZ"] }],
  serve: false,
};

const tenPercentInColombia: TargetingRule = {
  id: "co-ten-percent",
  description: "10 % of Colombian shoppers",
  conditions: [{ attribute: "country", operator: "in", values: ["CO"] }],
  serve: true,
  rollout: { percentage: 10 },
};

function config(overrides: Partial<FlagConfig> = {}): FlagConfig {
  return {
    key: "new-checkout",
    type: "boolean",
    defaultValue: false,
    salt: "new-checkout",
    archived: false,
    rules: [],
    ...overrides,
  };
}

// Buckets for salt "new-checkout", cross-checked with an independent SHA-256
// implementation: user-4 → 628 (inside 10 %), user-1 → 9287 (outside).
const INSIDE = "user-4";
const OUTSIDE = "user-1";

describe("valueTypeOf", () => {
  it.each([
    [true, "boolean"],
    ["on", "string"],
    [3, "number"],
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined],
    [null, undefined],
    [{}, undefined],
  ])("%j is %s", (value, expected) => {
    expect(valueTypeOf(value)).toBe(expected);
  });
});

describe("evaluateFlag", () => {
  it("serves the flag default when no rule matches", () => {
    const result = evaluateFlag("new-checkout", config({ defaultValue: true }), {}, false);
    expect(result).toEqual({ flagKey: "new-checkout", value: true, reason: "DEFAULT" });
  });

  it("serves the first matching rule", () => {
    const result = evaluateFlag(
      "new-checkout",
      config({ rules: [blocked, staff] }),
      { email: "a@rolloutlab.test", country: "NZ" },
      true,
    );
    expect(result).toMatchObject({ value: false, reason: "TARGETING_MATCH", ruleId: "blocked" });
  });

  it("serves a rollout rule only to identities inside the percentage", () => {
    const flag = config({ rules: [tenPercentInColombia] });
    expect(
      evaluateFlag("new-checkout", flag, { country: "CO", targetingKey: INSIDE }, false),
    ).toMatchObject({ value: true, reason: "SPLIT", ruleId: "co-ten-percent" });
    expect(
      evaluateFlag("new-checkout", flag, { country: "CO", targetingKey: OUTSIDE }, false),
    ).toMatchObject({ value: false, reason: "DEFAULT" });
  });

  it("lets identities outside a rollout fall through to later rules", () => {
    const flag = config({ rules: [tenPercentInColombia, { ...staff, id: "staff-later" }] });
    const result = evaluateFlag(
      "new-checkout",
      flag,
      { country: "CO", email: "b@rolloutlab.test", targetingKey: OUTSIDE },
      false,
    );
    expect(result).toMatchObject({
      value: true,
      reason: "TARGETING_MATCH",
      ruleId: "staff-later",
    });
  });

  it("skips rollout rules for identities without a targeting key", () => {
    const flag = config({ rules: [tenPercentInColombia] });
    expect(evaluateFlag("new-checkout", flag, { country: "CO" }, false)).toMatchObject({
      value: false,
      reason: "DEFAULT",
    });
    expect(
      evaluateFlag("new-checkout", flag, { country: "CO", targetingKey: 4 }, false),
    ).toMatchObject({ reason: "DEFAULT" });
  });

  it("returns the caller default with INVALID_CONTEXT for an unusable targeting key", () => {
    const flag = config({ defaultValue: true, rules: [tenPercentInColombia] });
    const result = evaluateFlag(
      "new-checkout",
      flag,
      { country: "CO", targetingKey: "x".repeat(257) },
      false,
    );
    expect(result).toMatchObject({ value: false, reason: "ERROR", errorCode: "INVALID_CONTEXT" });
  });

  it("returns the caller default for an unknown flag", () => {
    expect(evaluateFlag("missing", undefined, {}, true)).toEqual({
      flagKey: "missing",
      value: true,
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
      errorMessage: 'Flag "missing" not found',
    });
  });

  it("returns the caller default when the default has a different type", () => {
    const flag = config({ defaultValue: true, rules: [staff] });
    const context = { email: "a@rolloutlab.test" };
    expect(evaluateFlag("new-checkout", flag, context, "classic")).toMatchObject({
      value: "classic",
      reason: "ERROR",
      errorCode: "TYPE_MISMATCH",
    });
    expect(evaluateFlag("new-checkout", flag, context, 0)).toMatchObject({
      value: 0,
      errorCode: "TYPE_MISMATCH",
    });
  });

  it("rejects defaults that are not a usable value", () => {
    const result = evaluateFlag("new-checkout", config(), {}, Number.NaN);
    expect(result.reason).toBe("ERROR");
    expect(result.errorCode).toBe("TYPE_MISMATCH");
    expect(result.value).toBeNaN();
  });

  it("serves the caller default for an archived flag, ignoring its rules", () => {
    const flag = config({ archived: true, defaultValue: true, rules: [staff] });
    expect(evaluateFlag("new-checkout", flag, { email: "a@rolloutlab.test" }, false)).toEqual({
      flagKey: "new-checkout",
      value: false,
      reason: "DISABLED",
    });
  });

  it("gives the same result on every call", () => {
    const flag = config({ rules: [tenPercentInColombia] });
    const context = { country: "CO", targetingKey: INSIDE };
    const first = evaluateFlag("new-checkout", flag, context, false);
    for (let i = 0; i < 20; i += 1) {
      expect(evaluateFlag("new-checkout", flag, context, false)).toEqual(first);
    }
  });
});
