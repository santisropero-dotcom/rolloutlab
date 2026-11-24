import type { FlagConfig } from "./evaluation.js";
import {
  MAX_CONDITIONS,
  MAX_RULES,
  MAX_VALUES,
  OPERATORS,
  ruleListProblems,
  type Condition,
  type Operator,
  type TargetingRule,
} from "./targeting.js";

/**
 * Flag snapshots: every flag of one environment in a single JSON document,
 * so a process can evaluate flags locally without asking the API each time.
 *
 * Snapshots are read from files or the network, so they are treated as
 * untrusted input: `parseFlagSnapshot` checks every field and reports all
 * problems instead of handing a half-valid configuration to the evaluator.
 */

export const SNAPSHOT_SCHEMA_VERSION = 1;

export const MAX_SNAPSHOT_FLAGS = 500;

const MAX_KEY_LENGTH = 64;

export interface FlagSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  environment: string;
  flags: FlagConfig[];
}

export type SnapshotParseResult =
  | { ok: true; snapshot: FlagSnapshot }
  | { ok: false; problems: string[] };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_KEY_LENGTH &&
    !value.includes("\n")
  );
}

function parseCondition(input: unknown, where: string, problems: string[]): Condition | undefined {
  if (!isObject(input)) {
    problems.push(`${where}: condition must be an object`);
    return undefined;
  }
  const { attribute, operator, values } = input;
  let valid = true;
  if (!isKey(attribute)) {
    problems.push(`${where}: attribute must be a non-empty string`);
    valid = false;
  }
  if (typeof operator !== "string" || !(OPERATORS as readonly string[]).includes(operator)) {
    problems.push(`${where}: operator must be one of ${OPERATORS.join(", ")}`);
    valid = false;
  }
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > MAX_VALUES ||
    !values.every((v) => typeof v === "string")
  ) {
    problems.push(`${where}: values must be 1-${MAX_VALUES} strings`);
    valid = false;
  }
  if (!valid) return undefined;
  return {
    attribute: attribute as string,
    operator: operator as Operator,
    values: [...(values as string[])],
  };
}

function parseRule(input: unknown, where: string, problems: string[]): TargetingRule | undefined {
  if (!isObject(input)) {
    problems.push(`${where}: rule must be an object`);
    return undefined;
  }
  const { id, description, conditions, serve, rollout } = input;
  const before = problems.length;
  if (!isKey(id)) problems.push(`${where}: id must be a non-empty string`);
  if (description !== undefined && typeof description !== "string") {
    problems.push(`${where}: description must be a string`);
  }
  if (typeof serve !== "boolean") problems.push(`${where}: serve must be a boolean`);
  if (rollout !== undefined && !(isObject(rollout) && typeof rollout.percentage === "number")) {
    problems.push(`${where}: rollout must be { "percentage": number }`);
  }
  const parsedConditions: Condition[] = [];
  if (!Array.isArray(conditions) || conditions.length > MAX_CONDITIONS) {
    problems.push(`${where}: conditions must be a list of at most ${MAX_CONDITIONS}`);
  } else {
    conditions.forEach((condition, index) => {
      const parsed = parseCondition(condition, `${where} condition ${index}`, problems);
      if (parsed) parsedConditions.push(parsed);
    });
  }
  if (problems.length > before) return undefined;
  return {
    id: id as string,
    description: (description as string | undefined) ?? "",
    conditions: parsedConditions,
    serve: serve as boolean,
    ...(isObject(rollout) && { rollout: { percentage: rollout.percentage as number } }),
  };
}

function parseFlag(input: unknown, where: string, problems: string[]): FlagConfig | undefined {
  if (!isObject(input)) {
    problems.push(`${where}: flag must be an object`);
    return undefined;
  }
  const { key, type, defaultValue, salt, archived, rules } = input;
  const label = isKey(key) ? `flag "${key}"` : where;
  const before = problems.length;
  if (!isKey(key)) problems.push(`${where}: key must be a non-empty string`);
  if (type !== "boolean") problems.push(`${label}: type must be "boolean"`);
  if (typeof defaultValue !== "boolean") problems.push(`${label}: defaultValue must be a boolean`);
  if (!isKey(salt)) problems.push(`${label}: salt must be a non-empty string`);
  if (archived !== undefined && typeof archived !== "boolean") {
    problems.push(`${label}: archived must be a boolean`);
  }
  const parsedRules: TargetingRule[] = [];
  if (!Array.isArray(rules) || rules.length > MAX_RULES) {
    problems.push(`${label}: rules must be a list of at most ${MAX_RULES}`);
  } else {
    rules.forEach((rule, index) => {
      const parsed = parseRule(rule, `${label} rule ${index}`, problems);
      if (parsed) parsedRules.push(parsed);
    });
    for (const problem of ruleListProblems(parsedRules)) problems.push(`${label}: ${problem}`);
  }
  if (problems.length > before) return undefined;
  return {
    key: key as string,
    type: "boolean",
    defaultValue: defaultValue as boolean,
    salt: salt as string,
    archived: (archived as boolean | undefined) ?? false,
    rules: parsedRules,
  };
}

/** Checks an untrusted value (e.g. parsed JSON) and returns a clean copy. */
export function parseFlagSnapshot(input: unknown): SnapshotParseResult {
  if (!isObject(input)) return { ok: false, problems: ["Snapshot must be a JSON object"] };
  const problems: string[] = [];
  if (input.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (!isKey(input.environment)) problems.push("environment must be a non-empty string");

  const flags: FlagConfig[] = [];
  if (!Array.isArray(input.flags) || input.flags.length > MAX_SNAPSHOT_FLAGS) {
    problems.push(`flags must be a list of at most ${MAX_SNAPSHOT_FLAGS}`);
  } else {
    const seen = new Set<string>();
    input.flags.forEach((flag, index) => {
      const parsed = parseFlag(flag, `flag ${index}`, problems);
      if (!parsed) return;
      if (seen.has(parsed.key)) problems.push(`Duplicate flag key "${parsed.key}"`);
      seen.add(parsed.key);
      flags.push(parsed);
    });
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    snapshot: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      environment: input.environment as string,
      flags,
    },
  };
}
