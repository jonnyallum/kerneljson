# KJ-P3.1.1 - Telegram mission completion after the reviewer-cap fix - RESULT

**Status: PASS**
**Window: 2026-09-20, 12:40Z to 13:07Z (about 19 hours before the next scheduled fire)**
**Fix: PR #39, merged as `e54107aab21b44755a34e84600defe501986ee5b`. Earlier record: `docs/operations/PHASE_KJ_P4A_TWO_WAY_TELEGRAM_LIVE_RESULT_2026-09-20.md`.**

Evidence tags: OBSERVED means read live in this window. INFERRED means reasoned, not run. REPORTED means relayed by Jonny.

## Summary

The KJ-P4A record was frozen FAILED-SAFELY only because the first Telegram-originated `/brief` hit the reviewer's 2048-token output cap. This window
fixed that cap and proved the one thing still missing: **a Telegram-originated mission completes end to end.** Jonny sent one `/brief`; the channel admitted
exactly one task through the door; DeepSeek analysed, Claude reviewed within the new 4096-token budget, the kernel reconciled and ACCEPTED, and the ledger
completed the task, in 34 seconds. One reply and one completion notice were delivered once each. The KJ-P4A channel is now proven functionally complete.

## Merge and release (OBSERVED)

| Item | Value |
|---|---|
| PR #39 head | `572abd8753782920af04fff0316aea47811e1560`, CI green on both runs, mergeable, on current `main` |
| **Merge SHA** | `e54107aab21b44755a34e84600defe501986ee5b` (squash, guarded on the exact head); parent `3ccea8a` |
| Tree check | merged tree `4589d38a97d46f6c7ffe76b48b2bad269d6fa715` identical to the reviewed head's; exactly three files changed (`prompts.ts`, one test file, one doc) |
| **Deployed SHA**, worker and door | `e54107aab21b44755a34e84600defe501986ee5b`; images `kerneljson-worker:e54107a` (`b7981040f301`), `kerneljson-admission-door:e54107a` (`c2c8834d7915`) |
| Previous release | `2229a698b86d75ad9aef7c064c2dcf0f0df21ed3`, epoch 6 |
| **New epoch** | **7**, request `d29a8d28-cc88-4ac4-b4aa-fcd34972a572`, previous release `2229a698...` |
| Epoch verification | fresh DB session (backend pid 1632945): exactly one epoch-7 row; release, previous release and request id as requested |
| Cutover | worker and door recreated 12:48:15Z to 12:48:41Z; `activate_release` returned epoch 7 at 12:48:49Z, after every pre-activation gate passed in the same script |

Precheck (read-only, 12:45Z): worker and door on `2229a69`, healthy, restarts 0; epoch 6; one Telegram poll chain (sequence 177), one alert monitor
(914), one scheduler driver; outbox gate PASS with POISON 0; all 12 tasks terminal (11 COMPLETED, 1 FAILED) so nothing in flight; counters 31
admissions, 9 fires, 32 bindings; one Telegram mission already counted toward today's cap; the running image still carried `REVIEWER_MAX_TOKENS = 2048`.

**Environment: exactly one key changed**, `KERNELJSON_RELEASE_ID`, independently verified. Every other key was unchanged by fingerprint (no Telegram,
OpenRouter, scheduler, alert or admission change). The activation script also refused to proceed unless the recreated worker's running image read
`REVIEWER_MAX_TOKENS = 4096`; it did. The candidate env files were shredded.

**The poll chain survived the deploy.** Its sequence went from 177 to 186 (never reset to 0), there was still exactly one `TelegramOperator` invocation, the
durable offset (`461282855`) and the earlier inbox rows were untouched, and the worker log shows Restate replaying the poll the restart interrupted.
That is a live confirmation of the replay-safe design.

## The one live Telegram mission (OBSERVED)

Jonny sent `/brief jonnyallum/kerneljson findings=3` once (REPORTED, and confirmed by the inbox). Nothing was sent or synthesized by the operator.

