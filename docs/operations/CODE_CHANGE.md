# code-change/v1 (Mission #2)

Status: built (PR A core, PR B wiring, PR C activation prep), not deployed. Activation is a change window: [CODE_CHANGE_ACTIVATION.md](CODE_CHANGE_ACTIVATION.md).

## What it does

Jonny asks, from ChatGPT (`kj_run_code_change`) or Telegram (`/change owner/repo <instructions>`), for a bounded change to one allowlisted repository. KernelJSON:

1. reads the default branch head of the repository (the base) and tells Jonny it has started;
2. dispatches `kj-code-change.yml` in that repository: Claude Code makes the change with file tools only, and a
   separate job with no secrets pushes it to `kj/<task id>`;
3. dispatches `kj-test.yml` on that branch and waits for it to pass on exactly that commit;
4. captures the diff from GitHub and has the mission reviewer (a different model family) review it;
5. reconciles all of it (19 checks, `code-change-reconcile.ts`);
6. only if that accepts, opens a DRAFT pull request for exactly the reconciled commit and tells Jonny where it is.

Completion is re-verified by the ledger from persisted evidence, against the worker's own allowlist. Any
failure ends the task FAILED and Telegram says why. Nothing merges or deploys: the merge is Jonny's, in GitHub.

## Plan and evidence

Telegram accepts 10 to 2000 characters of instructions, including newlines. `/change` goes through the same
authenticated admission door and update-derived idempotency key as `/brief` and `/review`, and shares their daily
mission cap. The inbox records it as a mission and stores a digest of the command. The reply names the task and
repository without echoing the instructions. Worker configuration and repository allowlisting still decide whether
the mission can execute; admission is not a claim that a draft PR has been created.

| Step | Operation | Evidence source |
|---|---|---|
| 1 | `GITHUB_EVIDENCE` | `kerneljson:code-change-base/v1` (repo, default branch, base sha, instructions digest, coder model) |
| 2 | `CODE_RUN` | `kerneljson:code-change-run/v1` (the coding run as the Actions API reports it) |
| 3 | `CODE_TEST` | `kerneljson:code-change-capture/v1` (change facts, both runs, the diff text) |
| 4 | `RUNTIME_REVIEW` | `kerneljson:runtime/reviewer` |
| 5 | `RECONCILE` | `kerneljson:code-change-reconcile/v1` |
| 6 | `OPEN_DRAFT_PR` | `kerneljson:code-change-pr/v1` |

A cancel (`kj_cancel_task`) is checked before dispatching either workflow, before the paid review, before opening
the PR, and after each polling timer and run read. The task ends CANCELLED without further GitHub requests or a
review call. An already running GitHub workflow finishes on its own `kj/<task>` branch; cancellation does not stop
that external workflow. Polling normally observes a cancel within 30 seconds plus any in-flight service call.
Malformed run responses end the mission FAILED with a bounded error code, without persisting their raw content.

GitHub reads and explicit rate-limit refusals may retry. A network failure or server error during a write is
`WRITE_UNCERTAIN` and is terminal: GitHub may have accepted the request before the response was lost, and its
run listings may not show it yet. Inspect the task's Actions run and `kj/<task>` branch (and draft PR, if opening
one failed) before starting another mission. A FAILED task does not prove that no external workflow or PR exists.
Successful PR responses use the same 2 MB response limit as GitHub reads.

Publishing uses an explicit empty expected ref (`--force-with-lease=refs/heads/kj/<task>:`), so GitHub must still
have no task branch when accepting the push. Despite the option's name, it cannot replace or advance an existing
ref. This closes the fast-forward case that a plain push would allow if a duplicate run encounters a task branch.

## Worker configuration (all four or none)

| Variable | Value |
|---|---|
| `KJ_CODE_CHANGE_GITHUB_TOKEN` | fine-grained token, pilot repository only: Actions read/write, Contents read, Pull requests read/write. jVault `kerneljson/KJ_CODE_CHANGE_GITHUB_TOKEN` |
| `KJ_CODE_CHANGE_REPOS` | `jonnyallum/kj-pilot` |
| `KJ_CODE_CHANGE_CODER_MODEL` | the runner's OpenRouter model slug: `anthropic/claude-<id>`. Sent unchanged as the workflow's `coder_model` input; the same configured value is recorded in base evidence |
| `KJ_CODE_CHANGE_REVIEWER_MODEL` | the diff reviewer, a different family from the coder, for example `deepseek-v4-pro` (DeepSeek direct) or `x-ai/...` (OpenRouter) |

The reviewer is its own setting, not `MISSION_REVIEWER_MODEL`: the brief's reviewer is an Anthropic model, the
same family as the coder, and the brief keeps it. The code-change reviewer is served by the mission provider its
name selects (the same rule as the mission models), so that provider's key must already be set. Code-change also
needs the mission runtimes and the capability service (`KJ_REPO_ROOT`). A partial or inconsistent configuration
stops the worker at startup, which would stop the brief too, so the window checks the configuration in the new
image before it recreates the worker. The gateway and MCP releases must include `code-change/v1` in the door's
MCP scope (they do from PR B).

## Pilot repository

`jonnyallum/kj-pilot` (private, created 22/10/2026): a small text utility library with `node --test` tests, no
dependencies, no deploy integration. Setup (rulesets, Actions variables, the capped model key, workflow
installation) is in `infrastructure/github/README.md`.

## Limits

20 files, 800 changed lines, 100 KB of diff, 10 to 2000 characters of instructions. Refused paths: CI and
automation, infrastructure, secrets, billing, dependency manifests. Deletions are refused. Coding run up to 45
minutes of polling, test run up to 25.

## Known limitation

The coder model is attributed from configuration, not proven by the run: the coding job's Claude Code output is
not yet captured as evidence. The reviewer's model is proven (the provider's receipt).
