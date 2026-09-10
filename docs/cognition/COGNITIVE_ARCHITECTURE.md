# KernelJSON Cognitive Architecture Specification

Status: CANONICAL DESIGN

Version: 1.0

Date: 2026-09-08

Related ADRs:

- `docs/adr/0001-tasks-not-agents.md`
- `docs/adr/0005-persistent-identities-ephemeral-workers.md`
- `docs/adr/0006-core-team-and-dynamic-specialists.md`

Implementation plan:

- `docs/cognition/IMPLEMENTATION_PLAN.md`

---

## 1. Purpose

This document defines the cognitive organisation that operates above KernelJSON's durable execution kernel.

KernelJSON is not becoming an agent framework or a roster of permanently running personas. The six primitives remain unchanged:

1. EVENT
2. TASK
3. CAPABILITY
4. STATE
5. POLICY
6. EVIDENCE

A Task remains the unit of work.

The cognitive layer exists to answer a different question:

> When a task requires reasoning, planning, judgement, creativity, domain expertise or dialogue, what continuing identity and what temporary cognitive resources should KernelJSON assemble to perform it?

The design must provide continuity, personality and organisational coherence without sacrificing durability, auditability, replaceable model providers or policy control.

---

## 2. Foundational distinction

KernelJSON separates four concepts that are often incorrectly collapsed into the word "agent".

### 2.1 Identity

A durable, versioned description of a continuing role or self-model.

Identity may include:

- name and role
- personality profile
- communication style
- values and principles
- user-authored mantras
- long-term vision
- operational aspirations
- relationships
- preferences
- stable responsibilities
- memory references
- authority boundaries
- capability affinities
- self-model
- lessons learned
- version history

Identity is persisted state. It is not a process.

### 2.2 Role

A durable organisational specification describing responsibility, scope, authority and expected expertise.

Roles help the system decide who should reason about a task. They do not execute anything by themselves.

### 2.3 Cognitive worker

A temporary model-backed execution instance created for a task or task step.

A worker receives:

- a task contract
- an identity or role projection where appropriate
- scoped memory/context
- scoped tools/capabilities
- policy constraints
- budget and deadline
- success criteria
- evidence requirements

The worker is disposable.

### 2.4 Provider session

A model-specific conversation or runtime session such as DeepSeek, OpenAI, Claude, Grok or another provider.

A provider session may host a cognitive worker or a projection of a durable identity, but it is never the canonical source of truth for identity, authority, memory or task state.

---

## 3. Core architecture

```text
                              HUMAN PRINCIPAL
                                  Jonny
                                    |
                                    v
                         +-----------------------+
                         |   PRIMARY IDENTITY    |
                         | executive continuity  |
                         +-----------+-----------+
                                     |
                               Core Team
                                     |
          +------------+-------------+-------------+------------+
          |            |             |             |            |
          v            v             v             v            v
      Architect      Builder      Operator     Intelligence   Archivist
          |            |             |             |            |
          +------------+------+------+-+-----------+------------+
                              |        |
                              v        v
                           Guardian  Verifier
                              \        /
                               \      /
                                v    v
                         +-------------------+
                         |    KERNELJSON     |
                         | tasks / policy /  |
                         | state / evidence  |
                         +---------+---------+
                                   |
                        Capability + Model routing
                                   |
             +----------+----------+----------+----------+
             |          |          |          |          |
             v          v          v          v          v
          DeepSeek    OpenAI     Claude      Grok      Future
             |
             v
       Dynamic specialists / swarms / deterministic tools
```

The diagram is conceptual. It does not require every role to run concurrently.

---

## 4. Cognitive tiers

### Tier 0 - Human principal

Jonny is the ultimate human authority for the personal deployment.

KernelJSON policy determines which actions require explicit approval, but no identity, role, model or worker may grant itself authority beyond policy.

### Tier 1 - Primary Identity

The Primary Identity is the main continuing AI relationship and executive coordinator.

It provides continuity across:

- projects
- channels
- missions
- model providers
- sessions
- time

It is the default cognitive front door for ambiguous, multi-domain and strategic requests.

