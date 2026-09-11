# Phase S1-R — Restate Boundary Qualification (DESIGN-FIRST)

> Branch: `feat/phase-s1-restate-boundary` (off `feat/phase-s1-production-scheduler-mvp-prep`, kerneljson `0a268f2`).
> Status: DESIGN + INTERFACE + PURE TESTS. No Restate runtime, no Docker, no deploy,
> no PR #7 merge, no schedule enablement, no production, Phase 8.1 untouched.
> Claim tags: FACT (observed/executed) · INFERENCE · RECOMMENDATION.
> Evidence tiers: EXECUTED · STATICALLY VERIFIED · SPECIFIED / UNEXECUTED.

## 0. Purpose

Prove that Restate can provide **durable timer execution and workflow
continuation** for the S1 production scheduler **without becoming a second source
of schedule or task truth**. Restate is execution continuity; KernelJSON/Postgres
is the record. This document is the boundary; `services/kernel/src/scheduler/durable-timer.ts`
is the narrow, replaceable interface that encodes it; `tests/schedule-restate-boundary.test.ts`
is the executable proof of the architecture without a live Restate runtime.

The purpose is NOT "add Restate". Restate (`@restatedev/restate-sdk@1.17.0`) is
already the kernel's durable execution runtime for task workflows (FACT: `services/kernel/src/index.ts`
`restate.serve`, `workflow.ts`, `golden-workflow.ts`, `policy-workflow.ts`,
`executor/workflow.ts`). The S1 scheduler module does NOT use it yet (FACT:
`services/kernel/src/scheduler/index.ts` header; no `restate` import under
`services/kernel/src/scheduler/`). S1-R defines how the scheduler *would* use
Restate's durable timers while keeping schedule truth in Postgres.

## 1. Source-of-truth ownership (authority table)

| Concern | Owner (durable truth) | Restate role |
|---|---|---|
| `ScheduleSpec` (definition, versioned, immutable) | **Postgres** `schedule_specs` | none (reads via handler) |
| `ScheduleState` (enabled/paused/disabled, activeVersion) | **Postgres** `schedule_state` | none |
| `ScheduleFire` existence (one logical fire) | **Postgres** `schedule_fires` UNIQUE `(schedule_id,schedule_version,fire_window_key)` | none — never creates the row's authority |
| Fire idempotency identity | **Postgres**/deterministic: `idempotencyKey = scheduleId\|version\|fireWindowKey`; `fireIdentity = stableId(["kj-schedule-fire/v1",…])` | none — must reuse, never invent |
| Admission intent / canonical child task link | **KernelJSON Admission** + `schedule_fires.admitted_child_task_id` | none — never mints a task |
| Lease / fencing truth | **Postgres** `schedule_leases` `(owner, epoch)` | none — must hold the current fence, cannot bypass it |
| Task lifecycle / completion / evidence | **KernelJSON** (kernel ledger) | executes/continues steps only |
| **Durable timer waiting** ("wake at T for schedule S") | — | **Restate** owns |
| **Wake delivery** (at-least-once) | — | **Restate** owns |
| **Workflow continuation cursor** (where in wake→admit→bind we are) | — | **Restate** owns |
| Retrying transport/workflow steps | — | **Restate** owns (journaled `ctx.run`) |

**Restate MUST NOT own:** canonical `ScheduleFire` existence, canonical child task
identity, task admission, task completion authority, scheduler policy truth
(canFire / DST / windows — all re-derived from the Spec in Postgres), approvals,
or a second task queue.

## 2. Restate responsibility (precise)

Restate provides exactly one primitive to the scheduler: **a durable "wake me at
UTC time T for schedule S" with at-least-once delivery, that survives process
restarts, plus journaled continuation of the multi-step wake handler.** Everything
the handler then does is re-derived deterministically from Postgres. The Restate
timer is **semantically empty**: it carries "wake at T for S", never "what S means".

## 3. Deterministic timer / fire identity mapping (no parallel identity)

FACT (`services/kernel/src/scheduler/fire.ts`):
- `idempotencyKey(spec, fireWindowKey) = scheduleId | version | fireWindowKey`
- `fireIdentity(spec, fireWindowKey) = stableId(["kj-schedule-fire/v1", scheduleId, version, fireWindowKey])`
- `fireWindowKey` examples: `dailyAt/01:30|Europe/London|2026-09-11`, `everyNMinutes/5@<utcMs>`.

