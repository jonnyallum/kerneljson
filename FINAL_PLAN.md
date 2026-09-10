# KernelJSON Final Canonical Plan

Status: FINAL CANONICAL PLAN

Version: 1.0

Date: 2026-09-09

## 1. Purpose

This document is the master implementation roadmap for KernelJSON.

It consolidates the accepted kernel architecture, cognitive architecture and hardening requirements into one final plan.

Future implementation agents must treat this document and the referenced constitutional/ADR documents as binding. Architectural expansion beyond this plan requires an explicit new human decision and, where appropriate, a new ADR.

This plan does not mean every feature is already implemented. `STATE.yaml` remains the source of truth for verified implementation status.

---

## 2. Mission

Build KernelJSON as a durable cognitive execution platform that can support one continuing Primary Identity, a small stable Core Team, dynamic ephemeral specialists and optional swarms while keeping tasks, authority, memory, evidence and execution outside model-provider sessions.

KernelJSON is not an agent roster.

The six primitives remain:

1. EVENT
2. TASK
3. CAPABILITY
4. STATE
5. POLICY
6. EVIDENCE

Core rule:

> A Task is the primitive. An agent/worker is only one possible execution strategy.

Cognitive rule:

> Identities may persist. Cognitive executions do not.

Context/memory rule:

> Models may reason over canonical state. They do not become canonical state.

---

## 3. Canonical document hierarchy

Read and obey these in this order:

1. `ARCHITECTURE.md` - kernel constitutional invariants
2. `FINAL_PLAN.md` - final master roadmap
3. `STATE.yaml` - verified implementation truth
4. `BUILD_PLAN.md` - phase index
5. `CODEX_HANDOFF.md` - current bounded implementation instructions
6. accepted ADRs under `docs/adr/`
7. `docs/cognition/COGNITIVE_ARCHITECTURE.md`
8. `docs/cognition/IMPLEMENTATION_PLAN.md`
9. cognitive hardening specs

Accepted ADRs currently include:

- `0001-tasks-not-agents.md`
- `0002-durable-execution.md`
- `0003-evidence-bound-completion.md`
- `0004-jvault.md`
- `0005-persistent-identities-ephemeral-workers.md`
- `0006-core-team-and-dynamic-specialists.md`
- `0007-canonical-context-and-memory-boundaries.md`

Cognitive hardening specs:

- `docs/cognition/COGNITIVE_SECURITY.md`
- `docs/cognition/IDENTITY_GOVERNANCE.md`
- `docs/cognition/CONTEXT_ASSEMBLY.md`
- `docs/cognition/COGNITIVE_CONFLICT_PROTOCOL.md`
- `docs/cognition/IDENTITY_BACKUP_AND_RECOVERY.md`

If documents conflict, constitutional invariants and accepted ADRs outrank implementation convenience. `STATE.yaml` describes what exists, not what is merely planned.

---

## 4. Final architecture

```text
Human Principal
     |
     v
Primary Identity
     |
     +---------------- Core Team ----------------+
     | Architect | Builder | Operator | Intelligence |
     | Archivist | Guardian | Verifier              |
     +----------------------------------------------+
                         |
                  task compilation
                         |
            dynamic specialists / swarms
                         |
                         v
                    KERNELJSON
       EVENT / TASK / CAPABILITY / STATE / POLICY / EVIDENCE
                         |
          deterministic tools + model routing
                         |
       DeepSeek / OpenAI / Claude / Grok / future providers
```

The diagram is organisational, not a requirement for always-on processes.

Persistent elements are identity/role/state/configuration. Model-backed worker executions are ephemeral.

---

## 5. Primary Identity

The Primary Identity is the single continuing executive relationship with the human principal.

It replaces competing conductor/assistant/executive personas.

Durable identity domains:

- constitution
- persona
- values
- mantras
- vision
- operational aspirations
- self-model
- relationship model
- executive state

The Primary Identity may coordinate, delegate, synthesise and maintain continuity. It may not bypass deterministic policy, approvals, evidence or verification.

Different foundation models can host projections of the same canonical identity, but no provider session is itself the identity.

---

## 6. Core Team

Initial durable role set:

1. Primary Executive
2. Architect
3. Builder
4. Operator
5. Intelligence
6. Archivist
7. Guardian
8. Verifier

Roles are versioned organisational specifications, not permanent running agents.

Each role defines purpose, responsibilities, exclusions, authority ceiling, capability affinities, memory scope, model traits, escalation rules and verification requirements.

Start implementation empirically with Architect, Builder and Verifier before expanding the full team.

---

## 7. Dynamic specialists and swarms

The planner asks what expertise is required by the task, not which named agent already exists.

