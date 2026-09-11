# S1 Canary Gate 1 — `claude_md_check/v1` recipe (repo-only build)

Date: 2026-09-11. Author: Claude A (takeover; builder/verifier).
Branch: `feat/s1-canary-claude-md-check-recipe` (base: canonical main `289be33`).
Scope: **Gate 1 of the S1 production canary plan — repo-only. No production mutation,
no migration applied, no schedule created, no deployment.** See
`new-system/docs/migration/S1_PRODUCTION_CANARY_CLAUDE_MD_CHECK_PLAN.md`.

## What was built
A new, additive, isolated recipe `claude_md_check/v1` that performs a **read-only
CLAUDE.md drift check** and is admitted through the normal KernelJSON task path.

- `packages/contracts/src/plan.ts` — `RecipeId` gains `claude_md_check/v1`.
- `services/kernel/src/compiler/index.ts` — acceptance criterion registered
  (byte-identical to the runtime constant; a test asserts equality).
- `services/kernel/src/planner/index.ts` — the recipe plans to a **single
  `REPOSITORY_READ` step** (the sealed, read-only Track A / KJ-000000 capability
  `60000000-0000-4000-8000-000000000003` v1.0.0). No new operation, no new capability.
- `packages/runtimes/src/claude-md-check.ts` — `CLAUDE_MD_CHECK_CRITERION` and the
  pure verifier `verifyClaudeMdCheck`. It reuses `verifyRepositoryRead` (capability id,
  `repository.read` output, `mutations_detected === 0`, 64-hex content hash,
  evidence/outcome linkage) and adds two deterministic canary assertions:
  the read targeted a CLAUDE.md file, and the read's content hash equals an
  APPROVED digest supplied by the caller.
- `evals/fixtures/claude-md-check.ts`, `tests/claude-md-check.test.ts` — fixtures + tests.

## Safety properties (map to the plan's envelope)
- **Read-only** — reuses the sealed `repository.read` capability; `verifyRepositoryRead`
  requires `mutations_detected === 0`. No write path exists.
- **No arbitrary shell** — the capability is `repository.read`; there is no shell/exec
  operation in the plan.
- **Deterministic** — the verifier is a pure function of the result/evidence/outcome and
  the approved digest; no I/O, no clock, no randomness.
- **Evidence-producing** — PASS yields `evidenceRefs` from the outcome; the test writes a
  proof artifact (`artifacts/local/claude-md-check-canary-proof.json`).
- **Cannot create schedules/tasks outside normal admission** — this is a recipe + verifier
  only; it has no minting capability. The scheduler's sole task source remains the
  admission door.
- **Approved digest is caller-supplied, not hardcoded** — no fragile constant to churn;
  the schedule (Gate 2) pins the approved CLAUDE.md digest.

## Fail-on-purpose negatives (the check fails on known-bad input)
`tests/claude-md-check.test.ts` proves FAILED with the right reason for:
`CLAUDE_MD_DRIFT` (read digest != approved), `TARGET_NOT_CLAUDE_MD` (read a different file),
`MUTATIONS_DETECTED` (any mutation), `APPROVED_DIGEST_SHAPE` (malformed pinned digest),
`TASK_MISMATCH` (wrong task id), `PARSE_FAILED` (malformed capability result). The PASS
case (approved digest, 0 mutations, CLAUDE.md target) is also asserted.

## Test evidence (local)
- `tests/claude-md-check.test.ts`: 9/9 PASS.
- typecheck: PASS. lint (`--max-warnings=0`): PASS.
- Pure regression across the changed surface (contracts, kernel, capabilities, kj-000000,
  new-system-runtime, canary, scheduler pure): PASS.
- Baseline gate: unchanged and green — the 9 new tests are additive PASSES (not skips), so
  they do not alter the protected 224 baseline or the 32 intentional-skip allowlist. The
  guard still flags any *unexpected* skip, so silently skipping a canary test would fail CI.
- No `tests/baseline.json` change was required.

## Explicitly NOT done here (reserved for later gates)
- **Gate 2 (disabled install, change window):** extend the gateway public admission
  accept-list (`apps/gateway/src/server.ts` `PublicSubmission`) to include
  `claude_md_check/v1` so the scheduler can admit it; apply the scheduler migration to the
  kernel DB; insert the DISABLED canary schedule; verify schema/FK/RLS/state; soak disabled.
  The public HTTP admission surface is deliberately UNCHANGED in Gate 1.
- **Gate 3 (first live canary, separate authorisation):** enable the schedule.

## Readiness
Gate 1 deliverable complete: recipe implemented + registered in the recipe path, proven
read-only + deterministic + evidence-producing, with a fail-on-purpose negative suite, all
green locally. Ready for review and for the Gate 2 disabled-canary change window. Nothing
here touches production.
