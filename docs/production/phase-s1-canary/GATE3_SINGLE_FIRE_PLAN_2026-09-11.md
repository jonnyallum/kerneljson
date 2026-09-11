# S1 Canary Gate 3 — single controlled production fire (PLAN ONLY)

Date: 2026-09-11 (Europe/London). Author: Claude B (takeover; planner).
Scope: **PLAN ONLY. No production mutation. Gate 3 is NOT authorised to execute.** This
document prepares the exact path to authorise EXACTLY ONE production fire of the disabled
canary `claude_md_check`, and to return it to a safe (disabled) state, with full idempotency,
fencing and evidence. Nothing here enables, fires, deploys, or executes.

Gate 2 result: PASSED (disabled canary installed and verified) — see
`GATE2_OPTION_A_EXECUTION_PACKAGE_2026-09-11.md` section 7.

---

## 1. Objective

Prove, once, in production:

```
disabled -> explicitly enabled for one controlled run
  -> ONE deterministic ScheduleFire
  -> KernelJSON Admission (Idempotency-Key = fireIdentity)
  -> ONE canonical child task
  -> execution -> evidence -> completion
  -> re-invocation is a pure replay (no duplicate fire / admission / task)
  -> canary returned to disabled / safe state
  -> zero unrelated mutations
```

## 2. Fixed identities (immutable, from Gate 2)

| Item | Value |
|---|---|
| Production project ref | `banqdzddfganzfhckdps` |
| Schedule | `claude_md_check` |
| scheduleId | `acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b` |
| Owner (HUMAN) | `da5c6dfc-38c5-4773-bd47-5c80ed908d75` |
| Tenant (estate) | `5f970749-7507-894b-a2e4-872ce20a94b7` |
| Current active version | `v1` (`enabled_for_production=false`, `state=disabled`) |
| Approved CLAUDE.md digest (LF SHA-256) | `27255772beb1418e462fe262a2a747c53bf6a34973c3ad75907f7505a32f2b10` (Gate 1.5) |

## 3. Mechanism (grounded in reviewed code)