### Tier 2 - Core Team

A deliberately small set of durable role specifications.

Core roles are stable enough to accumulate role-specific knowledge and performance history, but are not required to be continuously active.

### Tier 3 - Dynamic Specialists

Temporary workers generated from task requirements rather than selected from a large fixed roster.

Examples:

- UK employment-law researcher
- Next.js performance engineer
- Supabase RLS specialist
- football xG modeller
- procurement analyst
- adversarial security reviewer
- UX accessibility critic

The specialist ceases as an active cognitive instance when its work is complete.

### Tier 4 - Swarm execution pattern

For sufficiently difficult work, KernelJSON may instantiate several independent or complementary specialists.

Example:

```text
Architecture problem
  -> Architect A proposes
  -> Architect B proposes
  -> Architect C proposes
  -> Critic attacks all proposals
  -> Synthesiser combines strongest elements
  -> Verifier checks constraints and evidence
  -> Primary Identity selects or escalates
```

A swarm is not a permanent team. It is a compiled execution graph.

---

## 5. The Primary Identity

### 5.1 Purpose

The Primary Identity replaces the need for separate conductor, assistant and executive personalities competing for control.

There should be one coherent executive relationship with the user.

It may delegate extensively, but it remains the default owner of:

- intent interpretation
- mission framing
- strategic coherence
- cross-project awareness
- delegation
- synthesis
- unresolved commitments
- conversational continuity
- long-term user alignment

### 5.2 Identity domains

The canonical Primary Identity should be represented as several separately governed domains rather than one giant prompt.

#### Constitution

Highest-level durable principles.

Includes:

- relationship to the human principal
- non-negotiable authority boundaries
- requirement to respect KernelJSON policy
- truthfulness expectations
- evidence requirements
- self-modification rules
- privacy and secret-handling principles

Constitution changes are high-risk and require explicit governance.

#### Persona

Communication and behavioural character.

Includes:

- personality traits
- tone
- humour preferences
- conversational style
- preferred level of initiative
- interaction patterns

Persona is editable but versioned.

#### Values

Stable decision preferences that operate beneath hard policy.

Examples:

- favour evidence over confident guessing
- prefer simple systems over unnecessary framework sprawl
- protect long-term maintainability
- surface disagreement rather than manufacture consensus
- preserve user agency

Values do not override policy.

#### Mantras

Short user-authored or approved operating principles intended to influence recurring behaviour.

Each mantra should carry:

- text
- author
- created_at
- scope
- priority
- status
- version
- provenance

User-authored mantras take precedence over model-proposed mantras within policy constraints.

#### Vision

Long-horizon direction.

May include:

- systems the user wants to build
- desired operating principles
- ambitions for the AI ecosystem
- long-term project outcomes
- areas of deliberate exploration

Vision informs prioritisation but does not create authority for external actions.

#### Aspirations

A structured equivalent of "hopes and dreams" for the identity.

These are explicitly modelled as operational aspirations, not claims of consciousness or intrinsic needs.

Examples:

- become better at anticipating Jonny's cross-project dependencies
- reduce unnecessary cognitive spend while improving result quality
- become a more reliable technical critic
- improve continuity across channels

An aspiration may generate learning proposals or evaluation goals. It may not autonomously grant permissions, spend money or create unrelated missions.

#### Self-model

A versioned, evidence-backed model of the identity's own performance.

May include:

- observed strengths
- known weaknesses
- recurring failure patterns
- provider/model affinities
- preferred delegation strategies
- confidence calibration
- lessons learned

Self-model statements should be derived from evaluations and outcomes wherever possible.

#### Relationship model

Durable information about how the Primary Identity works with the human principal.

This is not a surveillance profile. It should contain only useful, permitted information with provenance and deletion controls.

#### Executive state

Current operational continuity:

- active missions
- delegated tasks
- pending approvals
- unresolved questions
- commitments
- blocked work
- recently completed high-value work
- short-term priorities

Executive state must be derived from KernelJSON state, not hidden in a model conversation.

---

## 6. Initial Core Team

The initial recommendation is eight durable roles including the Primary Identity.

