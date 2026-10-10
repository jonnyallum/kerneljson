# KJ-P8 B1 R2.7.9: requirements matrix and reconciliation (implementer self-review)

Prepared by Claude Code on 10/10/2026, taking over the remediation branch from Codex. The normative source is
ADR-0023 revision 2.7.9 at sealed design commit `af2f7320aae32eaa0ce699b1c09d015371f156d5`, section 27 (read in
full for this record), as constrained by the [owner ruling on the helper rethrow](KJ_P8_B1_R279_OWNER_RULING.md).
This is a self-review. It is not a hostile review and claims no approval.

Status vocabulary, used exactly:

| Status | Meaning |
|---|---|
| PASS | executed, with the evidence named in the row; the level reached is stated (unit, integration, end-to-end runner run, CI) |
| FAIL | executed and did not meet the requirement |
| NOT_RUN | no execution evidence exists, whether or not code exists |
| BLOCKED | needs an authority, credential or environment this sprint does not have |
| CONTRADICTION | the sealed text cannot be met as written; the path is stopped and reported |

"Source exists" is never a status. A requirement whose code exists but has not been executed is NOT_RUN.

## 1. Anchors at takeover (OBSERVED, 10/10/2026)

| Anchor | Value |
|---|---|
| remote `feat/kjp8-b1-r279-remediation` | `8e4ea9b63e464dff749a0cb6a008023c81652c4c` (equal to the brief) |
| local Codex worktree | two further unpushed commits, `ac834a2` and `a44a969`, fast-forward from `8e4ea9b`; plus uncommitted trace work (`scripts/b1/trace.ts`, `tests/b1-trace.test.ts`, three modified harness files) |
| diagnostic commit | `9530a3e66cef29499af6c07d80131b6c6399926a`, ancestor of the branch |
| frozen B1 | `0ff2919c1bbf722b4842aa56fdc94ef9b74e5a51`, ancestor of the branch, and still the tip of `feat/kjp8-b1-runtime-least-privilege` |
| sealed design | `af2f7320aae32eaa0ce699b1c09d015371f156d5`, tip of `design/kjp8-reflection-governed-growth` |
| main | `e211eb796c51403637bb5f231c7feba2aaf97be2` |

The uncommitted Codex work typechecked and passed 216 tests across the seven B1 unit files, and was committed
unchanged as `608bc42`. Nothing was reset, rebased or force-pushed.

## 2. Matrix at takeover

Columns: requirement (ADR section), implementation location, required evidence, status at takeover, remediation.
Commit references are to the remediation branch.

### 2.1 Migration and catalogue

| Requirement | Implementation | Evidence required | Status at takeover | Remediation |
|---|---|---|---|---|
| 27.12.5 enumerated function ACL cleanup, no schema-wide routine ACL | `scripts/b1/co-resident-sql.mjs`, generated into the B1 migration (`14874ea`) | static guard (27.12.8 item 12), ACL-A, ACL-B, ACL-C through the runner | NOT_RUN for ACL-A to C; generator reproducibility PASS (unit) | run ACL-A to C end to end |
| 27.12.7 P1, P2 (a) to (d), P3 steps 1 to 5, first-statement presence and format | B1 migration pre-COMMIT `DO` blocks | cases 2 to 16, 19, 23 to 30, 38 through the runner; `23514` and the named rule | NOT_RUN (only the three base-plan positive runs exist) | negative cases as registered hooks |
| 27.9 stamp exception, 27.9.4 assertions | migration and `security-definers.ts` | catalogue tests, 27.9.5 probes on both roles | PASS at frozen B1 (`37459729830`, old CI); NOT_RUN on this branch | stage T `runtime-roles-*` suites |
| 27.12.3 and 27.12.4 pins file, pinned-content test | `infrastructure/database/co-resident-platform-pins.json`, `security-definers.test.ts` | unit test | PASS (unit) | none |
| 27.12.7 golden vector by snapshot tool, health and migration (case 41) | unit test reproduces the vector; migration and snapshot not exercised on the helper fixture | case 41 end to end on `pinned-helper` | PASS (unit only); end to end NOT_RUN | run case 41 |
| 27.10 inventory, baseline eligibility, 27.11 fact model | `security-definers.ts`, `runtime-roles.ts` | unit tests; S7 equality in runner runs | PASS (unit); S7 PASS in three base-plan runs (Codex, outside Git) | rerun under the new evidence store |
| 27.12.6 health P0 items, cases 31 to 35 | `health/collect.ts`, `health/evaluate.ts` | health cases | NOT_RUN (unit coverage partial) | execute cases 31 to 35 |
| CON-32 static B1 shape; CON-42 handler test; case 20 | not found | static tests with failing fixtures | NOT_RUN (absent) | add |