**Restate correlation keys (INFERENCE / design):**
- **Driver key** = `scheduleId`. One durable timer driver per schedule (a Restate
  Virtual Object keyed by `scheduleId`, or an equivalent keyed durable execution).
  The driver holds *only* the outstanding "next wake" and its continuation cursor.
  It re-reads the active spec/version from Postgres on every wake, so it carries no
  version-specific state that could go stale.
- **Wake key** = the next window's `idempotencyKey` (`scheduleId|version|fireWindowKey`).
  `scheduleWake` is idempotent on `(scheduleId, wakeKey)`; scheduling the same next
  window twice collapses to one timer.
- **Fire dedupe key** = `idempotencyKey` (DB UNIQUE) and `fireIdentity` (admission
  dedupe). There is **no random, independent timer identity** that could create
  parallel logical work: every wake maps deterministically back to a single
  `(scheduleId, version, fireWindow)`.

## 4. The wake → admission path (Restate can NEVER mint a task)

On each durable wake for `scheduleId`, the journaled handler runs (each step a
`ctx.run` durable action in the real impl):

1. **Claim/hold lease** → `LeaseFence {owner, epoch}` (`store.claimLease`). If not
   ours, abort — another worker owns this schedule.
2. **Read truth** `store.getSchedule(scheduleId)` → active `PersistedScheduleSpec` +
   `PersistedScheduleState`. [Postgres is truth]
3. **Gate** `canFire(runtimeSpec, {productionRuntime})` — disabled/paused/not-
   enabled-for-production ⇒ no admission.
4. **Enumerate** `dueFireWindows(runtimeSpec, cursor, now)` — deterministic, DST-correct.
5. For each due window (forward-only, `fireAtUtc > cursor`):
   a. `store.createOrGetFire(...)` — DB UNIQUE ⇒ one logical fire; `created:false`
      on any duplicate/replay.
   b. If already `ADMITTED` ⇒ REPLAY, skip (idempotent).
   c. Else `admission.admit({admissionIdentity: fireIdentity, …})` → canonical
      `childTaskId`. **KernelJSON Admission is the sole minter; it dedupes on
      `fireIdentity`.** The scheduler/Restate never generate a task id.
   d. `store.bindAdmission(idempotencyKey, {admissionRequestId: fireIdentity,
      childTaskId, at}, fence)` — **DB-fenced**; stale fence ⇒ `UPDATE 0` ⇒
      `StaleFenceError`; bind-once trigger blocks any rebind to a different task.
6. **Advance cursor**, `timers.scheduleWake(scheduleId, nextWakeKey, nextFireAtUtcMs)`.

Because (a) is idempotent, (c) dedupes on `fireIdentity`, and (d) is fenced +
bind-once, **any number of double wakes / replays / mid-handler crashes converge to
one logical `ScheduleFire`, one admission identity, one canonical child task.**

**Load-bearing requirement (RECOMMENDATION / open item):** KernelJSON Admission
MUST be idempotent on an externally supplied dedupe key = `fireIdentity`, returning
the same `childTaskId` on repeat. `runtime.ts::AdmissionSink` models exactly this
("a repeated identity is refused"). If the real Admission lacks this, exactly-once
degrades to "the DB fire row + bind-once trigger prevent double-binding, but a
duplicate admission could mint two tasks that race to bind, orphaning the loser."
**Confirm KJ Admission supports an idempotency key before runtime qualification.**

## 5. Failure / reconciliation matrix

For each: which component wins, how reconciliation works, and whether duplicate
canonical work is possible. **Required answer everywhere: NO duplicate canonical work.**