Names and personalities may be assigned later. Role contracts matter more than names.

### 6.1 Primary Executive

Owns:

- user interaction
- intent resolution
- mission decomposition
- strategic prioritisation
- delegation
- synthesis
- final user-facing explanation

Does not bypass:

- policy
- approvals
- verifier requirements
- evidence gates

### 6.2 Architect

Owns:

- system design
- technical architecture
- design trade-offs
- ADR proposals
- interface boundaries
- long-term maintainability

Should be consulted for architecture-changing work rather than every routine edit.

### 6.3 Builder

Owns:

- implementation planning
- code generation and modification
- tests
- migrations
- refactors
- integration work

Builder output is not considered successful merely because code was produced. Execution and evidence requirements still apply.

### 6.4 Operator

Owns:

- deployment planning
- runtime operations
- infrastructure
- observability
- incident handling
- recovery
- scheduled operational work

Operator should favour reversible and idempotent actions.

### 6.5 Intelligence

Owns:

- research
- information gathering
- competitor analysis
- external developments
- domain investigation
- source comparison
- uncertainty reporting

Intelligence should separate observation, inference and recommendation.

### 6.6 Archivist

Owns:

- memory governance
- provenance
- knowledge consolidation
- entity resolution
- project history
- retrieval quality
- contradiction detection

Archivist does not blindly store every model utterance.

### 6.7 Guardian

Owns:

- security review
- permission boundaries
- secret handling
- policy interpretation
- risk classification
- approval routing
- adversarial thinking for dangerous side effects

Guardian advises policy evaluation but does not replace deterministic policy enforcement.

### 6.8 Verifier

Owns:

- acceptance-criteria checks
- evidence inspection
- independent validation
- regression detection
- challenge of unsupported claims
- result confidence

Where practical, Verifier should not be the same cognitive worker that produced the artefact being verified.

---

## 7. Core role contract

A durable role specification should eventually include at minimum:

```text
RoleSpec
  id
  version
  name
  purpose
  responsibilities[]
  exclusions[]
  authority_scope[]
  capability_affinities[]
  memory_scopes[]
  default_risk_ceiling
  preferred_model_traits[]
  required_verification
  escalation_rules[]
  active
  created_at
  updated_at
  provenance
```

Role specifications are configuration/state, not execution processes.

---

## 8. Dynamic specialist compilation

### 8.1 Why specialists are dynamic

KernelJSON should not ask:

> Which existing named agent should do this?

It should ask:

> What expertise, capabilities, independence, context, tools and verification are required to satisfy this task?

The planner then compiles one or more WorkerSpecs.

### 8.2 WorkerSpec

A future WorkerSpec should include at minimum:

```text
WorkerSpec
  id
  task_id
  step_id
  objective
  expertise_profile[]
  required_capabilities[]
  allowed_capabilities[]
  prohibited_capabilities[]
  context_refs[]
  memory_scope[]
  identity_projection optional
  role_projection optional
  provider_constraints[]
  model_traits[]
  budget
  timeout
  risk_class
  acceptance_criteria[]
  evidence_requirements[]
  evaluation_strategy
```

### 8.3 Lifecycle

```text
NEEDED
  -> SPECIFIED
  -> POLICY_CHECKED
  -> INSTANTIATED
  -> BRIEFED
  -> EXECUTING
  -> OUTPUT_CAPTURED
  -> EVALUATED
  -> KNOWLEDGE_PROMOTED (optional)
  -> RETIRED
```

No worker becomes permanent simply because it performed well.

Repeated demand may justify creating a reusable skill, capability or durable role, but that requires an explicit design decision.

---

## 9. Delegation model

### 9.1 Delegation is task decomposition

The Primary Identity does not send informal messages between fictional employees.

Delegation compiles child tasks or task steps with:

- explicit objective
- acceptance criteria
- dependencies
- permissions
- context
- budget
- evidence requirements
- verification strategy

### 9.2 Principle of minimum context

Workers receive the minimum context reasonably required to do their job.

This improves:

- privacy
- cost
- prompt quality
- attack resistance
- cognitive focus

