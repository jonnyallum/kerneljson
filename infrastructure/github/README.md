# code-change/v1 pilot repository setup

These two workflows are templates for the ONE allowlisted pilot repository, `jonnyallum/kj-pilot`. Every
`uses:` is pinned to a full commit (the tests refuse a tag). The installed copies must stay byte-identical to
these files.

| File | Installed as | Dispatched by the kernel on | Holds |
|---|---|---|---|
| `kj-code-change.yml` | `.github/workflows/kj-code-change.yml` | the default branch | `code` job: model key, read token. `publish` job: write token, no secrets |
| `kj-test.yml` | `.github/workflows/kj-test.yml` | `kj/<task_id>` | read token, no secrets |

Both must be merged to the default branch by Jonny: the kernel dispatches the workflow files as they exist
there, and the model can never edit them (the `publish` job refuses any `.github/` path, and the kernel's
reconciliation refuses CI paths again).

## Repository settings (pilot repository only)

1. **Ruleset on the default branch**: require a pull request before merging, block force pushes and
   deletion, no bypass for GitHub Actions. This is what makes "no merge" hold even for a write token.
2. **Ruleset on `kj/**`**: block force pushes and deletion except by Jonny. Branches outside `kj/**` may
   be created only by Jonny (restrict creation, bypass for repository admins only).
3. **Actions, Workflow permissions**: read repository contents by default; do NOT allow GitHub Actions to
   create or approve pull requests.
4. **Actions variables**: `KJ_CLAUDE_CODE_VERSION` (an exact version), `KJ_TEST_COMMAND` (for example
   `npm ci && npm test`), optionally `KJ_NODE_VERSION`. The coder model comes from the kernel's required
   `coder_model` dispatch input, derived from `KJ_CODE_CHANGE_CODER_MODEL`, so it cannot drift from the worker's
   recorded setting. The old `KJ_CODER_MODEL` repository variable is ignored. Manual diagnostic dispatches must
   supply an `anthropic/claude-...` OpenRouter model slug; they still require the dedicated model key to run.
5. **Actions secret** `KJ_CODER_OPENROUTER_KEY`: a dedicated OpenRouter API key with a credit limit. It is the
   only secret in the repository and is visible only to the `code` job. Claude Code uses OpenRouter's Anthropic
   Messages endpoint (`ANTHROPIC_BASE_URL=https://openrouter.ai/api`) with the key in `ANTHROPIC_AUTH_TOKEN` and
   `ANTHROPIC_API_KEY` explicitly empty. No direct Anthropic account or key is needed. See the
   [OpenRouter Claude Code integration](https://openrouter.ai/docs/guides/coding-agents/claude-code-integration).
   Use a Claude model for this pilot; compatibility with other model families is not qualified. OpenRouter
   recommends the Anthropic first-party provider for Claude Code compatibility. Set this preference in the
   dedicated OpenRouter account/key routing configuration before the live pilot.
6. Every `uses:` is pinned to a full commit SHA (done in PR C; re-pin deliberately, never to a tag).

## The worker's token (kernel side)

A fine-grained personal access token restricted to the pilot repository with exactly:

- Actions: read and write (dispatch the two workflows, read runs)
- Contents: read (read refs and compare; it cannot push or merge)
- Pull requests: read and write (open the draft PR)
- Metadata: read (implicit)

Stored in jVault as `kerneljson/KJ_CODE_CHANGE_GITHUB_TOKEN` and given only to the execution worker. It
is not a production credential for anything else, and the runner workflows never see it.

## What stops what

| Risk | Stopped by |
|---|---|
| Change merged or deployed | Contents read on the kernel token (a merge needs Contents write), no merge call in the client, Actions cannot approve pull requests. No ruleset: GitHub refuses one on a private repository on the free plan |
| Model edits CI to escalate | `publish` refuses any `.github/` path, including a rename into or out of it; GitHub refuses a `GITHUB_TOKEN` push that creates or changes a workflow; reconciliation refuses CI paths. This matters because `kj-test` runs the workflow file on the task branch, so the branch must never carry its own |
| Model exfiltrates the key | No Bash or web tools in the `code` job; the key is spend-capped and model-only |
| Model plants git config that runs code (`core.fsmonitor`, hooks) | `.git` is moved outside the tree before the model runs and restored only if its fingerprint is unchanged and the model created no `.git`; `publish` applies with `git apply`, which refuses `.git/` paths |
| Repository agent settings start commands with the model key | The CLI loads no user/project/local settings, disables hooks and uses an explicit empty MCP configuration. `--tools` restricts built-ins to Read/Edit/Write/Glob/Grep; `--allowedTools` alone would only control approval prompts. Changes to `.claude/` and `.mcp.json` are refused before publication and by reconciliation |
| Test pass for a different commit | Test run dispatched on the task branch; kernel requires `head_sha` equal to the proposed head |
| Overspend | Dedicated OpenRouter key credit limit, `--max-turns`, job timeouts, task-scoped concurrency and no automatic retry after an ambiguous write failure. Dispatch is not an exactly-once API; a worker crash after GitHub accepts a request can still leave an external run to reconcile |
| Work on another repository | Allowlist in the client (refused before any request) and in reconciliation; token scoped to one repository |

The CLI isolation flags follow the [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
and [hook-disable guidance](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks). The pilot uses a fresh
GitHub-hosted runner; these flags are not a claim to override administrator-managed hooks on a custom runner.
