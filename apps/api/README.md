# @rolloutlab/api

Fastify API for workspaces, environments, flags, targeting rules, rollout plans, rollout stages and telemetry. Data lives in memory for now and is seeded with synthetic demo workspaces on start.

## Identity (local only)

Requests name a synthetic user in the `x-rolloutlab-user` header. There is no real sign-in.

| User | Workspace | Role |
|---|---|---|
| `alice` | `storefront` | owner |
| `bob` | `storefront` | editor |
| `carol` | `storefront` | viewer |
| `dave` | `payments` | owner |

| Role | Read | Create/update flags | Create environments | Send telemetry and metrics |
|---|---|---|---|---|
| owner | ✅ | ✅ | ✅ | ✅ |
| editor | ✅ | ✅ | — | ✅ |
| viewer | ✅ | — | — | — |

A user outside a workspace gets `404`, the same answer as for a workspace that does not exist.

## Endpoints

| Method | Path | Permission |
|---|---|---|
| GET | `/health` | none |
| GET | `/workspaces/:workspaceId/environments` | read |
| POST | `/workspaces/:workspaceId/environments` | owner |
| GET | `/workspaces/:workspaceId/flags` | read |
| GET | `/workspaces/:workspaceId/flags/:flagKey` | read |
| POST | `/workspaces/:workspaceId/flags` | owner, editor |
| PATCH | `/workspaces/:workspaceId/flags/:flagKey` | owner, editor |
| GET | `/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/rules` | read |
| PUT | `/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/rules` | owner, editor |
| POST | `/workspaces/:workspaceId/environments/:environmentKey/flags/:flagKey/evaluate` | read |
| GET | `/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/rollout/versions` | read |
| GET | `/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/rollout/versions/:version` | read |
| POST | `/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/rollout/versions` | owner, editor |
| GET | `/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/rollout` | read |
| POST | `/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/rollout/transitions` | owner, editor |
| GET | `/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/rollout/gates` | read |
| PUT | `/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/rollout/gates` | owner, editor |
| GET | `/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/rollout/gates/evaluation` | read |
| GET | `/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/telemetry/events` | read |
| POST | `/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/telemetry/events` | owner, editor |
| GET | `/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/telemetry/metrics` | read |
| PUT | `/workspaces/:workspaceId/flags/:flagKey/environments/:environmentKey/telemetry/metrics` | owner, editor |

Flag and environment keys are lowercase kebab case (`new-checkout`). New flags default to `false`. Errors use `{ "error": { "code", "message" } }`, plus `details` where there is more to say (a blocked advance includes the gate evaluation).

```sh
curl -s localhost:4000/workspaces/storefront/flags -H 'x-rolloutlab-user: carol'
```

## Targeting rules

Each flag has an ordered rule list per environment. `PUT` replaces the whole list, so reordering is one request. Rules are checked top to bottom and the first match decides the value; an identity that matches no rule gets the flag's default.

- A rule matches when **all** its conditions match.
- A condition matches when the attribute matches **any** of its values. Operators: `in`, `not_in`, `starts_with`, `ends_with`, `contains`. Values are compared as strings.
- A missing attribute never matches, not even `not_in`.
- A rule can add `"rollout": { "percentage": 10 }` to serve its value to only that share of the matching identities (see below). The others carry on to the next rule.
- Limits: 50 rules, 10 conditions per rule, 100 values per condition. Rule ids are kebab case and unique within the list. Archived flags can't be changed (`409`).

```sh
curl -s -X PUT localhost:4000/workspaces/storefront/flags/new-checkout/environments/production/rules \
  -H 'x-rolloutlab-user: bob' -H 'content-type: application/json' \
  -d '{"rules":[{"id":"beta","conditions":[{"attribute":"segment","operator":"in","values":["beta"]}],"serve":true}]}'
```

The demo seed has one rule in `storefront` / `development`: emails ending in `@rolloutlab.test` get `new-checkout` on.

## Cohort bucketing

