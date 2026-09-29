# ADR-0022: KJ-P7B, identity projection and cognition binding

Status: PROPOSED, revision 2 (design only). Revision 1 (`e962bbd`) was BLOCKED by Grok's hostile review
(B1 to B6 and the G1/G3/G4/G5 conditions). This revision closes each blocker as a decision; no
implementation-critical question is deferred.

Date: 29/09/2026

Builds on ADR-0021 (Primary Identity, ACCEPTED 28/09/2026). It writes the "P7B, runtime identity assembly"
section that ADR-0021 D7 refers to but never defined, and it discharges ADR-0021's recorded P7B
preconditions: explicit `identity.*` alert-policy rows, and a database-side twin of the canonical digest.
Class C/D remains frozen before, during and **after** P7B (B6).

Authority does not move. KernelJSON remains the sole task authority. Identity frames how one cognitive
execution speaks and judges; it never decides what is allowed, which faculty runs, or what memory is read.

## 1. Where we start (observed in the code at `4127361`, not assumed)

- **Production.** One active Primary Identity: **Kernel v1**.
  - identity `d60a1f11-01c2-46b5-90d4-94cd4b696aeb`, version row `08be5e20-2606-4809-b81f-11552bb67502`;
  - `identity_core_digest` `4f6dc581f06701c207d5cdf8bc1ced59fa0741c15bab18c30537d0b17a7bf9ed`;
  - `class_a_digest` `c1e3d107616db8ebf4586121d62eb2c6dd966351e2e11de3949a253ce6158dc6`;
  - epoch 12, release `4127361`.
- **The only production model consumer** is `runRepoAnalysisMission` in `services/kernel/src/mission/run.ts`
  (`model-smoke.ts` is a CLI smoke test). Its two runtime steps:
  - **analyst**: operation `RUNTIME_ANALYSE`, P6 faculty `intelligence`, with `providerPreferences`
    `["deepseek","openrouter"]`;
  - **reviewer**: operation `RUNTIME_REVIEW`, P6 faculty `verifier`.
- **How today's analyst request is built:**
  1. `analystRequest(...)` in `services/kernel/src/mission/prompts.ts` returns a `ModelRequest` with exactly
     two messages:
     - `system`: `analystSystem(contract)`;
     - `user`: `` `Question: ${question}\n\n${memory}${renderFacts(facts, factsDigest)}` ``, where `memory` is
       the P5 rendered context plus `"\n\n"`, or empty.
  2. Inside `runRuntime` in `run.ts`, `projectFacultyRequest(pin, request)` in
     `services/kernel/src/faculty/policy.ts` **prefixes** the system message with the faculty role line
     (`"Kernel faculty: …\nPurpose: …\nAuthority: advisory text only; KernelJSON owns decisions and
     execution.\n"`). It also enforces `contextBudget.maxInputBytes` (512,000) and the output budget.
  3. `callModel` in `services/kernel/src/models.ts` sends it through the guarded `ModelPort`. The receipt's
     `request_digest` is `modelDigest({provider, model, request})`, so it **includes provider and model**.
- **Where memory comes in.** It is assembled once, journaled (`ctx.run("mission-memory-context")`), for the
  **analyst only**. Its digest (`contextDigest` in `services/memory/src/canonical/assembler.ts`) is
  task-id-free: tenant, purpose, project, classes, budget and items. The reviewer is memory-isolated
  (`FACULTY_REVIEW_ISOLATION_REFUSED`).
- **Where the faculty pin comes in.** It is written by `PgFacultyRegistry.pin` in a journaled
  `ctx.run("faculty:<step>:pin")` and re-checked by `faculties.authorize` before the call. At completion it
  is verified inside `Ledger.write` by `verifyFacultyEvidence` against the **database** pins.
- **`identity_pins` already exists** from P7A: tenant, task, step, identity id and version, and a `pin`
  jsonb with the required keys. Nothing writes it yet.
- **Alerting gap.** Every `identity.*` check falls through to the policy default (CRITICAL maps to P2).

## 2. Scope: exactly one consumer

| Consumer | Kernel identity | Why |
|---|---|---|
| Mission analyst (`intelligence`) | profile `ANALYST_INTELLIGENCE_V1`, when latched REQUIRED | The single D7 consumer |
| Mission reviewer (`verifier`) | **none, structurally** (B4 fence and ceiling NONE) | Verifier independence: it must not become the Colonel agreeing with himself |
| Everything else (golden, canary, scheduler, Telegram, identity workflow, memory) | none | Not cognition, or out of scope |

Not in P7B:
- reviewer identity, reflection or KJ-P8, self-model;
- identity-generated missions, Shared Brain expansion, automatic memory promotion;
- any change to faculty selection, policy authority or admission authority;
- unfreezing Class C/D.

