# KJ-P2.2B - Telegram activation blockers - code qualification

**Status: PASS (code qualification only). Not deployed. No Telegram token configured. No live message sent.**

Date: 2026-09-19. Precedes production activation under
`docs/operations/PHASE_KJ_P2.2A_TELEGRAM_PRODUCTION_ACTIVATION_RUNBOOK_2026-09-18.md`, which KJ-P2.2B rewrote.

## Canonical record

| Item | Value |
|---|---|
| PR | #34, squash-merged into `main` |
| Canonical merge SHA | `b3a6cb7101254145e05bc79f2cd601a606d3f97b` |
| Merge commit parent | `a7a6a7c9cecd45ff2fefd6fb2c0f86f5a81ac2e0` (KJ-P2.2, PR #33), single parent |
| Reviewed PR head | `8d6710f0105bb6dda8dea3e337b034751e3fc056` (merge was pinned to this head) |
| Tree of merge commit | `38aa87150a8cd222deac613209cf3ec699748b40`, identical to the reviewed head's tree |
| Scope | 20 files, file list identical to the reviewed PR; nothing unrelated landed |

Evidence tags: **OBSERVED** means Claude ran or read it in this session. **REPORTED** means it was
relayed by Jonny and Claude did not see the primary output.

## Review and CI

- PR CI, two `validate` checks on head `8d6710f`: pass (runs 35446029251 and 35446049271). OBSERVED.
- CI on the merge commit `b3a6cb7`, `Kernel qualification`: success (run 35446419762). OBSERVED.
- **Grokbot adversarial re-review: all five blockers CLEARED. REPORTED by Jonny.** GitHub shows no review or comment
  on the PR, so the primary Grokbot output is not in this repository. Attach it here if a durable copy is wanted.

## The five blockers and their fixes

| # | Blocker | Fix | Proof |
|---|---|---|---|
| 1 | Chat-ID discovery put the bot token in a shell command's URL (argv, shell history) | `pnpm telegram:discover-chat --token-file <path>` (`telegram-discover.ts`, `telegram-discover-cli.ts`). Token from a file only; URL built in-process and never logged; every error a fixed sentence, no cause chained; refuses a token-shaped argument; input file overwritten and deleted on success and failure. Runbook Step 4 rewritten; both unsafe doc lines removed | `tests/telegram-discover.test.ts` (11), incl. a hostile `fetch` that tries to leak the URL. `tests/docs-token-safety.test.ts` scans `docs/` and failed on the two old unsafe lines before the fix |
| 2 | D1 Stage 5 can regenerate `runtime.env` as `DATABASE_URL` only, silently turning the alert runner off | `scripts/runtime_env_merge.py` is the only sanctioned way the file changes: allow-listed keys, secrets from files, `--require-keys`, every other line copied byte for byte, independent `verify`, names and sha8 only, never overwrites. D1 Stage 5 forbidden in the runbook; running-container checks required after restart | `tests/runtime-env-merge.test.ts` (15), incl. refusal of a `DATABASE_URL`-only base and detection of tampering |
| 3 | `execution.compose.yaml` did not declare `ALERT_TRANSPORT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, so its explicit env allowlist dropped them and the worker stayed on console silently | Declared as `${VAR:-}` (empty defaults); `check-execution-topology.mjs` asserts them; the existing S1D2 inventory test now scans the transport sources | With `main`'s previous compose file the topology checker exits 1 naming all three and 5 guard tests fail; with the fix all 27 pass |
| 4 | POISON is silent after cutover | `pnpm alerts:outbox-gate --baseline-poison N` (`outbox-gate.ts`, `outbox-gate-cli.ts`): read-only; fails on new POISON (with error class), stuck SENDING, stuck PENDING, duplicate DELIVERED. Runbook gates at Steps 6, 8, 11, 12 and the final checklist | `tests/outbox-gate.test.ts` (9), a negative case per failure, plus a real-Postgres test that forces POISON and a duplicate |
| 5 | Test-notification mechanism undecided | `pnpm alerts:test-notification --label <id> --confirm-queue-one-test-notification` (`test-notification.ts`, `test-notification-cli.ts`): one P3 `NEW` intent, check ID `TEST.telegramActivationVerification`, built by `intentsFromDecisions` and enqueued through the outbox store only. No raw INSERT, no Telegram call, never delivers itself (the monitor's next tick does), disabled without the exact flag and a label, refuses unless `ALERT_TRANSPORT=telegram`. Same label queues nothing further | `tests/test-notification.test.ts` (11) and `tests/test-notification.integration.test.ts` (3): real Postgres, exactly one outbox row, every other table's row count unchanged |

## Post-merge qualification, from canonical `main` at `b3a6cb7` (OBSERVED)

Docker Desktop verified with `docker info` first; run with `DOCKER_CONTEXT=default` to satisfy CI's context guard.

| Gate | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm build` | exit 0 |
| `pnpm check:topology` | PASS |
| Focused suites (compose/env inventory, topology, transport config, Telegram notifier and HTTP, discover, doc guard, outbox model and gate, alert runner, alerting model, store selection, test-notification unit and integration, env merge) | 15 files, 283 passed, 0 failed, 0 skipped |
| `pnpm test:unit` | 23 files, 444 passed |
| Full regression `pnpm test` | 60 files passed, 10 skipped (70); **853 passed, 62 skipped**, 915 total |
| `pnpm test:baseline` | **224/224 retained**; recovery 31 (needs at least 27); 62 intentional env-gated skips |
| Validation stack teardown | clean, no `kerneljson-validation` container left |

The 62 skips are the same enumerated, env-gated integration tests `main` carried at `a7a6a7c`
(708 passed, 62 skipped). Local counts run four higher than CI's because this workstation holds four untracked
local docs that the doc guard also scans; they all pass.

## Reconfirmed on the merged blobs (OBSERVED)

- `execution.compose.yaml` lines 96 to 98 declare `ALERT_TRANSPORT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, each with an empty default.
- `scripts/runtime_env_merge.py` and its test are tracked; the runbook forbids D1 Stage 5 and requires `runtime_env_merge.py`.
- `test-notification.ts` builds its intent with `intentsFromDecisions` and enqueues through the outbox store; it contains no `insert into`, Telegram URL or `sendMessage`.
- The POISON hard gate is in the runbook (Steps 6, 8, 11, 12, checklist) and in tested code.
- `git grep` for a token-bearing Bot API URL across tracked `docs/` returns nothing, and the doc guard passes.

## What this record does NOT establish

- Nothing was deployed and production was not changed by KJ-P2.2B.
- **Live production health has not been verified.** Runbook Step 1 was attempted read-only over IAP SSH to
  `kerneljson-prod-01` and was denied by the session's permission classifier; no other route was tried.
  `gcloud compute instances list` shows the VM `RUNNING`. The pre-window baselines are still to be captured.
- The Telegram bot, token and chat ID do not exist yet: `kerneljson/TELEGRAM_BOT_TOKEN` and
  `kerneljson/TELEGRAM_CHAT_ID` are absent from jVault.
- `docs/production/D1_EXECUTION_PATH_DEPLOYMENT_RUNBOOK.md` is not on `main`. The rewritten runbook does not depend on it.

## Ready to activate: what is needed first

1. Jonny creates the bot and stores the token and chat ID (runbook Steps 2 to 4). Step 4 uses the new helper.
2. Read access to `kerneljson-prod-01` for the Step 1 baselines (the classifier denied it once; it needs Jonny's
   permission or Jonny running it).
3. Explicit authorisation of the activation window, and a separate explicit authorisation of Step 9 (the single test message).
4. One deploy SHA for worker, door and `activate_release`. `b3a6cb7` is the tested code commit; later `main`
   commits that only add docs do not change it. Use one value everywhere.

Residual risks, already in the runbook: a monitor tick between the deploy and `activate_release` can send the two
known release-parity P1s to the phone; and a crash between a Telegram send and its ACK can send one duplicate
message (at-least-once delivery), which the gate cannot detect.

## Result

**KJ-P2.2B CODE QUALIFICATION: PASS.**
