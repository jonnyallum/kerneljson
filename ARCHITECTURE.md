# KernelJSON Architecture

## Constitutional invariants

1. A Task is the unit of work.
2. Every task has a durable identifier.
3. Every external side effect requires evidence.
4. No evidence means no COMPLETED state.
5. The model never grants its own permissions.
6. Secrets never enter source control.
7. External writes require idempotency.
8. Model and tool calls are traceable.
9. Execution must survive process failure.
10. Memory requires provenance.
11. Events are immutable.
12. Current state must be queryable.
13. Cognitive workers are ephemeral.
14. Self-modification requires evaluation.
15. External providers are replaceable.

## Core execution

Intent
→ Task Contract
→ Execution Graph
→ Policy
→ Capability Selection
→ Execution
→ Evidence
→ Verification
→ Outcome
→ Learning

## Six primitives

EVENT
TASK
CAPABILITY
STATE
POLICY
EVIDENCE
