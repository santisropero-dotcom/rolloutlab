/**
 * Targeting rules: ordered, per-environment conditions that pick a value for
 * the identities they match.
 *
 * A rule matches when every condition matches (AND). A condition matches when
 * the context attribute equals, or relates to, any of its values (OR). Values
 * are compared as strings, so `plan: "pro"` and `age: 30` are handled alike.
 */

export const OPERATORS = ["in", "not_in", "starts_with", "ends_with", "contains"] as const;
export type Operator = (typeof OPERATORS)[number];

export const MAX_RULES = 50;
export const MAX_CONDITIONS = 10;
export const MAX_VALUES = 100;

export interface Condition {
  attribute: string;
  operator: Operator;
  values: string[];
}

export interface TargetingRule {
  id: string;
  description: string;
  conditions: Condition[];
  serve: boolean;
}

export interface FlagTargeting {
  workspaceId: string;
  flagKey: string;
  environmentKey: string;
  rules: TargetingRule[];
  updatedAt: string | null;
}

/** Attributes describing the identity a flag is evaluated for. */
export type EvaluationContext = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

function attributeValue(context: EvaluationContext, attribute: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(context, attribute)) return undefined;
  const value = context[attribute];
  if (value === undefined || value === null) return undefined;
  return String(value);
}

/**
 * A missing attribute never matches, not even `not_in`: a rule should not
 * catch identities that simply did not send the attribute.
 */
export function matchesCondition(condition: Condition, context: EvaluationContext): boolean {
  const actual = attributeValue(context, condition.attribute);
  if (actual === undefined) return false;
  switch (condition.operator) {
    case "in":
      return condition.values.includes(actual);
    case "not_in":
      return !condition.values.includes(actual);
    case "starts_with":
      return condition.values.some((v) => actual.startsWith(v));
    case "ends_with":
      return condition.values.some((v) => actual.endsWith(v));
    case "contains":
      return condition.values.some((v) => actual.includes(v));
  }
}

export function matchesRule(rule: TargetingRule, context: EvaluationContext): boolean {
  return rule.conditions.every((condition) => matchesCondition(condition, context));
}

/** Rules are checked top to bottom; the first match wins. */
export function firstMatchingRule(
  rules: readonly TargetingRule[],
  context: EvaluationContext,
): TargetingRule | undefined {
  return rules.find((rule) => matchesRule(rule, context));
}

/** Problems a JSON schema cannot express; an empty list means the rules are valid. */
export function ruleListProblems(rules: readonly TargetingRule[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) problems.push(`Duplicate rule id "${rule.id}"`);
    seen.add(rule.id);
  }
  return problems;
}
