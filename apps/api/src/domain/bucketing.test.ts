import { describe, expect, it } from "vitest";
import {
  BUCKET_COUNT,
  BucketingError,
  bucketFor,
  bucketsFor,
  isInRollout,
  percentageProblem,
} from "./bucketing.js";

const flag = { flagKey: "new-checkout", salt: "new-checkout" };

/** 1,000 synthetic identities, the same on every run. */
const identities = Array.from({ length: 1000 }, (_, i) => `synthetic-${String(i).padStart(4, "0")}`);

describe("bucketFor", () => {
  it.each([
    ["user-1", 9287],
    ["user-2", 2274],
    ["user-42", 1320],
    ["alice@rolloutlab.test", 3961],
  ])("puts %s in bucket %i", (subjectKey, bucket) => {
    // Fixed values: a change here would move live identities between cohorts.
    expect(bucketFor({ ...flag, subjectKey })).toBe(bucket);
  });

  it("returns an integer bucket inside the range", () => {
    for (const subjectKey of identities) {
      const bucket = bucketFor({ ...flag, subjectKey });
      expect(Number.isInteger(bucket)).toBe(true);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(BUCKET_COUNT);
    }
  });

  it("gives the same buckets on every call", () => {
    const first = identities.map((subjectKey) => bucketFor({ ...flag, subjectKey }));
    const second = identities.map((subjectKey) => bucketFor({ ...flag, subjectKey }));
    expect(second).toEqual(first);
  });

  it("reshuffles when the salt changes", () => {
    expect(bucketFor({ ...flag, salt: "reshuffle-1", subjectKey: "user-1" })).toBe(6094);
    const moved = identities.filter(
      (subjectKey) =>
        isInRollout(bucketFor({ ...flag, subjectKey }), 10) !==
        isInRollout(bucketFor({ ...flag, salt: "reshuffle-1", subjectKey }), 10),
    );
    expect(moved).toHaveLength(192);
  });

  it("buckets the same identity independently per flag", () => {
    const a = identities.map((subjectKey) => bucketFor({ ...flag, subjectKey }));
    const b = identities.map((subjectKey) =>
      bucketFor({ flagKey: "express-shipping", salt: "express-shipping", subjectKey }),
    );
    expect(b).not.toEqual(a);
  });

  it("rejects missing, oversized and newline-joined inputs", () => {
    expect(() => bucketFor({ ...flag, subjectKey: "" })).toThrow(BucketingError);
    expect(() => bucketFor({ ...flag, subjectKey: "x".repeat(257) })).toThrow(BucketingError);
    expect(() => bucketFor({ ...flag, subjectKey: "a\nb" })).toThrow(BucketingError);
    expect(() => bucketFor({ ...flag, salt: "a\nb", subjectKey: "user-1" })).toThrow(
      BucketingError,
    );
  });
});

describe("percentage rollouts", () => {
  const buckets = identities.map((subjectKey) => bucketFor({ ...flag, subjectKey }));
  const inside = (percentage: number) =>
    identities.filter((_, i) => isInRollout(buckets[i]!, percentage));

  it.each([
    [0, 0],
    [1, 9],
    [10, 104],
    [25, 250],
    [50, 522],
    [100, 1000],
  ])("puts %s%% of 1,000 identities in %i", (percentage, expected) => {
    expect(inside(percentage)).toHaveLength(expected);
  });

  it("only adds identities when the percentage grows", () => {
    let previous = new Set<string>();
    for (const percentage of [0, 1, 5, 10, 25, 50, 75, 100]) {
      const current = new Set(inside(percentage));
      for (const id of previous) expect(current.has(id)).toBe(true);
      previous = current;
    }
  });

  it("accepts two decimals and rejects anything else", () => {
    expect(bucketsFor(12.5)).toBe(1250);
    expect(bucketsFor(0.01)).toBe(1);
    expect(bucketsFor(33.33)).toBe(3333);
    expect(percentageProblem(0.005)).toMatch(/two decimals/);
    expect(percentageProblem(-1)).toMatch(/between 0 and 100/);
    expect(percentageProblem(100.01)).toMatch(/between 0 and 100/);
    expect(percentageProblem(Number.NaN)).toMatch(/between 0 and 100/);
    expect(() => isInRollout(0, 101)).toThrow(BucketingError);
  });

  it("treats bucket edges as half-open", () => {
    expect(isInRollout(999, 10)).toBe(true);
    expect(isInRollout(1000, 10)).toBe(false);
    expect(isInRollout(0, 0)).toBe(false);
    expect(isInRollout(BUCKET_COUNT - 1, 100)).toBe(true);
  });
});
