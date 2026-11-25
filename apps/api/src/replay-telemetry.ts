import { parseArgs } from "node:util";
import { syntheticCheckoutTelemetry } from "./domain/telemetry-fixture.js";
import { MAX_EVENTS_PER_BATCH } from "./domain/telemetry.js";

/**
 * Sends the synthetic checkout fixture to a running API.
 *
 *   pnpm --filter @rolloutlab/api telemetry:replay --percentage 10 \
 *     --treatment-error-rate 0.06 --control-error-rate 0.01
 *
 * Running it twice with the same options stores nothing new the second time.
 */
const { values } = parseArgs({
  options: {
    api: { type: "string", default: process.env.ROLLOUTLAB_API_URL ?? "http://localhost:4000" },
    user: { type: "string", default: "bob" },
    workspace: { type: "string", default: "storefront" },
    flag: { type: "string", default: "new-checkout" },
    environment: { type: "string", default: "production" },
    percentage: { type: "string", default: "10" },
    subjects: { type: "string", default: "1000" },
    "treatment-error-rate": { type: "string", default: "0.06" },
    "control-error-rate": { type: "string", default: "0.01" },
    start: { type: "string", default: "2026-01-12T09:00:00.000Z" },
    "run-id": { type: "string", default: "checkout" },
  },
});

async function main(): Promise<void> {
  const base = `${values.api}/workspaces/${values.workspace}/flags/${values.flag}`;
  const headers = { "x-rolloutlab-user": values.user, "content-type": "application/json" };

  const flagResponse = await fetch(base, { headers });
  if (!flagResponse.ok) {
    throw new Error(`Could not read flag: ${flagResponse.status} ${await flagResponse.text()}`);
  }
  const flag = (await flagResponse.json()) as { salt: string };

  const events = syntheticCheckoutTelemetry({
    flagKey: values.flag,
    salt: flag.salt,
    percentage: Number(values.percentage),
    subjects: Number(values.subjects),
    start: values.start,
    treatmentErrorRate: Number(values["treatment-error-rate"]),
    controlErrorRate: Number(values["control-error-rate"]),
    runId: values["run-id"],
  });

  const totals = { received: 0, accepted: 0, duplicates: 0, rejected: 0 };
  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_BATCH) {
    const response = await fetch(
      `${base}/environments/${values.environment}/telemetry/events`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ events: events.slice(i, i + MAX_EVENTS_PER_BATCH) }),
      },
    );
    if (response.status !== 200 && response.status !== 207) {
      throw new Error(`Ingest failed: ${response.status} ${await response.text()}`);
    }
    const result = (await response.json()) as {
      received: number;
      accepted: number;
      duplicates: number;
      rejected: unknown[];
    };
    totals.received += result.received;
    totals.accepted += result.accepted;
    totals.duplicates += result.duplicates;
    totals.rejected += result.rejected.length;
  }
  console.log(JSON.stringify(totals));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
