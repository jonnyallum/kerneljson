# KJ-P8 R2.7.6: regression inventory against the B1 runner contract

Read-only inventory, taken on 09/10/2026 at the frozen B1 candidate `0ff2919c1bbf722b4842aa56fdc94ef9b74e5a51` (the
parent of the B1 remediation branch). It supports ADR-0023 section 27.12.15. Nothing here was executed against a
database; the classification is from the source.

## Method

`grep` over `tests/*.test.ts`, `tests/support/*.ts`, `scripts/**` and `.github/workflows/qualification.yml` for:
`migrate(` (the helper in `tests/support/local.ts`); `knowledgeDatabase` (`tests/support/knowledge-db.ts`, which calls
`migrate()`); `create database`; `KJ_TEST_PG_URL`; `compose(`; `new pg.Pool` and `new pg.Client`; and the environment
switches `S1R_LIVE`, `S1B_REARM_LIVE` and `S1R_RUNTIME`. Each match was then read.

## Facts that decide the classification

- `tests/support/local.ts` `migrate()` applies every `.sql` file of the working copy's `supabase/migrations/`, in name
  order, each in a plain `begin`, query, `commit`. It has `exclude` and `only` options; only
  `tests/runtime-roles-definers.integration.test.ts` uses them.
- `vitest.config.ts` loads `tests/support/runtime-roles.ts` as a setup file for every test file. In mode `enforce`
  (the default) production code connects as `kj_worker` or `kj_door`, which B1 creates; in mode `discover` it runs under
  `SET ROLE` and retries refusals as the owner. Either mode needs the runtime roles, so **every database-backed test
  needs a database where B1 is applied**, as long as the harness is in either mode.
- The compose worker (`infrastructure/docker/validation.compose.yaml`) connects as `kj_worker@db:5432/kerneljson`.

## Totals

| | Files |
|---|---|
| `tests/*.test.ts` | 107 |
| no database (unit) | 66 |
| database-backed | 41 |
| of which call `migrate()` directly | 25 |
| of which use the knowledge-database helper | 13 (one file also calls `migrate()`) |
| of which are gated on `KJ_TEST_PG_URL` (database prepared by `scripts/b1/qualify-ci.sh`) | 6 |

## Lanes (ADR-0023 27.12.15)

- **A** base regression, no B1.
- **B** positive B1 application and qualification.
- **C** negative B1 tamper or mutation fixture.
- **D** application test that connects after a successful B1 application.
- **E** containerised worker or Restate, needing network access to the database.
- **U** no database: runs in any lane, needs nothing from this design.

## Database-backed test files (41)

