# Phase 12: Evaluation framework

`pnpm eval:golden` executes the checked-in uppercase corpus against the registered
capability, hashes the candidate source and lockfile, and writes an ignored local
report. `evaluate` supports bounded trusted synchronous candidates; it records
expected/actual digests and sanitized errors. It is not a sandbox.

`EvaluationStore` executes its configured candidate and binds an immutable report
to an existing verified task/evidence. Identical concurrent runs reuse that report.
`canPromote` requires all cases from the exact configured suite to pass for the
exact candidate digest and checks tenant membership. It is a prerequisite check,
not permission to deploy or change policies. Callers must update the candidate
artifact digest when implementation changes. No code is modified automatically.

Validation: TypeScript and build passed, `pnpm eval:golden` passed all five cases,
and all 27 focused evaluation/database tests passed. Reports:
`artifacts/local/golden-evaluation.json` and `artifacts/local/phase12-tests.json`.
The evaluation-history migration was validated locally only.
