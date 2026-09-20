# Cognition plan: deliberate reorder, and the KJ-P to plan mapping

Date: 2026-09-20
Status: RECORDED (a decision of Jonny's, made 2026-09-20)
Relates to: `docs/cognition/IMPLEMENTATION_PLAN.md`, ADR-0007, ADR-0011, ADR-0014, ADR-0018

## The reorder, stated plainly

The recorded plan places the Telegram channel in Stage J (cross-channel and cross-provider incarnation, phases 13 to 15),
after the primary identity and the memory work. **KJ-P4A pulls that channel-adapter work forward, deliberately.** The
plan did not say this; this record does.

Why it is reasonable now: the plan's Stage A prerequisites (typed contracts, durable execution, persistence, policy and
approvals, evidence-bound completion, ModelPort) are met and running in production, and a two-way operator channel is
the everyday interface through which every later layer (memory, identity, faculties, growth) will actually be used.

What does not change:

- KernelJSON remains the sole task authority. The channel adapter is a client of the admission door, like every other
  client. It has no task authority and no side door.
- The adapter implements Stage J's own flow (channel event, then `IntentEnvelope`, then principal and tenant, then
  admission and policy) **with the identity-retrieval and projection steps left for later**, so identity slots in
  without rework.
- No Shared Brain authority, no personality or memory logic, no scheduler, no second task store.

The plan's "Immediate rule" (do not broaden the Phase 1 to 3 slice) was time-bound to the original Codex handoff and no
longer applies.

## Sequence

| Step | Programme | Cognition plan stage | Plan phases | Notes |
|---|---|---|---|---|
| 1 | **KJ-P4A** two-way Telegram channel adapter | Stage J, channel adapter only | 13 to 15 (pulled forward) | commands and deterministic replies; no free-form conversation |
| 2 | **KJ-P4B** Telegram approvals and cancel | ADR-0008 policy and approvals; ADR-0014 control port; Stage J | 7, 13 | must call the existing policy-workflow control port, not a second approval system; a pause at a mutation boundary inside a running mission needs its own small ADR |
| 3 | **KJ-P5** canonical memory and Shared Brain as a source | Stage E (and the prerequisite for Stage D) | 10 to 11 | ADR-0007, ADR-0011, ADR-0018; the context assembler and the candidate-to-canonical promotion path |
| 4 | **KJ-P6** core team and faculties as durable configuration | Stage C role specifications | 7 to 9 | recorded plan order kept: roles before identity |
| 5 | **KJ-P7** primary identity and personality | Stage D primary identity v1 | 10, after the memory fabric exists | identity supplies who is speaking; KernelJSON supplies what is allowed |
| 6 | **KJ-P8** reflection, memory promotion and controlled growth | Stage G | 12 | bounded, versioned, evidence-bound; no uncontrolled self-modification |

Two orderings are deliberate and worth stating:

- **Memory before identity.** Stage D requires the memory fabric to exist, so KJ-P5 precedes KJ-P7.
- **Faculties before identity.** The recorded plan defines the core team (Stage C) before the primary identity
  (Stage D). KJ-P6 keeps that order: the persistent identity should sit on roles already defined, not force a retrofit.

## Naming: KJ-P numbers are not plan phase numbers

The `KJ-P*` names are the operational programme track (KJ-P1 alerting, KJ-P2 notification and Telegram outbound,
KJ-P3 the first evidence-bound mission, KJ-P3.1 mission quality). They are **not** the phase numbers in
`BUILD_PLAN.md` or `IMPLEMENTATION_PLAN.md`. "KJ-P4" here does not mean build-plan Phase 4 (the compiler and planner).
Use the table above to translate. The operational programmes that already shipped map only loosely: the mission is the
nearest analogue of the plan's first model-backed governed task, and the alerting and outbox work is operational
infrastructure the plan does not stage separately.

## Authority, restated (unchanged by any step above)

- KernelJSON decides whether something may execute.
- Telegram, ChatGPT, Claude and Grok are interfaces and faculties, not separate people and not authorities.
- Identities may persist. Cognitive executions do not.
- Shared Brain can inform memory. KernelJSON decides what becomes canonical memory (ADR-0018).