## 3. B1: narrow-only projection (discharges ADR-0021 D4)

    effective_scope = identity_framing_scope  INTERSECT  kernel_faculty_ceiling

Both sides are **machine allow-lists of document field paths**. Neither is ever parsed from identity prose.

- **`identity_framing_scope`** is owned by KernelJSON, not by the identity document. It is a constant attached
  to a versioned projection profile in the P7B identity-binding module. P7B defines exactly one profile:
  `ANALYST_INTELLIGENCE_V1`.
- **`kernel_faculty_ceiling`** is owned by Kernel/P6. It is a constant table in a new P6-side module,
  `services/kernel/src/faculty/identity-ceiling.ts`, keyed by `(faculty id, faculty policyVersion)` of the
  **already-selected, already-validated** faculty pin. That module imports nothing from identity (B4).
  - `intelligence`: the field list in the table below.
  - `verifier`: the empty list.
  - Any other or unknown faculty, or unknown policyVersion: NONE.
- **Content.** Identity content can populate only fields in the intersection. A missing profile, a missing
  ceiling entry or an empty intersection means NONE. In REQUIRED mode that fails closed before any provider
  call.
- **Limits.** Identity can never select a faculty, alter a ceiling, choose a profile or request a larger
  projection. The profile is chosen by the step operation (`RUNTIME_ANALYSE` gives `ANALYST_INTELLIGENCE_V1`);
  no other mapping exists.

**The exact `ANALYST_INTELLIGENCE_V1` allow-list, identical on both sides for `intelligence`:**

| Class | Fields projected | Fields withheld |
|---|---|---|
| A | `name`, `constitution`, `values`, `operatorRelationship`, `facultyFraming`, `memoryPolicy` (all six) | none |
| C | `persona`, `communication`, `behaviour` | `presentation` |
| D | none | `objectives`, `vision` |

**Why Class A is projected intact.** Class A is the constitutional framing boundary, and it is what makes
the rest safe:
- It carries identity's own subordination: "KernelJSON remains the sole task authority…", "I do not create
  authority for myself, bypass governance…", `facultyFraming` ("I do not select, enable, disable, reorder or
  widen faculties") and `memoryPolicy` ("must never widen permissions or authority").
- Projecting persona or values without those constraints would hand a model the voice without the limits.
- Projecting Class A whole makes it **verifiable**: `classADigest(projection.sections.classA)` must equal the
  pinned `class_a_digest` of the immutable version. A partial Class A could not be checked against a governed
  digest.