### 2.2 Engine, runner and modes

| Requirement | Implementation | Evidence required | Status at takeover | Remediation |
|---|---|---|---|---|
| 27.12.13.7 Windows engine pin, H1 environment | `scripts/b1/engine.ts`, `b1-engine-pins.json` | runner runs; EPH-9, EPH-10 | positive PASS (three runs, Codex); EPH-9, EPH-10 NOT_RUN | run cases |
| Linux engine | same code, `linux-x64` pin | a runner run on Linux | NOT_RUN | CI runner job |
| 27.12.6 steps 1 to 5, 27.12.11 steps 6 to 10 | `release.ts`, `ledger.ts`, `ephemeral.ts`, `hosted.ts` | runs and cases 36, 40, EPH-14 | positive PASS (Codex); cases NOT_RUN | run cases |
| L1 to L6, S1 to S7, status predicate | `ephemeral.ts`, `ephemeral-cluster.ts`, `run-status.ts` | EPH-1 to EPH-27 | EPH-1 PASS for `none` and `pinned-helper` (Codex, records outside Git); others NOT_RUN | run cases |
| 27.12.13.8 closed registry: `callers`, `precondition`, `cases`, structured `expected`, the closed point set | `b1-runner-hooks.json`, `hooks.ts` | static qualification with failing fixtures; every hook point used | FAIL against the schema: the registry holds only six S2 ledger hooks, with no `callers`, `precondition` or `cases`; only one hook per run; no S5, L2-target, L3-skip, S3-files, S4-skip, S6-gate-inventory-skip or S6-apply | implement |
| HOSTED_COMMITTED entry point | `hosted.ts` | static boundary tests; refusal cases 36, EPH-11, EPH-12, EPH-17 | static PASS (unit); refusal cases NOT_RUN; any hosted connection BLOCKED (no authorised hosted disposable target) | run refusal cases; hosted application stays BLOCKED |
| LEDGER-A to F | six inherited S2 ledger hooks (Codex) are the snapshot refusals, not the 27.12.9 LEDGER cases | LEDGER-A to F through the runner | inherited snapshot refusals PASS (Codex, six runs); LEDGER-A to F NOT_RUN | implement as hooks |

### 2.3 Regression lanes, stage T and evidence

| Requirement | Implementation | Evidence required | Status at takeover | Remediation |
|---|---|---|---|---|
| Lane A helpers refuse B1 | `scripts/b1/base-guard.mjs`, `tests/support/local.ts` | `b1-base-guard.test.ts`; CON-7, CON-13 | unit PASS; CON-13 NOT_RUN | run lane A |
| Stage T, suite plans, run network services, post-T reads | none (`regressionSuites` is `z.never()`) | CON-1 to CON-14 | NOT_RUN (absent) | implement |
| `tests/lanes.json`, `tests/b1-required.json` | absent | static partition tests; coverage gate | NOT_RUN (absent) | implement |
| Pinned collection (CON-47) | `scripts/b1/collection.ts`; frozen-tree evidence `evidence/kj-p8-r279/frozen-collection.json` | static test at `R` with the 54999 listener | frozen tree PASS (Codex); at `R` NOT_RUN | wire into the static gate |
| Trace (G4, G5, CON-15, CON-16, CON-22) | `scripts/b1/trace.ts`, harness (`608bc42`) | stage T runs | unit PASS; stage T NOT_RUN | stage T |
| Log extraction and refusal accounting (CON-48) | `scripts/b1/refusal-accounting.ts` | pinned-image fixture | parser unit PASS; pinned-image fixture NOT_RUN | run CON-48 on the pinned image |
| G1 to G9 | old `qualification.yml`, `scripts/b1/qualify-ci.sh` | each gate separately at `R` | NOT_RUN on this branch; the inherited jobs cannot run (they call the full suite outside a runner) | replace CI |
| G7 mutation suites | `scripts/mutation-check-*.mjs` (lane A) | each verdict, every mutation killed | NOT_RUN | run in lane A |

