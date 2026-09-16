# Production alert runner — KJ-P1.3

Status: code/test preparation only. **Not deployed or activated.** Production
activation requires a later, explicit human-authorised change window after review.

## Architecture and authority

The production worker optionally registers `ProductionAlertMonitor`, a Restate
Virtual Object with the sole valid key `production`. Its exclusive `tick` handler
reuses the existing ScheduleDriver's **journaled step + delayed self-send pattern**,
without importing the business scheduler, admission gateway, ledger, or task APIs.

```
operator bootstrap -> Restate exclusive tick(production, sequence)
  -> Postgres session advisory lock + alert_state probe
  -> existing collectHealthSnapshot / evaluateHealthSnapshot
  -> existing runAlertEngine / PgAlertStateStore (atomic state commit)
  -> existing Notifier interface / ConsoleNotifier
  -> safe run summary -> durable next-sequence + delayed self-send
```

The existing `ScheduleDriver` cannot simply run this monitor: its wake is coupled
to schedule/fire/lease writes and canonical task admission. Reusing that handler
would violate this phase's observational boundary. There is no new cron, scheduler
database, scheduling service process, workflow engine, or task-minting path here.
Restate already supplies durable waiting and continuation. The monitor's sequence
is a continuation cursor, not a ScheduleSpec, task identity, or business-work ledger.
Operator configuration owns cadence; KernelJSON remains the sole canonical task
authority. Removing the monitor does not affect task admission or execution.

Production data writes are confined to the existing `kernel_private.alert_state`.
Restate journals only safe run summaries, delayed monitor deliveries and its own
continuation cursor. No business schedule state or Restate server configuration is
changed by the runner. No external notifier, auto-remediation, Docker access,
Shared Brain/B1/C1 access, or jVault mutation is added.

## Cadence and lifecycle

**RECOMMENDATION: 300,000 ms (five minutes) after completion of each attempt.**
This gives useful operational detection latency with modest read load on the
existing low-volume production system. Detection latency is up to one delay plus
collection duration during normal operation; this is not a five-minute SLA.

The delay is completion-relative, never a fixed wall-clock catch-up schedule.
Slow runs do not overlap and missed intervals are not replayed in a burst. A run
longer than five minutes finishes before another five-minute wait begins.
Failures represented by a summary also rearm at the same controlled cadence.
There is no retry timer in the application: a process crash invokes Restate's
existing durable replay; a completed failing attempt waits for the next cadence.

Default `ALERT_RUNNER_ENABLED=false` means no service registration, DB connection,
bootstrap, or recurrence. Enabling registers the service but **does not send an
initial tick**. Startup and deploy never implicitly seed a chain.

## Configuration

| Variable | Default / contract |
|---|---|
| `ALERT_RUNNER_ENABLED` | `false`; only literal `true`/`false`, empty = false |
| `ALERT_RUNNER_CADENCE_MS` | `300000`; integer 60000..86400000, empty = default |
| `ALERT_STATE_STORE` | must be unset/empty or `postgres`; enabled runner rejects memory |
| `DATABASE_URL` | runtime injected from jVault; **direct or session-pooled Postgres**, never transaction pooling |
| `RESTATE_ADMIN_URL` | existing read-only health configuration; Compose defaults `http://restate:9070` |
| `KJ_ADMISSION_URL` | existing admission health GET endpoint; runner needs no admission bearer |
| `KERNELJSON_RELEASE_ID` / `EXPECTED_RELEASE_ID` | worker's deployed release / independently approved expected release; Compose passes expected explicitly, defaulting to deployment release |

All other health expectations retain P1.1 defaults/configuration from
`health/config.ts`. Review the expected schedule, version, recipe, digest and
services before activation; keep the existing live scheduler's configuration.
The Compose allowlist explicitly passes the new runner settings. Do not invent
container restart counts: absent counts remain UNKNOWN, as in P1.1. Static counts
cannot establish that no restart happened later.

