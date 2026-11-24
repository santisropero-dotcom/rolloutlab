# RolloutLab

**Progressive delivery with release guardrails.** RolloutLab keeps feature-flag cohorts stable, replays health signals for each cohort, and explains whether a rollout should advance, wait for more data, or pause.

> **Status:** early development, following a 6-week roadmap (see below). It uses a sample storefront and synthetic telemetry.

## The problem

A team releases a feature to 10% of users and needs to decide whether to expand. To decide well, they need:

- users to stay in the same cohort as the rollout grows
- health metrics split by cohort, with enough data to trust
- a clear rule for when to stop, and a record of who decided what

RolloutLab provides this and keeps the final rollback decision with a person.

## Demo workflow

1. Roll out a checkout feature to 10% of 1,000 synthetic users
2. Replay telemetry where treatment errors rise to 6% against a 1% baseline
3. See why expansion to 50% is blocked, and which rule was breached
4. Review and approve a simulated rollback

The guardrail shows a correlation, not proof of cause, and the UI says so.

## Planned features

- Environments, flags, variants and targeting rules
- Stable percentage cohorts based on the flag, a salt and the subject key
- Flag evaluation through an API and an OpenFeature-compatible provider
- Sample storefront that shows evaluation reasons
- Rollout stages managed by a state machine
- Replay and deduplication of synthetic telemetry, aggregated by cohort and time window
- Guardrails with thresholds and minimum sample sizes
- Release dashboard with metric trends and decision history
- Simulated rollback proposals with role checks and an audit trail

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js, TypeScript |
| API | Fastify |
| Database | PostgreSQL, Prisma |
| Queue | Redis, BullMQ |
| Flag SDK | OpenFeature provider adapter |
| Testing | Vitest, Playwright |
| Packaging | Docker |

## Architecture

```mermaid
flowchart LR
  Config[Flag configuration] --> Eval[Deterministic evaluation]
  Eval --> Telemetry[Synthetic telemetry]
  Telemetry --> Metrics[Cohort metrics]
  Metrics --> Guard[Guardrail decision]
  Guard --> Human[Human review]
```

**Core entities:** Project, Environment, Flag, Variant, TargetingRule, Rollout, RolloutStage, HealthObservation, GuardrailPolicy, ApprovalRequest, AuditEntry.

## Design rules

- Cohort assignment is deterministic, and stays stable when the percentage grows.
- Replaying the same telemetry always produces the same metrics.
- A guardrail never decides with too little data.
- Only an authorized owner can approve a rollback, and every decision is audited.
- One workspace can never change another workspace's flags.

## Roadmap

| Week | Focus | Status |
|---|---|---|
| Week 1 | **W01-01 + CI** — Scaffold workspace with Compose stack, add sample storefront, add default-off checkout flag with test | ✅ Done |
| Week 2 | **Flags & evaluation** — Add environments, flags and roles, add targeting rules, add deterministic cohort bucketing, add typed defaults | ✅ Done |
| Week 3 | **Provider & rollouts** — Add local OpenFeature provider, show flag evaluation reasons, add rollout versions, add stage-transition state machine | ✅ Done |
| Week 4 | **Telemetry & gates** — Ingest and deduplicate events, aggregate cohort metrics in a worker, evaluate thresholds and minimum sample sizes | Planned |
| Week 5 | **Dashboard & rollback** — Add release dashboard with metric trends, add decision history, add simulated rollback proposals with role checks, record rollout audit entries | Planned |
| Week 6 | **Release** — Cover concurrent delivery and measure evaluation latency, package containers, document cache invalidation and release gates, add end-to-end tests and architecture docs | Planned |

## Getting started

Setup instructions will be added once the first packages are in place.
