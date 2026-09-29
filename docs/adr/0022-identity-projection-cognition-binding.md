# ADR-0022: KJ-P7B, identity projection and cognition binding

Status: PROPOSED (design only, for hostile review before any code is written)

Date: 29/09/2026

Builds on ADR-0021 (Primary Identity, ACCEPTED 28/09/2026). It writes the "P7B, runtime identity assembly"
section that ADR-0021 D7 refers to but never defined, and it discharges ADR-0021's recorded P7B
preconditions:
- explicit `identity.*` alert-policy rows;
- a database-side twin of the canonical digest before cognition trusts identity;
- Class C/D stays frozen until P7B's live qualification (G13).

It changes nothing about who holds authority. KernelJSON remains the sole task authority. Identity decides
how a cognitive execution is framed, never what it is allowed to do.

## Where we start (observed, not assumed)

- **Production.** One active Primary Identity: **Kernel v1** (`d60a1f11…`, `identity_core_digest`
  `4f6dc581…`), epoch 12, release `4127361`. Nothing reads it at runtime yet.
- **The only production model consumer** is the repo-analysis mission (`services/kernel/src/mission/run.ts`).
  It has two runtime steps: the **analyst** (`RUNTIME_ANALYSE`, P6 faculty `intelligence`) and the
  **reviewer** (`RUNTIME_REVIEW`, P6 faculty `verifier`). `model-smoke.ts` is a CLI smoke test, not a
  consumer.
- **Existing assembly shape.**
  1. `prompts.ts` builds the request.
  2. `projectFacultyRequest` prefixes the system message with a one-line faculty role and enforces the
     faculty budget (`maxInputBytes` 512,000).
  3. Canonical memory (P5) is assembled once in a journaled `ctx.run`, **for the analyst only**. The reviewer
     is memory-isolated by `FACULTY_REVIEW_ISOLATION_REFUSED`.
- **Existing evidence.**
  - Every runtime step records provider, model, `request_digest` (over provider, model and request), the
    memory-assembly digest and the faculty digest.
  - At completion, `ledger.write` calls `verifyFacultyEvidence` against the **database** faculty pins, not
    model-supplied metadata.
- **P7A already created `identity_pins`** (tenant, task, step, identity id and version, with a `pin` jsonb
  requiring `identityCoreDigest`). It is not yet written by anything.
- **Alerting gap.** Every `identity.*` health check falls through to the alert policy's conservative default
  (CRITICAL maps to P2). A D8 orphan would page no louder than a P2 today.

## Decision

P7B wires Kernel into **exactly one consumer**, the analyst step of `repo-analysis-mission/v1`, behind a
default-off switch. It does so through five gates. G13 is the live qualification that ends P7B; it does not
by itself unfreeze anything.

### Scope boundary (the smallest thing that proves the architecture)

| Consumer | Receives Kernel? | Why |
|---|---|---|
| Mission **analyst** (`intelligence`) | **Yes**, profile `ANALYST_PERSPECTIVE` | The one D7 consumer. It is where "which Kernel made this decision" matters |
| Mission **reviewer** (`verifier`) | **No, structurally refused** | Independence. A verifier sharing the analyst's persona becomes the Colonel agreeing with himself. This mirrors P6's memory isolation of the reviewer |
| Golden workflow, canary, scheduler, Telegram operator, identity workflow | No | Out of scope. They make no model call, or they are not cognition |

Anything wider, including a conversational Kernel on Telegram, is a later ADR. It is not P7B.

### Switch: `KJ_IDENTITY_COGNITION_ENABLED` (worker, default off)

- **Off (default):** the analyst request is **byte-identical** to today. A regression test pins this by
  request digest, so P7B-1 can ship to production with zero behavioural change, the same property P7A had.
- **On:** for every mission, the analyst **requires** exactly one current identity for the task's tenant,
  DB-digest-verified (G1). If one is missing, mismatched or ambiguous, the analyst step fails closed
  (`ANALYST_IDENTITY_REFUSED`) and the mission ends FAILED with evidence. **There is never a silent fallback
  to "no identity"**, because that is exactly the "cognition with no identity when one is required" failure.
- **Adding the variable:** it is added to the `execution.compose.yaml` environment allowlist and to
  `runtime_env_merge.py`'s `PUBLIC_KEYS` as `^(true|false)$`, so it cannot be silently dropped. This is the
  allowlist trap that bit S1D2.

