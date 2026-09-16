# KJ-P1.3C RELEASE PROVENANCE SEAM — READY

Base: canonical main `700d9e44d29ae684392fb525772a40f59aa81ff1`, containing PR #30.
Scope: release provenance, corresponding health semantics, disposable qualification
and activation documentation. No production command, migration, deployment, restart,
activation or P1.3A resumption was performed.

## Implementation

FACT: All runtime binding INSERTs already use `persistBinding`, called by gateway
admission and initial ledger creation. Scheduler admission uses the gateway; recovery
and replay preserve existing bindings. No writer refactor or second authority path
is introduced. A database BEFORE INSERT trigger enforces provenance for those calls,
older overlapping binaries and direct SQL, independently of caller-supplied values.

FACT: The migration adds one singleton epoch row, immutable release_activations,
and release_epoch/persisted_at binding columns. Both binding insertion and operator
activation perform a real UPDATE on the singleton and hold its row lock through
transaction completion. The returned epoch, not a clock or allocated transaction ID,
orders each binding relative to activation. Stale Repeatable Read/Serializable writers
fail with 40001; Read Committed writers use the latest committed epoch after waiting.

FACT: Existing rows become explicit epoch-0 baseline with NULL insertion time;
contracts are untouched. First activation serializes against all subsequent trigger
writes. No historical activation or binding timestamp is fabricated. Activation uses
a caller request UUID and expected-epoch compare-and-swap, so retries cannot advance
or resurrect an old epoch. Rollback is a new explicit activation, never a history edit.

FACT: Both binding health checks share one collector snapshot and evaluator. All
bindings are checked against their own epochs, including undispatched admissions.
Valid historical releases are accepted; wrong-epoch release is CRITICAL/P1; missing
provenance and zero current-epoch observations are explicit UNKNOWN. Historical
violations remain visible after later deployments. Running-versus-expected release
and bound-worker rejection checks retain CRITICAL/P1. The authority check's mapping
is strengthened from historical-mix P2 to canonical-epoch violation P1.

## Activation protocol

[RELEASE_PROVENANCE.md](RELEASE_PROVENANCE.md) contains the ordering argument, writer
inventory, privilege boundary and operator procedure. Quiesce every binding ingress
and drain old work; apply migration in an authorized window; deploy worker/door;
verify parity; establish one activation using the dedicated database function;
verify committed state; reopen admissions; observe natural authorized current-epoch
work. No scheduler configuration/state change or synthetic task is required. Missing
provenance blocks transition qualification, and an idle epoch does not fake HEALTHY.

## Qualification

FACT: Full disposable regression: **645 passed, 51 existing intentional environment-gated
skips, 0 failed** (59 files; 435.79 seconds). Unit suite: **243 passed**. Final focused
qualification: **73 passed**, including **13 real-Postgres provenance tests** and
11 deterministic provenance tests. Typecheck, lint, build, execution-topology and
diff-whitespace checks passed. No newly introduced test is skipped.

Reproduce with `npm test`, `npm run test:unit`, and:

```powershell
npx vitest run tests/release-provenance.test.ts tests/release-provenance-postgres.test.ts tests/gateway.test.ts tests/execution-binding.test.ts tests/health-model.test.ts
```

The qualification includes:

- Deterministic shared-health cases, P1 alert mapping, running mismatch and rejection.
- Disposable Postgres concurrent pre/post boundary writers with pg_blocking_pids
  evidence, Read Committed late writes, stale stronger-isolation writers, rollback,
  replay, concurrent activation retries, immutability and privilege checks.
- Upgrade from the previous binding schema, preserving legacy contracts and absent
  insertion timestamps; the actual P1.3A release IDs are used in this regression.
- Gateway admission retries and all six workflow-bound ledger creation paths assert
  database provenance. Source inventory checks the sole runtime INSERT helper.
- Activation leaves canonical task, admission and schedule-fire counters unchanged.

Local Supabase security advisor against disposable Postgres reported zero errors and
only the pre-existing public.schedule_fire_bind_once mutable-search-path warning.
Both new functions have an explicit empty search_path, SECURITY INVOKER, and revoked
public/API-role execution grants. No production advisor or database was contacted.

## Review considerations

RECOMMENDATION: Review transaction ordering and the operational quiescence protocol
before merge. The single row serializes binding transactions and the health scan
covers full binding history; both are deliberate tradeoffs for current volume.
Database owners remain trusted, consistent with the existing ledger; this PR does
not introduce separate deployment/runtime database identities. Dedicated activation
transactions and a quiesced rollout are requirements, not automatic orchestration.

No known unresolved correctness failure remains in the completed qualification.
Production activation readiness is separate from code qualification.
