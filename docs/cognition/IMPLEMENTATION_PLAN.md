# KernelJSON Cognitive Architecture Implementation Plan

Status: PLANNED

Version: 1.0

Date: 2026-09-08

This plan implements the design in `docs/cognition/COGNITIVE_ARCHITECTURE.md` without disrupting the current Phase 1-3 Codex handoff.

The existing build order remains authoritative. Cognitive implementation should begin only when the underlying contracts, persistence, durable execution, policy, evidence, memory and world-model foundations exist.

---

## 1. Immediate rule

Do **not** broaden the current Codex Phase 1-3 slice.

Current work remains:

- Phase 1 - typed contracts
- Phase 2 - Supabase persistence foundation
- Phase 3 - deterministic Restate TaskWorkflow

The cognition documents are architecture commitments for later phases, not permission to add a large agent framework now.

---

## 2. Phase mapping

The cognitive architecture maps primarily onto the existing KernelJSON build phases:

| KernelJSON phase | Cognitive work |
| --- | --- |
| 4 - Kernel compiler/planner/executor | delegation primitives and worker-plan hooks |
| 5 - ModelPort and DeepSeek | provider-neutral cognitive execution |
| 6 - capability layer | scoped capabilities for workers |
| 7 - policy and approvals | role/worker authority ceilings |
| 8 - evidence and verification | independent cognitive verification |
| 9 - golden E2E | first model-backed governed task |
| 10 - memory fabric | identity memory and memory promotion |
| 11 - world model | relationship/project/context grounding |
| 12 - evaluation | worker, provider and routing evaluations |
| 13 - Mission Control | cognitive visibility and identity controls |
| 14 - adaptive routing | model/worker/core-role selection |
| 15 - autonomous workflows | primary executive + core team coordination |

---

# STAGE A - Foundations before identity

## Goal

Prove KernelJSON can safely execute and verify tasks before introducing a continuing AI identity.

## Prerequisites

- typed Task/TaskStep/Event/Evidence contracts
- durable Restate workflow
- task/event persistence
- capability registry
- policy decisions and approvals
- evidence-bound completion
- ModelPort abstraction

## Acceptance

- deterministic task survives runtime restart
- model-backed step can execute behind ModelPort
- model cannot self-authorise capabilities
- task cannot complete without required evidence

No Primary Identity implementation is required yet.

---

# STAGE B - Cognitive execution primitive

Target: around Phases 4-6.

## Goal

Create the smallest provider-neutral way for a task step to request cognition.

## Add

### WorkerSpec contract

Fields:

- id
- taskId
- stepId
- objective
- expertiseProfile[]
- requiredCapabilities[]
- allowedCapabilities[]
- prohibitedCapabilities[]
- contextRefs[]
- memoryScope[]
- identityProjection optional
- roleProjection optional
- providerConstraints[]
- modelTraits[]
- budget
- timeout
- riskClass
- acceptanceCriteria[]
- evidenceRequirements[]
- evaluationStrategy

### WorkerRun metadata

Capture:

- workerSpecId
- provider
- model
- start/end time
- trace
- token/cost data where available
- tool/capability calls
- output refs
- evaluator result

## Runtime rule

`AGENT_LOOP` remains a TaskStep execution kind.

Do not introduce a separate agent scheduler.

## Acceptance

- one task can compile a WorkerSpec
- ModelPort executes it
- output is captured as an artefact/evidence candidate
- worker disappears without loss of durable task state

---

# STAGE C - Role specifications

Target: around Phases 7-9.

## Goal

Represent the Core Team as durable configuration rather than running processes.

## Add contracts

- RoleSpec
- RoleVersion
- RoleProjection

## Seed initial role templates

1. Primary Executive
2. Architect
3. Builder
4. Operator
5. Intelligence
6. Archivist
7. Guardian
8. Verifier

## Each role defines

- purpose
- responsibilities
- explicit exclusions
- authority ceiling
- preferred capability classes
- memory scopes
- preferred model traits
- escalation rules
- verification requirements

## Policy integration

Policy decision inputs should be able to consider:

- principal
- task risk
- capability
- role
- worker grant

Role may restrict authority but never expand policy authority.

## Acceptance

- role projections are versioned
- a Builder cannot acquire Operator capabilities unless the task/policy explicitly grants them
- Guardian advice cannot directly mutate deterministic policy
- Verifier can run independently from producer

---

