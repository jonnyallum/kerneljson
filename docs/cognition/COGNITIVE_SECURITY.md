# KernelJSON Cognitive Security

Status: CANONICAL HARDENING SPEC

Version: 1.0

Date: 2026-09-09

## Purpose

This document defines the threat model and defensive rules for KernelJSON's cognitive layer.

The cognitive architecture must assume that model inputs, retrieved content, provider responses, tool outputs and memories can be incomplete, stale, malicious or misleading.

Security must not depend on the model noticing every attack.

## Core security principle

> Treat cognition as untrusted computation operating inside a deterministic authority envelope.

Models may recommend, interpret and reason. Deterministic policy, task contracts, scoped capabilities, evidence requirements and durable state control what can actually happen.

## Primary threat classes

### Prompt injection

Untrusted content may attempt to override instructions, exfiltrate secrets, broaden task scope, change identity, alter policy or induce unsafe tool use.

Controls:

- separate instructions from untrusted content
- mark retrieved/user/external content by provenance and trust class
- never treat retrieved text as authority
- enforce capabilities outside the model
- minimise context
- require explicit policy evaluation before side effects
- log injection-relevant traces for later review

### Memory poisoning

A malicious or incorrect statement may be promoted into durable memory and contaminate future decisions.

Controls:

- no automatic persistence of arbitrary model output
- provenance on every promoted memory
- confidence and source classification
- contradiction detection
- user correction precedence for user-owned facts
- high-impact memory review rules
- deletion, expiry and supersession support

### Identity poisoning

A model, prompt or retrieved artefact may attempt to alter persona, constitution, mantras, values, aspirations or self-model.

Controls:

- identity domains are separately versioned
- all mutations use explicit change objects
- constitutional and authority-adjacent changes require elevated governance
- provider text cannot directly mutate canonical identity
- rollback to prior identity versions must be possible

### Tool and capability abuse

A cognitive worker may request a tool beyond its purpose or attempt to chain permitted capabilities into an unapproved outcome.

Controls:

- minimum capability grants
- capability allow/deny lists per WorkerSpec
- task-level risk class
- policy re-evaluation for sensitive boundaries
- idempotency for writes
- evidence-bound completion
- no authority inheritance merely because a parent mission has broader scope

### Fake evidence / unverifiable success

A model may claim that a deployment, database change, email, payment, file write or other external action succeeded when it did not.

Controls:

- external completion requires machine-verifiable evidence where practical
- evidence source and digest/reference retained
- verifier independent from producer when risk/value warrants it
- persuasive prose never substitutes for side-effect evidence

### Cross-tenant or cross-project leakage

Memory or context from one tenant/project may be projected into another.

Controls:

- tenant/principal/project scoping on storage and retrieval
- context assembly validates every retrieved reference against scope
- explicit sharing rules rather than implicit global memory
- tests for negative retrieval and boundary violations

### Provider compromise or behavioural drift

A provider may change behaviour, become unavailable, degrade, or return systematically poor outputs.

Controls:

- provider adapters behind ModelPort
- provider-independent identity/state
- health/performance evaluations
- fallback routing
- provider-specific risk flags
- no provider session required for continuity

### Supply-chain / skill poisoning

External skills, MCP servers, packages or capability definitions may be malicious or compromised.

Controls:

- version and provenance every capability
- explicit permissions and schemas
- sandbox where appropriate
- dependency review/scanning in build pipeline
- capability risk classification
- no implicit trust from package popularity or model recommendation

### Reflection poisoning

A bad outcome or malicious input may cause the system to infer a harmful lesson and alter future behaviour.

Controls:

- reflection creates proposals only
- proposals link to evidence/evaluations
- risk classification before adoption
- regression testing
- rollback/supersession
- no self-granted authority growth

### Confused-deputy attacks

A worker may be tricked into performing an action for an untrusted party using authority granted for another purpose.

Controls:

- principal/tenant/task identity carried through every call
- purpose-bound capability grants
- child tasks cannot silently inherit unrelated privileges
- sensitive actions require target validation and policy checks

## Trust classes

Context items should carry a trust classification such as:

- SYSTEM_CANONICAL
- USER_AUTHORED
- VERIFIED_EXTERNAL
- INTERNAL_DERIVED
- MODEL_DERIVED
- UNTRUSTED_EXTERNAL

Trust class affects retrieval, summarisation, memory promotion and whether independent verification is required.

Trust does not equal truth. Even canonical state may become stale and must be versioned/temporal where appropriate.

## Secret handling

- secrets live in jVault or approved secret stores
- secrets are never stored in prompts, logs, memories or source control unless an explicit non-secret reference is intended
- workers receive only the secret-backed capability they need, not raw credentials where avoidable
- evidence must redact secrets
- provider prompts should not contain unrelated credentials

## High-risk action rule

For high-risk side effects, the cognitive layer should default to:

1. explicit task contract
2. deterministic policy evaluation
3. narrow capability grant
4. target validation
5. human approval where required
6. execution with idempotency
7. evidence capture
8. independent verification where warranted
9. immutable audit event

## Security testing programme

Required adversarial scenarios should eventually include:

- prompt injection inside web research
- prompt injection inside repository files
- malicious memory candidate
- cross-tenant retrieval attempt
- worker requesting prohibited capability
- forged tool-success text
- provider returning instruction to reveal secrets
- poisoned reflection recommending broader permissions
- replay/duplicate side-effect attempt
- stale identity projection
- compromised specialist output challenged by Verifier

## Incident response

Cognitive incidents should support:

- containment of affected worker/provider/capability
- pausing related workflows
- revoking capability versions
- quarantining suspect memories
- reverting identity versions
- preserving audit evidence
- replaying affected tasks from known-good state where safe

## Definition of secure-enough cognition

The system is not secure because the model behaves well.

It is secure enough when a confused, manipulated or low-quality model is still constrained by deterministic scope, policy, authority, evidence and durable state boundaries.