| # | Failure | Winner | Reconciliation | Dup work? |
|---|---|---|---|---|
| 1 | Restate wake delivered twice | Postgres | 2nd `createOrGetFire` ⇒ `created:false`; admission dedupes on `fireIdentity` | NO |
| 2 | Wake replay after Restate restart | Postgres | handler re-runs from journal; same idempotencyKey/fireIdentity | NO |
| 3 | Acknowledgement lost | Postgres | at-least-once redelivery ⇒ case #1 | NO |
| 4 | Restate crashes before DB write | Postgres | nothing written; replay creates the fire once | NO |
| 5 | Crash after `createOrGetFire`, before admit | Postgres | replay: fire exists (`created:false`), not yet admitted ⇒ admit once | NO |
| 6 | Crash after KJ admission commits, before bind | KJ/Postgres | replay: admission dedupes ⇒ same `childTaskId`; bind binds once | NO |
| 7 | Postgres temporarily unavailable | Postgres | handler step fails; Restate retries the `ctx.run` until DB back; no fabricated state | NO |
| 8 | KJ Admission temporarily unavailable | KJ | admit step retried; fire stays `PLANNED`/`ADMISSION_PENDING` until admit succeeds | NO |
| 9 | Restate thinks timer fired but no `ScheduleFire` exists | Postgres | handler simply `createOrGetFire` (creates) then admits — a wake is only "evaluate now" | NO |
| 10 | `ScheduleFire` exists but Restate lost workflow state | Postgres | driver restart re-reads fires + cursor from DB, recomputes next wake; never repairs DB from memory | NO |
| 11 | Lease expires during continuation | Postgres | fenced mutation with stale epoch ⇒ `UPDATE 0`/`StaleFenceError`; new owner proceeds | NO |
| 12 | Stale Restate continuation wakes after another worker took ownership | Postgres | epoch bumped on takeover; late continuation fenced out | NO |
| 13 | Clock / DST interaction | Postgres (spec) | windows re-derived by `dueFireWindows` (DST gap/fold handled); `everyNMinutes` is fixed-UTC | NO |
| 14 | Schedule paused while a timer already exists | Postgres | on wake `canFire` false ⇒ no admission; driver holds/stops rescheduling | NO |
| 15 | Schedule version changes while an old timer exists | Postgres | wake re-reads active version; windows computed forward from cursor under the NEW version; old already-fired slots are before cursor ⇒ not re-fired; identities include version | NO |
| 16 | Cancelled schedule with outstanding timer | Postgres | on wake state=disabled ⇒ no admission; `cancelWake`; already-admitted child tasks follow KJ lifecycle | NO |
| 17 | Backfill interacting with Restate timers | Postgres | backfill is a separate human-approved, bounded, DB-CHECK path; a coinciding window shares the identity scheme ⇒ `createOrGetFire` dedupes to one fire | NO |

## 6. Reconciliation law

When Restate state and Postgres schedule state disagree, **Postgres/KernelJSON wins.**
Restate reconciles to canonical state (recompute the next wake from DB). Canonical
state is NEVER repaired merely because Restate believes something should exist.
Restate is execution continuity, not truth.

## 7. Lease fencing integration (S1-F2 survives)

Every ownership-sensitive mutation in the wake handler (`bindAdmission`,
`transition`, `releaseLease`) goes through the fenced `ScheduleStore` methods, which
**require** a `LeaseFence` at the type level (FACT: `store.ts`; compile-time tripwire
`tests/schedule-fencing-types.test.ts`) and are DB-enforced (`UPDATE … FROM
schedule_leases WHERE l.owner=$ AND l.epoch=$`). A Restate replay/continuation
holding a stale fence (epoch N) after a takeover (epoch N+1) updates zero rows and
fails closed. Restate replay CANNOT bypass fencing. The `PrivilegedScheduleStore`
unfenced path is off the runtime interface and is not used by the driver.

Design (INFERENCE): `LeaseFence.owner` = the driver instance id, claimed at lease
time; takeover bumps the epoch; a late continuation's `(owner, epoch)` no longer
matches ⇒ fenced.

## 8. Schedule-change semantics (no old timer creates new-version work silently)

Because the timer is semantically empty and the handler re-reads the active
spec/version each wake:
- **disabled / cancelled**: `canFire` false ⇒ no admission; `cancelWake`.
- **paused**: `canFire` false ⇒ no admission; timer may hold a light resume-check
  cadence; no fires while paused.
- **version replaced**: handler reads the new `activeVersion`; windows computed
  **forward from the fire cursor**; a civil slot already fired under v1 is before the
  cursor and is not recomputed; new windows carry v2 identity (distinct namespace —
  FACT: version-namespace proven in Postgres evidence, 2 rows). The **cursor** (not
  the version) prevents re-firing a past slot.
