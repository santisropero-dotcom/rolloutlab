# @rolloutlab/evaluator

The flag evaluator shared by the API and the storefront, plus a local [OpenFeature](https://openfeature.dev) provider built on it.

| Module | Contents |
|---|---|
| `src/bucketing.ts` | Deterministic SHA-256 cohort bucketing (10,000 buckets) |
| `src/targeting.ts` | Targeting rules, operators and limits |
| `src/evaluation.ts` | `evaluateFlag`: rules → rollouts → defaults, with OpenFeature reasons |
| `src/snapshot.ts` | `parseFlagSnapshot`: validates a JSON snapshot of one environment's flags |
| `src/openfeature.ts` | `RolloutLabLocalProvider` (import from `@rolloutlab/evaluator/openfeature`) |

The package is compiled to `dist/`; `pnpm build:packages` at the root builds it, and the root `dev`, `typecheck` and `test` scripts do so first.

## Flag snapshots

A snapshot holds every flag of one environment. Anything read from a file or the network goes through `parseFlagSnapshot`, which checks every field, drops unknown ones and lists all problems.

```json
{
  "schemaVersion": 1,
  "environment": "development",
  "flags": [
    {
      "key": "new-checkout",
      "type": "boolean",
      "defaultValue": false,
      "salt": "new-checkout",
      "rules": [
        { "id": "ten-percent", "conditions": [], "serve": true, "rollout": { "percentage": 10 } }
      ]
    }
  ]
}
```

`archived` defaults to `false` and a rule's `description` to `""`. Limits are those of the API (50 rules, 10 conditions, 100 values) plus 500 flags per snapshot.

## Local OpenFeature provider

`RolloutLabLocalProvider` evaluates flags in-process from a snapshot, so no request leaves the process per evaluation. `@openfeature/server-sdk` is a peer dependency.

```ts
import { OpenFeature } from "@openfeature/server-sdk";
import { parseFlagSnapshot } from "@rolloutlab/evaluator";
import { RolloutLabLocalProvider } from "@rolloutlab/evaluator/openfeature";

const parsed = parseFlagSnapshot(JSON.parse(raw));
if (!parsed.ok) throw new Error(parsed.problems.join("\n"));

await OpenFeature.setProviderAndWait(new RolloutLabLocalProvider(parsed.snapshot));
const details = await OpenFeature.getClient().getBooleanDetails("new-checkout", false, {
  targetingKey: "user-4",
});
// { flagKey: "new-checkout", value: true, reason: "SPLIT", flagMetadata: { ruleId: "ten-percent" }, … }
```

- Reasons (`TARGETING_MATCH`, `SPLIT`, `DEFAULT`, `DISABLED`, `ERROR`) and error codes (`FLAG_NOT_FOUND`, `TYPE_MISMATCH`, `INVALID_CONTEXT`) come straight from the evaluator; the rule that decided the value is in `flagMetadata.ruleId`.
- Context values that are strings, numbers, booleans or `null` are passed on; dates become ISO strings; nested objects and lists are dropped.
- RolloutLab flags are booleans, so string, number and object lookups return the caller's default with `TYPE_MISMATCH`.
- `updateSnapshot(next)` swaps the configuration and emits `PROVIDER_CONFIGURATION_CHANGED` with the keys of the flags that changed.
