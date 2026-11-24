import { BucketingError, bucketFor, isInRollout } from "./bucketing.js";
import { matchesRule, type EvaluationContext, type TargetingRule } from "./targeting.js";

/**
 * Flag evaluation: rules, percentage rollouts and defaults combined into one
 * value with a reason.
 *
 * Every call carries a typed default from the calling code. Whenever the flag
 * can't be evaluated (unknown flag, wrong type, bad context) the caller gets
 * that default back with `reason: "ERROR"` and an error code, never an
 * exception and never a value of the wrong type. Reasons and error codes use
 * the OpenFeature names so a provider can pass them through unchanged.
 */

export type FlagValueType = "boolean" | "string" | "number";

export type FlagValue = boolean | string | number;

export type EvaluationReason = "TARGETING_MATCH" | "SPLIT" | "DEFAULT" | "DISABLED" | "ERROR";

export type EvaluationErrorCode = "FLAG_NOT_FOUND" | "TYPE_MISMATCH" | "INVALID_CONTEXT";

/** Context attribute holding the identity's subject key, as in OpenFeature. */
export const TARGETING_KEY = "targetingKey";

/** Everything the evaluator needs for one flag in one environment. */
export interface FlagConfig {
  key: string;
  type: "boolean";
  defaultValue: boolean;
  salt: string;
  archived: boolean;
  rules: readonly TargetingRule[];
}

export interface Evaluation<T extends FlagValue> {
  flagKey: string;
  value: T;
  reason: EvaluationReason;
  /** Id of the rule that decided the value, for TARGETING_MATCH and SPLIT. */
  ruleId?: string;
  errorCode?: EvaluationErrorCode;
  errorMessage?: string;
}

export function valueTypeOf(value: unknown): FlagValueType | undefined {
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    case "number":
      return Number.isFinite(value) ? "number" : undefined;
    default:
      return undefined;
  }
}

function subjectKeyOf(context: EvaluationContext): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(context, TARGETING_KEY)) return undefined;
  const value = context[TARGETING_KEY];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Evaluates `config` for `context`, falling back to `callerDefault`.
 *
 * Order: unknown flag → type check → archived → rules top to bottom → the
 * flag's own default. A rule with a rollout only serves the identities whose
 * bucket is inside the percentage; everyone else, and anyone without a
 * `targetingKey`, moves on to the next rule.
 */
export function evaluateFlag<T extends FlagValue>(
  flagKey: string,
  config: FlagConfig | undefined,
  context: EvaluationContext,
  callerDefault: T,
): Evaluation<T> {
  const fallback = (
    reason: EvaluationReason,
    errorCode?: EvaluationErrorCode,
    errorMessage?: string,
  ): Evaluation<T> => ({
    flagKey,
    value: callerDefault,
    reason,
    ...(errorCode && { errorCode, errorMessage }),
  });

  const expected = valueTypeOf(callerDefault);
  if (expected === undefined) {
    return fallback(
      "ERROR",
      "TYPE_MISMATCH",
      "Default value must be a boolean, string or finite number",
    );
  }
  if (!config) {
    return fallback("ERROR", "FLAG_NOT_FOUND", `Flag "${flagKey}" not found`);
  }
  if (config.type !== expected) {
    return fallback(
      "ERROR",
      "TYPE_MISMATCH",
      `Flag "${flagKey}" is ${config.type}, but a ${expected} default was given`,
    );
  }
  if (config.archived) return fallback("DISABLED");

  // From here on the flag and the caller agree on the type.
  const typed = (value: FlagValue) => value as T;
  const subjectKey = subjectKeyOf(context);

  for (const rule of config.rules) {
    if (!matchesRule(rule, context)) continue;
    if (!rule.rollout) {
      return { flagKey, value: typed(rule.serve), reason: "TARGETING_MATCH", ruleId: rule.id };
    }
    if (subjectKey === undefined) continue;
    let bucket: number;
    try {
      bucket = bucketFor({ flagKey: config.key, salt: config.salt, subjectKey });
    } catch (error) {
      if (error instanceof BucketingError) {
        return fallback("ERROR", "INVALID_CONTEXT", error.message);
      }
      throw error;
    }
    if (isInRollout(bucket, rule.rollout.percentage)) {
      return { flagKey, value: typed(rule.serve), reason: "SPLIT", ruleId: rule.id };
    }
  }

  return { flagKey, value: typed(config.defaultValue), reason: "DEFAULT" };
}