| File | Database today | Needs B1 | Lane under 2.7.6 | Also |
|---|---|---|---|---|
| `authority.test.ts` | knowledge helper, own database | yes (harness) | D | |
| `controls.test.ts` | knowledge helper | yes | D | |
| `evaluation-db.test.ts` | knowledge helper | yes | D | |
| `execution-binding.test.ts` | knowledge helper | yes | D | |
| `gateway.test.ts` | knowledge helper | yes | D | |
| `identity-migration.integration.test.ts` | knowledge helper, plus own `identity_acl_*` | yes | D | A, under `mutation-check-identity` |
| `memory-canonical.integration.test.ts` | knowledge helper | yes | D | A, under `mutation-check-memory` |
| `memory.test.ts` | knowledge helper | yes | D | |
| `mission-control.test.ts` | knowledge helper | yes | D | |
| `release-provenance-postgres.test.ts` | knowledge helper | yes | D | |
| `schedule-db.test.ts` | knowledge helper | yes | D | |
| `terminal-hardening.test.ts` | knowledge helper | yes | D | |
| `world.test.ts` | knowledge helper | yes | D | |
| `control-signing-store.integration.test.ts` | own `kj_p4b1_*` | yes | D | |
| `database.test.ts` | own `test_*` | yes | D | A, under `mutation-check-identity` |
| `health-collect-postgres.integration.test.ts` | own `kj_health_collect_*` | yes | D | receives copies of its run-bound declaration and baseline (27.12.15) |
| `identity-cognition.integration.test.ts` | own | yes | D | A, under `mutation-check-identity-cognition` |
| `mission-workflow.integration.test.ts` | own `kj_p3_*` | yes | D | A, under `mutation-check-faculties` |
| `runtime-roles-catalogue.integration.test.ts` | own `kj_b1_cat_*` | yes | D | |
| `runtime-roles-connection.integration.test.ts` | own `kj_b1_con_*` | yes | D | |
| `runtime-roles-negative.integration.test.ts` | own `kj_b1_neg_*` | yes | D | privilege probes on a correctly applied B1; not a B1 tamper fixture |
| `runtime-roles-definers.integration.test.ts` | own `kj_b1_def_*`, `_acl`, `_tamper`, `_ledger` | yes | mixed: B (lines 58 to 79, base then in-test snapshot then B1; lines 348 to 354, ACL), C (lines 361 to 371, tamper; 379 to 406, ledger row inserted and deleted by hand), D (the inventory and predicate assertions on an applied database) | the B and C parts move to runner runs |
| `schedule-restate-live.integration.test.ts` | own, plus the Restate stack | yes | D and E | runs only with `S1R_LIVE=1`; `compose("pause", "db")` becomes a network disconnect |
| `schedule-restate-rearm-live.integration.test.ts` | own, plus Restate | yes | D and E | runs only with `S1B_REARM_LIVE=1` |
| `schedule-restate-runtime.integration.test.ts` | own | yes | D | runs only with `S1R_RUNTIME=1` |
| `telegram-approvals-store.integration.test.ts` | own `kj_p4b_*` | yes | D | |
| `telegram-channel.integration.test.ts` | own `kj_p4a_*` | yes | D | |
| `telegram-memory.integration.test.ts` | own `kj_p5_tg_*` | yes | D | A, under `mutation-check-memory` |
| `test-notification.integration.test.ts` | own `kj_p22b_*` | yes | D | |
| `alert-runner.integration.test.ts` | default `kerneljson`, compose stack | yes | D and E | |
| `gate3-executor.integration.test.ts` | default, `compose up db restate`, `down --volumes` | yes | D and E | |
| `identity-cognition-restate.integration.test.ts` | default, `down --volumes`, `up --build`, `exec worker` | yes | D and E | |
| `identity-workflow.integration.test.ts` | default, `down --volumes`, `up --build` | yes | D and E | A, under `mutation-check-identity` |
| `recovery.test.ts` | default, kills and restarts worker and Restate | yes | D and E | |
| `telegram-approvals.integration.test.ts` | default, `down --volumes`, `up --build` | yes | D and E | |
| `alerting-postgres.integration.test.ts` | `KJ_TEST_PG_URL` | yes | D | gated set |
| `canary-tooling.integration.test.ts` | `KJ_TEST_PG_URL` | yes | D | gated set |
| `gateway-bootstrap.integration.test.ts` | `KJ_TEST_PG_URL` | yes | D | gated set |
| `outbox-postgres.integration.test.ts` | `KJ_TEST_PG_URL` | yes | D | gated set |
| `schedule-fencing.integration.test.ts` | `KJ_TEST_PG_URL` | yes | D | gated set |
| `schedule-postgres.integration.test.ts` | `KJ_TEST_PG_URL` | yes | D | gated set |

Each file creates at most one database of its own, except `runtime-roles-definers` (four) and
`identity-migration.integration` (two). The six default-database files share `kerneljson` today and reset it with the
compose stack; under 2.7.6 each gets its own plan database.

## No-database test files (66, lane U)

`alert-runner`, `alerting-model`, `alerting-store-selection`, `approval-boundary`, `approval-test-cli`, `canary-config`,
`canary-fire`, `canary-gateway-admission`, `canary-lifecycle`, `canary-runner`, `canary-seed`, `capabilities`,
`claude-md-check`, `contracts`, `control-signing`, `docs-token-safety`, `evaluation`, `faculty`, `gateway-bootstrap`,
`github-read`, `health-model`, `identity-canonical`, `identity-cognition`, `identity-provisioning`,
`identity-secret-scan`, `identity-topology`, `kernel-worker-registration`, `kernel-workflow-capability`, `kernel`,
`kj-000000`, `legacy-conductor-adapter`, `memory-canonical`, `mission-cli`, `mission-core`, `models`,
`new-system-runtime`, `openrouter-port`, `outbox-gate`, `outbox-model`, `policy`, `primary-identity-contracts`,
`release-provenance`, `routing`, `runtime-env-merge`, `runtime-roles-topology`, `schedule-admission-identity`,
`schedule-fencing-types`, `schedule-next-window-boundary`, `schedule-persistence`, `schedule-production-sim`,
`schedule-production`, `schedule-restate-boundary`, `schedule`, `security-definers`, `telegram-adapter-units`,
`telegram-approvals`, `telegram-channel`, `telegram-commands`, `telegram-discover`, `telegram-notifier-http`,
`telegram-notifier`, `telegram-outbox-reply`, `test-notification`, `topology-guard`, `transport-config`,
`verification` (each `tests/<name>.test.ts`). `gateway-bootstrap.test.ts` builds a pool on an unreachable placeholder
URL and never connects.

