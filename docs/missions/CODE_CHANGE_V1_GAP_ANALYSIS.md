# Mission #2: `code-change/v1`, implementation gap analysis

Written 22/10/2026 against `main` at `c5de3f5` (production, epoch 16). Tags: **FACT** is read from the code or observed in production; **INFERENCE** is a reading not yet tested; **RECOMMENDATION** is a proposal that needs Jonny's decision where marked.

## The goal, as asked

Jonny states a change in ChatGPT (or Telegram). KernelJSON has it made on a branch of one allowlisted pilot repository by an isolated GitHub Actions runner, verifies the result from evidence, has it reviewed by an independent model, opens a **draft** PR and says so on Telegram. Nothing it holds can merge or deploy. Jonny reviews and merges in GitHub.

Out of scope for the pilot: more than one repository, more roles or agents, merging, deploying, any P8 governance work, any change to the morning brief.

## What already exists and is reused unchanged

| Need | Existing machinery | Evidence |
|---|---|---|
| A recipe the kernel drives step by step, every step leaving evidence | The repo-analysis mission: `GITHUB_EVIDENCE -> RUNTIME_ANALYSE -> RUNTIME_REVIEW -> RECONCILE` | FACT: `services/kernel/src/mission/run.ts` |
| Completion only when the kernel's own re-derivation from persisted evidence agrees | `verifyMissionCompletion`, called by the ledger inside the COMPLETED transaction; a mismatch becomes FAILED | FACT: `mission/verify.ts`, `executor/index.ts:70` |
| Read-only GitHub evidence at one commit, bounded, no redirects, token never in output | `createGithubGet` / `createGithubReader` | FACT: `packages/runtimes/src/github-read.ts` |
| An independent reviewer of a different model, with the family the provider reports checked | `MISSION_RUNTIME_FAMILIES`, `sameModel`, per-role provider config | FACT: `contracts/src/mission.ts`, `mission/config.ts` |
| Model receipts with token usage | `ModelUsage` on every model call, journaled by Restate | FACT: `contracts/src/model.ts` |
| Durable waiting across minutes or a worker restart | Restate workflow with durable sleep and signal | FACT: implemented phase 3 and 4 |
| Telegram notification after the terminal commit, replay-safe | `enqueueMissionNotice` through the durable outbox | FACT: `mission/notify.ts`; delivered daily by the brief |
| Admission from ChatGPT with a scoped principal | Door `doorScope` with `MCP_RECIPES`, the `chatgpt-mcp/v1` channel, MCP tools calling `door.admit` | FACT: `apps/gateway/src/main.ts:204`, `apps/mcp/src/tools.ts` |
| Admission from Telegram | `/mission` command and `admissionRequest` | FACT: `channel/telegram/commands.ts` |
| Reading results from ChatGPT | `kj_get_task`, `kj_task_evidence`, `kj_task_history` already show any task | FACT, verified live 22/10 |
| Human approval with Telegram cards | Policy `APPROVAL_REQUIRED`, approval store, `approve` control, cards | FACT, but wired only to the golden workflow (`approval-boundary.ts`), not to missions |

## The gaps

| # | Gap | Size | Notes |
|---|---|---|---|
| G1 | Recipe contract: `CODE_CHANGE_RECIPE`, criterion, objective parser (`owner/repo` must be on the allowlist; bounded instruction text), result manifest schema, evidence shapes | S | Mirrors `contracts/src/mission.ts` |
| G2 | The runner: a `workflow_dispatch` workflow in the pilot repository, from its default branch so the agent cannot change it. Two jobs: **code** (agent, pushes `kj/<task>`), then **test** (fresh runner on the pushed commit, no secrets, read-only) | M | The test job is separate so the agent cannot fake its result: the kernel reads the job's conclusion from the Actions API, not from anything the agent wrote |
| G3 | GitHub runner client for the worker: dispatch, find the run by task id, poll, read job conclusions, compare `base...branch`, read the manifest artifact, create a draft PR | M | Same bounded style as `github-read.ts`; the only writes are dispatch and draft PR |
| G4 | Mission sequence `runCodeChangeMission`: `GITHUB_EVIDENCE -> RUNNER_DISPATCH -> RUNNER_AWAIT -> CHANGE_EVIDENCE -> RUNTIME_REVIEW -> RECONCILE -> DRAFT_PR` | M | Copies the repo-analysis shape; durable sleep between polls, hard deadline |
| G5 | Completion verifier `verifyCodeChangeCompletion`: branch head equals the reviewed commit, diff digest equals the reviewed diff, test job `success` on that commit, reviewer accepted, draft PR head equals that commit, paths and size inside bounds | M | The load-bearing part. Each check gets a negative test |
| G6 | Wiring: compiler criterion, executor and workflow dispatch, ledger verifier call, door `PublicSubmission` enum and `MCP_RECIPES`, worker config (fail closed: unset means not served) | S | One branch in each of five existing switch points |
| G7 | MCP tool `kj_run_code_change(repo, instructions, request_id)`; Telegram `/change` command | S | Reads need nothing new |
| G8 | Bounds: one code-change task at a time; instruction length; runner `timeout-minutes`; agent turn limit; dedicated model key with a spending limit; diff size and file count caps; refused paths (`.github/`, lockfiles unless asked, secrets patterns) | S | Enforced by the kernel and the workflow, not by prompt wording |
| G9 | Credentials, set up once by Jonny (below) | S | No code |
| G10 | Approval before anything consequential | none in the pilot | See decision D4 |

