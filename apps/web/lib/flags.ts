/**
 * Local flag definitions for the sample storefront.
 *
 * Every flag ships with a default that keeps today's behaviour, so a missing or
 * broken configuration can never switch a feature on by accident. Reasons and
 * error codes follow the OpenFeature names so a real provider can replace this
 * module later without changing callers.
 */

export interface BooleanFlagDefinition {
  key: string;
  description: string;
  defaultValue: boolean;
}

export type ResolutionReason = "DEFAULT" | "STATIC" | "ERROR";

export interface FlagResolution<T> {
  value: T;
  reason: ResolutionReason;
  errorCode?: "TYPE_MISMATCH";
}

export type FlagOverrides = Readonly<Record<string, unknown>>;

export const NEW_CHECKOUT: BooleanFlagDefinition = {
  key: "new-checkout",
  description: "One-step checkout that shows the amount to pay on the button.",
  defaultValue: false,
};

export const flagDefinitions: readonly BooleanFlagDefinition[] = [NEW_CHECKOUT];

export function resolveBooleanFlag(
  flag: BooleanFlagDefinition,
  overrides: FlagOverrides = {},
): FlagResolution<boolean> {
  if (!Object.prototype.hasOwnProperty.call(overrides, flag.key)) {
    return { value: flag.defaultValue, reason: "DEFAULT" };
  }
  const override = overrides[flag.key];
  if (typeof override !== "boolean") {
    return { value: flag.defaultValue, reason: "ERROR", errorCode: "TYPE_MISMATCH" };
  }
  return { value: override, reason: "STATIC" };
}

/**
 * Parses overrides such as `{"new-checkout": true}`. Anything that is not a
 * JSON object yields no overrides, so every flag falls back to its default.
 */
export function parseFlagOverrides(raw: string | undefined): FlagOverrides {
  if (!raw || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as FlagOverrides;
  } catch {
    return {};
  }
}
