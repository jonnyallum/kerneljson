# Phase S1-R — LIVE Runtime Qualification Report (2026-09-11)

> Branch `feat/phase-s1-restate-boundary`. Supersedes the pre-Option-B report
> `S1R_RUNTIME_QUALIFICATION_2026-09-10.md` (which recorded FAILED at the FK bind
> gap, before commit `814314b`). Executed against a REAL containerised Restate
> (`docker.restate.dev/restatedev/restate:1.7.9`, SDK `@restatedev/restate-sdk@1.17.0`),
> REAL disposable Postgres (`postgres:17.6`, validation stack on 127.0.0.1:55432,
> per-test `s1rlive_<uuid>` databases), and the REAL KernelJSON admission door
> (`apps/gateway/src/server.ts`). No production Supabase, no production schedules,
> Phase 8.1 untouched. Docker: existing daemon only (`docker info` healthy); no
> Docker Desktop lifecycle management.
> Tags: FACT · INFERENCE · RECOMMENDATION. Tiers: EXECUTED · STATICALLY VERIFIED ·
> SPECIFIED / UNEXECUTED.

## Verdict: S1-R RUNTIME QUALIFICATION PASSED

The full chain completes through a live Restate durable timer and survives the
adversarial matrix. For every fault: **one ScheduleFire, one admission identity,
one canonical child task.** Restate owns only durable waiting + at-least-once wake
delivery + journaled continuation; KernelJSON/Postgres owns all schedule and task
truth. Evidence: `RESTATE_LIVE_EVIDENCE.json` (this run, 2026-09-10T23:58Z UTC).

## Topology (FACT)

```
Restate container (ingress :18080, admin :19070)
  → host.docker.internal:9091 → host ScheduleDriver worker (tests/support/schedule-worker.ts)
    → ScheduleTimerDriver (services/kernel/src/scheduler/durable-timer.ts)
    → HttpAdmissionGateway → real admission door POST /v1/tasks (Idempotency-Key = fireIdentity)
    → throwaway per-test Postgres (schedule_* tables + kernel_private.task_admissions)
```

The scheduler core imports NO Restate SDK. The only SDK-importing file is the
adapter `services/kernel/src/scheduler/restate-service.ts`; the wake logic depends
on three seams — `DurableTimerRuntime`, `AdmissionGateway`, `StepJournal` — so
Restate is replaceable (a cron poller calling the same handler is a valid
substitute). Delete `restate-service.ts` + the worker and the scheduler still
computes fires and admits through the same door.

## The real end-to-end chain (FACT — Test A, `A_normal_wake`)

`ctx.sleep(1500)` durable timer (observed wall wait 1795 ms) → journaled wake →
`createOrGetFire` (ctx.run) → `claimLease` (fence owner=`restate-driver`, epoch 0)
→ `admit` (ctx.run → real door, `Idempotency-Key = fireIdentity`
`a485f6b5…`) → canonical `taskId` in `kernel_private.task_admissions` (rowcount 1)
→ fenced `bindAdmission` (ctx.run) → fire `ADMITTED`, `admitted_child_task_id` =
the canonical id → **`public.tasks` rowcount 0 at bind time** (Option B: the fire
binds the admission identity, which exists synchronously; `public.tasks` is
downstream). Restate invocation id `inv_10P6oDQo7yDx4D35fpOkobNBjWY8H8VFiK`.

## Adversarial matrix (Section 15) — results by tier

| # | Scenario | Result | Tier |
|---|---|---|---|
| A | normal durable timer wake → full chain | ADMITTED, 1 task, timer waited | **EXECUTED (live Restate)** |
| B | duplicate wake | 2nd wake replays; 1 fire, 1 task | **EXECUTED (live Restate)** |
| C | worker/process restart while waiting | timer survived; wake completed once | **EXECUTED (live Restate)** |
| D | Restate restart while waiting | timer survived container restart; 1 task | **EXECUTED (live Restate)** |
| E | acknowledgement lost after wake | at-least-once redelivery converges (see B, C, D) | **EXECUTED (live, via B/C/D)** |
| F | crash before ScheduleFire creation | replay creates fire once (createOrGetFire idempotent) | EXECUTED (PG) + journaled replay (see H) |
| G | crash after ScheduleFire creation, before admit | replay: fire exists, admit once | EXECUTED (PG dedupe) + journaled replay (see B/H) |
| H | crash after admission commits, before bind | replay re-admits same id (Idempotency-Key), binds once; `admissionsDelta` = 1 | **EXECUTED (live Restate)** — Section 16 |
| I | retry after Admission-door outage | admit step is a retryable `ctx.run`; converges on recovery | SPECIFIED (same retry path proven live by J) |
| J | recovery after temporary Postgres outage | wake blocked through a live `docker pause` of Postgres, resumed and bound once on unpause | **EXECUTED (live Restate + real PG outage)** |
| K | stale continuation after epoch takeover (N→N+1) | fenced bind rejected by Postgres; no duplicate; reconciles to same task | **EXECUTED (live Restate)** — Section 17 |
| L | schedule paused while timer outstanding | wake gated; 0 fires, 0 admissions | **EXECUTED (live Restate)** |
| M | schedule disabled while timer outstanding | wake gated; 0 fires, 0 admissions | **EXECUTED (live Restate)** |
| N | schedule version changes while old timer outstanding | wake admits under the ACTIVE (v2) identity; v1 fires = 0 | **EXECUTED (live Restate)** |

