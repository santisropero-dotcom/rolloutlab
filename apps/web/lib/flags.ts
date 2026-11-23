import type { EvaluationDetails } from "@openfeature/server-sdk";
import {
  SNAPSHOT_SCHEMA_VERSION,
  parseFlagSnapshot,
  type FlagConfig,
  type FlagSnapshot,
} from "@rolloutlab/evaluator";

/**
 * Flags of the sample storefront.
 *
 * Flags are evaluated locally from a snapshot file through the RolloutLab
 * OpenFeature provider. Every flag has a default in code that keeps today's
 * behaviour, so a missing or broken snapshot can never switch a feature on:
 * the storefront falls back to that default and shows why.
 */

export interface BooleanFlagDefinition {
  key: string;
  description: string;
  defaultValue: boolean;
}

export const NEW_CHECKOUT: BooleanFlagDefinition = {
  key: "new-checkout",
  description: "One-step checkout that shows the amount to pay on the button.",
  defaultValue: false,
};

export const flagDefinitions: readonly BooleanFlagDefinition[] = [NEW_CHECKOUT];

/** Snapshots larger than this are rejected before parsing. */
export const MAX_SNAPSHOT_BYTES = 1_000_000;

export interface SnapshotLoad {
  snapshot: FlagSnapshot;
  /** Empty when the snapshot was read and validated. */
  problems: string[];
}

function unavailable(problems: string[]): SnapshotLoad {
  return {
    snapshot: { schemaVersion: SNAPSHOT_SCHEMA_VERSION, environment: "unavailable", flags: [] },
    problems,
  };
}

/**
 * Turns the raw snapshot file into a validated snapshot. Anything unusable
 * yields an empty snapshot, so every flag resolves to its code default with
 * `FLAG_NOT_FOUND`, and the problems are reported instead of thrown.
 */
export function readSnapshot(raw: string | undefined): SnapshotLoad {
  if (raw === undefined) return unavailable(["Snapshot file could not be read"]);
  if (Buffer.byteLength(raw, "utf8") > MAX_SNAPSHOT_BYTES) {
    return unavailable([`Snapshot is larger than ${MAX_SNAPSHOT_BYTES} bytes`]);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return unavailable(["Snapshot is not valid JSON"]);
  }
  const parsed = parseFlagSnapshot(json);
  return parsed.ok ? { snapshot: parsed.snapshot, problems: [] } : unavailable(parsed.problems);
}

/** Synthetic shopper used when the page is opened without one. */
export const DEFAULT_SHOPPER_ID = "shopper-0001";

const SHOPPER_ID = /^[A-Za-z0-9._-]{1,64}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,189}$/;

export interface ShopperContext {
  targetingKey: string;
  email?: string;
}

type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

/**
 * Builds the evaluation context from the page's query string. Unknown
 * parameters are ignored; an invalid shopper id falls back to the default
 * shopper and an invalid email is left out.
 */
export function shopperContext(params: SearchParams): ShopperContext {
  const shopper = first(params.shopper);
  const email = first(params.email).toLowerCase();
  return {
    targetingKey: SHOPPER_ID.test(shopper) ? shopper : DEFAULT_SHOPPER_ID,
    ...(EMAIL.test(email) && { email }),
  };
}

export interface FlagExplanation {
  flagKey: string;
  value: boolean;
  reason: string;
  environment: string;
  ruleId?: string;
  errorCode?: string;
  /** One sentence a shopper-facing team can read without knowing the evaluator. */
  summary: string;
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

/**
 * Explains an OpenFeature evaluation of a storefront flag. `flag` is the
 * snapshot entry, used to name the rule and its rollout percentage.
 */
export function explainEvaluation(
  details: EvaluationDetails<boolean>,
  flag: FlagConfig | undefined,
  environment: string,
): FlagExplanation {
  const ruleId = typeof details.flagMetadata.ruleId === "string" ? details.flagMetadata.ruleId : undefined;
  const rule = flag?.rules.find((candidate) => candidate.id === ruleId);
  const reason = details.reason ?? "UNKNOWN";

  let summary: string;
  switch (reason) {
    case "TARGETING_MATCH":
      summary = `Rule "${ruleId}" matched this shopper and serves ${onOff(details.value)}.`;
      if (rule?.description) summary += ` ${rule.description}`;
      break;
    case "SPLIT":
      summary = rule?.rollout
        ? `This shopper is inside the ${rule.rollout.percentage}% rollout of rule "${ruleId}", which serves ${onOff(details.value)}.`
        : `This shopper is inside the rollout of rule "${ruleId}", which serves ${onOff(details.value)}.`;
      break;
    case "DEFAULT":
      summary = `No rule served this shopper, so the flag's default (${onOff(details.value)}) applies.`;
      break;
    case "DISABLED":
      summary = `The flag is archived, so the storefront keeps its own default (${onOff(details.value)}).`;
      break;
    case "ERROR":
      summary = `The flag could not be evaluated (${details.errorCode ?? "GENERAL"}), so the storefront keeps its own default (${onOff(details.value)}).`;
      break;
    default:
      summary = `Resolved to ${onOff(details.value)} with reason ${reason}.`;
  }

  return {
    flagKey: details.flagKey,
    value: details.value,
    reason,
    environment,
    ...(ruleId && { ruleId }),
    ...(details.errorCode && { errorCode: details.errorCode }),
    summary,
  };
}