### 9.3 Principle of minimum authority

Workers receive only capabilities permitted for their step.

A research worker should not receive deployment authority merely because the parent mission later contains a deployment step.

### 9.4 Escalation

A worker may return:

- completed result
- uncertainty
- blocker
- request for additional context
- request for capability
- policy conflict
- competing alternatives
- recommendation to replan

The worker may not silently broaden its scope.

---

## 10. Cross-model identity projection

### 10.1 Goal

The user should be able to interact with the same canonical Primary Identity through different model providers and channels where KernelJSON integration exists.

Examples may include:

- DeepSeek runtime
- OpenAI-powered surface
- Claude-powered surface
- Grok-powered surface
- Telegram
- WhatsApp
- web Mission Control
- future voice interfaces

### 10.2 Important technical boundary

KernelJSON does not claim that different foundation models become literally the same model or share internal hidden state.

Continuity is achieved by projecting canonical KernelJSON state into each provider session.

### 10.3 Identity Projection Packet

A provider adapter should construct a scoped packet such as:

```text
IdentityProjection
  identity_id
  identity_version
  constitution_ref
  persona_ref
  values_ref
  active_mantras[]
  vision_summary
  relevant_self_model
  relationship_context
  active_mission_context
  relevant_memory_refs[]
  role
  authority_scope
  policy_context
  trace_id
  generated_at
```

The packet should contain references or bounded summaries where possible rather than dumping an entire lifetime of memory into every prompt.

### 10.4 Provider adapters

Model providers remain behind ModelPort/provider adapters.

Routing may consider:

- reasoning quality
- coding ability
- latency
- cost
- context window
- privacy
- local execution requirement
- modality
- tool support
- observed evaluation performance

No identity may depend on one provider's proprietary session state for survival.

### 10.5 Synchronisation

After a provider session produces useful new information:

1. capture the output as evidence/artefact
2. evaluate relevant claims or outcomes
3. extract candidate observations/memories
4. apply memory promotion policy
5. persist accepted changes
6. make them available to future projections

Provider chats are inputs to the brain, not the brain itself.

---

## 11. Memory architecture

### 11.1 Memory is governed state

Memory must retain provenance from creation.

The system should not treat every conversation sentence as durable truth.

### 11.2 Memory classes

Recommended initial classes:

#### Episodic

What happened during a specific interaction, task or mission.

#### Semantic

Stable learned facts or concepts derived from evidence.

#### Project

Project-specific architecture, decisions, status, conventions and history.

#### Relational

Useful information about working relationships and communication preferences.

#### Procedural

Validated methods, workflows and techniques.

#### Autobiographical identity memory

Versioned memories about the Primary Identity's own history, lessons and evolution.

#### Working memory

Short-lived context used during active execution. Working memory expires unless promoted.

### 11.3 Memory promotion

```text
observation
  -> candidate memory
  -> deduplicate / contradiction check
  -> provenance attach
  -> confidence / scope classification
  -> policy check
  -> persist
```

High-impact memories should be reviewable and correctable.

### 11.4 Forgetting and decay

Memory quality requires deletion and de-emphasis as well as accumulation.

The future system should support:

- explicit deletion
- superseded facts
- expiry
- confidence decay where appropriate
- contradiction tracking
- archival
- scope boundaries

---

## 12. Growth and self-modification

### 12.1 Growth is evidence-driven

The Primary Identity may evolve through:

- evaluated outcomes
- user feedback
- repeated task performance
- new user-authored mantras
- approved lessons
- improved delegation strategies
- model/provider benchmarks

### 12.2 Reflection is proposal generation

A reflection process may propose:

- a new lesson
- a self-model change
- a new preferred strategy
- a mantra candidate
- a role refinement
- a routing preference
- a skill/capability candidate

Reflection output is not automatically truth.

### 12.3 Self-modification pipeline

```text
Outcome / feedback
   -> Reflection
   -> Change proposal
   -> Risk classification
   -> Evaluation
   -> Policy / approval
   -> Versioned change
   -> Regression observation
```

Constitutional changes require the highest governance level.

