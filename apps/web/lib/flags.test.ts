import { readFileSync } from "node:fs";
import { ErrorCode, type EvaluationDetails } from "@openfeature/server-sdk";
import type { FlagConfig } from "@rolloutlab/evaluator";
import { describe, expect, it } from "vitest";
import { checkoutButtonLabel } from "./checkout";
import {
  DEFAULT_SHOPPER_ID,
  MAX_SNAPSHOT_BYTES,
  NEW_CHECKOUT,
  explainEvaluation,
  flagDefinitions,
  readSnapshot,
  shopperContext,
} from "./flags";

const bundledSnapshot = readFileSync(new URL("../flags/development.json", import.meta.url), "utf8");

describe("new-checkout flag", () => {
  it("is off by default in code", () => {
    expect(NEW_CHECKOUT.defaultValue).toBe(false);
  });

  it("every defined flag defaults to off and keys are unique", () => {
    const keys = new Set(flagDefinitions.map((flag) => flag.key));
    expect(keys.size).toBe(flagDefinitions.length);
    for (const flag of flagDefinitions) {
      expect(flag.defaultValue).toBe(false);
    }
  });
});

describe("readSnapshot", () => {
  it("accepts the bundled development snapshot", () => {
    const load = readSnapshot(bundledSnapshot);
    expect(load.problems).toEqual([]);
    expect(load.snapshot.environment).toBe("development");
    const flag = load.snapshot.flags.find((candidate) => candidate.key === NEW_CHECKOUT.key);
    expect(flag?.defaultValue).toBe(false);
    expect(flag?.rules.map((rule) => rule.id)).toEqual(["internal-staff", "ten-percent"]);
  });

  it("returns an empty snapshot when the file is missing", () => {
    const load = readSnapshot(undefined);
    expect(load.snapshot.flags).toEqual([]);
    expect(load.snapshot.environment).toBe("unavailable");
    expect(load.problems).toEqual(["Snapshot file could not be read"]);
  });

  it("rejects invalid JSON", () => {
    expect(readSnapshot("{not json").problems).toEqual(["Snapshot is not valid JSON"]);
  });

  it("rejects oversized files before parsing", () => {
    const load = readSnapshot(" ".repeat(MAX_SNAPSHOT_BYTES + 1));
    expect(load.problems[0]).toMatch(/larger than/);
    expect(load.snapshot.flags).toEqual([]);
  });

  it("reports schema problems instead of using a half-valid snapshot", () => {
    const load = readSnapshot(
      JSON.stringify({
        schemaVersion: 1,
        environment: "development",
        flags: [{ key: "new-checkout", type: "boolean", defaultValue: "yes", salt: "s", rules: [] }],
      }),
    );
    expect(load.snapshot.flags).toEqual([]);
    expect(load.problems).toContain('flag "new-checkout": defaultValue must be a boolean');
  });
});

describe("shopperContext", () => {
  it("uses the default shopper when none is given", () => {
    expect(shopperContext({})).toEqual({ targetingKey: DEFAULT_SHOPPER_ID });
  });

  it("takes the shopper id and a lower-cased email", () => {
    expect(shopperContext({ shopper: " shopper-0013 ", email: "Ana@RolloutLab.test" })).toEqual({
      targetingKey: "shopper-0013",
      email: "ana@rolloutlab.test",
    });
  });

  it("uses the first value of repeated parameters", () => {
    expect(shopperContext({ shopper: ["shopper-0002", "shopper-0003"] }).targetingKey).toBe(
      "shopper-0002",
    );
  });

  it("falls back for invalid shopper ids and drops invalid emails", () => {
    expect(shopperContext({ shopper: "a b", email: "not-an-email" })).toEqual({
      targetingKey: DEFAULT_SHOPPER_ID,
    });
    expect(shopperContext({ shopper: "x".repeat(65) }).targetingKey).toBe(DEFAULT_SHOPPER_ID);
    expect(shopperContext({ shopper: "line\nbreak" }).targetingKey).toBe(DEFAULT_SHOPPER_ID);
  });
});

