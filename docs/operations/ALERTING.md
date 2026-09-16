# KernelJSON production alerting (KJ-P1.2)

> Second result under **KernelJSON Production Operations Hardening**, built directly
> on top of KJ-P1.1's health model (`docs/operations/HEALTH_MODEL.md`). This
> document covers KJ-P1.2 only: a deterministic alerting layer over the existing
> health model. No Mission Control, no auto-remediation, no new capabilities, no
> resolution of the Shared Brain/B1 observability gap.

## What it answers

**"Which health changes require human attention, at what severity, and should we
notify now?"** — `npm run alerts` runs the P1.1 health model, then decides, per
check, whether anything changed enough to be worth telling a human about.

## Architecture

```
services/kernel/src/alerting/
  types.ts           AlertSeverity, AlertDecision, AlertStateRow, AlertPolicyEntry, Notifier
  fingerprint.ts      deterministic (checkId, entityId) -> fingerprint
  policy.ts            the explicit check-id -> severity policy table
  reducer.ts           PURE — (existing state row | null, fresh CheckResult) -> (next row, decision | null)
  state-store.ts        AlertStateStore interface + InMemoryAlertStateStore
  pg-state-store.ts      PgAlertStateStore (the canonical persistent store — see "Persistence")
  select-store.ts         ALERT_STATE_STORE mode parsing + fail-closed store selection
  notifier.ts            Notifier interface + ConsoleNotifier + RecordingNotifier (test helper)
  format.ts               human-readable alert/recovery text
  engine.ts                async orchestration: health report -> decisions, via a store + optional notifier
  cli.ts                    `kerneljson alerts` entrypoint
```

Same collect/evaluate split discipline as P1.1: `reducer.ts` is 100% pure (no I/O),
so the entire episode lifecycle — first detection, dedup, escalation,
de-escalation, recovery, recurrence — is exhaustively unit-tested with synthetic
`CheckResult`s and state rows (`tests/alerting-model.test.ts`, 20 tests). Only
`engine.ts` (store + notifier orchestration), `pg-state-store.ts`, `select-store.ts`,
and `cli.ts` touch I/O.

## Severity model

```
P0 = authority corruption / runaway execution / unsafe production behaviour
P1 = critical production execution or scheduler outage
P2 = degraded service / repeated retry / evidence or release issue needing attention
P3 = operational warning / observability gap / non-urgent degradation
```

**Deliberately not a blind 1:1 map from `HealthStatus`.** Two checks can both be
`CRITICAL` and warrant very different severities — e.g.
`scheduler.noDuplicateFireWindow` CRITICAL (the double-admit invariant broke) is
P0, while `evidence.toolReceiptPresentWhereRequired` CRITICAL (one task's evidence
is incomplete) is P2. `services/kernel/src/alerting/policy.ts` is the single
source of truth: one entry per check id, each carrying an explicit `rationale`
string. Reproduced here for the checks KJ-P1.2 explicitly requires:

| Check id | CRITICAL | DEGRADED | UNKNOWN | Why |
|---|---|---|---|---|
| `scheduler.nextWakeArmedAndFuture` | P1 | P2 | — | self-rearm chain stopped = scheduler outage |
| `scheduler.noDuplicateFireWindow` | P0 | — | — | double-admit invariant broke — proven-dangerous in S1-R |
| `scheduler.noZeroDelayLoop` | P0 | — | — | exact signature of the S1B zero-delay loop defect |
| `scheduler.scheduleEnabled` | P1 | — | — | canonical schedule not in expected state |
| `authority.bindingReleaseConsistent` | — | P2 | P3 | release hygiene, not an active violation |
| `authority.admittedFiresHaveCanonicalTasks` | P0 | — | — | scheduler minted without KJ — direct authority breach |
| `releaseParity.matchesExpected` | P1 | — | — | wrong release running is critical, not corruption |
| `restate.noStuckInvocation` | P1 | — | — | recurring chain stalled |
| `admission.doorReachable` | P1 | — | P3 | new admission blocked entirely |
| `execution.workerRegistered` | P1 | — | — | worker execution outage |
| `database.reachable` | P1 | — | — | system is DOWN, not doing something wrong — P1 not P0 |
| `evidence.toolReceiptPresentWhereRequired` | P2 | — | — | evidence-completeness gap |
| `evidence.digestMatchesApproved` | P1 | — | — | real integrity signal, more than bookkeeping |
| `legacyAuthority.b1FreezeObservable` | P0 | — | P3, **notify: false** | known, permanent, documented gap — see "Known gaps" |