# STAGE D - Primary Identity v1

Target: Phase 10, after memory fabric exists.

## Goal

Create a continuing executive identity without placing canonical state in a model conversation.

## Add contracts/state

### IdentityProfile

- id
- name
- status
- ownerPrincipal
- currentVersion

### IdentityVersion

Versioned domains:

- constitution ref
- persona ref
- values ref
- role ref
- provenance

### Mantra

- id
- identityId
- text
- author
- scope
- priority
- status
- version
- provenance

### VisionItem

- id
- identityId
- objective
- horizon
- scope
- status
- provenance

### Aspiration

- id
- identityId
- text
- improvementMetric optional
- status
- provenance

### IdentityProjection

Bounded provider-ready projection of identity + current mission context.

## Initial behaviour

The Primary Identity should:

- receive user intent
- query relevant project/executive memory
- compile/delegate tasks
- synthesize results
- maintain unresolved commitments from durable state

## Explicitly defer

- automatic persona rewriting
- automatic mantra creation
- broad self-generated missions
- emotional-state simulation as system state
- autonomous constitutional changes

## Acceptance

- start a conversation through provider A
- complete durable work
- start a fresh provider B session
- generate a projection from KernelJSON
- provider B can correctly recover relevant identity/project/mission continuity without provider A session history

---

# STAGE E - Memory and executive continuity

Target: Phases 10-11.

## Goal

Give the Primary Identity long-term continuity with governed memory.

## Add memory classes

- working
- episodic
- semantic
- project
- relational
- procedural
- autobiographical identity

## Add memory promotion pipeline

1. candidate observation
2. source/provenance capture
3. deduplication
4. contradiction check
5. confidence classification
6. scope classification
7. policy check
8. persistence

## Executive state projection

Maintain queryable projections for:

- active missions
- delegated tasks
- pending approvals
- blockers
- commitments
- unresolved questions
- short-term priorities

Do not use the model context window as the authoritative to-do list.

## Acceptance

- important fact survives session/provider reset
- stale or superseded fact is identifiable
- memory points back to provenance
- user correction supersedes conflicting model-derived memory
- working memory expires unless promoted

---

# STAGE F - Dynamic specialist factory

Target: Phases 11-12.

## Goal

Compile specialist cognition from task requirements instead of using a fixed roster.

## Planner additions

The planner determines:

- required expertise
- number of independent workers
- role involvement
- provider/model requirements
- context scope
- tool grants
- budget
- verification strategy

## Specialist lifecycle

`NEEDED -> SPECIFIED -> POLICY_CHECKED -> INSTANTIATED -> BRIEFED -> EXECUTING -> OUTPUT_CAPTURED -> EVALUATED -> RETIRED`

## Reuse logic

Repeated successful specialist patterns may generate proposals for:

- reusable prompt template
- skill
- deterministic capability
- durable role addition

No automatic promotion to permanent role.

## Acceptance

- two unrelated tasks generate meaningfully different WorkerSpecs
- specialists cannot access out-of-scope memory/capabilities
- specialist outputs can be evaluated independently
- worker process removal causes no loss of promoted knowledge

---

# STAGE G - Reflection and identity growth

Target: Phase 12.

## Goal

Allow the Primary Identity and core roles to improve without uncontrolled self-rewrite.

## Add

- ReflectionProposal
- SelfModelObservation
- IdentityChangeProposal
- evaluation linkage

## Reflection triggers

Examples:

- repeated verifier failures
- strong positive user feedback
- task class consistently routed poorly
- repeated delegation failure
- major project outcome
- explicit user request to update mantra/personality/vision

## Change classes

### Low risk

- provider preference based on benchmarks
- delegation heuristic
- communication preference

### Medium risk

- role responsibility adjustment
- memory retrieval strategy
- self-model claim

### High risk

- identity constitution
- authority boundary
- policy-adjacent behaviour
- long-term autonomous goal class

## Acceptance

- reflection creates a proposal, not a direct mutation
- changes are versioned
- rejected changes leave an audit record
- high-risk changes require explicit approval
- regression evaluation can roll back or supersede a change

---

# STAGE H - Swarms and adversarial cognition

Target: Phases 12-14.

## Goal

Use multiple cognitive workers only where empirical value justifies it.

## Initial patterns

- competing proposals
- creator + critic
- red team + defender
- domain panel
- map/reduce research
- synthesiser + verifier

## Routing requirement