Not a gap: a new orchestration layer, a new evidence store, a new notifier or a new principal type. None is needed.

## Credentials and what each can do

| Holder | Credential | Can | Cannot |
|---|---|---|---|
| Runner, code job | `GITHUB_TOKEN`, `contents: write` | push a branch | push or merge to the default branch (repository ruleset: only `kj/**` may be created by Actions; default branch needs a PR and Jonny's review); change workflows (no `workflows` permission) |
| Runner, code job | A **dedicated** model API key with a hard spending limit, as a repository secret | call the coding model | anything else; it is worthless outside the model provider and capped |
| Runner, test job | `GITHUB_TOKEN`, `contents: read` | check out and test | write anything; it has no secrets |
| Worker (KernelJSON) | New fine-grained token, **pilot repository only**: Actions read/write, Contents read, Pull requests read/write | dispatch the one workflow, read runs and artifacts, open a draft PR | merge (needs Contents write), push, deploy, touch any other repository |

No production secret reaches GitHub Actions. The worker's token is the only new production credential, and it is limited to one repository with no deploy path, provided the pilot repository has no deploy workflows or deploy secrets (a precondition, checked before setup).

**INFERENCE, a residual risk to accept:** the code job runs an agent on untrusted repository content with network access and the model key. Prompt injection could make it misuse that key. The key is dedicated and capped, and the job holds nothing else.

## Decisions needed from Jonny before the build PRs

- **D1, the pilot repository.** It must be small, have a test command that runs in CI in a few minutes, and have no deploy workflow or secrets. The candidates need checking against that; RECOMMENDATION: a non-production repository of yours, not `kerneljson`.
- **D2, the coding agent in the runner.** RECOMMENDATION: Claude Code in headless mode (`claude -p` with a turn limit and a fixed tool allowlist), with a dedicated Anthropic API key capped in the Anthropic console. Alternatives: aider or Codex CLI through OpenRouter.
- **D3, the reviewer model.** RECOMMENDATION: the existing reviewer runtime, which must be a different model family from the coding agent (the existing independence rule).
- **D4, approval.** RECOMMENDATION: no KernelJSON approval in the pilot. A draft PR changes nothing until Jonny merges it in GitHub, and the repository ruleset makes that merge his alone. Wiring the existing approval cards into missions is a separate step if wanted.
- **D5, admission on Plus.** OpenAI's pages checked on 21/10 do not say whether Plus gets write tools on custom servers, and Pro gets read only (FACT: OPERATOR_MCP.md). The existing write tools have not yet been tried on Plus. Until they have, assume `kj_run_code_change` may not be callable from ChatGPT on Plus. Telegram `/change` covers that; ChatGPT can still follow the task with the read tools.

## Build plan: three PRs, each releasable

1. **PR A, the verified core, no live wiring.** G1, G3, G5 and the workflow file for G2 (stored under `infrastructure/github/` for installation in the pilot repository). Unit tests against a fake GitHub API; every verifier check broken on purpose. Nothing is served yet. This is the narrowly scoped first build PR.
2. **PR B, wiring.** G4, G6, G7, G8, with integration tests in CI. The worker serves the recipe only when its configuration is complete.
3. **Release and pilot.** Install the workflow and ruleset in the pilot repository, create the credentials (G9), release in an approved window, then one real change end to end: ChatGPT or Telegram request, runner, tests, review, verified completion, draft PR, Telegram notice.

Acceptance for the pilot: one task COMPLETED with evidence for every step; a draft PR whose head is the verified commit; one deliberately bad change (failing test) ending FAILED with no PR; the worker token shown unable to merge.