### 2.4 CI (P0)

The inherited `.github/workflows/qualification.yml` runs `pnpm test` over the whole suite, `scripts/b1/qualify-ci.sh`
(which migrates `kj_gated` with `migrate()` and states "B1 included") and the mutation scripts against the compose
database. On this branch `migrate()` now refuses B1 and requires harness mode `base`, so those jobs would no longer apply
B1, but they would fail, and the `validate` job would run database consumers without a runner. Codex therefore marked
every commit `[skip ci]`. Status at takeover: FAIL (unsafe and unrunnable as qualification); no CI evidence exists for
any R2.7.9 commit.

## 3. Owner ruling and design text

- The owner ruling preserves the pinned helper unchanged and treats ADR 27.12.4's "on failure the pinned body
  re-raises" as inaccurate. That sentence is used by no B1 qualification requirement: B1 creates no table, so the
  helper never fires during B1, and no case of 27.12.9, 27.12.13.9 or 27.12.15 asserts the helper's failure
  behaviour. The ruling therefore leaves every B1 requirement in this matrix independent of it.
- The ADR correction is pending independent design review. The design is not resealed, and this record does not say
  it is.

## 4. What changed after takeover

All work is on the remediation branch, fast-forward from `8e4ea9b`, with no rewrite. Commit references below are to that
branch. The headline changes:

- **Closed hook registry** to the 27.12.13.8 schema: 105 hooks generated from committed definitions
  (`scripts/b1/hook-definitions.ts`, `scripts/b1/build-hook-registry.ts`) over the eight registered points (S6-apply
  33, S5 32, S3-files 21, S2 14, L2-target 2, L3-skip, S4-skip and S6-gate-inventory-skip one each). The runner
  refuses a registry blob that differs from the one generated at `R`. Every hook point is implemented.
- **B1 migration**: every violated P1 and P2 clause is named in one `23514`; P2 (c) checks the full sealed topology;
  P2 (d) is identity-based. The statements digest is re-frozen from the pinned engine.
- **Stage T** (`scripts/b1/stage-t.ts`), the twelve registered suites (`scripts/b1/plans.ts`), the coverage partition
  (`tests/lanes.json`), the required rows (`tests/b1-required.json`, generated), and every lane D file converted to plan
  database leases.
- **CI replaced** (P0). `.github/workflows/qualification.yml` has governed jobs only. The gate (`scripts/b1/ci-gate.ts`,
  `scripts/b1/gate-suite.ts`) recomputes every status from the evidence files. It also refuses unless every needed job
  concluded `success`, so a skipped, cancelled or failed job never qualifies. `scripts/b1/qualify-ci.sh` is removed.
  The only other workflow (`capabilities-validate.yml`) runs a Python catalogue check and touches no database.
- **Runner cases** in lanes B and C: 230 cases in six files (`tests/b1-runner-{coresident,settings,ledger,lifecycle,
  refusals,staget}.test.ts`). Each runs the governed entry point as a child process and acts as an independent
  consumer of the record.

## 5. Defects found by failing a check on purpose (self-review)

Each was observed in a run on this branch, fixed and committed. None was found by reading alone.

