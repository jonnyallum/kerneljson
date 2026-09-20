# ADR-0019: Telegram is a human interface onto existing approvals, not an approval authority

Status: ACCEPTED

Date: 2026-09-20

Extends ADR-0008 (policy and approvals), ADR-0010 (golden workflow) and ADR-0014 (mission control control port). It does
not change any of them. The Telegram channel itself is the KJ-P4A work; this is the KJ-P4B decision about what may cross it.

## Decision

An approval is decided only by the existing approval machinery: the policy workflow's `approve` handler, the
`ApprovalStore`, for the named approver, against the exact scope digest, before the database-clock deadline, first valid
decision wins. Telegram may **show** an approval and may **carry a human's answer to the door's existing `approve`
control**. It may not decide, mint, widen, extend, or bypass one.

Consequently the Telegram layer adds no authority path:

1. It writes no approval, task, evidence or event row. Its own tables hold only which approvals were shown, what each
   opaque button handle means, and which button presses were already handled.
2. It asks through the door's existing `POST /v1/tasks/:id/approve`, the same route Mission Control uses, so the door's
   tenant, binding, named-approver, digest and deadline checks apply before the workflow is reached, and the workflow's
   own checks apply again after.
3. It reads the ledger to know what to say. It never infers an outcome from the door's reply.
4. If the layer were deleted, every approval would still be answerable through the door and checked identically.

## What is bound to an approval (all existing)

`PolicyScope` already binds task id, step id, tenant, principal, trace, capability, the digest of the exact invocation
(including its input), the capability descriptor digest and the policy version. The **scope digest** is the sha256 of
that canonical scope. The approver principal and the deadline are recorded beside it. An approval therefore cannot approve
another action: change the input, task, tenant, capability or policy version and the digest changes.

The "action digest" of KJ-P4B is that scope digest. No second digest was invented.

## How the answer travels

- The card shows a **shortened** digest for reading only. The full digest the door receives is copied from the ledger's
  own `POLICY_CHECKED` event when the card is created and is stored server side.
- A button carries `kj1:<handle>` and nothing else, where the handle is 128 random bits. The decision, task and digest are
  looked up server side from the handle. There is no decision, task id or digest in the callback data to forge or replay.
- A press is accepted only from the configured private chat and user, on the card's own message, and only once per
  Telegram update id.

## Authentication boundary for the workflow (new, small)

The policy and golden workflows were built to be given an authenticator and were never registered in production, because
ADR-0008 says registration awaits a real authentication boundary. KJ-P4B supplies it without new logic in the workflow:
the door presents an internal credential (`KJ_CONTROL_TOKEN`, a secret distinct from the public admission bearer) on its
hop to the workflow, and the worker compares it in constant time and names the door's one fixed human principal. The
identity is fixed by configuration and never read from the request.

## The synthetic boundary

The first live approval uses one deliberately harmless rule: the deterministic `uppercase` capability, for the door's
principal, requires that same principal's approval. That capability uppercases the task's own text and touches no file,
network or account, so nothing but the approval path is under test.

## Not decided here

A pause partway through a `KernelWorkflowV1` mission, at a mutation boundary, is a different mechanism from the
pre-execution capability gate above and needs its own ADR before it is built. It is not built.

## Consequences

- One person, one door principal, so the requester and the named approver are the same identity in this deployment. The
  approval is still a real gate (a separate, explicit, time-bound, digest-bound human act), but it is not a two-person
  control. A second approver identity would need a second door credential and is future work.
- A card is shown at the next poll after the approval is recorded, not instantly, because the channel adapter's loop is a
  long poll. Up to about twenty-one seconds.
- The workflow's policy is a code constant with a version string, so changing what needs approval is a code change with
  a new version, which changes every scope digest bound to it.
