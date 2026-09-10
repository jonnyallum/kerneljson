# ADR-0017: Trusted execution binding and current authority

Status: ACCEPTED

Gate 1 adds an immutable task execution binding, independent of the Task's business contract. It records tenant/principal, exact service and version, deployment release identity, workflow key, creation time, supported controls and trusted routing identity. Deployment code chooses these values. Public schemas never accept service, handler, endpoint, principal or tenant authority fields.

An admission may durably reserve a binding before the worker's task projection exists. This is a receipt for a client submission, not a queue: only the request handler invokes Restate, and retries address the same workflow key. There is no SQL poller or scheduler. A gateway dispatch timeout is UNRESOLVED, not task failure; an equivalent retry safely resubmits to the same key. The Task projection and immutable binding are cross-checked when execution starts. Existing records are not backfilled with guessed service identities; they remain readable and unsupported controls fail explicitly.

Each service factory attaches its own identity inside the existing ledger write transaction. This adds no Restate journal commands to existing workflows. Production processes must supply a build/release identity; local tests may use an explicitly marked development identity. Old bindings retain their release and routing identity when later compatible deployments execute replay; trusted deployment routing must retain old endpoints where necessary.

Tenant membership has ACTIVE, REVOKED and REMOVED (tombstone) states. Historical foreign keys remain intact. Authorization checks current status and a code-owned role/action matrix, never only a historical actor identifier. A tenant operator role does not grant infrastructure administration. Lifecycle changes retain an immutable audit record.

FAILED and CANCELLED transitions persist an immutable terminal-result record with the Outcome shape, even when a legacy workflow omits an outcomes row. Public reads prefer an explicit Outcome, otherwise this durable terminal record. This preserves the Phase 15 tests which explicitly assert no happy-path outcomes row after schedule cancellation. Permanent verification rejection is a FAILED Outcome, distinct from transient infrastructure retry. An uncertain effect/dispatch is explicitly UNRESOLVED and cannot support COMPLETED. No exactly-once claim extends beyond KernelJSON's transaction and Restate idempotency boundaries. Current pure capabilities introduce no external writes.

Controls resolve from the persisted binding and a deployment-owned service catalogue. Legacy workflows remain internal; the public gateway authenticates and checks membership/policy before forwarding. No network exposure or deployment is performed by Gate 1.

Completion hardening retains the existing Restate operation names and order. New completions journal the verified terminal Outcome inside the existing completion operation; replay of an older void completion result retains the original compatible return value. Only pure verification rejection becomes FAILED. Database transport errors and unresolved-effect errors propagate for retry; a connection failure must never manufacture a terminal result.
