# ADR-0008: Deterministic policy and bound human approvals

Status: ACCEPTED

Deployment-owned rules match tenant, principal and exact capability version.
Unmatched requests are denied. The initial policy only authorizes the reviewed,
permission-free deterministic capabilities supported by Phase 6. A rule may
allow, deny or require a named human approver within the same tenant.

Decisions bind the invocation and capability descriptor digests, identities and
policy version. Approval resolution requires that exact scope digest and an
authenticated human identity obtained separately from the payload. The database
rechecks tenant membership and serializes resolution; the first valid terminal
decision wins. Expired requests cannot grant execution. Cancellation is recorded
as a denied approval with a cancellation reason.

Restate owns durable waits, deadlines and recovery. PostgreSQL atomically stores
policy/approval records and resolution evidence/events, never schedules work.
Existing schema suffices. The new gated workflow requires an injected identity
authenticator and is exercised on the private integration stack; production
registration awaits a real authentication boundary and the golden workflow.
Existing workflow versions and their journals remain unchanged.

An approval is permission to execute one bound invocation, not proof of task
completion. Capability execution still verifies its result; final task evidence
verification is the next phase. No model can register rules, resolve approvals
or supply its own authenticated identity.