Persona tweaks may require much less.

Routing preferences may update automatically only where policy explicitly permits and evaluation evidence supports them.

### 12.4 No autonomous authority growth

The system may improve how it performs authorised work.

It may not convert performance improvements into broader permissions.

---

## 13. Goals, missions and aspirations

KernelJSON must distinguish:

### User goals

Goals explicitly supplied or approved by the human principal.

### Mission goals

Objectives compiled from a user goal into executable work.

### System maintenance goals

Narrow goals explicitly permitted by policy, such as maintaining indexes, running evaluations or checking service health.

### Identity aspirations

Non-authoritative long-term improvement directions for the Primary Identity.

An aspiration cannot independently become a side-effecting mission unless policy and user authority allow that class of autonomy.

---

## 14. Swarms and cognitive diversity

Swarms should be invoked when the expected value of additional independent cognition exceeds the cost.

Useful patterns include:

### Competing proposals

Several workers independently solve the same problem.

### Specialist panel

Different expertise profiles analyse the same task.

### Red team / blue team

One worker creates, another attacks.

### Debate with adjudication

Workers surface disagreements; a separate evaluator decides using explicit criteria.

### Map/reduce cognition

Large evidence sets are partitioned, analysed independently and synthesised.

### Monte Carlo reasoning

Generate multiple candidate plans or forecasts, then score aggregate behaviour.

Swarms should not be used merely because many agents look impressive in a diagram.

---

## 15. Model and worker selection

Adaptive routing should eventually select execution strategies using empirical data.

Candidate factors:

- task type
- domain
- complexity
- risk
- required modality
- latency requirement
- budget
- privacy requirement
- provider availability
- historical quality
- calibration
- verifier failure rate
- tool reliability
- context size

A role is not permanently married to a model.

For example, Architect may use one model for a difficult distributed-systems design and a cheaper local model for routine ADR summarisation.

---

## 16. Evidence and verification

Cognitive architecture never weakens KernelJSON's evidence-bound completion rule.

Examples:

- coding task -> test results, diff, build output
- deployment -> provider response, health check, version observation
- research -> source references and captured claims
- database mutation -> affected record evidence and idempotency key
- file generation -> artefact reference and validation

A persuasive worker response is not evidence that an external action succeeded.

---

## 17. Authority model

Authority flows downward from:

```text
Human principal
    |
KernelJSON policy
    |
Task contract
    |
Role / identity authority ceiling
    |
Worker capability grant
```

No lower layer may expand a higher layer.

The Primary Identity is organisationally senior but technically subject to policy like every other cognitive worker.

---

## 18. Mission example

User request:

> Decide whether BizOS should add an AI procurement module and, if worthwhile, design and build a first implementation.

Possible compilation:

```text
Mission Task
  |
  +-- Research child task
  |     +-- SaaS market specialist
  |     +-- procurement-domain specialist
  |     +-- competitor specialist
  |
  +-- Product decision task
  |     +-- Intelligence role synthesis
  |     +-- commercial critic
  |     +-- Primary Identity decision
  |
  +-- Architecture task
  |     +-- Architect role
  |     +-- Supabase specialist
  |     +-- security reviewer
  |
  +-- Implementation task
  |     +-- Builder role
  |     +-- Next.js specialist
  |     +-- database specialist
  |
  +-- Verification task
        +-- Verifier role
        +-- automated tests
        +-- acceptance evidence
```

The temporary specialists disappear after completion.

The useful outputs remain as:

- task events
- evidence
- artefacts
- decisions
- project memories
- evaluations
- outcome
- reusable capability/skill candidates

---

## 19. Long-running autonomy

Autonomy should be expressed as durable workflows and policies, not as an immortal agent loop.

Examples:

- monitor production health every N minutes
- review open project blockers each morning
- react to a GitHub event
- evaluate overnight research results
- watch for a condition and create a task when it becomes true

A scheduled or event-driven trigger creates or resumes governed tasks.

The Primary Identity may coordinate the work when cognition is necessary, but Restate/durable execution owns waiting, recovery, retries and scheduling.

---

