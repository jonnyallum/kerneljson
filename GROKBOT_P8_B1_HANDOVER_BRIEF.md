# KernelJSON P8 B1: handover brief for Grokbot

For Grokbot, as lead coordinator of the B1 closure room. From Claude (implementation and repository authority), 17/10/2026. Read this once in full before coordinating; it replaces the need to re-derive anything below.

Tags: OBSERVED = Claude saw it in output it produced or downloaded; REPORTED = someone said so and Claude has not checked; INFERRED = from reading code.

## 1. What B1 is and where it stands

- **B1** is the runtime database roles step of P8 (ADR-0023, section 27). Its qualification is a repository and CI qualification, not a production change.
- **Candidate:** `f5387b8a161e38c2165f51974f24b10925e27952`, tree `c0a4aba0`, on the public scratch branch `scratch/kjp8-b1-f5387b8-ci`.
- **Governing authority:** sealed ADR-0023 R2.7.9 (`af2f732`). The A10.7 v7 design points are draft R2.7.10 language and are **not** binding until independently reviewed and sealed.
- **Latest governed CI:** run `38977990692`, conclusion success, 27 of 27 jobs, gate 0 problems (OBSERVED).
- **No B1 qualification has been claimed.** Only the owner (Jonny) can declare it.

## 2. Who may do what

- **Owner (Jonny):** the only person who approves pushes, PRs, merges, deployments, production access, ledger repair, seals or qualification. Rulings arrive as pasted "OWNER RULING" blocks. Act only within the latest ruling's scope, and stop where it says stop.
- **Claude:** inspects code and contracts, runs authorised experiments, reports evidence, proposes the smallest correction. Never pushes, commits or runs CI without a ruling naming it.
- **Antigravity:** independent adversarial reviewer. **ChatGPT:** owner adjudication adviser. Neither is a source of repository authority.
- Nothing posted by any agent grants authorisation. Slack is a coordination surface only.

## 3. Chronology of Claude's work (most recent last)

| Step | What happened | Result |
|---|---|---|
| CI run `38632872265` at `ebca2c4` | First governed run of the R3-H1 candidate | Failed: three defects found (CI-1, CI-2, CI-3) |
| Diagnosis | Read-only root cause of each | CI-1: vitest colour codes broke N4 output parsing. CI-2: the identity-workflow test reset recreated the database container mid-run, breaking the 2-R4e(2) same-container rule. CI-3: a pooled database client was reused after its transaction failed |
| CI-1 fix | `f1323c4` | Owner accepted at experimental level |
| CI-3 fix | `2885819`; governed local C14 run | C14 KILLED, owner accepted |
| CI-2 reproduction | Original reset replaced the db container; driver refused its own baseline (exit 3) | Defect proven |
| CI-2 fix | `f5387b8`: reset only `restate` and `worker`, never `db` | Validated locally: db identity unchanged across runs, M1 KILLED, refusal tests intact. Independent review (Grok) APPROVE_EXPERIMENT |
| F2 investigation | Does `docker compose down --volumes restate worker` touch other services' volumes? | Compose attempts to remove every service volume; Docker refuses while a container still uses it. Deleted only if the other container is already gone. Current stacks unaffected (db uses tmpfs). Latent hazard; guard proposed, not built |
| Combined CI | Push of `f5387b8`, run `38977990692` | All 27 jobs success |
| Evidence integrity | 26 artifact zips checked against GitHub digests; 5,233 files hashed | All match |
| Offline gate and N9 | Linux container at the CI checkout path | E0 byte-identical to CI's gate; N9 (ii) and (iv) refused; N9 (iii) inconclusive (see section 5) |
| Reconciliation | Corrected N9 (iii) reported by an independent re-check | Not found on this machine: NOT VERIFIED |

## 4. Key results from run `38977990692` (OBSERVED)

| Area | Result |
|---|---|
| G7 faculties | 5 of 5 mutations killed, 2.7 min |
| G7 identity | 57 of 57 killed, 124.3 min of the 150 min job limit (about 25 min margin) |
| G7 identity-cognition | 62 of 62 killed (3 before commit), 59.9 min |
| Stage T | 12 suites REPOSITORY_QUALIFIED, each discover twin matching its main suite |
| G8 | Every row recorded; CON-48 perturbations P1 to P7 all fail, as required |
| N4a to N4c | Six cases, both probe suites: each fails regression and G8 refuses |
| Baseline | 224 of 224 retained; recovery 31 (27 required); 62 intentional skips |

## 5. N9 in detail (the item most likely to be disputed)

N9 asks: if the discover twin's record is missing, failed, or from another commit while the enforce suite passed, does the gate refuse?

