# code-change/v1: activation window

Mission #2 ([CODE_CHANGE.md](CODE_CHANGE.md)). Release from main after PR #62, PR #63 and this PR merge, epoch 16 to
17. Same pattern as the operator MCP window ([OPERATOR_MCP_DEPLOY_CHECKLIST.md](OPERATOR_MCP_DEPLOY_CHECKLIST.md)).

**Needs Jonny's approval for one window**, clear of the 06:00Z brief and 08:00Z canary wakes. About 30 minutes.
No step changes a schedule, the canary, Phase 8.1, the brief's models or the MCP registration setting. Every step
names its expected result; anything else means stop and roll back from that step.

```
Z="--zone=europe-west2-b --project=project-c407f628-c71c-45fa-994 --account=kerneljson@gmail.com --tunnel-through-iap"
VM=kerneljson-prod-01
SHA=<main merge commit containing this PR, 40 hex>     SHORT=${SHA:0:7}
SC="python -I C:\Users\jonny\Desktop\new-system\AgentHub\scripts\secretctl.py"
```

## Done already (no production change)

| What | State |
|---|---|
| `jonnyallum/kj-pilot` | private, `node --test`, no deploy path |
| Workflows | `kj-test.yml` on `main` is byte-identical to `infrastructure/github/`. `kj-code-change.yml` is one change behind (the git-metadata guard): jonnyallum/kj-pilot#1 brings it level (sha256 `6b7aad16b8ed…`). `code-change-config-check.ts` re-proves both in the window and fails until kj-pilot#1 is merged |
| Actions policy | GitHub-owned actions only, SHA pinning required, workflow token read-only by default, Actions cannot approve pull requests |
| Variables | `KJ_CLAUDE_CODE_VERSION=2.1.296`, `KJ_CODER_MODEL=claude-sonnet-5-5`, `KJ_TEST_COMMAND=npm test`, `KJ_NODE_VERSION=22` |
| Dry runs, no key | `kj-test` on `main` refused at "Validate the ref". `kj-code-change` validated, checked out, set up Node 22, installed and version-checked Claude Code, then stopped at "Make the change" with `is_error: true`, cost 0 |

## Jonny, before the window

| # | Do | Expect |
|---|---|---|
| J1 | Anthropic Console: a new workspace (for example `kj-pilot-coder`) with a monthly spend limit, and an API key in it. Then in a terminal: `gh secret set KJ_CODER_ANTHROPIC_KEY -R jonnyallum/kj-pilot` and paste the key at the hidden prompt | `gh secret list -R jonnyallum/kj-pilot` lists `KJ_CODER_ANTHROPIC_KEY`. The key exists only in that workspace and that secret |
| J2 | GitHub, fine-grained token: owner `jonnyallum`, only `kj-pilot`; Actions read and write, Contents read, Pull requests read and write (Metadata read is automatic); 90-day expiry. Save it in jVault as `kerneljson/KJ_CODE_CHANGE_GITHUB_TOKEN` | `$SC check kerneljson/KJ_CODE_CHANGE_GITHUB_TOKEN` reports length 93 |
| J3 | Main branch protection for `kj-pilot` (see "Rulesets" below) | Decided and recorded here |
| J4 | Merge jonnyallum/kj-pilot#1. Then merge #62, then #63 (its base becomes `main`), then this PR. #61 and #65 are already in `main`, so the release keeps the Grok Bot MCP code | `gh run list --commit $SHA` shows `validate` succeeded |

## Rulesets

