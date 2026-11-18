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

Flag and environment keys are lowercase kebab case (`new-checkout`). New flags default to `false`. Errors use `{ "error": { "code", "message" } }`.

```sh
curl -s localhost:4000/workspaces/storefront/flags -H 'x-rolloutlab-user: carol'
```

## Targeting rules

Each flag has an ordered rule list per environment. `PUT` replaces the whole list, so reordering is one request. Rules are checked top to bottom and the first match decides the value; an identity that matches no rule gets the flag's default.

- A rule matches when **all** its conditions match.
- A condition matches when the attribute matches **any** of its values. Operators: `in`, `not_in`, `starts_with`, `ends_with`, `contains`. Values are compared as strings.
- A missing attribute never matches, not even `not_in`.
- Limits: 50 rules, 10 conditions per rule, 100 values per condition. Rule ids are kebab case and unique within the list. Archived flags can't be changed (`409`).

```sh
curl -s -X PUT localhost:4000/workspaces/storefront/flags/new-checkout/environments/production/rules \
  -H 'x-rolloutlab-user: bob' -H 'content-type: application/json' \
  -d '{"rules":[{"id":"beta","conditions":[{"attribute":"segment","operator":"in","values":["beta"]}],"serve":true}]}'
```

The demo seed has one rule in `storefront` / `development`: emails ending in `@rolloutlab.test` get `new-checkout` on.
