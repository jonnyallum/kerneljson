# KJ-P8 R2.7.6 to R2.7.9: regression inventory against the B1 runner contract

Read-only inventory, taken on 09/10/2026 at the frozen B1 candidate `0ff2919c1bbf722b4842aa56fdc94ef9b74e5a51` (the
parent of the B1 remediation branch). It supports ADR-0023 section 27.12.15. Nothing here was executed against a
database; the classification is from the source.

Revision 2.7.7 corrects this inventory (R276-B2). The 2.7.6 version classified `identity-cognition.integration`,
`identity-migration.integration` and `runtime-roles-negative` at file level only, and gave the definers file a coarse
line-range split. The corrected file rows, the block-by-block partition of every mixed file, the protected-test and
intentional-skip facts and the mutation-suite facts are below. Where this document and an earlier version differ,
this one governs.

Revision 2.7.8 corrects it again (R277-B1 to B3 and the review's factual findings): the identity mutation suite has 57
mutations, not 44; `tests/baseline.json` was last changed by commit `1fbe6b2`; the frozen `_ledger` test is restored
as six hooks with its six exact messages; and the hook mappings now carry exact expectations and preconditions.

Revision 2.7.9 pins the `_acl` precondition to the `proacl` items, corrects the description of B1's four `SELECT`s,
and records the collection and log-extraction evidence below.

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
| `identity-migration.integration.test.ts` | knowledge helper, plus own `identity_acl_*` | 19 blocks yes; the default-ACL block applies B1 only incidentally | mixed: D (19 blocks), A (the `identity_acl` block); see the block table | its tests also run under `mutation-check-identity` |
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
| `identity-cognition.integration.test.ts` | own databases: `p7b_pre_*` (one per case), `p7b_acl_*`, `p7b_main_*` | `p7b_pre` never applies B1; `p7b_acl` applies it only incidentally; `p7b_main` yes | mixed: A (`p7b_pre`, `p7b_acl`), D (`p7b_main` and its nested blocks); see the block table | its tests also run under `mutation-check-identity-cognition` |
| `mission-workflow.integration.test.ts` | own `kj_p3_*` | yes | D | A, under `mutation-check-faculties` |
| `runtime-roles-catalogue.integration.test.ts` | own `kj_b1_cat_*` | yes | D | |
| `runtime-roles-connection.integration.test.ts` | own `kj_b1_con_*` | yes | D | |
| `runtime-roles-negative.integration.test.ts` | own `kj_b1_neg_*`, migrated with B1 | yes | D, suite with `refusalPolicy` `probes` | the 27.6 item 4 negative qualification: per role, 51 `FORBIDDEN` probes plus 3 named tests; 8 `SEPARATION` probes; per role, 28 `PROBES` rows of 27.9.5 plus rows 25 to 27; writes `b1-negative-probes.json` and `b1-definer-probes.json`. Every probe is a required test (`tests/b1-required.json`). Rows counted by pattern; the collection at `R` is authoritative |
| `runtime-roles-definers.integration.test.ts` | own `kj_b1_def_*` built by hand (base chain, hand-made ledger, schema `auth` with four platform-style definers, in-test snapshot, then B1), plus `_acl`, `_tamper`, `_ledger` | yes | mixed: A, B, C and D; see the block table | its 28 `FIXTURES` are health-detection fixtures on the applied database (lane D) |
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
| `scripts/mutation-check-faculties.mjs` | 5 mutations, of `services/kernel/src/faculty/policy.ts` and of migration `20260923150000`; runs `faculty.test.ts` and `mission-workflow.integration.test.ts` (which call `migrate()`) | lane A; in the frozen CI (`validate`) |
| `scripts/mutation-check-identity.mjs` | 57 mutations (57 distinct literal ids; corrected in revision 2.7.8 from 44, which counted array lines), of migration `20260925120000` and of application code; runs ten files, three database-backed | lane A; in the frozen CI (`validate`) |
| `scripts/mutation-check-memory.mjs` | 23 mutations, of migration `20260921180000` and of application code; runs three files, two database-backed | lane A; not run by the frozen CI, not added |
| `scripts/mutation-check-identity-cognition.mjs` | 62 mutations (56 literal ids and six generated by a `map`, `C49` to `C54`), of migration `20260929120000` and of application code; its own loop applies every file, B1 included (lines 165 to 168) | lane A, its loop applying the base set only; in the frozen CI (own job) |
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
| mutation checks edit a base migration or application code, then re-run tests | a mutated migration fails 27.12.11 step 7 (exported files must equal their pins); a mutated source file leaves the checkout dirty, which 27.12.6 step 1 refuses. Neither can run in a runner run |
| a test pauses the database container | not forbidden in words, but the container would be the runner's cluster, which no test may reach (27.12.13.8, last static bullet) |

## Block-level partition of the mixed files (revision 2.7.7)

Each frozen describe block is assigned by what it executes. In the remediation every mixed file is split at these
boundaries into single-lane files; the new file names are the implementation's, and this table is the trace from each
frozen block to its lane. Nothing is deleted, skipped or downgraded.

**`tests/identity-cognition.integration.test.ts`**

| Frozen block | What it executes | Lane |
|---|---|---|
| "the migration's pre-COMMIT qualification refuses bad production states (and applies on the true one)", 3 tests | per test, a fresh `p7b_pre_*` database: the base chain before P7B (`migrateBefore`), seeded identity rows, then P7B (`20260929120000`) itself. B1 is never applied | A |
| "least privilege under a Supabase-style default ACL (PR #47 harness), including service_role", 5 tests | `p7b_acl_*`: platform roles, `ALTER DEFAULT PRIVILEGES` granting everything to `public`, `anon`, `authenticated` and `service_role`, then `migrate()` (every file, B1 included); asserts those grantees' privileges on P7B objects | A, on the base chain. B1 creates no object and grants only to the runtime roles (case CON-32), so it cannot change an asserted fact. Residual: B1 is not applied under a Supabase default ACL in repository regression; target qualification covers the production ACL |
| "KJ-P7B-1 against the real ledger" and its four nested blocks (SQL twin corpus, parity trigger and marker, latch table, missions under the contract) | `p7b_main_*` migrated with B1; production code paths | D, `refusalPolicy` `none` unless a test is shown to probe a runtime role, in which case it moves to a `probes` suite |

**`tests/identity-migration.integration.test.ts`**

| Frozen block | What it executes | Lane |
|---|---|---|
| the 19 blocks from "identity_profiles: bootstrap ownership guard" to "a second bootstrap is still refused once an identity exists" | the knowledge-helper database migrated with B1; identity triggers and guards, including "RLS: anon and authenticated have no access to any identity table" | D |
| "least privilege under a Supabase-style default ACL: PUBLIC, anon and authenticated hold NO privilege on any P7A relation" | `identity_acl_*`: platform roles, default ACL granting to `public`, `anon` and `authenticated`, then `migrate()` (B1 included); asserts those grantees hold nothing on P7A relations | A, for the same reason and with the same residual as `p7b_acl` |

**`tests/runtime-roles-negative.integration.test.ts`**: one database migrated with B1; every block probes the runtime
roles directly. Lane D, in a suite with `refusalPolicy` `probes`; every probe required.

**`tests/runtime-roles-definers.integration.test.ts`**

| Frozen block or step | What it executes | Lane |
|---|---|---|
| `beforeAll`: base chain, hand-made ledger, schema `auth` with four definers, in-test snapshot, B1 | the fixture and the B1 application | B: the runner's S1 to S7 under setup profile `platform-definer-fixture` (S2 creates the same four definers, S3 is the snapshot, and the ledger is the engine's real one) |
| "27.9.3 source digest", test "derivation A (catalogue of main without B1)..." | reads the stamp function's source before B1 | A, on the base chain |
| "27.9.3 source digest", test "after B1 the catalogue source still equals the pin" | reads after B1 | D |
| "27.9.4 the exception's exact catalogue values", 4 tests | reads after B1 | D |
| "27.10.4 the read-only platform snapshot", 3 tests | the first two read the snapshot's result; the third calls the snapshot tool on the applied database and expects refusal | D, profile `platform-definer-fixture`, reading the copies of the run-bound baseline and declaration that stage T provides |
| "27.10.1 ACTUAL equals EXPECTED(B1)...", 8 tests | health and inventory on the applied database, some creating schemas and functions to show detection | D, same suite |
| "27.9.4 and 27.10: every assertion fails on purpose", 28 `FIXTURES` | tamper and restore on the applied database; health must report each | D, same suite |
| "27.10.2 the excluded-schema predicate, observed", 2 tests | temporary schema names; `CREATE SCHEMA pg_kj_probe` refused | D |
| "the B1 migration's pre-COMMIT self-check", test "removes any foreign EXECUTE grant..." (`_acl`) | `grant execute on function` the stamp function `to anon, authenticated` before B1, then B1; asserts the ACL is exactly the owner's EXECUTE | C: hook at `S2`. Precondition (pinned in revision 2.7.9, read from `aclexplode(proacl)`, never `has_function_privilege`): `proacl` is not null and its items are exactly three EXECUTE grants by `postgres`, not grantable, to `postgres`, `anon` and `authenticated` (`proacl::text[]` as a set: `postgres=X/postgres`, `anon=X/postgres`, `authenticated=X/postgres`). Before the hook it is `{postgres=X/postgres}`, because `20260916205049_release_provenance.sql` revokes all from `public`, `anon`, `authenticated` and `service_role` (INFERRED from the migration text; the runner cluster's owner is `postgres`). `expected`: S6 commits, S7 passes, and the stamp function's `proacl` is exactly `{postgres=X/postgres}` |
| same block, test "refuses to commit B1 when the stamp body differs from the pin (23514)" (`_tamper`) | the stamp body changed (`prosrc || ' '`) before B1; asserts `23514`, a message naming the source digest, and full rollback | C: hook at `S2`. Precondition: the stamp function's source digest differs from the 27.9.3 pin. `expected`: the run ends at S6 with SQLSTATE `23514` and a message matching `source digest of kernel_private\.stamp_binding_provenance\(\)`; afterwards the stamp function is not a definer and the ledger has no B1 row |
| "27.11.6 item 3: the snapshot needs the ledger at the expected head and the stamp function" (`_ledger`), six refusals and one success, each with its exact frozen message | see the next table | C: six hooks; the success case is B (EPH-1, whose S3 records the same `migrationLedger` provenance) |

