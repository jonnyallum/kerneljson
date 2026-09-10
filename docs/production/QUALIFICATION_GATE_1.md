# Production Qualification Gate 1

Status: **PASSED** — local production qualification scope. This is post-Phase-15 qualification, not Phase 16 or deployment approval.

Protected baseline: `docs/kerneljson-prep-track-c` at `705a1af5c9ac882d590dfa3ef37fd04f385f2f00`. Baseline re-execution before runtime changes passed **224 tests, 27 recovery tests, zero failures/skips**. Every original test name/file is retained in `tests/baseline.json`; `scripts/check-baseline.mjs` rejects missing, failed or skipped baseline cases. No baseline assertions were removed. The existing recovery test's control adapter construction now supplies its database dependency.

## Implemented workstreams

| Workstream | Implementation and evidence |
| --- | --- |
| A1 | Frozen dependency installation, Node/pnpm pins, real ESLint pipeline, full CI checks and retained JSON reports. Baseline-name regression guard. |
| F1 | `THREAT_MODEL.md`, `PERMISSION_MATRIX.md`, ADR 0017. Covers external identity, current membership, private runtime handlers, operator trust and historical provenance. |
| G1 | Strict binding contracts; immutable private SQL binding; deployment-owned family/version catalogue; factories persist binding with task creation. Admission reserves binding before dispatch. A different release cannot first execute an already reserved task. |
| A3 | Evidence freshness checks; unresolved-effect completion guards; immutable terminal fallback results; permanent schedule verification failure becomes FAILED; durable idempotent receipt reconciliation. |
| A4 | Active/revoked/removed membership semantics, action roles, immutable lifecycle audit and historical principal retention. HTTP and database adversarial tests. |
| D1 | Task-bound routing for all six existing workflow families; explicit supported actions and cancellation states; Mission Control buttons reflect task state and binding. |
| E1 | Authenticated gateway factory, strict two-recipe public submission, 16 KiB body bound, correlation ID, tenant/principal-scoped idempotency, mandatory admission hook, durable status/history/evidence/outcome and read-only knowledge endpoints. |

## Architecture and runtime limits

A Task remains the primitive. Restate owns scheduling, waits, execution and retries. PostgreSQL records trusted bindings and immutable receipts; no SQL polling dispatcher was introduced. The gateway returns a persisted task identity before any dispatch acknowledgement can be trusted. A client can retry the same request/key after a lost acknowledgement. Conflicting reuse returns 409. Transport ambiguity is `UNRESOLVED`; it never means COMPLETED.

The gateway is a composable HTTP handler, deliberately not a publicly listening executable. Deployment must supply a real credential verifier, selected tenant resolution, current admission policy, internal transport credentials and release identity. Tests use explicit opaque test tokens. No test token is a production authentication implementation. The default worker still exposes its original two internal workflows; later factories are exercised by the isolated integration worker. Hosting those factories and a real gateway is a later deployment qualification task.

Execution bindings include family/service, version, build/release, stable workflow key, creation time, trusted routing identity, control support and task definition digest. Existing unbound records remain readable; controls return UNSUPPORTED instead of guessing a workflow. Existing task replays preserve their first release. Unsupported historical versions fail closed; deployment may supply a trusted endpoint resolver/catalogue. Retaining compatible old workers is a release-management obligation.

`terminal_results` adds a read fallback without changing the original public `outcomes` table's cancellation semantics. FAILED/CANCELLED tasks remain visible even when their workflow never creates a happy-path Outcome. Explicit outcomes take precedence. Completion paths remain independently verified; a confirmed interaction receipt alone cannot complete a task. The effect receipt helper is internal reconciliation infrastructure, not an external write executor. No provider-level exactly-once claim is made.

Cancellation is cooperative. REQUESTED records intent, ACCEPTED records a supported handler acknowledgement, COMPLETED requires persisted CANCELLED state. A winning earlier RESUME decision rejects a later cancellation. Golden/policy/child cancellation is supported at approval waits; cancellation during their verification is explicitly unsupported. No control rewrites a terminal task.

Revocation denies new authority and keeps task attribution. Authorization holds a membership share lock during transactional operations; a committed revocation blocks subsequent authorization. In-flight operations authorized before revocation may finish. Bounded schedules recheck schedule authority before children. Already journaled work is not silently erased or reauthorized by changing its history.

## New migrations — local validation only

