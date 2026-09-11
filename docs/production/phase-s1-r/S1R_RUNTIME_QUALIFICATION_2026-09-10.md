# Phase S1-R — Runtime Qualification Report (2026-09-10)

> **SUPERSEDED (2026-09-11).** This report recorded FAILED at the FK bind gap — the
> state BEFORE the Option B fix (`814314b`, which retargeted the fire FK to
> `kernel_private.task_admissions(task_id)`). Option B landed, the bind now completes,
> and the LIVE Restate runtime qualification PASSED. See
> `S1R_LIVE_RUNTIME_QUALIFICATION_2026-09-11.md` and `RESTATE_LIVE_EVIDENCE.json`.
> This document is retained as the historical record of the pre-Option-B blocker.

> Branch `feat/phase-s1-restate-boundary`. Executed against REAL Postgres
> (disposable `postgres:17.6`, compose project `kerneljson-validation`, tmpfs, on
> 127.0.0.1:55432) and the REAL KernelJSON admission door (`apps/gateway/src/server.ts`).
> No production Supabase. No Restate server started (see §5). Docker: existing
> daemon only (`docker info` healthy); no Docker Desktop lifecycle management.
> Tags: FACT · INFERENCE · RECOMMENDATION. Tiers: EXECUTED · SPECIFIED/UNEXECUTED.

## Verdict: S1-R RUNTIME QUALIFICATION FAILED

The end-to-end chain **Restate wake → deterministic fireIdentity → createOrGetFire
→ lease claim → current LeaseFence → KernelJSON Admission → canonical taskId →
bindAdmission → persisted state** does **not** complete against real infrastructure.
A CONFIRMED foreign-key/materialisation gap blocks the `bindAdmission` step. The
boundary DESIGN, the admission door, `createOrGetFire` dedupe and lease fencing are
each runtime-proven; the bind is not. This is a fixable schema/lifecycle gap, not an
architectural dead-end.

## What PASSED at runtime (EXECUTED, real Postgres)

1. **Gateway admission door** — `tests/gateway.test.ts` 15/15 against the real DB
   (replay → same taskId; 5 concurrent identical → one taskId; UNRESOLVED dispatch
   then retry → same taskId; same key + changed payload → 409). Converts the
   previously STATICALLY-VERIFIED gateway evidence to fresh runtime evidence.
2. **Scheduler → admission identity mapping** — `tests/schedule-restate-runtime.integration.test.ts`
   sends `Idempotency-Key = fireIdentity`: 5 concurrent → 1 canonical taskId, replay
   → same taskId, changed payload → 409. FACT (RESTATE_RUNTIME_EVIDENCE.json →
   `admission_mapping`).
3. **createOrGetFire dedupe on real Postgres** — a duplicate `(scheduleId, version,
   fireWindowKey)` insert resolves to the existing row (`created:false`), one fire
   row. FACT (`createOrGetFire_dedupe`).
4. **Lease fencing on real Postgres** — after an epoch takeover (0 → 1), a stale-fence
   `bindAdmission` is rejected with `StaleFenceError` (DB `UPDATE 0`). The S1-F2
   invariant holds through the driver. FACT (`fencing`).

## The CONFIRMED BLOCKER (FACT, RESTATE_RUNTIME_EVIDENCE.json → `bind_blocker`)

The admission door mints a **deterministic** `taskId` and records it in
`kernel_private.task_admissions`, but does **not** write `public.tasks` synchronously
— that row is materialised later by the Restate workflow/ledger during execution.
So when the driver performs the fenced bind, it fails:

```
insert or update on table "schedule_fires" violates foreign key constraint
"schedule_fires_admitted_child_task_id_fkey"
```

because `schedule_fires.admitted_child_task_id uuid references public.tasks(id)` and
the admitted task is in `task_admissions` (rowcount 1) but not yet in `public.tasks`
(rowcount 0). The in-memory fakes could not surface this (no FK; the fake gateway
returned a random id), which is precisely why runtime qualification was required.

Note (INFERENCE): the existing `FireState` enum already contains `ADMISSION_PENDING`,
which suggests the intended lifecycle is two-phase and the current single-step
`bindAdmission` (which sets `admitted_child_task_id` at admission time) is premature.

## Recommended resolutions (Jonny's design decision — not applied)

- **Option A — two-phase bind (recommended; aligns with the `ADMISSION_PENDING` enum).**
  At admission time record `admission_request_id` (= fireIdentity) and set state
  `ADMISSION_PENDING` with `admitted_child_task_id` NULL (no FK). Set
  `admitted_child_task_id` + state `ADMITTED` later, once the child task materialises
  in `public.tasks` (a fenced reconciliation step). Touches `store.ts`/`pg-store.ts`
  (a new fenced method) — i.e. PR #7's S1-F2 contract.
- **Option B — retarget the FK** `schedule_fires.admitted_child_task_id →
  kernel_private.task_admissions(task_id)` so the fire binds the ADMITTED identity
  (which exists synchronously). One-line migration change to PR #7's
  `20260910180000_scheduler.sql`.

Both touch PR #7 artefacts already PROVEN IN POSTGRES, and the choice is an
authority-model decision (bind the admission vs bind the executed task). Left for
Jonny; **not applied** on the S1-R branch.

## Test layers (do not bury skips)

| Layer | Count | Status |
|---|---|---|
| PURE (scheduler core) | 29 | EXECUTED |
| SIMULATION | 13 | EXECUTED |
| IN-MEMORY PERSISTENCE | 12 | EXECUTED |
| TYPE FENCING (compile-time guard) | 1 | EXECUTED |
| S1-R BOUNDARY (pure) | 14 | EXECUTED |
| S1-R0 ADMISSION IDENTITY (pure) | 4 | EXECUTED |
| POSTGRES (scheduler integration) | 9 | committed evidence; not re-run this session (SKIP w/o DB) |
| POSTGRES FENCING | 8 | committed evidence; not re-run this session (SKIP w/o DB) |
| GATEWAY ADMISSION (real Postgres) | 15 | EXECUTED this session |
| S1-R RUNTIME (real Postgres + real door) | 4 | EXECUTED this session (3 prove; 1 documents the blocker) |
| RESTATE RUNTIME (live server durable timer) | 0 | SPECIFIED / UNEXECUTED (see §5) |
| END-TO-END REPLAY/RECOVERY | 0 | BLOCKED by the bind gap |

## §5 Why no live Restate server was started

Restate durable-timer **liveness** (a real `restatedev/restate:1.7.9` server delivering
a durable wake and resuming across restart) was NOT executed. It would drive the same
wake handler whose bind FK-fails, so it can only reproduce the blocker, not clear it.
The correct order is: resolve the bind gap (Option A/B), then run the Restate-server
liveness + end-to-end replay/recovery proofs (scenarios A–M). Plan for that step:
implement `RestateDurableTimerRuntime` behind the `DurableTimerRuntime` interface +
a real `AdmissionGateway` (POST `/v1/tasks`, `Idempotency-Key = fireIdentity`), bring
up the disposable `restate` service, kill/restart to prove durable delivery + journaled
resume. GATED — awaiting Jonny's go and the bind-fix decision.

## Teardown / safety
Per-test databases (`s1r_<uuid>`) dropped in `afterAll`. Disposable compose `db`
brought down after qualification. Unrelated containers (e.g. `supabase_*`) untouched.
Production contacts = ZERO. Production mutation = NONE.