The frozen `_ledger` test's six refusals become six hooks at `S2`, each ending the run at S3 with the snapshot tool's
exact frozen message (`PLATFORM_BASELINE_REFUSED: ...`). Nothing is merged or dropped.

| Hook | Effect at S2 | Precondition (exact result) | Expected at S3 |
|---|---|---|---|
| ledger absent | drop `supabase_migrations.schema_migrations` | the table does not exist | "the migration ledger supabase_migrations.schema_migrations does not exist" |
| wrong head | delete the newest base version's row | the ledger head is the second newest base version | matches "the migration ledger head is [0-9]{14}, not [0-9]{14}, the final base migration before B1", with the two versions named |
| gapped ledger | delete the rows of the 11th to 13th base versions | exactly those three versions are absent and the head is correct | "the migration ledger does not record exactly the 22 base migrations before B1; missing" followed by those three versions |
| unexpected row | insert version `20250101000000` | that row is present and the 22 base rows are intact | "the migration ledger does not record exactly the 22 base migrations before B1; unexpected 20250101000000" |
| B1 already recorded | insert version `20261002090000` | that row is present | "B1 is already applied to this database" |
| stamp function missing | rename `kernel_private.stamp_binding_provenance()` | no function of that identity exists | "kernel_private.stamp_binding_provenance() does not exist" |

