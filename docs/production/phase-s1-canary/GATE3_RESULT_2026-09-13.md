# S1 Canary Gate 3 — production result (PASSED)

Date: 2026-09-13. Status: **Gate 3 PASSED.** The single controlled production fire of
`claude_md_check` planned in `GATE3_SINGLE_FIRE_PLAN_2026-09-11.md` executed successfully,
completed with verified evidence, and the canary was returned to `disabled`. This document
is the canonical evidence record referenced by that plan's §10 and §15.

Machine-readable companion: `GATE3_RESULT_2026-09-13.json`.

---

## 1. Canonical runtime

| Item | Value |
|---|---|
| Canonical runtime SHA | `b210c1b8e78dcea86b3a9080c6ebcf17ee16f527` |
| Prior canonical SHA (pre-hotfix) | `35b03fba6aa5edd46cf6fdf9592f52818a64329a` |
| Worker image / release ID | `kerneljson-worker:b210c1b` / `b210c1b8e78dcea86b3a9080c6ebcf17ee16f527` |
| Door image / release ID | `kerneljson-admission-door:b210c1b` / `b210c1b8e78dcea86b3a9080c6ebcf17ee16f527` (identical to worker) |
| Restate | healthy throughout; not rebuilt, not restarted; re-registered only |

## 2. Fire / admission / execution result

| Item | Value |
|---|---|
| Schedule | `claude_md_check`, `acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b` |
| fire_identity | `f27ada35-cfb4-8ff9-a61c-e115b0f9b2e9` |
| fire_window_key | `dailyAt/09:00\|Europe/London\|2026-09-12` |
| task_id (canonical child) | `31698dcc-e3af-841b-a8ec-d4787dbd12d2` |
| Terminal state | `COMPLETED` (started `2026-09-13T01:53:26.658Z`, completed `2026-09-13T01:53:26.938Z`) |
| Admissions | 19 → **20** |
| Fires | 0 → **1** (`distinct fire_identity = 1`, `distinct admitted_child_task_id = 1` — no duplicates) |
| Admitted-undispatched (historical) | remains **19** — the new task is dispatched/completed, correctly excluded |
| Canary state after completion | `disabled`, `active_version = v2` (unchanged from the enabled version) |
| AUTHORITY observations | none (`schedule_observations` empty for this schedule) |

## 3. Evidence — TOOL_RECEIPT

From `public.evidence`, bound to `task_id = 31698dcc-e3af-841b-a8ec-d4787dbd12d2`:

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

- Approved digest: `27255772beb1418e462fe262a2a747c53bf6a34973c3ad75907f7505a32f2b10`
- Observed digest: `27255772beb1418e462fe262a2a747c53bf6a34973c3ad75907f7505a32f2b10`
- **Match: exact.**
- No secret values appear anywhere in the evidence row, task payload, or logs captured during this run.

## 4. Replay / idempotency proof

Re-invoked `fire-once` for the identical `(scheduleId, version, fireWindowKey)`:

| Field | First fire | Replay |
|---|---|---|
| `childTaskId` | `31698dcc-e3af-841b-a8ec-d4787dbd12d2` | `31698dcc-e3af-841b-a8ec-d4787dbd12d2` (same) |
| `fireCreated` | `false` (resolved existing `PLANNED` row from the pre-hotfix attempt) | `false` |
| `admissionReplay` | `false` (genuine first admission) | **`true`** |
| `admissions_total` after | 20 | **20 (unchanged)** |

Exactly-once behaviour confirmed: the same fire identity always resolves to the same
canonical task, with zero new admissions on replay.

## 5. Resolved deviations

1. **Bearer-prefix bug found on the first fire attempt.** `canary-runner.ts`'s
   `buildAdmissionGatewayFromEnv()` passed `KJ_ADMISSION_BEARER` raw as the `authorization`
   header. The admission door (`apps/gateway/src/server.ts`) requires RFC 6750 form
   (`/^Bearer [^\s]{1,4096}$/`); the raw token was rejected `401 UNAUTHENTICATED`. The
   `schedule_fires` row for this exact fire_identity was created (`PLANNED`) but never
   reached admission — 0 tasks admitted, 0 evidence produced, admissions stayed at 19.
2. **Fixed in PR #19** (`fix/gate3-canary-admission-bearer-prefix`, merged to `main` as
   `b210c1b8e78dcea86b3a9080c6ebcf17ee16f527`): the header is now constructed as
   `Authorization: Bearer <KJ_ADMISSION_BEARER>`. A regression test proves the exact header
   sent, and was verified to fail against the pre-fix code before being verified to pass
   against the fix. No change to the gateway's auth contract or the canonical bearer value.
3. **Re-arming v2 after the first (failed) attempt required a direct, reviewed store call.**
   `enable-canary`'s `ALREADY_PRODUCTION` guard correctly refuses to re-enable a version that
   already has `enabled_for_production=true` — it is designed for `disabled(v1) →
   enabled(newVersion)`, not a disable/re-enable cycle on the same version. Since v2's spec
   was already correct, the fix was a direct call to the same reviewed
   `PgScheduleStore.setState(...)` that `disable-canary` itself uses internally (same
   fail-closed `PgIdentityGate` HUMAN-actor check first) — no new version minted, no raw SQL,
   no change to `enable-canary`'s guard.
4. **The replay proof initially hit `NOT_FIRABLE`** even after the schedule was genuinely
   re-armed (`state=enabled`, `enabled_for_production=true` confirmed independently).
   Root cause: the injected `--now` for `fire-once` was the original historical window bound
   (`2026-09-12T08:01:00Z`), which is *before* the re-arm's real `updated_at`
   (`2026-09-13T01:56:34Z`) — a temporal-consistency mismatch. Corrected by passing the
   actual current time as `--now` while keeping `--last-tick` bounding the same single due
   window, which resolved to the identical `fireIdentity` as before.

## 6. Final state (all confirmed independently, not asserted)

- Worker: `kerneljson-worker:b210c1b`, healthy, restarts=0.
- Door: `kerneljson-admission-door:b210c1b`, healthy, `/healthz=200`, noauth=401, wrong-bearer=401, `mode=restate-dispatch`, `KJ_ADMISSION_BEARER` fingerprint unchanged.
- Restate: healthy; `KernelWorkflowV1`, `CapabilityServiceV1`, `TaskWorkflow` all registered.
- Canary: `state=disabled`, `active_version=v2`.
- No unrelated schedule touched; no second execution; `KJ_ADMISSION_BEARER` unchanged throughout.

## 7. Next phase

Gate 3 is complete. The next phase is **not** a repeat of Gate 3 — it is the first
*unattended* production fire (the durable Restate-driven wake path, `ScheduleTimerDriver`
via the registered `ScheduleDriver`), which Gate 3 itself deliberately deferred
(`GATE3_SINGLE_FIRE_PLAN_2026-09-11.md` §4, GAP F: "For the FIRST controlled fire, do NOT
deploy the ScheduleDriver Restate service... The durable Restate path is a later,
separately-authorised step"). That remains gated behind its own explicit change-window
authorisation and is not started by this document.
