# @rolloutlab/api

Fastify API for workspaces, environments, flags and targeting rules. Data lives in memory for now and is seeded with synthetic demo workspaces on start.

## Identity (local only)

Requests name a synthetic user in the `x-rolloutlab-user` header. There is no real sign-in.

| User | Workspace | Role |
|---|---|---|
| `alice` | `storefront` | owner |
| `bob` | `storefront` | editor |
| `carol` | `storefront` | viewer |
| `dave` | `payments` | owner |

| Role | Read | Create/update flags | Create environments |
|---|---|---|---|
| owner | ✅ | ✅ | ✅ |
| editor | ✅ | ✅ | — |
| viewer | ✅ | — | — |

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

Flag and environment keys are lowercase kebab case (`new-checkout`). New flags default to `false`. Errors use `{ "error": { "code", "message" } }`.

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

Percentage rollouts put each identity in one of 10,000 buckets (`src/domain/bucketing.ts`). The bucket comes from SHA-256 of the flag key, the flag's `salt` and the identity's subject key, so it is the same on every run and every server, with nothing stored.

- An identity is in a rollout of `p` % when its bucket is below `p × 100`. Percentages take up to two decimals (`12.5`, `0.01`).
- Raising the percentage only adds identities; lowering it only removes them. Editing targeting rules doesn't move anyone's bucket.
- A new flag's salt is its key. `PATCH { "salt": "reshuffle-1" }` (letters, digits, `.`, `_`, `-`; up to 64) reshuffles every cohort for that flag; it is the only way to do so.
- Subject keys are required, at most 256 characters, and can't contain newlines.

With the demo salt, 104 of 1,000 synthetic identities (`synthetic-0000`…`synthetic-0999`) fall inside a 10 % rollout of `new-checkout`.

## Evaluation

`POST …/environments/:environmentKey/flags/:flagKey/evaluate` returns the value of one flag for one identity (`src/domain/evaluation.ts`). The body carries the caller's typed default and the identity's attributes; `targetingKey` is the subject key used for bucketing.

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