### G1: database digest authority (before cognition trusts anything)

Postgres gets its own implementation of the ADR-0021 D3 canonical form. Its outputs are then required to
equal the application's.

- **`kernel_private.identity_canonical_text(jsonb) returns text`** (IMMUTABLE STRICT, `search_path=''`) and
  **`kernel_private.identity_canonical_digest(jsonb) returns text`** (`sha256` over the UTF-8 text,
  lowercase hex). The rules match `canonicalStringify`:
  - object keys sorted at every depth (keys ordered with `COLLATE "C"`);
  - arrays kept in order;
  - strings through `to_json(text)::text`;
  - `true`, `false` and `null` literal;
  - numbers restricted to **integers**. The function raises on any non-integer numeric, because
    JavaScript and Postgres float formatting differ and the identity schema has no floats. Refusing is
    safer than approximating.
  - **Keys must be ASCII.** JavaScript sorts by UTF-16 code unit and `COLLATE "C"` sorts by UTF-8 byte;
    they agree for ASCII, and the identity schema's keys are fixed ASCII. The function raises on a
    non-ASCII key rather than risk a divergent order.
- **A BEFORE INSERT trigger on `identity_versions`** refuses (23514 `IDENTITY_DIGEST_PARITY`) any version
  whose stored `identity_core_digest` or `class_a_digest` differs from the database's own computation.
  From P7B on, no future version can be written with a digest the database disagrees with.
- **The migration asserts parity for every existing version before COMMIT** (today, Kernel v1 only:
  `4f6dc581…` and `c1e3d107…`). If any version disagrees, the migration rolls back. This is the same
  pre-COMMIT discipline that caught the ACL defect.
- **`kernel_private.identity_cognition_source(p_tenant uuid)`** is a single read that returns the current
  version for the tenant: id, version, document, stored digest, DB-computed digest, and the count of current
  identities. Cognition reads identity **only** through this function.
- **Refusing on disagreement.** The pin step (G4) requires *stored = DB-computed = application-computed*.
  Any disagreement refuses the analyst (`IDENTITY_DIGEST_MISMATCH`).
- **Proof.** A differential test runs a corpus through `canonicalStringify` (TypeScript) and
  `identity_canonical_text` (SQL) and requires **byte equality**. The corpus covers:
  - quotes, backslashes and every control character from U+0000 to U+001F;
  - U+007F, U+2028 and U+2029;
  - multi-byte and astral characters (emoji);
  - empty strings and arrays, nested arrays of objects, deep nesting;
  - the real Kernel v1.

  Negative controls: a float and a non-ASCII key must each **raise**, and a deliberately altered stored
  digest must be refused by the trigger.

### G2: identity health, made loud

These are new or completed health checks, **each with explicit rows in `services/kernel/src/alerting/policy.ts`**
(no more default fall-through), and each shipped with its negative case.

| Check | Fails when | Status → severity |
|---|---|---|
| `identity.completedTasksHaveActivation` (exists) | a COMPLETED identity task has no activation (the D8 orphan) | CRITICAL → **P1** |
| `identity.profilesHaveActivatedIdentity` (exists) | a profile has no activated identity past grace | DEGRADED → P2 |
| `identity.currentDigestParity` | for any current version, stored ≠ DB-computed digest | CRITICAL → **P0** (integrity) |
| `identity.singleCurrentPerTenant` | a tenant has more than one current identity | CRITICAL → **P0** (structurally impossible today; checked anyway) |
| `identity.headEqualsCurrent` | the head version is not the current version | CRITICAL → **P1** |
| `identity.analystRunsBound` (only when the switch is on) | an analyst runtime record since enablement lacks an identity pin, or its evidence differs from its pin | CRITICAL → **P1** |
| `identity.verifierIsolated` | any reviewer runtime record carries identity metadata or an identity pin | CRITICAL → **P1** |

"Cognition using a stale identity version" is **not** an alert. A pinned mission deliberately keeps its
pinned version (see G4, version pinning). The check that matters is that the pin, the evidence and the
immutable version agree, and `analystRunsBound` covers it.

### G3: `IdentityProjection`, the bounded object a model actually receives

