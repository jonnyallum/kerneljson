# KernelJSON production health model (KJ-P1.1)

> This is the start of a new programme, **KernelJSON Production Operations
> Hardening**, distinct from the completed migration programme documented in
> `new-system`'s `docs/migration/`. It lives here rather than extending that
> programme indefinitely. This document covers KJ-P1.1 only: one canonical,
> read-only health model. No alerting, dashboards, auto-remediation, or new
> capabilities are in scope yet.

## What it answers

**"Is KernelJSON production healthy right now, and why?"** — one command, one
machine-readable report, one human summary. Not a dashboard, not a monitor, not an
alert — a single point-in-time judgement with evidence attached to every claim.

## Architecture: collect / evaluate / report

```
services/kernel/src/health/
  types.ts        HealthStatus, CheckResult, DomainResult, HealthReport
  snapshot.ts      the plain-data shape everything is judged against
  aggregate.ts     worst-of-children rollup (domain, then overall)
  collect.ts       IMPURE — Postgres/Restate/HTTP reads only, never throws past
                    its own boundary; every optional source becomes an
                    `Unavailable` marker, never a guess
  restate-client.ts a minimal read-only Restate admin client (health, registered
                    services, sys_invocation introspection)
  evaluate.ts      PURE — one evaluate*() function per domain, snapshot +
                    expectations -> CheckResult[]
  run.ts           PURE — wires evaluate*() into the full HealthReport
  report.ts        formats the human summary table + picks an exit code
  config.ts        env -> connection config + expectations, with defaults set to
                    the canonical production identity (S1D2)
  cli.ts           the `kerneljson health` entrypoint
```

The collect/evaluate split is deliberate: `evaluate.ts` and `run.ts` are 100% pure
functions over plain data, so every domain's rules are exhaustively unit-testable
with synthetic snapshots — no Docker, no Postgres, no Restate (see
`tests/health-model.test.ts`). Only `collect.ts` and `restate-client.ts` touch a
network or a socket, and both are thin.

## Health states

```
HEALTHY < UNKNOWN < DEGRADED < CRITICAL   (severity order, worst wins)
```

- **HEALTHY** — checked, and the observed value matches the expected condition.
- **DEGRADED** — checked, and something is off but not an active failure (e.g. the
  most recent fire is older than its staleness grace; a fire sat `PLANNED` longer
  than the admission grace).
- **CRITICAL** — checked, and it's a confirmed failure or authority violation.
- **UNKNOWN** — could not be checked (source unreachable or not configured). This
  is *not* the same as healthy: "found nothing" is never a pass. An empty domain
  (nothing to check) is UNKNOWN, never HEALTHY.

**Aggregation is worst-of-children**, applied twice: each domain's status is the
worst of its own checks; the overall status is the worst of all ten domains. A
single CRITICAL check anywhere makes the whole report CRITICAL, however many other
domains are HEALTHY — health is not an average.

Every check states its own evidence source, so a check that degrades because an
*optional* signal (e.g. Restate admin, or container restart counts) isn't
configured reports UNKNOWN **for that check/domain only** — it never masquerades as
a failure in an unrelated domain (`tests/health-model.test.ts` "Restate
unavailable" proves the Restate-dependent checks go UNKNOWN while
database/evidence/authority stay HEALTHY in the same run).

## Domains and check catalogue

| Domain | Check id | What it means |
|---|---|---|
| authority | `authority.bindingReleaseConsistent` | bindings agree with their database activation epochs; missing provenance or no current observations is UNKNOWN |
| authority | `authority.admittedFiresHaveCanonicalTasks` | every `schedule_fires.admitted_child_task_id` exists in `tasks` — the scheduler never minted |
| authority | `authority.noReleaseMismatchIncidents` | no recent `TASK_FAILED` event contains "Task requires its bound worker release" |
| admission | `admission.doorReachable` | `GET {KJ_ADMISSION_URL}/healthz` returns 200 |
| admission | `admission.humanOperatorPresent` | an ACTIVE HUMAN `operator` principal exists |
| scheduler | `scheduler.scheduleEnabled` | `schedule_state.state` matches expectation |
| scheduler | `scheduler.activeVersionExpected` | `schedule_state.active_version` matches expectation |
| scheduler | `scheduler.recentFireExists` | a fire exists and isn't stale past a cadence-derived grace |
| scheduler | `scheduler.noDuplicateFireWindow` | no `(schedule_id, version, fire_window_key)` has more than one row — the core double-admit invariant |
| scheduler | `scheduler.noOrphanPlannedFire` | no fire has sat `PLANNED` (never admitted) past grace |
| scheduler | `scheduler.admittedFiresBoundConsistently` | every `ADMITTED` fire has a bound child task |
| scheduler | `scheduler.nextWakeArmedAndFuture` | when `armNext` is expected on, exactly a pending, future-dated self-armed wake exists |
| scheduler | `scheduler.noZeroDelayLoop` | no two completed invocations for the schedule landed under 60s apart |
| execution | `execution.workerRegistered` | `KernelWorkflowV1`/`TaskWorkflow` are registered with Restate |
| execution | `execution.capabilityServiceRegistered` | `CapabilityServiceV1` is registered (when expected) |
| execution | `execution.noWorkerRestartLoop` | worker container restart count is 0 (operator-supplied; see "Known gaps") |
| restate | `restate.reachable` | Restate admin `/health` responds |
| restate | `restate.expectedServicesRegistered` | all `EXPECTED_SERVICES` are registered |
| restate | `restate.noStuckInvocation` | no `scheduled` invocation is stuck past its own `scheduled_start_at` |
| database | `database.reachable` | `select 1` succeeds |
| database | `database.scheduleReadsSucceed` | scheduler reads succeed |
| database | `database.taskReadsSucceed` | task reads succeed |
| evidence | `evidence.mostRecentCompletedTaskHasEvidence` | the most recently scheduled task has >=1 evidence row |
| evidence | `evidence.toolReceiptPresentWhereRequired` | a `TOOL_RECEIPT` exists for it |
| evidence | `evidence.digestMatchesApproved` | the receipt's digest matches `SCHED_APPROVED_SHA256` |
| evidence | `evidence.boundToCorrectTask` | evidence rows are bound to the queried task, not another |
| releaseParity | `releaseParity.selfReportedReleaseKnown` | this component reports its own `KERNELJSON_RELEASE_ID` |
| releaseParity | `releaseParity.matchesExpected` | it matches `EXPECTED_RELEASE_ID` |
| releaseParity | `releaseParity.recentBindingsConsistent` | same canonical epoch check as authority, including explicit expected active release |
| releaseParity | `releaseParity.noBoundReleaseRejection` | no live release-mismatch rejection observed |
| productionConfig | `productionConfig.armNextExpected` | `SCHED_ARM_NEXT` matches expectation |
| productionConfig | `productionConfig.approvedDigestPresentAndValid` | `SCHED_APPROVED_SHA256` is a well-shaped sha256 |
| productionConfig | `productionConfig.scheduleIdentityMatchesCanonical` | configured schedule id/recipe match canonical production values |
| legacyAuthority | `legacyAuthority.b1FreezeObservable` | see "Known gaps" — always UNKNOWN in this pass |

