# Phase 8: Evidence and verification

`verifyTaskEvidence` independently checks persisted uppercase capability output,
input and descriptor digests, task/step ownership, exact acceptance criteria,
policy provenance and any required human approval evidence. Missing, foreign,
expired or inconsistent evidence fails closed.

`VerificationStore.finish` verifies under the task transaction lock and writes
the Outcome, terminal event and projection atomically. Concurrent retries return
the same immutable Outcome. Failed verification creates FAILED and a
VERIFICATION_FAILED event. Only the initial uppercase recipe is supported.

Run `pnpm typecheck`, `pnpm build` and `pnpm test`. Tests include invalid evidence
fixtures and concurrent finalization of real policy-approved Restate executions,
with matching and deliberately unsupported acceptance criteria. See STATE.yaml
for the executed report. No remote migrations or new SQL are required.
