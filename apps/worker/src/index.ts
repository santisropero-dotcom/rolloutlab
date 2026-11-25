import { setTimeout as sleep } from "node:timers/promises";
import { AggregationJob } from "./aggregation-job.js";
import { createApiClient } from "./api-client.js";
import { describeTarget, loadConfig, type WorkerConfig } from "./config.js";

/**
 * Metrics worker: aggregates telemetry by cohort and time window and
 * publishes the result to the API, on an interval or once with `--once`.
 */
export function describeWorker(config: WorkerConfig = loadConfig()) {
  return {
    service: "worker",
    apiUrl: config.apiUrl,
    targets: config.targets.map(describeTarget),
    windowMinutes: config.windowMinutes,
    intervalMs: config.intervalMs,
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const config = loadConfig();
  const job = new AggregationJob(
    createApiClient({ apiUrl: config.apiUrl, user: config.user }),
    config.windowMinutes,
  );
  const once = argv.includes("--once");
  console.log(JSON.stringify({ msg: "worker ready", ...describeWorker(config), once }));

  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => controller.abort());
  }

  do {
    const results = await job.runOnce(config.targets);
    for (const result of results) console.log(JSON.stringify({ msg: "metrics", ...result }));
    if (once) {
      if (results.some((r) => r.status === "failed")) process.exitCode = 1;
      return;
    }
    try {
      await sleep(config.intervalMs, undefined, { signal: controller.signal });
    } catch {
      return; // Stopped.
    }
  } while (!controller.signal.aborted);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
