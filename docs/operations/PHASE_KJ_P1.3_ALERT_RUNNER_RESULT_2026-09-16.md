# KJ-P1.3 production alert runner — code qualification

Date: 2026-09-16. Scope: implementation, disposable qualification, documentation
and a narrow review PR only. **No merge, deployment or production activation.**

**KJ-P1.3 PRODUCTION ALERT RUNNER — READY for code review.**

| Check | Result |
|---|---|
| Typecheck / full lint / build | PASS |
| Deterministic unit command | 232/232 PASS |
| Focused runner + registration + store-selection tests | 59/59 PASS |
| Final disposable monitor integration | 7/7 PASS, zero skips |
| Full regression | 621 PASS, 51 pre-existing intentional skips, 0 failures (672 total) |
| Baseline | 224/224 retained; 31 recovery tests pass; no new intentional skips |
| Compose configuration resolution | runner=false, cadence=300000, postgres store; health/release passthrough verified with dummy local configuration |
| Diff whitespace check | PASS |

Local machine-readable reports: `artifacts/kj-p1.3/tests.json` and
`artifacts/kj-p1.3/integration.json` (not committed). No qualification claims are
based on a skipped test. Existing gated legacy suites remain explicitly skipped;
the new real PostgreSQL/Restate runner suite executes automatically.

## Architecture decision

FACT: `ScheduleDriver` combines durable waking with business schedule/fire/lease
writes and admission. The observational monitor therefore reuses its existing
Restate Virtual Object, journalled-step and delayed-self-send pattern, without
calling that business handler. `ProductionAlertMonitor/production` owns only a
continuation cursor; there is no new cron, scheduler DB, task minting path or
workflow engine. KernelJSON retains all canonical task authority.

RECOMMENDATION: start with a five-minute delay **after completion**, explicitly
configured and default off. Starting the worker never seeds a monitor invocation.
Restate serialisation/sequence checks prevent duplicate chains; a PostgreSQL
session advisory lock also excludes independent runner and manual alert CLI
invocations. The lock owner performs all state I/O on the same connection.

## Failure behaviour and limits

- Collector exceptions leave episodes unchanged; report `COLLECTION_FAILED`.
- Missing/unavailable state or persistence failure reports `STATE_FAILED`, never
  falls back to memory, and emits nothing without acknowledged state commit.
- Long runs finish before another delay starts; no overlapping catch-up burst.
- Restate resumes interrupted invocations. Replay after a committed but
  unjournalled attempt deduplicates episode decisions, but may increment the sample
  count again. Failure summaries retry at the next regular cadence.
- A failed notifier is counted and isolated; later decisions still get attempted.
- The existing persist-before-notify ordering permits notification loss after
  commit/crash or notifier failure. No outbox or exactly-once delivery claim.
- Complete Restate outage pauses this monitor too. No independent watchdog added.
- Activation must verify direct/session-pooled PostgreSQL; transaction pooling
  cannot support this session-lock contract. Older unlocked alert CLI binaries
  must be quiesced. Existing single-deployment/entity alert-engine scope remains.

See [ALERT_RUNNER.md](ALERT_RUNNER.md) for configuration, ownership boundaries,
metrics, lifecycle, operator activation/stop/resume steps and detailed semantics.

## Deterministic and integration evidence

FACT: deterministic runner tests cover healthy runs, P0/P1 propagation, repeated
dedupe, later recovery, DB failures, collection exceptions, overlap, crash/lost
commit acknowledgement, notifier isolation, safe summaries/notifications, B1
P3 suppression, cadence validation and sequence idempotency.

FACT: seven ungated integration tests create uniquely named, localhost-only
disposable `postgres:17.6` and `restate:1.7.9` containers and remove their own
resources afterward. They prove:

1. Persisted episodes dedupe and recover across independent PostgreSQL pools.
2. Advisory exclusion works across independent connections and releases on failure.
3. A missing alert_state table fails closed before collection or notification.
4. A real separate `alerts` CLI process exits 4 while the monitor owns the lock.
5. Terminating the actual lock backend prevents stale writes; a later owner can run.
6. The real health collector handles unavailable Restate without task/fire/schedule
   table changes, and the existing engine persists its decisions.
7. A real Restate chain runs at least three samples, survives worker and Restate
   restarts, dedupes duplicate bootstrap, leaves exactly one scheduled continuation,
   and attempts the initial two notifications only once. Raw observation markers
   never appear in worker output.

The live timing test accelerates the injected test service to two seconds; the
production parser rejects anything below one minute. Worker fixtures replace only
health observations and cadence; real Restate, runner, state store and notifier
code execute. The real collector is covered separately in test 6. This is
disposable integration evidence, **not production cadence activation evidence**.

Initial qualification exposed harness issues (HTTP/1 discovery against the SDK's
HTTP/2 listener, then Docker reassignment of ephemeral ports on restart). The
harness now checks TCP readiness and re-reads assigned ports; final tests pass.

## Repository reconciliation and safety

FACT: base main/remote main were both
`6fa8446c3922428965d478b827e8f8214f941770`. P1.2A's latest activation record agrees
with the handoff. The living ALERTING document and PG store comment still said
the migration was pending and were reconciled to P1.2A. Historical result files
and migration SQL remain unchanged; the old migration header's fallback language
is superseded by the runtime's explicit fail-closed selection. Cross-repo migration
documents contain older status blocks, but their latest S1D2 completion and the
constitution agree with this phase. No architectural authority contradiction found.

No production connection, admission, schedule mutation, schema migration,
registration, container action or B1/C1 access was performed. Only disposable
local qualification infrastructure was mutated. Existing untracked user files
were not staged or changed. Docker Desktop lifecycle was not managed.

## Changed-file manifest

- `services/kernel/src/alerting/runner.ts`: observational attempt and safe metrics.
- `services/kernel/src/alerting/runner-config.ts`: explicit opt-in and cadence bounds.
- `services/kernel/src/alerting/runner-postgres.ts`: database-wide session exclusion.
- `services/kernel/src/alerting/runner-restate.ts`: durable singleton continuation.
- `services/kernel/src/alerting/runner-production.ts`: existing health/alert wiring.
- `services/kernel/src/alerting/pg-state-store.ts`: caller-owned locked connection support.
- `services/kernel/src/alerting/cli.ts`: manual PostgreSQL invocation shares exclusion.
- `services/kernel/src/index.ts`: opt-in registration, no automatic bootstrap.
- `infrastructure/docker/execution.compose.yaml`: explicit, default-off configuration passthrough.
- `package.json`: runner tests included in the deterministic unit command.
- `tests/alert-runner.test.ts`: deterministic runner/continuation qualification.
- `tests/alert-runner.integration.test.ts`: disposable Postgres/Restate qualification.
- `tests/support/alert-runner-fixture.ts`: synthetic health fixture.
- `tests/support/alert-runner-worker.ts`: disposable restartable monitor worker.
- `tests/kernel-worker-registration.test.ts`: production opt-in registration proof.
- `docs/operations/ALERTING.md`: current persistence status reconciliation.
- `docs/operations/ALERT_RUNNER.md`: runbook and architecture.
- This qualification record.