**Live-EXECUTED: A, B, C, D, E, H, J, K, L, M, N (11).** F and G are covered by the
journaled-replay convergence proven live in B and H plus the `createOrGetFire`
dedupe proven in Postgres; a dedicated live injection at those exact points was not
run. I shares J's retryable-`ctx.run` recovery path (only StaleFenceError is
converted to a non-retryable TerminalError; all other errors stay retryable) and was
not separately fault-injected.

## The critical crash case (FACT — Test H, Section 16)

Crash injected AFTER the admission door commits `task_admissions` and BEFORE the
fenced bind (the admit `ctx.run` dies without journaling). On Restate re-delivery to
the respawned worker: the journaled `createOrGetFire`/`claimLease` replay from cache;
`admit` re-runs and the door returns the SAME canonical id on the same
Idempotency-Key; the fenced bind runs once. `admissionsDelta = 1` (exactly one
canonical task across the crash), fire `ADMITTED`, bound to the canonical id, 1 fire
row. No second task.

## Fencing under Restate (FACT — Test K, Section 17)

A continuation claims epoch 0 and stalls after admit; a takeover bumps the lease to
epoch 1; the resumed continuation's fenced `bindAdmission` (epoch 0) is rejected by
Postgres (`UPDATE 0` / `StaleFenceError`). The adapter converts the StaleFenceError
to a Restate `TerminalError` so `ctx.run` FAILS CLOSED instead of retrying a doomed
bind forever, and returns a `fenced_out_stale_lease` result. Canonical truth is
unharmed: the fire stays unbound, `admissionsDelta = 1`, and a later wake by the
current owner reconciles it to the SAME canonical task. **Restate replay cannot
bypass S1-F2.** (Regression note: an earlier iteration of the adapter re-threw the
StaleFenceError inside `ctx.run`, which Restate retried indefinitely and blocked the
object key — caught by this test failing on purpose, then fixed.)

## Test layers (Section 20 — do not bury skips)

| Layer | Count | Status |
|---|---|---|
| PURE (scheduler core) | 29 | EXECUTED |
| SIMULATION | 13 | EXECUTED |
| IN-MEMORY PERSISTENCE | 12 | EXECUTED |
| TYPE FENCING (compile-time guard) | 1 | EXECUTED |
| S1-R BOUNDARY (pure) | 14 | EXECUTED |
| S1-R0 ADMISSION IDENTITY (pure) | 4 | EXECUTED |
| POSTGRES (scheduler integration) | 9 | EXECUTED (throwaway PG this session) |
| POSTGRES FENCING | 8 | EXECUTED (throwaway PG this session) |
| GATEWAY ADMISSION (real Postgres) | 15 | EXECUTED |
| S1-R PG RUNTIME (real PG + real door, in-memory timer) | 6 | EXECUTED |
| **RESTATE RUNTIME + RESTART/RECOVERY (live server)** | **9** | **EXECUTED (live Restate)** |

Pure subtotal 73; PG/gateway/PG-runtime 38; live Restate 9. typecheck PASS, lint
PASS (`--max-warnings=0`). The pure 73 and the S1-R PG-runtime 6 were re-executed
after the journal seam was added (backward-compatible: `directJournal` default).

## Removability (Section 19)

**"If Restate disappeared now, would KernelJSON still know every schedule, fire,
admission identity and canonical task?" → YES (FACT by construction).** All of it is
in Postgres (`schedule_specs`, `schedule_state`, `schedule_fires`,
`schedule_leases`) and `kernel_private.task_admissions` + the kernel ledger. Restate
holds only outstanding durable timers and in-flight continuation cursors. Losing
Restate delays future wake *delivery* until another `DurableTimerRuntime` replaces
it — no schedule or task truth is lost.

## Teardown / safety

Per-test databases (`s1rlive_<uuid>`) dropped in `afterAll`; the suite's
`ScheduleDriver` deployment deregistered from Restate in `afterAll` (registry back to
zero deployments); host worker processes killed. Claude B's stale `S1RSmoke`
deployment (dead host endpoint) deregistered. Disposable validation `db` + `restate`
containers left running (as found); unrelated `supabase_*` containers untouched.
**Production contacts = ZERO. Production mutation = NONE.** No PR merged, no schedule
enabled, no migration applied to production, Phase 8.1 undisturbed.

## Artefacts

- `services/kernel/src/scheduler/restate-service.ts` — the Restate adapter (durable
  timer + journaled wake + StaleFence→Terminal fail-closed), the only SDK importer.
- `services/kernel/src/scheduler/http-admission.ts` — the real admission seam
  (`Idempotency-Key = fireIdentity`).
- `services/kernel/src/scheduler/durable-timer.ts` — `StepJournal` seam (added;
  backward-compatible) threaded through the wake handler.
- `tests/schedule-restate-live.integration.test.ts` — the live suite (gated on
  `S1R_LIVE=1`).
- `tests/support/schedule-worker.ts` — the host ScheduleDriver worker (fault-capable).
- `docs/production/phase-s1-r/RESTATE_LIVE_EVIDENCE.json` — machine-readable evidence.

## Reproduce

```
# validation stack must be up (docker info healthy; never manage Docker Desktop):
#   docker compose -f infrastructure/docker/validation.compose.yaml up -d db restate
S1R_LIVE=1 npx vitest run tests/schedule-restate-live.integration.test.ts
```
