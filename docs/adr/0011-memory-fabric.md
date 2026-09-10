# ADR-0011: Provenance-preserving result memory

Status: ACCEPTED

The initial memory fabric stores verified task results, not inferred universal
facts or instructions. Content is derived from a persisted completed Outcome;
the referenced non-human evidence must belong to that task and its Outcome.
Rows carry tenant, task, evidence, outcome digest, observation time and optional
expiry. Deterministic IDs make repeated writes idempotent; conflicting expiry
or provenance cannot overwrite history. SQL prevents mutation of memory rows.

The internal service accepts an authenticated principal/tenant context, rechecks
membership in its transaction, and never accepts identity from a model. Public
database roles remain denied. Retrieval uses bounded literal substring matching,
stable ordering and validity filters. No vector dependency is justified yet.
Memory is explicitly requested; it does not autonomously influence execution.