GitHub refuses rulesets and branch protection on a private repository on the free plan (HTTP 403, "Upgrade to
GitHub Pro or make this repository public"). Without them, `main` is still protected by construction: the kernel's
token has Contents read only, the only write token is the `publish` job's, whose push target is fixed in the
workflow on `main` to `kj/<task>`, and the model's patch cannot touch `.github/`. What a ruleset adds is defence in
depth against a mistake in that construction. The options are GitHub Pro, making `kj-pilot` public (the run inputs,
including the instructions, become public), or accepting the construction alone for the pilot.

## Before the window (Claude, laptop side)

| # | Do | Expect |
|---|---|---|
| P1 | `git bundle create cc.bundle kj-release-$SHORT` from a branch at `$SHA`, then `gcloud compute scp cc.bundle cc-prep.sh cc-deploy.sh activate-cc.js ${VM}:/tmp/kjwin/ $Z` | Files in `/tmp/kjwin` |
| P2 | `$SC get kerneljson/KJ_CODE_CHANGE_GITHUB_TOKEN --out kjcc.token --expect-len 93`, `gcloud compute scp kjcc.token ${VM}:/tmp/kjwin/ $Z`, `$SC shred kjcc.token`, then on the VM `chmod 600 /tmp/kjwin/kjcc.token` | Length printed, never the value. Nothing left on the laptop |
| P3 | `sudo bash /tmp/kjwin/cc-prep.sh $SHA` | Worker env verify: changed exactly `KERNELJSON_RELEASE_ID,EXPECTED_RELEASE_ID` and the four `KJ_CODE_CHANGE_*`. Door: `KERNELJSON_RELEASE_ID` only. MCP `public.env`: `KERNELJSON_RELEASE_ID` only, registration unchanged. Rollback copies equal live. Config check on the live env prints `CC_CONFIG NOT_CONFIGURED` (the check failing on purpose), then on the staged env every line `PASS`, including `token does NOT reach jonnyallum/kerneljson (HTTP 404)` and both workflows equal to the templates, and `CC_CONFIG OK`. Token file shredded. `PREP OK $SHORT` |

## The window

| # | Do (on the VM) | Expect |
|---|---|---|
| 1 | Baseline, read only: `morning-check.js`, `counts.js` | Epoch 16, release `c5de3f5`, nonterminal 0, brief and canary wakes armed |
| 2 | `sudo bash /tmp/kjwin/cc-deploy.sh $SHA` | Worker healthy with `brief_reviewer=anthropic/claude-sonnet-5` unchanged and the code-change values from P3. `ACTIVATED {"epoch":17,...}`. Door healthy, door check all `PASS` then `MCP_DOOR OK`. `kerneljson-mcp` healthy on `kerneljson-admission-door:$SHORT` with registration as before. `DEPLOY OK $SHORT` |
| 3 | Release checks (`smoke-check.js`) and `morning-check.js` | HEALTHY at epoch 17. Brief and canary wakes still armed. Restate and n8n container IDs unchanged |
| 4 | ChatGPT (web), new chat with KernelJSON: "Check KernelJSON's health" | Epoch 17, `doorMatchesActive: true`. The tool list includes `kj_run_code_change` (a refreshed connector may be needed to see it) |

## First pilot run

| # | Do | Expect |
|---|---|---|
| 5 | ChatGPT: "Use kj_run_code_change with repo `jonnyallum/kj-pilot` and these instructions: Add an exported function `slugify(text)` to `src/text.js`. It lowercases the text, replaces every run of characters that are not a-z or 0-9 with a single hyphen, and removes hyphens from both ends, so an empty or all-punctuation string gives an empty string. Add tests in `test/text.test.js` covering spaces, punctuation, repeated separators, mixed case and empty input. Change no other file." | A task id. Telegram: started. The objective is admissible: an allowlisted slug and 10 to 2000 characters of instructions |
| 6 | Follow it (`kj_get_task`, or the Actions tab) | `kj:<task> code` succeeds, `kj/<task>` exists, `kj:<task> test` passes on that commit, then COMPLETED. Telegram: draft PR opened, with the link |
| 7 | Read the draft PR | Draft, from `kj/<task>` into `main`, one bot commit, only `src/text.js` and `test/text.test.js` changed. The three existing tests still pass, plus new ones equivalent to: `"Hello World"` gives `hello-world`, `"Hello, World!"` gives `hello-world`, `"a -- b__c"` gives `a-b-c`, `"MiXeD CaSe"` gives `mixed-case`, `""` gives `""`. Nothing merged. Merge or close it yourself |
| 8 | On the VM, the task's evidence | Six rows, one per source in CODE_CHANGE.md, and the ledger's COMPLETED (it re-verified the whole chain) |

A FAILED first run is a result, not an incident: Telegram says why, nothing is merged or deployed, and the brief is
unaffected. Record it and fix forward.

## Rollback

| # | Do | Expect |
|---|---|---|
| R1 | Recipe off, release kept. Install `$RB/worker.before.env` with `KERNELJSON_RELEASE_ID` and `EXPECTED_RELEASE_ID` moved to `$SHA` (merge tool, `--set-public`), recreate the worker on `kerneljson-worker:$SHORT` | The worker starts without the code-change keys; `code-change/v1` submissions fail at the kernel as not served. No new epoch: same release |
| R2 | Token. Revoke the fine-grained token in GitHub | Any running task fails at its next GitHub call and says so on Telegram |
| R3 | Release, only if the door or worker misbehave. Back to `c5de3f5` under RELEASE_PROVENANCE.md: stop the door, install `worker.before.env`, recreate the worker on `kerneljson-worker:c5de3f5`, activate `c5de3f5` as epoch 18 (new request UUID), install `door.before.env`, recreate the door on `kerneljson-admission-door:c5de3f5`, install `mcp.public.before.env` and recreate `kerneljson-mcp` on the same image | Release checks HEALTHY on `c5de3f5`, epoch 18 |

`$RB` is `/opt/kerneljson/runtime/cc-$SHORT`.
