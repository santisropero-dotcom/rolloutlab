# Worker

Aggregates telemetry into cohort metrics and publishes them to the API.

Each run reads every stored event for a target through `GET …/telemetry/events` (500 per page), aggregates them with `@rolloutlab/metrics` and sends the report to `PUT …/telemetry/metrics`. It recomputes from the full event set every time rather than keeping running totals, so the numbers can't drift and replaying the same fixture always gives the same metrics. A target whose events haven't changed since the last publish is skipped, and one failing target doesn't stop the others.

The event cursor follows `occurredAt`, so an event that arrives behind it while a read is in progress would be missed. The worker compares what it read with the page `total` and reads again (up to three times) when they differ.

```sh
# with the API running and telemetry replayed (see apps/api/README.md)
pnpm --filter @rolloutlab/worker metrics:once
# {"msg":"metrics","target":"storefront/new-checkout/production","eventCount":3000,"sourceDigest":"b749…","status":"published"}

pnpm --filter @rolloutlab/worker dev   # every 30 s until stopped
```

| Variable | Default | Meaning |
|---|---|---|
| `ROLLOUTLAB_API_URL` | `http://localhost:4000` | API base URL |
| `ROLLOUTLAB_WORKER_USER` | `bob` | Workspace member the worker acts as; owner or editor |
| `ROLLOUTLAB_METRICS_TARGETS` | `storefront/new-checkout/production` | Comma-separated `workspace/flag/environment` |
| `ROLLOUTLAB_METRICS_WINDOW_MINUTES` | `15` | Window length, 1–1440 |
| `ROLLOUTLAB_WORKER_INTERVAL_MS` | `30000` | Pause between runs |

With `--once` the worker exits non-zero if any target failed.
