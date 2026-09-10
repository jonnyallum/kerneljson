# ADR-0007: Canonical context and memory boundaries

Status: ACCEPTED

Date: 2026-09-09

## Decision

Models may consume projections of identity, memory, world state, task state and authority, but model/provider sessions never own canonical identity, memory, authority, task state or policy.

Canonical state remains in KernelJSON-controlled durable stores and versioned configuration.

## Rules

1. Provider conversations are execution surfaces, not sources of truth.
2. Identity is reconstructed from canonical versioned state for each cognitive execution.
3. Memory is retrieved by scope and relevance, with provenance and policy controls.
4. Model outputs become candidate observations, evidence, artefacts or memories only after capture and any required evaluation/promotion.
5. Provider-local hidden state, summaries or chat history must never be required for continuity.
6. A model cannot mutate its own canonical identity, memory class, authority or policy by emitting text.
7. Context assembly must apply minimum-context and minimum-authority principles.
8. User corrections and authoritative external evidence can supersede model-derived memory while preserving provenance.
9. Stale, contradicted, revoked or expired memory must remain distinguishable from current accepted state.
10. Cross-provider continuity is proven only when canonical state can be projected into a fresh provider session and useful continuity is recovered without relying on the previous provider's session history.

## Rationale

The architecture deliberately allows a continuing Primary Identity while keeping model providers replaceable. That is only possible if continuity lives outside provider conversations.

This boundary also reduces prompt-injection blast radius, memory poisoning risk, vendor lock-in, accidental identity drift and uninspectable state.

## Consequences

- KernelJSON requires an explicit context assembly layer.
- Identity projection packets are bounded, traceable and versioned.
- Memory promotion and contradiction handling are first-class operations.
- Provider adapters must not silently depend on proprietary conversation persistence.
- Mission Control must be able to show which canonical state and memory references informed a cognitive run.

## Relationship to existing ADRs

This ADR extends ADR-0001, ADR-0005 and ADR-0006 without changing the six KernelJSON primitives.

> Models may reason over canonical state. They do not become canonical state.