| Defect | Observed | Fix |
|---|---|---|
| Three stage T files resolved repository paths against the working directory, which 27.12.15 makes a fresh empty directory | regression-enforce pilot at `05b17e1`: 3 files failed with `ENOENT` | `tests/support/repo.ts`; static rule with failing fixtures (`b1-partition.test.ts`) (`6196b71`) |
| The manifest check read the B1 migration from inside a stage T consumer, which 27.12.15 forbids | same pilot | moved unchanged to lane A (`tests/runtime-roles-manifest.test.ts`) (`6196b71`) |
| Stage T accepted any skipped entry; 27.12.15 accepts only a `tests/baseline.json` intentional skip, and none in `regression-gated` | review of the report rule while writing CON-5 | skip accounting in stage T (`4abffe5`); CON-5 "listed file skipped" now fails on it |
| `readTraces` threw on a refused production statement, so stage T and the gate never ran the G4 or G5 analyser that CON-15 requires to fail | reading CON-15 against the code path | production refusals returned beside probe refusals; G4 and the log check still run (`2313d9e`); CON-15 end to end |
| Every regression-stack file called `compose down` before naming its plan database; stage T refused it, so the stack suite never ran | CON-16 run at `2313d9e`: 5 files failed in `beforeAll` | placeholder for `down` only, as the runner's own `down` (`a0ecd08`) |
| L3 required sole run-network membership throughout; 27.12.15 requires it only until stage T begins, after which membership is the post-T check's | CON-10 run at `2313d9e`: L3 refused, stage T "not reached" | sole membership until `beginStageT()`; L3 still requires the cluster on exactly that labelled network (`7318eaf`) |
| A server that vanished during stage T emitted an unhandled pg `error` event and ended the runner with no record and no L6 | CON-10 cluster removal at `2313d9e`: no summary emitted | an error listener on every factory client (`7318eaf`) |
| The replacement workflow had an unquoted `${{ github.sha }}` in a YAML flow mapping, so GitHub rejected the whole file and no job ran; the static workflow test checked rules but never the YAML | the first push, run `38053042825` at `b1eab1d`: "workflow file issue", zero jobs | expression quoted; a flow-mapping rule with that exact line as its failing fixture (`b1-workflow.test.ts`). The file now parses with a YAML parser. |
| `tests/b1-required.json` was checked out with CRLF on Windows, so `build-required --check` (G1) failed although the blob equals the generated bytes | clean checkout of `5bf31b8` | `eol=lf` for that file (`cdce594`) |
| Case 36 asked its throwaway clone for `HEAD~1`, which a shallow CI checkout lacks | CI run `38054524572`, `runner-cases (refusals)` | one fixture commit in the clone; its parent is the release other than HEAD (`97dec74`) |
| CON-9 (unlabelled network) reported the induction as failed: the runner's next connection fell between the outside steps, so L3 refused and L6 removed the cluster before the test's re-connect | same run; reproduced locally (`docker network connect`: "No such container") | the induction is the labelled network replaced; the re-connect is best effort (`97dec74`) |
| An `.each` in `b1-base-guard.test.ts` gave three rows one title, so the lane A report held one expanded name three times; the gate refused it and coverage cascaded (689 problems); the required-row generator had skipped the repeat silently | CI gate, run `38054524572` | rows named; the generator refuses a repeat; a collection rule refuses a repeated name in a suite, with a fixture (CON-36) (`e31e216`) |
| G7 counted correctly but had never refused a real run | first identity mutation run: M44 INCONCLUSIVE (Docker build-cache error) | none needed: the G7 rule refused the verdict; the rerun killed 57/57 |

My own process errors during the sprint, none of them shipped:
- edits to a tree while a run was using it (case 17 refused a dirty tree);
- concurrent collections on port 54999, so two pilots lost the port;
- a background queue stopped by the host for low memory.

Runs are now sequential, one collection-port user at a time.

## 6. CONTRADICTION R279-DISCOVER-SKIP (blocks qualification)

**Observed.** CI run `38054524572` at `cdce594`, job `stage-t (regression-definers-discover)`: the record is
`REPOSITORY_QUALIFIED` with `regressionOutcome` `failed`, and its only problems are two entries of the form "skipped
test not an intentional skip". The tests are in `tests/runtime-roles-definers.integration.test.ts`:
- line 153, "database.runtimeRolesLeastPrivilege is green, read as kj_worker";
- line 161, "27.11: a platform function executable by PUBLIC in a schema the roles cannot USAGE is not a runtime fact".

