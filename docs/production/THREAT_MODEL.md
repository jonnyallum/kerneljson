# Gate 1 threat model

Status: implementation contract for post-Phase-15 qualification. Baseline 705a1af5c9ac882d590dfa3ef37fd04f385f2f00. No deployment authorization.

## Assets and invariants

Protect task/evidence integrity, historical actor attribution, tenant confidentiality, current authority, execution identity and secrets. A Task remains the primitive. Restate owns execution. SQL records binding/provenance; it does not dispatch work. No model output grants authority. COMPLETED requires independent task-bound verification.

## Trust boundaries

| Boundary | Trusted responsibility | Untrusted input / enforcement |
| --- | --- | --- |
| Human user | Intent and explicit consent | Browser/body identifiers are claims, not identity. |
| Authenticated principal | Authenticator resolves a HUMAN or SERVICE identity | Gateway rejects invalid authentication; never accepts identity from task JSON. |
| Tenant | Authentication establishes a selected tenant context | Current active membership and action permission checked at each operation. |
| Service identity | Narrow runtime purpose and membership | No implicit operator or human-approval authority. |
| Gateway | Schema, identity, admission, durable submission and status | Strict body, size bounds, idempotency identity; no arbitrary workflow or URL. |
| Mission Control | Tenant-filtered read views and scoped controls | Browser is untrusted; origin/CSRF controls, escaping, bound control routing. |
| Kernel | Deterministic policy, execution and verification | Only reviewed deployment catalogues; no user-defined permissions. |
| Restate | Durable invocation/journal/state | Internal ingress/admin stay private; gateway authenticates callers before forwarding. |
| PostgreSQL/Supabase | Constraints, transactions, immutable audit | API roles remain denied; backend credentials are privileged and must not reach users. |
| Capability runtime | Reviewed pure implementations | Gate 1 adds no external writes or arbitrary code; inputs/results independently validated. |
| Model provider | Untrusted text plus interaction receipt | Existing adapter only; no new model exposure or permissions; uncertain requests may have run. |
| Sandbox | Required boundary for future untrusted execution | Not implemented or enabled. Shell/filesystem execution stays unavailable. |
| jVault | Runtime secret source, project kerneljson | No secrets in repository, payloads, evidence or logs; deployment injection remains separately scoped. |
| External integrations | Future bounded adapters | Not enabled by this gate; catalogue manifests do not establish runtime authority. |
| Operator/admin | Explicit out-of-band recovery and database administration | Not inferred from tenant role; admin endpoints private; interventions require attribution and review. |

## Threats and mitigations

| Threat | Required mitigation and test |
| --- | --- |
| Cross-tenant task/evidence/history/knowledge access | Derive tenant from authenticator; scope every query and command; foreign IDs return no data and trigger no transport. |
| Spoofed principal/tenant/service identifiers | Strict public contracts omit authority fields; mismatches and unknown fields rejected. |
| Stale/revoked/removed membership | Membership tombstone retains provenance; active status and action permissions checked on every new request. No JWT-only membership authority. |
| Privilege escalation/model self-authorization | Allowlisted role/action matrix and deployment-only workflow catalogue; service principals cannot grant human approval or create human schedules. |
| Operator privilege | No public admin bypass; database operators remain trusted infrastructure, outside tenant API. Formal production credential isolation remains a deployment gate. |
| Compromised capability | Current registry accepts reviewed pure functions only; no dynamic module/MCP loading. A fully compromised kernel/DB owner is beyond application isolation; least-privilege deployment required. |
| Replayed requests | Tenant/principal/idempotency scope plus request digest; equivalent replay returns same identity, conflicting replay rejected; durable dispatch repeats use same workflow key. |
| Confused deputy | Controls resolve immutable persisted execution binding and exact supported action; no caller-supplied service, handler or endpoint. |
| Internal-handler exposure | Gate 1 creates factories, not public Restate deployment; private handlers require network/process isolation. Test worker and trust-auth DB must never be exposed. |
| Historical provenance after revocation | Principal/membership references retained; active authority is a separate status. No destructive membership removal for actors with history. |
| Verification forgery or receipt reuse | Check task/step/input/digest/policy and evidence scope; no completed task on missing/foreign evidence; idempotency conflicts reject. |
| Ambiguous external effect | Explicit UNRESOLVED effect disposition; never infer failure/success from transport timeout. No external write adapter enabled. |
| Cancellation races | Requested/accepted/completed/unsupported/failed are distinct; terminal DB state is authoritative. Cancellation cannot rewrite completed history. |
| Resource abuse | Bounded body and per-tenant admission hook required for public submit; no model/SQL scheduler or unlimited dispatch loop. |

## Residual risks / deferred production controls

Authenticator implementation, TLS, private network deployment, vault injection, distributed quotas, recovery runbooks, backup/restore, retention and production DB role grants require later deployment qualification. Gate 1 must not claim these have been deployed. Legacy unbound tasks remain readable but cannot receive guessed controls. Existing 27 recovery scenarios must continue to pass.
