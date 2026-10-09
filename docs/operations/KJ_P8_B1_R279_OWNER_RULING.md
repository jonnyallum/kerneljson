# R279 helper ruling and B1 resumption

Status: **ACCEPTED OWNER RULING — design-review/seal update pending**. The owner replied “continue” to the explicit request to approve preserving the pinned helper and correcting the inaccurate rethrow claim. This supersedes the earlier pending status. It authorizes the narrow correction and B1 resumption; it is not a hostile-review verdict or implementation qualification.

Decider: repository owner. Scope: the contradictory rethrow inference in ADR-0023 section 27.12.4 only. The sealed design commit remains immutable; acceptance of this proposal is not a new hostile seal.

The diagnostic at `9530a3e66cef29499af6c07d80131b6c6399926a` is valid: the pinned helper logs and absorbs errors in its RLS-enabling block. The assertion that it rethrows is an inaccurate behavioural inference. B1 creates no tables and does not fire the helper; this finding does not block B1 remediation.

Preserve the helper's sealed source, digest, owner, null ACL, configuration and `ensure_rls` topology. No rethrow is added. No runtime authority, runner invariant, qualification threshold or production fence changes. The diagnostic and its original stop report remain historical evidence.

Proposed narrow ADR correction for later review, not an edit or reseal of `af2f7320aae32eaa0ce699b1c09d015371f156d5`:

> The pinned helper logs and absorbs failures while enabling RLS. It does not guarantee transaction abort or RLS enablement on failure. KernelJSON migrations must not rely on that helper as their sole RLS enforcement.

## Alternatives and consequences

| Option | Consequence |
|---|---|
| Preserve the sealed source; correct the inference (recommended) | Describes the observed behaviour accurately and preserves the B1 co-resident contract. No abort-on-failure guarantee is claimed for this helper. |
| Require the helper to rethrow | Requires a changed body, new digest, updated sealed contract and separate platform-change authorization. It cannot qualify against the existing source pin. |

The recommendation does not waive any other section 27.12.4 interaction or qualification requirement. In particular, preserving an event-trigger pin does not establish that application tables have RLS enabled. Explicit RLS enforcement for future table-creating migrations belongs to its separately authorized stage.

## Verification and resumption conditions

The existing diagnostic was rerun successfully during this Codex handoff: positive-control RLS was enabled; the injected failure produced a committed table with RLS disabled; direct ALTER TABLE returned `42501`; the complete helper pin remained unchanged; the failure log was observed; teardown passed. This was an isolated diagnostic, with no B1 application or production connection.

1. Owner choice recorded above: preserve the helper and correct the rethrow inference.
2. Submit the narrow correction through the repository's design-review/seal process. Do not silently edit the sealed commit or label this proposal hostile-approved.
3. Continue unaffected B1 remediation under sprint section 51, retaining the contradiction report and identifying any dependent qualification as pending until the applicable design decision is accepted.
4. Validate B1 against the resulting authorized contract and all remaining original gates. A successful diagnostic, a ruling, or draft migration generation cannot establish full B1 qualification.

Remediation continues on `feat/kjp8-b1-r279-remediation`, as child commits of the diagnostic commit, without rebase or history rewrite. Production connections, mutation, baseline capture, ledger repair, deployment, merge, opening a merge PR and all later P8 stages remain unauthorised. P8A-0 is not started. No implementation qualification follows from this ruling alone.
