# KJ-P3.1 - cross-provider live mission - RESULT

**Status: PASS**
**Window: 2026-09-20, 08:37Z to 09:07Z (well inside the 24 hours before the next scheduled fire at 2026-09-21T08:00Z)**
**Design: `docs/operations/KJ_P3_1_MISSION_QUALITY.md`. Code: PR #37, merged as `59d2dbd5d966e7db735a8fad6149c47eacbde17f`.**

Evidence tags: OBSERVED means read live in this window. INFERRED means reasoned, not run. REPORTED means relayed by Jonny.

## Summary

Production now runs the KJ-P3.1 mission contract. One real mission was admitted with `findings=3` against `jonnyallum/kerneljson`.
A DeepSeek analyst (direct) proposed exactly three findings, each bound to `{path, blobSha}` evidence at one captured commit, and a
Claude reviewer (through OpenRouter) approved them. The kernel reconciled the two deterministically, the ledger re-verified the
admitted contract from persisted evidence, and the task completed. It took about 30 seconds. One Telegram notice was delivered once.
A replay of the same request changed nothing. KernelJSON stayed the only task authority throughout.

## Release and deployment (OBSERVED)

| Item | Value |
|---|---|
| Deployed SHA, worker and door | `59d2dbd5d966e7db735a8fad6149c47eacbde17f`; tree identical to the qualified PR head (`d79020d...`) |
| Images | `kerneljson-worker:59d2dbd` (`632a9844bab9`), `kerneljson-admission-door:59d2dbd` (`b34622159f2e`), built on `kerneljson-prod-01` from the clean checkout |
| Previous release | `4f6ac8c9b7c80ccde5efb5bcbf77f12af5def70c`, epoch 4 |
| New epoch | **5**, request `3fb0599b-272c-4180-b5ca-96c84ee8a3e8`, previous release `4f6ac8c...` |
| Epoch verification | fresh DB session (backend pid 1615777): exactly one epoch-5 row; release, previous release and request id as requested; epoch 4 unchanged |
| Cutover | worker and door recreated 08:57:33Z to 08:58:06Z; `activate_release` returned epoch 5 at 08:58:06Z, after every pre-activation check passed in the same script |

Precondition gate before any change (read-only, 08:48Z): staged rollback files mode 600; live release `4f6ac8c` on worker and door;
epoch 4; counters 29 admissions, 9 fires, 30 bindings; nothing in flight; Docker daemon already healthy (not started or restarted);
restarts 0. The 2026-09-20 08:00Z scheduled fire had completed cleanly on `4f6ac8c` (fires 8 to 9, admitted, epoch unchanged).

Environment change, by the merge tool, independently verified: exactly three keys differ. `KERNELJSON_RELEASE_ID` changed;
`MISSION_REVIEWER_MODEL` changed to `anthropic/claude-sonnet-5`; `MISSION_OPENROUTER_API_KEY` was added (length 73, fingerprint
`ED3FC05A`). Every other key was `UNCHANGED` by fingerprint, including the alert runner settings, the Telegram bot credentials, the
scheduler and admission settings, the analyst model `deepseek-flash` and the DeepSeek key (length 35, `16031682`). The door changed
its release id only. Running containers after cutover: parity exact on both, restarts 0, every existing Restate service and handler
still registered, the monitor's sequence continuous (868). The staged key, candidate files and every temporary copy were shredded.

The OpenRouter key was found at `kerneljson/OPENROUTER_API_KEY` in the vault, not at the name the brief gave. It is in the KernelJSON
project, and its fingerprint is not the old shared key's (`77B191EE`). Before any deployment it was checked from a file: accepted by
the provider, account credit remaining 19.81, and one small call through the repo's own OpenRouter port answered as
`anthropic/claude-sonnet-5` (reported model identical). The key was moved to the VM by file only and never appeared in an argument
or in output.

## The mission (OBSERVED)

