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
4. **Actions variables**: `KJ_CLAUDE_CODE_VERSION` (an exact version), `KJ_CODER_MODEL` (a bare Anthropic
   model id; the worker's `KJ_CODE_CHANGE_CODER_MODEL` is the same id with `anthropic/` in front),
   `KJ_TEST_COMMAND` (for example `npm ci && npm test`), optionally `KJ_NODE_VERSION`.
5. **Actions secret** `KJ_CODER_ANTHROPIC_KEY`: a key from a dedicated Anthropic Console workspace with a
   monthly spend limit set in the Console. It is the only secret in the repository and is visible only to
   the `code` job. It has no access to anything but the model.
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
| Test pass for a different commit | Test run dispatched on the task branch; kernel requires `head_sha` equal to the proposed head |
| Overspend | Workspace spend limit, `--max-turns`, job timeouts, one run per task |
| Work on another repository | Allowlist in the client (refused before any request) and in reconciliation; token scoped to one repository |
