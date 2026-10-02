# KJ-P8 B1 implementation report: least-privilege runtime database roles

Status: ENGINEERING CANDIDATE, not merged, not deployed. **One open ruling blocks "ready for hostile review"; see
section 3.** Production was not touched. No P8A-0 object exists in this candidate.

Design authority: ADR-0023 revision 2.3, section 27, sealed at `679e3a3dfc7a33f9106ed77913d49cdac19166d5`
(branch `design/kjp8-reflection-governed-growth`; seal in `docs/reviews/KJ_P8_ADR0023_R23_HOSTILE_SEAL_679e3a3.md`).
Entry contract: `docs/operations/KJ_P8_B1_ENTRY_BRIEF.md`. Base: `main` `20e39f797be9c4c982bc32fb40b6aa1427b5c09c`
(CI green on that commit before this work began).

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
| Evidence | `docs/operations/evidence/kj-p8-b1/` |
| Cutover plan (not executed) | `docs/operations/KJ_P8_B1_PRODUCTION_CUTOVER_PLAN.md` |

## 2. Role contract as implemented

Both roles: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`, connection limit 40
(worker) and 20 (door). They own nothing, are members of nothing and have no members. The migration creates them
**without a password**; a password is set out of band at cutover. A pre-COMMIT block in the migration refuses to
commit if an attribute or a membership is not as sealed.

FACT: `tests/runtime-roles-catalogue.integration.test.ts` reads the attributes, ownership and memberships from the
catalogue for both roles and compares them with the manifest.

## 3. OPEN RULING: one existing trigger needs the owner's rights

**This is the single blocker, and it is a question for the design authority, not something this candidate may decide.**

FACT: the existing trigger function `kernel_private.stamp_binding_provenance()` (P1.3 release provenance, a BEFORE
INSERT trigger on `kernel_private.execution_bindings`) performs a real `UPDATE kernel_private.release_epoch SET
epoch = epoch` to lock the epoch and stamp the binding. It is `SECURITY INVOKER`. Both runtime roles insert
execution bindings (the door at admission, the worker for scheduled work), so under their own rights both would need
`UPDATE` on `kernel_private.release_epoch`.

The sealed design says two things that cannot both hold here:

- section 27.3: a runtime role may never write `release_epoch`;
- section 27.8: B1 makes no change to a P1 to P7 trigger.

| Option | Effect | Conflict |
|---|---|---|
| A. Make that one function `SECURITY DEFINER` (**implemented in this candidate**) | the body is unchanged and runs with the owner's rights; the roles hold nothing on `release_epoch`; a direct write is refused | the letter of 27.8 |
| B. Grant both roles `UPDATE (epoch)` on `release_epoch` | no function change | 27.3, and it is a real widening: a runtime role could change the release epoch |

Why A was implemented for qualification: it is the only option that keeps the authority boundary of 27.3. The
function already sets `search_path = ''`, takes no arguments, and as a trigger function cannot be called directly.
The catalogue test fails if any other `SECURITY DEFINER` function appears in the application schemas, and two
negative probes prove both roles are refused a direct write of `release_epoch`.

FACT: with option A the complete suite passes under the runtime roles (section 7). Without A or B, admission cannot
work under `kj_door` at all (observed in the discovery run: `permission denied for table release_epoch`).

**Ruling needed:** accept option A as a B1 precondition fix, or direct a different resolution. If A is refused, the
change is isolated to one entry in `runtime-role-decisions.json` (`securityDefinerTriggers`) and three generated
lines of the migration.

No other required P1 to P7 operation conflicts with the sealed forbidden list. That was established by the static
closure through every invoker trigger, view and function, and confirmed by the discovery run.

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
| `SECURITY DEFINER` | exactly one function, section 3 |
| EXECUTE through `PUBLIC` | revoked for all functions in both schemas; catalogue equality reads effective privileges, so a future grant to `PUBLIC` fails the test |
| dynamic SQL with interpolated identifiers in runtime queries | none found |
| deployment modules imported by a runtime entry | none (tested) |

## 7. Qualification results (gates 6 to 9)

All runs were local, in a Linux container with Postgres 17.6 and Restate 1.7.9, the same shape as the CI job. FACT.

| Run | Total | Passed | Failed | Skipped |
|---|---|---|---|---|
| Baseline at `20e39f7`, everything as the owner | 1,861 | 1,799 | 0 | 62 |
| B1, enforce mode (genuine `kj_worker` / `kj_door` sessions) | 2,016 | 1,954 | 0 | 62 |
| B1, discovery mode (records refusals instead of stopping) | 2,016 | 1,953 | 0 | 63 |
| Six environment-gated files, owner at base | 43 | 43 | 0 | 0 |
| The same six files, B1 enforce mode | 43 | 43 | 0 | 0 |

- The 62 skips are the same pre-existing environment-gated tests in both runs; `pnpm test:baseline` passes
  (224/224 protected tests, recovery 31).
- Every pre-existing test passes under the roles: the pre-existing test files give 1,805 passed and 62 skipped
  (the 1,799 of the baseline plus 6 cases added to existing files, four of them the new health cases). The four new
  B1 test files add 149 passing cases. The one extra skip in discovery mode is a B1 case that needs a genuine session.
- In the enforce run the compose worker is a real `kj_worker` process; in the test process, production code that
  takes its own connection gets a genuine role login, and the small remainder (a test handing its own owner
  connection to production code) runs under `SET ROLE`, which applies the same privilege and policy checks. The
  split is recorded per role in `dynamic-inventory-enforce.json`.
- **Unexpected `42501`: 0.** The harness records every refusal of a runtime-attributed statement; the trace gate
  (`analyse-trace.mjs --fail-on-refusal`) fails the run on any.
- **Negative probes: all pass**, each with its pinned SQLSTATE, on genuine login sessions of both roles
  (`evidence/kj-p8-b1/negative-probes.json`): object creation, ALTER, DROP, TRUNCATE, trigger disabling, row level
  security changes, policy changes, role changes, `SET ROLE`, session authorization, `ALTER SYSTEM`, release
  activation and epoch writes, identity freeze, history rewrites, role separation, and every relation and function
  outside the manifest.
- **Catalogue equality: pass in both directions for both roles**, with negative cases for an extra privilege, a
  privilege through `PUBLIC`, a missing privilege, a membership, an ownership, an extra policy, a changed attribute
  and an unlisted definer function.

Not run locally: the three long mutation jobs (`mutation-check-identity`, `-identity-cognition`, `-faculties`). They
run in CI on push. INFERENCE: unaffected, because they run the same suite files through the same harness.

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

- **Production was not inspected.** The door's current role, the pooler mode, platform schemas that grant to
  `PUBLIC`, and whether revoking TEMPORARY from `PUBLIC` affects a platform role are all unknown. Each is a
  precondition in the cutover plan. On the hosting platform the catalogue equality check is likely to report
  platform-level `PUBLIC` grants as extra until they are revoked or listed.
- The connection limits (40 and 20) are INFERENCE from pool sizes in the code (worker 10 + 3 + 3, door 10).
- CI has not yet run on this branch when this report was written.

## 11. Reproducing

```
pnpm install --frozen-lockfile
node scripts/b1/build-manifest.mjs --check          # manifest and migration match their inputs
pnpm test                                           # enforce mode: production code runs as kj_worker / kj_door
node scripts/b1/analyse-trace.mjs artifacts/local/b1-trace artifacts/local/b1-dynamic-inventory.json --fail-on-refusal
KJ_RUNTIME_ROLES=discover KJ_WORKER_DATABASE_URL=postgresql://postgres@db:5432/kerneljson pnpm test   # discovery run
node scripts/b1/summarise.mjs <artefact dir> docs/operations/evidence/kj-p8-b1
```

To change a grant: edit `runtime-role-decisions.json` with a reason, run `node scripts/b1/build-manifest.mjs`, and
commit the regenerated manifest and migration together.