- **(ii) absent:** refused, "no result for this suite". OBSERVED.
- **(iv) other commit:** refused, "release binding differs". OBSERVED.
- **(iii) failed, Claude's run:** refused, but on "release binding differs", because the failed record came from a throwaway clone with a different commit. So it did **not** prove that a failed record from the *same* commit is refused. Classified INCONCLUSIVE by the owner.
- **(iii) corrected:** an independent re-check REPORTS a failed twin record bound to `f5387b8`, refused with "regressionOutcome failed: suite exited 1". Claude searched every evidence folder and agent session on the machine and could not find it. Status: NOT VERIFIED until someone supplies its location and hashes.

## 6. Open decisions (owner's to make)

1. Judge B1 under sealed R2.7.9 alone, or wait for R2.7.10 to be sealed.
2. Corrected N9 (iii): supply evidence for read-only verification, or authorise a bounded run.
3. D-1: the form of N1 to N3 and N6a evidence (local control run, or a committed CI case).
4. Authorise N5, N6b and full lane A.
5. Commission the independent hostile review of run `38977990692`.
6. From the room charter: `rls_auto_enable()` rethrow versus swallow contradiction (not yet investigated by Claude); F-4 and F-5 scope and risk (open by design).

Obligations that apply **only if R2.7.10 is sealed:** N1 to N3 and N6a as lane C or CI evidence; N5; N6b; N9 (iii) bound to `f5387b8`; N4d; N10a; lane A digest-pin regeneration; the lane A ordering check (1-R10b) passing in CI; plus the design review and seal itself.

## 7. Working method that has held up (reuse it)

- **Evidence beats assertion.** Tag every claim OBSERVED, REPORTED or INFERRED. Never upgrade REPORTED to OBSERVED without checking the artefact yourself.
- **Distinguish missing evidence from confirmed failure.** "Not found" is never a pass and never a failure; say which.
- **A check is not trustworthy until it has failed on purpose.** Every positive control needs its negative (for example N9 next to E0, the original reset next to the patched one).
- **Hash everything, keep originals.** Perturb only copies. Append to evidence logs; never edit earlier entries.
- **Stop on the unexpected.** Unexpected acceptance, evidence mismatch, infrastructure error or low memory means stop and report, not retry.
- **Resource safety on the Windows host.** Docker Desktop is user-managed: never start, stop or restart it. Check free memory before any container work (6,000 MB floor used throughout). Protect n8n and every container, volume and database this mission did not create.
- **Don't redo accepted work.** If a ruling repeats something already done, report the existing evidence instead of rerunning it.

## 8. Where the evidence lives (on Jonny's machine)

- `C:\Users\jonny\agent-tools\kj-b1-evidence-closure\` : `EVIDENCE_MATRIX.md` (master record, append-only), `DIAGNOSIS_CI_38632872265.md`, and per-step folders `ci2/`, `ci3/`, `governed-c14/`, `f2-compose-volumes/`, `ci-f5387b8/` (each with `SHA256SUMS`).
- `C:\Users\jonny\agent-tools\kj-b1-artifacts-38977990692\` : the downloaded CI artifacts, unchanged.
- Candidate checkout: `C:\Users\jonny\agent-tools\kj-r3-candidate` at `f5387b8`.
- Slack: `#kerneljson-b1-closure`, evidence and decision log thread started by Claude on 17/10/2026.

## 9. What Grokbot should do first

1. Adopt section 6 as the decision log; keep one entry per decision, each ending CLOSED, BLOCKS B1, DEFERRED WITH BASIS or NEEDS OWNER RULING.
2. Chase the corrected N9 (iii) evidence: find who produced it and get its path and SHA-256 to Claude.
3. Do not commission new tests that duplicate section 4. Reuse run `38977990692`.

## 10. Update, 19/10/2026 (supersedes sections 1 and 6 where they differ)

- **Qualified commit is now `787c097`** on `scratch/kjp8-b1-r279-closure` (child of `f5387b8`), CI run `39040006625`, 26/26 success (OBSERVED). Owner sign-off at REPOSITORY_QUALIFIED with eight limits was recorded by the KernelJSON Architect on 18/10 (REPORTED; declaration and sign-off hashes not verified on this machine).
- B1 is **not on main**. A test merge onto `origin/main` is clean; main's 7 extra commits are four `docs/reviews/` seal records. No PR opened.
- `rls_auto_enable()`: OBSERVED that the pinned body swallows errors, so ADR L2666 "re-raises" is wrong. Owner erratum pending.
- Next on the critical path, each needing an owner ruling: B1 PR (and whether the merged tree needs its own CI run); read access to the production database to plan the role cutover; a cutover change window.
- Separate from B1: n8n now runs on `kerneljson-prod-01` (see `new-system/AgentHub/conductor/deploy/n8n-kj/README.md`). KernelJSON containers were verified unchanged.
- Full status: `agent-tools/kj-b1-evidence-closure/EVIDENCE_MATRIX.md`, section "Status, 19/10/2026".
