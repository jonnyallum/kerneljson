# KJ-P7B-1 implementation qualification

Date: 2026-09-30. Scope: local implementation and disposable qualification only.

Design: ADR-0022 sealed at `2dd2af5909b8fc49d208834ba9d2a99148ba5daa`, with the D1
call-time binding errata `a1e8381b0cac9092ec70b4c0775649979e8d1e9f` and
`354a6c3fab0a2af7d74724d4c618a59ca3286729`.

## Implemented contract

- The analyst assembler inserts one bounded identity projection after the faculty header when REQUIRED.
  NONE and legacy requests retain the pre-P7B bytes. Reviewer assembly remains isolated.
- PostgreSQL persists an immutable tenant/step/release-bound latch, with deferred constraints enforcing
  REQUIRED plus one pin or NONE without a pin. The cognition contract marker is created empty.
- Call-time authorization re-reads the canonical latch/pin and checks the assembly digest against the
  exact request passed to the provider. The existing model-result validator binds the complete request,
  provider and model through the receipt's request digest.
- The validated receipt hook writes an idempotent, immutable MODEL_CALLED binding containing identifiers
  and digests. It contains no prompt, memory text, projection text, credentials or provider request body.
- Ledger completion cross-checks persisted runtime evidence, the call binding and canonical latch/pin.
  The pure verifier never reconstructs the prompt or imports assembly or model services.
- Versioned SQL and TypeScript identity digests share one corpus, including the approved Kernel v1.
  The migration refuses digest disagreement and unexpected privilege exposure before commit.
- All seven identity health checks have explicit alert policies. No observation and database-unreachable
  states are silent P3; real identity binding and isolation failures retain their specified severity.

## D1 evidence

`tests/identity-cognition.test.ts` covers message-byte and token-budget sensitivity, provider-independent
assembly/continuity digests, completion refusal for each mismatched binding field, and strict payload shape.

`tests/identity-cognition.integration.test.ts` exercises the actual PostgreSQL ledger, including:

- request object identity between authorization and provider generation;
- equality of the persisted assembly digest and validated full-request receipt digest;
- refusal of a receipt for a different request before any MODEL_CALLED binding is written;
- receipt replay after a lost journal acknowledgement, without duplicate call bindings;
- completion refusal for call-id, request, assembly and continuity digest mismatches;
- canonical memory promotion, consumption and retraction, proving later requests omit the retracted
  text while earlier immutable call bindings and runtime evidence remain unchanged;
- OFF/REQUIRED missions, environment flips, replay, missing/corrupt pins, version pinning and ACLs.
- two fresh missions on different fake providers, comparing the full stable identity/faculty set and
  assembly/continuity digests while requiring different execution IDs, routes and request digests.

Replay in the P7B-specific suite uses the established journal simulation against a real PostgreSQL ledger.
It is not a live provider or live production Restate qualification.

The OFF golden fixture was independently reproduced from the unmodified release
`4127361860700085453f86aa09adfa7bf81ef7d3`, including both provider HTTP request bodies.

The existing P7A raw-SQL fixtures now compute real version digests so their original authority assertions
remain reachable under the new parity trigger. The release-provenance migration fixture explicitly removes
the later P7B dependencies before reconstructing its historical schema. Neither historical migration changed.

## Validation results

- `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm check:topology`: PASS.
- Full regression: 1,794 passed, 62 declared environment-gated skips, zero failures (1,856 total).
  `pnpm test:baseline`: all 224 protected tests retained; all 31 recovery tests passed.
- Targeted fixture, G5 and D1 regression: 144 passed, zero skips or failures.
- Production worker image built locally; network-isolated startup passed with memory OFF and ON.
  The missing-memory-directory negative control refused startup as expected.
- Independent OFF golden recapture from `4127361`: exact match.
- Final P7B baseline after mutation-coverage repairs: 143 passed, zero skips or failures; the migration
  chain applies both with plain privileges and reproduced Supabase default privileges.
- P7B mutation qualification: all 62 cases detected, 59 by failing tests and three by the migration's
  explicit pre-COMMIT refusal. Zero surviving or inconclusive cases remain after targeted rechecks.
  This includes both deferred triggers, every identity alert-policy row, forbidden Class D/presentation
  projection, receipt validation, call binding, completion verification and all six import fences.

Machine-readable reports and logs are retained locally under `artifacts/local/`, including `tests.json`,
`p7b-full-suite.log`, `p7b-regression-fixes.json`, `p7b-worker-smoke.log` and `p7b-off-recaptured.json`.
The initial full-run failure is also retained: older digest/schema fixtures were corrected, and the
transient Docker setup failure was resolved by a successful full rerun. No failed tests were skipped to pass.

The first mutation run found two collection-time fixture failures and one legacy-state test masked by a
second violation. Projection fixtures now construct inside test bodies, and the legacy-state negative
isolates its one violation. Rechecks `C28`, `C55` and `C42` all fail as intended under their mutations.
Both runs are retained in `p7b-mutations.log`, `p7b-mutations-recheck.log` and their corresponding
`identity-cognition-mutations*/` report directories. `p7b-mutation-verdicts.json` records the latest
verdict and source log for every case. Source hashes verify that all intentional mutations were restored.

## Production boundary

No production deployment, migration, activation, configuration change or provider call was performed.
The feature defaults OFF. Production epoch 13 activation, marker insertion and the P7B-2 live provider
proofs remain separate windows. Class C/D remains frozen.

Follow `KJ_P7B1_ACTIVATION_PRECONDITIONS.md` for the measured worker-role gate, atomic activation,
OFF-byte proof and rollback drain requirements. This record does not authorize those operations.