- **timezone / trigger expression changed**: these are semantic changes ⇒ a new
  version (spec is immutable per version). Reduces to the version-replaced case.

## 9. Adapter / interface design (Restate replaceable)

`DurableTimerRuntime` (narrow, in `durable-timer.ts`):
```
scheduleWake(scheduleId, wakeKey, fireAtUtcMs): Promise<void>   // idempotent per (scheduleId, wakeKey)
cancelWake(scheduleId, wakeKey): Promise<void>
observe(scheduleId): Promise<Array<{ wakeKey; fireAtUtcMs }>>    // for reconciliation on restart
```
Kernel scheduler code depends on this interface, not on `@restatedev/restate-sdk`.
The Restate implementation (`RestateDurableTimerRuntime`, SPECIFIED / UNEXECUTED)
lives behind it; `InMemoryDurableTimerRuntime` drives the pure tests. Restate SDK
calls do not scatter across core scheduling logic. Restate is replaceable (a cron
poller calling the same handler is a valid, if less durable, substitute).

`AdmissionGateway` (models KernelJSON Admission; the sole task minter):
```
admit({ admissionIdentity, scheduleId, version, fireWindowKey, at }): Promise<{ childTaskId; deduped }>
```
The driver obtains a `childTaskId` **only** from `admit`; it has no task-minting
capability. This is the structural proof that Restate/the scheduler cannot mint.

## 10. Removability test (hard rule)

**"If Restate disappeared tomorrow, would KernelJSON still know every schedule,
fire, child task, admission identity, lease/fence and task state?" → YES (FACT by
construction).** All of that lives in Postgres (`schedule_specs`, `schedule_state`,
`schedule_fires`, `schedule_leases`) and the kernel task ledger. Restate holds only
outstanding durable timers and in-flight continuation cursors. Losing Restate loses
future durable wake *delivery* until another `DurableTimerRuntime` replaces it — no
schedule truth is lost. The S1 scheduler module is already isolated (FACT: nothing
outside `services/kernel/src/scheduler/` imports it); the adapter keeps Restate
removable.

## 11. Test strategy

**EXECUTED (pure/interface-level, no Restate runtime, no Docker)** —
`tests/schedule-restate-boundary.test.ts` against `InMemoryScheduleStore` +
`InMemoryDurableTimerRuntime` + an idempotent in-memory `AdmissionGateway`: matrix
rows 1,2,4,5,6,9,10,11,12,14,15,16,17 plus "scheduler cannot mint" and
"removability = DB holds all truth".

**SPECIFIED / UNEXECUTED (needs real Restate runtime + throwaway Docker Postgres —
STOP for approval first):**
- real Restate durable timer survives a process kill and re-delivers the wake;
- journaled `ctx.run` steps resume across a crash against real Postgres;
- at-least-once wake with real DB dedupe end-to-end;
- DST/real-clock durable timer over a real interval;
- `RestateDurableTimerRuntime` conformance to `DurableTimerRuntime`.

Do NOT give Restate a green qualification on diagrams. The interface-level proof
qualifies the *architecture/boundary*; the runtime proof (pending) qualifies the
*Restate integration*.

## 12. Standing constraints honoured

No Restate runtime started · no new Docker services · no deploy · PR #7 not merged ·
no schedule enabled · production untouched · Phase 8.1 untouched · scheduler stays
isolated/removable · LeaseFence never optional.

## 13. Open items / recommendations

1. **[RECOMMENDATION, blocking runtime qual]** Confirm KernelJSON Admission accepts
   an idempotency key (= `fireIdentity`) and returns the same `childTaskId` on
   repeat (see §4). This is the load-bearing assumption for exactly-once.
2. **[RECOMMENDATION]** Persist the fire cursor (`last_fired_window_utc`) in
   `schedule_state` for efficient forward-only enumeration; a migration addition,
   deferred to the runtime-qualification change window (design uses an explicit
   cursor parameter meanwhile).
3. **[RECOMMENDATION]** Choose the Restate shape (Virtual Object keyed by
   `scheduleId` vs workflow-per-window) at runtime-qualification time; the boundary
   is shape-independent.
