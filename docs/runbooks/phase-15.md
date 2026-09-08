# Phase 15 checkpoint (historical)

Superseded by [the final preservation handoff](../../PHASE_15_HANDOFF.md). The three items listed below were completed before the preservation freeze; the saved full suite passed 224 tests. Production-readiness and lint gaps remain documented in the final handoff.

Saved on 2026-09-05 at the user's request. This phase remains in progress.

The bounded schedule workflow compiles an authenticated human request into a
fixed set of uppercase child tasks. Deployment configuration defaults to
disabled and bounds iterations, intervals and execution units. Restate owns
durable waits, child calls and recovery. Authorization is checked before each
child; cancellation stops future children. Child tasks use the golden workflow
and bind themselves to the persisted parent schedule. The production entry
point does not enable the scheduler.

Executed validation:

- `pnpm typecheck` and `pnpm build` passed.
- `tests/schedule.test.ts`: four tests passed.
- Phase 15 selection in `tests/recovery.test.ts`: four passed; 23 unrelated
  tests were not selected. Tests cover timer restart and final commit recovery,
  cancellation, authorization revocation, and unauthorized/orphan requests.
- Local report: `artifacts/local/phase15-recovery-tests.json` (ignored).

Before declaring completion:

1. Strengthen parent completion verification to independently validate each
   child's full evidence bundle, beyond completed outcomes and evidence refs.
2. Add a negative database test proving a completed schedule step cannot
   complete the parent when required child evidence is missing.
3. Run the full combined regression suite and review the final changes.
4. Update `STATE.yaml` with the actual results.

The last full combined suite was Phase 9 (175 passed). Phases 10–15 have
focused validation recorded separately; those results are not a full-suite
claim. Local tests use the dedicated Docker validation stack in Ubuntu WSL
with `KERNELJSON_DOCKER_WSL=Ubuntu`. Remote Supabase migrations and production
deployment remain unapproved and unexecuted. Secrets and raw local artifacts
are excluded from Git.