**Why these three Class C fields.**
- `behaviour` ("investigate before concluding; challenge contradictions and false greens; stop at
  governance boundaries") and `communication` ("plain UK English; lead with the finding, then evidence")
  directly shape the quality of an evidence-cited analysis.
- `persona` carries the Colonel's judgement and standards, which is the point of the consumer.
- `presentation` (sections, tables, layout) is **withheld** because the analyst's output is a machine-checked
  JSON object with a fixed shape and hard length limits. Layout guidance cannot improve it and could only
  compete with the output contract.

**Class D is never projected in P7B**, so objectives and vision cannot reach cognition.

**Memory stays fully independent.** Retrieval scope, the memory query (`purpose`, `project`), memory
permissions and classes, ranking, and the faculty memory ceiling (`permittedMemoryClasses`,
`maxMemoryTokens`) are computed exactly as today, **before and without** any identity read. The memory
module is fenced from identity (B4). `memoryPolicy` only frames how already-authorised, already-assembled
memory text is interpreted.

## 4. B2: durable task-latched enablement

`KJ_IDENTITY_COGNITION_ENABLED` (worker env, `true|false`, default `false`) is read **exactly once per
analyst step**: inside the journaled latch creation. It is never consulted again for that step.

- **New table `kernel_private.identity_cognition_latches`:**
  - columns `tenant_id`, `task_id`, `step_id`, `mode` (`NONE` or `REQUIRED`), `release_id`, `latched_at`;
  - primary key `(task_id, step_id)`; foreign key `(step_id, task_id)` to `task_steps`; RLS on; all grants
    revoked from PUBLIC, anon, authenticated and service_role;
  - immutable: UPDATE, DELETE and TRUNCATE are refused, like every ledger table.
  - Checked by a deferred constraint trigger:
    - `mode = REQUIRED` requires an `identity_pins` row for the same `(task_id, step_id)`;
    - `mode = NONE` requires that none exists;
    - `identity_pins` rows may exist only for analyst steps whose latch is REQUIRED.
- **Latch creation** runs in `ctx.run("identity:<analyst step>:latch")`, **after** the faculty pin is
  obtained, in one database transaction under `pg_advisory_xact_lock('identity-latch:<task>:<step>')`:
  1. If a latch row exists, return it unchanged, **ignoring the env**. The env is not even read.
  2. Otherwise read the env once:
     - **OFF:** insert a `NONE` latch. No identity pin exists, and the provider request is byte-identical to
       the pre-P7B request (B3).
     - **ON:** create the exact identity pin (section 8), then insert a `REQUIRED` latch in the same
       transaction.
- **Afterwards:**
  - Restate replay returns the journaled latch.
  - Retries after a lost journal entry find the database row.
  - Completion verification (section 10) reads the persisted latch, never the env.
  - An environment change has **zero** effect on any task already latched. No replay or retry can turn
    NONE into REQUIRED or REQUIRED into NONE, because the row is immutable and the env is not read when it
    exists.
- **Rollback semantics:**
  - **Turning the env OFF** affects only analyst steps latched after the change. In-flight REQUIRED tasks
    stay REQUIRED and complete, or fail closed, as REQUIRED.
  - **Turning it ON** affects only newly latched steps.
  - **Rolling the release back** below P7B-1 is permitted only after draining: zero non-terminal tasks with a
    REQUIRED latch. Pre-P7B code does not read latches, so it must never host a REQUIRED task. This is added
    to the release-rollback checklist.
  - **Legacy tasks.** Tasks bound at an epoch before P7B-1's activation have no latch and keep their original
    completion contract, like pre-P6 tasks without faculty pins. Any mission task **bound at or after the
    P7B-1 epoch** must have a latch for its analyst step, or completion is refused.
- **Observability without secrets.** The env value is non-secret. The health CLI reports the worker's current
  enablement for **new** work and the count of latches by mode. The value is read with the existing
  allow-listed `printenv`. Adding the variable to `execution.compose.yaml`'s environment allowlist and to
  `runtime_env_merge.py` `PUBLIC_KEYS` (`^(true|false)$`) is a P7B-1 requirement.

## 5. B3: one analyst assembly contract

**The one canonical assembler** is a new `assembleAnalystRequest(input)` in
`services/kernel/src/mission/analyst-assembly.ts`. It is the **only** place the analyst provider request is
composed, and the only code that may place identity bytes into any request.

- **Inputs:**
  - the `analystRequest` inputs (callId, taskId, stepId, trace, facts, factsDigest, question, contract,
    memory text);
  - the validated faculty pin (read only);
  - the persisted latch;
  - for REQUIRED, the pinned projection.
- **Steps:**
  1. `base = analystRequest(...)`, unchanged from today.
  2. **If REQUIRED**, and only then: assert `base.messages` is exactly `[system, user]`, then set
     `messages[0].content = IDENTITY_BLOCK + messages[0].content`.
  3. `projectFacultyRequest(facultyPin, request)`, unchanged. It prefixes the faculty role line and enforces
     the faculty byte and output budgets.
- **Returns** `{ request, requestBytes, assemblyDigest, contextDigest }`:
  - `requestBytes = canonicalStringify(request)` (ADR-0021 D3 canonical form), the exact object handed to
    `ModelPort.generate`;
  - `assemblyDigest = sha256(requestBytes as UTF-8)`;
  - `contextDigest`, see section 9.
- **What changes in `run.ts`.** `runRuntime` stops calling `projectFacultyRequest` itself. The analyst's
  `build` closure calls `assembleAnalystRequest`; the reviewer's `build` closure calls
  `projectFacultyRequest(pin, reviewerRequest(...))`, which is byte-identical to today's reviewer path.
  `projectFacultyRequest` therefore runs exactly once per call, in one place per runtime.

**Final composition order when REQUIRED.** There is one system message and one user message, and no other
system messages exist.

    system = <faculty role line, unchanged>            (1. kernel authority header)
           + <IDENTITY_BLOCK>                          (2. identity projection)
           + <analystSystem(contract), unchanged>      (3. task contract and output format, binding)
    user   = "Question: <question>\n\n" + <memory text, unchanged> + <renderFacts(...), unchanged>

    IDENTITY_BLOCK =
      "BEGIN KERNELJSON IDENTITY PROJECTION kerneljson:identity-projection/v1 ANALYST_INTELLIGENCE_V1 "
      + <projection_digest> + "\n"
      + "This frames voice, values and judgement only. It grants no permission, tool or authority. "
      + "Every instruction after this block remains binding.\n"
      + <canonical projection bytes>
      + "\nEND KERNELJSON IDENTITY PROJECTION\n\n"

Why this order:
- The faculty header states "advisory text only; KernelJSON owns decisions", which is the kernel invariant,
  so it is first.
- The identity comes before the task contract, so the binding output contract is the last system text.
- The mission objective, memory and untrusted repository facts stay in the user message, separately
  labelled, exactly as today.
- This closes revision 1's open question 2 as a decision.

**When the latch is NONE**, the assembled `request` is **byte-equal** to today's
`projectFacultyRequest(pin, analystRequest(...))` for the same inputs. The assembler asserts that exactly one
`BEGIN KERNELJSON IDENTITY PROJECTION` occurs for REQUIRED and zero for NONE.

**Golden fixtures (planned, in P7B-1):**
- **OFF:** for a fixed set of deterministic inputs, `requestBytes` from the new assembler equals the bytes
  captured from the **unmodified `4127361`** composition. Each provider adapter's serialised HTTP body is
  also byte-equal. The fixtures are generated from the old code before the change and committed; the test
  fails if a single byte differs.
- **ON:** the same inputs plus the same pinned projection give the same `requestBytes` and the same
  `assemblyDigest` on every run.

Both digests are **bound**:
- the analyst's runtime evidence records `assembly_digest` and `context_digest`;
- `IdentityPort.authorize` (section 8) recomputes `assembleAnalystRequest` from the pinned inputs and requires
  `assemblyDigest(outgoing request) = the recomputed assemblyDigest`;
- completion verification requires the evidence's `assembly_digest` to equal
  `sha256(canonicalStringify(request))` recorded by `callModel` for that call. The receipt's `request_digest`
  is recomputed from the same request and the recorded provider and model.

## 6. B4: dependency and import fences

**Modules with P7B identity authority:**
- `services/kernel/src/identity/projection.ts`: the pure projection and IdentityProjection contract use;
- `services/kernel/src/identity/cognition-binding.ts`: IdentityPort, latch, pin and authorize.

**The only permitted importers** of those two modules:
- `services/kernel/src/mission/analyst-assembly.ts`;
- `services/kernel/src/mission/run.ts`, for wiring the analyst step only;
- `services/kernel/src/index.ts`, the composition root;
- their own tests.

**Forbidden** from reaching either module through any transitive import:
- `services/kernel/src/faculty/**`, including `routeFaculty`, the registry and the new
  `identity-ceiling.ts`;
- `services/memory/**`, covering retrieval, assembly, policy and the mission port;
- admission: `apps/gateway/**` and `services/kernel/src/compiler/**`;
- `services/kernel/src/planner/**`;
- policy: `services/kernel/src/policy.ts` and `services/kernel/src/approval-*.ts`;
- `services/kernel/src/mission/prompts.ts`, which includes `reviewerRequest`;
- completion authority: `services/kernel/src/ledger.ts` and `services/kernel/src/verification*.ts`.

Completion verification uses a **separate** pure module, `services/kernel/src/identity/evidence-verify.ts`.
It imports only contracts and `identity/canonical.ts` and has **no** IdentityPort, database or projection
import. Only that module is allowed into `ledger.ts`.

**The inverse direction.** `projection.ts` and `cognition-binding.ts` must not import:
- `faculty/registry.ts`, `faculty/policy.ts` routing or `faculty/templates.ts`;
- any memory module.

They may import the `FacultyPin` **type** from contracts and read `faculty/identity-ceiling.ts`. Identity
can **read** the persisted faculty pin value handed to it, and can never produce, replace or influence it.
The faculty pin and the identity pin meet only in `analyst-assembly.ts` and in the evidence record.

**The topology test** (`tests/identity-topology.test.ts`) builds the static import graph of the repository's
TypeScript. It asserts:
- the permitted-importer allow-list above is exact;
- no forbidden root reaches either identity module transitively;
- the inverse rule holds;
- `evidence-verify.ts` stays pure.

**Mutations the topology test must kill** (each injects one forbidden import):
1. into `faculty/policy.ts` (`routeFaculty`);
2. into `services/memory/src/canonical/assembler.ts`;
3. into `apps/gateway/src/server.ts` (admission);
4. into `services/kernel/src/policy.ts`;
5. into `services/kernel/src/mission/prompts.ts` (`reviewerRequest`);
6. `faculty/registry.ts` into `identity/cognition-binding.ts` (inverse direction).

These sit alongside the behavioural mutations in section 12.

**Behavioural fence.** The reviewer's faculty ceiling is empty. `assembleAnalystRequest` is the only function
that emits an identity block. Completion refuses any reviewer evidence carrying identity metadata and any
identity pin on a non-analyst step.

## 7. G1: versioned digest contract (the database digest authority)

- **Contract identifier:** `kerneljson:identity-core/v1`, which is exactly ADR-0021 D3's `canonicalStringify`:
  - object keys sorted at every depth;
  - arrays kept in order;
  - primitives encoded as JSON.
- **Exact UTF-8 canonicalisation:**
  - The canonical text is encoded as UTF-8 with no BOM and no trailing newline, with no whitespace between
    tokens.
  - Keys are sorted by UTF-16 code unit. Identity keys are fixed ASCII, so this equals byte order. The SQL
    function **raises** on any non-ASCII key.
  - Strings are JSON-escaped exactly as `JSON.stringify` does: `\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, and
    other U+0000 to U+001F as `\u00xx` in lowercase hex. Every other code point, including U+007F, U+2028,
    U+2029 and non-ASCII, is emitted literally as UTF-8.
  - Numbers must be integers. The SQL function **raises** on any non-integer.
  - Booleans and null are literal.
  - `sha256` over those bytes is emitted as lowercase hex.
- **Versioned twins:**
  - TypeScript `identityCoreDigestV1`, with today's `identityCoreDigest` and `classADigest` as aliases, their
    semantics frozen;
  - SQL `kernel_private.identity_core_canonical_v1(jsonb) returns text` and
    `kernel_private.identity_core_digest_v1(jsonb) returns text`, IMMUTABLE STRICT with `search_path=''`.
- **One golden corpus**, `tests/fixtures/identity-core-v1.vectors.json`, holds entries of the form
  `{name, inputJson, canonical, sha256}`. It is consumed by **both** the TypeScript test and the real-Postgres
  test, and each must reproduce `canonical` byte-for-byte and `sha256` exactly. The vectors:
  - the exact production Kernel v1, as a draft (`proposed_digest` `01998d01…`) and as v1 with `version: 1`
    (`4f6dc581…`), plus its Class A alone (`c1e3d107…`);
  - object key reordering, and whitespace differences in `inputJson` (same canonical);
  - Unicode and non-ASCII strings, including astral and emoji, and every escaped control character;
  - arrays whose order changes (different digest), and empty arrays;
  - null against an absent key (different digests; generic vectors, since the identity schema has no
    optional field);
  - a one-byte Class A change, a Class C-only change and a Class D-only change (the whole-document digest
    changes each time; `class_a_digest` changes only for the Class A change);
  - version treatment (draft without `version` against the version with it);
  - `id` and `tenantId` changes;
  - negative vectors: a float and a non-ASCII key, both of which must raise in SQL.
- **Enforcement:**
  - The P7B migration adds a BEFORE INSERT trigger on `identity_versions` refusing (`23514
    IDENTITY_DIGEST_PARITY`) any row whose stored `identity_core_digest` or `class_a_digest` differs from
    `identity_core_digest_v1(document)` or `identity_core_digest_v1(document->'sections'->'classA')`.
  - **Before COMMIT**, the migration verifies that production Kernel v1 (`08be5e20…`) recomputes to exactly
    `4f6dc581…` and `c1e3d107…`, and that every existing version has parity. Otherwise it rolls back.
  - `kernel_private.identity_cognition_source_v1(p_tenant uuid, p_identity uuid, p_version int)` returns the
    exact immutable version with its stored and DB-computed digests. The latch and pin use only this.
- **Evolution rule.** The semantics of a digest function or version are **never changed in place**. A v2
  would require all of these:
  1. new versioned SQL and TypeScript implementations;
  2. dual computation across every existing version;
  3. an explicit, proven parity or migration;
  4. switching consumers only in a separately reviewed migration and release;
  5. keeping v1 verification for all historical evidence.

## 8. G3/G4: the durable projection pin

**Projection object** (`kerneljson:identity-projection/v1`):

    { "schema": "kerneljson:identity-projection/v1", "profile": "ANALYST_INTELLIGENCE_V1",
      "identity": { "id", "version", "identityCoreDigest", "digestContract": "kerneljson:identity-core/v1" },
      "sections": { "classA": {6 fields}, "classC": { "persona", "communication", "behaviour" } } }

- `projection_digest = sha256(canonicalStringify(projection))`.
- **The 16 KiB limit** is `16 * 1024 = 16384` **UTF-8 bytes** of exactly
  `canonicalStringify(projection)`: the bytes inserted by the assembler between the block's header and footer
  lines. It is not a JavaScript character count, a token count or a pre-serialisation object size.
  Kernel v1's `ANALYST_INTELLIGENCE_V1` projection is about 6 KB.
- **Over the cap while REQUIRED fails before any provider call** (`IDENTITY_PROJECTION_TOO_LARGE`). There is
  no truncation, and no partial constitution or persona.

**Identity pin (REQUIRED only).** One `identity_pins` row per analyst step, written in the latch transaction.
The `pin` jsonb binds:

| Key | Value |
|---|---|
| `tenantId`, `taskId`, `stepId` | the analyst step |
| `identityId`, `identityVersionId`, `identityVersion` | the exact immutable version row, taken from `identity_current` at latch time, **never HEAD at call time** |
| `identityCoreDigest`, `classADigest`, `digestContract` | stored = SQL v1 = TypeScript v1, all three equal, or refused (`IDENTITY_DIGEST_MISMATCH`) |
| `projectionSchema`, `projectionProfile` | `kerneljson:identity-projection/v1`, `ANALYST_INTELLIGENCE_V1` |
| `projection` | the **exact projection object**; `canonicalStringify(pin.projection)` reproduces the inserted bytes |
| `projectionBytes`, `projectionDigest` | the UTF-8 byte length (≤ 16384) and the digest |
| `facultyId`, `facultyVersion`, `facultyDigest` | read from the already-persisted faculty pin, for binding only |
| `mode` | `REQUIRED` |

The P7A table's CHECK keys (`tenantId`, `taskId`, `stepId`, `identityId`, `identityVersion`,
`identityCoreDigest`) are all present, and its foreign keys to tasks, steps and `identity_versions` hold.

**HEAD advancing does not affect in-flight work.** If Kernel v2 activates, a latched task keeps its pinned
v1. The pin names the version row, and the projection is stored in the pin.

**Before the model call**, `IdentityPort.authorize`, inside the guarded port next to `faculties.authorize`,
checks all of these:
1. The pin row is unchanged, meaning its digest equals the journaled pin.
2. The task is RUNNING.
3. The pinned version row still exists with the same `id`, and its stored digests equal the pin.
4. SQL `identity_core_digest_v1` of its document equals the pin.
5. Recomputing `projectIdentity(pinnedVersion.document, profile, ceiling)` equals `pin.projection` and
   `projectionDigest`.
6. The outgoing request's `assemblyDigest` equals the recomputed `assembleAnalystRequest` output.

If the pinned version is unavailable or corrupt, the step fails closed (`REQUEST_REJECTED`). **The latest
HEAD is never substituted.**

**Replay and retry** use the same journaled latch and pin, and therefore byte-identical projection and
request bytes.

## 9. `context_digest` (provider-independent) against `request_digest` (historical)

- **`request_digest`** is unchanged, and keeps its meaning: the digest of exactly what one provider call was
  sent, **including provider and model**. It is per-call execution evidence and differs between providers by
  design.
- **`context_digest`** is new. It is the provider-independent digest of the deterministic cognition inputs,
  and it is ADR-0021 D9's `assembly_digest`:

      context_digest = sha256(canonicalStringify({
        "contract": "kerneljson:analyst-context/v1",
        "mission": { "recipe", "question", "contractDigest": sha256(canonicalStringify(missionContract)),
                     "repo", "factsDigest" },
        "faculty": { "id", "version", "digest" },
        "identity": null | { "mode": "REQUIRED", "identityCoreDigest", "projectionProfile", "projectionDigest" },
        "memory": null | { "assemblyDigest": <P5 contextDigest, task-id-free> },
        "messagesDigest": sha256(canonicalStringify(request.messages))
      }))

  `messagesDigest` covers only the system and user message bytes: no call, task or step id, trace, timestamp
  or provider. For NONE, `identity` is `null`.
- **It excludes** provider, model, task UUID, step or call ids, trace ids, timestamps, attempt numbers and all
  other nondeterministic execution metadata.
- **Provider and model** are recorded separately and immutably in the same evidence record (the existing
  `provider`, `model` and `response_model` fields).
- **Output hashes are never compared across providers.**

## 10. Evidence and completion

**Analyst runtime evidence** gains:
- `identity`: `null`, or `{identity_id, identity_version_id, identity_version, identity_core_digest,
  class_a_digest, projection_profile, projection_digest}`;
- `identity_cognition_mode`: `NONE` or `REQUIRED`;
- `assembly_digest`;
- `context_digest`.

**Reviewer runtime evidence** gains `identity_cognition_mode: "NONE"` and `context_digest`, and **must not**
carry an `identity` object.

**`verifyIdentityEvidence`** (pure, in `identity/evidence-verify.ts`) is called in `Ledger.write` beside
`verifyFacultyEvidence`, with the **database** latches and pins:
- **Every mission task bound at or after the P7B-1 epoch** must have exactly one analyst latch.
- **REQUIRED:** the analyst evidence `identity` equals the pin field for field; `mode` is REQUIRED;
  `assembly_digest` recomputes as described in section 5.
- **NONE:** no identity pin, and analyst evidence `identity` is `null`.
- **Never:** an identity pin on a non-analyst step, or identity metadata on reviewer evidence.
- **On any mismatch:** a `CompletionVerificationError`, and the task ends FAILED.

## 11. B5: G2 alert semantics

Every check uses the existing alerting standard: HealthStatus, then an explicit row in
`services/kernel/src/alerting/policy.ts`, then the existing episode, notify and recovery lifecycle. There is
**no generic P2 fallback**; a P7B-1 test asserts each id below has an explicit row.

- **UNKNOWN because the database is unreachable** stays P3 and defers to the database domain, as today.
- **UNKNOWN because there is no observation** is recorded as `NO_OBSERVATION` and mapped explicitly to **P3
  with `notify:false`**. It is visible, never paged, and never presented as broken identity.

**A. Canonical identity and store invariants.** These are observable whether cognition is on or off, and
none of them depends on cognition having run.

| Check | Invariant | Data source | HEALTHY | Incident | NO_OBSERVATION | Recovery / debounce | Severity |
|---|---|---|---|---|---|---|---|
| `identity.completedTasksHaveActivation` | every COMPLETED identity-change task has an activation (D8) | `tasks` joined to `identity_activations` | none missing | any missing: CRITICAL | never; zero identity tasks is HEALTHY | recovers when none missing; no grace (atomic since P7A) | **P1** |
| `identity.profilesHaveActivatedIdentity` | every profile has an activated identity | `identity_profiles` joined to `identity_activations` | none missing past grace | missing past 10 min: DEGRADED | never | the existing 10 min grace | **P2** |
| `identity.currentDigestParity` | for every version, stored digests equal SQL `identity_core_digest_v1` | `identity_versions` plus the SQL function | all equal | any differs: CRITICAL | never; zero versions is HEALTHY | recovers only when equal; durable, so no flapping | **P1** |
| `identity.singleCurrentPerTenant` | at most one current identity per tenant | `identity_current` grouped by tenant | at most one | more than one: CRITICAL | never | durable | **P0** |
| `identity.headEqualsCurrent` | head version = current version for each identity | `identity_head` against `identity_current` | equal | differs: CRITICAL | never | durable | **P1** |

**B. Cognition-binding invariants.** These legitimately report NO_OBSERVATION until a qualifying execution
exists.

| Check | Invariant | Data source | Observation condition | HEALTHY | Incident | NO_OBSERVATION | Recovery / debounce | Severity |
|---|---|---|---|---|---|---|---|---|
| `identity.analystRunsBound` | every REQUIRED analyst latch has an identity pin, runtime evidence equal to the pin, a pinned version whose SQL v1 digest equals the pin, and a recomputed projection digest equal to the pin | latches, pins, evidence, `identity_versions` | at least one REQUIRED latch exists | all bound and equal | any unbound or unequal: CRITICAL | no REQUIRED latch ever (including while OFF): P3, notify off | durable evidence rows; recovers only when every REQUIRED record verifies | **P0**: a model received identity bytes not provably governed |
| `identity.verifierIsolated` | no reviewer evidence carries identity; no identity pin on a non-analyst step; no NONE-latched analyst carries identity | evidence, pins, latches | at least one mission runtime record at or after the P7B-1 epoch | none violated | any violation: CRITICAL | no mission since P7B-1: P3, notify off | durable | **P1** |

- **Feature OFF can never raise P0 or P1 by itself.** Group B reports NO_OBSERVATION or HEALTHY while OFF.
  Group A is independent of the switch and alarms only on a real store fault.
- **Seriousness is graded.** A digest mismatch against identity actually consumed (`analystRunsBound`) is P0;
  store parity with nothing consumed is P1; absence of a first cognition observation is P3 with no
  notification.
- **Each check ships with its negative case**, a deliberately broken input that must produce the incident
  status, and with the `smoke.py --selftest`-style assertion.

## 12. Testing and mutations (planned for P7B-1)

- **Golden fixtures:** the OFF byte-equality fixtures and the ON determinism fixtures (section 5), and the
  shared digest corpus (section 7).
- **Real Postgres:**
  - the migration's parity trigger and pre-COMMIT assertion against Kernel v1;
  - latch immutability and the latch/pin consistency trigger;
  - pin contents;
  - `identity_cognition_source_v1`;
  - ACLs (no PUBLIC, anon or authenticated privilege on the new table, function or trigger function), using
    the Supabase default-ACL regression from PR #47.
- **Real Restate end to end:**
  - an OFF mission is byte-identical;
  - an ON mission is bound;
  - an env flip mid-mission changes nothing for a latched task;
  - a v2 activation mid-mission leaves the pinned v1 in use;
  - replay reproduces the same bytes;
  - a missing or corrupt pinned version fails closed;
  - over-cap fails before the provider call.
- **Behavioural mutations, each killed by its own test:**
  - remove the parity trigger;
  - skip the pre-COMMIT v1 assertion;
  - skip DB parity at pin time;
  - read the env instead of the latch at completion or replay;
  - fall back to NONE when REQUIRED cannot pin;
  - substitute HEAD for the pinned version at call time;
  - truncate instead of refusing over the cap;
  - project Class D or `presentation`;
  - give the reviewer a projection;
  - drop the identity metadata from evidence;
  - skip `verifyIdentityEvidence`;
  - insert the identity block in a second place or position;
  - remove each G2 policy row (caught by the explicit-row test).
- **Topology mutations:** the six injections in section 6.

## 13. G5: cross-provider proof

- **In CI:** two fake providers, the same mission. Required equal: identity pin digests, `projection_digest`,
  faculty id, version and digest, memory `assemblyDigest`, and `context_digest`. Different: provider, model
  and `request_digest`.
- **Live, in P7B-2:**
  1. Two **fresh** missions, with no shared provider session or history and the same semantic input: the same
     repo at the same head, the same question and contract, and unchanged memory.
  2. **Mission 1** has the analyst route on `deepseek`.
  3. The analyst route is then changed **by config only** to `openrouter`. It is already in the intelligence
     faculty's `providerPreferences`, so there is no faculty swap and no faculty version change.
  4. **Mission 2** runs under the same identity pin version (Kernel v1).
  5. **Pass:** the identity pin fields, `projection_digest`, the faculty pin fields, the memory assembly
     digest and `context_digest` are equal. Each mission's execution evidence proves **which provider and
     model actually ran**: the receipt's provider, model, `response_model` and provider request id.
  6. **Refused as not a proof:** both runs on the same provider. There is no fallback path that could cause
     it (a faculty route is a single pinned provider and model, and `FACULTY_PINNED_ROUTE_UNAVAILABLE`
     refuses rather than falls back), and the proof asserts the two recorded providers differ.
  7. Output text is never compared by hash.

## 14. B6: G13 does not unfreeze Class C/D

- **G13 means only** "P7B live qualification has completed": P7B-2 passed its live proofs.
- **It does not** call `kernel_private.set_identity_freeze(…, false)`, does not add any production C/D policy
  rule, and does not unfreeze Class C/D. **Class C/D remains frozen after P7B PASS.**
- **Any future unfreeze requires** a separate phase and window, explicit human authorisation, its own review
  and its own production evidence.
- **The historical artefact rule.** The applied P7A migration `20260925120000_primary_identity.sql`
  (production blob SHA-256 `85ead096…`) contains comments at lines 347 and 378 implying the P7B G13 window
  opens the freeze:
  - Those comments are **superseded operational guidance and MUST NOT be acted upon**.
  - The file itself is **not edited**. Its exact blob and hash are part of the P7A release evidence, and
    changing it would break provenance.
  - The correction is carried by a dated erratum appended to ADR-0021, by corrected wording in the P7A live
    result record, and by this section.
  - A code comment with the same implication in `services/kernel/src/approval-boundary.ts` (line 161) will be
    corrected in the P7B-1 code PR. It is a comment only, so no behaviour changes.

## 15. Delivery: two windows, default off

1. **P7B-1: code and migration, deployed as epoch 13**, with `KJ_IDENTITY_COGNITION_ENABLED=false`.
   - The migration adds the digest twin, parity trigger, pre-COMMIT v1 assertion, latch table and source
     function, with the full Supabase ACL qualification.
   - After deploy, a controlled mission proves the analyst request bytes are byte-identical to `4127361`.
   - The G2 group A checks are live; group B reports NO_OBSERVATION.
   - Class C/D is still frozen.
2. **P7B-2: separate authorisation.**
   - The env is turned on for **new** analyst latches only. In-flight tasks are unaffected by the latch.
   - One bound mission; the G2 negative proofs; the G5 live cross-provider pair; then G13 closes P7B.
   - **Class C/D is still frozen.**

## 16. Decisions that close revision 1's open questions

| Revision 1 question | Decision |
|---|---|
| 1. Scope of the analyst projection | the section 3 allow-list: Class A all six, Class C persona/communication/behaviour, no Class D, no `presentation` |
| 2. Placement | the section 5 order: faculty header, then the identity block, then the task contract (system); user message unchanged |
| 3. Switch granularity | a worker env switch, **latched durably per analyst step** (section 4); the latch is the auditable ledger record |
| 4. G5 provider pair | two fresh missions with a config-only route change and a provider-difference assertion (section 13) |
| 5. Severity | the section 11 tables (P0 is consumed-identity mismatch and multiple current identities) |