Both are `it.skipIf(process.env["KJ_RUNTIME_ROLES"] === "discover")`. They were added in frozen B1 history (`d1a7d97`,
`94bb6cb`) because each needs a genuine `kj_worker` session, which the discover harness does not give production code.

**The sealed rules that meet here** (ADR-0023 at `af2f732`):
- 27.12.15 `regressionOutcome`: `passed` only if every test the collection assigns to the suite "passed, or is an
  accounted intentional skip".
- "Intentional-skip accounting": an intentional skip is an entry of `tests/baseline.json` `intentionalSkips` at `R`,
  and "every skipped test in any report must be one". G2 holds the count at 62.
- "CI gate over every registered suite": each registered stage T suite, discover twins included, needs a record whose
  recomputed `regressionOutcome` is `passed`.
- G5 for a discover twin: "exits 0 with zero failed", with its inventory gated.

The two skips are not among the 62, so the discover twin of `regression-definers` cannot reach `passed` as sealed.
No other lane D file skips by harness mode, so this is the only twin affected.

**Every resolution is outside this sprint's authority:**

| Resolution | Why it is not mine to take |
|---|---|
| Add the two skips to `tests/baseline.json` | changes the sealed G2 threshold of 62 |
| Remove the `skipIf` | changes test semantics; under discover, production code is not a `kj_worker` session, so the tests would fail |
| Exempt discover twins from the skip rule | relaxes a gate |

The gate is left as it is and refuses this twin. Qualification is therefore not claimed at any SHA until the owner
rules and, if the design changes, it is independently reviewed.

## 6a. Results (OBSERVED)

Status words as in section 1. A result at one SHA is evidence for that SHA only. Qualification is claimed at none
(section 6).

**CI (Linux engine, `ubuntu-24.04`, governed workflow, `push` events only):**

| Run | SHA | Outcome | What failed |
|---|---|---|---|
| `38053042825` | `b1eab1d` | FAIL | workflow file rejected; no job ran (section 5) |
| `38054524572` | `cdce594` | FAIL | `regression-definers-discover` (section 6); `runner-cases (refusals)` (case 36, CON-9); gate (those two plus the duplicate name in lane A, with coverage cascading) |
| `38056781302` | `e31e216` | FAIL | `regression-definers-discover` (section 6); `runner-cases (refusals)` (CON-4, CON-9, both Linux timing; change committed in `042d327`, Linux run pending); gate: 235 problems = definers-discover + the refused runner-cases report + its coverage cascade |

At `e31e216` every other job passed on Linux:
- **Static:** typecheck, lint, build, and the G1 generators and collection checks.
- **Lane A** (base-regression).
- **Runner cases:** coresident, settings, ledger, lifecycle and staget.
- **Stage T:** all twelve suites except `regression-definers-discover`.
- **EPH-26.**
- **G7:** all three mutation suites.
- **G9:** the worker image.

The gate's G2/G3 recomputation over the merged report counted 2,440 tests: 0 failed, 19 skipped, recovery 31 passed,
and no baseline, unexpected-skip or vanished-skip deviation. It is listed as a problem only because the merged
report's `success` is false while the other problems stand.

**Local (Windows engine, pinned `windows-x64` CLI, Node 22.19.0, Docker Desktop 29.1.5):**