Planner must support a single-worker baseline.

The evaluation system should compare swarm outcome against:

- cost
- latency
- quality
- verifier pass rate
- uncertainty/calibration

## Acceptance

- swarm graph is explicit in task steps
- disagreement is retained
- final synthesis cites source worker/evidence
- system can decide not to use a swarm

---

# STAGE I - Adaptive cognitive routing

Target: Phase 14.

## Goal

Choose model, worker count, role involvement and verification depth from measured performance.

## Evaluation dimensions

- task type
- domain
- risk class
- quality score
- acceptance pass rate
- verifier failure rate
- latency
- cost
- tool reliability
- context length
- provider availability
- privacy/locality constraint

## Routing outputs

- deterministic only
- single model call
- one specialist
- core role projection
- several specialists
- swarm
- human escalation

## Acceptance

- routing decision is traceable
- system can explain why a provider/strategy was selected
- fallback works when preferred provider is unavailable
- budget limits are respected

---

# STAGE J - Cross-channel and cross-provider incarnation

Target: Phases 13-15 depending on integrations.

## Goal

Make the Primary Identity available through multiple integrated surfaces while retaining one canonical KernelJSON identity.

## Adapter flow

```text
channel event
 -> IntentEnvelope
 -> resolve principal/tenant
 -> retrieve identity
 -> build scoped IdentityProjection
 -> execute through selected provider
 -> capture output/evidence
 -> persist accepted memory/state changes
 -> respond through channel
```

## Candidate surfaces

- DeepSeek VM runtime
- web gateway
- Mission Control
- Telegram
- WhatsApp
- Claude integration where supported
- OpenAI integration where supported
- Grok integration where supported

## Important limitation

A consumer chat application that is not connected to KernelJSON cannot automatically share canonical KernelJSON state. Cross-model continuity requires an integration path such as API, MCP/plugin/tool, gateway or another authorised connector.

## Acceptance

- same identity version visible across integrated channels
- channel-specific presentation can vary without changing canonical identity
- provider outage does not erase executive continuity
- memories created through one integrated channel can be retrieved through another after promotion

---

# STAGE K - Mission Control cognition UI

Target: Phase 13 and later enhancement.

## Goal

Give Jonny direct visibility and control over the cognitive organisation.

## Views

### Primary Identity

- current identity version
- persona
- values
- active mantras
- vision
- aspirations
- self-model
- recent approved changes

### Core Team

- role definitions
- role versions
- recent usage
- performance
- authority ceilings

### Active cognition

- mission graph
- active workers
- provider/model
- budgets
- current step
- evidence
- evaluator status

### Memory

- newly promoted memories
- contradictions
- provenance
- corrections/deletion controls

### Governance

- pending identity changes
- policy approvals
- high-risk autonomy requests

The UI should show real task/runtime state, not decorative animated agents.

---

# STAGE L - Autonomous workflows

Target: Phase 15.

## Goal

Allow the system to run approved recurring/event-driven work with executive coordination where cognition adds value.

## Examples

- production health watch
- overnight project summary
- market/news research workflows
- repository maintenance
- evaluation sweeps
- business operations checks

## Architecture

Autonomy is expressed as:

- event trigger
- schedule
- condition
- durable workflow
- task contract
- policy

Not as an infinite autonomous agent loop.

## Acceptance

- workflow survives restart
- budget/risk ceilings enforced
- user can inspect, pause or cancel
- external side effects require policy/evidence
- Primary Identity may coordinate but does not own scheduling durability

---

## 3. Suggested database additions when their phases arrive

Do not add these during the current Phase 1-3 slice unless a later implementation handoff explicitly authorises them.

Possible tables:

- identities
- identity_versions
- identity_mantras
- identity_vision_items
- identity_aspirations
- roles
- role_versions
- worker_specs
- worker_runs
- worker_evaluations
- reflection_proposals
- identity_change_proposals
- self_model_observations
- memory_promotions
- model_affinities

All should be tenant/principal scoped as appropriate and retain provenance/versioning.

---

## 4. Evaluation programme

Before calling the cognitive layer successful, build evaluation suites for:

### Identity continuity

Can the system recover the right context after model/provider/session replacement?

### Delegation quality

Does decomposition improve acceptance rate versus a single worker?

### Core-role usefulness

Does involving Architect/Verifier/etc. measurably improve the relevant task class?

### Specialist quality

Does dynamic expertise selection beat generic worker prompts?