- `20260908233816_qualification_gate_1.sql`: private immutable execution bindings.
- `20260908234518_qualification_terminal_results.sql`: terminal fallback results and unresolved/confirmed effect receipts.
- `20260908234711_qualification_membership_lifecycle.sql`: membership status, timestamps and immutable lifecycle audit.
- `20260908234849_qualification_ingress_receipts.sql`: control, admission and dispatch receipts.

None was applied remotely. The existing linked Supabase project was not mutated. All migration tests use disposable local PostgreSQL with test API roles. A real Supabase staging upgrade remains outside this gate.

## Reproduce

Use Node **22.19.0**, pnpm **10.4.0**, Docker Engine/Compose v2. Images are PostgreSQL **17.6**, Restate **1.7.9**, and the pinned worker Node image. The TypeScript **7.0.2** compiler is retained through `@typescript/native`; ESLint's TypeScript parser uses the official side-by-side TypeScript **6.0.2** API alias. ESLint **10.10.0** and typescript-eslint **8.70.0** are locked.

From a fresh checkout on Linux:

```sh
corepack enable
corepack prepare pnpm@10.4.0 --activate
pnpm install --frozen-lockfile
export KERNELJSON_RELEASE_ID="$(git rev-parse HEAD)"
pnpm typecheck
pnpm lint
pnpm test --reporter=default --reporter=json --outputFile=artifacts/local/tests.json
pnpm test:baseline
pnpm build
```

On Windows with Docker in Ubuntu WSL, set `$env:KERNELJSON_DOCKER_WSL='Ubuntu'` before the test command. The local test worker defaults to `unreleased-development` when no release variable is injected; the test report records the actual source identity separately. CI injects its commit SHA into the worker. The full suite includes database, integration and recovery tests; running `test:unit` alone does not qualify a release.

CI uses only the fixed `kerneljson-validation` compose project, loopback ports, disposable database and test credentials. It has read-only repository permissions, no production environment, no vault/Supabase secrets and no remote migration command. It requires the default local Docker context and no remote Docker host. JSON test reports and tested commit identity are retained for 14 days. Do not point test ports/context at any persistent environment.

Required runtime configuration names only: `DATABASE_URL`, `PORT`, `KERNELJSON_RELEASE_ID`. Test configuration: `KERNELJSON_DOCKER_WSL`, `DOCKER_CONTEXT`, `CI`. Identity/admission/transport are injected typed dependencies, not task-body fields. Future real secrets must come from jVault project `kerneljson`; this gate requires no vault access or real model credential.

## Executed validation

Final fresh-source validation: **277 passed, 0 failed, 0 skipped; 31 recovery tests**. Frozen install, typecheck, lint, full tests, baseline guard and build all passed under Node 22.19.0 / pnpm 10.4.0. All 224 original tests and 27 original recovery cases remain; 53 tests were added, including 4 recovery cases. Runtime and test source did not change after the export. The tested Git tree is `6e3775b0bb6754b92a89a5d21c85dade98864d02`, injected into the test worker as release `gate1-6e3775b0bb6754b92a89a5d21c85dade98864d02`. Only qualification documentation/state were updated afterward. Detailed counts, report digest and every new test name are committed in `gate-1-validation.json`. Raw logs/report are retained in `artifacts/local/gate1-fresh/artifacts/local/`. CI execution on GitHub is separate from this executed local result; CI records its own exact commit SHA.

Baseline re-run: 224 passed, 0 failed, 0 skipped; 27 recovery. Targeted A3, identity, binding, control and gateway suites passed before the combined run. Initial ESLint/TypeScript API incompatibility was resolved using the side-by-side compiler/API arrangement, rather than downgrading the existing compiler or suppressing lint.

## Intentionally deferred

No staging or production deployment, remote migrations, DeepSeek qualification, external write adapters, new integrations, sandbox runtime, object storage, distributed quotas, identity-provider installation, TLS/network rollout, backup/restore drill or disaster recovery drill. Gateway deployment must provide and qualify those relevant boundaries before real ingress. Membership administration remains a trusted operator function; `database_actor` identifies the SQL session actor, so production must separately attribute individual operator access. The existing broad backend database credential is not a claim of production least privilege. Historical unbound tasks require an explicit reviewed migration if future controls are desired.

The next gate is not started by this work package.

## Failure history during qualification

The first combined implementation run passed 273 tests. A later run passed 276 and failed one new control test because its fixture attempted the forbidden transition APPROVAL_REQUIRED → VERIFYING. The database correctly rejected it. The fixture now transitions through RUNNING; no production lifecycle rule or baseline assertion was weakened. The corrected control/hardening suite passed all 21 tests. The failed run is retained locally as `artifacts/local/gate1-pre-final-tests.json`.

