# KJ-P1.2A — production alert-state migration activation (PASS)

Date: 2026-09-16. Status: **PASS.** `supabase/migrations/20260915220000_alert_state.sql`
is applied to canonical KernelJSON production. Durable, cross-process alert-state
persistence is proven live: two independent process invocations against the same
production table correctly dedupe, share the same fingerprint/episode, and
advance the occurrence count — with zero notifier call, zero schedule mutation,
zero production degradation. This is the first real production database write in
the KernelJSON Production Operations Hardening programme.

---

## 1. Preconditions confirmed (read-only precheck, before any mutation)

- Canonical `main` = `1d44d4486f1b5005f6dd0058ad591c9df16d4fe0` (PR #28, KJ-P1.2B,
  squash-merged) — verified as `origin/main`'s tip before proceeding.
- Target confirmed as canonical KernelJSON production Supabase project
  (`banqdzddfganzfhckdps`) — corroborated by this repo's own
  `supabase/.temp/linked-project.json` link and multiple existing production
  runbooks, explicitly distinct from the Shared Brain project
  (`lkwydqtfbdjhxaarelaz`), a different product. Note: this session's Supabase
  MCP connector has no scope on `banqdzddfganzfhckdps` (only the Shared Brain
  and an inactive project are visible to it) — consistent with the same
  connector-scope limit recorded during the original scheduler-migration
  runbook (`docs/production/phase-s1-canary/GATE2_OPTION_A_EXECUTION_PACKAGE_2026-09-11.md`).
  Applied via the direct-Postgres route instead: a script executed inside a
  production container that already holds `DATABASE_URL`, the same
  secret-safe pattern used for every KernelJSON production DB read/write this
  entire programme.
- `kernel_private.alert_state`: confirmed absent (`42P01 undefined_table`;
  `information_schema.tables` for `kernel_private` listed exactly 7 tables,
  none named `alert_state`).
- Scheduler: `enabled`, `active_version=v2`, `SCHED_ARM_NEXT=true`, next wake
  durably armed and future-dated. Production health: `criticalIssues: 0`,
  `degradedIssues: 0` — no P0/P1/P2 possible under any policy mapping.
  Worker/door/Restate: all healthy, all 4 expected services registered, no
  stuck invocation.
- `supabase_migrations.schema_migrations`: no row for version `20260915220000`
  or name matching `alert_state`; most recent entry was `20260910180000`
  (the scheduler migration).

No provenance or target ambiguity found. Proceeded to Phase B.

## 2. Migration application (Phase B)

- Mechanism: the exact migration file (`20260915220000_alert_state.sql`, byte
  verified against the committed repo copy) split into its 5 top-level
  statements and executed inside **one transaction** against production,
  followed by the tracking-row insert into `supabase_migrations.schema_migrations`
  in the **same transaction** — atomic: either the whole migration and its
  record commit together, or neither does. No unrelated pending migration was
  touched.
- Pre-flight guards inside the same script (fail closed, not assumed): refused
  to run if `kernel_private.alert_state` already existed, or if version
  `20260915220000` was already recorded.
- Result: **COMMITTED**.

**Post-apply schema verification (read-only), compared against the repository
migration file:**
- Columns: `fingerprint` (text, not null, PK), `check_id` (text, not null),
  `entity_id` (text, not null), `severity` (text, not null), `current_state`
  (text, not null), `first_seen_at`/`last_seen_at` (timestamptz, not null),
  `last_notified_at`/`recovered_at` (timestamptz, nullable),
  `occurrence_count` (integer, not null) — matches exactly.
- Indexes: `alert_state_check_id` (btree, check_id), `alert_state_current_state`
  (btree, current_state), `alert_state_pkey` (unique btree, fingerprint) —
  exactly the 2 explicit indexes plus the implicit PK index, matching the file.
- Constraints: the 2 cross-field CHECKs (`current_state='RECOVERED' or
  recovered_at is null`, `current_state='OPEN' or recovered_at is not null`),
  the `current_state` enum CHECK, the `severity` enum CHECK, the
  `occurrence_count > 0` CHECK, and the PRIMARY KEY — 6 constraints total,
  matching the file exactly.
- RLS: `relrowsecurity = true` (enabled, deny-by-default, no policies — same
  convention as every other `kernel_private` table).
- `supabase_migrations.schema_migrations`: exactly one new row, version
  `20260915220000`, name `alert_state`.
