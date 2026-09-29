# ADR-0022: KJ-P7B, identity projection and cognition binding

Status: PROPOSED, revision 3 (design only).
- Revision 1 (`e962bbd`) was BLOCKED by Grok's hostile review (B1 to B6 and the G1/G3/G4/G5 conditions).
- Revision 2 (`868cabb`) closed B1, B3, B4, B5, B6, G1 and G5.
- This revision closes the remaining blockers: B2.a (the tenant FK), B2.b (the latch ACL and writer), B2.c
  (the release, replay and completion oracle, all in section 4), and NB1 (D9 digest naming, section 9).
- No implementation-critical question is deferred.

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

`KJ_IDENTITY_COGNITION_ENABLED` (worker env, `true|false`, default `false`) is read **at most once per analyst
step**, inside the latch transaction and only when no latch row exists. No decision path reads it
anywhere else: not completion, not replay, not authorisation. The health CLI only displays it (section 4.8a)
and decides nothing from it.

### 4.1 The latch table, tenant-bound (B2.a)

The latch uses the same tenant authority pattern as `faculty_pins` and `identity_pins`: composite foreign
keys, never JSON self-consistency.

    create table kernel_private.identity_cognition_latches (
      tenant_id     uuid        not null,
      task_id       uuid        not null,
      step_id       uuid        not null,
      mode          text        not null check (mode in ('NONE','REQUIRED')),
      release_epoch bigint      not null check (release_epoch > 0),
      latched_at    timestamptz not null default clock_timestamp(),   -- audit only, never ordering
      primary key (task_id, step_id),
      foreign key (task_id, tenant_id) references public.tasks(id, tenant_id),
      foreign key (step_id, task_id)   references public.task_steps(id, task_id),
      foreign key (task_id, tenant_id, release_epoch)
        references kernel_private.execution_bindings(task_id, tenant_id, release_epoch),
      foreign key (release_epoch) references kernel_private.release_activations(epoch)
    );

- The P7B migration adds `unique (task_id, tenant_id, release_epoch)` to `kernel_private.execution_bindings`
  as the composite FK target. `task_id` is already its primary key, so the constraint cannot reject an
  existing row; it exists only so the FK can be declared.
- A latch's tenant is therefore the task's tenant **and** the binding's tenant, and its `release_epoch` is the
  binding's epoch (section 4.4). None of them can disagree with the task.
- There is **no `release_id` column**. Release truth has one source (section 4.4).
- A BEFORE INSERT guard, `kernel_private.identity_cognition_latch_guard()` (security invoker,
  `search_path = ''`), refuses with `23514` unless:
  1. `kernel_private.identity_cognition_contract_v1` has its row, and
     `NEW.release_epoch >= first_release_epoch` (`IDENTITY_LATCH_PRE_CONTRACT`). Legacy tasks cannot be
     latched.
  2. A `public.faculty_pins` row exists for the same `(task_id, step_id)` with `faculty_id = 'intelligence'`
     (`IDENTITY_LATCH_NOT_ANALYST`). Identity reads the persisted faculty pin here and never writes it (B4).
- **Planned real-Postgres negative test:** the correct `task_id` and `step_id` with another tenant's
  `tenant_id` must be refused by the `(task_id, tenant_id)` FK (SQLSTATE `23503`, named constraint).

### 4.2 One worker write path and its ACL (B2.b)

There is **no SECURITY DEFINER latch writer**. The worker inserts the latch with a plain `INSERT` from its
pooled connection, inside the same transaction that writes the identity pin. This is the same model as
`faculty_pins` and `identity_pins`. No other application write path exists.

Explicit ACLs, never ambient Supabase defaults:

    alter table kernel_private.identity_cognition_latches enable row level security;
    revoke all on kernel_private.identity_cognition_latches from public, anon, authenticated, service_role;
    grant usage on schema kernel_private to service_role;
    grant select, insert on kernel_private.identity_cognition_latches to service_role;
    create trigger identity_cognition_latches_immutable before update or delete
      on kernel_private.identity_cognition_latches for each row execute function public.reject_ledger_mutation();
    create trigger identity_cognition_latches_no_truncate before truncate
      on kernel_private.identity_cognition_latches for each statement execute function public.reject_ledger_mutation();

