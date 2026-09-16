# KJ-P1.3A PRODUCTION ALERT RUNNER ACTIVATION — STOP

Date: 2026-09-16 UTC. Stopped during preflight, before deployment or bootstrap.
No new feature, health rule, alert policy, scheduler semantic, or notifier was added.

## Blocking finding

The current health model compares **all bindings created in the last 24 hours**,
including completed tasks, against `EXPECTED_RELEASE_ID`. Production contains a
completed task from today's normal business-schedule execution:

| Field | Observed value |
|---|---|
| Task | `41f2ce1f-5044-84dc-aa5e-6ce5e5f30103` |
| Created | `2026-09-16T08:00:00.645Z` |
| Status | `COMPLETED` |
| Bound release | `5a2335b41d8fe525ff940a3bd86912c98dae68af` |

Using that actual binding in the **unchanged, merged evaluator and reducer** gives:

| Locally evaluated deployment configuration | Check | Decision |
|---|---|---|
| Current release / expected release both `5a2335b...` | `releaseParity.recentBindingsConsistent = HEALTHY` | none |
| Proposed release / expected release both `d5abf22...` | `releaseParity.recentBindingsConsistent = CRITICAL` | `NEW`, **P1**, `notify:true` |

This is a local preflight forecast, not an alert emitted or persisted in production.
Source: `health/collect.ts` (`fetchRecentBindings`, 24-hour window),
`health/evaluate.ts` (`evaluateReleaseParity`) and `alerting/policy.ts`
(`releaseParity.recentBindingsConsistent` maps CRITICAL to P1).

Deploying and immediately seeding under the requested configuration therefore
cannot meet the qualification requirement **"no P0/P1/P2 is generated"** at this
time. Removing release expectations, retaining a false old release identity, or
changing health/policy logic was not used to evade this gate. Resolving completed
binding history across release transitions, or explicitly approving different
activation timing/qualification, requires a separate decision. No next phase started.

## Source and runtime provenance

- PR #29 is merged; canonical remote main is
  `d5abf22ec176d16932af5cfcd77a8ce3098027bc`.
- Its tree is identical to qualified PR head
  `962940f7558b2a617b6551702e777bb450b9454b`; both GitHub qualification checks passed.
- **Newly deployed SHA: none.** Production checkout, worker and door remain
  `5a2335b41d8fe525ff940a3bd86912c98dae68af`; checkout was clean.
- Worker image: `kerneljson-worker:5a2335b`.
- Door image: `kerneljson-admission-door:5a2335b`.
- Restate image: `docker.restate.dev/restatedev/restate:1.7.9`.

## Pooling-mode proof — PASS

The worker's actual runtime database connection resolves to the shared pooler
`aws-0-eu-west-2.pooler.supabase.com:5432`, database `postgres`. No username,
password or complete connection string was printed or persisted.

The [current Supabase endpoint contract](https://supabase.com/docs/guides/database/connecting-to-postgres)
identifies shared-pooler port 5432 as **session mode**, while 6543 is transaction
mode. This was corroborated with the production connection, not inferred from
the hostname alone:

- Two simultaneous clients obtained distinct PostgreSQL backends.
- Client A acquired the monitor's exact advisory key `(1263153235, 13)`.
- Across three explicit read-only BEGIN/COMMIT boundaries, A retained the same
  backend and client B remained unable to acquire that lock.
- A explicitly released the lock; B then acquired and explicitly released it.
- Clients were destroyed; a subsequent read found **zero remaining monitor locks**.

These were transient session locks only; the probe made no table writes and did
not alter the server or pooler configuration. Production manual-CLI exclusion
was **not** claimed: that separate qualification step would require deployment of
the reviewed CLI. No alert CLI processes were detected in the worker or door.

## Configuration and preflight evidence

- `SCHED_ARM_NEXT=true` on the worker.
- `SCHED_RECIPE=claude_md_check/v1`.
- Approved digest remains
  `27255772beb1418e462fe262a2a747c53bf6a34973c3ad75907f7505a32f2b10`.
- Worker and door release IDs match the current production SHA.
- Monitor settings remain absent; `ALERT_RUNNER_ENABLED=true`, cadence 300000,
  and postgres mode were **not applied**.
- `kernel_private.alert_state` exists and was readable across independent
  preflight invocations. Its existing B1 row remains OPEN/P3, occurrence count 2,
  first seen `2026-09-16T06:32:38.782Z`, last seen
  `2026-09-16T06:33:46.980Z`, `last_notified_at=null`.
- The unchanged B1 UNKNOWN policy remains P3 / `notify:false`.
- All five existing business tasks are COMPLETED.
- Door `/healthz` and Restate admin `/health` returned HTTP 200.
- Full post-deployment health collection was not executed: deployment was stopped.

## Before/after safety evidence

| Item | Before | After |
|---|---|---|
| Admissions | 24 | 24 |
| Schedule fires | 5 | 5 |
| Tasks | 5 | 5 |
| Business schedule state/version | enabled / v2 | enabled / v2 |
| Business schedule updated_at | `2026-09-14T21:23:23.562Z` | unchanged |
| Worker / door / Restate | healthy / healthy / healthy | unchanged |
| Restart counts | 0 / 0 / 0 | unchanged |
| Alert-state rows / occurrence count | 1 / 2 | unchanged |
| Monitor advisory locks | 0 | 0 |

The business-schedule pending wake remains
`inv_10gzREX5HBAt7GVwoz62YNpUOfuQgEE7Yt`, scheduled for
`2026-09-17T08:00:00.018Z`. It was neither cancelled nor replaced.

## Bootstrap and recurrence qualification

- Bootstrap invocation: **not sent**.
- First/second/third monitor sequences: **not executed**.
- Delayed monitor wake: **none created**.
- Natural recurrence, five-minute completion-relative delay, monitor dedupe and
  actual CLI exclusion: **not production-qualified in this phase**.
- Rollback: unnecessary; no release/configuration deployment occurred.

## Deviations and retained evidence

The phase stopped at preflight because a deterministic release-transition check
conflicts with the requested zero-P1 activation gate. No deployment, registration,
bootstrap, schedule mutation, persistent DB write, or container restart occurred.
Temporary advisory locks were acquired/released solely to prove session semantics.
No secrets, raw credentials, B1/C1 infrastructure or unrelated application data were changed.

Sanitised local evidence:
`artifacts/kj-p1.3a/precheck.json`, `postcheck.json`, and
`release-preflight.json`; reproducible local evaluation:
`artifacts/kj-p1.3a/release-preflight.mjs`.