The full table (all ~30 check ids, every `rationale`) is `policy.ts` itself —
treat that file, not this table, as canonical; this is a snapshot for readability.
A check id with no explicit entry falls back to a conservative default (`CRITICAL`
only, P2) rather than silently alerting nothing — see `resolvePolicy`'s
`DEFAULT_POLICY`.

## Fingerprinting

`fingerprint = sha256(checkId + "\n" + entityId)`, truncated to 32 hex chars
(`\n` chosen in KJ-P1.2B — explicit, printable, greppable in source; neither
field is ever user-controlled, so there's no delimiter-injection concern).
**Deliberately excludes severity and the raw `observed` value.** A worsening or
improving severity on the same underlying problem must stay the *same* episode (so
it can be tracked as an `ESCALATED`/`DEESCALATED` event on it), not spawn an
unrelated fingerprint; and `observed` legitimately changes between otherwise
identical failures (e.g. `scheduler.noZeroDelayLoop`'s `observed` is a list of
completion timestamps) — fingerprinting on that would defeat dedup entirely.

`entityId` resolution (`resolveEntityId`) is deliberately simple: this system has
exactly one production deployment and one canonical schedule today, so every
check resolves to the same entity id (the canonical schedule id). If a second
schedule is ever added, this would need to become check-specific.

## Deduplication / episode lifecycle

One state row per fingerprint — the identity of "this specific problem persisting
over time," tracked in `AlertStateRow` (`currentState: OPEN | RECOVERED`,
`firstSeenAt`, `lastSeenAt`, `lastNotifiedAt`, `occurrenceCount`, `recoveredAt`).
`reducer.ts`'s `reduceCheck` is the single place every transition is decided:

| Prior state | New status | Result | Notifies? |
|---|---|---|---|
| none | HEALTHY | nothing tracked | no |
| none | unhealthy | **NEW** episode opens | per policy (`notify !== false`) |
| OPEN, same severity | still unhealthy | **ONGOING** — occurrence count bumped | **no** (dedup) |
| OPEN | severity got worse | **ESCALATED** | per policy |
| OPEN | severity got better, still unhealthy | **DEESCALATED** | per policy |
| OPEN | HEALTHY | **RECOVERED**, episode closes, duration computed | per policy |
| RECOVERED | HEALTHY | nothing (no decision at all) | no — never spams recovery |
| RECOVERED | unhealthy | **NEW** episode reopens (`firstSeenAt`/`occurrenceCount` reset) | per policy |

This is exactly "recurrence after recovery alerts again": a fingerprint's identity
survives across episodes, but each episode's own clock and counter start fresh.

## Recovery

A `RECOVERED` decision carries `durationMs` (episode length: `firstSeenAt` of that
episode to the recovery timestamp) and its own message
(`"<checkId> recovered — <check's own message>"`). Recovery closes the *specific*
open episode that was failing — it never manufactures a recovery for a check that
was never open, and a second consecutive healthy run is a silent no-op (see the
"repeated healthy state does not spam recovery" test).

## Persistence

`AlertStateStore` interface, two implementations, selected by
`ALERT_STATE_STORE=postgres|memory` (`select-store.ts`):

- **`ALERT_STATE_STORE=postgres` — the default when unset.** Durable
  persistence is the production-safe default; `memory` must be explicitly
  requested, never assumed. This mode constructs `PgAlertStateStore` (typed
  against `kernel_private.alert_state`,
  `supabase/migrations/20260915220000_alert_state.sql`) and **probes it before
  use** (`PgAlertStateStore.probe()` — a cheap `select ... limit 1`). If the
  table doesn't exist (the migration hasn't been applied yet — Postgres error
  `42P01 undefined_table`), `probe()` throws `AlertStateStoreUnavailableError`
  with a message naming the migration; `select-store.ts` lets this propagate
  rather than catching it and silently substituting memory. Any OTHER probe
  failure (a genuine connectivity/auth problem) is also left un-swallowed, as
  its original error — never relabelled as "migration missing" when it might be
  something else entirely. **A durable-mode caller getting silent ephemeral
  behaviour instead of a clear failure would be worse than the failure itself.**