Specialists are compiled into `WorkerSpec` objects and retired after execution.

Useful knowledge may be promoted into memory, skills, capabilities or role-change proposals. The worker itself does not become permanent automatically.

Swarms are explicit task graphs used only when evaluation shows value over a simpler baseline.

Supported patterns may include:

- competing proposals
- creator + critic
- red team / defender
- specialist panel
- map/reduce cognition
- synthesis + independent verification

---

## 8. Authority and security

Authority flows downward:

```text
Human principal
  > KernelJSON constitutional invariants
  > deterministic policy
  > explicit approval
  > task contract
  > identity/role authority ceiling
  > worker capability grant
```

No lower layer can expand a higher layer.

Treat cognition as untrusted computation inside this deterministic envelope.

Required protections include:

- prompt-injection boundaries
- memory-poisoning controls
- identity-change governance
- minimum capability grants
- tenant/principal/project isolation
- secret handling through jVault
- evidence-bound external completion
- independent verification where warranted
- provider/skill supply-chain controls
- reflection proposals rather than direct self-rewrite

---

## 9. Context and memory

Canonical identity, memory, task state and authority live outside provider sessions.

Context assembly must:

- apply minimum context
- preserve authority hierarchy
- attach provenance/trust classes
- enforce tenant/principal/project scope
- retain material contradictions
- respect token budgets
- segregate untrusted external content
- avoid projecting unrelated secrets/sensitive memory

Recommended memory classes:

- working
- episodic
- semantic
- project
- relational
- procedural
- autobiographical identity

Memory lifecycle:

```text
observation
 -> candidate
 -> provenance
 -> dedupe/contradiction check
 -> confidence/scope
 -> policy
 -> promotion
 -> supersession/expiry/deletion when needed
```

Explicit user correction takes precedence over conflicting model-derived user facts, while preserving provenance/history.

---

## 10. Conflict and uncertainty

Material disagreement is preserved until resolved by evidence, deterministic validation, adjudication or human authority.

Adjudication ladder:

1. deterministic validation
2. provenance/freshness check
3. acceptance-criteria comparison
4. independent Verifier
5. specialist adjudicator
6. diverse panel/swarm
7. Primary Identity synthesis within authority
8. human decision

The system is allowed to return `INSUFFICIENT_EVIDENCE` or `MATERIAL_CONFLICT` rather than manufacturing confidence.

Verifier rejection blocks completion when verification is required.

---

## 11. Identity growth and governance

Reflection generates proposals, not automatic truth.

Identity change lifecycle:

```text
PROPOSED
 -> CLASSIFIED
 -> EVALUATED
 -> APPROVAL/REJECTION
 -> APPLIED
 -> OBSERVED
 -> SUPERSEDED/ROLLED_BACK if needed
```

High-risk changes include:

- constitution
- authority boundaries
- policy-adjacent behaviour
- broad autonomy classes

These require explicit human approval.

Authority cannot grow as a consequence of good performance.

---

## 12. Backup, recovery and safe mode

The cognitive layer must be recoverable without provider conversation history.

Recovery capabilities should eventually include:

- provider failover
- identity version rollback
- role version rollback
- memory quarantine
- routing rollback
- cognitive snapshots
- safe mode
- full cognitive restore

Safe mode should be able to pin a known-good identity, freeze identity changes, disable memory promotion, restrict providers/specialists and approval-gate external writes.

A backup is not accepted until restore has been tested.

---

## 13. Final implementation phases

### Phase 0 - Repository and architecture bootstrap

Status is determined by `STATE.yaml`.

### Phase 1 - Typed contracts

Implement strict TypeScript/Zod contracts and tests.

### Phase 2 - Supabase persistence foundation

Implement versioned migrations for identity/principal basics, task ledger, evidence, intelligence metadata and world-model foundations. Do not push remote changes without the required review/approval process.

### Phase 3 - Restate durable TaskWorkflow

Prove deterministic durable execution, waits, restart/resume, idempotency and evidence-bound completion before LLM integration.

### Phase 4 - Kernel compiler/planner/executor

Compile intent into typed tasks/steps. Add delegation hooks without a separate agent scheduler.

### Phase 5 - ModelPort + DeepSeek provider

Introduce provider-neutral model execution. DeepSeek is the first provider, not a hard dependency throughout the codebase.

### Phase 6 - Capability layer

Implement scoped capability registry/execution and the first `WorkerSpec`/`WorkerRun` cognitive primitive.

### Phase 7 - Policy and approvals

Enforce deterministic policy, worker/role authority ceilings and approval flows.

### Phase 8 - Evidence and verification

Formalise deterministic evidence capture, verification and independent Verifier paths.

### Phase 9 - Golden end-to-end workflow