| Evidence | SHA | Result | Record SHA-256 (prefix) |
|---|---|---|---|
| regression-enforce | `6196b71`, `e31e216` | REPOSITORY_QUALIFIED, `regressionOutcome` passed | `5dc92992`, `0ef6b1d9` |
| regression-probes | `4abffe5`, `cdce594` | the same | `0749857b`, `99ef2084` |
| regression-helper-probes | `cdce594` | the same | `303de6bc` |
| regression-definers | `cdce594` | the same | `981f9c89` |
| regression-gated | `cdce594` | the same | `45508d5d` |
| regression-stack | `7318eaf` | the same (80/80 tests) | `cbbbde46` |
| CON-48 on the probes log | `4abffe5` | 234 refusals reconciled; P1 to P7 each fail | evidence in `evidence/kj-p8-r279/con48/` |
| lane A base-regression | `2313d9e` | 86 files, 1,637 passed, 19 skipped (the four notRunInCi files), 0 failed | n/a |
| CON-13 | `2313d9e` | after lane A, the compose cluster holds no `kj_*` role and no runtime-role policy | n/a |
| G7 faculties, identity, identity-cognition | `84054cf`, `2efec2c`, `84054cf` | 5/5, 57/57 (rerun; first run M44 INCONCLUSIVE, Docker build cache), 62/62 killed | n/a |
| runner cases, earlier batches | `6cab960`, `583b5bf` | coresident 59/59, settings 52/52, ledger, lifecycle and refusals 106/106 | n/a |
| stage T runner cases (CON-5, 6, 10, 15, 16) | `2313d9e`, then `7318eaf` | 6/9, then the 3 failures fixed and passing | n/a |

The discover twins ran on Linux only. The local sequence at `cdce594` was stopped deliberately after five suites,
once the CONTRADICTION made a full local pass at that SHA moot.

## 7. Findings for design review (not changes to the sealed design)

The ADR is not resealed, and this record does not say it is.

1. **R279-HELPER-RETHROW** (owner ruling): the helper pin is preserved byte for byte. 27.12.4's "on failure the pinned
   body re-raises" is inaccurate, but no B1 requirement depends on it. B1 never claims the helper guarantees RLS
   enablement. The correction is pending independent design review.
2. **P2 naming.** Where several P2 clauses are violated at once, the migration names all of them. Some 27.12.9 cases
   name a single sub-rule.
3. **ACL-C.** The definer copy also violates P1, which is named alongside P2 (a) and E1.
4. **EPH-13 and EPH-5.** EPH-13 at S2 is refused at S3 by the snapshot, not at the gate; LEDGER-E at S5 shows the
   gate. EPH-5 is refused at S4 before the gate; with `s4-skip`, the gate refuses.
5. **CON-32.** The DO-block list omits the two inherited cleanup loops, which the shape check admits by name.
6. **Registry suite schema.** It gains `timeoutSeconds` and `roles`.
7. **CON-10 status.** A foreign container still attached at L6 makes the network removal fail. The run is then
   `NOT_QUALIFIED` as well as `regressionOutcome` `failed`. The ADR states only the latter. The runner never touches a
   container it did not create.
8. **CON-9 label clause.** A network's labels are immutable, so the outside construction replaces the run network. L3
   then refuses on network identity, before the label clause is reached. The label clause is unreachable from outside
   without a registered hook, which the R2.7.6 review left open.
9. **CON-15 and CON-16 construction.** The sealed fixture removes a manifest grant. That changes the B1 migration and
   its frozen statements digest, so the run stops at S7 before stage T. The same observable is built without touching
   B1: production code (`packages/identity` `withTenant`) issues a statement no runtime role may run, and swallows the
   error. CON-15 does this on the host only; CON-16 does it inside the compose worker only.
10. **CON-13 ledger clause.** Lane A's `migrate()` writes no Supabase ledger table. "The compose ledger never records
    `20261002090000`" therefore holds because there is no ledger. The check that carries weight is that the cluster
    holds no `kj_*` role and no runtime-role policy.

## 8. Blocked and not authorised

- **Hosted-disposable application** (HOSTED_COMMITTED on a hosted target): BLOCKED, as no authorised hosted
  disposable target exists. The hosted entry point's refusals are exercised; it has never connected to a hosted
  target.
- Production connection, baseline capture, ledger repair, deployment, merge, PR and P8A-0: not authorised and not done.
- Branch protection requiring the `gate` check is a repository setting outside this sprint's authority. Until it is
  set, "qualified" means the `gate` job of the qualification workflow concluded `success` for the exact SHA. A commit
  whose workflow did not run (for example `[skip ci]`) has no gate result and is not qualified.
- On `pull_request` events GitHub runs the workflow on a merge commit. Its gate qualifies that merge commit, not the
  branch head. This sprint uses `push` results only.