describe("explainEvaluation", () => {
  const flag: FlagConfig = {
    key: "new-checkout",
    type: "boolean",
    defaultValue: false,
    salt: "new-checkout",
    archived: false,
    rules: [
      {
        id: "internal-staff",
        description: "Staff try the new checkout first.",
        conditions: [{ attribute: "email", operator: "ends_with", values: ["@rolloutlab.test"] }],
        serve: true,
      },
      {
        id: "ten-percent",
        description: "",
        conditions: [],
        serve: true,
        rollout: { percentage: 10 },
      },
    ],
  };

  function details(overrides: Partial<EvaluationDetails<boolean>>): EvaluationDetails<boolean> {
    return { flagKey: "new-checkout", value: false, flagMetadata: {}, ...overrides };
  }

  it("names the matching rule and its description", () => {
    const explanation = explainEvaluation(
      details({ value: true, reason: "TARGETING_MATCH", flagMetadata: { ruleId: "internal-staff" } }),
      flag,
      "development",
    );
    expect(explanation).toEqual({
      flagKey: "new-checkout",
      value: true,
      reason: "TARGETING_MATCH",
      environment: "development",
      ruleId: "internal-staff",
      summary:
        'Rule "internal-staff" matched this shopper and serves on. Staff try the new checkout first.',
    });
  });

  it("gives the rollout percentage for splits", () => {
    const explanation = explainEvaluation(
      details({ value: true, reason: "SPLIT", flagMetadata: { ruleId: "ten-percent" } }),
      flag,
      "development",
    );
    expect(explanation.summary).toBe(
      'This shopper is inside the 10% rollout of rule "ten-percent", which serves on.',
    );
  });

  it("still explains a split when the rule is not in the snapshot", () => {
    const explanation = explainEvaluation(
      details({ value: true, reason: "SPLIT", flagMetadata: { ruleId: "gone" } }),
      undefined,
      "development",
    );
    expect(explanation.summary).toBe('This shopper is inside the rollout of rule "gone", which serves on.');
  });

  it("explains defaults, archived flags and errors", () => {
    expect(explainEvaluation(details({ reason: "DEFAULT" }), flag, "development").summary).toBe(
      "No rule served this shopper, so the flag's default (off) applies.",
    );
    expect(explainEvaluation(details({ reason: "DISABLED" }), flag, "development").summary).toMatch(
      /archived/,
    );
    const error = explainEvaluation(
      details({ reason: "ERROR", errorCode: ErrorCode.FLAG_NOT_FOUND }),
      undefined,
      "unavailable",
    );
    expect(error.errorCode).toBe("FLAG_NOT_FOUND");
    expect(error.ruleId).toBeUndefined();
    expect(error.summary).toBe(
      "The flag could not be evaluated (FLAG_NOT_FOUND), so the storefront keeps its own default (off).",
    );
  });

  it("ignores a non-string ruleId in the metadata", () => {
    const explanation = explainEvaluation(
      details({ reason: "DEFAULT", flagMetadata: { ruleId: 3 } }),
      flag,
      "development",
    );
    expect(explanation.ruleId).toBeUndefined();
  });
});

describe("checkout button", () => {
  const totals = { itemCount: 2, subtotalCents: 2800, shippingCents: 499, totalCents: 3299 };

  it("keeps the current checkout when the flag is off", () => {
    expect(checkoutButtonLabel(totals, false)).toBe("Checkout (2 items)");
    expect(checkoutButtonLabel({ ...totals, itemCount: 1 }, false)).toBe("Checkout (1 item)");
  });

  it("shows the amount to pay when the flag is on", () => {
    expect(checkoutButtonLabel(totals, true)).toBe("Pay $32.99 now");
  });
});