| Item | Value |
|---|---|
| Task ID | `d10442d5-f208-859d-af74-c4d16a9d379f` |
| Objective | `jonnyallum/kerneljson findings=3` plus the question: review the repository and identify the three highest-value concrete improvements to reliability or operational usefulness, every finding citing exact repository evidence |
| Admitted | once, at 09:00:09Z, through the production admission door |
| Captured GitHub head | `59d2dbd5d966e7db735a8fad6149c47eacbde17f`, 569 tree entries, not truncated, every entry carrying a git object id |
| Contract, re-derived from the task objective | exactly 3 findings (`requestedFindings` 3, min 3, max 3), schema `repo-analysis-findings/v2` |
| Findings returned | **3**, with 19 citations in total |
| Analyst | provider `deepseek`, requested `deepseek-flash`, provider-reported `deepseek-flash`; 12,701 in and 1,384 out tokens |
| Reviewer | provider `openrouter`, requested `anthropic/claude-sonnet-5`, provider-reported `anthropic/claude-sonnet-5`; 20,967 in and 1,529 out tokens |
| Independence recorded | `crossProvider` **true**, `crossFamily` **true** (families `deepseek` and `anthropic`) |
| Reviewer verdict | `approve`, no unsupported findings, echoed digest equal to the analysis digest |
| Reconciliation | **ACCEPTED**, all thirteen checks passed |
| Final task status | **COMPLETED**, one outcome row citing four evidence rows |

Model identity through a router is **provider-reported, not cryptographically proven**, and the record says so. The reviewer's
call cost roughly six US cents at list price (INFERRED from the published per-million rates).

### Independent verification (OBSERVED)

These were recomputed from persisted rows with separate code, not by trusting the kernel's own verifier: the contract re-derived from
the immutable task objective equals the reconciliation's; exactly 3 findings; every finding has `{path, blobSha}` evidence; every
`blobSha` resolves against the captured commit's tree (19 of 19, none unresolved); the analysis names the captured head; the three
`findingEvidenceDigests` equal an independent recomputation over head, path and full object id (`ba1949394025`, `77c1dfb9ea12`,
`0772adf3d894`); the analysis and review texts hash to their recorded digests; the analyst evidence binds to the GitHub digest and the
reviewer evidence to the analysis digest; the task was bound at release `59d2dbd` in epoch 5; no secret-looking string appears in any
evidence row. The ledger's own completion backstop also re-derived the admitted contract, which is why the task could complete.

### Evidence rows (four, one per source, no duplicates)

| Type | Source | Digest (first 12) |
|---|---|---|
| TOOL_RECEIPT | `kerneljson:github-read/v1` | `b5659f038ad1` |
| ARTIFACT | `kerneljson:runtime/analyst` | `c6696675c1a0` |
| ARTIFACT | `kerneljson:runtime/reviewer` | `ab257e3d00d1` |
| DETERMINISTIC_RESULT | `kerneljson:mission-reconcile/v1` | `3719df9efdde` |

Events: one each of `TASK_CREATED`, `INTENT_RESOLVED`, `PLAN_COMPILED`, `TASK_READY`, `TASK_STARTED`, `TASK_VERIFYING` and
`TASK_COMPLETED`; four each of `STEP_STARTED` and `STEP_COMPLETED`.

## What the mission produced, and how far to trust it

1. **Empty stub modules create a false impression of shipped policy, telemetry and worker runtimes.** Five `index.ts` files
   (`services/policy`, `packages/telemetry`, `runtimes/worker`, `runtimes/sandbox`, `packages/config`) cited with the empty-blob
   object id `e69de29`. **Spot-checked true** against the repository at `59d2dbd`: all five are the empty blob. Here object-id
   binding proved something real, because the id itself is the evidence.
2. **CI coverage appears thinner than the operational and qualification machinery it must protect.** The workflow files it names do
   exist (two workflows plus a `.gitkeep`). **The judgement itself is disputable:** `qualification.yml` runs typecheck, lint, the
   full test suite, the protected-baseline gate and the build. The analyst saw paths and object ids only, not file contents, so it
   could not have supported "thin", and the reviewer approved it anyway.
3. **Alerting store, notifier and runner selection is spread across many modules, raising misconfiguration risk.** Seven citations,
   all resolving. A design opinion, not a checkable fact.