Monitoring uses a separate pool (max 3, connection timeout 5s, server statement
timeout 10s, client query timeout 15s), leaving the business worker's pool alone.
HTTP collection retains P1.1's 5–10s per-request timeouts. There is no unsafe
Promise.race timeout that releases a lock while writes continue in the background.
The only wired notifier is bounded local console output; an indefinitely hung
future notifier would hold this run and prevent rearming, and would need its own
transport timeout design.

## Overlap and replay

1. Restate serialises exclusive handlers for `production`.
2. Only the expected nonnegative `sequence` runs (initially zero). A duplicate,
   stale or future sequence returns `DUPLICATE_OR_OUT_OF_ORDER` without collecting,
   writing, or scheduling another wake. Other object keys are rejected.
3. The handler journals the entire attempt as one `ctx.run`. It then journals
   the next cursor and delayed self-send. A crash between these operations resumes
   the same invocation rather than opening a second chain.
4. A database-wide advisory lock `(1263153235, 13)` guards collection through
   notification. A competing runner returns `OVERLAP_SKIPPED` immediately.
   The **same pg client** owns the lock, reads state, and performs transactional
   state writes; it cannot reconnect writes after losing the lock. The client is
   destroyed on exit so a locked session never returns to the pool. Process/session
   loss releases the lock at Postgres. During a partition it may remain held until
   Postgres detects connection loss, which safely delays monitoring.

Session advisory locks require a direct/session-pooled connection. Confirm the
production endpoint's pooling mode before activation; URL shape is not proof.
The PostgreSQL mode of `npm run alerts` uses the same lock and exits nonzero if
another alert invocation owns it. Older deployed CLI versions must be quiesced
before activation. `npm run health` remains safe to run concurrently. One deployment
and canonical entity per database is the existing alert engine's supported model.

An external step can commit Postgres and crash before Restate records its result.
Replay then recollects and reduces against durable state: no second NEW episode,
though `occurrence_count` can advance again. **This is episode idempotency, not
exactly-once samples or exactly-once delivery.**

## Failure semantics

| Condition | Behaviour |
|---|---|
| Collector throws (including a failed SQL read after reachability passed) | `COLLECTION_FAILED`, no state change or notifications; next cadence retries |
| Optional source unavailable | Existing health model marks unavailable/UNKNOWN or confirmed failure; normal policy applies |
| Missing/unreachable alert-state DB, read/write/commit failure | `STATE_FAILED`, no memory fallback and no notifications without acknowledged commit; next cadence retries |
| Restate admin unavailable while invocation can run | Existing health collection records unavailability/failure and alert policy evaluates it |
| Restate runtime unavailable | No execution/wake until it recovers; persisted continuation resumes. This monitor cannot independently report its own runtime's total outage |
| Run exceeds cadence | No catch-up or overlap; next delay starts after completion |
| Worker crashes before state commit | Transaction rolls back; Restate retries same invocation |
| Crash after state commit, before notification or journal acknowledgement | Persisted episode dedupes on replay; a notification may be lost (existing P1.2 ordering) |
| Crash after journalled attempt, before next send | Restate replays the completed step and continues the same delayed-send chain |
| Two runner invocations | Restate serialisation + sequence dedupe; independent runner processes additionally excluded by PG lock |
| Notifier throws | Count failure, continue other decisions, return `NOTIFIER_FAILED`; committed episode remains deduped |

The current engine commits notification intent (`last_notified_at`) before transport
delivery. It is **not a delivery receipt**. Failed or interrupted console delivery
is not retried on subsequent unchanged episodes. This phase deliberately preserves
the qualified P1.2 semantics; durable outbox/acknowledged delivery is outside scope.
No claim of guaranteed paging or independent availability monitoring is made.

## Observability and secrets

Each actual attempt logs `alert_monitor_started` and, on completion,
`alert_monitor_run`. Completion includes `sequence`, `startedAt`, `completedAt`,
`durationMs`, `overall` (null if not collected), `decisionCounts` by P0/P1/P2/P3,
`notificationsAttempted`, `notificationsFailed`, and `result`.
Decision counts include recovery decisions and policy-suppressed decisions, not
all currently open episodes; a deduped run can have zero decisions while unhealthy.
Runner `OK` means the pipeline executed, not that production is healthy.

