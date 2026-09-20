# ADR-0018: Canonical memory authority and external knowledge sources

Status: ACCEPTED

Date: 2026-09-20

Numbering: this is 0018 because 0015 (adaptive routing), 0016 and 0017 are already taken. It completes the
memory-boundary decisions in ADR-0007 and ADR-0011; it does not replace either.

## Decision

KernelJSON-controlled durable stores are the canonical authority for persistent identity and memory state.

External knowledge systems, including the Shared Brain, may provide retrieval, context and candidate memories,
but cannot directly mutate canonical identity or memory. Promotion into canonical memory requires a
KernelJSON-governed transition with provenance, policy and evidence.

Shared Brain can inform memory. KernelJSON decides what becomes canonical memory.

## The split

| Owned by KernelJSON (canonical) | Provided by the Shared Brain (source, not authority) |
|---|---|
| identity-defining memories | broader knowledge |
| durable preferences | project context |
| decisions | documents |
| commitments | historical conversations |
| lessons promoted into long-term memory | external notes |
| autobiographical and relationship memory that influences the persistent identity | the semantic retrieval corpus |
| versioned personality state | candidate memories |
| provenance, policy, promotion status and supersession | contextual facts that may help a mission |
| immutable, evidence-bound memory records | |

## Rules

1. The Shared Brain is a knowledge source and retrieval substrate. It is not the authority for identity-changing or
   behaviour-changing memory, and it has no task authority (as already recorded in the migration constitution).
2. Anything the Shared Brain supplies to a cognitive execution passes through the KernelJSON context assembler
   (ADR-0007 rule 7), with provenance and policy checks applied.
3. What was supplied is recorded as evidence: which items, from which source, under which policy, in what form. A
   mission can therefore show exactly what informed a model, as ADR-0007 requires.
4. Material from the Shared Brain becomes canonical memory only through an explicit KernelJSON transition:
   candidate, then evaluated, then promoted, with provenance, policy and evidence. Promotion is recorded and can be
   superseded, never silently edited (ADR-0011: rows are immutable).
5. A model, a provider session or an external system cannot mutate canonical identity or memory by emitting text or by
   writing to the Shared Brain (ADR-0007 rule 6). A write to the Shared Brain changes what MAY be retrieved, never
   what KernelJSON treats as true about the identity.
6. If the Shared Brain and canonical memory disagree, canonical memory wins, and the disagreement is a candidate for
   review, not an automatic overwrite.

## Rationale

ADR-0007 already places canonical state in KernelJSON-controlled stores, and ADR-0011 already implements the first
canonical memory there. The Shared Brain is valuable precisely because it is broad and easy to write to, which is also
why it cannot be the authority: memory poisoning and identity drift are prevented by keeping the promotion decision
inside the governed, evidence-bound kernel.

## Consequences

- KJ-P5 builds the context assembler and the candidate-to-canonical promotion path, and integrates the Shared Brain as
  a source behind them.
- The Shared Brain integration is read-only from the kernel's side until promotion exists.
- Context supplied from the Shared Brain is bounded and auditable per mission.
- Nothing in this ADR changes the current KernelJSON task-authority boundary.

## Relationship to existing ADRs

- ADR-0007 (canonical context and memory boundaries): unchanged; this ADR names the Shared Brain's place within it.
- ADR-0011 (provenance-preserving result memory): unchanged; it remains the first canonical memory class.
- ADR-0005 (persistent identities, ephemeral workers): unchanged; identities persist, cognitive executions do not.