Percentage rollouts put each identity in one of 10,000 buckets (`packages/evaluator/src/bucketing.ts`). The bucket comes from SHA-256 of the flag key, the flag's `salt` and the identity's subject key, so it is the same on every run and every server, with nothing stored.

- An identity is in a rollout of `p` % when its bucket is below `p × 100`. Percentages take up to two decimals (`12.5`, `0.01`).
- Raising the percentage only adds identities; lowering it only removes them. Editing targeting rules doesn't move anyone's bucket.
- A new flag's salt is its key. `PATCH { "salt": "reshuffle-1" }` (letters, digits, `.`, `_`, `-`; up to 64) reshuffles every cohort for that flag; it is the only way to do so.
- Subject keys are required, at most 256 characters, and can't contain newlines.

With the demo salt, 104 of 1,000 synthetic identities (`synthetic-0000`…`synthetic-0999`) fall inside a 10 % rollout of `new-checkout`.

## Evaluation

`POST …/environments/:environmentKey/flags/:flagKey/evaluate` returns the value of one flag for one identity (`packages/evaluator/src/evaluation.ts`). The body carries the caller's typed default and the identity's attributes; `targetingKey` is the subject key used for bucketing.

```sh
curl -s -X POST localhost:4000/workspaces/storefront/environments/development/flags/new-checkout/evaluate \
  -H 'x-rolloutlab-user: carol' -H 'content-type: application/json' \
  -d '{"defaultValue":false,"context":{"targetingKey":"user-4","email":"a@rolloutlab.test"}}'
# {"flagKey":"new-checkout","value":true,"reason":"TARGETING_MATCH","ruleId":"internal-staff"}
```

Order: unknown flag → type check → archived → rules top to bottom → the flag's default. Reasons and error codes use the OpenFeature names:

| Outcome | `reason` | `value` |
|---|---|---|
| A rule without a rollout matched | `TARGETING_MATCH` | the rule's value |
| A rollout rule matched and the identity's bucket is inside the percentage | `SPLIT` | the rule's value |
| No rule matched | `DEFAULT` | the flag's default |
| The flag is archived | `DISABLED` | the caller's default |
| Unknown flag (`FLAG_NOT_FOUND`), default of another type (`TYPE_MISMATCH`), unusable `targetingKey` (`INVALID_CONTEXT`) | `ERROR` + `errorCode` | the caller's default |

The value always has the type of the caller's default, so a misconfigured flag can't hand a string to code expecting a boolean. Evaluation problems are answered with `200`; only access and malformed requests are HTTP errors. Rollout rules are skipped for identities without a string `targetingKey`. Context values can be strings (up to 1,000 characters), numbers, booleans or `null`; at most 50 attributes.

## Rollout versions

A rollout plan lists the stages a flag goes through in one environment, for example 10 % → 50 % → 100 % (`src/domain/rollouts.ts`). Plans are versioned: `POST …/rollout/versions` adds version 2, 3, … and earlier versions are never changed, so a later decision can always point to the plan it was made against.

- `stages`: 1 to 10 percentages, each above 0 with up to two decimals, strictly increasing, ending at 100. Pausing or rolling back is not a stage.
- `serve`: the value for identities inside the current stage.
- `baseVersion`: the latest version the author saw (`0` for the first). If someone published in between, the request gets `409` instead of overwriting their plan.
- Each version records who wrote it and the flag's `salt` at that moment. Stages only list percentages; which identities they cover still comes from the salt-based buckets above, so moving between stages or versions never reshuffles anyone. A salt rotation shows up as a different `salt` on the next version.
- Archived flags can't get new versions (`409`).

```sh
curl -s -X POST localhost:4000/workspaces/storefront/flags/new-checkout/environments/production/rollout/versions \
  -H 'x-rolloutlab-user: bob' -H 'content-type: application/json' \
  -d '{"serve":true,"stages":[{"percentage":5},{"percentage":25},{"percentage":100}],"baseVersion":1}'
```

