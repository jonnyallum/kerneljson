# S1 canary — durable Restate-driven unattended wake (PASSED)

Date: 2026-09-13. Status: **PASSED.** The phase Gate 3 deliberately deferred
(`GATE3_SINGLE_FIRE_PLAN_2026-09-11.md` §4, GAP F) has now been proven in production:
Restate woke the schedule itself, with no manual `fire-once` invocation, and drove exactly
one canonical production execution end to end.

Machine-readable companion: `DURABLE_RESTATE_WAKE_RESULT_2026-09-13.json`.

---

## 1. Implementation path

```
ScheduleDriver Virtual Object (Restate)
  → ScheduleTimerDriver.onWake            (the exact same class Gate 3 used manually)
  → HttpAdmissionGateway                  (the exact same admission client Gate 3 used)
  → canonical admission door
  → KernelWorkflowV1
  → CapabilityServiceV1
  → sealed repository.read
  → evidence
  → completion
```

No parallel scheduler, no independent task-minting authority:
- **Restate owns durable waiting/wake only** — the `ctx.sleep(...)` durable wait and
  journaled continuation (`ctx.run(...)`) in `services/kernel/src/scheduler/restate-service.ts`.
- **KernelJSON remains sole task authority** — the wake handler re-derives everything from
  Postgres and calls the identical `ScheduleTimerDriver.onWake` that the manual `fire-once`
  CLI tool calls; `HttpAdmissionGateway` is the same class, same door, same
  `Idempotency-Key = fireIdentity` contract.
- No duplicate admission/scheduler authority was introduced anywhere in this phase.

## 2. Code changes required

Two, both merged before this test ran:

| PR | SHA | What |
|---|---|---|
| #20 | `a6c6edf` | Wired `ScheduleDriver` into the production worker (`services/kernel/src/index.ts`), fail-closed all-or-nothing gate on the admission seam + canary config. |
| #21 | `38b57af` | `infrastructure/docker/execution.compose.yaml` did not pass `KJ_ADMISSION_URL`/`KJ_ADMISSION_BEARER` through to the worker container at all — Compose only forwards explicitly-declared `environment:` keys, not arbitrary env-file contents. Fixed. |

**Deployed runtime SHA:** `38b57af55a4ce893eab3cd6fe91082dfbddceb05` — worker and door, release
IDs identical, confirmed independently.

## 3. Restate invocation / fire / task

| Item | Value |
|---|---|
| Restate invocation ID | `inv_10gzREX5HBAt6Ygho8YFcF8DjCgtFuL1CG` |
| Arm mechanism | one-way `POST /ScheduleDriver/{scheduleId}/fire/send`, `202 Accepted` at `2026-09-13T11:11:13Z` |
| fire_identity | `06f4f916-7561-8d89-ab70-d7b30e2d0010` |
| fire_window_key | `dailyAt/09:00\|Europe/London\|2026-09-13` (new, distinct from Gate 3's `2026-09-12` window) |
| Autonomous execution time | `2026-09-13T11:13:43Z` — matching the 150s durable sleep exactly; zero human action at that moment |
| task_id | `59971e13-b690-84ab-a4f1-ed5e960220d8` |
| Terminal state | `COMPLETED` (`2026-09-13T11:13:43.700Z` → `2026-09-13T11:13:44.565Z`) |

## 4. Counters

| Item | Before | After |
|---|---|---|
| admissions | 19 -> 20 (Gate 3) | 20 -> **21** (this phase) |
| fires | 0 -> 1 (Gate 3) | 1 -> **2** (this phase; one distinct new fire identity, one distinct new child task — no duplicates) |
| AUTHORITY observations | 0 | 0 |

## 5. Evidence — TOOL_RECEIPT

```json
{
  "type": "TOOL_RECEIPT",
  "source": "kerneljson:repository-read-local/v1",
  "capability": "repository.read",
  "target_path": "CLAUDE.md",
  "content_sha256": "27255772beb1418e462fe262a2a747c53bf6a34973c3ad75907f7505a32f2b10",
  "mutations_detected": 0
}
```

Bound to `task_id = 59971e13-b690-84ab-a4f1-ed5e960220d8`. Observed digest exactly matches
the approved digest `27255772beb1418e462fe262a2a747c53bf6a34973c3ad75907f7505a32f2b10`. No
secret values appear anywhere in the evidence row, task payload, or logs captured during
this run.

## 6. Replay / durability proof

A second `POST /ScheduleDriver/{scheduleId}/fire/send` was sent for the identical window
(`sleepMs=0`, immediate). Result: resolved to the same `fire_identity`, the same
`admitted_child_task_id`, admissions stayed at 21 — no new fire row, no new admission, no
second execution.

**Live Restate restart proof was deliberately not repeated in production.** That exact
durability/recovery scenario (Restate restart mid-continuation, resuming to the same
canonical task) is already proven live on disposable qualification infrastructure
(`docs/production/phase-s1-r/S1R_LIVE_RUNTIME_QUALIFICATION_2026-09-11.md`, matrix A-N).
Restarting live production Restate for this test would add real operational risk — it also
runs `KernelWorkflowV1`/`CapabilityServiceV1`/`TaskWorkflow` for any other in-flight work —
without producing any evidence not already established. Scoped out as a deliberate,
documented decision, not an omission.

## 7. Resolved implementation deviations

1. The first draft of PR #20's registration-gating logic incorrectly treated "canary
   configured, admission seam absent" (the valid, pre-existing baseline) as an error. Caught
   by the tests added in the same PR before the commit was made, then fixed.
2. The Compose env-passthrough gap (PR #21) was found only by checking the actual deployed
   container configuration after PR #20 merged, not assumed from the code change alone.
3. Two `gh pr merge` self-approval classifier blocks (`Merge Without Review`,
   `Self-Approval`) and one `Modify Shared Resources` block on the arming HTTP call were all
   resolved through explicit human action (exiting auto mode or merging directly) — never
   bypassed.
4. No duplicate authority, duplicate fire, duplicate admission, or second execution occurred
   at any point.

## 8. Final state (all confirmed independently, not asserted)

- Canary: `state=disabled`, `active_version=v2` (unchanged version — no new spec minted for
  this phase).
- Worker: `kerneljson-worker:38b57af`, healthy, restarts=0.
- Door: `kerneljson-admission-door:38b57af`, healthy, release ID identical to worker.
- Restate: healthy; `ScheduleDriver`, `KernelWorkflowV1`, `CapabilityServiceV1`,
  `TaskWorkflow` all registered. (Service registration is independent of the schedule's own
  enabled/disabled lifecycle state, as designed.)

## 9. Next phase

**This is not Gate 3 repeated, and it is not itself a template to repeat.** The durable,
unattended, Restate-driven wake path is now proven end to end in production, once, under a
controlled single-shot test (`armNext` was not enabled — no self-perpetuating recurring
wake was armed by this phase). The next phase is a separate, explicitly-gated decision — see
the estate-wide canonical migration plan (`new-system` repo) for the authoritative sequence;
this document does not define it.
