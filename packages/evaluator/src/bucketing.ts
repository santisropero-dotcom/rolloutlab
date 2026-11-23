import { createHash } from "node:crypto";

/**
 * Deterministic cohort bucketing.
 *
 * Every identity gets a bucket from 0 to 9,999 computed from the flag key,
 * the flag's salt and the identity's subject key. Nothing is stored and
 * nothing random is involved, so the same identity lands in the same bucket
 * on every run, on every machine, in every process.
 *
 * An identity is inside a rollout of `p` percent when its bucket is below
 * `p × 100`. Raising the percentage only adds identities and lowering it only
 * removes them, so nobody flips back and forth while a rollout grows.
 * Changing the salt is the one deliberate way to reshuffle the cohorts.
 */

/** Buckets per 100 %, so percentages can have two decimals (0.01 % steps). */
export const BUCKET_COUNT = 10_000;

export const MAX_SUBJECT_KEY_LENGTH = 256;

export class BucketingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BucketingError";
  }
}

export interface BucketInput {
  flagKey: string;
  salt: string;
  subjectKey: string;
}

/**
 * Bucket in `[0, BUCKET_COUNT)`.
 *
 * The first 32 bits of SHA-256 are scaled (not taken modulo) onto the bucket
 * range, so buckets are evenly sized and the order of hashes is kept. The
 * parts are joined with a newline, which keys cannot contain, so
 * `("a", "b-c")` and `("a-b", "c")` never share an input.
 */
export function bucketFor({ flagKey, salt, subjectKey }: BucketInput): number {
  if (subjectKey.length === 0) {
    throw new BucketingError("Subject key is required for percentage rollouts");
  }
  if (subjectKey.length > MAX_SUBJECT_KEY_LENGTH) {
    throw new BucketingError(`Subject key is longer than ${MAX_SUBJECT_KEY_LENGTH} characters`);
  }
  for (const part of [flagKey, salt, subjectKey]) {
    if (part.includes("\n")) throw new BucketingError("Bucketing inputs cannot contain newlines");
  }
  const digest = createHash("sha256").update(`${flagKey}\n${salt}\n${subjectKey}`).digest();
  // At most 2^32 × 10^4 < 2^46, well inside the exact range of a double.
  return Math.floor((digest.readUInt32BE(0) * BUCKET_COUNT) / 2 ** 32);
}

/** Validates a rollout percentage: 0–100 with at most two decimals. */
export function percentageProblem(percentage: number): string | undefined {
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    return "Percentage must be between 0 and 100";
  }
  if (Math.abs(percentage * 100 - Math.round(percentage * 100)) > 1e-9) {
    return "Percentage can have at most two decimals";
  }
  return undefined;
}

/** Number of buckets a percentage covers, e.g. 12.5 % → 1,250. */
export function bucketsFor(percentage: number): number {
  const problem = percentageProblem(percentage);
  if (problem) throw new BucketingError(problem);
  return Math.round(percentage * 100);
}

export function isInRollout(bucket: number, percentage: number): boolean {
  return bucket < bucketsFor(percentage);
}