| Item | Value |
|---|---|
| Telegram update ID | `461282855` |
| Task ID | `c94ec75c-cc85-8338-a7ac-a1dda44da905` |
| Inbox claim | exactly one new claim since the deploy; DONE, ADMITTED, counted as a mission; stored digest equals the exact typed command (the text itself is not stored) |
| Admission | exactly one for this task and one binding; recipe `repo-analysis-mission/v1` |
| Source | **`kerneljson:channel/telegram/v1`**; principal and tenant equal to the door bearer's identity |
| Idempotency key | **`tg:upd:461282855`**; stored key digest equals the digest of that string; stored request digest equals the digest of the admitted request |
| Trace | `8c27a2ab-3aed-4fe8-a977-a6b394d85d5f` on both trace and correlation ids: the deterministic trace for this update |
| Objective and contract | `jonnyallum/kerneljson findings=3`; the kernel re-derives an exact contract of 3 |
| Telegram-sourced admissions in the ledger | exactly two in total: the earlier failed mission and this one |

### The mission (OBSERVED)

| Item | Value |
|---|---|
| Analyst | provider `deepseek`, `deepseek-flash` (requested and provider-reported the same): completed; 13,315 in and 1,378 out tokens |
| Reviewer | provider `openrouter`, requested and provider-reported `anthropic/claude-sonnet-5`: **completed**; 21,977 in and **2,303 out tokens** |
| Finish reason | not recorded on the model receipt. A response cut off by the cap ends the task with `OUTPUT_LIMIT`, and this one did not, so the stored answer is evidence it finished inside 4096 |
| Findings | **exactly 3**, with 23 citations in total (8, 7 and 8); three per-finding evidence digests recorded |
| Reconciliation | **ACCEPTED**, 13 of 13 checks; `crossProvider` true, `crossFamily` true |
| Final task status | **COMPLETED**: one outcome row, one `TASK_COMPLETED` event, no `TASK_FAILED`; four steps, four `STEP_COMPLETED` |
| Evidence rows | four, one per source: GitHub receipt `36fac02fe321`, analyst `cfe0bb446e95`, reviewer `17120c277213`, reconciliation `5c403e8ed8c4` |

The three findings' titles: (1) layered monorepo of contracts, kernel services, capabilities and durable execution; (2) a broad operational surface
across alerting, outbox, the Telegram channel, scheduler and health; (3) strong governance documents but code gaps and ambiguous ADR numbering.
They are grounded in cited repository evidence at the captured commit. As always, grounded is not proven true. Finding 3 is consistent with what was
observed in the ADR directory earlier (repeated numbers), but it has not been independently checked here.

### What the token number shows

**The reviewer used 2,303 output tokens, 255 above the old 2,048-token cap.** This same review would therefore have failed under the old limit. That turns
the cause recorded in KJ-P3.1.1 (inferred, because a length-limited response is not stored) into something observed: a Claude review of this size exceeds 2,048
tokens. It is 56 percent of the new budget, which is the headroom that was missing. One honest limit: the tightened reviewer prompt did **not**, by itself,
bring the answer under the old cap (2,303 is still above 2,048), and no comparison against the old prompt was run, so the prompt change's own effect is
unmeasured. The budget increase is what was demonstrably necessary. (INFERRED, not measured: the output count may include tokens the model spends before
the JSON, which the receipt does not break out.)

## Telegram delivery evidence (OBSERVED)

