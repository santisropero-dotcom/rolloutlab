import { describe, expect, it } from "vitest";
import { MAX_SNAPSHOT_FLAGS, parseFlagSnapshot } from "./snapshot.js";

const validFlag = {
  key: "new-checkout",
  type: "boolean",
  defaultValue: false,
  salt: "new-checkout",
  rules: [
    {
      id: "staff",
      conditions: [{ attribute: "email", operator: "ends_with", values: ["@rolloutlab.test"] }],
      serve: true,
    },
    { id: "ten-percent", conditions: [], serve: true, rollout: { percentage: 10 } },
  ],
};

function problemsOf(input: unknown): string[] {
  const result = parseFlagSnapshot(input);
  return result.ok ? [] : result.problems;
}

describe("parseFlagSnapshot", () => {
  it("accepts a valid snapshot and fills optional fields", () => {
    const result = parseFlagSnapshot({
      schemaVersion: 1,
      environment: "development",
      flags: [validFlag],
    });
    expect(result).toEqual({
      ok: true,
      snapshot: {
        schemaVersion: 1,
        environment: "development",
        flags: [
          {
            ...validFlag,
            archived: false,
            rules: [
              { ...validFlag.rules[0], description: "" },
              { ...validFlag.rules[1], description: "" },
            ],
          },
        ],
      },
    });
  });

  it("returns a copy that does not share arrays with the input", () => {
    const input = { schemaVersion: 1, environment: "development", flags: [validFlag] };
    const result = parseFlagSnapshot(input);
    if (!result.ok) throw new Error("expected a valid snapshot");
    result.snapshot.flags[0]!.rules[0]!.conditions[0]!.values.push("@other.test");
    expect(validFlag.rules[0]!.conditions[0]!.values).toEqual(["@rolloutlab.test"]);
  });

  it("drops unknown fields", () => {
    const result = parseFlagSnapshot({
      schemaVersion: 1,
      environment: "development",
      flags: [{ ...validFlag, owner: "alice" }],
      exportedBy: "someone",
    });
    expect(result.ok && result.snapshot).toEqual({
      schemaVersion: 1,
      environment: "development",
      flags: [expect.not.objectContaining({ owner: "alice" })],
    });
  });

  it.each([[null], [[]], ["{}"], [42]])("rejects %j", (input) => {
    expect(problemsOf(input)).toEqual(["Snapshot must be a JSON object"]);
  });

  it("rejects other schema versions and a missing environment", () => {
    expect(problemsOf({ schemaVersion: 2, flags: [] })).toEqual([
      "schemaVersion must be 1",
      "environment must be a non-empty string",
    ]);
  });

  it("reports every broken field instead of stopping at the first", () => {
    const problems = problemsOf({
      schemaVersion: 1,
      environment: "development",
      flags: [
        { key: "a", type: "string", defaultValue: "on", salt: "", rules: [] },
        {
          key: "b",
          type: "boolean",
          defaultValue: true,
          salt: "b",
          rules: [
            { id: "r1", conditions: [{ attribute: "plan", operator: "equals", values: [] }], serve: 1 },
            { id: "r2", conditions: [], serve: true, rollout: { percentage: 12.345 } },
          ],
        },
      ],
    });
    expect(problems).toEqual([
      'flag "a": type must be "boolean"',
      'flag "a": defaultValue must be a boolean',
      'flag "a": salt must be a non-empty string',
      'flag "b" rule 0: serve must be a boolean',
      'flag "b" rule 0 condition 0: operator must be one of in, not_in, starts_with, ends_with, contains',
      'flag "b" rule 0 condition 0: values must be 1-100 strings',
      'flag "b": Rule "r2": Percentage can have at most two decimals',
    ]);
  });

  it("rejects duplicate flag keys and duplicate rule ids", () => {
    const duplicateRules = {
      ...validFlag,
      key: "other",
      rules: [validFlag.rules[0], validFlag.rules[0]],
    };
    expect(
      problemsOf({
        schemaVersion: 1,
        environment: "development",
        flags: [validFlag, validFlag, duplicateRules],
      }),
    ).toEqual(['Duplicate flag key "new-checkout"', 'flag "other": Duplicate rule id "staff"']);
  });

  it("rejects rollouts that are not objects with a numeric percentage", () => {
    const flag = { ...validFlag, rules: [{ id: "r", conditions: [], serve: true, rollout: 10 }] };
    expect(problemsOf({ schemaVersion: 1, environment: "development", flags: [flag] })).toEqual([
      'flag "new-checkout" rule 0: rollout must be { "percentage": number }',
    ]);
  });

  it("limits the number of flags", () => {
    const flags = Array.from({ length: MAX_SNAPSHOT_FLAGS + 1 }, (_, i) => ({
      ...validFlag,
      key: `flag-${i}`,
    }));
    expect(problemsOf({ schemaVersion: 1, environment: "development", flags })).toEqual([
      `flags must be a list of at most ${MAX_SNAPSHOT_FLAGS}`,
    ]);
  });
});
