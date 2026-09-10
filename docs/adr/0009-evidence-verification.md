# ADR-0009: Persisted evidence governs completion

Status: ACCEPTED

Phase 8 introduces a deterministic verifier for the initial policy-gated uppercase
recipe. It reads persisted task/step contracts, capability runs and descriptors,
policy scope, approval evidence and result evidence. Approval is authorization;
only independently checked capability evidence supports acceptance criteria.

Verification requires exact task criteria, original input, completed step output,
capability/descriptor digests and policy provenance. Unsupported criteria or
missing/foreign/tampered evidence fail closed. There is no model adjudication.

A completion store takes the existing task transaction lock, verifies the database
snapshot, and atomically persists the terminal projection, verification audit and
Outcome. Retries return the immutable existing Outcome. Failed verification creates
FAILED, never COMPLETED. Existing TaskWorkflow/KernelWorkflowV1 verifiers remain
unchanged; integration into the new golden workflow is Phase 9.
