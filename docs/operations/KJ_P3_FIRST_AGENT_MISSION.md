# KJ-P3 - the first real agent mission (`repo-analysis-mission/v1`)

Status: **code and tests complete; not deployed.** No production change, secret or live model call
was made in preparing this. Going live is a separate, explicitly authorised change window (see
"Going live" below).

## The mission

KernelJSON admits one repository-analysis task. It gathers GitHub evidence, has an **analyst runtime**
analyse it, has a different **reviewer runtime** review that analysis, reconciles the two against the
evidence, completes the canonical task only if the evidence supports it, and tells Jonny through Telegram.
The runtimes are models: Claude and Grok through OpenRouter, or DeepSeek directly (see "Runtimes").

Constraints held: KernelJSON is the sole task authority; the runtimes are execution runtimes that
return text; no second scheduler; no Shared Brain task authority; every step writes evidence; completion is
evidence-bound; the production scheduler and alerting code are untouched.

## What already existed

| Need | Where it already lived | Used as-is? |
|---|---|---|
| Durable execution | Restate `KernelWorkflowV1`, `services/kernel/src/executor/workflow.ts` | Extended with one recipe branch |
| Task, plan, evidence, outcome contracts | `packages/contracts/src` | Extended (closed enums) |
| Intent compiler and planner | `services/kernel/src/compiler`, `planner` | Extended with one recipe |
| Evidence-bound completion | `Ledger.write` verifies plan, steps and evidence in the commit transaction; `verifyPlanCompletion` per recipe | Used; mission verifier added |
| Task-scoped model calls with receipts | `ModelPort`, `callModel` (Restate-journalled), live-verified DeepSeek adapter | Reused; core extracted to a generic port |
| Capability service seam | `CapabilityServiceV1` (sealed `repository.read`) | One handler added |
| Public admission | `POST /v1/tasks` through the admission door, bearer, idempotency | Recipe id added |
| Durable notification | The KJ-P2.1 outbox, delivered over Telegram by the running monitor | Reused, alerting code untouched |
| Identity and human approval | Tenant membership checks in the ledger; `GoldenTaskWorkflowV1` approval wait | Ledger checks used; approval not needed (read-only, LOW risk) |

## What was missing

1. A vocabulary for anything but text recipes and one file read: no GitHub evidence, no runtime step.
2. A model port usable for a second provider (only DeepSeek existed, with a hard-coded endpoint).
3. Any judgement of runtime output: nothing checked a runtime's claims against evidence.
4. A completion verifier for a multi-step, runtime-produced result.
5. A way to admit and watch a mission without putting the bearer in a command line.
6. Deployment plumbing so the new settings are not silently dropped (compose allowlist, env-merge tool).

> **Superseded in part by KJ-P3.1** (`KJ_P3_1_MISSION_QUALITY.md`): the reconciliation now makes thirteen checks (a finding-count
> contract, uncited findings and evidence binding to the captured commit were added), findings cite `evidence` with git object ids
> instead of bare `paths`, and the provider is chosen per role so the analyst and reviewer can use different providers. The text
> below describes the mission as first shipped.

## Architecture path

```
POST /v1/tasks {recipe: repo-analysis-mission/v1, objective: "owner/repo [question]"}
  -> admission door (existing) -> KernelWorkflowV1 (existing) -> compile + plan (4 steps)

  1 GITHUB_EVIDENCE   CapabilityServiceV1.githubRead     TOOL_RECEIPT   read-only facts at one commit
  2 RUNTIME_ANALYSE   analyst model (ModelPort)          ARTIFACT       JSON analysis, bound to the facts
  3 RUNTIME_REVIEW    reviewer model (ModelPort)         ARTIFACT       JSON review, bound to the analysis
  4 RECONCILE         kernel, pure                       DETERMINISTIC  ten checks, decision

  ACCEPTED  -> TASK_VERIFYING -> ledger.finish re-verifies from persisted evidence -> COMPLETED
  otherwise -> FAILED with evidence
  after the terminal commit: enqueue one notice in the KJ-P2.1 outbox -> Telegram
```

### Who decides, and how

- Runtimes return text. They have no tools, no credentials and no way to move a task.
- `reconcileMission` (pure) makes ten checks from the evidence alone: the analysis parses; it cites the
  GitHub head SHA; every cited path exists in the GitHub tree; the review parses; it echoes the digest of
  exactly this analysis; both runtimes are in an allowed family and **the reviewer is a different model from the
  analyst**, judged by the model the provider reports it ran (`responseModel`, not the one requested); the
  verdict is not `reject`; no finding is flagged unsupported.
- The ledger then calls `verifyMissionCompletion` inside the transaction that commits COMPLETED. It re-parses
  the persisted GitHub facts, re-hashes the persisted runtime text, re-runs the reconciliation, checks the
  evidence is for the repository the task asked about, and requires the steps, the outcome summary and the
  evidence set to match. A workflow bug cannot self-approve: a mismatch becomes a terminal FAILED.
- The notice is queued after the terminal commit and can never change the outcome.

### Evidence recorded per mission

| Step | Type | Source | Digest |
|---|---|---|---|
| GitHub | TOOL_RECEIPT | `kerneljson:github-read/v1` | canonical digest of the facts (facts stored in metadata) |
| Analyst | ARTIFACT | `kerneljson:runtime/analyst` | sha256 of the returned text (text and model receipt in metadata) |
| Reviewer | ARTIFACT | `kerneljson:runtime/reviewer` | sha256 of the returned text |
| Reconcile | DETERMINISTIC_RESULT | `kerneljson:mission-reconcile/v1` | canonical digest of the reconciliation |