Every `CheckResult` carries `{ id, status, observed?, expected?, evidence, message,
checkedAt }` — `evidence` names the table/endpoint/env var the observation came
from, never "trust me".

## Known gaps (deliberate, not oversights)

- **`legacyAuthority.b1FreezeObservable` is always UNKNOWN in this pass.** The B1
  authority freeze (`new-system`'s `dsp_scanner`/`boardroom-poller` guard) lives in
  a *different* system — the Shared Brain Supabase project — which this module has
  no credentials for. Wiring cross-system connectivity into a "KernelJSON
  production health" tool is a scope decision, not a defect fix, so it was left out
  of KJ-P1.1 rather than faked. This means **the overall status can never reach a
  true `HEALTHY` today** — it caps at `UNKNOWN`, which is the CORRECT behaviour
  (`tests/health-model.test.ts` proves both: the gap keeps overall at `UNKNOWN`,
  and a resolved `legacyAuthority` reaches a genuine `HEALTHY`). See the KJ-P1.1
  result doc for this exact finding, reported rather than silently patched over.
- **Container restart counts are operator-supplied**, not self-discovered — this
  module deliberately never shells out to `docker inspect` (it has no business
  managing or introspecting the container runtime). Pass `WORKER_RESTART_COUNT`
  / `DOOR_RESTART_COUNT` from a wrapper script if you want
  `execution.noWorkerRestartLoop` to resolve past UNKNOWN.
- **`authority.noReleaseMismatchIncidents` / `releaseParity.noBoundReleaseRejection`**
  only find an incident if it was persisted as a `TASK_FAILED` event with the
  error text in its payload. If the runtime ever throws this error somewhere that
  doesn't reach a `TASK_FAILED` write, this check will not see it — absence of
  evidence here is not proof of absence, only "none found in `task_events`".

## Usage

```bash
DATABASE_URL=postgres://... \
RESTATE_ADMIN_URL=http://restate:9070 \
KJ_ADMISSION_URL=http://gateway:8081 \
SCHED_ARM_NEXT=true \
SCHED_APPROVED_SHA256=27255772beb1418e462fe262a2a747c53bf6a34973c3ad75907f7505a32f2b10 \
SCHED_RECIPE=claude_md_check/v1 \
KERNELJSON_RELEASE_ID=5a2335b41d8fe525ff940a3bd86912c98dae68af \
EXPECTED_RELEASE_ID=5a2335b41d8fe525ff940a3bd86912c98dae68af \
  npm run health
```

All `EXPECTED_*`/canonical values default to the current production identity (see
`config.ts`), so in production the only required variable is `DATABASE_URL`; the
rest add precision as they're supplied. `--json` prints only the machine-readable
report (no human table) — useful for piping into something else later, once P1.2+
exists.

Prints the human summary table, then the full JSON report, and exits `0`
(HEALTHY) / `1` (DEGRADED) / `2` (CRITICAL) / `3` (UNKNOWN overall).

## Safety

**Read-only, unconditionally.** Every collector in `collect.ts` issues a `SELECT`,
a Restate `/query` introspection call, a Restate `/health` GET, or an admission
door `/healthz` GET. Nothing in this module or anything it imports can:

- enable/disable a schedule
- fire a schedule (`/fire/send` is never called)
- create a task
- change a database row
- restart a container
- modify Restate state
- touch legacy infrastructure (the Shared Brain gap above is a *missing read*, not
  a withheld write — there is no write path to legacy infra anywhere in this module)

This is enforced by construction (every DB call in `collect.ts` is a `select`; grep
the file — there is no `insert`/`update`/`delete`), not by a runtime guard, because
there is nothing here that could plausibly need one.

Release transition semantics and the operator activation protocol are specified in [RELEASE_PROVENANCE.md](RELEASE_PROVENANCE.md).
