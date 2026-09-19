# KJ-P3 - first real agent mission - code qualification

**Status: PASS (code qualification only). Not deployed. No live model or GitHub call has been made for a mission.**

Date: 2026-09-19. Describes `repo-analysis-mission/v1`; design and honest limits are in
`docs/operations/KJ_P3_FIRST_AGENT_MISSION.md`.

Evidence tags: **OBSERVED** means read or run live in this session. **REPORTED** means relayed by Jonny; the
primary output was not seen.

## Canonical record

| Item | Value |
|---|---|
| PR | #35, squash-merged into `main` |
| Canonical merge SHA | `e0629515886f4d52c62fd69156d2c92c215fb05d` |
| Merge commit parent | `0d6874151e8ed32edc85cf379ac436e5c603aeff` (KJ-P2.2A freeze), single parent |
| Reviewed and merged PR head | `82fcd59368f125d8cb74dc39b41ad58ba8bb268e` (the merge was pinned to this head) |
| Tree of merge commit | `1c060f83ee194ab1e61b08884dcf086d9dd950aa`, identical to the reviewed head's tree |
| Scope | 37 files, file list identical to the reviewed PR; nothing unrelated landed |

## Review and CI

- CI on head `82fcd59`, two `Kernel qualification` runs: success (35453328305 and 35453329119). OBSERVED. The PR was `CLEAN` and `MERGEABLE`.
- Grokbot adversarial review found one blocker: the README was fetched without a ref, so it came from the branch tip while
  the commit and tree were pinned, allowing mixed-state evidence. Fixed in `82fcd59` by requesting
  `readme?ref=<captured sha>`; six tests added, five of which fail against the previous head. **Grokbot then CLEARED it. REPORTED by Jonny.**
- Grokbot's non-blocking risks were deliberately not addressed in that patch. Their content has not been seen here and is
  not restated.

## Test totals (OBSERVED, on head `82fcd59`, before merge)

| Gate | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | exit 0 |
| `pnpm check:topology` | PASS |
| GitHub reader tests | 18 passed |
| Mission reconciliation, real-Postgres verifier, CLI, OpenRouter port | 4 files, 63 passed |
| `pnpm test:unit` | 27 files, 510 passed |
| Full regression `pnpm test` | 65 files passed, 10 skipped (75); **944 passed, 62 skipped**, 1006 total; exit 0; no unhandled errors |
| `pnpm test:baseline` | **224/224 retained**; recovery 31 (needs at least 27); 62 intentional env-gated skips |
| Validation stack teardown | clean |

The worktree had no tracked changes when these ran, so the results describe the committed head. The 62 skips are the same
enumerated, env-gated integration tests `main` has carried since KJ-P2.2 (853 passed before KJ-P3, so +91 tests).

## Properties reconfirmed from the code and tests (OBSERVED)

1. **README pinned to the captured head sha.** `github-read.ts` requests `readme?ref=` with `encodeURIComponent(commit.sha)`.
2. **Tree and README are one commit.** The tree is fetched at `git/trees/<commit.sha>` and the README at the same sha; the
   commit is read once. A test moves the branch tip immediately after the commit is read and the README evidence stays that
   of the captured commit; the test double is shown to serve the newer README when no ref is sent.
3. **No runtime has task authority.** `ModelPort` carries no permissions, tools or task lifecycle. In `mission/run.ts` the only
   thing that can move a task is the injected `emit`; the ledger is imported as a type only, and the runtimes are reached only
   through `callModel`, which returns text.
4. **Completion still requires ledger-verifiable evidence.** `verifyPlanCompletion` routes the mission recipe to
   `verifyMissionCompletion`, which re-hashes persisted runtime text, re-parses the GitHub facts, recomputes the reconciliation
   and checks the repository. Tests show it refuses a wrong-repository, a forged step and forged runtime text.
5. **A notification failure cannot rewrite terminal truth.** The notice is queued only after the terminal `emit` has committed, inside a
   `try/catch` that swallows its own failure; a test forces the outbox to fail and the task stays COMPLETED.

## Live prerequisites, measured on 2026-09-19 (OBSERVED)