The last frozen assertion (snapshot succeeds once all hold, with `migrationLedger` equal to the table name, present,
the final base version as head, `b1Recorded` false and the 22 versions) is checked on EPH-1's recorded S3 provenance.
The two ledger-writing hooks change only the disposable runner database of a negative-fixture run; they never repair,
backfill or synthesise any other ledger.

## Protected tests and intentional skips (facts at `0ff2919`)

- `tests/baseline.json` (its `commit` field reads `705a1af`, which is not in the file's history; `git log` shows the
  file last changed by `1fbe6b2`, 17/09/2026, corrected in revision 2.7.8): 224 protected tests in 16 files: `capabilities` 25, `contracts` 29,
  `database` 17, `evaluation-db` 3, `evaluation` 7, `kernel` 18, `memory` 8, `mission-control` 5, `models` 44,
  `policy` 13, `recovery` 27, `routing` 6, `schedule-db` 2, `schedule` 4, `verification` 9, `world` 7. None is in a
  block assigned to lane A, B or C above.
- 62 `intentionalSkips` in 10 files: the six `KJ_TEST_PG_URL` files, `gate3-executor`, `schedule-restate-live`,
  `schedule-restate-runtime` and `schedule-restate-rearm-live`.
- `scripts/check-baseline.mjs` requires: report `success`; zero failed; each protected test passed; no skip outside
  `intentionalSkips`; no intentional skip absent; `recovery.test.ts` passed at least 27.