The production wake path is `ScheduleTimerDriver.onWake` ([durable-timer.ts:190](../../../services/kernel/src/scheduler/durable-timer.ts#L190)):

```
getSchedule (truth, Postgres)
  -> canFire (gate)                         policy.ts:15
  -> claimLease (LeaseFence owner+epoch)    pg-store.ts:249
  -> for each due window (processWindowUnderFence, durable-timer.ts:268):
       createOrGetFire  (DB unique, ON CONFLICT do nothing)   pg-store.ts:122
       admit            (POST /v1/tasks, Idempotency-Key=fireIdentity)  http-admission.ts:56
       bindAdmission    (fenced UPDATE join schedule_leases; bind-once trigger)  pg-store.ts:162
  -> scheduleWake(next)  (armNext only; off for single-shot)
```

- **fireIdentity / idempotencyKey** are content-derived and version-bound:
  `idempotencyKey = scheduleId|version|fireWindowKey`; `fireIdentity =
  stableId(["kj-schedule-fire/v1", scheduleId, version, fireWindowKey])`
  ([fire.ts:29](../../../services/kernel/src/scheduler/fire.ts#L29)). The same `(spec, window)`
  always yields the same identity.
- **Restate** owns only the durable wait + at-least-once wake + journaled continuation
  ([restate-service.ts](../../../services/kernel/src/scheduler/restate-service.ts)); it holds no
  schedule/fire/task truth. The scheduler core imports no Restate SDK. This boundary is
  qualified LIVE (PASSED) across the full adversarial matrix A–N in
  `../phase-s1-r/S1R_LIVE_RUNTIME_QUALIFICATION_2026-09-11.md` (duplicate wake, worker restart,
  Restate restart, lost ack, crash before/after admit, Postgres outage, epoch-takeover fence,
  paused/disabled/version-change gating). For every fault: one fire, one admission identity,
  one canonical task.

## 4. Prerequisites / gaps that MUST be closed before any change window

Gate 3 is **not executable today.** The following are repo-only build/deploy items, each to be
built, reviewed and tested (Docker-free where possible) BEFORE a change window, in the same
Option A style as Gate 1.5/1.6/2 (reviewed tools, no raw mutation SQL). None is a production
mutation.

- **GAP A — no reviewed ENABLE tool.** `enabled_for_production` is a per-version column and a
  spec version is immutable: `upsertSpecVersion` refuses an existing `(schedule_id, version)`
  ([pg-store.ts:55](../../../services/kernel/src/scheduler/pg-store.ts#L55)), and the scheduler
  never self-enables ([policy.ts:24](../../../services/kernel/src/scheduler/policy.ts#L24)).
  Enabling for production is therefore an authorised human-owned spec update, i.e. a NEW version.
  Recommended enable tool contract (`enable-canary`): given `scheduleId`, `fromVersion=v1`,
  `toVersion=v2`, `ownerId` (HUMAN), and an approved `createdAt(v2)`, it (1) `upsertSpecVersion`
  a v2 spec byte-identical to v1 except `version=v2` and `enabledForProduction=true`, then
  (2) `setState(scheduleId, state='enabled', activeVersion='v2', updatedBy=ownerId)`. Fail-closed,
  idempotent, verifies HUMAN owner via the same read-only `PgIdentityGate`. (Alternative: a
  privileged in-place `UPDATE schedule_specs SET enabled_for_production=true` on v1 — bypasses
  version immutability and the store discipline; NOT preferred, requires explicit approval.)
- **GAP B — no reviewed DISABLE/rollback tool.** Rollback to safe = `setState(state='disabled')`
  (authority-safe, not lease-fenced, [pg-store.ts:110](../../../services/kernel/src/scheduler/pg-store.ts#L110)).
  Recommended `disable-canary` tool: `setState(scheduleId, state='disabled', activeVersion=<current>, updatedBy=ownerId)`.
  A bound fire is immutable (bind-once); disabling stops any NEW fire but never rewrites history.
- **GAP C — no reviewed SINGLE-FIRE tool.** Recommended one-shot `fire-once` tool: construct
  `PgScheduleStore` + `HttpAdmissionGateway` and call
  `new ScheduleTimerDriver(store, NoopDurableTimerRuntime, gateway, {owner, productionRuntime:true, leaseTtlMs}, directJournal).onWake(scheduleId, lastTickMs, nowMs)` ONCE, with `(lastTickMs, nowMs]`
  chosen to bound EXACTLY ONE due civil slot, `armNext` OFF. This uses the Restate-independent
  path (proven by the "real PG + real door, in-memory timer" layer, 6 EXECUTED). No Restate
  deploy. The tool prints only non-secret result codes and the canonical id it read back from
  the fire row.
- **GAP D — admission door not in production.** `POST /v1/tasks` (`apps/gateway/src/server.ts`)
  with the `claude_md_check/v1` accept-list was built in Gate 1.5 but "not deployed/activated".
  Gate 3 requires the door reachable at a known `admissionUrl`, accepting `claude_md_check/v1`,
  with its bearer token held in jVault (project `kerneljson`, injected like `DATABASE_URL`,
  never in argv). Deploying the door is a production change with its own go/no-go.
- **GAP E — executor/verifier + digest.** For execution -> evidence -> completion, the kernel
  executor/verifier for `claude_md_check/v1` must be deployed and configured with
  `SCHED_APPROVED_SHA256 = 27255772…` ([canary-config.ts](../../../services/kernel/src/scheduler/canary-config.ts)).
  Without it, admission would create a task that cannot complete with evidence.
- **GAP F — Restate decision.** `services/kernel/src/index.ts` registers only the task + kernel
  workflows; the `ScheduleDriver` Virtual Object is NOT wired
  ([index.ts:12](../../../services/kernel/src/index.ts#L12)). For the FIRST controlled fire, do
  NOT deploy the ScheduleDriver Restate service (the boundary forbids production Restate deploys,
  and the one-shot `onWake` path does not need it). The durable Restate path is a later,
  separately-authorised step (already qualified live on disposable infra).

## 5. Exact ENABLE mechanism (after GAP A)

```
jvault run --project kerneljson -- pnpm exec tsx services/kernel/src/tools/canary-runner.ts \
  enable-canary --schedule-id acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b \
  --from-version v1 --to-version v2 --owner-id da5c6dfc-38c5-4773-bd47-5c80ed908d75 \
  --created-at <APPROVED_V2_CREATED_AT>
```

Effect: v2 spec (identical to v1 + `enabled_for_production=true`) inserted; state set to
`enabled` with `active_version=v2`. `createdAt(v2)` must be a fixed, approved, recorded value
(idempotent re-run). This is the ONLY production write of the enable step.

## 6. Exact SINGLE-FIRE mechanism (after GAP C)

```
jvault run --project kerneljson -- pnpm exec tsx services/kernel/src/tools/canary-runner.ts \
  fire-once --schedule-id acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b \
  --last-tick <ISO_JUST_BEFORE_SLOT> --now <ISO_JUST_AFTER_SLOT> \
  --owner fire-once/gate3 --production
```

`--last-tick`/`--now` bound exactly one `dailyAt 09:00 Europe/London` slot, so `dueFireWindows`
yields exactly one window -> one fire -> one admission -> one bind. `armNext` is off, so no next
wake is scheduled. `productionRuntime=true` enforces `enabled_for_production=true`
([policy.ts:25](../../../services/kernel/src/scheduler/policy.ts#L25)).

## 7. Exact expected KernelJSON admission / task path

- `createOrGetFire` inserts one `schedule_fires` row (`state=PLANNED`,
  `idempotency_key = acab9ebc…|v2|<window>`), unique-constrained.
- `admit` POSTs to the door with `Idempotency-Key = fireIdentity`; KernelJSON mints ONE canonical
  child task and records it in `kernel_private.task_admissions`. A repeat of the same key returns
  the SAME task; the same key with a different payload fails closed (HTTP 409,
  `AdmissionIdempotencyConflict`, [http-admission.ts:70](../../../services/kernel/src/scheduler/http-admission.ts#L70)).
- `bindAdmission` sets the fire `ADMITTED` and `admitted_child_task_id` = the canonical id, under
  the current LeaseFence (UPDATE joins `schedule_leases`; a stale epoch matches no row ->
  `StaleFenceError`), with the bind-once trigger blocking any rebind.
- The child task then runs through the kernel task ledger (`public.tasks` + evidence tables) to
  completion. `public.tasks` may lag `task_admissions` at bind time (Option B); completion is
  observed on the task ledger.

## 8. Exact change-window steps (each verified before the next; never combined)

- **P0 — preflight (read-only).** Canary `state=disabled`, `enabled_for_production=false`,
  exactly one spec, zero fires; HUMAN owner intact; SERVICE principal intact; admission door
  healthy and reachable; gateway bearer present in jVault (name only); executor/verifier +
  digest configured.
- **P1 — enable** (section 5). Verify `state=enabled`, `active_version=v2`,
  v2 `enabled_for_production=true`, still zero fires.
- **P2 — single fire** (section 6). Verify exactly one `schedule_fires` row, `state=ADMITTED`,
  one `admitted_child_task_id`, one `task_admissions` row for that id.
- **P3 — execution / evidence / completion.** Verify the child task reaches a terminal completed
  state with evidence in the kernel ledger.
- **P4 — disable / rollback** (GAP B). `setState(state='disabled')`. Verify `state=disabled`; the
  one fire stays `ADMITTED` (immutable history); zero NEW fires.
- **P5 — idempotency re-fire proof.** Re-invoke `fire-once` for the SAME window. Verify replay:
  no second fire, no second admission, no second task; the fire row unchanged; admission count
  delta = 0.
- **P6 — STOP.**

## 9. Read-only verification queries (templates)

Replace `<V>` with the active version (`v2` after enable). All read-only.

```sql
-- Fire + admission shape for the canary (expect exactly one fire, ADMITTED, one child)
select count(*) as fires,
       count(*) filter (where state='ADMITTED') as admitted,
       count(distinct fire_identity) as distinct_identities,
       count(distinct admitted_child_task_id) filter (where admitted_child_task_id is not null) as distinct_children,
       min(idempotency_key) as sample_idem
from public.schedule_fires
where schedule_id='acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b';

-- The bound canonical child exists exactly once in admissions
select count(*) as admissions
from kernel_private.task_admissions ta
join public.schedule_fires f on f.admitted_child_task_id = ta.task_id
where f.schedule_id='acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b';

-- Lifecycle / completion of the child task (kernel ledger)
select t.id, t.status
from public.tasks t
join public.schedule_fires f on f.admitted_child_task_id = t.id
where f.schedule_id='acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b';

-- Post-run safe state (expect disabled again)
select st.state, st.active_version, sp.enabled_for_production
from public.schedule_state st
join public.schedule_specs sp on sp.schedule_id=st.schedule_id and sp.version=st.active_version
where st.schedule_id='acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b';

-- Observations (expect none, or only benign LEASE_RECOVERED); AUTHORITY = investigate
select kind, count(*) from public.schedule_observations
where schedule_id='acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b' group by kind;

-- Lease state (single owner/epoch; no churn)
select owner, epoch, expires_at from public.schedule_leases
where schedule_id='acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b';
```

## 10. Evidence to capture

The fire row (idempotency_key, fire_identity, state, admitted_child_task_id, admitted_at); the
admission Idempotency-Key = fireIdentity; the canonical task id and its completion + evidence
artefact; the verified CLAUDE.md digest; the re-fire replay proof (deltas = 0); the pre/post
`state`/`enabled_for_production`; SERVICE principal + unrelated tables unchanged; timing. Record
as `docs/production/phase-s1-canary/GATE3_RESULT_<date>.md` plus a machine-readable JSON.

## 11. Success criteria (all must hold)

Exactly 1 fire; 1 distinct fire_identity; 1 admission; 1 canonical child task; task completed
with evidence; digest verified; re-fire is a pure replay (0 new fire/admission/task); canary
returned to `state=disabled`; SERVICE principal unchanged; no unrelated table mutated; Phase 8.1
undisturbed.

## 12. Fail / stop criteria (any -> STOP, disable, capture, do not blind-retry)

More than one fire / admission / task; HTTP 409 `AdmissionIdempotencyConflict` (payload drift);
unexpected `StaleFenceError`; admission-door error (non-202/409); execution failure or missing
evidence; canary not returning to disabled; a `fire_bind_conflict` AUTHORITY observation; any
unrelated mutation. On stop: run `disable-canary`, capture full read-only state, and escalate to
Jonny; never retry a mutation blindly.

## 13. Safety mechanisms (defense in depth)

- **Duplicate-fire protection:** unique `(schedule_id, schedule_version, fire_window_key)` and PK
  `idempotency_key`; `createOrGetFire` ON CONFLICT do nothing resolves to the existing row.
- **Admission idempotency:** `Idempotency-Key = fireIdentity`, no secondary key; KernelJSON
  dedupes to one canonical task; changed payload under the same key -> 409 fail-closed.
- **Bind-once:** `schedule_fire_bind_once()` trigger + `admitted_child_task_id is null` guard;
  a different task can never overwrite a bound fire.
- **LeaseFence:** ownership-sensitive mutations (`bindAdmission`, `transition`, `releaseLease`)
  require the current `(owner, epoch)`; the fenced UPDATE joins `schedule_leases`, so a stale
  epoch matches no row -> `StaleFenceError` -> fail closed (proven live, matrix K).
- **Retry / lost-ack:** at-least-once wake + journaled continuation converge to one task
  (matrix B/C/D/E/H); only `StaleFenceError` becomes a non-retryable `TerminalError`, all other
  errors stay retryable (matrix I/J).
- **Restate involvement:** durable wait + wake + continuation only; removable; holds no truth.
  For the FIRST fire, Restate is not deployed (one-shot `onWake`).

## 14. Boundary (still forbidden in Gate 3 prep)

Do not enable the canary, create any fire, trigger execution, deploy production Restate changes,
execute Phase B or C1, change EMAIL authority or Phase 8.1, or alter WhatsApp/n8n/OpenClaw/JaiOS.
Touch none of the pre-existing untracked files. Do not touch the SERVICE principal.

## 15. Status

Production mutation = NONE. This is a plan. Gate 3 execution requires: GAPs A–F closed and
reviewed; an explicit change window; and Jonny's explicit go-ahead per step.