| Prerequisite | State | What is needed |
|---|---|---|
| OpenRouter key placement | The key exists at `jonnyai/OPENROUTER_API_KEY` and `other/OPENROUTER_API_KEY` (length 73). `kerneljson/MISSION_OPENROUTER_API_KEY` **does not exist** | `secretctl copy` it under `kerneljson/` with `--expect-len 73` |
| OpenRouter key validity | Valid (key-info call returned 200), paid tier, no per-key spending cap | none |
| **OpenRouter account balance** | **Exhausted: 458.87 credits bought, 459.05 used, remaining about -0.19.** A mission would fail at its first model call with `INSUFFICIENT_BALANCE` | **Jonny tops up the OpenRouter account** |
| Claude model slug | Not set. Current in OpenRouter's public list: `anthropic/claude-sonnet-5` (2.00 in / 10.00 out per million tokens), `anthropic/claude-opus-5` (5.00 / 25.00) | Recommend `anthropic/claude-sonnet-5` for `MISSION_ANALYST_MODEL` |
| Grok model slug | Not set. Current: `x-ai/grok-4.6` (2.00 / 6.00), older `x-ai/grok-4.5`, `x-ai/grok-4.3` | Recommend `x-ai/grok-4.6` for `MISSION_REVIEWER_MODEL` |
| GitHub token for private repos | `kerneljson/GITHUB_READ_TOKEN` does not exist; `other/GITHUB_TOKEN` is 13 characters, not a real token. **Not needed for the first mission: `jonnyallum/kerneljson` is a public repository** | Only for a private target later |
| Admission bearer | `kerneljson/KJ_ADMISSION_BEARER` present (length 43) | Written to a file for the CLI |

Cost estimate at list prices with the two recommended slugs: about 65 thousand input and 6 thousand output tokens per mission, roughly
0.20 in provider credits, well under 1 per mission. A top-up of 20 covers about a hundred missions.

## Shortest exact path to the first live mission

Each numbered step is a separate, explicitly authorised action; none has been taken.

1. **Jonny tops up OpenRouter** (the only step that needs money).
2. Copy the key: `secretctl copy jonnyai/OPENROUTER_API_KEY kerneljson/MISSION_OPENROUTER_API_KEY --expect-len 73`.
3. **Deploy** worker and door together from canonical code commit `e0629515886f4d52c62fd69156d2c92c215fb05d`, following the KJ-P2.2A
   procedure: baseline gate, `sudo python3 scripts/runtime_env_merge.py` with `MISSION_ANALYST_MODEL=anthropic/claude-sonnet-5`,
   `MISSION_REVIEWER_MODEL=x-ai/grok-4.6` and the key from a file, image build, recreate, running-container checks, then
   `activate_release` (epoch 3 to 4), then the POISON gate. Keep clear of the next scheduled fire at 2026-09-20T08:00Z.
4. **Admit** in the worker image on the `kerneljson-exec` network, with the bearer in a mode-600 file:
   `mission admit --repo jonnyallum/kerneljson --label first --door-url http://kerneljson-admission-door-gateway-1:8081 --bearer-file <path>`.
5. **Watch** with `mission status --task-id <id> ...`. Expect COMPLETED with four evidence rows and one Telegram message
   (P3 `MISSION.repoAnalysis.<id8>.completed`), or a REJECTED or FAILED outcome with evidence and a P2 message.
6. **Verify** in a fresh session: task COMPLETED, four evidence rows, the notice DELIVERED once, POISON 0, counters unchanged
   apart from the mission's own task.

## What this record does NOT establish

- Nothing was deployed and production was not changed.
- No live call has been made to OpenRouter for a mission, so it is **unverified that a live response reports a `model` in the
  `anthropic/` and `x-ai/` families**. The verifier checks that value and fails closed, so a naming difference would show as a
  REJECTED mission rather than a wrong acceptance.
- Restate registration of the new capability handler and the mission branch is covered by the worker registration tests but has not
  run against the production Restate; the first live run is that check.
- Analysis quality is untested against a real model.

## Result

**KJ-P3 CODE QUALIFICATION: PASS.**
