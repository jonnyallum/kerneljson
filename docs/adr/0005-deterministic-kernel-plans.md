# ADR-0005: Deterministic kernel plans

Status: ACCEPTED

Phase 4 implements the compiler, planner and executor using explicit, versioned
recipes. It does not infer executable actions from natural-language text.
Intent text is literal input; attachments and context references are rejected
until a supported resolver exists. Identity comes from the trusted internal
caller, never from a model. Compilation preserves intent/trace provenance.

An ExecutionPlan is a validated DAG with task-owned step IDs, dependency-bound
inputs and a declared result step. The planner emits stable IDs and a stable
topological order. The executor accepts only built-in deterministic operations
and a durable event wait. Execution is sequential in topological order for this
phase; graph dependencies do not imply a second scheduler or queue.

The immutable PLAN_COMPILED event stores the complete plan and its digest;
task_steps stores queryable projections. Existing tables suffice. Restate owns
execution and journal recovery. Completion recomputes the recipe independently
and checks the stored plan, persisted steps and task-bound evidence.

A separately named KernelWorkflowV1 executes Phase 4 plans. TaskWorkflow remains
available with its original journal sequence so this refactor cannot invalidate
already-running Phase 3 executions. Existing task IDs cannot be reused across
the workflows because the ledger rejects conflicting creation writes.

This decision extends the implementation without changing ADRs 0001–0004.
Model planning, arbitrary graph submission, external capabilities, public
authorization, autonomous scheduling and remote migrations remain out of scope.
