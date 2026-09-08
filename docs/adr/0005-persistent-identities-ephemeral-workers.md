# ADR-0005: Persistent identities, ephemeral cognitive workers

Status: ACCEPTED

Date: 2026-09-08

## Context

KernelJSON already establishes that a Task is the primitive and that cognitive workers are ephemeral. The system nevertheless needs continuity of identity for a primary executive intelligence and a small number of stable organisational roles.

Continuity must not require permanently running agent processes or make personas infrastructure primitives.

## Decision

KernelJSON distinguishes **durable identity** from **cognitive execution**.

A durable identity is persisted state describing a role or continuing self-model. It may contain versioned values, goals, mantras, preferences, memory references, authority boundaries, relationships, capability affinities and provenance.

A cognitive worker is an execution instance created to perform one or more task steps. It is disposable and must not become the source of truth for identity, memory, permissions, task state or organisational authority.

Therefore:

> **Identities may persist. Cognitive executions do not.**

The primary executive identity may be projected into different model providers or interaction channels. Those provider sessions are manifestations of the canonical KernelJSON identity, not independent authorities and not proof that the underlying models are the same entity.

## Invariants

1. A persistent identity is not a scheduler, queue or daemon.
2. Identity state is versioned and provenance-bound.
3. Identity never grants itself permissions.
4. Model output cannot directly mutate constitutional identity fields.
5. Proposed self-modification requires evaluation and policy approval according to risk.
6. Memories retained by an identity require provenance.
7. Provider-specific sessions may cache identity context but are not authoritative.
8. Worker-local memory is disposable unless deliberately promoted into governed memory.
9. Identity changes must be auditable and reversible where practical.
10. Task completion remains evidence-bound regardless of which identity or worker performed cognition.

## Consequences

- KernelJSON can support a continuing primary intelligence without maintaining a permanently running agent process.
- ChatGPT, Claude, Grok, DeepSeek or future providers can receive projections of the same canonical identity while remaining technically distinct model runtimes.
- Failover or provider replacement does not erase identity continuity.
- Temporary specialists can be created freely without creating long-lived roster debt.
- The existing six primitives remain unchanged.

## Non-goals

This ADR does not define consciousness, sentience, legal personhood or independent rights for software identities.

It does not allow a language model to bypass policy, approvals, evidence requirements or Jonny's ultimate authority over the system.