Prove the first governed model-backed task. Then prove an Architect -> Builder -> Verifier coding path and compare with a simpler baseline.

### Phase 10 - Memory fabric + Primary Identity v1

Implement governed memory, identity profile/version, mantras and bounded IdentityProjection. Prove continuity across fresh provider sessions.

### Phase 11 - World model + specialist factory

Ground context in entities/relationships/observations and dynamically compile specialists from task requirements.

### Phase 12 - Evaluation + governed growth

Evaluate workers/providers/routing, add reflection proposals, self-model observations and controlled identity change.

### Phase 13 - Mission Control

Expose tasks, evidence, active cognition, identity versions, Core Team, memories, governance proposals, costs and recovery controls.

### Phase 14 - Adaptive routing

Select deterministic/model/specialist/swarm strategies from measured performance, risk, privacy, cost and latency. Implement provider fallback and traceable routing.

### Phase 15 - Governed autonomy

Enable approved scheduled/event-driven/condition-driven durable workflows. The Primary Identity may coordinate cognition, but Restate owns durability, scheduling, waits, retries and recovery.

---

## 14. Cognitive milestones

- **M0 Architecture accepted**: ADRs/specs/final plan committed
- **M1 Ephemeral worker proven**: cognitive worker executes inside durable task and disappears without state loss
- **M2 Core delegation proven**: Architect -> Builder -> Verifier passes golden task
- **M3 Identity continuity proven**: fresh provider/session reconstructs canonical Primary Identity context
- **M4 Governed growth proven**: reflection change evaluated, approved/rejected and versioned
- **M5 Dynamic organisation proven**: specialists compiled from task requirements and evaluations
- **M6 Multi-channel continuity proven**: two+ integrated surfaces share canonical identity/memory
- **M7 Governed autonomy proven**: durable autonomous workflows operate with inspectable authority/evidence

---

## 15. Non-negotiable implementation rules

1. Do not introduce a persistent agent roster.
2. Do not make persona prompts infrastructure.
3. Do not use LangGraph, CrewAI or AutoGen as the runtime architecture.
4. Do not make Supabase the job queue.
5. Do not add Redis/RabbitMQ/Kafka without demonstrated need and an ADR.
6. Do not store secrets in Git, prompts, memory or committed env files.
7. Do not scatter direct provider imports through business logic.
8. Do not allow an LLM to grant permissions.
9. Do not report external side effects complete without evidence.
10. Do not allow self-modification without evaluation/governance.
11. Do not make provider conversation state canonical.
12. Do not store durable memory without provenance.
13. Do not erase material disagreement during synthesis.
14. Do not create swarms without a simpler baseline/evaluation case.
15. Do not broaden the current implementation phase silently.
16. Do not mark placeholders as implemented features.
17. Do not update `STATE.yaml` for design-only work.
18. Do not change architecture without an ADR when the change affects accepted boundaries.
19. Prefer deterministic mechanisms over LLMs when deterministic mechanisms solve the problem reliably.
20. Prefer the smallest implementation that satisfies the current acceptance tests.

---

## 16. Definition of final success

KernelJSON reaches its intended end state when:

1. tasks survive process/provider failures
2. external completion is evidence-bound
3. permissions remain deterministic and inspectable
4. one Primary Identity provides coherent continuity across integrated surfaces
5. canonical identity/memory survive provider/session replacement
6. a small Core Team provides useful durable role structure without always-on processes
7. specialists are compiled dynamically from mission requirements
8. swarms are used only when they measurably improve outcomes
9. memory is provenance-bound, correctable, forgettable and recoverable
10. identity growth is versioned, evaluated and reversible
11. context assembly is scoped, traceable and injection-aware
12. conflicts and uncertainty remain inspectable
13. providers remain replaceable
14. Mission Control can explain what happened, what reasoned, what changed, why and under what authority
15. the cognitive layer can enter safe mode and recover known-good identity state
16. approved autonomous workflows run durably without immortal agent loops
17. the architecture can expand to hard missions and collapse back to simple deterministic execution when cognition adds no value

---

## 17. Architecture freeze

This document represents the final agreed architecture and plan as of 2026-09-09.

Implementation should now proceed phase by phase rather than continuing speculative redesign.

New discoveries may require small implementation changes. A material change to the architectural principles, primitives, authority model, identity model, persistence boundaries, durable runtime or cognitive organisation requires:

1. a documented problem/evidence
2. explicit human decision
3. an ADR if the architecture changes
4. updates to this plan and affected canonical documents

Until then, build the plan.

> **One evolving Primary Identity. A small trusted Core Team. An unlimited ephemeral workforce. KernelJSON underneath, remembering, governing, proving, recovering and coordinating the work.**