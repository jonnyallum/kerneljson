# KJ-P3 - first live agent mission - RESULT

**Status: PASS**
**Window: 2026-09-20, 06:16Z to 06:27Z (finished 93 minutes before the 08:00Z scheduled fire)**
**Design: `docs/operations/KJ_P3_FIRST_AGENT_MISSION.md`. Code qualification: `docs/operations/PHASE_KJ_P3_FIRST_REAL_AGENT_MISSION_CODE_QUALIFICATION_2026-09-19.md`.**

Evidence tags: OBSERVED means read live in this window. REPORTED means relayed by Jonny.

## Summary

KernelJSON admitted one real repository-analysis task through the production admission door, gathered GitHub evidence at one
exact commit, had DeepSeek Flash analyse it, had DeepSeek V4 Pro review it, reconciled the two deterministically, and
completed the canonical task only after the ledger re-verified the evidence. It then queued one Telegram notice through the
durable outbox. The whole mission took about 20 seconds. KernelJSON remained the only authority throughout: the runtimes
returned text and nothing else.

## Release and deployment (OBSERVED)

| Item | Value |
|---|---|
| Merge SHA (PR #36) | `4f6ac8c9b7c80ccde5efb5bcbf77f12af5def70c`, merged tree identical to the reviewed head's (`1581b8f...`), 13 files |
| Deployed release, worker and door | `4f6ac8c9b7c80ccde5efb5bcbf77f12af5def70c`, images `kerneljson-worker:4f6ac8c` and `kerneljson-admission-door:4f6ac8c` |
| Previous release | `b3a6cb7101254145e05bc79f2cd601a606d3f97b`, epoch 3 |
| Active release epoch | **4**, request `8de25b5a-2bac-4a0d-b78a-c7f08fc24c12`, previous release `b3a6cb7...` |
| Epoch verification | fresh DB session (backend pid 1604109): exactly one epoch-4 row, release and previous release and request id as requested; epochs 2 and 3 unchanged |
| Cutover | 06:21Z; `activate_release` returned epoch 4 at 06:21:45Z, after every pre-activation check passed in the same script |

Precheck before any change (read-only, 06:17Z): worker, door and Restate healthy with `restarts=0`; worker and door on
`b3a6cb7`; one `ProductionAlertMonitor` chain plus the `ScheduleDriver`; alert runner on at 300000ms with the Telegram transport;
no open P0/P1/P2; outbox 7 delivered, POISON 0; counters 27 / 8 / 28; the fire 1h43m away.

Environment change: the merge tool touched four keys only. `KERNELJSON_RELEASE_ID` changed and three were added:
`MISSION_DEEPSEEK_API_KEY` (fingerprint `16031682`, equal to the vault entry), `MISSION_ANALYST_MODEL`, `MISSION_REVIEWER_MODEL`.
Every existing key was `UNCHANGED` by fingerprint, including the alert runner settings, the Telegram token and chat ID, the
scheduler and the admission settings, and the independent `verify` reported `VERIFY OK` for the worker and the door.

Running containers after cutover (presence and non-secret values only): `ALERT_RUNNER_ENABLED=true`,
`ALERT_RUNNER_CADENCE_MS=300000`, `ALERT_STATE_STORE=postgres`, `ALERT_TRANSPORT=telegram`, `SCHED_ARM_NEXT=true`,
`MISSION_ANALYST_MODEL=deepseek-flash`, `MISSION_REVIEWER_MODEL=deepseek-v4-pro`; the DeepSeek key, Telegram token and chat ID
`SET`; the OpenRouter key `UNSET`. Restate registration returned 200 with every existing service intact plus the new `githubRead`
handler; the monitor's `nextSequence` advanced 836 to 837 to 838 with no reset. The staged DeepSeek key was shredded within a minute
of the cutover, and the rollback baselines and staging directory at close.

## The mission (OBSERVED)

| Item | Value |
|---|---|
| Task ID | `8702ca51-000a-86de-ac19-5b77228a307a` |
| Recipe | `repo-analysis-mission/v1`, risk LOW, bound to `KernelWorkflowV1` at release `4f6ac8c` |
| Objective | `jonnyallum/kerneljson` plus the question: review the repository and identify the three highest-value concrete improvements to reliability or operational usefulness, every finding citing an existing repository path |
| Admitted | once (one task, one admission, one binding) |
| Captured GitHub head SHA | `4f6ac8c9b7c80ccde5efb5bcbf77f12af5def70c` (head commit dated 06:16:38Z), repository public, 567 tree entries, not truncated, README present |
| Analyst model, as reported by the provider | `deepseek-flash` (provider `deepseek`), 8104 input and 1872 output tokens |
| Reviewer model, as reported by the provider | `deepseek-v4-pro` (provider `deepseek`), 9961 input and 66 output tokens |
| Reviewer verdict | `approve`, no unsupported findings, echoed digest equal to the analysis digest |
| Reconciliation | **ACCEPTED**, all ten checks passed |
| Final task status | **COMPLETED**, one outcome row citing four evidence rows |
| Steps | four, all COMPLETED (tool call, two LLM calls, deterministic reconcile) |

Independence, stated plainly: this is **different-model independence within the same provider and model-family lineage**
(both DeepSeek), **not cross-provider independence**. The kernel required the reviewer to be a different model from the analyst and it was;
both are DeepSeek, so they may share blind spots. Claude plus Grok would remove that, and remains available through the OpenRouter route.

### Evidence rows (four, one per source, no duplicates)

| Type | Source | What it holds |
|---|---|---|
| TOOL_RECEIPT | `kerneljson:github-read/v1` | the GitHub facts at the captured head SHA, and their canonical digest |
| ARTIFACT | `kerneljson:runtime/analyst` | the analysis text, its digest, the model receipt; bound to the GitHub digest |
| ARTIFACT | `kerneljson:runtime/reviewer` | the review text, its digest, the model receipt; bound to the analysis digest |
| DETERMINISTIC_RESULT | `kerneljson:mission-reconcile/v1` | the ten checks and the decision |

Bindings checked from the database: the analyst evidence's subject digest equals the GitHub digest; the reviewer's subject digest equals the
analysis digest; the analysis text hashes to its recorded digest. Events: one each of `TASK_CREATED`, `INTENT_RESOLVED`, `PLAN_COMPILED`,
`TASK_READY`, `TASK_STARTED`, `TASK_VERIFYING` and `TASK_COMPLETED`, and four each of `STEP_STARTED` and `STEP_COMPLETED`.

## What the mission produced

Eight findings, each citing existing repository paths (the kernel verified every cited path against the GitHub tree). Titles:
thin CI automation relative to the integration test surface; runtime adapters and model ports lacking adjacent tests and docs; split Node and Python
operational scripts with no single bootstrap entry; root-level planning documents competing with `STATE.yaml` as source of truth; the alerting and outbox
stack being broad with limited per-module docs; scheduler durability split across many modules without a summary runbook; Supabase migrations without a
rollback or drift check; and Mission Control being minimal relative to its advertised role.

Two honest observations. **The question asked for three; the analyst returned eight.** The kernel does not check the count against the question, so this
passed; a future version should carry the requested count into the prompt and the check. And **the kernel verifies that cited paths exist and that the
evidence chain is intact, not that each claim is true.** The reviewer approved with no notes. The findings have not been fact-checked here beyond that,
and at least one (finding 2) describes tests as indirect where the repository does have tests for those files.

## Telegram (OBSERVED, and REPORTED by Jonny)

| Check | Result |
|---|---|
| Outbox row | `MISSION.repoAnalysis.8702ca51.completed`, kind NEW, severity P3, created 06:23:28Z (after the terminal commit) |
| Delivery | `DELIVERED` at 06:25:18Z by the monitor's next natural tick, `attempt_count` 1, no error |
| Delivery events for this notice | exactly 1 (`telegram`, `DELIVERED`) |
| Phone | both new messages arrived, REPORTED by Jonny |

A second natural message went out at the same time: `authority.bindingReleaseConsistent` **RECOVERED** (P3). The mission's own binding under epoch 4
was the first binding under the new epoch, which cleared the P3 that had been open since the previous release. It is unrelated to the mission's
completion notice. Alert state afterwards has only the known `legacyAuthority.b1FreezeObservable` P3 open.

## Replay and safety (OBSERVED)

| Check | Result |
|---|---|
| Replay (same label re-admitted at 06:26Z) | returned the same task, status COMPLETED; no second task, no re-run |
| Counters before and after the replay | identical: admissions 28, fires 8, bindings 29, mission tasks 1 |
| Duplicate completion | none: one outcome row, one `TASK_COMPLETED` event |
| Duplicate evidence | none: four rows, one per source |
| Notices | one mission notice, one delivery event |
| Business counters, before and after the mission | admissions 27 to 28, bindings 28 to 29 (the mission's own task); **schedule fires unchanged at 8** |
| Alerting and outbox | gate PASS: PENDING 0, SENDING 0, POISON 0, no duplicate DELIVERED; 9 delivered (7 plus the two above) |
| Runtime | worker, door and Restate healthy with `restarts=0`; one `ProductionAlertMonitor` chain and one `ScheduleDriver`; `nextSequence` 838 |

## Deviations and notes

1. The door bearer was moved from the container's own environment into a private file inside the container, used by the admission tool, and
   removed; the value never appeared in a command or output.
2. My database queries for the epoch briefly guessed a column name and returned an error before I read `kernel_private.release_epoch.epoch`; the activation row
   was verified separately, and the epoch itself was read live by the cutover script (3) before activation.
3. The 08:00Z scheduled fire has not yet run against release `4f6ac8c` at the time of writing. Its natural execution is the first
   canary fire under epoch 4; the alert monitor will report it.

## Residual risks

- Same-lineage independence (above). A reviewer can approve badly: it approved three faulty analyses in local testing, and the kernel's deterministic checks are
  what decided each time.
- A single mission can be rejected for a runtime's mistake; there is no automatic retry. FAILED with evidence is a valid outcome.
- The old shared OpenRouter key (fingerprint `77B191EE`) is still live in a different account; revoking it is outside this record.

## Result

**KJ-P3 FIRST LIVE AGENT MISSION: PASS.**