- Row count in the new table immediately after apply: **0**.

No unrelated schema change occurred anywhere else in the database.

## 3. Production store probe (Phase C)

Ran `kerneljson alerts` against production with `RESTATE_ADMIN_URL` and
`EXPECTED_RELEASE_ID` set (default `ALERT_STATE_STORE` — unset, i.e.
`postgres`, the canonical default). Exit code **0** — the probe succeeded, no
`AlertStateStoreUnavailableError`, no fallback to `InMemoryAlertStateStore`
(there is no fallback path in the code at all — `selectAlertStateStore` either
returns the real `PgAlertStateStore` or throws; exit 0 proves the former).
Production health evaluated correctly (see counts below): `legacyAuthority.b1FreezeObservable`
produced exactly one decision, `P3`/`notify: false`, no P0/P1/P2 decision
existed anywhere.

## 4. Durability proof (Phase D) — two independent process invocations

| | Run 1 (first ever) | Run 2 (independent process, ~68s later) |
|---|---|---|
| Exit code | 0 | 0 |
| Decisions returned | 1 (`kind: NEW`, `legacyAuthority.b1FreezeObservable`, P3, `notify: false`, `occurrenceCount: 1`) | **0** (`decisions: []` — deduped, no decision object at all, matching the reducer's `ONGOING` contract) |
| Persisted row (read-only query, immediately after) | fingerprint `3e8433950ceb79e2c6e35adede8c0ea1`, `current_state=OPEN`, `first_seen_at=2026-09-16T06:32:38.782Z`, `occurrence_count=1`, `last_notified_at=null` | **same fingerprint**, `current_state=OPEN` (unchanged), `first_seen_at=2026-09-16T06:32:38.782Z` (**unchanged** — proves it's the same episode, not a fresh one), `last_seen_at` advanced to `2026-09-16T06:33:46.980Z`, `occurrence_count=2`, `last_notified_at` **still null** |

This is the complete, genuine proof requested: the second independent process
read the first process's persisted row (real cross-process durability, not
in-memory luck), correctly identified it as the same fingerprint/episode
(`first_seen_at` unchanged), advanced the occurrence count exactly per reducer
semantics (dedup, not a fresh `NEW`), and never called a notifier for this
known `notify: false` condition across either run. No fake P0/P1/P2 fault was
induced anywhere to test this — the only tracked condition throughout was the
pre-existing, already-documented `legacyAuthority` gap.

Only one row exists in `kernel_private.alert_state` at all times during this
phase — no duplicate/orphaned rows.

## 5. Safety verification (Phase E)

| Check | Before | After | Result |
|---|---|---|---|
| `task_admissions_total` | 23 | 23 | unchanged |
| `schedule_fires_total` | 4 | 4 | unchanged |
| `schedule_state` (`state`/`active_version`/`updated_at`) | `enabled`/`v2`/`2026-09-14T21:23:23.562Z` | identical | unchanged — no schedule state/version mutation |
| Worker `RestartCount` | 0 | 0 | unchanged |
| Door `RestartCount` | 0 | 0 | unchanged |
| Restate `RestartCount` | 0 | 0 | unchanged |
| Restate invocations/fires | — | — | none created; `/fire/send` was never called anywhere in this phase |
| Manually created tasks | — | — | none — admissions count identical before/after |
| B1 (Shared Brain authority freeze) | — | — | untouched — zero queries/writes against the Shared Brain project anywhere in this phase |
| C1 (ledger hygiene) | — | — | untouched, same reason |
| Post-activation `kerneljson health` | — | `criticalIssues: 0`, all domains HEALTHY except the two expected benign UNKNOWNs (legacyAuthority's known gap; execution's worker-restart-count, not supplied this run) | no degradation |

All temporary files and the deployed compiled bundle were removed from the VM
and both containers after use.

## 6. Deviations

None. Every phase completed exactly as authorised, in order, with no STOP
condition triggered.

## 7. Canonical status after this record

- **KJ-P1.2A = PASS.** `kernel_private.alert_state` exists in production,
  schema-verified exact, and durable cross-process alert-state persistence is
  proven live.
- `ALERT_STATE_STORE` remains defaulted to `postgres`; production now runs in
  genuine durable mode rather than fail-closed.
- No external notifier transport added — `ConsoleNotifier` (stdout) remains
  the only wired transport, exactly as before.
- Not started: KJ-P1.3, or any further phase.