Start without completion indicates an interrupted/in-progress attempt. There can
be duplicate logs on crash/replay; correlate with sequence and Restate invocation.
Summaries are returned to Restate; no raw health report, credential, URL, exception
text or observed value is persisted in its journal. Console notifications retain
check ID, severity, episode and recovery fields but replace raw collector messages
with a safe identity/lifecycle message and omit observed values.

`POST /ProductionAlertMonitor/production/status` with `{}` returns current
`enabled`, `cadenceMs`, and `nextSequence`. This is a shared, read-only handler.
The B1 gap stays UNKNOWN / P3 / notify:false. Total Restate/worker outage and missing
completion need operator inspection; an external heartbeat/watchdog is not added.

## Later production activation procedure — NOT executed

1. Obtain explicit approval for the reviewed commit and a separate production
   change window. Record current release, health, scheduler state and pending wake,
   task/fire counts, and worker/door restart counts using existing runbook patterns.
2. Verify P1.2A migration and durable alert rows, production DB identity and
   direct/session pooling, correct health endpoints and independent expectations.
   Quiesce older alert CLI writers that lack this lock. No migration is introduced by P1.3.
3. Operator deploys the approved worker release with explicit
   `ALERT_RUNNER_ENABLED=true`, `ALERT_RUNNER_CADENCE_MS=300000`, PostgreSQL state
   and health configuration. Preserve release parity with the door and all
   existing business scheduler settings. Docker/process lifecycle is operator-owned.
4. Operator registers that worker using the existing deployment runbook, verifies
   `ProductionAlertMonitor` is present, then inspects monitor `status` and Restate
   pending invocations. **For a fresh monitor only**, send exactly one
   `POST /ProductionAlertMonitor/production/tick/send` body `{"sequence":0}` to
   the existing localhost-only Restate ingress. This is a monitor continuation,
   never a `ScheduleDriver/fire` or task admission request.
5. Observe at least three natural runs, durable dedupe and exactly one pending
   delayed monitor tick, approximately completion + 300 seconds. Confirm no extra
   admissions/fires attributable to monitoring and no schedule mutation. Do not
   induce production faults to qualify failure handling.
6. Capture evidence and an activation result separately. A code merge alone is
   neither deployment nor activation.

**Stop/change/resume (operator only, separate authorised actions):** set the runner
off in the worker environment through the normal deployment process and account
for/cancel only outstanding `ProductionAlertMonitor/production` invocations using
Restate's operator tooling. Do not cancel business workflows or ScheduleDriver
wakes. Preserve alert_state and the monitor cursor; do not reset them. Changing
cadence requires the same controlled worker configuration rollout (no server
configuration change). Restate may pin in-flight work to an old deployment; verify
it has drained/cancelled before claiming a new configuration is effective. To
resume, inspect status and pending invocations; if one continuation already exists,
let it resume. Only if the chain is absent send the returned `nextSequence` once.
Reusing sequence zero after prior activation is harmless but will not restart it.

## Qualification and provenance

`tests/alert-runner.test.ts` exercises deterministic runner/continuation failure
paths; `tests/alert-runner.integration.test.ts` provisions and removes its own
local Postgres and Restate containers, migrates only the disposable database,
tests real persistence/lock loss/read-only collection and durable restart recovery.
It supplies no production URL. The production registration test checks opt-in.

FACT: preimplementation main was `6fa8446c3922428965d478b827e8f8214f941770`.
The latest P1.2A result agrees with the handoff. `ALERTING.md` and the PG store
comment still claimed migration pending; they are reconciled to that newer result.
Historical P1.2/P1.2B result files remain frozen. Cross-repo migration documents
contain older superseded status blocks; their latest S1D2 completion and the
constitution agree with this phase. The health collector's header claims it never
throws, but several SQL reads can throw: this runner explicitly contains that case.