- Every new function (the guards and the consistency function) has EXECUTE revoked from public, anon,
  authenticated and service_role.
- **Required ACL tests**, run in the production-shaped default-ACL harness from PR #47:
  - PUBLIC, anon and authenticated have no privilege of any kind on the latch table;
  - service_role has SELECT and INSERT true, and UPDATE, DELETE and TRUNCATE false;
  - the harness recreates Supabase's `service_role` with BYPASSRLS, as in production;
  - because `USAGE` on `kernel_private` is new for service_role, a test enumerates **every** relation,
    sequence and function in `kernel_private`. service_role must hold no privilege on any of them except
    SELECT/INSERT on the latch and SELECT on the contract marker (section 4.5).
- **Immutability applies to every role.** UPDATE, DELETE and TRUNCATE are refused by
  `reject_ledger_mutation` triggers, which fire for the table owner too.
- **Which role the worker uses (INFERRED, to verify in P7B-1).** The worker already inserts into
  `kernel_private.execution_bindings`. That table and schema were never granted to service_role, so the worker
  evidently connects as the owning role.
  - The P7B-1 PR records the production worker's `current_user` with a read-only query. CI then exercises the
    latch path as that role.
  - If it is the owner, grants do not bind it. Its ceiling is the immutability triggers and the constraint
    triggers in section 4.3. The service_role grant above remains the exact ceiling for any non-owner service
    path.

### 4.3 The latch and pin invariant in final transaction state

For every analyst `(task_id, step_id)`, at COMMIT:

| Latch | `identity_pins` rows | Result |
|---|---|---|
| REQUIRED | exactly one | valid |
| NONE | zero | valid |
| REQUIRED | zero | invalid |
| NONE | one | invalid |
| none | one | invalid (a pin without a REQUIRED latch) |

The check is also tenant-consistent: `identity_pins.tenant_id = latch.tenant_id`. Both are already FK-bound to
`tasks(id, tenant_id)`, and the check restates it.

- It is enforced by `kernel_private.identity_latch_pin_consistency()`, called from two
  `CONSTRAINT TRIGGER … AFTER INSERT … DEFERRABLE INITIALLY DEFERRED FOR EACH ROW` triggers:
  - one on `kernel_private.identity_cognition_latches`;
  - one on `public.identity_pins`, added by the P7B migration. The P7A migration file is not edited.
- Each re-reads both tables for the row's `(task_id, step_id)` at COMMIT. Latch and pin can therefore be
  created in either order inside one transaction, and neither survives COMMIT alone.
- INSERT is the only insertion surface. UPDATE, DELETE and TRUNCATE are refused on both tables.
- The migration asserts before COMMIT that `public.identity_pins` holds zero rows (true in production:
  nothing writes it yet), so no existing row can violate the new invariant.
- **Required tests.** Each negative must fail **at COMMIT** with the invariant's own SQLSTATE and message.
  Each test first asserts the migration applied and the triggers exist, so no apply or syntax failure can
  count as a pass.
  - REQUIRED with a pin: COMMIT succeeds.
  - NONE with no pin: COMMIT succeeds.
  - REQUIRED with no pin: COMMIT fails.
  - NONE with a pin: COMMIT fails.
  - A pin with no latch: COMMIT fails.
  - A cross-tenant pair: fails.

### 4.4 Release provenance: `release_epoch`, one source of truth (B2.c)

- Canonical task release provenance already exists: `kernel_private.execution_bindings.release_epoch`,
  stamped by `stamp_binding_provenance()` at binding time.
- The latch stores `release_epoch`. The composite FK in 4.1 makes the **database** enforce
  `latch.release_epoch = execution_bindings.release_epoch` for the same task. A TypeScript object cannot
  supply a different value.
- A task with no execution binding cannot be latched.
- When a person needs the release id, it is resolved, never copied:

      execution_bindings.release_epoch  ->  release_activations.epoch  ->  release_activations.release_id

### 4.5 The contract-start marker

