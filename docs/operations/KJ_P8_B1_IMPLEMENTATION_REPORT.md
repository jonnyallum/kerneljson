# KJ-P8 B1 implementation report: least-privilege runtime database roles

Status: ENGINEERING CANDIDATE, not merged, not deployed. **Repository-qualified; target platform baseline pending
(section 12).** Production was not touched. No P8A-0 object exists in this candidate.

Design authority: ADR-0023 revision 2.5, section 27 (including 27.9 and 27.10), hostile-sealed APPROVE at
`424f85c283a543ba00a650ecc2ecc3a4346623df` on branch `design/kjp8-reflection-governed-growth`. It supersedes revision
2.3 (`679e3a3`) for B1 and closes the ruling this report previously left open. Entry contract:
`docs/operations/KJ_P8_B1_ENTRY_BRIEF.md`, reconciled to revision 2.5. Base: `main`
`20e39f797be9c4c982bc32fb40b6aa1427b5c09c`. Candidate history: `4314858`, `108db1b` (the frozen candidate),
`d1a7d97` (revision 2.5 remediation), `d2a2447` (fixture corrections), then the evidence commit.

Tags used below: **FACT** was observed in this work; **INFERENCE** was reasoned and not exercised.

## 1. What B1 delivers

| Piece | Where |
|---|---|
| Two runtime roles, `kj_worker` and `kj_door`, with the sealed attributes | migration `supabase/migrations/20261002090000_runtime_least_privilege_roles.sql` |
| The frozen, machine-readable grant manifest | `infrastructure/database/runtime-role-manifest.json` |
| The reviewed departures from the static inventory, each with a reason | `infrastructure/database/runtime-role-decisions.json` |
| Deterministic inventory and generator | `scripts/b1/runtime-graph.mjs`, `static-inventory.mjs`, `build-manifest.mjs`, `analyse-trace.mjs`, `summarise.mjs` |
| Fail-closed runtime connection guard and catalogue comparison | `services/kernel/src/database/runtime-roles.ts` |
| Health check `database.runtimeRolesLeastPrivilege` (P0) | `services/kernel/src/health/{collect,evaluate,snapshot}.ts`, `alerting/policy.ts` |
| Suite harness that runs production code as the runtime roles | `tests/support/runtime-roles.ts` (test-only) |
| Catalogue equality, negative probes, connection guard, topology tests | `tests/runtime-roles-*.test.ts` |
| Stage-aware `SECURITY DEFINER` inventory (ADR 27.10) and the 27.9 exception checks | `services/kernel/src/database/security-definers.ts`, `infrastructure/database/security-definer-stage-manifest.json` (generated) |
| Read-only platform baseline snapshot (deployment authority) | `services/kernel/src/database/platform-baseline-snapshot.ts`, `scripts/b1/platform-baseline-snapshot.ts` |
| Definer qualification and the 27.9.5 probe matrix | `tests/security-definers.test.ts`, `tests/runtime-roles-definers.integration.test.ts`, `tests/runtime-roles-negative.integration.test.ts` |
| CI job running the discover run, inventories and gated files | `.github/workflows/qualification.yml` job `b1-qualification`, `scripts/b1/qualify-ci.sh` |
| Evidence | `docs/operations/evidence/kj-p8-b1/` |
| Cutover plan (not executed) | `docs/operations/KJ_P8_B1_PRODUCTION_CUTOVER_PLAN.md` |

## 2. Role contract as implemented

