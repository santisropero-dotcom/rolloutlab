import { OpenFeature, ProviderEvents } from "@openfeature/server-sdk";
import { afterAll, describe, expect, it, vi } from "vitest";
import { RolloutLabLocalProvider, toEvaluationContext } from "./openfeature.js";
import type { FlagSnapshot } from "./snapshot.js";

// Buckets for salt "new-checkout": user-4 → 628 (inside 10 %), user-1 → 9287.
const INSIDE = "user-4";
const OUTSIDE = "user-1";

function snapshot(overrides: Partial<FlagSnapshot> = {}): FlagSnapshot {
  return {
    schemaVersion: 1,
    environment: "development",
    flags: [
      {
        key: "new-checkout",
        type: "boolean",
        defaultValue: false,
        salt: "new-checkout",
        archived: false,
        rules: [
          {
            id: "internal-staff",
            description: "Staff try the new checkout first.",
            conditions: [
              { attribute: "email", operator: "ends_with", values: ["@rolloutlab.test"] },
            ],
            serve: true,
          },
          {
            id: "ten-percent",
            description: "10 % of everyone else",
            conditions: [],
            serve: true,
            rollout: { percentage: 10 },
          },
        ],
      },
      {
        key: "old-banner",
        type: "boolean",
        defaultValue: true,
        salt: "old-banner",
        archived: true,
        rules: [],
      },
    ],
    ...overrides,
  };
}

describe("toEvaluationContext", () => {
  it("keeps primitives, turns dates into ISO strings and drops nested values", () => {
    const signedUp = new Date("2026-01-02T03:04:05.000Z");
    expect(
      toEvaluationContext({
        targetingKey: "user-4",
        plan: "pro",
        orders: 3,
        beta: false,
        referrer: null,
        signedUp,
        address: { country: "CO" },
        tags: ["a", "b"],
        broken: Number.NaN,
        invalidDate: new Date("not a date"),
      }),
    ).toEqual({
      targetingKey: "user-4",
      plan: "pro",
      orders: 3,
      beta: false,
      referrer: null,
      signedUp: "2026-01-02T03:04:05.000Z",
    });
  });
});

describe("RolloutLabLocalProvider", () => {
  const provider = new RolloutLabLocalProvider(snapshot());

  it("serves a targeting match with the deciding rule in the metadata", async () => {
    await expect(
      provider.resolveBooleanEvaluation("new-checkout", false, {
        targetingKey: OUTSIDE,
        email: "a@rolloutlab.test",
      }),
    ).resolves.toEqual({
      value: true,
      reason: "TARGETING_MATCH",
      flagMetadata: { ruleId: "internal-staff" },
    });
  });

  it("splits by bucket for everyone else", async () => {
    await expect(
      provider.resolveBooleanEvaluation("new-checkout", false, { targetingKey: INSIDE }),
    ).resolves.toMatchObject({ value: true, reason: "SPLIT", flagMetadata: { ruleId: "ten-percent" } });
    await expect(
      provider.resolveBooleanEvaluation("new-checkout", false, { targetingKey: OUTSIDE }),
    ).resolves.toEqual({ value: false, reason: "DEFAULT", flagMetadata: {} });
  });

  it("returns the caller's default for archived flags", async () => {
    await expect(provider.resolveBooleanEvaluation("old-banner", false, {})).resolves.toEqual({
      value: false,
      reason: "DISABLED",
      flagMetadata: {},
    });
  });

  it("reports unknown flags and wrong types with OpenFeature error codes", async () => {
    await expect(provider.resolveBooleanEvaluation("missing", true, {})).resolves.toMatchObject({
      value: true,
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
    });
    await expect(
      provider.resolveStringEvaluation("new-checkout", "off", { targetingKey: INSIDE }),
    ).resolves.toMatchObject({ value: "off", reason: "ERROR", errorCode: "TYPE_MISMATCH" });
    await expect(
      provider.resolveNumberEvaluation("new-checkout", 0, { targetingKey: INSIDE }),
    ).resolves.toMatchObject({ value: 0, reason: "ERROR", errorCode: "TYPE_MISMATCH" });
  });

  it("reports an unusable targeting key as invalid context", async () => {
    await expect(
      provider.resolveBooleanEvaluation("new-checkout", false, { targetingKey: "a\nb" }),
    ).resolves.toMatchObject({ value: false, reason: "ERROR", errorCode: "INVALID_CONTEXT" });
  });

  it("never serves object flags", async () => {
    const fallback = { layout: "classic" };
    await expect(provider.resolveObjectEvaluation("new-checkout", fallback)).resolves.toMatchObject(
      { value: fallback, reason: "ERROR", errorCode: "TYPE_MISMATCH" },
    );
    await expect(provider.resolveObjectEvaluation("missing", fallback)).resolves.toMatchObject({
      value: fallback,
      errorCode: "FLAG_NOT_FOUND",
    });
  });

  it("swaps snapshots and announces only the flags that changed", async () => {
    const local = new RolloutLabLocalProvider(snapshot());
    const handler = vi.fn();
    local.events.addHandler(ProviderEvents.ConfigurationChanged, handler);

    const [checkout, banner] = snapshot().flags;
    const next = snapshot({
      environment: "production",
      flags: [
        { ...checkout!, rules: [] },
        banner!,
        { key: "dark-mode", type: "boolean", defaultValue: true, salt: "s", archived: false, rules: [] },
      ],
    });

    expect(local.updateSnapshot(next)).toEqual(["new-checkout", "dark-mode"]);
    expect(local.environment).toBe("production");
    await vi.waitFor(() =>
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ flagsChanged: ["new-checkout", "dark-mode"] }),
      ),
    );
    await expect(
      local.resolveBooleanEvaluation("new-checkout", true, { targetingKey: INSIDE }),
    ).resolves.toMatchObject({ value: false, reason: "DEFAULT" });

    handler.mockClear();
    expect(local.updateSnapshot(next)).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("through the OpenFeature SDK", () => {
  const domain = "rolloutlab-provider-test";

  afterAll(async () => {
    await OpenFeature.clearProviders();
  });

  it("resolves flags with reasons and metadata", async () => {
    await OpenFeature.setProviderAndWait(domain, new RolloutLabLocalProvider(snapshot()));
    const client = OpenFeature.getClient(domain);

    const split = await client.getBooleanDetails("new-checkout", false, { targetingKey: INSIDE });
    expect(split).toMatchObject({
      flagKey: "new-checkout",
      value: true,
      reason: "SPLIT",
      flagMetadata: { ruleId: "ten-percent" },
    });

    expect(await client.getBooleanValue("new-checkout", false, { targetingKey: OUTSIDE })).toBe(
      false,
    );

    const missing = await client.getBooleanDetails("missing", true);
    expect(missing).toMatchObject({ value: true, reason: "ERROR", errorCode: "FLAG_NOT_FOUND" });
  });
});
