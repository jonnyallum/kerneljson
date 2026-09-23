# KJ-P6 Core Team / faculties

Design and implementation in progress. No P6 production activation or PASS is claimed.

ADR 0006 and cognition Stage C define eight persistent roles. P6 stores all eight as tenant-scoped versioned configuration. Intelligence and Verifier serve the existing admitted repository-analysis recipe. The other six templates are disabled until a governed recipe uses them. This introduces no autonomous worker or new task authority.

Routing uses the persisted Kernel plan operation, never a model output, free-text role request, or channel parameter. Intelligence handles RUNTIME_ANALYSE; Verifier handles RUNTIME_REVIEW. The registry pins the complete configuration, digest, routing reason and deployed provider/model before a model call. Replays reuse that selection. A new deployment may substitute an allowed provider for new tasks; it cannot silently change an existing pin. Disabled current configuration revokes new execution even for an older pin.

Faculty configuration is append-only and installed through a reviewed deployment, not writable through a model or channel API. The read-only model interface receives bounded text and output-token limits only. No tool, database, approval, admission or canonical-memory mutation interface is supplied. Faculties may restrict the existing recipe but cannot grant capabilities. The existing kernel ledger alone decides terminal state and verifies evidence against persisted pins.

Budgets include input bytes (an honest measurable bound), canonical-memory token estimate, output tokens, one attempt, and an optional monetary ceiling. The current ports do not offer an authoritative versioned price quote: a faculty with a monetary ceiling fails closed with PRICED_ROUTE_REQUIRED. Initial templates use token limits with no claimed monetary guarantee. Provider/model preferences remain separate from credentials and the deployed runtime allowlist.

Only analyst memory is permitted; Verifier remains isolated from operator memory. Both role versions and actual provider-reported model identities are recorded in evidence. Provider-reported identity is not cryptographic attestation.

Required qualification: deterministic routing; pin replay/concurrency; disabled/cross-tenant/capability refusals; provider substitution for new work and refusal for pinned work; failure without unauthorized retry; bounded context; evidence mutation refusals; real PostgreSQL append-only and tenant constraints. One harmless live task and pin replay must pass after canonical-merge CI and controlled worker/door activation before the P6 freeze.
