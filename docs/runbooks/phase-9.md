# Phase 9: Golden end-to-end workflow

`createGoldenWorkflow(ledger, policyRules, authenticate)` constructs
`GoldenTaskWorkflowV1`. Submit a `KernelSubmission` for `uppercase/v1` using
the task ID returned by `compileIntent`. The workflow persists the intent and
compiled plan, evaluates deployment policy, durably awaits scoped approval when
required, executes the capability and finishes through `VerificationStore`.

The `approve` and `cancel` handlers use the same authentication and scope rules
as Phase 7. Cancellation is supported at the human approval gate. A completed
workflow exposes its immutable Outcome at `GET /restate/workflow/GoldenTaskWorkflowV1/{taskId}/attach`
(wait for completion) or `/output` (peek). Duplicate `run` submission returns 409
without executing again. See [Restate HTTP invocation](https://docs.restate.dev/services/invocation/http).
Restate ingress
must remain private behind the authenticated gateway; cached workflow results
are not an independently authenticated public API.

The validation worker injects synthetic identities only on the local Docker
network. Production registration is intentionally explicit: provide a trusted
authenticator and reviewed policy rules. No model call or remote deployment is
needed for this deterministic golden path.

Run `pnpm typecheck`, `pnpm build`, `pnpm test`. Recovery coverage restarts
Restate and the worker during approval, then crashes after the Outcome commits
but before acknowledgement. The final audit, run and Outcome remain unique.
Unsupported recipes and spoofed intent ownership are rejected before persistence.