A failed GitHub read or a failed provider call also leaves an ARTIFACT recording what failed (never the
provider's error body), then the task ends FAILED.

### Files

- Contracts: `packages/contracts/src/mission.ts`; recipe and operation ids in `plan.ts`.
- Compiler and planner: `services/kernel/src/compiler`, `planner`.
- Mission: `services/kernel/src/mission/{run,reconcile,verify,evidence,prompts,notify,config,mission-cli}.ts`.
- Runtimes: `packages/runtimes/src/github-read.ts`; `packages/models/src/{chat-completions,openrouter}.ts`
  (the DeepSeek adapter's code, extracted unchanged into a generic port; its 44 tests still pass).
- Wiring: `executor/workflow.ts`, `executor/index.ts`, `capability-service.ts`, `index.ts`, the gateway recipe list.
- Deployment: `execution.compose.yaml` passthrough; `scripts/runtime_env_merge.py` allow-list.

## Runtimes

The deployment picks one provider group and two models. The kernel accepts a model from the `anthropic`, `x-ai` or
`deepseek` family for either role, and requires the two to be different models.

| Group | Key | Models | Independence |
|---|---|---|---|
| DeepSeek direct | `MISSION_DEEPSEEK_API_KEY` | bare names, e.g. `deepseek-flash` writes, `deepseek-v4-pro` reviews | different model, **same lineage** (weaker) |
| OpenRouter | `MISSION_OPENROUTER_API_KEY` | `provider/slug`, e.g. `anthropic/claude-sonnet-5` and `x-ai/grok-4.6` | different providers (stronger) |

Setting both keys is refused at startup rather than guessed. A same-lineage pair is accepted, but the evidence records
exactly which models ran, so the weaker independence is visible in the record and not hidden.

### What was proven live, locally (19/20 September 2026)

Real GitHub (a public repository, no token), real DeepSeek for both roles, a throwaway local Postgres ledger and the real
completion verifier. Nothing touched production. The provider reported the requested model names back, so the
independence and family checks worked on real responses.

| Attempt | Result | What it taught |
|---|---|---|
| 1 and 2 (first prompt) | REJECTED | The analyst returned 13 findings against a hard limit of 12, and the reviewer approved it anyway. The kernel's schema check caught what the reviewer missed. The prompt now states the hard limits with margin (at most 8 findings, summary at most 1500 characters) |
| 3 (fixed prompt) | REJECTED | The analyst cited a file that is not in the GitHub tree, and the reviewer approved it. The kernel rejected on `analysis_paths_exist_in_evidence` |
| 4 to 7 (fixed prompt) | COMPLETED x4 | About 11 seconds and about 20 thousand tokens each; eight findings, every cited path present |

So with the fixed prompt, 4 of 5 real runs completed and the one that did not was a runtime hallucination the kernel refused.
A rejected mission is a correct outcome, not a fault. It ends FAILED with evidence and a P2 notice.

## Honest limits

- **The runtimes are models reached through an API**, not the Claude Code agent or the Grok Bot application.
  `ModelPort` is the seam: an adapter for those agent surfaces plugs in the same way. The verifier checks the model
  the provider reports, so a substitution fails closed.
- **With DeepSeek alone, independence is model-level only.** Two models from one lineage can share blind spots.
  Claude plus Grok removes that. A reviewer can also approve badly, as attempts 1 to 3 show: the kernel's deterministic
  checks, not the reviewer, are what decide.
- A single run can be rejected for a runtime's mistake. There is no automatic retry in this slice.
- Analysis quality is only as good as the evidence: the tree is capped at 1000 paths, and a truncated tree is
  flagged to the runtimes. File contents beyond the README excerpt are not read.
- The mission is read-only and LOW risk. It is not policy-gated or approval-gated; a write-capable mission
  would need the existing policy and approval workflow.
- Live behaviour is proven only locally (above). Nothing has run against the production worker or Restate.

## Going live (a separate change window)

Prerequisites, none of which this PR performs:

1. **Merge and deploy** the release: worker and door together, `activate_release` in the same window, exactly
   as KJ-P2.2A. Use `scripts/runtime_env_merge.py` for the new keys; never regenerate `runtime.env`.
2. **DeepSeek route (no OpenRouter needed):** the key is `kerneljson/DEEPSEEK_API_KEY` (35 characters). Pass it to the merge tool
   from a file as `MISSION_DEEPSEEK_API_KEY`, with `MISSION_ANALYST_MODEL=deepseek-flash` and
   `MISSION_REVIEWER_MODEL=deepseek-v4-pro`. Confirm the model names against the DeepSeek models list first.
   **OpenRouter route (later):** store an OpenRouter key from the funded account under a new name, use
   `MISSION_OPENROUTER_API_KEY` with `provider/slug` models. Set exactly one of the two keys.
3. **Confirm the response model names** on the first production run: the verifier checks the model the provider reports.
   This was confirmed locally for DeepSeek.
4. **`GITHUB_READ_TOKEN`** (optional): needed only for private repositories. `other/GITHUB_TOKEN` in jVault is
   13 characters, too short to be a real token, so create a fine-grained, read-only token for the target
   repository and store it as `kerneljson/GITHUB_READ_TOKEN`. A public repository needs none.
5. **Admit** with the CLI, run in the worker image on the `kerneljson-exec` network, bearer from a mode-600 file:
   `mission admit --repo owner/repo --label first --question "..." --door-url http://<door>:8081 --bearer-file <path>`,
   then `mission status --task-id <id> ...`.
6. **Expect** one Telegram message when it finishes: a P3 `MISSION.repoAnalysis.<id8>.completed`, or a P2
   `...failed`. Run the KJ-P2.2A POISON gate before and after.

Rollback: unset the four mission variables through the merge tool and recreate the worker. With none set the
worker serves no mission and behaves exactly as it did before this change.
