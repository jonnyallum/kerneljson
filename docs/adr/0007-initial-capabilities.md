# ADR-0007: Versioned deterministic capabilities

Status: ACCEPTED

Phase 6 adds a code-owned registry of exact capability ID/version pairs, input
and output schemas, implementations and independent verifiers. Initial built-ins
uppercase trimmed text and reverse Unicode code points. Registration rejects
duplicates, permissions, non-LOW risk and non-DETERMINISTIC implementations.
This is a bounded deployment allowlist, not Phase 7 policy authorization.

Calls belong to a task and step, carry trace IDs and an idempotency key, and
produce a verified result with request, output and descriptor digests. A verifier
must accept the schema-valid output before a successful result exists. Generated
text cannot register implementations or grant permissions. This registry is not
a sandbox: only reviewed, trusted application code may supply definitions.

Restate journals execution and owns recovery. A PostgreSQL receipt store checks
persisted task/step provenance and atomically inserts a capability run, evidence
and TOOL_CALLED event using the existing tables. Duplicate identical writes are
idempotent; conflicting keys fail. Persistence never transitions a task to
COMPLETED. The task's final acceptance criteria still need their own verifier.

Existing TaskWorkflow and KernelWorkflowV1 retain their journal sequences and
completion verifiers. A test-only workflow exercises the new durable boundary.
Production capability-backed recipes follow policy/approval integration; external
APIs, tools, sandboxing, model tool calls and autonomous execution remain disabled.
No migrations, new queues, secrets or remote deployment are required.
