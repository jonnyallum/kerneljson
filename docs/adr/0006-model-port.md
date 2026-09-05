# ADR-0006: Task-scoped ModelPort

Status: ACCEPTED

Phase 5 introduces a provider-independent, typed ModelPort and a DeepSeek HTTP
adapter. This follows the user's instruction to proceed to Phase 5 in BUILD_PLAN;
the earlier exclusion of DeepSeek applied to Phases 1–4.

Every request carries task, step, call and trace identifiers. Deployment code
selects the provider/model and injects credentials from jVault project kerneljson.
Prompts cannot select endpoints, credentials, tools or permissions. The initial
port supports bounded, non-streaming text generation. Structured interpretation,
tool calling, routing and model-generated execution plans remain later work.

Results contain untrusted text and a receipt, never task status or permission
decisions. Receipts record digests, provider response identity, token usage and
sanitized failure codes without prompt text, reasoning or credentials. A receipt
proves a model interaction, not the truth of its output or task completion.

The adapter makes one HTTP attempt, with a timeout and bounded response size.
It returns classified failures without an internal retry loop. Restate owns
durability: the kernel helper journals the result before recording its receipt
through an idempotent sink. Retrying receipt persistence must not repeat a
journaled provider call. An interrupted provider request before journal commit
can still be billed twice if replayed; no provider idempotency guarantee is
assumed and this phase does not claim exactly-once inference.

TaskWorkflow and KernelWorkflowV1 retain their existing deterministic plans and
journal sequences. The new helper is exercised by an integration-only workflow;
production model-backed recipes await the capability and policy phases. Existing
MODEL_CALLED events can hold receipts; no database migration is needed.
