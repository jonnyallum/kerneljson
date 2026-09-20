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

## Authentication boundary for the workflow (revised by KJ-P4B.1)

The policy and golden workflows were built to be given an authenticator and were never registered in production, because
ADR-0008 says registration awaits a real authentication boundary. KJ-P4B supplies it without new logic in the approval
path. The first design (KJ-P4B) sent a long-lived secret as `Authorization: Bearer ...` on the door's hop to the workflow
and assumed it "stays on the private network". **That assumption was wrong, and it was caught by the pre-deployment check
in the live window, not by a test.**

**Restate journals every request header.** The invocation's `Input` journal entry holds the full header list, retained
for 24 hours after completion (`completion_retention` and `journal_retention` are both `PT86400S`), readable through
Restate's admin SQL and held in its data volume. Measured on Restate 1.7.9 with a real golden workflow and confirmed
read-only on production (`docs/operations/PHASE_KJ_P4B_TELEGRAM_APPROVALS_LIVE_RESULT_2026-09-20.md`). Restate's and the
worker's logs did not contain the value; the journal is the exposure. Anything sent in a header on that hop is therefore
written into a durable store.

**Decision (KJ-P4B.1): the long-lived key is never transmitted. The door sends a short-lived, request-bound HMAC
assertion in dedicated headers, never `Authorization`.** What Restate journals is a bounded, non-secret assertion.

- **Canonical payload.** A domain tag `kj-control/v1`, a newline, then a JSON array of thirteen strings in a fixed order:
  version, key id, method, service, handler, workflow key (the task id), tenant id, principal id, scope digest, decision,
  sha256 of the body, issued-at (unix seconds), nonce. JSON string escaping makes every boundary unambiguous. For `approve`
  the scope digest and decision are read from the body, so an approval assertion names the exact task, tenant, approver,
  full digest and decision, and separately the hash of the whole body.
- **Signature.** `HMAC-SHA256(signing key, canonical payload)`, compared in constant time.
- **Headers.** `X-KJ-Control-Version`, `-Key-Id`, `-Timestamp`, `-Nonce`, `-Body-SHA256`, `-Signature`. No `Authorization`.
- **The worker trusts nothing in the headers about the request.** It rebuilds the payload from what it received (its own
  service name, the handler running, the workflow key, the raw body from the SDK) and from its own configured tenant and
  principal, so an assertion verifies only for the request it was made for. The identity returned is the configured
  principal, never one read from the request.
- **Replay model.** Restate redelivers durable work with identical headers, so "seen before" cannot mean reject. The nonce is
  stored with the sha256 of the canonical payload in `kernel_private.control_assertions`, judged on the DATABASE clock:
  first sight and within the freshness window (default 300 s) is recorded and accepted; seen again with the identical
  digest is accepted idempotently; seen again with a different digest is rejected; never seen and outside the window is
  rejected. The signature is verified before the store is touched, so unauthenticated traffic writes nothing. Rows are purged
  after seven days, so a purge can only make an old replay fail (it is stale).
- **Key ids and rotation.** Every assertion names a key id. The worker recognises the current and, during a controlled
  rotation, one previous key; the door signs only with the current one. No wider key-management framework.
- **An outage is not a refusal.** If the replay store cannot be reached the verifier reports "unavailable" and Restate retries;
  it is never turned into a permanent 401.

The approval semantics are untouched: the ApprovalStore is still the final authority and first valid decision still wins.
The signed assertion authenticates the hop; it grants nothing.

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
  control. A second approver identity would need a second door signing key and is future work.
- Restate will hold each assertion for 24 hours. That is acceptable by construction: an assertion is bound to one exact request
  and is not the key. Someone who can read the journal and reach the ingress could resend an identical request, which the
  replay model accepts as an idempotent no-op (the approval store and the workflow are themselves idempotent), and could do
  nothing else with it.
- A `run` assertion is judged fresh when the worker FIRST sees it. If the worker is down for longer than the freshness window
  between the door sending a submission and the worker running it, that submission is refused as stale and the task is
  stranded. The blast radius is the harmless synthetic recipe only, and `KJ_CONTROL_FRESHNESS_SECONDS` can be raised.
- The pre-deployment header check stays a permanent step of any window that changes what crosses the hop.
- A card is shown at the next poll after the approval is recorded, not instantly, because the channel adapter's loop is a
  long poll. Up to about twenty-one seconds.
- The workflow's policy is a code constant with a version string, so changing what needs approval is a code change with
  a new version, which changes every scope digest bound to it.
