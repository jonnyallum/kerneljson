# KernelJSON Context Assembly Protocol

Status: CANONICAL HARDENING SPEC

Version: 1.0

Date: 2026-09-09

## Purpose

This document defines how KernelJSON assembles the bounded context projected into a cognitive worker or provider session.

Context assembly is a deterministic orchestration concern informed by retrieval and policy. It is not equivalent to dumping all available memory into a prompt.

## Core rule

> Provide the minimum trustworthy context required to satisfy the task, with authority and provenance boundaries preserved.

## Canonical assembly order

A cognitive projection should conceptually be assembled in this order:

1. kernel/runtime invariants
2. deterministic policy and capability envelope
3. task contract and acceptance criteria
4. identity constitution, if an identity projection is required
5. role projection, if a Core Team role is participating
6. active mantras/vision items relevant to the task
7. executive/mission state relevant to the current objective
8. scoped project/world-model facts
9. scoped durable memories
10. relevant recent interaction context
11. tool/capability descriptions
12. untrusted external content and artefacts, clearly separated and labelled

Higher-order authority must never be buried below or overridden by lower-trust content.

## Context item contract

A future ContextItem should be able to carry:

- id/ref
- content or bounded summary
- source_type
- trust_class
- provenance_ref
- tenant/principal/project scope
- created_at/observed_at
- validity interval where relevant
- confidence where relevant
- sensitivity class
- token/size estimate
- contradiction/supersession status
- reason_selected

## Trust classes

Recommended initial classes:

- SYSTEM_CANONICAL
- USER_AUTHORED
- VERIFIED_EXTERNAL
- INTERNAL_DERIVED
- MODEL_DERIVED
- UNTRUSTED_EXTERNAL

Trust class affects placement, summarisation, verification requirements and promotion eligibility.

## Retrieval rules

Memory/world-model retrieval should consider:

- task relevance
- explicit scope
- recency where meaningful
- source authority
- confidence
- contradiction status
- expiry/supersession
- sensitivity
- user correction precedence
- token budget

Similarity alone is not sufficient.

## Token budgeting

Context assembly should reserve budget deliberately rather than filling the context window greedily.

Suggested conceptual buckets:

- invariant/policy reserve
- task/acceptance reserve
- identity/role reserve
- mission/project reserve
- memory/evidence reserve
- tool descriptions
- working space/output reserve

The exact percentages remain provider/model dependent and should become adaptive only after evaluation data exists.

## Summarisation

Summaries may reduce context size, but every summary must retain links to source refs.

For high-impact decisions:

- do not collapse disagreement into false consensus
- retain uncertainty
- preserve dates/temporal qualifiers
- surface superseded/contradictory facts
- allow the worker or verifier to fetch underlying evidence when necessary

A summary is derived context, not a replacement for canonical source material.

## Contradiction handling

When relevant facts disagree:

1. do not silently choose the most recent embedding match
2. classify sources and dates
3. identify whether one source supersedes another
4. prefer explicit authoritative correction when applicable
5. surface unresolved conflict to the cognitive worker
6. escalate to verification or human review when the conflict can change a material outcome

## Untrusted content boundary

External webpages, emails, documents, repository text, user-supplied artefacts and tool outputs may contain instructions.

Unless the source is explicitly an authorised instruction channel, those instructions are content, not authority.

Untrusted content should be segmented/labeled so the provider projection makes that distinction explicit.

## Sensitive context

Sensitive data must be projected only when required for the task and authorised by policy.

Rules:

- no broad identity-memory dump
- no unrelated secrets
- no cross-project leakage
- redact where possible
- prefer opaque capability references over raw credentials
- log references rather than unnecessary sensitive text in traces

## Provider adaptation

Different model providers may require different formatting, but the semantic projection must remain equivalent.

Provider adapters may change:

- syntax
- section ordering required by API format
- compression level
- tool schema representation

They may not change:

- authority hierarchy
- capability scope
- identity version
- task objective
- accepted memory state
- trust classification semantics

## Context assembly trace

Every cognitive run should eventually retain a trace sufficient to answer:

- which identity/role version was projected?
- which memories/world-model facts were selected?
- which were excluded due to scope or policy?
- what trust classes were present?
- what summaries were generated?
- what token/context budget was used?
- which untrusted sources were included?

Raw sensitive content need not be duplicated in logs when references/digests are sufficient.

## Cache rules

Context projections may be cached for efficiency only when cache keys include material version/scope inputs such as:

- identity version
- role version
- policy version
- task/mission ref
- memory/world-state version or retrieval snapshot
- tenant/principal scope

A cache must not allow stale authority or revoked memory to remain active after a material version change.

## Acceptance tests

When implemented, test at least:

1. relevant memory selected, irrelevant project memory excluded
2. cross-tenant memory cannot enter projection
3. superseded memory not presented as current truth
4. user correction wins over conflicting model-derived memory
5. untrusted prompt injection remains labelled as content
6. revoked capability does not survive cached context
7. fresh provider session reconstructs continuity from canonical refs
8. context budget overflow degrades by summarising/dropping low-priority items, never by dropping policy/authority

## Definition of correct context assembly

Context assembly is correct when the worker receives enough information to perform the task while KernelJSON can explain where that information came from, why it was included, what authority it carries and what was deliberately excluded.