This is the boundary of what KJ-P3.1 claims. The kernel proves each finding is **grounded in this exact repository evidence at this
exact commit**. It does not prove a finding is true, and finding 2 shows the gap: it is grounded and approved, and I would not act
on it without reading the workflow. The natural next hardening is excerpt-level grounding (capture file content before analysis so a
quoted line can be verified), which was out of scope here and has not been started.

## Telegram (OBSERVED)

| Check | Result |
|---|---|
| Outbox row | `MISSION.repoAnalysis.d10442d5.completed`, kind NEW, severity P3, created 09:00:39Z (after the terminal commit) |
| Delivery | `DELIVERED` at 09:05:28Z by the monitor's next natural tick, `attempt_count` 1, no error |
| Delivery events for this notice | exactly 1 (`telegram`, `DELIVERED`) |
| Outbox totals | 9 delivered before, 10 after; the one new row is this mission's; POISON 0, no duplicate delivered |
| Phone receipt | not confirmed by Jonny in this session |

No alert opened during the epoch change: only the known `legacyAuthority.b1FreezeObservable` P3 is open, and the release-parity and
binding-consistency alerts stayed `RECOVERED`.

## Replay and safety (OBSERVED)

The identical request (same label, same `findings=3`, same question) was re-admitted at 09:06Z.

| Check | Before replay | After replay |
|---|---|---|
| Task returned | | the same `d10442d5-...`, status `COMPLETED` |
| Admissions / fires / bindings | 30 / 9 / 31 | 30 / 9 / 31 |
| Mission tasks | 2 | 2 |
| Evidence rows for the task | 4 | 4 |
| Outcome rows / `TASK_COMPLETED` events | 1 / 1 | 1 / 1 |
| Notices / delivery events for the task | 1 / 1 | 1 / 1 |
| All notices | 10 | 10 |

Counters across the whole window: admissions 29 to 30, bindings 30 to 31 (the mission's own task), **schedule fires unchanged at 9**.
Outbox gate PASS with POISON 0. Worker, door and Restate healthy with restarts 0; one `ProductionAlertMonitor` chain and one
`ScheduleDriver`. Nothing else in the estate was touched.

## Deviations and notes

1. The first attempt to build the images on the production VM was denied by the session's action classifier. Jonny then authorised
   this specific build and deploy window in writing, limited to `59d2dbd`, the KernelJSON worker and door, and no Docker daemon
   lifecycle changes. Nothing was worked around, and the boundary on the Docker lifecycle was kept.
2. My first copy of the key to the VM failed (the Windows copy tool does not expand `~`) and my script staged an **empty** file. No
   secret was exposed: the landing file was empty and the local copy was shredded. The script now uses an absolute path, stops if the
   copy fails, and refuses and deletes any staged key that is not length 73 with the expected fingerprint.
3. My presence probe reported the empty OpenRouter variable as `SET` (`printenv` succeeds for an empty value). Confirmed by length
   (0) that nothing diverged; later checks used lengths and fingerprints.
4. Two local scripting slips (a nested heredoc, and a scratch script treated as CommonJS) cost nothing and touched no live state.
5. **Rollback baselines were shredded at close, as instructed, so a rollback now means rebuilding the environment** with the merge
   tool (set the release id and reviewer model back, drop the OpenRouter key). The previous images, including `4f6ac8c`, are still on
   the host.

## Residual risks and follow-ups

- Grounding is not truth (above). A reviewer can approve badly, and here it approved a debatable finding.
- No automatic retry: a rejected mission ends FAILED with evidence.
- The old shared OpenRouter key `77B191EE` is still live in another account; revoking it is outside this record.
- The vault entry is named `kerneljson/OPENROUTER_API_KEY`, not `MISSION_OPENROUTER_API_KEY`; the running variable is correct.
- The next scheduled fire, 2026-09-21T08:00Z, is the first canary fire on `59d2dbd` at epoch 5. INFERRED safe: `CLAUDE.md` is
  byte-identical between `4f6ac8c` and `59d2dbd`, so the canary's approved digest is unaffected. Its outcome is not yet observed.

## Result

**KJ-P3.1 CROSS-PROVIDER LIVE MISSION: PASS.**