"Tasks bound under P7B" is defined by one immutable database row, not by prose or a timestamp:

    create table kernel_private.identity_cognition_contract_v1 (
      singleton           boolean     primary key default true check (singleton),
      contract            text        not null check (contract = 'kerneljson:identity-cognition/v1'),
      first_release_epoch bigint      not null references kernel_private.release_activations(epoch),
      created_at          timestamptz not null default clock_timestamp()
    );

- There is at most one row: the singleton primary key.
- The table is immutable through the `reject_ledger_mutation` UPDATE/DELETE/TRUNCATE triggers, and RLS is on.
- ACLs: all privileges are revoked from public, anon, authenticated and service_role, then SELECT alone is
  granted to service_role. The worker reads it for the oracle and never writes it.
- **The migration inserts no row.** The epoch is not guessed as "current + 1".
- A BEFORE INSERT guard refuses (`23514`) unless `NEW.first_release_epoch` equals the current value of
  `kernel_private.release_epoch`. The marker can only name the epoch activated in the same transaction, never
  a past epoch. Marking a past epoch would retroactively turn legacy tasks into contract tasks.
- It authorises nothing. It is only the immutable compatibility boundary used by the completion and replay
  oracle. `activate_release` remains the only release authority.

**Atomic P7B-1 activation.** It runs while ingress is quiesced, as the operator role that already runs
`activate_release`:

    BEGIN;
      select kernel_private.activate_release(<request uuid>, '<P7B-1 release sha>', 12, <evidence>);  -- returns 13
      insert into kernel_private.identity_cognition_contract_v1(contract, first_release_epoch)
        values ('kerneljson:identity-cognition/v1', <returned epoch>);
      -- verify: one marker row; first_release_epoch = returned epoch = release_epoch.epoch;
      --         release_activations(<returned epoch>).release_id = <P7B-1 release sha>
    COMMIT;

- If either statement or the verification fails, both roll back and production stays at epoch 12 with no
  marker.
- `activate_release` holds the `release_epoch` row lock until COMMIT, and `stamp_binding_provenance` takes
  that same lock. So no binding can be stamped with the new epoch before the marker exists.
- **Retry.** `activate_release` returns the existing epoch for the same request id. The retry script inserts
  the marker only if no row exists. If a row exists with the same epoch, that is success; with a different
  epoch, it aborts.

### 4.6 Latch creation, and why the database row is canonical

The **database latch row is canonical**. The Restate `ctx.run` result is durable replay material, never a
second source of truth.

Latch creation runs in `ctx.run("identity:<analyst step>:latch")`, after the faculty pin. It is one database
transaction:

1. Take `pg_advisory_xact_lock(hashtext('identity-latch:<task>:<step>'))`.
2. Read `execution_bindings.release_epoch` and the contract marker.
   - If there is no marker, or the binding epoch is below `first_release_epoch`, the task is **legacy**.
     Nothing is written, the env is not read, and `{legacy: true, releaseEpoch}` is returned.
3. If a latch row exists, return the exact persisted row. **The env is not read.**
4. Otherwise:
   - read the env once;
   - insert a NONE latch, or insert the identity pin (section 8) and a REQUIRED latch;
   - COMMIT, then return the persisted row as re-read after the insert.

**Before any provider invocation**, `IdentityPort.authorize` re-reads the database:

- It re-derives legacy against non-legacy from `execution_bindings` and the marker.
- It re-reads the latch, and the pin for REQUIRED.
- The journaled value must equal the database row field for field. **If they disagree, it fails closed.**
- A non-legacy task with no latch row **fails closed**.
- A task the database says is legacy but whose journal holds a latch, or whose latch row exists, **fails
  closed**.

If the journal is lost and the `ctx.run` body executes again, step 3 finds the row. The database wins and the
env is not re-read.

None of these can relatch NONE to REQUIRED or REQUIRED to NONE:

| Event | Why it cannot relatch |
|---|---|
| env flip | the env is read only when no row exists |
| worker restart | the row is persisted |
| Restate replay | the journal must equal the row |
| lost journal | the row is found first |
| later release | the row and its epoch are immutable |

**Legacy composition.** A legacy task's analyst request is built by the same assembler on the NONE path, so
it is byte-identical to `4127361` (section 5).

### 4.7 The completion oracle

