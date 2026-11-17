import { describe, expect, it } from "vitest";
import { checkoutButtonLabel } from "./checkout";
import { NEW_CHECKOUT, flagDefinitions, parseFlagOverrides, resolveBooleanFlag } from "./flags";

describe("new-checkout flag", () => {
  it("is off by default", () => {
    expect(NEW_CHECKOUT.defaultValue).toBe(false);
    expect(resolveBooleanFlag(NEW_CHECKOUT)).toEqual({ value: false, reason: "DEFAULT" });
  });

  it("can be switched on by a local override", () => {
    expect(resolveBooleanFlag(NEW_CHECKOUT, { "new-checkout": true })).toEqual({
      value: true,
      reason: "STATIC",
    });
  });

  it("falls back to the default when the override has the wrong type", () => {
    expect(resolveBooleanFlag(NEW_CHECKOUT, { "new-checkout": "true" })).toEqual({
      value: false,
      reason: "ERROR",
      errorCode: "TYPE_MISMATCH",
    });
  });

  it("ignores overrides for other flags", () => {
    expect(resolveBooleanFlag(NEW_CHECKOUT, { "other-flag": true }).value).toBe(false);
  });

  it("does not read inherited object properties as overrides", () => {
    const inherited = Object.create({ "new-checkout": true }) as Record<string, unknown>;
    expect(resolveBooleanFlag(NEW_CHECKOUT, inherited).reason).toBe("DEFAULT");
  });

  it("every defined flag defaults to off", () => {
    const keys = new Set(flagDefinitions.map((flag) => flag.key));
    expect(keys.size).toBe(flagDefinitions.length);
    for (const flag of flagDefinitions) {
      expect(flag.defaultValue).toBe(false);
    }
  });
});

describe("parseFlagOverrides", () => {
  it("returns no overrides for empty or missing input", () => {
    expect(parseFlagOverrides(undefined)).toEqual({});
    expect(parseFlagOverrides("  ")).toEqual({});
  });

  it("parses a JSON object", () => {
    expect(parseFlagOverrides('{"new-checkout": true}')).toEqual({ "new-checkout": true });
  });

  it("returns no overrides for invalid JSON or non-objects", () => {
    expect(parseFlagOverrides("{not json")).toEqual({});
    expect(parseFlagOverrides("[true]")).toEqual({});
    expect(parseFlagOverrides("true")).toEqual({});
    expect(parseFlagOverrides("null")).toEqual({});
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
