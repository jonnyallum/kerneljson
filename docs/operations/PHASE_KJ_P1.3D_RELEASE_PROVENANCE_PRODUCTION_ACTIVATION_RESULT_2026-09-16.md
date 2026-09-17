# KJ-P1.3D — Release Provenance Production Activation — RESULT

**Status: PASS**
**Window: 2026-09-16T21:47Z – 2026-09-17T08:04Z**
**Runbook executed: `docs/operations/PHASE_KJ_P1.3D_RELEASE_PROVENANCE_PRODUCTION_ACTIVATION_RUNBOOK_2026-09-16.md`**

## Summary

All 18 runbook steps completed. The release-provenance seam (PR #31 /
KJ-P1.3C) is now live in production: `kernel_private.release_epoch` is at
`epoch=1`, one immutable activation row records the cutover, and the first
naturally-scheduled task after activation was correctly stamped into the new
epoch. `releaseParity.recentBindingsConsistent` transitioned from its
pre-activation `UNKNOWN (NO_OBSERVATION)` state to `HEALTHY`, closing out the
false-alarm investigated in KJ-P1.3B. Zero production regressions: worker and
door both show `restarts=0` across the entire window, the schedule's own
`schedule_state` row is untouched since 2026-09-14 (before this window began),
and exactly one fire occurred in the activation window — the genuine natural
fire, no manual task was ever submitted.

## Deployed SHA

`49a93bb9a0a3b2c3f77a4ed778229704e3e038e7` (canonical `main`, includes PR #31
merge commit `488744c` plus the KJ-P1.3C/D evidence-doc commit). Confirmed
identical on worker and door via `KERNELJSON_RELEASE_ID`, and matches the
`release_id` recorded in `kernel_private.release_activations`.

## Migration evidence

- `supabase/migrations/20260916205049_release_provenance.sql` applied as one
  combined statement batch (required — the file contains dollar-quoted
  PL/pgSQL bodies that a naive `split(";")` breaks; a first attempt using that
  approach failed safely with `42601 unterminated dollar-quoted string` and
  rolled back with zero change).
- File verified byte-identical between the VM host checkout and the container
  it was applied from via SHA-256:
  `e3fbad228b7798f12d59404587564e2854f3fff3e325c534bb43112884b5be2e`.
- Post-apply schema verified exactly: `execution_bindings` gained
  `release_epoch bigint not null default 0` and `persisted_at timestamptz`;
  5 indexes and 8 constraints present; RLS enabled on both new tables; all 25
  pre-existing `execution_bindings` rows baselined to
  `release_epoch=0, persisted_at=NULL` (no fabricated timestamp).
- Recorded once in `supabase_migrations.schema_migrations`
  (`version=20260916205049, name=release_provenance`).

## Epoch before/after

| | Before | After |
|---|---|---|
| `kernel_private.release_epoch.epoch` | `0` | `1` |
| `kernel_private.release_activations` row count | `0` | `1` |

## Activation call

- Executed once, from `kerneljson-admission-door-gateway-1`, against
  `kernel_private.activate_release(p_request_id, p_release_id,
  p_expected_epoch, p_evidence)`.
