import { aggregateCohortMetrics, type CohortMetrics } from "@rolloutlab/metrics";
import type { ApiClient } from "./api-client.js";
import { describeTarget, type MetricsTarget } from "./config.js";

export interface JobResult {
  target: string;
  status: "published" | "unchanged" | "failed";
  eventCount?: number;
  sourceDigest?: string;
  error?: string;
}

/**
 * Reads all telemetry for each target, aggregates it and publishes the
 * metrics to the API.
 *
 * Every run recomputes from the full event set instead of updating running
 * totals, so the result can't drift and a replay always gives the same
 * numbers. A target whose events are unchanged since the last publish is
 * skipped. One failing target doesn't stop the others.
 */
export class AggregationJob {
  /** `sourceDigest` + window length last published per target. */
  private readonly published = new Map<string, string>();

  constructor(
    private readonly client: ApiClient,
    private readonly windowMinutes: number,
  ) {}

  async runOnce(targets: readonly MetricsTarget[]): Promise<JobResult[]> {
    const results: JobResult[] = [];
    for (const target of targets) {
      results.push(await this.runTarget(target));
    }
    return results;
  }

  private async runTarget(target: MetricsTarget): Promise<JobResult> {
    const name = describeTarget(target);
    let metrics: CohortMetrics;
    try {
      const events = await this.client.listAllEvents(target);
      metrics = aggregateCohortMetrics(events, { windowMinutes: this.windowMinutes });
    } catch (error) {
      return { target: name, status: "failed", error: messageOf(error) };
    }
    const summary = {
      target: name,
      eventCount: metrics.eventCount,
      sourceDigest: metrics.sourceDigest,
    };
    const fingerprint = `${metrics.windowMinutes}:${metrics.sourceDigest}`;
    if (this.published.get(name) === fingerprint) return { ...summary, status: "unchanged" };
    try {
      await this.client.putMetrics(target, metrics);
    } catch (error) {
      return { ...summary, status: "failed", error: messageOf(error) };
    }
    this.published.set(name, fingerprint);
    return { ...summary, status: "published" };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