## Support files and scripts

| File | Today | Under 2.7.6 |
|---|---|---|
| `tests/support/local.ts` `migrate()` | applies every file, B1 included | lane A helper: base set only, with the refusals of 27.12.15 |
| `tests/support/knowledge-db.ts` | creates a database, calls `migrate()` | lane D: uses its suite plan database; lane A: base only |
| `tests/support/runtime-roles.ts` | harness, `enforce` or `discover` | adds mode `base` for lane A; in stage T the runner sets the mode |
| `tests/support/worker.ts` | compose worker, `DATABASE_URL` from compose | lane E, reaches `kj-eph-db` on the run network |
| `infrastructure/docker/validation.compose.yaml` | `db`, `restate`, `worker` | stays for lane A; a regression compose file without `db`, joined to the run network, for lane E |
| `scripts/b1/qualify-ci.sh` | discover run of the whole suite; `kj_gated` migrated with B1 by `migrate()`; gated files | discover and gated become registered regression suites run in stage T |
| `scripts/mutation-check-faculties.mjs` | mutates `20260923150000`, runs `faculty.test.ts` and `mission-workflow.integration.test.ts` (which call `migrate()`) | lane A |
| `scripts/mutation-check-identity.mjs` | mutates `20260925120000`, runs ten files, three database-backed | lane A |
| `scripts/mutation-check-memory.mjs` | mutates `20260921180000`, runs three files, two database-backed | lane A |
| `scripts/mutation-check-identity-cognition.mjs` | mutates `20260929120000`; its own loop applies every file, B1 included (lines 165 to 168) | lane A: its loop applies the base set only |
| `scripts/b1/build-manifest.mjs`, `static-inventory.mjs`, `analyse-trace.mjs`, `summarise.mjs`, `runtime-graph.mjs` | repository analysis, no database | unchanged |
| `scripts/b1/platform-baseline-snapshot.ts` | operator snapshot tool | hosted snapshot (27.12.6), and the runner's S3 in ephemeral mode; no test connects through it |
| `.github/workflows/qualification.yml` | `validate`: whole suite in enforce, mutation checks; `b1-qualification`: `qualify-ci.sh`; `identity-cognition-mutations` | lane B, C and D runs through the ephemeral entry point; lane A for the mutation checks |

## Contradictions with revision 2.7.5

| Behaviour | Rule it breaks |
|---|---|
| `migrate()`, `qualify-ci.sh` and `mutation-check-identity-cognition.mjs` apply B1 without the runner | 27.12.8 item 9; P3 step 1 aborts without the settings (27.12.7) |
| tests create their own databases, under random names | 27.12.13.3 L1 (`plannedApplications` a runner constant) and "One cluster, several databases" |
| tests and the worker connect to the B1 database themselves | 27.12.13.8 rule 5 and its last static bullet |
| the compose worker reaches the database at `db:5432` | 27.12.13.3 L2 and L3 (the cluster's only port is on `127.0.0.1`, unreachable from a container on a Linux CI host) |
| mutation checks re-apply a mutated base migration | 27.12.11 step 7 (exported files must equal their pins), so a mutated chain can never run in a runner cluster |
| a test pauses the database container | not forbidden in words, but the container would be the runner's cluster, which no test may reach (27.12.13.8, last static bullet) |

## Not established

- The duration of one runner application (base set and B1 through the pinned CLI) is not measured, so the time a
  regression run with one plan database per file adds is unknown.
- Whether every database-backed file needs exactly one database: counted from `create database` and helper calls, not
  executed.
- Whether a network disconnect reproduces the paused-database fault closely enough for
  `schedule-restate-live.integration.test.ts` is to be shown by that file under the remediation.