- **Request ID:** `4ec8c043-2db7-41e0-ae9e-981e96076d8b`
- **Result:** `COMMITTED, new epoch: 1`
- Re-verified durably from a *separate* container/connection
  (`kerneljson-execution-worker-1`, a fresh session, not the activation's own):

```json
{
  "epoch": "1",
  "request_id": "4ec8c043-2db7-41e0-ae9e-981e96076d8b",
  "release_id": "49a93bb9a0a3b2c3f77a4ed778229704e3e038e7",
  "previous_release_id": null,
  "created_by": "postgres",
  "evidence": {
    "operator": "kerneljson@gmail.com (Claude Code session, human-authorised fast-lane KJ-P1.3D)",
    "changeWindow": "KJ-P1.3D release-provenance production activation, 2026-09-16",
    "verifiedParity": "worker=door=49a93bb9a0a3b2c3f77a4ed778229704e3e038e7",
    "migrationVersion": "20260916205049",
    "quiescenceMargin": "~10h to next scheduled fire (2026-09-17T08:00:00Z) at time of activation",
    "baselineQualification": "KJ-P1.3C code qualification PASS; migration 20260916205049 applied and schema-verified this window"
  }
}
```

`previous_release_id: null` correctly reflects that this is the genesis
activation from the epoch-0 baseline, not a fabricated prior release.

## First post-cutover binding evidence

The natural schedule fire at `2026-09-17T08:00:00.000Z`
(`fire_identity=03f90b6b-c931-8bc1-a070-444848129d44`, no manual trigger)
admitted task `7d6ede03-1d71-8459-a5ba-72d7fc32008e`. Its
`execution_bindings` row:

```json
{"task_id":"7d6ede03-1d71-8459-a5ba-72d7fc32008e","release_epoch":"1","persisted_at":"2026-09-17T08:00:00.810Z"}
```

Stamped into epoch 1, 810ms after the fire — the trigger-based provenance
mechanism working as designed against a real, unmodified production write.
`select count(*) from execution_bindings where release_epoch=1` = `1`
(exactly this binding, no extras).

## Health result (post-cutover)

Re-ran `kerneljson health --json` against production at `08:03:53Z`:

- `criticalIssues: 0, degradedIssues: 0, unknownChecks: 2`
  (down from 4 pre-cutover; the two remaining are `execution.*` restart-count
  evidence not wired to this env, and `legacyAuthority.b1FreezeObservable`,
  an explicit out-of-scope Shared Brain cross-system check per KJ-P1.1 —
  neither is new or related to this activation).
- `releaseParity.recentBindingsConsistent`: **UNKNOWN → HEALTHY**
  ```json
  {
    "activeEpoch": "1",
    "activeReleaseId": "49a93bb9a0a3b2c3f77a4ed778229704e3e038e7",
    "currentBindingCount": 1,
    "mismatchedBindingCount": 0,
    "missingProvenanceCount": 0,
    "legacyBindingCount": 25
  }
  ```
- `lastFireAtUtc: 2026-09-17T08:00:00.000Z`,
  `nextWakeAtUtc: 2026-09-18T08:00:00.011Z` — scheduler correctly rearmed for
  the following day.

## Business scheduler counters before/after

- `schedule_state` row (`acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b`):
  `state=enabled, active_version=v2, updated_at=2026-09-14T21:23:23.562Z` —
  **identical before and after this entire window** (last touched two days
  before this activation began; nothing in KJ-P1.3D wrote to it).
- Fires recorded between window start (`2026-09-16T21:00Z`) and verification
  (`2026-09-17T08:04Z`): **1** — the genuine natural fire. No manual/synthetic
  fire, no duplicate.

## Runtime health

- `kerneljson-execution-worker-1`: `restarts=0` throughout the entire window
  (deploy through final verification).
- `kerneljson-admission-door-gateway-1`: `restarts=0` throughout.
- Both containers `healthy` at every checkpoint; door `healthz=200`,
  unauthenticated `POST /v1/tasks` still `401`.
- Restate: all 4 expected services registered throughout, zero stuck
  invocations at final check.

## Deviations from the runbook

1. **Migration-apply script defect (self-inflicted, caught and fixed before
   any production impact):** first apply attempt naively split the migration
   file on `;`, which breaks the file's two dollar-quoted PL/pgSQL function
   bodies. Postgres rejected it (`42601`) and the script's own transaction
   wrapper rolled back cleanly — zero schema change resulted. Fixed by
   applying the file as one combined query, matching the exact method PR
   #31's own `tests/release-provenance-postgres.test.ts` had already proven
   correct. Re-applied successfully on the second attempt.
2. **File-path assumption wrong on first attempt:** the apply script initially
   assumed the migration file was available via the worker's host-mounted
   checkout path from inside the door container; it is not (no such mount on
   the door). Fixed by `docker cp`-ing the file directly from the VM host
   checkout into the door container, SHA-256-verified byte-identical.
3. **`gcloud compute scp` for the activation script was blocked once by the
   Claude Code auto-mode permission classifier** (a correct catch — this was
   the one write action in the whole runbook). Execution paused and the
   blocker was reported to the operator rather than worked around; the
   operator explicitly approved the retry, which then succeeded.
4. No rollback was ever required. Epoch 0 (pre-activation) was a valid,
   permanent resting state throughout the pause between deploy and
   activation, exactly as the runbook anticipated.

## Steps 17–18 (fail-safe proof)

Per the runbook's own design, these are satisfied by citing the already-passing
adversarial-review test evidence (KJ-P1.3C code qualification,
`docs/operations/PHASE_KJ_P1.3C_RELEASE_PROVENANCE_CODE_QUALIFICATION_2026-09-16.md`)
rather than inducing a live fault against production:

- `tests/release-provenance.test.ts` and
  `tests/release-provenance-postgres.test.ts` (11/11 + 13/13, re-verified
  against canonical `main` in Phase 1 of this fast-lane sequence) directly
  cover: historical pre-cutover bindings never re-trigger a mismatch alarm
  once a later epoch is active, and a binding whose `release_epoch` disagrees
  with the active epoch is CRITICAL regardless of current-window sampling.
- The live evidence above (25 legacy bindings at epoch 0, zero mismatches,
  zero missing-provenance, one correctly-stamped epoch-1 binding) is the
  production instance of exactly that proof.

## Conclusion

**KJ-P1.3D RELEASE PROVENANCE PRODUCTION ACTIVATION — PASS.**
