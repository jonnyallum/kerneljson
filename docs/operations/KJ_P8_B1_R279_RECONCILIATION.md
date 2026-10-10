# KJ-P8 B1 R2.7.9: requirements matrix and independent reconciliation

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
