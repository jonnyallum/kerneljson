# Phase 7: Policy and approvals

Deployment-owned PolicyRules match tenant, principal and exact capability version.
Unmatched scopes are DENY. Explicit rules can ALLOW, DENY or require a named human
approver and deadline. This initial policy never enables external, permissioned
or high-risk capabilities, even if a rule says ALLOW. ADR-0008 records the scope.
Unsupported task constraints, budgets and deadlines also fail closed. Policy
evaluation occurs at COMPILED; authorization is required before entering READY.

Decisions bind the invocation, descriptor, task, step, tenant, principal, trace
and policy-version digests. ApprovalAnswer accepts only the scope digest and a
GRANTED/DENIED choice. Identity is provided by an injected authenticator outside
that payload. Neither prompts nor model results can supply rules or approver
identity.

ApprovalStore persists policy events and pending approvals atomically using the
existing schema. It checks persisted task/step binding and tenant membership.
Resolution locks the task and approval, rechecks the authenticated principal and
membership, uses the database clock for expiry, and atomically writes resolution,
evidence and an audit event. Identical retries return the existing decision;
the first valid terminal decision wins. Revoked reviewers cannot grant. A late
grant returns the already-recorded denial/expiry/cancellation decision.

Cancellation is restricted to the task owner and records DENIED with reason
CANCELLED. Expiration records EXPIRED with deterministic evidence. A human
decision records HUMAN_DECISION evidence. Approval evidence is authorization,
not task-completion evidence.

PolicyCapabilityWorkflowV1 submits a single uppercase capability invocation,
journals the policy evaluation, enters APPROVAL_REQUIRED when necessary, and
waits on a Restate durable promise with a durable timeout. After notification
or timeout it reads the authoritative approval decision. A grant permits the
capability call; denial, cancellation and expiry prevent it. Execution ends at
VERIFYING for the next evidence-verification phase, never COMPLETED on approval.

The factory requires an Authenticator and has no permissive default. The
production worker does not register it yet. Integration tests use explicitly
synthetic identities on the private validation stack. Production must supply a
real authentication boundary before exposing this workflow. Initial submission
identity is journaled so restarting a task does not depend on an old token still
being valid. Approval resolution always rechecks live tenant membership.

No new migrations, remote database calls, credentials, model calls or public
authorization endpoints are introduced. Existing workflow journals are unchanged.
Current approvals pin their original policy version; deploy changed rules under
a new version and cancel outstanding requests if that authority must be revoked.

Run `pnpm typecheck`, `pnpm build`, `pnpm test:unit` and the full Docker suite:

```powershell
$env:KERNELJSON_DOCKER_WSL = "Ubuntu"
pnpm test --reporter=default --reporter=json --outputFile=artifacts/local/phase7-tests.json
```

Tests cover rule matching, default deny, scope/identity injection, unsupported
capabilities, competing approval decisions, expiry, membership revocation and
worker/Restate restart while awaiting approval. STATE.yaml records executed
validation totals before progression to Phase 8.

Executed on 2026-09-05: **162 tests passed**, zero failures or skips, in 125.81
seconds. The final worker build also passed all four approval integration tests
in a targeted run (12 unrelated recovery cases intentionally not selected).
Reports: `artifacts/local/phase7-tests.json` and
`artifacts/local/phase7-final-recovery.json`. TypeScript and build passed.
