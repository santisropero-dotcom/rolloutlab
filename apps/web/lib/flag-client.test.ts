import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenFeature } from "@openfeature/server-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { loadStorefrontFlags, snapshotPath } from "./flag-client";
import { NEW_CHECKOUT } from "./flags";

// Buckets for flag/salt "new-checkout": shopper-0013 → 504 (inside 10%), shopper-0001 → 5549.
const INSIDE = "shopper-0013";
const OUTSIDE = "shopper-0001";

const dir = mkdtempSync(path.join(tmpdir(), "rolloutlab-web-"));
const file = path.join(dir, "snapshot.json");
copyFileSync(new URL("../flags/development.json", import.meta.url), file);

afterAll(async () => {
  await OpenFeature.close();
  rmSync(dir, { recursive: true, force: true });
});

async function evaluate(context: Record<string, string>) {
  const { client, load } = await loadStorefrontFlags(file);
  const details = await client.getBooleanDetails(NEW_CHECKOUT.key, NEW_CHECKOUT.defaultValue, context);
  return { details, load };
}

describe("snapshotPath", () => {
  it("uses ROLLOUTLAB_FLAG_SNAPSHOT when set", () => {
    expect(snapshotPath({ ROLLOUTLAB_FLAG_SNAPSHOT: "/srv/flags.json" })).toBe("/srv/flags.json");
  });

  it("defaults to the bundled development snapshot", () => {
    expect(snapshotPath({})).toBe(path.join(process.cwd(), "flags", "development.json"));
    expect(snapshotPath({ ROLLOUTLAB_FLAG_SNAPSHOT: "  " })).toBe(
      path.join(process.cwd(), "flags", "development.json"),
    );
  });
});

// These run in order: later cases edit the snapshot file the provider reads.
describe("loadStorefrontFlags", () => {
  it("keeps the new checkout off for shoppers outside every rule", async () => {
    const { details, load } = await evaluate({ targetingKey: OUTSIDE });
    expect(load.problems).toEqual([]);
    expect(details).toMatchObject({ value: false, reason: "DEFAULT" });
  });

  it("serves shoppers inside the rollout with reason SPLIT", async () => {
    const { details } = await evaluate({ targetingKey: INSIDE });
    expect(details).toMatchObject({
      value: true,
      reason: "SPLIT",
      flagMetadata: { ruleId: "ten-percent" },
    });
  });

  it("serves staff through the targeting rule", async () => {
    const { details } = await evaluate({ targetingKey: OUTSIDE, email: "ana@rolloutlab.test" });
    expect(details).toMatchObject({
      value: true,
      reason: "TARGETING_MATCH",
      flagMetadata: { ruleId: "internal-staff" },
    });
  });

  it("picks up edits to the snapshot file on the next call", async () => {
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        environment: "staging",
        flags: [
          { key: "new-checkout", type: "boolean", defaultValue: false, salt: "new-checkout", archived: true, rules: [] },
        ],
      }),
    );
    const { details, load } = await evaluate({ targetingKey: INSIDE });
    expect(load.snapshot.environment).toBe("staging");
    expect(details).toMatchObject({ value: false, reason: "DISABLED" });
  });

  it("falls back to the code default when the snapshot breaks", async () => {
    writeFileSync(file, "{ broken");
    const { details, load } = await evaluate({ targetingKey: INSIDE });
    expect(load.problems).toEqual(["Snapshot is not valid JSON"]);
    expect(details).toMatchObject({ value: false, reason: "ERROR", errorCode: "FLAG_NOT_FOUND" });
  });

  it("treats a deleted snapshot like a broken one", async () => {
    rmSync(file);
    const { details, load } = await evaluate({ targetingKey: INSIDE });
    expect(load.problems).toEqual(["Snapshot file could not be read"]);
    expect(details.value).toBe(false);
  });
});
