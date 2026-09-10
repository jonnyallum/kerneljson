# Phase 5: ModelPort and DeepSeek

Phase 5 adds a typed provider boundary in `packages/models/src`, contracts in
`packages/contracts/src/model.ts`, and `callModel` in
`services/kernel/src/models.ts`. See ADR-0006 for the architectural decision.

## Implemented boundary

- `ModelPort.generate` accepts task, step, call and trace IDs, text messages and
  an explicit output-token limit. Unknown fields, tool roles, empty prompts and
  oversized requests fail before any provider request.
- `createDeepSeekPort` uses one non-streaming HTTPS chat-completion request,
  disables thinking, refuses redirects and restricts responses to 1 MiB. The
  default timeout is 30 seconds, including response-body reading; callers may
  configure 10 ms–120 seconds and cancel through an AbortSignal. Deployment
  configuration chooses the model, credentials and timeout. Tasks cannot do so.
- The initial limits are 64 messages, 128,000 combined UTF-16 code units and
  8,192 output tokens. These are local safety bounds, not advertised provider
  context limits. There is no automatic retry, provider fallback or model loop.
- Responses require a single complete text choice and consistent token usage.
  Truncation, content filtering, tool calls, malformed responses and provider
  failures produce classified failures rather than successful text results.
- Receipts bind the normalized request and text digests to task/step/trace IDs,
  model, provider response ID and usage. Failures use fixed codes; response error
  bodies and exception details are discarded. Receipts omit prompts, generated
  text, credentials and reasoning. Failed calls may have incurred provider cost;
  absence of usage on a failure is not a claim of zero usage.

`validateModelResult` checks provenance and digests. It does not verify the
truth of an answer. Neither a model result nor its receipt is an Outcome,
PolicyDecision or proof that a task's acceptance criteria passed.

## Durable use

`callModel(ctx, port, request, record)` journals the provider result in one
`ctx.run`, then persists the receipt in a separate `ctx.run`. The supplied sink
must be idempotent by call ID and reject a different receipt under the same ID.
An existing MODEL_CALLED event can carry the receipt; no migration is needed.
Invalid provider contracts terminate the invocation with a sanitized error.

Successful and classified failed results are journaled. A retryable failure
flag is information for a future caller policy; it does not trigger a retry.
An explicitly authorized retry needs a new call ID. After a result is journaled,
receipt retries and recovery reuse it. A process failure before that journal
commit can repeat an already-accepted provider request and incur another charge.
Exactly-once inference is not claimed.

Full results, including prompt-derived text, can exist in a Restate journal.
Apply the runtime's access controls and retention policy before using sensitive
business data. Keep secrets out of prompts.

The production worker still serves only the existing deterministic TaskWorkflow
and KernelWorkflowV1. Model-backed recipes, capability execution and policy
authorization are later phases. The ModelProbeV1 workflow is registered only by
the Docker integration-test worker; it never creates a completed task outcome.

## Local validation

```powershell
pnpm typecheck
pnpm build
pnpm test:unit
$env:KERNELJSON_DOCKER_WSL = "Ubuntu"
pnpm test --reporter=default --reporter=json --outputFile=artifacts/local/phase5-tests.json
```

Model tests cover request/response contracts, substitute providers, digest
tampering, HTTP serialization, errors, timeouts during headers/body, cancellation
and redirect refusal. Two real Restate recovery scenarios simulate provider
success and rate limiting. Each crashes the worker after the receipt's SQL commit
but before acknowledgement, restarts Restate and the worker, and verifies one
provider invocation, one immutable MODEL_CALLED event and no task outcome.
Provider responses in these scenarios are mocks; they do not prove connectivity
to DeepSeek.

Executed on 2026-09-05, branch `codex/phase-5`: **109 tests passed**, zero failures
or skips. This includes 44 model contract/HTTP tests, 47 existing unit tests,
7 PostgreSQL tests and 11 real Restate recovery tests. Strict TypeScript and
the build passed. The combined run took 104.04 seconds; the JSON report is
`artifacts/local/phase5-tests.json`. The live smoke prerequisite check exited 2
before network I/O because runtime credentials were unavailable. A subsequent
live check passed using the user-supplied `.env` for vault project `kerneljson`.
The exact expected response matched; requested model `deepseek-chat` returned
model `deepseek-v4-flash`, with 17 input and 5 output tokens. The receipt records
`2026-09-05T16:46:00.814Z` in `artifacts/local/phase5-live-smoke.json`.

## Explicit live smoke check

Unlock jVault locally, then inject the `kerneljson` project's key into the child
process. Do not paste credentials into a shell command or chat. Select a model
available to the account explicitly; the library has no implicit model default.

```powershell
$env:JVAULT_PROJECT = "kerneljson"
$env:DEEPSEEK_MODEL = "deepseek-v4-flash"
jvault run --project kerneljson -- node --import tsx services/kernel/src/model-smoke.ts
```

This sends one fixed, non-sensitive prompt with a 16-token output limit. It saves
only the receipt and exact-response check in the ignored local file
`artifacts/local/phase5-live-smoke.json`. Synthetic IDs identify this isolated
connectivity check; it does not submit or complete a kernel task. The key is
read from DEEPSEEK_API_KEY. JVAULT_PROJECT identifies the intended secret source;
the application cannot independently attest how an environment variable was set.

`pnpm test:model:live` is an equivalent command after injection. Without the
required environment it exits 2 before making a request. Exit 1 indicates a
failed provider call or unexpected response; inspect the sanitized receipt.
Exit 0 requires both a valid provider result and the exact expected text.

The successful check loaded the existing, Git-ignored `.env` directly:

```powershell
node --env-file=.env --import tsx services/kernel/src/model-smoke.ts
```

No secret values were displayed or committed. No remote Supabase migration,
remote dry run or application deployment is part of this phase.

Provider behavior was checked against the official
[chat-completion API](https://api-docs.deepseek.com/api/create-chat-completion/)
and [error codes](https://api-docs.deepseek.com/quick_start/error_codes/)
on 2026-09-05. Model IDs are deployment configuration because the provider's
available models can change.