| Item | Result |
|---|---|
| Operator reply | exactly one row `OPERATOR.reply.461282855`, `DELIVERED`, `attempt_count` 1, exactly one delivery event (telegram, DELIVERED); claimed 13:04:53.668Z, delivered 13:04:54.020Z (352 ms) |
| Reply text | "Started a brief of jonnyallum/kerneljson: exactly 3 findings. Task c94ec75c-... Missions today: 2 of 5. Check progress with /task <id>. A notice arrives when it finishes." |
| Completion notice | exactly one `MISSION.repoAnalysis.c94ec75c.completed` (P3), queued at 13:05:27.965Z after the terminal commit, delivered 13:05:43.248Z by the monitor's next tick, `attempt_count` 1, exactly one delivery event |
| Duplicates | none: one reply and one notice |
| Phone | REPORTED by Jonny that he messaged the bot; delivery is confirmed in the outbox and delivery-event rows |

Timeline (UTC): claim 13:04:53.668, GitHub evidence 13:04:55.299, analyst 13:05:01.371, reviewer 13:05:27.715, reconciliation and outcome
13:05:27.863 and 13:05:27.965. **34 seconds from claim to completion.**

## Replay and safety (OBSERVED)

| Check | Result |
|---|---|
| The deployed adapter re-handles the SAME update against the real inbox, with a door that throws if called and a store whose write path throws | recognised as a duplicate: `duplicates` 1, `commands` 0, `admitted` 0 |
| The same idempotency key and body at the door | returned the SAME task id |
| Ledger counters before and after both probes | identical |
| Daily mission count | incremented once, from 1 to 2 of the cap of 5; the inbox counts exactly two missions today |
| Chains | exactly one `TelegramOperator` (sequence 235), one `ProductionAlertMonitor` (918), one `ScheduleDriver` |
| Scheduler | unaffected: fires still 9, the latest still the 2026-09-20 08:00Z fire |
| Outbox | 19 delivered, POISON 0, PENDING 0, no duplicate delivery |
| Runtime | worker, door and Restate healthy, restarts 0; no failed polls in the last 30 minutes |
| Alerts | only the known `legacyAuthority.b1FreezeObservable` P3 open |

The replay probe in-process is the only input the operator constructed; it is built so that it cannot write. It is a probe, not a command to Telegram.

### Counters before and after

| Counter | Before | After | Why |
|---|---|---|---|
| Task admissions | 31 | 32 | this mission |
| Schedule fires | 9 | 9 | unchanged |
| Execution bindings | 32 | 33 | this mission |
| Tasks | 12 | 13 | this mission (COMPLETED 12, FAILED 1) |
| Outbox rows | 15 | 19 | the operator reply, the completion notice, and the usual epoch-change pair (`authority.bindingReleaseConsistent` opened after activation and recovered on the first binding under epoch 7) |
| Missions counted today | 1 | 2 | this mission |

## Deviations and notes

1. The reviewer-cap fix is exactly the change proposed after the KJ-P4A freeze: 2048 to 4096 tokens plus a concise reviewer prompt. Nothing else was deployed.
2. **Not exercised live:** the `/task` command, the daily-cap refusal, the rate limit, and a real stranger. Those remain proven only by tests and the in-process check
   recorded in the KJ-P4A record.
3. The next scheduled fire, 2026-09-21T08:00Z, is the first canary fire on `e54107a` at epoch 7. `CLAUDE.md` is byte-identical across the releases, so it is INFERRED
   safe, but it has not been observed.
4. The rollback baselines were shredded after this record was written. A rollback now means rebuilding the environment with the merge tool; the previous images,
   including `2229a69`, remain on the host.

## Residual risks and follow-ups

- Grounding is still not truth (KJ-P3.1): a reviewer can approve a debatable finding.
- No automatic retry: a mission the kernel rejects ends FAILED with evidence. A future length overrun would fail the same way, though the 4,096 budget is now 78 percent
  above what this review used (44 percent of it was unused).
- The completion notice still arrives in the existing alert style, not as a templated reply.
- The next programme step is KJ-P4B (approvals through the existing policy-workflow control port).

## Result

**KJ-P3.1.1 TELEGRAM MISSION COMPLETION: PASS.** A Telegram-originated mission completed end to end after the reviewer-cap fix. KJ-P4A is functionally complete.