### Swarm value

Do additional workers justify their cost?

### Memory precision

Does retrieval surface relevant, non-stale, provenance-backed context?

### Growth safety

Do self-improvement proposals actually improve future evals without identity drift?

### Calibration

Are confidence and escalation behaviour aligned with observed correctness?

---

## 5. Golden cognitive scenarios

Add these gradually as the necessary phases exist.

### Scenario 1 - coding delegation

Primary -> Architect -> Builder -> Verifier.

### Scenario 2 - research panel

Primary -> three independent specialists -> synthesiser -> Verifier.

### Scenario 3 - provider failover

Begin with provider A, resume with provider B without loss of canonical state.

### Scenario 4 - memory correction

Model-derived memory conflicts with explicit user correction; user correction wins and provenance remains inspectable.

### Scenario 5 - self-improvement proposal

Repeated routing failures produce a proposal, evaluation and approved routing change.

### Scenario 6 - blocked high-risk action

Senior role requests a capability outside policy; deterministic policy denies or requires approval.

### Scenario 7 - autonomous scheduled mission

Durable trigger creates a task, cognition executes only when needed, restart does not duplicate side effects.

---

## 6. Build discipline

During implementation:

1. never replace a deterministic mechanism with an LLM merely to make it feel agentic
2. never create a new persistent role unless repeated evidence shows it deserves one
3. never make model-provider session state canonical
4. never store memory without provenance
5. never allow role seniority to bypass policy
6. never treat reflection as automatic truth
7. never add a swarm without a single-worker baseline
8. never declare a cross-provider identity integration complete until state genuinely round-trips through KernelJSON
9. never report an autonomous action complete without evidence
10. update `STATE.yaml` only for verified implementation, not design documents

---

## 7. Recommended first cognition implementation slice

When KernelJSON reaches the appropriate point, the first bounded slice should be:

1. implement `WorkerSpec` and `WorkerRun`
2. execute one provider-neutral cognitive TaskStep through ModelPort
3. capture output/evaluation
4. implement `RoleSpec`
5. seed only Architect, Builder and Verifier initially
6. run a coding golden path: Architect -> Builder -> Verifier
7. compare it with a single-worker baseline
8. only then expand toward the full core team

This keeps implementation empirical and prevents speculative agent infrastructure.

---

## 8. Recommended Primary Identity slice

After memory fabric exists:

1. create `IdentityProfile` + `IdentityVersion`
2. define constitution/persona/values as separately versioned domains
3. add user-authored mantras
4. add scoped `IdentityProjection`
5. add project/executive memory retrieval
6. prove provider-session replacement continuity
7. add vision and aspirations
8. add reflection proposals
9. add self-model only after evaluation data exists
10. add cross-channel adapters after the identity works through one gateway

---

## 9. Milestone definitions

### Cognitive M0 - architecture accepted

Complete when:

- ADR-0005 accepted
- ADR-0006 accepted
- cognitive spec exists
- implementation plan exists

### Cognitive M1 - ephemeral worker proven

One cognitive worker runs within a durable task and disappears without losing state.

### Cognitive M2 - core delegation proven

Architect -> Builder -> Verifier golden task passes end to end.

### Cognitive M3 - identity continuity proven

Primary Identity survives provider/session replacement through canonical persisted state.

### Cognitive M4 - governed growth proven

A reflection-generated change proposal is evaluated, approved/rejected and versioned.

### Cognitive M5 - dynamic organisation proven

Planner creates specialists based on task requirements and evaluation data.

### Cognitive M6 - multi-channel continuity proven

Two or more integrated channels share one canonical identity/memory state.

### Cognitive M7 - governed autonomy proven

Approved long-running workflows operate durably with inspectable executive coordination.

---

## 10. End-state target

The finished architecture should feel to the user like a coherent intelligent organisation while remaining technically disciplined underneath:

```text
Jonny
  -> one continuing Primary Identity
       -> small stable Core Team
            -> dynamic specialists when required
                 -> optional swarms for hard problems

All execution
  -> KernelJSON tasks
  -> deterministic policy
  -> scoped capabilities
  -> durable state
  -> provenance-bound memory
  -> evidence
  -> verification
  -> evaluation
  -> learning proposals
```

The desired result is not the largest agent system.

It is the smallest durable cognitive organisation that can expand to the complexity of the mission and collapse back to simplicity when that complexity is no longer needed.