Both roles: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`, connection limit 40
(worker) and 20 (door). They own nothing, are members of nothing and have no members. The migration creates them
**without a password**; a password is set out of band at cutover. A pre-COMMIT block in the migration refuses to
commit if an attribute or a membership is not as sealed.

FACT: `tests/runtime-roles-catalogue.integration.test.ts` reads the attributes, ownership and memberships from the
catalogue for both roles and compares them with the manifest.

## 3. The one `SECURITY DEFINER` exception (ADR 27.9), as ruled

The ruling this report previously left open is closed by ADR-0023 revision 2.5 section 27.9: the existing trigger
function `kernel_private.stamp_binding_provenance()` becomes `SECURITY DEFINER`, the only such change B1 makes.
FACT: as `SECURITY INVOKER` its real `UPDATE kernel_private.release_epoch SET epoch = epoch` would force both runtime
roles to hold `UPDATE` on `release_epoch`, which section 27.3 forbids; the discovery run of the frozen candidate showed
admission failing under `kj_door` without it (`permission denied for table release_epoch`).

What the B1 migration does to it, and nothing else: `ALTER FUNCTION ... SECURITY DEFINER`, `SET search_path = ''`,
`REVOKE ALL ... FROM PUBLIC`, and a loop that revokes EXECUTE from every other non-owner grantee. It contains no
`CREATE FUNCTION` for it. A pre-COMMIT block refuses to commit unless `prosecdef` is true, `proconfig` is exactly
`{"search_path=\"\""}`, the ACL is exactly the owner's EXECUTE, the source digest equals the pin, exactly one function
in all governed schemas is named `stamp_binding_provenance`, and `public` plus `kernel_private` hold exactly one
definer.

FACT (CI run `37459729830` on `d2a2447`, `evidence/kj-p8-b1/b1-definers.json`):

| Assertion | Observed |
|---|---|
| source digest pin (reviewed input, `runtime-role-decisions.json`) | `468979611a28ca8e2ec7b46f16402e90ae6622a228e186e1acc7ac45186e439b` |
| derivation A: `pg_proc.prosrc` of a database migrated from `main` without B1 (SQL `sha256` and Node, separately) | both `468979611a28...` |
| derivation B: text between the dollar quotes in `20260916205049_release_provenance.sql` (`build-manifest.mjs`, and again in the test) | `468979611a28...` |
| catalogue digest after B1 | `468979611a28...` (body unchanged) |
| identity | `kernel_private.stamp_binding_provenance()`, `pronargs = 0`, returns `trigger`, `proretset = false`, `prokind = 'f'`, language `plpgsql` |
| `prosecdef`, owner | true, `postgres` (the deployment owner; runtime roles own nothing) |
| `proconfig` | `["search_path=\"\""]`: one element, the text `search_path=""`, exactly as sealed |
| `proacl` | `["postgres=X/postgres"]`; `aclexplode` gives one row, grantor and grantee `postgres`, EXECUTE, not grantable; effective EXECUTE false for `kj_worker`, `kj_door`, `anon`, `authenticated`, `service_role` |
| trigger topology | exactly one `pg_trigger` row: `execution_bindings_provenance` on `kernel_private.execution_bindings`, `tgtype = 7`, `tgenabled = 'O'`, no `WHEN`, `tgisinternal = false`, `tgnargs = 0`, `tgattr` empty |
| name uniqueness | exactly one function named `stamp_binding_provenance` in all governed schemas |
| migration refuses a tampered body | B1 applied over a body changed by one character: `23514`, "source digest ... is 8c4c...2637, pinned 4689...439b", whole transaction rolled back |
| migration removes foreign grants | EXECUTE granted to `anon` and `authenticated` before B1: after B1 the ACL is exactly the owner's |

## 4. How the manifest was obtained (gates 1 and 2)

The manifest is not hand-written. `manifest = (static inventory - reviewed denials) + reviewed additions`, and the
migration is a pure function of the manifest. `node scripts/b1/build-manifest.mjs --check` fails if the committed
manifest or migration differs from what the inputs produce; the suite and CI run it.

**Static inventory** (`scripts/b1/static-inventory.mjs`, output `evidence/kj-p8-b1/static-inventory.json`):

1. Runtime entry points are declared once: the worker entry, the health and alert CLIs, the outbox gate and test
   notification CLIs for `kj_worker`; the gateway entry for `kj_door`.
2. The import graph gives every source file each role can reach. Five deployment-authority modules are excluded and
   listed (canary runner and seed, identity provisioning, the approval test CLI, the evaluator CLI): they are operator
   tools run with the owner credential and are not runtime.
3. SQL in those files is parsed into (verb, object, columns). `ON CONFLICT` and `RETURNING` imply SELECT; an UPDATE
   or DELETE implies SELECT; `FOR UPDATE/SHARE` implies a row lock, attributed per statement.
4. The set is closed through every `SECURITY INVOKER` trigger function, view and plain function in the migrations,
   because those run with the caller's rights.

**Dynamic inventory** (`tests/support/runtime-roles.ts`, `scripts/b1/analyse-trace.mjs`):

- In the discovery run every runtime statement runs with the role's privileges; a refusal is recorded and the
  statement retried as the owner, so one run lists every missing privilege.
- Every statement is recorded and parsed with the same extractor, then compared with the manifest in both directions.

**Cross-check results (FACT, final discovery run):**

| | `kj_worker` | `kj_door` |
|---|---|---|
| distinct runtime statements | 1,436 | 108 |
| observed but not in the manifest | 0 | 0 |
| refusals | 0 | 0 |
| in the manifest, never observed | 13 | 5 |

The first discovery run, against the purely static manifest, found seven worker gaps and one door gap. Each was
resolved narrowly: four were extractor rules that were wrong and are now fixed (`ON CONFLICT`/`RETURNING` need
SELECT, a bare table alias in UPDATE); three are row locks on statements assembled across string literals, added as
written decisions; one is the ruling in section 3; two were test-only sabotage tables (section 8).

**Statically granted but never observed** are kept and listed, because an unexercised legitimate path must not be
revoked on the strength of test coverage alone:

- `kj_worker`: the scheduler tables (`schedule_leases`, `schedule_fires`, `schedule_observations`,
  `schedule_backfill_requests`). FACT: these paths are exercised by the six environment-gated files, which CI skips
  and which pass under the roles (section 7). Also `terminal_results` INSERT, `identity_governance_state` SELECT and
  two identity digest helper functions, all reached only inside triggers.
- `kj_door`: SELECT on `entities`, `observations`, `relationships`, `memory_items` (the door's `GET /v1/world` and
  `GET /v1/memory` routes) and SELECT on `release_epoch`. INFERENCE: required by those routes; not exercised through
  the gateway by any test.

**Door narrowing.** File-level reachability over-grants the door, because it imports modules that also hold worker
write paths. Eight static entries are denied for the door with written reasons (replay-store writes, effect receipt
writes, world and memory writes, a task row lock). FACT: none was observed for the door in either run, and the full
suite passes without them.

**Manifest entry counts:**

| Role | relations | SELECT | INSERT | UPDATE | DELETE | lock-only | EXECUTE |
|---|---|---|---|---|---|---|---|
| `kj_worker` | 51 | 50 | 38 | 14 | 2 | 6 | 4 |
| `kj_door` | 18 | 18 | 4 | 0 | 0 | 2 | 0 |

UPDATE is column-level wherever the columns could be determined (for example `identity_candidates (state,
resolved_at)`). A lock-only entry grants UPDATE on one column with a policy whose `WITH CHECK` is `false`: the role
can take the row lock that `authorize()` needs and can never change the row.

## 5. Row level security (gate 3)

130 policies are added, one per table and verb in the manifest, named `<role>_<verb>` (or `<role>_rowlock`), each
`TO` exactly one role. The exact list is `evidence/kj-p8-b1/rls-policy-inventory.json`. No policy is `TO PUBLIC`, no
`FOR ALL`, no role receives the other's policies.

**The policies are role-scoped, not tenant-scoped, and their predicates are `true`. This needs the reviewer's
attention.** The reason is the existing architecture, not convenience:

- FACT: KernelJSON has no database-side tenant context. `withTenant` authorises a tenant in SQL at the start of a
  transaction and the composite `(id, tenant_id)` keys bind rows; no session setting carries a tenant.
- The worker is a multi-tenant system process (scheduler, alert monitor, ledger).
- A tenant predicate in a policy would need a new session-level tenant mechanism. The brief forbids inventing a
  second tenancy mechanism, and ADR 27.4 states that tenant isolation "continues to be enforced where it is today".

So B1 preserves tenant isolation exactly as it is and does not add a second database-level layer. What the policies
add is the role boundary: before B1 nothing but ownership stood between a runtime session and every table.

Cross-tenant behaviour is covered by the existing tenant-isolation tests, which now run under the roles and pass
(for example `memory.test.ts` "isolates tenants even for a principal belonging to both", `evaluation-db.test.ts`
"isolates tenant reports", the gateway authorisation tests).

## 6. Runtime connections (gates 5 and 10)

- Every runtime pool is created by `runtimePool(config, role)`. Before the first statement, and again after any
  refusal, it proves `current_user = session_user = role`, the sealed attributes, no membership and no ownership.
  Any other session is refused with `RUNTIME_DATABASE_ROLE_REFUSED` and never runs a statement.
- The proof is lazy (first use), because the image smoke check starts the worker with no database.
- The environment variable is unchanged: each process still reads its own `DATABASE_URL`. The door and the worker
  already receive separate injected environments, so no new variable and no alternate URL exists.
- **There is no fallback.** An owner URL makes the process refuse; there is no flag that relaxes this.

FACT (`tests/runtime-roles-connection.integration.test.ts`): the owner is refused on query and on connect and the
statement does not run; the other runtime role is refused; a widened role is refused under the right name; `SET ROLE`
does not satisfy the guard; the message never contains the connection string.

**Escape-hatch review** (FACT, repository search plus `tests/runtime-roles-topology.test.ts`):

| Pattern | Finding |
|---|---|
| pool or client constructed in runtime-reachable code | only inside the guard |
| pool or client elsewhere | `tools/canary-runner.ts` (deployment tool, owner by design), `scripts/seed-core-team.ts` and the mutation scripts (not runtime) |
| alternate, owner or service-role database URL variable | none |
| `SET ROLE`, `SET SESSION AUTHORIZATION`, `session_replication_role` in runtime code | none |
| literal `postgres` credential in runtime code | none |
| `SECURITY DEFINER` | the KernelJSON half is exactly `stamp_binding_provenance()` (section 3); every governed schema is inventoried against the stage manifest and the frozen platform baseline (section 12) |
| EXECUTE through `PUBLIC` | revoked for all functions in both schemas; catalogue equality reads effective privileges, so a future grant to `PUBLIC` fails the test |
| dynamic SQL with interpolated identifiers in runtime queries | none found |
| deployment modules imported by a runtime entry | none (tested) |

## 7. Qualification results (gates 6 to 9)

FACT. These runs are GitHub Actions CI (`ubuntu-24.04`, Postgres 17.6 and Restate 1.7.9 in docker compose), run
`37459729830` on `d2a2447908a0b2588433c3f2580c11caf41d88a4`; the base row is `main`'s own CI run `36940075218` on
`20e39f7`. Local Docker was not available for this remediation, so nothing below comes from a local run. The evidence
in `docs/operations/evidence/kj-p8-b1/` was regenerated from those artefacts by `scripts/b1/summarise.mjs`.

| Run | Total | Passed | Failed | Skipped |
|---|---|---|---|---|
| Base `20e39f7`, everything as the owner (`main` CI) | 1,861 | 1,799 | 0 | 62 |
| B1, enforce mode (`validate` job; genuine `kj_worker` / `kj_door` sessions) | 2,160 | 2,098 | 0 | 62 |
| B1, discovery mode (`b1-qualification` job) | 2,160 | 2,097 | 0 | 63 |
| Six environment-gated files, B1 enforce mode (`b1-qualification` job) | 43 | 43 | 0 | 0 |

- Pre-existing test files under the roles: 1,805 passed and 62 skipped, in both modes. That is the 1,799 of the
  base plus the 6 cases B1 adds to existing files; the 62 skips are the same environment-gated tests, and
  `pnpm test:baseline` passes. B1 test files add 293 passing cases (one more is skipped in discovery mode because it
  needs a genuine session).
- **Unexpected `42501`: 0**, in the enforce run, the discovery run and the gated run (trace gate
  `analyse-trace.mjs --fail-on-refusal`). Observed operations not in the manifest: 0 for both roles.
- **Negative probes: 237 of 237 pass** (98 for `kj_worker`, 139 for `kj_door`), each with its pinned SQLSTATE.
- **ADR 27.9.5 matrix: all 27 sealed rows, 62 of 62 probes pass** across both roles (`b1-definer-probes.json`).
  Rows 15, 20 and 21 keep the design's grouping (two, three and two forms). The 56 refusals all returned `42501`,
  including row 1, the direct call (`0A000` would have been a DESIGN_MISMATCH; it did not occur). Every refusal is
  followed by an owner re-read showing nothing changed. Rows 25 to 27: with a changed `search_path`, with forged
  `release_epoch` and `persisted_at`, and repeatedly, inserted bindings carry the canonical epoch and a fresh
  timestamp, and the epoch's value does not change.
- **Catalogue equality: pass in both directions for both roles**, with the existing negative cases.
- **`SECURITY DEFINER` inventory: pass** against a qualification-fixture baseline (section 12). **28 deliberate
  failures, 28 seen red and restored to green**: an extra platform definer after the snapshot, a missing one, changed
  owner, return type, `proconfig` and digest, a platform-looking schema, a new application schema, a moved function, a
  definer in `public`, a P8A-0 function present at B1, a second `stamp_binding_provenance` and an overload, the stamp
  function back to invoker, executable by `kj_worker` or `PUBLIC`, a null `proacl`, a widened or missing
  `search_path`, another owner, a changed body, the trigger disabled, replica-only, always, attached twice, attached
  elsewhere, given a `WHEN`, and renamed.
- **Schema predicate, observed:** temporary schemas are named `pg_temp_15` and `pg_toast_temp_15`; `CREATE SCHEMA
  pg_kj_probe` is refused `42939` even for the owner.
- **Mutation jobs:** faculty, identity and identity-cognition mutation checks are green in the same CI run.

## 8. Existing tests whose expectations changed (gate 9)

Each is an accidental reliance on owner authority, not a legitimate runtime capability. No privilege was granted to
make a test pass.

| File | Change | Why |
|---|---|---|
| `tests/identity-workflow.integration.test.ts`, `tests/identity-migration.integration.test.ts` | the test's own sabotage trigger function is now `SECURITY DEFINER` | it reads a test-only table that no runtime role may see |
| `tests/support/worker.ts` | the deliberate row-corruption fault injection uses `KJ_TEST_OWNER_DATABASE_URL` | corrupting a ledger row is sabotage, not a worker capability |
| `tests/alert-runner.integration.test.ts` | the spawned alert CLI is given the `kj_worker` URL | it is a runtime process and now refuses the owner |
| `tests/release-provenance-postgres.test.ts` | after replaying one old migration, restores B1 state for the three objects it recreated | B1 is always applied after it in a real database |
| `tests/health-model.test.ts` | snapshot fixtures carry the new observation; four new cases | new health check |
| `infrastructure/docker/validation.compose.yaml` | the worker connects as `kj_worker` | the worker is a runtime process |

Nothing was skipped, weakened or deleted.

## 9. Things Postgres does not let B1 prevent

Stated so that nobody assumes otherwise:

- A role can always change **its own password** and its own session defaults. `ALTER ROLE ... CREATEDB` and every
  attribute change are refused (probed); a password change is not preventable by privilege.
- `PUBLIC` keeps its built-in rights on `pg_catalog` and on language `plpgsql`, so a runtime role can read the
  catalogues and run an anonymous `DO` block. It cannot create a function (no CREATE on any schema; probed).
- A row the role may legitimately write is not further constrained by B1. For example the worker may update
  `approvals.status` because the approval store does; what makes an approval count is still the existing guards and
  bound policy events, not the grant.

## 10. Not verified, and must be at cutover

- **Production was not inspected, read or written.** The door's current role, the pooler mode, platform schemas
  that grant to `PUBLIC`, and whether revoking TEMPORARY from `PUBLIC` affects a platform role are all unknown. Each
  is a precondition in the cutover plan. FACT from the qualification fixture: a platform function executable by
  `PUBLIC` is reported by the existing grant-manifest equality as a runtime-role grant (`kj_worker holds unlisted
  function:auth...:EXECUTE`) and turns the health check red. On the hosting platform such functions are expected,
  so cutover precondition 6 (revoke or list each by a reviewed change) is real work, not a formality.
- **The target platform `SECURITY DEFINER` baseline has not been taken** (section 12).
- The connection limits (40 and 20) are INFERENCE from pool sizes in the code (worker 10 + 3 + 3, door 10).
- The environment-gated files were not re-run as the owner at the base commit in this remediation (the frozen
  candidate's local run recorded 43 of 43); under the roles they pass 43 of 43 in CI.

## 11. Reproducing

```
pnpm install --frozen-lockfile
node scripts/b1/build-manifest.mjs --check          # manifest and migration match their inputs
pnpm test                                           # enforce mode: production code runs as kj_worker / kj_door
node scripts/b1/analyse-trace.mjs artifacts/local/b1-trace artifacts/local/b1-dynamic-inventory.json --fail-on-refusal
KJ_RUNTIME_ROLES=discover KJ_WORKER_DATABASE_URL=postgresql://postgres@db:5432/kerneljson pnpm test   # discovery run
bash scripts/b1/qualify-ci.sh                       # discovery run, inventories, gated files (CI job b1-qualification)
node scripts/b1/summarise.mjs <artefact dir> docs/operations/evidence/kj-p8-b1
```

To change a grant: edit `runtime-role-decisions.json` with a reason, run `node scripts/b1/build-manifest.mjs`, and
commit the regenerated manifest and migration together.

## 12. The stage-aware `SECURITY DEFINER` inventory (ADR 27.10) and the target baseline

`EXPECTED(stage) = PLATFORM_BASELINE UNION KERNELJSON_STAGE_MANIFEST(stage)`, compared in both directions with every
governed `pg_proc` row that has `prosecdef = true`. Identity is schema, name and ordered argument types (each
`<schema>.<type>`); return type, `proretset`, `prokind`, owner, `prosecdef`, language, `proconfig`, ACL (KernelJSON
functions) and source digest are compared separately. The schema predicate is exactly
`not (nspname in ('pg_catalog', 'information_schema', 'pg_toast') or nspname ~ '^pg_temp_[0-9]+$' or nspname ~ '^pg_toast_temp_[0-9]+$')`.

- **Stage manifest** (`kerneljson:security-definer-stage-manifest/v1`, generated, SHA-256
  `418d47acd0413d3289bf044b46c2e03c49fd624e046e7a5fce9ba17652b397a4` LF-normalised): declared stage B1; B1 set
  `kernel_private.stamp_binding_provenance() -> pg_catalog.trigger`. P8A-0 (and B2, P8A-1, P8A-2) add
  `kernel_private.freeze_reflection(pg_catalog.uuid) -> pg_catalog.void`; P8B adds
  `kernel_private.close_growth_window_by_owner(pg_catalog.uuid, pg_catalog.uuid) ->
  kernel_private.identity_growth_window_closures`. Later stages are unimplemented, carry no migration and no source
  pin, and B1 creates neither later function.
- **Stage binding** (FACT, `tests/security-definers.test.ts`): the declared stage is checked against the migrations
  the release carries, each pinned by SHA-256 (22 base migrations and the B1 migration). Removing or changing the B1
  migration, changing a base migration, carrying an unlisted migration, relabelling the release as any later stage,
  marking a later stage implemented, an unknown label, another design SHA or reordered stages each fail. A
  database that disagrees with its release fails catalogue equality, and health (P0).
- **Platform baseline** (`kerneljson:security-definer-platform-baseline/v1`): the qualification proves the machinery
  on a fixture, a database migrated from `main` without B1 and given four platform-style definers in schema `auth`,
  one per digest rule (`internal`, a SQL-standard body, plpgsql and SQL). The read-only snapshot recorded
  `transaction.readOnly = true`, `searchPath = ""`, `stampSecurityDefiner = false`, and the query SHA-256; it refuses
  once B1 is applied. **This fixture baseline is not the target baseline and is not committed as one.**

**TARGET_PLATFORM_BASELINE_PENDING.** No target baseline is committed, and `database.runtimeRolesLeastPrivilege` reports
`TARGET_PLATFORM_BASELINE_PENDING` and stays CRITICAL until one is. Reason it was not taken in this task: it is a
read of the production database. It needs the deployment owner's credential and the target environment's identity,
and the design requires the deployment owner to take it before the B1 migration. This task did not handle that
credential. Remaining gate, for the deployment owner:

```
pnpm tsx scripts/b1/platform-baseline-snapshot.ts --environment <target name> \
  --database-url-file <mode-600 file holding the owner URL> \
  --out infrastructure/database/security-definer-platform-baseline.json
```

It opens one READ ONLY transaction with `search_path = ''`, writes nothing, and refuses if B1 is applied or an entry is
ineligible. Delete the URL file afterwards. The artefact is reviewed and committed, which makes a new candidate SHA
for review. If the platform role cannot execute `pg_control_system()`, the tool stops with a fixed message and the
SQLSTATE; that would need a design ruling on the provenance field, not a weaker snapshot.
