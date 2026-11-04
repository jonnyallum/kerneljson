# KernelJSON self-build target

Jonny ended the earlier phase freeze on 4 November 2026 and wants KernelJSON to build improvements to its own repository, converse through Telegram, and give Grok Bot working VM access.

The live `code-change/v1` mission completed a real pilot task on `jonnyallum/kj-pilot`: task `a638530b-2758-8756-ab70-1ffc95894a25` passed its coding and test workflows and opened draft PR #2. The production fix required Restate to register the worker's `CapabilityServiceV1` code-change handlers; see `CODE_CHANGE_ACTIVATION.md`.

This change installs the same coding and test workflows in `jonnyallum/kerneljson`. The repository's test variable should run `corepack pnpm install --frozen-lockfile && corepack pnpm typecheck && corepack pnpm test:unit`, with Node 22. The model runner needs the `KJ_CODER_OPENROUTER_KEY` GitHub Actions secret. The production worker needs a fine-grained GitHub token that reaches this repository with Actions read/write, Contents read, and Pull requests read/write, plus `jonnyallum/kerneljson` in `KJ_CODE_CHANGE_REPOS`. Do not put a broad user token on the VM as a shortcut. Values remain in GitHub Actions secrets and the existing secret broker, never in this repository.

After the workflows are on the default branch and the scoped credentials are configured, use one bounded `/change jonnyallum/kerneljson <instructions>` pilot. Prove the exact branch, test commit, independent review, draft PR, and ledger result. Then send a second task for the ordinary-language Telegram route. A pilot PR is reviewable code, not an automatic merge or deployment.

Grok Bot is on the same Windows PC under the same OS user as the verified GCP session. `new-system/AgentHub/keith-onboarding/Connect-KernelJSONVM.ps1` reached `kerneljson-prod-01` with that session. Grok Bot itself still needs to run the helper once to prove its own shell access.