The demo seed has version 1 in `storefront` / `production`: 10 % → 50 % → 100 %, written by `alice`.

## Rollout stages

`GET …/rollout` returns where the rollout stands (`state`) and every move so far (`history`). `POST …/rollout/transitions` makes one move (`src/domain/rollout-state.ts`):

```
not_started ─start─▶ running ─advance─▶ … ─advance─▶ completed
                     │  ▲                                │
                 pause  resume                       roll_back
                     ▼  │                                ▼
                    paused ──────────roll_back──────▶ rolled_back
```

| Action | Allowed from | Result |
|---|---|---|
| `start` | `not_started`, `rolled_back`, `completed` (only once a newer version exists) | first stage of the latest version |
| `advance` | `running` | next stage; reaching the last one (100 %) makes it `completed` |
| `pause` | `running` | same stage, no further widening |
| `resume` | `paused` | `running` on the same stage |
| `roll_back` | `running`, `paused`, `completed` | `rolled_back`, 0 % |

- Any other move is rejected with `409` and code `INVALID_TRANSITION`; the state and history stay as they were.
- `baseSequence` is the `state.sequence` the caller saw (`0` at first). If someone moved the rollout in between, the request gets `409` `CONFLICT`.
- `pause` and `roll_back` need a `reason` (up to 500 characters); it is kept in the history with the user and time.
- A started rollout stays on its version. Publishing a new version doesn't change its stages; the new version is used at the next `start`.
- On an archived flag, only `pause` and `roll_back` are allowed.
- `state.percentage` is the share the current stage covers. Evaluation doesn't read it yet.

```sh
curl -s -X POST localhost:4000/workspaces/storefront/flags/new-checkout/environments/production/rollout/transitions \
  -H 'x-rolloutlab-user: bob' -H 'content-type: application/json' \
  -d '{"action":"start","baseSequence":0}'
```

The demo seed leaves the `storefront` / `production` rollout `not_started`.

## Telemetry

Services report how each request went for the flag value they served (`src/domain/telemetry.ts`). Later steps compare the treatment cohort (`value: true`) with the control cohort (`value: false`).

```sh
curl -s -X POST localhost:4000/workspaces/storefront/flags/new-checkout/environments/production/telemetry/events \
  -H 'x-rolloutlab-user: bob' -H 'content-type: application/json' \
  -d '{"events":[{"eventId":"req-1","subjectKey":"synthetic-0001","value":true,"outcome":"error","latencyMs":340,"occurredAt":"2026-01-12T09:30:00Z"}]}'
# {"received":1,"accepted":1,"duplicates":0,"rejected":[]}
```

- `eventId` (1–128 of letters, digits, `.`, `_`, `:`, `-`) is chosen by the sender and identifies the event within one flag and environment.
- `outcome` is `success` or `error`; `latencyMs` (whole milliseconds, up to 600,000) is optional; `occurredAt` needs a time zone and may be at most 5 minutes ahead of the server clock. It is stored in UTC.
- Up to 1,000 events per request. A batch that doesn't have this shape is rejected as a whole (`400`).
- Each event is checked on its own. Invalid events are listed in `rejected` with their `index` and the request answers `207`; the rest are stored.

**Deduplication.** Resending an `eventId` with the same content counts as a duplicate and changes nothing, so a sender can retry a batch, or replay a fixture, any number of times. "Same content" compares subject, value, outcome, latency and the instant, so `09:30Z` and `10:30+01:00` match. The same `eventId` with different content is rejected as `CONFLICTING_DUPLICATE`; the first version stays.

`GET …/telemetry/events?limit=100&after=<cursor>` lists stored events oldest first (ties by `eventId`), up to 500 per page, with `total` and `nextCursor`. Archived flags still accept telemetry.

### Synthetic replay

`src/domain/telemetry-fixture.ts` generates checkout traffic for `synthetic-0000`…`synthetic-0999`, three requests each. Treatment membership uses the same bucketing as evaluation; errors, latencies and times come from a hash of each event id, so the fixture is identical on every run. With the API running:

