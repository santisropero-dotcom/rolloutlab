import { aggregateCohortMetrics, type CohortMetrics, type MetricsEvent } from "@rolloutlab/metrics";
import { describe, expect, it } from "vitest";
import { AggregationJob } from "./aggregation-job.js";
import { createApiClient, MAX_READ_ATTEMPTS, PAGE_SIZE } from "./api-client.js";
import { loadConfig, parseTargets, type MetricsTarget } from "./config.js";

const target: MetricsTarget = {
  workspaceId: "storefront",
  flagKey: "new-checkout",
  environmentKey: "production",
};

function events(count: number, prefix = "ev"): MetricsEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    eventId: `${prefix}-${String(i).padStart(5, "0")}`,
    subjectKey: `synthetic-${i % 300}`,
    value: i % 300 < 30,
    outcome: i % 41 === 0 ? "error" : "success",
    latencyMs: 80 + ((i * 37) % 400),
    occurredAt: new Date(Date.UTC(2026, 0, 12, 9) + ((i * 7919) % 3_600_000)).toISOString(),
  }));
}

/**
 * Stands in for the API's telemetry routes: pages events oldest first with a
 * cursor and records the metrics it is sent.
 */
class FakeApi {
  stored: MetricsEvent[] = [];
  puts: Array<{ url: string; body: CohortMetrics }> = [];
  pageRequests = 0;
  failPut = false;
  /** Called after each page is served, e.g. to add a late event. */
  onPage?: (page: number) => void;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (headers.get("x-rolloutlab-user") !== "bob") return json(401, { error: { code: "UNAUTHENTICATED" } });
    if (init?.method === "PUT") {
      if (this.failPut) return json(500, { error: { code: "INTERNAL", message: "boom" } });
      this.puts.push({ url: url.pathname, body: JSON.parse(String(init.body)) as CohortMetrics });
      return json(200, {});
    }
    if (!url.pathname.endsWith("/events")) return json(404, { error: { code: "NOT_FOUND" } });
    const sorted = [...this.stored].sort((a, b) =>
      a.occurredAt === b.occurredAt
        ? a.eventId.localeCompare(b.eventId)
        : a.occurredAt.localeCompare(b.occurredAt),
    );
    const after = url.searchParams.get("after");
    const limit = Number(url.searchParams.get("limit"));
    let start = 0;
    if (after) {
      const [occurredAt, eventId] = JSON.parse(after) as [string, string];
      const index = sorted.findIndex(
        (e) => e.occurredAt > occurredAt || (e.occurredAt === occurredAt && e.eventId > eventId),
      );
      start = index === -1 ? sorted.length : index;
    }
    const items = sorted.slice(start, start + limit);
    const last = items.at(-1);
    const more = start + items.length < sorted.length;
    const body = {
      items,
      total: sorted.length,
      nextCursor: more && last ? JSON.stringify([last.occurredAt, last.eventId]) : null,
    };
    this.pageRequests += 1;
    this.onPage?.(this.pageRequests);
    return json(200, body);
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setup(api = new FakeApi()) {
  const client = createApiClient({ apiUrl: "http://api.test", user: "bob", fetch: api.fetch });
  return { api, client, job: new AggregationJob(client, 15) };
}

describe("AggregationJob", () => {
  it("reads every page, aggregates and publishes the metrics", async () => {
    const { api, job } = setup();
    api.stored = events(1234);
    const [result] = await job.runOnce([target]);

    expect(result).toMatchObject({ status: "published", eventCount: 1234 });
    expect(api.pageRequests).toBe(Math.ceil(1234 / PAGE_SIZE));
    expect(api.puts).toHaveLength(1);
    expect(api.puts[0]?.url).toBe(
      "/workspaces/storefront/flags/new-checkout/environments/production/telemetry/metrics",
    );
    expect(api.puts[0]?.body).toEqual(
      JSON.parse(JSON.stringify(aggregateCohortMetrics(api.stored, { windowMinutes: 15 }))),
    );
  });

  it("skips publishing while the telemetry is unchanged", async () => {
    const { api, job } = setup();
    api.stored = events(600);
    await job.runOnce([target]);
    const [again] = await job.runOnce([target]);
    expect(again?.status).toBe("unchanged");
    expect(api.puts).toHaveLength(1);

    api.stored.push(...events(1, "late"));
    const [changed] = await job.runOnce([target]);
    expect(changed).toMatchObject({ status: "published", eventCount: 601 });
    expect(api.puts).toHaveLength(2);
  });

  it("publishes identical metrics when the same fixture is replayed into a fresh API", async () => {
    const first = setup();
    first.api.stored = events(900);
    await first.job.runOnce([target]);

    const second = setup();
    second.api.stored = events(900).reverse();
    await second.job.runOnce([target]);

    expect(JSON.stringify(second.api.puts[0]?.body)).toBe(JSON.stringify(first.api.puts[0]?.body));
  });

  it("reads again when an event lands behind the cursor mid-read", async () => {
    const { api, job } = setup();
    api.stored = events(1200);
    api.onPage = (page) => {
      if (page === 1) {
        api.stored.push({ ...events(1, "late")[0]!, occurredAt: "2026-01-12T08:00:00.000Z" });
      }
    };
    const [result] = await job.runOnce([target]);
    expect(result).toMatchObject({ status: "published", eventCount: 1201 });
  });

  it("gives up after repeated changes and reports the failure", async () => {
    const { api, job } = setup();
    api.stored = events(1200);
    let n = 0;
    api.onPage = () => {
      n += 1;
      api.stored.push({ ...events(1, `late${n}`)[0]!, occurredAt: "2026-01-12T08:00:00.000Z" });
    };
    const [result] = await job.runOnce([target]);
    expect(result?.status).toBe("failed");
    expect(result?.error).toContain("kept changing");
    expect(api.pageRequests).toBe(MAX_READ_ATTEMPTS * 3);
    expect(api.puts).toHaveLength(0);
  });

  it("reports API errors per target and retries the publish on the next run", async () => {
    const { api, job } = setup();
    api.stored = events(10);
    api.failPut = true;
    const [failed] = await job.runOnce([target]);
    expect(failed).toMatchObject({ status: "failed", error: "500 boom" });

    api.failPut = false;
    const [retried] = await job.runOnce([target]);
    expect(retried?.status).toBe("published");
  });

  it("keeps going when one target fails", async () => {
    const api = new FakeApi();
    api.stored = events(5);
    const client = createApiClient({ apiUrl: "http://api.test", user: "nobody", fetch: api.fetch });
    const okClient = createApiClient({ apiUrl: "http://api.test", user: "bob", fetch: api.fetch });
    const results = await new AggregationJob(
      {
        listAllEvents: (t) =>
          t.flagKey === "broken" ? client.listAllEvents(t) : okClient.listAllEvents(t),
        putMetrics: (t, m) => okClient.putMetrics(t, m),
      },
      15,
    ).runOnce([{ ...target, flagKey: "broken" }, target]);
    expect(results.map((r) => r.status)).toEqual(["failed", "published"]);
  });
});

describe("worker config", () => {
  it("uses local defaults", () => {
    expect(loadConfig({})).toEqual({
      apiUrl: "http://localhost:4000",
      user: "bob",
      targets: [target],
      windowMinutes: 15,
      intervalMs: 30_000,
    });
  });

  it("reads targets, window and interval from the environment", () => {
    const config = loadConfig({
      ROLLOUTLAB_API_URL: "http://api:4000/",
      ROLLOUTLAB_WORKER_USER: "alice",
      ROLLOUTLAB_METRICS_TARGETS: "storefront/new-checkout/production, payments/x/staging",
      ROLLOUTLAB_METRICS_WINDOW_MINUTES: "5",
      ROLLOUTLAB_WORKER_INTERVAL_MS: "10000",
    });
    expect(config.apiUrl).toBe("http://api:4000");
    expect(config.user).toBe("alice");
    expect(config.targets).toHaveLength(2);
    expect(config.windowMinutes).toBe(5);
    expect(config.intervalMs).toBe(10_000);
  });

  it("rejects malformed targets and numbers", () => {
    expect(() => parseTargets("storefront/new-checkout")).toThrow(/Invalid metrics target/);
    expect(() => parseTargets("a/b/c/d")).toThrow(/Invalid metrics target/);
    expect(() => parseTargets(" , ")).toThrow(/no targets/);
    expect(() => loadConfig({ ROLLOUTLAB_METRICS_WINDOW_MINUTES: "0" })).toThrow();
    expect(() => loadConfig({ ROLLOUTLAB_WORKER_INTERVAL_MS: "fast" })).toThrow();
  });
});