## Proposed primary suites (for the partition at `R`)

| Suite | Lane | Profile | `refusalPolicy` | Files |
|---|---|---|---|---|
| `regression-enforce` | D | `none` | `none` | every lane D database-backed file not listed below, the six compose-stack files, and the 66 no-database files |
| `regression-probes` | D | `none` | `probes` | `runtime-roles-negative`, and any file shown to probe a runtime role deliberately |
| `regression-definers` | D | `platform-definer-fixture` | `probes` | the lane D part of the definers file |
| `regression-gated` | D | `none` | `none` | the six `KJ_TEST_PG_URL` files |
| `regression-helper-probes` | D | `pinned-helper` | `probes` | the case 21 and 22 probes as runtime roles |
| `base-regression` | A | not a runner run | n/a | the lane A blocks above |
| `runner-cases` | B and C | not a runner run | n/a | the files that invoke the ephemeral entry point (27.12.9, 27.12.13.9, the CON cases, the definers' B and C parts) |

Secondary: a discover twin of each `regression-*` suite, and the faculty, identity and identity-cognition mutation
suites. The final list is pinned in `tests/lanes.json` at `R` by the remediation and reviewed with it.

## B1 statement shape (for case CON-32)

In the frozen B1 migration at `0ff2919`, by leading keyword: 130 `CREATE POLICY` and 142 `GRANT`, every one to
`kj_worker` or `kj_door`; 7 `REVOKE` (`CREATE` on schema `public` and `EXECUTE` on all functions from `PUBLIC`, the
blanket revokes of tables, sequences, functions and schemas from the runtime roles, and the stamp function from
`PUBLIC`); 2 `ALTER ROLE` (the two runtime roles' attributes); 2 `ALTER FUNCTION` (the stamp function's
`SECURITY DEFINER` and `search_path`); 10 `DO` blocks (role creation, cleanup loops, `TEMPORARY` and `CONNECT` by
`format`, the stamp ACL cleanup and the pre-COMMIT checks). The four lines that begin with `select` (migration lines
332, 345, 348 and 354) are inside the pre-COMMIT `DO` blocks, not top-level statements (corrected in revision 2.7.9).
No `CREATE TABLE`, `FUNCTION`, `VIEW` or `SEQUENCE`. The remediated B1 replaces the blanket function revoke with the enumerated cleanup of 27.12.5; CON-32 pins
the remediated shape.

## Test identity (facts from the R2.7.7 review, not re-run here)

The reviewer ran `vitest list --json` on the frozen tree (vitest 5.0.0, Node 20, offline): 1,528 entries from 104 of
107 files (the three live-Restate files whose top-level suite is skipped were absent); `.each` tests as unexpanded
templates; `describe.skip` titles lost; repeated (file, name) pairs; 112 of 224 protected tests and 0 of 62
intentional skips matchable by name; 25 entries for `recovery.test.ts`; 9 templates for `runtime-roles-negative`.
Revision 2.7.8 therefore uses collection for source locations only, and expanded report entries for identity.

## Evidence for revision 2.7.9 (OBSERVED, 09/10/2026)

Run by the recording session on Windows 11 with Node 25.2.1 (the repository pins 22.19.0) and Docker 29.1.5, on a
disposable detached worktree of the frozen B1 `0ff2919` with `pnpm install --frozen-lockfile --ignore-scripts`
(Vitest 5.0.0). No production access; every container removed. The scripts are held outside the repository; their
SHA-256s: `collect.mjs` `16baa08f...fcb`, `variants.mjs` `abc44eb0...b52a`, `logexp.mjs` `87dacfa7...d6f7de`,
`logparse.mjs` `e7bd580b...36f2`.

**Collection** (`node node_modules/vitest/vitest.mjs list ...`, environment built from nothing as ADR-0023 27.12.15
pins, a TCP listener on `127.0.0.1:54999` counting connections):

| Form | Exit | Entries | Files of 107 | Without location | Missing files |
|---|---|---|---|---|---|
| pinned: `--no-static-parse --includeTaskLocation --json`, four flags, placeholder `KJ_TEST_PG_URL` | 0 | 2192 | 107 | 0 | none |
| static parse (`--includeTaskLocation --json`) | 0 | 1528 | 104 | 0 | the three `schedule-restate-*` files |
| no `--includeTaskLocation` | 0 | 2192 | 107 | 2192 | none |
| no `KJ_GATE3_LIVE` | 0 | 2190 | 106 | 0 | `gate3-executor` |
| no `KJ_TEST_PG_URL` | 0 | 2149 | 101 | 0 | the six gated files |
| three flags, no `KJ_TEST_PG_URL` (the 2.7.8 form) | 0 | 2147 | 100 | 0 | `gate3-executor` and the six gated files |

Connections accepted on the placeholder during the pinned collection: 0. Every location in the pinned output points
at a test-registering call; for multi-line `.each` calls it is the closing `])(` line (167 such entries, inspected).
The pinned run's standard output SHA-256: `73ccff08df277ff2fbd36de3c115ccb90aaed83a8ebe4e162ba57f0723f92f88`. Not
reproduced here: the execution-report match of the 224 protected tests and 62 intentional skips (it needs the
database-backed suite), which is reviewer-derived evidence.

**Log extraction**: a cluster from `postgres@sha256:00bc8661...` (the pinned image), `log_line_prefix` set to the
pinned `kjlog|%p|%l|%e|%u|%d| ` with `ALTER SYSTEM` and `pg_reload_conf()`, a `kj_worker` login role, a table it may
not read and a SQL function reading it; `pg` 8.23.0. Twelve refusals, all `42501`: the same statement from two tests;
a multiline statement with a TAB and two spaces inside a literal; `select public.peek()` (logged `ERROR`, `CONTEXT`,
`STATEMENT`); a named prepared statement twice; a parameterised statement; a named parameterised statement twice; a
statement of more than 600 characters; two statements differing only by whitespace inside a literal. Every record
carried the prefix with `%e` `42501`, including `CONTEXT` and `STATEMENT`; `%l` advanced on every record; continuation
lines began with one TAB. The extraction found nine (role, SQLSTATE, fingerprint) keys, three with multiplicity 2,
equal to the trace projection, with no association error. Each perturbation failed: one identical refusal dropped; a
third added; a `STATEMENT` moved to another process id; whitespace inside a literal altered; continuation TABs
removed; the next-line rule; the frozen harness's fingerprint (whitespace collapsed, truncated to 600); truncation
alone. The exact fingerprints of `... note = 'x  y'` and `... note = 'x y'` differ; collapsed, they are equal.

Not covered: PostgreSQL 17.6 was the server, but on Docker Desktop for Windows, not the Linux CI host; concurrent
backends were not exercised, so interleaving was not observed; `kj_door`, a `FATAL` refusal and `DETAIL` or `HINT`
records were not produced.

## Not established

- The duration of one runner application (base set and B1 through the pinned CLI) is not measured, so the time a
  regression run with one plan database per file adds is unknown.
- Whether every database-backed file needs exactly one database: counted from `create database` and helper calls, not
  executed. `identity-cognition.integration` creates one `p7b_pre` database per case; those cases move to lane A.
- Mutation counts are by pattern over the scripts; the gate pins the exact id sets from the scripts at `R`.
- Whether any lane D block other than `runtime-roles-negative` deliberately provokes a runtime-role `42501`, which
  would place it in a `probes` suite: the database-log check of 27.12.15 will show it, failing closed.
- Whether `vitest list --json` collects every file without a database: to be shown by the static test.
- Whether a network disconnect reproduces the paused-database fault closely enough for
  `schedule-restate-live.integration.test.ts` is to be shown by that file under the remediation.
