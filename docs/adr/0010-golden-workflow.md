# ADR-0010: Versioned golden workflow

Status: ACCEPTED

GoldenTaskWorkflowV1 composes the existing compiler, single-step uppercase plan,
policy, durable approval, capability receipt and persisted evidence verifier.
Its journal is separate from the earlier workflow versions. Deployment injects
the authenticator and policy configuration; submission cannot configure either.
The terminal Outcome commit is journaled and safe to retry after acknowledgement
loss. Authentication is required for submission and approval/cancellation.

The initial golden workflow remains deliberately deterministic and supports only
uppercase/v1. It proves the complete execution chain without unnecessary model
calls. Production registration requires an operator-supplied identity boundary;
synthetic test tokens are confined to the local validation worker.
