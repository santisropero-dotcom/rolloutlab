import {
  ErrorCode,
  OpenFeatureEventEmitter,
  ProviderEvents,
  StandardResolutionReasons,
  type EvaluationContext as OpenFeatureContext,
  type FlagMetadata,
  type JsonValue,
  type Provider,
  type ResolutionDetails,
} from "@openfeature/server-sdk";
import {
  evaluateFlag,
  type Evaluation,
  type FlagConfig,
  type FlagValue,
} from "./evaluation.js";
import type { FlagSnapshot } from "./snapshot.js";
import type { EvaluationContext } from "./targeting.js";

/**
 * OpenFeature provider that evaluates RolloutLab flags in-process from a
 * snapshot, with the same evaluator the API uses. No network call happens
 * per evaluation, so a storefront page can resolve flags on every request.
 *
 * Results are returned as-is: reasons and error codes already use the
 * OpenFeature names, the deciding rule goes into `flagMetadata.ruleId`, and
 * every failure yields the caller's default instead of an exception.
 */

export const PROVIDER_NAME = "rolloutlab-local";

/**
 * Keeps the attributes the evaluator understands. Dates become ISO strings;
 * nested objects and lists are dropped because no targeting operator can
 * compare them.
 */
export function toEvaluationContext(context: OpenFeatureContext): EvaluationContext {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [name, value] of Object.entries(context)) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      result[name] = value;
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) result[name] = value;
    } else if (value instanceof Date) {
      if (!Number.isNaN(value.getTime())) result[name] = value.toISOString();
    }
  }
  return result;
}

function toResolution<T extends FlagValue>(evaluation: Evaluation<T>): ResolutionDetails<T> {
  const flagMetadata: FlagMetadata = evaluation.ruleId ? { ruleId: evaluation.ruleId } : {};
  return {
    value: evaluation.value,
    reason: evaluation.reason,
    flagMetadata,
    ...(evaluation.errorCode && {
      errorCode: ErrorCode[evaluation.errorCode],
      errorMessage: evaluation.errorMessage,
    }),
  };
}

function sameConfig(a: FlagConfig | undefined, b: FlagConfig | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class RolloutLabLocalProvider implements Provider {
  readonly metadata = { name: PROVIDER_NAME } as const;
  readonly runsOn = "server";
  readonly events = new OpenFeatureEventEmitter();

  private flags: ReadonlyMap<string, FlagConfig>;
  private currentEnvironment: string;

  constructor(snapshot: FlagSnapshot) {
    this.flags = new Map(snapshot.flags.map((flag) => [flag.key, flag]));
    this.currentEnvironment = snapshot.environment;
  }

  get environment(): string {
    return this.currentEnvironment;
  }

  /**
   * Swaps in a new snapshot and emits `PROVIDER_CONFIGURATION_CHANGED` with
   * the keys of the flags that were added, removed or edited. Evaluations
   * already running finish on the old snapshot.
   */
  updateSnapshot(snapshot: FlagSnapshot): string[] {
    const next = new Map(snapshot.flags.map((flag) => [flag.key, flag]));
    const keys = new Set([...this.flags.keys(), ...next.keys()]);
    const changed = [...keys].filter((key) => !sameConfig(this.flags.get(key), next.get(key)));
    this.flags = next;
    this.currentEnvironment = snapshot.environment;
    if (changed.length > 0) {
      this.events.emit(ProviderEvents.ConfigurationChanged, { flagsChanged: changed });
    }
    return changed;
  }

  private evaluate<T extends FlagValue>(
    flagKey: string,
    defaultValue: T,
    context: OpenFeatureContext,
  ): Promise<ResolutionDetails<T>> {
    const evaluation = evaluateFlag(
      flagKey,
      this.flags.get(flagKey),
      toEvaluationContext(context),
      defaultValue,
    );
    return Promise.resolve(toResolution(evaluation));
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: OpenFeatureContext,
  ): Promise<ResolutionDetails<boolean>> {
    return this.evaluate(flagKey, defaultValue, context);
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: OpenFeatureContext,
  ): Promise<ResolutionDetails<string>> {
    return this.evaluate(flagKey, defaultValue, context);
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: OpenFeatureContext,
  ): Promise<ResolutionDetails<number>> {
    return this.evaluate(flagKey, defaultValue, context);
  }

  /** RolloutLab has no object flags, so this always returns the default. */
  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
  ): Promise<ResolutionDetails<T>> {
    const known = this.flags.has(flagKey);
    return Promise.resolve({
      value: defaultValue,
      reason: StandardResolutionReasons.ERROR,
      errorCode: known ? ErrorCode.TYPE_MISMATCH : ErrorCode.FLAG_NOT_FOUND,
      errorMessage: known
        ? `Flag "${flagKey}" is not an object flag`
        : `Flag "${flagKey}" not found`,
    });
  }
}
