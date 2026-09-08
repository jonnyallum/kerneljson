# ADR-0006: Core team roles and dynamic specialists

Status: ACCEPTED

Date: 2026-09-08

## Context

Previous systems can accumulate large persistent agent rosters. That creates coordination overhead, duplicated responsibility, stale prompts, unclear authority and expensive always-on cognition.

KernelJSON needs a small stable organisational layer while retaining the ability to assemble large amounts of specialist cognition for difficult missions.

## Decision

KernelJSON uses a three-tier cognitive organisation:

1. **Primary Identity** - one durable executive identity that represents the user's principal AI relationship and coordinates missions.
2. **Core Team** - a small set of durable role specifications with stable responsibilities, authority boundaries and memory scopes.
3. **Dynamic Specialists** - ephemeral workers instantiated from task requirements, evaluated after execution, and discarded when their work is complete.

A fourth execution pattern, **Swarms**, may create multiple competing or complementary specialists for difficult work. A swarm is a task execution strategy, not a persistent organisational tier.

The initial recommended core roles are:

- Primary Executive
- Architect
- Builder
- Operator
- Intelligence
- Archivist
- Guardian
- Verifier

Role names and personalities may evolve, but responsibilities and authority boundaries must remain explicit and versioned.

## Delegation rules

1. The primary identity owns mission decomposition and final synthesis unless policy delegates otherwise.
2. Core roles receive only the context and capabilities required for their assigned task steps.
3. Specialists are created from required capabilities, domain expertise, risk class and evaluation criteria, not from a fixed roster lookup.
4. No worker may expand its own permissions.
5. High-risk actions pass through policy and approval regardless of role seniority.
6. Verification should be independent of the worker that produced the result when practical.
7. Disagreement is represented as evidence, alternatives or evaluation results, not hidden by forced consensus.
8. Temporary workers cease to exist as active cognitive sessions after their assigned work. Durable outputs are promoted into KernelJSON state only through governed write paths.

## Specialist lifecycle

`NEEDED -> SPECIFIED -> INSTANTIATED -> BRIEFED -> EXECUTING -> EVALUATED -> RETIRED`

A specialist specification should include at minimum:

- objective
- required capabilities
- domain or expertise profile
- allowed tools and permissions
- memory/context scope
- model/provider constraints or preferences
- budget
- deadline/timeout
- success criteria
- required evidence
- evaluator or verification strategy

## Consequences

- The system avoids rebuilding a large static agent roster.
- New expertise can be assembled per mission without permanent prompt debt.
- Core organisational continuity remains understandable to humans.
- Provider/model selection can be optimised independently from role identity.
- Evaluation data can improve future specialist selection and routing.

## Non-goals

This ADR does not require eight concurrent model processes.

It does not make the core team a substitute for KernelJSON task contracts, policy, evidence, durable execution or human approvals.
