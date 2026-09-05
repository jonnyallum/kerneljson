# Phase 1–3 validation results

Executed on 5 September 2026 on branch `codex/phase-1-3`, based on upstream `5dafa24`.

| Check | Observed result |
| --- | --- |
| `pnpm typecheck` | Passed, strict TypeScript |
| `pnpm build` | Passed |
| `pnpm test --reporter=default --reporter=json --outputFile=artifacts/local/phase1-3-tests.json` | 40 passed, 0 failed, 0 skipped; three test files; 97.94 seconds |
| Contracts and lifecycle | 29 tests passed |
| PostgreSQL migrations and constraints | 7 tests passed |
| Real Restate recovery and API | 4 tests passed |

Toolchain: host Node 25.2.1, container Node 22.19.0, pnpm 10.4.0, TypeScript 7.0.2, Zod 4.5.4, Vitest 5.0.0, Restate SDK 1.17.0, Restate server 1.7.9, PostgreSQL 17.6. Supabase CLI 2.114.0 generated the migration files. The validation runtime was Docker Engine 29.8.0 in the existing Ubuntu WSL installation.

The combined suite verified actual process crashes and recovery, not simulated Restate contexts. It killed/restarted both Restate and its worker during a durable wait. It also forced the worker to exit after committing step B to PostgreSQL and before acknowledging that write to Restate, then checked successful replay with exact event/step/evidence counts. Concurrent duplicate signals, repeated submission, cancellation and unsupported requests were exercised through the live service; the typed client's submit/status/signal/cancel methods were exercised too.

The SQL tests execute all four migrations on a fresh local PostgreSQL database with Supabase API roles. They test event mutation rejection, default-deny API access, lifecycle constraints, evidence-bound completion, terminal-record immutability, provenance foreign keys and idempotency constraints. These results do not establish hosted Supabase Auth/PostgREST/Storage behavior; the full Supabase local stack was not run.

Earlier runs exposed and resolved test-harness issues (WSL idle shutdown, HTTP/2 discovery and container PID 1 fault injection) and a PostgreSQL JSON-operator precedence bug in the completion trigger. The final combined run above includes those fixes and a positive SQL completion regression test.

The machine-readable test report is generated locally under `artifacts/local/phase1-3-tests.json`, which is intentionally Git-ignored. No remote migration, remote dry run, model integration, channel integration, UI, memory retrieval or autonomous workflow was performed. Runtime/test limitations and the exact proposed remote dry-run command are in [the runbook](phase-1-3.md).