- **The contract**, in `packages/contracts`: `IdentityProjection` with schema `kj-identity-projection/v1`,
  holding:
  - `profile`;
  - `identity: { id, version, identityCoreDigest }`;
  - `sections`, containing **only** the fields the profile allows.
- **Pure function** `projectIdentity(document, profile)`. It is deterministic, and
  `projectionDigest = canonicalDigest(projection)`.
- **Profiles form a closed enum; an unknown profile is refused.** P7B defines two:
  - `ANALYST_PERSPECTIVE`: all of Class A (name, constitution, values, operatorRelationship,
    facultyFraming, memoryPolicy), all of Class C, and all of Class D. Kernel v1 renders to about 8.3 KB.
  - `NONE`: the reviewer's profile. Choosing it produces no projection, and choosing anything else for
    `RUNTIME_REVIEW` is refused.
- **A hard cap of 16 KiB on rendered projection bytes.** If it is exceeded, the analyst is **refused, never
  truncated**. Truncating a constitution silently changes identity.
- **Rendering.** A fixed-format block, placed in the system message **after** the one-line faculty authority
  header and **before** the task instructions. The resulting system message is: faculty header ("advisory
  text only; KernelJSON owns decisions"), then the identity block, then the analyst task contract.
  - The block states its own subordination in fixed text: identity frames voice, values and judgement; it
    grants no permission, tool or authority, and the task contract and output format below it are binding.
  - The repository facts (untrusted content) stay in the user message, separately labelled, unchanged.
  - The enforcement is structural (no tools, a fixed output contract, the kernel's reconciliation), not
    the prose.
- **D4 faculty lock.**
  - `projectIdentity` receives the **already-validated** faculty pin only to read `operation` (which
    decides the profile). It has no code path that reads, selects or influences a faculty.
  - The faculty pin is computed first by P6's unchanged code, and the identity pin second.
  - They meet only in the evidence record, as ADR-0021 D4 requires.
  - A test asserts `projectIdentity` has no import of the faculty registry or routing, and that changing
    any identity text never changes the faculty pin digest.

### G4: pinning and evidence (what ran, provably, six months later)

**Identity pin (new, in the style of `PgFacultyRegistry.pin`):**
- **Scope:** only for the analyst step. It is written **after** the faculty pin, under
  `pg_advisory_xact_lock('identity-pin:<task>:<step>')`, and is idempotent (an existing pin is re-validated
  and returned).
- **Preconditions:** task RUNNING, step operation `RUNTIME_ANALYSE`, and G1 parity from
  `identity_cognition_source`.
- **Write:** one `identity_pins` row whose `pin` holds the required keys plus `projectionSchema`,
  `projectionProfile` and `projectionDigest`. The existing table CHECKs and foreign keys apply.

**Version pinning:** a mission uses the version pinned at the analyst step, even if a governed change
activates a newer version mid-mission (IDENTITY_GOVERNANCE: "must not silently change semantics of an
already-running pinned mission").

**Authorisation before the model call** (`IdentityPort.authorize`, next to `faculties.authorize` in the
guarded port):
- the pin row is unchanged;
- the task is RUNNING;
- the pinned version still exists;
- the identity block in the outgoing request is byte-equal to the pinned projection's rendering.

Any failure fails closed with `REQUEST_REJECTED`.

**Evidence:** `runtimeEvidence.metadata.identity = { identity_id, identity_version, identity_core_digest,
projection_schema, projection_profile, projection_digest }` on the analyst. There is **no** `identity` key
on the reviewer.

**A context digest for both runtimes:** `context_digest = canonicalDigest(request.messages)`, the digest of
exactly what was handed to the model, **excluding provider and model**. Today's `request_digest` includes
provider and model, so it can never be equal across providers. `context_digest` is the ADR-0021 D9
`assembly_digest`.

**Completion** (`ledger.write`, beside `verifyFacultyEvidence`): `verifyIdentityEvidence(identityPins,
evidence, required)`. It requires:
- the analyst's evidence identity metadata to equal its database pin;
- no identity pin on any non-analyst step;
- no identity metadata on reviewer evidence;
- `required` to be true when the switch was on for this task.

A COMPLETED mission therefore cannot exist whose evidence disagrees with its identity pin. Otherwise the
existing `CompletionVerificationError` path ends the task FAILED.

**Replay:** the projection and pin are built inside a journaled `ctx.run`, as memory context is today, so a
Restate replay sees the same identity even if a new version activated meanwhile.

The four D9 digests on every bound analyst run are then:
- `identity_core_digest`;
- `context_digest` (the assembly);
- the P6 faculty digest;
- the P5 memory-assembly digest.

### G5: cross-provider continuity proof

- **In CI (deterministic):** the same mission through two fake providers must produce identical
  `identity_core_digest`, `projection_digest`, faculty digest, memory-assembly digest **and
  `context_digest`**. Only provider, model and `request_digest` may differ.
- **Live, in the P7B-2 window:**
  1. Run one governed mission with the analyst on provider A.
  2. Change the analyst route by config to provider B (it must already be in the intelligence faculty's
     `providerPreferences`, so there is no faculty change).
  3. Run the same objective against unchanged memory, with a fresh session and no shared history.
  4. **Hard pass:** the four D9 digests are equal across the two runs. **Qualitative, for the record only:**
     both outputs speak as Kernel within the same authority boundaries. Wording is expected to differ, and
     identity is not.

### G13: P7B live qualification (ends P7B; unfreezes nothing by itself)

G13 is complete when all of these have passed in production:
- G1 parity is live;
- the G2 checks are HEALTHY and their alerts have fired on purpose in a negative test;
- the switch-on analyst runs are bound;
- the reviewer is isolated;
- the G5 digests are equal across providers.

**Unfreezing Class C/D is a separate, explicitly authorised decision after G13.** That decision would be
`set_identity_freeze(…, false)` plus a production C/D policy rule, reviewed on its own. It is not part of
this ADR and no code in P7B performs it.

## Delivery: two windows, same discipline as P7A

1. **P7B-1, code with the switch off.**
   - Contents: one PR with the G1 migration (functions, trigger, pre-COMMIT parity assertion), the G2
     checks and policy rows, the G3 projection contract and function, the G4 port, pin, evidence and
     completion verification, and the G5 CI test.
   - Qualification: hostile review, failing-first tests, mutations, CI.
   - Deploy as epoch 13 with the switch **off**, the migration's pre-COMMIT parity check live against
     Kernel v1, and the analyst request digest proven unchanged against the next natural canary. That
     canary is not an analyst run, so a controlled mission compares before and after.
2. **P7B-2, enable.**
   - A config-only window (switch on; no release change, so no epoch change).
   - One bound analyst mission; the negative health proofs; the G5 cross-provider pair; then G13.

**Mutations to add** (each must be killed by its own test, like M55 to M57):
- remove the version digest-parity trigger;
- skip DB-digest parity at pin time;
- fall back to no identity when the switch is on;
- give the reviewer a projection;
- truncate instead of refusing over the cap;
- drop identity metadata from evidence;
- skip `verifyIdentityEvidence` at completion;
- read the current version at call time instead of the pin;
- let identity text reach faculty routing;
- remove a G2 policy row (must fall back to P2 and be caught by the policy test).

## Explicitly not in P7B

- A conversational or primary Kernel runtime, including Kernel speaking on Telegram.
- Reflection or proposals (KJ-P8).
- Class E self-model.
- Any memory write.
- Any faculty change.
- The P5 protected-promotion fix.
- Unfreezing C/D.
- Shared Brain integration (P9).

## Open questions for hostile review

1. **Scope of `ANALYST_PERSPECTIVE`.** Should the analyst get all of Class C/D, or should Class D
   (objectives and vision) be withheld from an analysis step to keep it about the repository in front of
   it? The proposal includes it, because "revisit old projects" is exactly an analysis concern.
2. **Placement.** The faculty header goes before the identity block. That departs slightly from
   CONTEXT_ASSEMBLY's order (identity 4, role 5). The one-line authority header is treated as the invariant
   (order 1 to 2), not the role projection. Is that acceptable, or should the faculty purpose line move
   after identity?
3. **Switch granularity.** The switch is worker-wide and single-tenant today. Should it be per-tenant from
   the start (a database flag in `kernel_private`, deployment-authority only) so enabling is auditable in
   the ledger rather than in an env file?
4. **G5 provider pair.** Is switching the analyst route by config between two runs acceptable as "fresh
   session, no shared history", or should G5 use two separately pinned faculty routes in one run?
5. **Is P0 right for `currentDigestParity`?** It is proposed as P0 because a mismatch means the identity a
   model would receive is not provably the governed one.