- **`ALERT_STATE_STORE=memory`** — explicit opt-out, for local/dev/smoke work
  only. Returns `InMemoryAlertStateStore`; the DB is never touched for alert
  state. Every deterministic test uses this (or a mocked `pg.Pool` for the
  store-selection contract itself — see
  `tests/alerting-store-selection.test.ts`).

**The migration itself remains PREPARED, NOT APPLIED to production.** Per the
KJ-P1.2 authorisation ("do not mutate production during this phase unless
explicitly authorised later"), `20260915220000_alert_state.sql` has not been run
against production — exactly like `20260910180000_scheduler.sql` was prepared
long before S1 schedule enablement happened. This means `kerneljson alerts` run
against production **today, with the default `postgres` mode, correctly fails
closed** (`AlertStateStoreUnavailableError`) rather than silently running in
ephemeral mode — proven live, read-only, against real production (see the
KJ-P1.2 persistence-fix result doc). Applying the migration — so durable
production alert-state actually starts accumulating — is a separate, future,
explicitly-authorised change window.

Cross-process persistence itself (two independent `PgAlertStateStore`
instances/connections against the same database correctly dedupe, recover, and
reopen episodes) is proven in
`tests/alerting-postgres.integration.test.ts`, gated on `KJ_TEST_PG_URL`
against a disposable local Postgres — never production.

## Notifier abstraction

`Notifier` is one method: `notify(decision): Promise<void>`. Two implementations
ship: `ConsoleNotifier` (stdout — the only wired transport) and `RecordingNotifier`
(collects decisions in memory, used by tests and the CLI's `--json` mode). The
engine works with **no notifier at all** — `AlertEngineOptions.notifier` is
optional — so alert *evaluation* never depends on a transport existing.
Telegram/WhatsApp/email/Slack are deliberately NOT wired: out of scope for this
phase, and adding one is a separate decision with its own credentials/review, not
something to bolt on here.

## Output shapes

Machine-readable (`--json`):
```json
{
  "severity": "P1",
  "fingerprint": "…",
  "checkId": "scheduler.nextWakeArmedAndFuture",
  "message": "Enabled production schedule has no valid future wake — …",
  "notify": true
}
```

Human-readable:
```
P1 Scheduler
Enabled production schedule has no valid future wake — …
First seen: 10:03
Last seen: 10:08
Occurrences: 2
Notification sent: yes
```
```
RECOVERED
Scheduler: scheduler.nextWakeArmedAndFuture recovered — …
Duration: 9m 14s
```

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
  npm run alerts
```

Same env-var surface as `kerneljson health` (it runs the health model internally
first). `--json` prints machine-readable decisions only, and suppresses the
`ConsoleNotifier` (nothing is "sent" in JSON mode — the caller decides what to do
with the decisions). Add `ALERT_STATE_STORE=memory` for local/dev/smoke work —
without it, the default `postgres` mode will fail closed until the migration
above is applied to whichever database `DATABASE_URL` points at.

## Known gaps

- **No durable production alert-state yet** — see "Persistence". The wiring and
  the store are complete and cross-process persistence is proven against a
  disposable Postgres; what's still pending is applying the migration to
  production itself (a separate, explicitly-authorised change window). Until
  then, `kerneljson alerts` run against production correctly fails closed
  rather than silently running ephemeral — it does not yet run at all in
  `postgres` mode against production, by design.
- **`legacyAuthority.b1FreezeObservable` never notifies, by policy** (`notify:
  false`) — it is still tracked (a state row exists, `occurrenceCount`
  increments), but deliberately never reaches a notifier. This is the same
  known, documented, permanent gap from KJ-P1.1 (no Shared Brain credentials in
  this module) — alerting on a gap we already know about and can't act on in this
  phase would be pure noise. If it's ever wired up and genuinely reports
  `CRITICAL` (the freeze visibly broke), the policy notifies normally at P0.
- **No transport beyond stdout.** `ConsoleNotifier` is the only wired notifier.
- **No periodic re-notification for a long-open P0/P1.** An episode that stays
  open at the same severity dedupes indefinitely (by design, per the required
  test list) — there is no "still down after N minutes, remind me anyway" timer
  in this phase. Worth considering for a future phase if silent long-running
  outages become a real risk; not built here to avoid scope creep beyond what
  KJ-P1.2 asked for.