Typecheck initially caught an ambiguous Restate callback return type and a new test using the wrong TaskClient signature; both were corrected before final validation. Fresh pnpm installation reports an ignored esbuild build script under pnpm's default dependency-script policy; the installed platform package supplies the binary used by the executed suite. No blanket dependency-script approval was added.

## Changed-file inventory
- `.github/workflows/qualification.yml`
- `.node-version`
- `BUILD_PLAN.md`
- `README.md`
- `STATE.yaml`
- `apps/gateway/src/index.ts`
- `apps/gateway/src/server.ts`
- `apps/mission-control/src/server.ts`
- `apps/mission-control/src/store.ts`
- `apps/mission-control/src/view.ts`
- `docs/adr/0017-production-authority-and-execution-binding.md`
- `docs/production/PERMISSION_MATRIX.md`
- `docs/production/QUALIFICATION_GATE_1.md`
- `docs/production/THREAT_MODEL.md`
- `eslint.config.mjs`
- `infrastructure/docker/validation.compose.yaml`
- `package.json`
- `packages/contracts/src/execution.ts`
- `packages/contracts/src/index.ts`
- `packages/identity/src/index.ts`
- `pnpm-lock.yaml`
- `scripts/check-baseline.mjs`
- `services/kernel/src/approval-store.ts`
- `services/kernel/src/autonomous-workflow.ts`
- `services/kernel/src/execution-binding.ts`
- `services/kernel/src/executor/workflow.ts`
- `services/kernel/src/golden-workflow.ts`
- `services/kernel/src/ledger.ts`
- `services/kernel/src/policy-workflow.ts`
- `services/kernel/src/schedule-store.ts`
- `services/kernel/src/terminal.ts`
- `services/kernel/src/verification-store.ts`
- `services/kernel/src/verification.ts`
- `services/kernel/src/workflow.ts`
- `supabase/migrations/20260908233816_qualification_gate_1.sql`
- `supabase/migrations/20260908234518_qualification_terminal_results.sql`
- `supabase/migrations/20260908234711_qualification_membership_lifecycle.sql`
- `supabase/migrations/20260908234849_qualification_ingress_receipts.sql`
- `tests/authority.test.ts`
- `tests/baseline.json`
- `tests/controls.test.ts`
- `tests/execution-binding.test.ts`
- `tests/gateway.test.ts`
- `tests/recovery.test.ts`
- `tests/support/worker.ts`
- `tests/terminal-hardening.test.ts`

## Execution-path audit

| Family/path | Completion authority | Supported controls |
| --- | --- | --- |
| TaskWorkflow | Ledger independently verifies deterministic result; permanent rejection produces durable FAILED. | First-decision-wins signal/cancel. |
| KernelWorkflowV1 | Ledger verifies immutable compiled DAG, steps and task-bound evidence. | First-decision-wins signal/cancel. |
| PolicyCapabilityWorkflowV1 | Existing Phase 7 helper stops at VERIFYING; it does not emit COMPLETED. The final verifier is a separate responsibility. | Named approval and cancellation at approval wait. |
| GoldenTaskWorkflowV1 | VerificationStore re-reads persisted capability, policy, approval and evidence before atomic Outcome. | Named approval and cancellation at approval wait. |
| AutonomousChildTaskWorkflowV1 | Same independent final verifier, with parent/task binding. | Supported approval-wait controls only. |
| BoundedScheduleWorkflowV1 | Re-verifies each child plus schedule scope; permanent verifier rejection produces FAILED. | Cooperative cancellation; no generic signal. |
| Model/capability fault probes | Test-only handlers, excluded from public dispatch catalogue. Interaction receipts never themselves complete tasks. | No public routing. |

Tests cover missing/forged/task-foreign/step-foreign/stale/digest-altered evidence in contract, database, verification and terminal-hardening suites. Database tenant foreign keys and tenant-scoped endpoint tests cover tenant substitution. Existing capability/model recovery cases cover receipt commit/acknowledgement crashes; gateway recovery covers lost dispatch acknowledgement; the added verification-failure recovery covers a crash after FAILED commits. Control tests cover duplicate/losing decisions, unsupported verification-time cancellation and explicitly supported historical versions. Unknown external effects remain unresolved; no external-write qualification is claimed.

Additional evidence file: `docs/production/gate-1-validation.json`.

Gate 1 has no unresolved local test failures. Production prerequisites in the deferred section remain open and are not a claim of deployment readiness. Gate 2 has not started.