In `Ledger.write`, `verifyIdentityEvidence` receives the database facts. The rule:

    binding_epoch        = execution_bindings.release_epoch for the task
    contract_start_epoch = identity_cognition_contract_v1.first_release_epoch   (absent: no contract)

    no marker, or binding_epoch < contract_start_epoch
        -> LEGACY: the analyst step must have NO latch and no identity pin, and analyst evidence carries no
           identity; completion follows the pre-P7B contract
    binding_epoch >= contract_start_epoch
        -> the analyst step must have EXACTLY ONE latch; missing -> CompletionVerificationError
           (then section 10's REQUIRED/NONE rules apply)

- **Never used:** timestamps, environment values, the current process's release id, "current release"
  guesses, or Restate journal state.
- A task with no execution binding is legacy by construction: it cannot have a latch. Its release provenance
  is governed by the existing release-provenance checks, unchanged by P7B.

### 4.8 Rollback and drain

The chosen, stricter rule:

- **Before activating any release that does not implement `kerneljson:identity-cognition/v1`** while the
  marker exists, there must be **zero non-terminal tasks whose `execution_bindings.release_epoch >=
  first_release_epoch`**, whatever their latch mode.
- Safety is never inferred from the env being OFF. A REQUIRED task stays REQUIRED after the switch is turned
  off.
- **Epochs are monotonic.** Tasks bound while rolled back get epochs at or above `first_release_epoch`, but
  the rolled-back code writes no latches. If P7B-capable code later completes them, the oracle refuses them:
  it fails closed, never open.
  - So **rolling forward** onto a P7B-capable release after such a rollback also requires zero non-terminal
    tasks bound at the rolled-back epochs.
  - That drain protects availability. Safety already holds, because the oracle errs closed.
- Both drains are added to the release-rollback checklist as queries against `execution_bindings`, `tasks`
  and the marker.

### 4.8a Observability without secrets

- The env value is non-secret.
- The health CLI reports the worker's current enablement for **new** work, the marker's `first_release_epoch`,
  and the count of latches by mode.
- The env value is read with the existing allow-listed `printenv`.
- P7B-1 requires adding the variable to `execution.compose.yaml`'s environment allowlist and to
  `runtime_env_merge.py` `PUBLIC_KEYS` (`^(true|false)$`).

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
- **Returns** `{ request, requestBytes, assemblyDigest, continuityDigest }`:
  - `requestBytes = canonicalStringify(request)` (ADR-0021 D3 canonical form) of the **full** `ModelRequest`,
    which is handed unchanged to `ModelPort.generate`. It exists for deterministic regression (the OFF-mode
    golden fixtures) and request construction.
    - `requestBytes` is **not** "what the model sees". The full request includes envelope fields (`callId`,
      `taskId`, `stepId`, `trace`).
    - The provider adapter receives the full `ModelRequest` internally but serialises only the
      provider-visible fields outward. For the chat-completions adapter
      (`packages/models/src/chat-completions.ts`) those are `model`, `messages`,
      `max_tokens = maxOutputTokens`, `stream` and any provider-specific extra body.
  - `assemblyDigest = sha256(canonicalStringify({ messages: request.messages, maxOutputTokens:
    request.maxOutputTokens }))`. This is **ADR-0021 D9's `assembly_digest`**: the provider-neutral cognitive
    assembly only (section 9.2);
  - `continuityDigest`, the provider-independent `continuity_digest` (section 9.3).
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
- the analyst's runtime evidence records `assembly_digest` and `continuity_digest`;
- `IdentityPort.authorize` (section 8) recomputes `assembleAnalystRequest` from the pinned inputs and requires
  `assemblyDigest(outgoing request) = the recomputed assemblyDigest`;
- completion verification requires the evidence's `assembly_digest` to equal the digest recomputed, by the
  section 9.2 formula, from the `messages` and `maxOutputTokens` of the request that `callModel` actually
  sent for that call. The receipt's `request_digest` keeps its existing meaning: it is recomputed from the
  same full request and the recorded provider and model.

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

**Replay and retry** use the canonical database latch and pin (section 4.6). The journal must equal them,
which gives byte-identical projection and request bytes.

**Pin validation to be widened in the implementation PR (not done in this design commit).** The P7A
`identity_pins` CHECK requires only `tenantId`, `taskId`, `stepId`, `identityId`, `identityVersion` and
`identityCoreDigest`. The P7B-1 migration must add a new CHECK, and the Zod/contract validation must match, so
that every one of the following keys is required:
- `tenantId`, `taskId`, `stepId`;
- `identityId`, `identityVersionId`, `identityVersion`;
- `identityCoreDigest`, `classADigest`, `digestContract`;
- `projectionSchema`, `projectionProfile`, `projection`, `projectionBytes`, `projectionDigest`;
- `facultyId`, `facultyVersion`, `facultyDigest`;
- `mode`.

It must also enforce:
- `mode = 'REQUIRED'`;
- `digestContract = 'kerneljson:identity-core/v1'`;
- `projectionSchema = 'kerneljson:identity-projection/v1'`;
- `projectionProfile = 'ANALYST_INTELLIGENCE_V1'`;
- `projectionBytes <= 16384`.

The new CHECK goes in the new migration; the P7A migration file is not edited.

## 9. Digest taxonomy, the D9 mapping and `continuity_digest`

### 9.1 One meaning per name

| Name | Exactly one meaning |
|---|---|
| `identity_core_digest` | the immutable canonical identity document (`kerneljson:identity-core/v1`) |
| `class_a_digest` | the immutable canonical Class A section |
| `projection_digest` | the exact bounded IdentityProjection (`kerneljson:identity-projection/v1`) |
| P5 memory assembly digest | the exact authorised canonical memory assembly: P5's existing `contextDigest` in `services/memory/src/canonical/assembler.ts`, task-id-free. This is its historical name and it is **not** reused for anything else |
| `assembly_digest` | **ADR-0021 D9's `assembly_digest`**: the provider-neutral, model-visible cognitive assembly, `messages` + `maxOutputTokens` |
| `continuity_digest` | the broader provider-independent G5 continuity contract (`kerneljson:analyst-continuity/v1`) |
| `request_digest` | the existing per-call receipt digest over provider, model and the full `ModelRequest`, as currently defined in `models.ts` |

There are no aliases between these names. P7B introduces no new digest called `context_digest`.

### 9.2 `assembly_digest` is D9's `assembly_digest`

    assembly_digest = sha256(canonicalStringify({
      "messages":        request.messages,
      "maxOutputTokens": request.maxOutputTokens
    }))

- **Contract meaning.** `assembly_digest` is ADR-0021 D9's evidence-bound digest of the exact
  provider-neutral cognitive assembly presented for generation. It covers the system and user messages, which
  carry the faculty header, the identity block, the task contract, the question, memory and facts, plus the
  output budget.
- **It excludes** `callId`, `taskId`, `stepId`, `trace`, provider, model, timestamps and attempt ids. Those are
  execution and routing envelope metadata, not identity or context assembly. Of them, only `model` reaches the
  provider HTTP body, and it is recorded separately.
- **What stays as it is.** The full `ModelRequest` is unchanged and is still passed to `ModelPort.generate`.
  This revision changes no `ModelRequest` contract. `request_digest` keeps its per-call execution meaning and
  continues to bind provider, model and the full `ModelRequest` exactly as the existing receipt contract
  defines.
- **It is evidence-bound.** `IdentityPort.authorize` recomputes it from the outgoing request before the
  provider call, and completion re-verifies it from the request `callModel` actually sent (section 5).
- **`assembly_digest` MUST match across the two G5 providers** (section 13). Identical deterministic inputs
  produce identical messages and output budget, whichever provider runs. That match is the literal discharge
  of ADR-0021 D9.
- `continuity_digest` is never called the D9 assembly digest.

### 9.3 `continuity_digest`

It is the richer provider-independent proof that all deterministic cognition inputs matched across fresh
executions:

    continuity_digest = sha256(canonicalStringify({
      "contract": "kerneljson:analyst-continuity/v1",
      "mission":  { "recipe", "question", "contractDigest": sha256(canonicalStringify(missionContract)),
                    "repo", "factsDigest" },
      "faculty":  { "id", "version", "digest" },
      "identity": null | { "mode": "REQUIRED", "identityCoreDigest", "projectionProfile", "projectionDigest" },
      "memory":   null | { "assemblyDigest": <P5 task-id-free memory assembly digest> },
      "assemblyDigest": <ADR-0021 D9 assembly_digest, section 9.2>
    }))

- It includes the D9 `assemblyDigest` rather than a separate messages digest, because `assembly_digest` is
  itself provider-independent and covers the exact messages and `maxOutputTokens`.
- For NONE and for legacy tasks, `identity` is `null`.
- **Excluded:** provider, model, task id, step id, call id, trace id, timestamps, attempt ids and provider
  request id.
- Provider, model and `response_model` stay recorded separately and immutably in the same evidence record.
- Output hashes are never compared across providers.

## 10. Evidence and completion

**Analyst runtime evidence** gains:
- `identity`: `null`, or `{identity_id, identity_version_id, identity_version, identity_core_digest,
  class_a_digest, projection_profile, projection_digest}`;
- `identity_cognition_mode`: `NONE` or `REQUIRED`;
- `assembly_digest` (D9);
- `continuity_digest`.

**Reviewer runtime evidence** gains only `identity_cognition_mode: "NONE"`, and **must not** carry an
`identity` object.

**`verifyIdentityEvidence`** (pure, in `identity/evidence-verify.ts`) is called in `Ledger.write` beside
`verifyFacultyEvidence`, with the **database** latches and pins:
- **The section 4.7 oracle decides first.** If the task is legacy (no contract marker, or binding epoch below
  `first_release_epoch`), it must have no latch and no identity pin. Otherwise the analyst step must have
  exactly one latch.
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
| `identity.verifierIsolated` | no reviewer evidence carries identity; no identity pin on a non-analyst step; no NONE-latched analyst carries identity | evidence, pins, latches | at least one mission runtime record whose binding `release_epoch >= identity_cognition_contract_v1.first_release_epoch` | none violated | any violation: CRITICAL | no such record, or no contract marker: P3, notify off | durable | **P1** |

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
  - latch immutability; the section 4.1 cross-tenant FK refusal; the section 4.2 ACL matrix and
    `kernel_private` enumeration; the six section 4.3 COMMIT-time cases; the latch guard (pre-contract and
    non-analyst refusals); `release_epoch` FK disagreement refused; the marker's singleton, immutability and
    current-epoch guard; the atomic activation rolling back both on failure;
  - pin contents;
  - `identity_cognition_source_v1`;
  - ACLs (no PUBLIC, anon or authenticated privilege on the new table, function or trigger function), using
    the Supabase default-ACL regression from PR #47.
- **Real Restate end to end:**
  - an OFF mission is byte-identical;
  - an ON mission is bound;
  - an env flip mid-mission changes nothing for a latched task;
  - journal and database disagreement fails closed; a lost journal re-executes and returns the database row
    without reading the env; a non-legacy task without a latch fails closed; a legacy task runs NONE bytes
    with no latch;
  - a v2 activation mid-mission leaves the pinned v1 in use;
  - replay reproduces the same bytes;
  - a missing or corrupt pinned version fails closed;
  - over-cap fails before the provider call.
- **Behavioural mutations, each killed by its own test:**
  - remove the parity trigger;
  - skip the pre-COMMIT v1 assertion;
  - skip DB parity at pin time;
  - read the env instead of the latch at completion or replay;
  - drop the latch tenant FK, the `release_epoch` FK or either deferred constraint trigger;
  - grant UPDATE to service_role on the latch;
  - skip the journal/database equality check;
  - compare against the current release instead of the binding epoch in the oracle;
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

**The G5 comparison set** is used both in CI (two fake providers) and live. It compares only stable
continuity fields. Two fresh missions can never have fully equal pin objects: the faculty pin carries the
route's provider and model, and both pins carry `taskId` and `stepId`.

| Must be equal across Mission 1 and Mission 2 | Fields |
|---|---|
| Identity pin | `tenantId`, `identityId`, `identityVersionId`, `identityVersion`, `identityCoreDigest`, `classADigest`, `digestContract`, `projectionSchema`, `projectionProfile`, `projection`, `projectionBytes`, `projectionDigest`, `facultyId`, `facultyVersion`, `facultyDigest`, `mode` |
| Faculty pin | faculty id, faculty version, `facultyDigest` (the faculty definition digest), `policyVersion`, `operation` (`RUNTIME_ANALYSE`), `routingReason` (`repo-analysis/analyst`) |
| Mission and context | the semantic mission input (recipe, question, contract digest, repo at the same head, facts digest), the P5 memory assembly digest, `assembly_digest` (D9), `continuity_digest` |

| Must differ | Why |
|---|---|
| `taskId`, `stepId` (both pins) | fresh missions |
| provider, model (faculty pin and receipt) | the point of the proof: the live G5 proof requires them to differ |
| `request_digest` | provider, model and the execution envelope differ |

Output digests and text are **not** compared. Each run's `assembly_digest` is also recomputed from its own
actual request (section 5).
- **Live, in P7B-2:**
  1. Two **fresh** missions, with no shared provider session or history and the same semantic input: the same
     repo at the same head, the same question and contract, and unchanged memory.
  2. **Mission 1** has the analyst route on `deepseek`.
  3. The analyst route is then changed **by config only** to `openrouter`. It is already in the intelligence
     faculty's `providerPreferences`, so there is no faculty swap and no faculty version change.
  4. **Mission 2** runs under the same identity pin version (Kernel v1).
  5. **Pass:** every field in the equal set above is equal, including `assembly_digest` and
     `continuity_digest`, and every field in the differ set differs. Each mission's execution evidence proves
     **which provider and model actually ran**: the receipt's provider, model, `response_model` and provider
     request id.
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
   - The migration adds:
     - the digest twin, the parity trigger and the pre-COMMIT v1 assertion;
     - the latch table, its guard, and the latch/pin constraint triggers;
     - the `execution_bindings` composite unique key;
     - the contract-marker table, empty;
     - the widened pin CHECK and the source function.

     It carries the full Supabase default-ACL qualification.
   - Activation is the single atomic transaction in section 4.5: `activate_release` returns 13, and the
     `identity_cognition_contract_v1` marker is written with `first_release_epoch = 13`. Ingress is quiesced
     throughout.
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

## Erratum, 29/09/2026: D1, call-time assembly binding (implementation discovery)

The sealed design is `2dd2af5909b8fc49d208834ba9d2a99148ba5daa`. This erratum does not rewrite it. It
corrects one impossibility found by the KJ-P7B-1 precondition review.

**What is wrong in the text above.**
- Sections 5 and 10 say completion verification recomputes `assembly_digest` (and `request_digest`) from the
  exact `ModelRequest` that `callModel` sent.
- That request is intentionally not persisted: only Restate journals it.
- Persisting it would copy canonical-memory text into immutable evidence and break P5 retract semantics.
- Rebuilding it at completion would make `Ledger` and evidence verification import memory and identity
  assembly, which B4 (section 6) forbids.
- Where sections 5, 8 and 10 conflict with this erratum, the erratum governs.

**Decision: call-time binding plus a completion cross-check.** The full `ModelRequest`, its messages and
memory text are never persisted. The corrected contract:

1. **Build.** `assembleAnalystRequest` constructs the exact `ModelRequest`.
2. **Authorise.** Immediately before the provider is invoked, `IdentityPort.authorize` recomputes the
   following and verifies it against the exact outgoing request object:

       assembly_digest = sha256(canonicalStringify({
         messages: request.messages,
         maxOutputTokens: request.maxOutputTokens
       }))

3. **Call.** `callModel` receives that exact request.
4. **Receipt.** The existing `validateModelResult` (`packages/models/src/port.ts`) continues to prove that
   `receipt.requestDigest == modelDigest({ provider: receipt.provider, model: receipt.model, request })`. So
   `request_digest` remains the binding of the complete `ModelRequest`, provider and model.
5. **Bind.** The existing `callModel(..., record)` hook, a no-op in the mission today, persists an immutable
   `MODEL_CALLED` call-binding record through the ledger after the provider result has been validated.
   - Its payload holds only non-secret provenance and digests, at minimum: `task_id`, `step_id`, `call_id`,
     `provider`, `model`, `request_digest`, `assembly_digest` and `continuity_digest`.
   - It must **not** hold the `ModelRequest`, messages, memory text, identity projection text beyond what is
     already deliberately pinned (section 8), credentials, or provider request bodies.
   - It is written for the analyst call of every contract task (section 4.7), in both NONE and REQUIRED
     mode. Legacy tasks write none and keep their pre-P7B completion contract.
6. **Evidence.** The analyst runtime evidence carries the same `call_id`, `request_digest`,
   `assembly_digest` and `continuity_digest`, plus the identity cognition provenance (section 10).
7. **Completion.** Completion verification does **not** reconstruct the prompt. From persisted database state
   it verifies:
   - exactly one applicable `MODEL_CALLED` binding exists for the analyst call;
   - the runtime evidence's `call_id`, `request_digest`, `assembly_digest` and `continuity_digest` each equal
     that binding's;
   - the runtime identity provenance equals the canonical latch and pin;
   - the NONE, REQUIRED and reviewer-isolation rules (sections 4.7 and 10) still hold.
8. **Purity.** `verifyIdentityEvidence` stays pure. It consumes persisted latch, pin, evidence and model-call
   binding data only. It must not import the memory assembler, the identity projection assembler, the analyst
   prompt builder or `ModelPort`.
9. **Authority.** `Ledger` remains the completion authority. The `MODEL_CALLED` record is evidence and a
   binding, not authority.
10. **P5 retract semantics.** They stay intact because only digests and identifiers are durable. Retracted
    memory content is never copied into immutable model-call evidence.

**D9.** ADR-0021 D9 remains satisfied. The evidence-bound `assembly_digest` is computed and verified against
the exact outgoing request at call time, then durably recorded. Completion verifies that durable binding and
does not pretend to reconstruct prompt bytes that no longer exist.

**What completion proves.** It does not prove the request from scratch. It proves that:
1. the exact outgoing request was authorised before the call;
2. its `assembly_digest` was bound to the immutable model-call record;
3. the provider receipt's `request_digest` matched that exact full request;
4. the final runtime evidence refers to those same immutable call bindings;
5. the identity provenance still matches the canonical latch and pin.

**Planned tests (added to section 12):**
- changing one byte of an outgoing system or user message changes `assembly_digest`, and so does changing
  `maxOutputTokens`;
- call-time `authorize` sees the exact request object passed to `ModelPort.generate`;
- the `MODEL_CALLED` binding receives that same `assembly_digest`, and the validated receipt's
  `request_digest` binds that same full `ModelRequest`;
- completion refuses runtime evidence whose `assembly_digest`, `call_id`, `request_digest` or
  `continuity_digest` differs from the `MODEL_CALLED` binding;
- no prompt text or memory text appears in the `MODEL_CALLED` payload;
- a P5 memory retraction needs no mutation of immutable model-call evidence.

**Implementation clarifications from the same review.** These are not design changes.
- **Alert notification.** `AlertPolicyEntry` gains a backward-compatible per-status and per-severity
  notification policy, `notifyFor(status, severity)`, and the existing `notify` semantics are kept.
  `identity.analystRunsBound` then tracks UNKNOWN/NO_OBSERVATION at P3 without notifying, while a real P0
  still notifies.
- **Correction to section 11.** Today the two P7A identity checks have no policy rows, so an unreachable
  database raises **no** identity alert. "Stays P3, as today" was inaccurate. All seven identity checks now
  map database-unreachable UNKNOWN explicitly to P3 with notification off, deferring to the database domain.
- **Faculty pins in contract tasks.** When the cognition contract applies but no valid `intelligence` faculty
  pin exists, the step fails closed. No identity latch may bypass faculty authority (the section 4.1
  guard).
- **Contract marker in tests.** Tests write it only in disposable test databases, through a real
  `activate_release`. The migration still creates the table empty.
- **Replay tests.** P7B-1 uses the established journal-simulated replay and lost-journal pattern
  (`tests/mission-workflow.integration.test.ts`) together with the existing identity-workflow Restate test. A
  full live-Restate mission proof, if needed, belongs to a later qualification window.