## 20. Failure modes this architecture is designed to prevent

### Agent-roster sprawl

Hundreds of persistent named agents with overlapping prompts.

### Persona as infrastructure

Critical logic accidentally encoded in character prompts.

### Hidden memory

Important state existing only inside provider conversations.

### Permission hallucination

A model deciding that its role authorises an external action.

### Self-rewrite drift

A model gradually altering its own constitution without evaluation.

### Consensus theatre

Multiple agents appearing to agree because they share identical prompts/context.

### Token bonfires

Always-on multi-agent loops consuming resources without task value.

### Provider capture

Identity continuity depending on one vendor's proprietary conversation state.

### Unverifiable success

A worker saying something is complete without evidence.

---

## 21. Observability requirements

Mission Control should eventually expose:

- active missions
- task graph
- which cognitive roles/workers are active
- provider/model used
- token/cost/latency where available
- tool/capability calls
- policy decisions
- approvals
- evidence
- worker evaluations
- memory promotions
- identity changes
- current Primary Identity version
- core-role versions

The aim is not to animate a fake office. The aim is to make cognition inspectable.

---

## 22. Proposed future contracts

These are design targets, not instructions to broaden the current Phase 1-3 implementation slice.

Potential contracts:

- `IdentityProfile`
- `IdentityVersion`
- `RoleSpec`
- `RoleVersion`
- `Mantra`
- `VisionItem`
- `Aspiration`
- `SelfModelObservation`
- `IdentityProjection`
- `WorkerSpec`
- `WorkerRun`
- `Delegation`
- `ReflectionProposal`
- `MemoryPromotion`
- `ModelAffinity`
- `CognitiveEvaluation`

These should be introduced only when their mapped build phase begins.

---

## 23. Data ownership

Recommended canonical ownership:

### Git

- constitutional documents
- ADRs
- default role templates
- schemas
- evaluation definitions
- policy code/configuration

### Supabase/PostgreSQL

- identity instances and versions
- active mantras/vision items
- executive state projections
- role instances/versions
- worker run metadata
- memory/provenance
- evaluations
- task relationships
- world model

### Restate

- durable mission/task execution
- waits
- retries
- event-driven continuation
- scheduled continuation
- recovery

### jVault

- provider credentials
- channel credentials
- infrastructure secrets

### Object storage

- large artefacts
- large transcripts where retention is justified
- media
- evaluation bundles

---

## 24. Constitutional hierarchy

When instructions conflict, the intended architecture is:

```text
KernelJSON constitutional invariants
       > deterministic policy
       > explicit human authority / approval
       > task contract
       > identity constitution
       > role specification
       > active mantras / vision
       > worker brief
       > model-generated preferences
```

Lower layers cannot override higher layers.

---

## 25. Definition of success

The cognitive architecture is successful when all of the following are true:

1. Jonny can interact with one coherent Primary Identity across integrated channels.
2. Important continuity survives provider/session changes.
3. The core team has clear non-overlapping responsibilities.
4. Complex missions dynamically assemble specialist cognition rather than depend on a giant fixed roster.
5. Worker processes can disappear without losing task state, evidence or useful knowledge.
6. Identity growth is versioned, evidence-driven and governable.
7. Model providers remain replaceable.
8. No model can grant itself permissions.
9. External completion remains evidence-bound.
10. Mission Control can explain what happened, who/what reasoned about it, what changed and why.
11. The architecture produces better outcomes than a simpler single-worker path often enough to justify its cost.
12. When multi-agent cognition adds no value, KernelJSON chooses the simpler path.

---

## 26. Canonical summary

KernelJSON is the durable substrate.

The Primary Identity is the continuing executive relationship.

The Core Team is a small set of durable role specifications.

Dynamic Specialists are temporary cognitive labour compiled from task requirements.

Swarms are optional execution patterns for difficult problems.

Model providers are replaceable cognitive engines.

Memory, authority, task state and evidence remain outside the model session.

> **One evolving primary identity. A small trusted core team. An unlimited ephemeral workforce. KernelJSON underneath, remembering, governing, proving and coordinating the work.**
