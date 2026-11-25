# @rolloutlab/metrics

Cohort metrics from flag telemetry, shared by the worker that computes them and the API that stores them.

| Module | Contents |
|---|---|
| `src/aggregate.ts` | `aggregateCohortMetrics`: totals and time windows per cohort |
| `src/validate.ts` | `cohortMetricsProblems`: checks a report received over the wire |

Events served `true` form the **treatment** cohort, events served `false` the **control** cohort. For each cohort, in total and per window:

- `requests`, `errors` and `errorRate` (`errors / requests`, `null` without requests)
- `subjects`: distinct subject keys. A subject served both values counts in both cohorts.
- `latency`: `p50Ms`, `p95Ms` (nearest rank) and `maxMs` over the requests that reported a latency, or `null`

Windows are aligned to the window length in UTC (`09:00`, `09:15`, … for 15 minutes); only windows with events are listed.

The result depends only on the set of events: order doesn't matter and a repeated event id counts once. `sourceDigest` is a SHA-256 over the events sorted by id, so two reports with the same digest were computed from the same telemetry.

Built to `dist/` by `pnpm build:packages`.