```sh
pnpm --filter @rolloutlab/api telemetry:replay --percentage 10 --treatment-error-rate 0.06 --control-error-rate 0.01
# {"received":3000,"accepted":3000,"duplicates":0,"rejected":0}
# run again:
# {"received":3000,"accepted":0,"duplicates":3000,"rejected":0}
```

Telemetry is kept in memory with the rest of the data.

### Cohort metrics

The metrics worker (`apps/worker`) aggregates the stored events with `@rolloutlab/metrics` and sends the result to `PUT …/telemetry/metrics`; `GET …/telemetry/metrics` returns the latest report with `computedAt` and `computedBy`, or `404` before the first one.

- The report is checked as a whole: schema version, window length, timestamps, digest, and that windows and totals add up to `eventCount`. Any problem → `400 VALIDATION_FAILED` listing all of them.
- Telemetry is never deleted, so a report covering fewer events than the stored one comes from an older read and is refused with `409 STALE_METRICS`.

```sh
curl -s localhost:4000/workspaces/storefront/flags/new-checkout/environments/production/telemetry/metrics \
  -H 'x-rolloutlab-user: carol'
# {"workspaceId":"storefront",…,"metrics":{"eventCount":3000,"totals":{"treatment":{…},"control":{…}},"windows":[…]},"computedAt":"…","computedBy":"bob"}
```

## Release gates

`advance` is the only transition that widens exposure, so it must clear the release gates first. The rules come from `@rolloutlab/metrics` and are judged against the latest cohort metrics for the flag and environment:

| Field | Default | Rule |
|---|---|---|
| `minSubjectsPerCohort` | 100 | both cohorts need this many distinct subjects before any limit is judged |
| `minRequestsPerCohort` | 200 | both cohorts need this many requests before any limit is judged |
| `maxErrorRate` | 0.02 | treatment error rate (0–1) |
| `maxErrorRateIncrease` | 0.01 | treatment − control error rate |
| `maxP95LatencyMs` | `null` (off) | treatment p95 latency |
| `maxP95LatencyIncreaseMs` | 100 | treatment − control p95 latency |

Limits are inclusive: exactly at the limit passes. `null` turns a limit off; at least one must stay on.

- `GET …/rollout/gates` returns the saved policy, or the defaults with `source: "default"`. `PUT` replaces the whole policy (every field required; strings such as `"0.02"` are refused, not coerced) → `400 VALIDATION_FAILED` listing every problem.
- `GET …/rollout/gates/evaluation` returns the verdict, one check per rule with the observed value, limit and a sentence, the breached rules, and which metrics were judged (`sourceDigest`, `eventCount`, `metricsComputedAt`).
- Verdicts: `fail` if any limit is breached; otherwise `insufficient_data` if a cohort is below the minimum sample, a latency rule has no latencies, or no metrics exist yet; otherwise `pass`. Too little data never passes.
- `advance` with any verdict other than `pass` → `409 GATE_BLOCKED`; the message names the breached rules and `error.details.gate` holds the full evaluation. The rollout stays where it was. A successful `advance` keeps its evaluation in the history as `gate`.
- `start`, `pause`, `resume` and `roll_back` are never gated: rolling back a red canary must always work.

Metrics currently cover all telemetry for the flag and environment, not just the current stage.

```sh
# after the synthetic replay (treatment 6 % errors) and one worker run:
curl -s -X POST localhost:4000/workspaces/storefront/flags/new-checkout/environments/production/rollout/transitions \
  -H 'x-rolloutlab-user: bob' -H 'content-type: application/json' -d '{"action":"advance","baseSequence":1}'
# 409 {"error":{"code":"GATE_BLOCKED","message":"Cannot advance: Release gate breached: Treatment error rate 5.13 % is above the 2 % limit; Treatment errors exceed control by 4.09 pp, more than the 1 pp allowed","details":{"gate":{…}}}}
```
