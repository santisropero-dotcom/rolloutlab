import type { CohortMetrics, MetricsEvent } from "@rolloutlab/metrics";
import { describeTarget, type MetricsTarget } from "./config.js";

export const PAGE_SIZE = 500;
/** Full re-reads allowed when events keep landing behind the cursor. */
export const MAX_READ_ATTEMPTS = 3;

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

interface EventPage {
  items: MetricsEvent[];
  total: number;
  nextCursor: string | null;
}

export interface ApiClient {
  /** Every stored event for the target, read page by page. */
  listAllEvents(target: MetricsTarget): Promise<MetricsEvent[]>;
  putMetrics(target: MetricsTarget, metrics: CohortMetrics): Promise<void>;
}

export function createApiClient(options: {
  apiUrl: string;
  user: string;
  fetch?: typeof fetch;
}): ApiClient {
  const doFetch = options.fetch ?? fetch;
  const headers = { "x-rolloutlab-user": options.user };

  function base(target: MetricsTarget): string {
    const parts = [
      "workspaces",
      target.workspaceId,
      "flags",
      target.flagKey,
      "environments",
      target.environmentKey,
      "telemetry",
    ];
    return `${options.apiUrl}/${parts.map(encodeURIComponent).join("/")}`;
  }

  async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await doFetch(url, { ...init, headers: { ...headers, ...init.headers } });
    const text = await response.text();
    if (!response.ok) {
      let code: string | undefined;
      let message = text;
      try {
        const body = JSON.parse(text) as { error?: { code?: string; message?: string } };
        code = body.error?.code;
        message = body.error?.message ?? text;
      } catch {
        // Not JSON; keep the raw text.
      }
      throw new ApiRequestError(response.status, code, `${response.status} ${message}`);
    }
    return JSON.parse(text) as T;
  }

  return {
    async listAllEvents(target) {
      // The cursor follows `occurredAt`, so an event that lands behind it
      // while paging would be missed. `total` shows that happened; read again.
      for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt += 1) {
        const events: MetricsEvent[] = [];
        let after: string | null = null;
        let total = 0;
        do {
          const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
          if (after) query.set("after", after);
          const page: EventPage = await request<EventPage>(`${base(target)}/events?${query}`);
          events.push(...page.items);
          total = page.total;
          after = page.nextCursor;
        } while (after);
        if (events.length === total) return events;
      }
      throw new Error(
        `Telemetry for ${describeTarget(target)} kept changing while it was read; try again later`,
      );
    },

    async putMetrics(target, metrics) {
      await request(`${base(target)}/metrics`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(metrics),
      });
    },
  };
}
