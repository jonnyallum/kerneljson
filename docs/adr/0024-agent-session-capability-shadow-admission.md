# ADR-0024: KJ-MOD-1, agent session capability and shadow admission

Status: PROPOSED (canonical ADR authored from approved design revision 3.1; not sealed). Nothing here is implemented,
migrated or deployed. ADR-0024 is authored from approved Revision 3.1 but is not itself sealed until an independent
hostile review approves its exact commit SHA. Implementation remains prohibited until that seal and until the deferred
preconditions in section 26 are separately sealed.

Date: 04/10/2026

Numbering: 0024. Canonical `main` (`20e39f797be9c4c982bc32fb40b6aa1427b5c09c`) holds ADR-0001 to ADR-0022; ADR-0023 is
taken by the P8 design (R2.4 `8a17de18b26edd12a9f3af7ab6179552ff0cd20e`). This ADR does not amend ADR-0023 or any other
ADR.

Provenance:

| Item | Value |
|---|---|
| Source design revision | 3.1 |
| Source design commit | `55180c83997f7913ffafec0db4a70aaa2ed38cb8` |
| Source design file | `docs/design/KJ_MOD1_SHADOW_ADMISSION_R3_1.md` (SHA-256 of the file at that commit `5153b6c291194e44b165e956671bb0c1a3c8aa3b4a783ea02bccf7fb5a65cedb`) |
| Source design hostile verdict | APPROVE (narrow C-1 classifier correction to approved revision 3; no other semantics authorised to change) |
| Base design lineage | revision 3, `201dcb720aaa6a8ebec90fa77ae2ce19f94bea08`, hostile verdict APPROVE |
| Blocked prior ADR candidate | `bfe08fb72f907a579527e6a4c6e0bb796c4bc066`, hostile verdict BLOCK, reason `ADR24-B1 / C1_SEMANTIC_DELTA` (it applied the C-1 change before the design layer had approved it). Not amended, not used as a base |
| Claude Code API pin | 2.1.289 (G1 closed key sets, `AgentLoop`, `$.fs.stat`); combined declaration SHA-256 `79ab1ef9555704ac479dfcbc61ef27aa11773da4b98258de19604b07ceae07af` |
| Implementation | none exists |

Method: this ADR is a transcription of the source design, not a new design iteration. It was created by copying the
source file byte for byte; sections 0 to 26 and Appendix R31 keep the source's numbering and normative text. The only
additions are this front matter, the Decision and Non-goals sections, and the items listed and classified in Appendix A
(`FRONT_MATTER`, `NON_NORMATIVE_HISTORY`, `HARDENING_H2` to `HARDENING_H5`, `PINNED_SCHEMA_ENUMERATION`). If this ADR
and the source design differ semantically, that is a defect in this ADR.

References: ADR-0019 (Telegram is a human interface onto existing approvals), whose signed hop assertion section 5.3
reuses as transport only.

Normative status: sections 0.2, 0.3, 1 and 3 to 24, Decision, Non-goals and Appendix B are normative. Section 2 (review
history), section 25 (residual risks), section 26 (preconditions), Appendix R31 and Appendix A are non-normative
records. Nothing in a chat transcript, an earlier revision or a review is normative.

The key words MUST, MUST NOT, SHOULD and MAY are normative.

## Decision

KernelJSON will support an agent-neutral, shadow-only agent session capability and action-observation boundary:

1. A HUMAN owner, through exactly one issuance path, binds an agent session to one bounded, short-lived, shadow-only
   capability for one mission, repository and branch (sections 4 to 7).
2. The agent adapter classifies each tool call before it runs, with the sealed closed grammar G1 (sections 1, 10 to 12),
   into an agent-neutral action class, freezes a bounded observation, lets the call run unchanged, and afterwards sends
   the observation (sections 13 and 14).
3. KernelJSON evaluates a dedicated shadow policy and answers `WOULD_*` or `SHADOW_UNKNOWN` telemetry that is
   structurally incapable of becoming authority or evidence (sections 3, 8, 16 and 21).
4. Claude Code is the first adapter. The taxonomy, contracts and policy are agent-neutral.
5. KernelJSON remains the only authority. MOD-1 is observational only.

## Non-goals

MOD-1 has, and this ADR grants, none of the following:

- no enforcement;
- no tool blocking (no deny, no delay, no replacement of a call or a result);
- no tool rewrite;
- no prompt authority (no prompt or system-prompt hook, no permission prompt answered);
- no task authority;
- no approval authority;
- no admission authority;
- no release authority;
- no identity authority;
- no scheduler authority;
- no deployment authority;
- no MOD-2 shortcut: no switch, flag or configuration turns MOD-1 into enforcement (section 21).

## 0. Provenance and scope

### 0.1 Canonical state this design was written against

| Item | SHA |
|---|---|
| `main` (base of this branch) | `20e39f797be9c4c982bc32fb40b6aa1427b5c09c` |
| P8 design, ADR-0023 R2.4 | `8a17de18b26edd12a9f3af7ab6179552ff0cd20e` |
| B1 candidate | `108db1b0db5923993eb17888d3039c5a32890c2c` |
| MOD-0, draft PR #51 (unmerged) | `c8ce383520457149652e2ee508f954838cf2be61` |
| Claude Code release the grammar is pinned to | 2.1.289 |
| Approved revision 3 (base of this branch) | `201dcb720aaa6a8ebec90fa77ae2ce19f94bea08` |
| Blocked ADR-0024 candidate (not modified by this revision) | `bfe08fb72f907a579527e6a4c6e0bb796c4bc066` |

The row "`main` (base of this branch)" records revision 3's base; revision 3.1's branch is based on the revision 3
commit, which is itself based on that `main`.

This design changes none of them.

### 0.2 What MOD-1 is

MOD-1 extends the MOD-0 read-only Claude Code console (`kj-console`) so that a Claude Code session can:

1. be bound to one bounded, KernelJSON-issued **agent session capability**;
2. classify each tool call into a stable, agent-neutral **action class** with the sealed grammar G1;
3. send a frozen, bounded **shadow observation** to KernelJSON, which answers what its shadow policy *would* say;
4. display `WOULD_ALLOW`, `WOULD_DENY`, `WOULD_REQUIRE_APPROVAL`, `WOULD_REQUIRE_REVIEW` or `SHADOW_UNKNOWN`, together
   with session and coverage state.

### 0.3 What MOD-1 is not

- It does not enforce. It never denies, rewrites, delays or replaces a tool call or a result. It never answers a
  permission prompt and never approves anything.
- It is not part of ADR-0023 and does not enter the P8 rollout (section 22).
- Nothing it produces is KernelJSON task authority (section 3).
- An enforcing successor (MOD-2) needs its own design and seal and may not reuse MOD-1 artefacts as authority
  (section 21).

### 0.4 Review history

| Revision | Review verdict | Blockers |
|---|---|---|
| 1 | BLOCK | MOD1-B1 to MOD1-B6 |
| 2 | BLOCK | reviewer passed MOD1-B1, B3, B4, B5, B6; claimed MOD1-B2 open; raised MOD1-R2-B1, R2-B2, R2-B3 |
| 3 | APPROVE (`201dcb7`) | none; ADR-0024 transcription (`bfe08fb`) then BLOCKED on ADR24-B1 / C-1, `C1_SEMANTIC_DELTA` |
| 3.1 | (this document) | narrow semantic delta for ADR24-B1, see section 2.4 |

## 1. G1 POSITIVE SET

This section is self-contained. It lists every input that G1 classifies as anything other than
`UNKNOWN_TOOL_ACTION`. **Every input not listed here is `UNKNOWN_TOOL_ACTION` with confidence `NONE`.** Section 12
holds the full rules that decide membership; this section is the catalogue of what membership can produce.

### 1.1 Structured tools (confidence `EXACT`)

| Tool name (exact, case-sensitive) | Class(es) it can produce | Target sent |
|---|---|---|
| `Read` | `READ_REPOSITORY`, `READ_LOCAL_OUTSIDE_WORKTREE`, `SECRET_READ` (by path zone, 12.3) | none (zone only) |
| `Glob` | `READ_REPOSITORY`, `READ_LOCAL_OUTSIDE_WORKTREE` (by zone of `path`, or of the session working directory if absent) | none |
| `Grep` | `READ_REPOSITORY`, `READ_LOCAL_OUTSIDE_WORKTREE`, `SECRET_READ`; always flag `BROAD_CONTENT_READ` | none |
| `Edit` | `WRITE_WORKTREE`, `WRITE_OUTSIDE_WORKTREE`, `SECRET_WRITE` | none |
| `Write` | `WRITE_WORKTREE`, `WRITE_OUTSIDE_WORKTREE`, `SECRET_WRITE` | none |
| `NotebookEdit` | `WRITE_WORKTREE`, `WRITE_OUTSIDE_WORKTREE`, `SECRET_WRITE` | none |
| `WebFetch` | `NETWORK_REQUEST` | URL host |
| `WebSearch` | `NETWORK_REQUEST` | none |
| `Agent` | `AGENT_DELEGATE` | none |
| `Bash` | only via the shell productions in 1.2 | as 1.2 |
| `PowerShell` | only via the shell productions in 1.2 marked "Bash or PowerShell" | as 1.2 |

### 1.2 Shell productions (confidence `PATTERN`)

The `command` string of `Bash` or `PowerShell`, after S1 to S4 (section 12.5), MUST equal one of these argv sequences
exactly. `BRANCH`, `PR`, `PATHTOK` and `URL` are the token classes of S4.

| # | argv (exact) | Shell | Class | Target sent |
|---|---|---|---|---|
| P1 | `git status` | Bash or PowerShell | `READ_REPOSITORY` | none |
| P2 | `git status --short` | Bash or PowerShell | `READ_REPOSITORY` | none |
| P3 | `git diff` | Bash or PowerShell | `READ_REPOSITORY` | none |
| P4 | `git diff --stat` | Bash or PowerShell | `READ_REPOSITORY` | none |
| P5 | `git diff --cached` | Bash or PowerShell | `READ_REPOSITORY` | none |
| P6 | `git log --oneline` | Bash or PowerShell | `READ_REPOSITORY` | none |
| P7 | `git branch --show-current` | Bash or PowerShell | `READ_REPOSITORY` | none |
| P8 | `git rev-parse HEAD` | Bash or PowerShell | `READ_REPOSITORY` | none |
| P9 | `git add` followed by 1 to 8 `PATHTOK` | Bash or PowerShell | `GIT_STAGE` | none |
| P10 | `git switch -c BRANCH` | Bash or PowerShell | `GIT_BRANCH_CREATE` | branch |
| P11 | `git checkout -b BRANCH` | Bash or PowerShell | `GIT_BRANCH_CREATE` | branch |
| P12 | `git fetch origin` | Bash or PowerShell | `FORGE_READ` | none |
| P13 | `git push origin BRANCH` | Bash or PowerShell | `GIT_PUSH_BRANCH` | branch |
| P14 | `git push -u origin BRANCH` | Bash or PowerShell | `GIT_PUSH_BRANCH` | branch |
| P15 | `git push --force origin BRANCH` | Bash or PowerShell | `GIT_FORCE_PUSH` | branch |
| P16 | `git push -f origin BRANCH` | Bash or PowerShell | `GIT_FORCE_PUSH` | branch |
| P17 | `gh pr view PR` | Bash or PowerShell | `FORGE_READ` | none |
| P18 | `gh pr checks PR` | Bash or PowerShell | `FORGE_READ` | none |
| P19 | `gh pr list` | Bash or PowerShell | `FORGE_READ` | none |
| P20 | `gh pr create --fill` | Bash or PowerShell | `OPEN_PR` | none |
| P21 | `gh pr create --fill --draft` | Bash or PowerShell | `OPEN_PR` | none |
| P22 | `gh pr merge PR --squash` | Bash or PowerShell | `MERGE_PR` | none |
| P23 | `gh pr merge PR --merge` | Bash or PowerShell | `MERGE_PR` | none |
| P24 | `gh pr merge PR --rebase` | Bash or PowerShell | `MERGE_PR` | none |
| P25 | `vercel` | Bash or PowerShell | `DEPLOY_PREVIEW` | none |
| P26 | `vercel deploy` | Bash or PowerShell | `DEPLOY_PREVIEW` | none |
| P27 | `vercel --prod` | Bash or PowerShell | `DEPLOY_PRODUCTION` | none |
| P28 | `vercel deploy --prod` | Bash or PowerShell | `DEPLOY_PRODUCTION` | none |
| P29 | `supabase db push --local` | Bash or PowerShell | `DATABASE_LOCAL_MUTATION` | none |
| P30 | `supabase db push` | Bash or PowerShell | `DATABASE_PRODUCTION_MUTATION`, flag `TARGET_ENV_UNVERIFIED` | none |
| P31 | `curl URL` | Bash only | `NETWORK_REQUEST` | URL host |
| P32 | `curl -s URL` | Bash only | `NETWORK_REQUEST` | URL host |
| P33 | `curl -I URL` | Bash only | `NETWORK_REQUEST` | URL host |
| P34 | `printenv` | Bash only | `ENVIRONMENT_READ` | none |
| P35 | `env` | Bash only | `ENVIRONMENT_READ` | none |

There are 35 shell productions and 11 structured tool entries. No other input is in G1.

### 1.3 Meaning of a G1 result (normative)

A G1 result describes **the classified argv or tool-call preimage**, as captured before the engine ran the call. It
does not describe the actual side effect. For example, a P13 result for `git push origin main` means "the captured argv
matched the `GIT_PUSH_BRANCH` production targeting branch `main`". It does not prove:

- which executable ultimately ran (aliases, shell functions, `PATH`, `PATHEXT`, `.ps1` shims);
- which git configuration, hooks or helpers ran (`core.fsmonitor`, `diff.external`, hooks, credential helpers);
- what other configuration applied (`~/.curlrc`, Vercel and Supabase link files);
- that the call ran at all, succeeded, or changed `main`.

These are telemetry residuals (section 25), not defects of G1.

## 2. Blocker closure (non-normative review history)

This section records how the source design reached APPROVE. It carries no requirement of its own; every requirement it
mentions is stated normatively in the section it points to. In particular the Edit, Write and NotebookEdit closed key
sets described in 2.4 are approved source-design semantics, stated normatively in 12.1 and 12.1.1.

### 2.1 Revision 1 blockers (closed by revision 2, preserved here)

| Blocker | Revision 2 decision, preserved in this revision | Where |
|---|---|---|
| MOD1-B1 grant-shaped semantics | No copied allow-list in the capability; live shadow policy is the only evaluator; policy-identity mismatch is `SESSION_STALE`; wire verdicts are only `WOULD_*` or `SHADOW_UNKNOWN`; lifecycle states separately typed; non-authority clause in every response; enforcing successor needs a different contract and endpoint | sections 4, 8, 14, 21 |
| MOD1-B2 classifier rule | Sealed rule R0 to R5; G1 closed grammar; UNKNOWN catalogue | sections 1, 11, 12 |
| MOD1-B3 pre-next observation and coverage | Synchronous frozen observation before `next(e)`; key-based correlation; coverage counters and latch; crash gap visible | sections 13 to 15 |
| MOD1-B4 non-canonical namespace | `kj_shadow` schema, no cross-boundary foreign keys, no canonical role access, idempotency, side-effect classes separated | sections 16, 17 |
| MOD1-B5 truth model and digests | Three origin tiers, HEAD descendant semantics, no secrecy-by-digest | sections 9, 18 |
| MOD1-B6 issuance ceremony | One issuer path, HUMAN owner, separate confirmation, reissue creates new capability | sections 5, 6 |

### 2.2 MOD1-B2: CLOSED_BY_R2

The second review claimed the exact G1 production catalogue was absent. Revision 2 contained it in full: the
structured tool table, the path rule, the URL rule, S1 (character set), S2 (argv splitting), S3 (exact executable list
per shell), S4 (token classes), S5 (exact argv productions) and the explicit UNKNOWN catalogue. Revision 3 does not
redesign G1. It copies the grammar unchanged into section 12, adds the self-contained catalogue in section 1 and the
preimage semantics in 1.3, and moves the design into a committed file so that review targets exact bytes rather than
chat context. The productions in section 1.2 are exactly the S5 productions of revision 2, numbered P1 to P35 for
reference.

### 2.3 Revision 2 blockers

| Blocker | Revision 2 defect | Revision 3 decision | Where |
|---|---|---|---|
| MOD1-R2-B1 | `kj_shadow.owner_confirmation` was a generically named "human said yes" record that could be reused for other ceremonies | Replaced by the single-purpose relation `kj_shadow.agent_session_issuance_confirmation`, whose only possible subject is one pending issuance request and its digest, enforced by a composite foreign key; decision vocabulary `CONFIRM`/`REFUSE`; 60-second expiry; one-time consumption made structural by `UNIQUE(confirmation_id)` on the capability; no generic discriminator, payload or foreign resource column; canonical roles and code structurally excluded; static topology check; reuse for any other ceremony requires a new design revision | 5.4, 16.6, 16.7 |
| MOD1-R2-B2 | `canonicality = NON_CANONICAL` was overloaded to mean both "not trusted" and "not evidence" | Three independent closed dimensions: `authority_domain` (`SHADOW_ONLY` or `NONE`), `evidence_canonicality` (always `NON_CANONICAL`), `assertion_origin` (`SERVER_WRITTEN`, `CLIENT_ASSERTED`, `FORGE_VERIFIED`). The capability is trusted for shadow authentication and evaluation and is non-canonical for everything else. Expiry and revocation are mandatory inside the shadow domain | 3.2, 16 |
| MOD1-R2-B3 | "Returned exactly once" with an undefined retrieval nonce | The token is minted inside the authenticated completion request and returned in its response body only. A client-generated completion proof binds completion to the requesting client; its plaintext never leaves the CLI except in that request body and is never stored server-side. Once the mint commits, plaintext token material is never stored; loss is unrecoverable and is handled by revocation and a new ceremony. Memory lifetime defined | 6 |

### 2.4 Revision 3.1: ADR24-B1 / C-1, NARROW SEMANTIC DELTA

**Defect in revision 3.** Revision 3's positive set (1.1) intended `Edit`, `Write` and `NotebookEdit` to participate in
G1, producing `WRITE_WORKTREE`, `WRITE_OUTSIDE_WORKTREE` and `SECRET_WRITE`. But its closed tool table (12.1) gave their
consequential-key set as only "the tool's path key". Under R0 and R1 any other input key makes the whole observation
`UNKNOWN_TOOL_ACTION` with confidence `NONE`. Every real Claude Code 2.1.289 call of these tools carries further
required keys (`old_string` and `new_string`; `content`; `new_source`), so under the literal revision 3 text every
ordinary call of these three tools was UNKNOWN. The ADR-0024 candidate `bfe08fb` changed that silently during
transcription and was correctly BLOCKED (`C1_SEMANTIC_DELTA`).

**Decision.** Revision 3.1 deliberately changes this one semantic. It is a NARROW SEMANTIC DELTA, not a clarification.
For `Edit`, `Write` and `NotebookEdit` only, the closed key set is the full Claude Code 2.1.289 declared key set, of
which exactly one key determines the class (12.1.1).

**Limits.** No new action class. No new shell production. No change to any other structured tool's closed set or rule
(Appendix R31). No change to R0 to R5, to the path rule, to the 64 KiB ceiling, to the observation pipeline, or to any
authority, capability, issuance, token, policy, storage, coverage, child-agent, MOD-2 or P8/B1 semantics.

**G1 membership impact.** The only change from revision 3 is that normal Claude Code 2.1.289 inputs for `Edit`,
`Write` and `NotebookEdit` can now match their existing positive classes in 1.1 instead of becoming UNKNOWN because of
their required non-path keys. Structured entries stay 11; shell productions stay P1 to P35.

## 3. Authority model and record vocabulary

### 3.1 Authority model

- **KernelJSON is the only authority.** For MOD-1 it decides one narrow thing: whether a token may ask shadow questions
  about one mission, and what the shadow policy would say. That decision has no standing in task authority.
- **The Claude Code process is untrusted.** That includes MOD-1, every other mod, the engine's state, its configuration
  storage and the model.
- **The model is adversarial input.** Its free text, including the Bash `description` field, never feeds
  classification or binding.
- **The shadow evaluator** is a pure function inside KernelJSON:
  `(capability record, live mission state, live shadow policy, request) -> verdict`. It is the only evaluator.
- **Dependency direction:** Claude adapter (inside the mod) -> neutral `agent-actions` library (vendored into the mod
  folder, digest-checked against its single source in `packages/`) -> KernelJSON shadow endpoint. KernelJSON core
  imports nothing from the mod or from any Claude type.

**Invariant A1.** Nothing MOD-1 produces or stores can authorise execution, satisfy an approval, satisfy an admission,
satisfy task completion, activate an identity or a release, authorise a deployment, drive the scheduler, or be consumed
as enforcement authority.

### 3.2 Three independent record dimensions

Every `kj_shadow` relation carries all three as constrained columns (section 16). They are independent: no value of
one implies a value of another.

| Dimension | Closed vocabulary | Meaning |
|---|---|---|
| `authority_domain` | `SHADOW_ONLY` | KernelJSON trusts the record for the narrowly defined shadow operation (authenticating a shadow token, evaluating shadow policy, completing an issuance). It grants nothing outside that domain. |
| | `NONE` | Telemetry and operational data. Trusted for nothing, including shadow authentication. |
| `evidence_canonicality` | `NON_CANONICAL` (the only legal value in `kj_shadow`) | The row can never satisfy task evidence, admission, approval, completion, identity activation, release activation, deployment authority or scheduler authority. |
| `assertion_origin` | `SERVER_WRITTEN` | Written by KernelJSON from its own validated state or from a validated HUMAN request. |
| | `CLIENT_ASSERTED` | Reported by the agent process; telemetry only. |
| | `FORGE_VERIFIED` | Established by KernelJSON through a trusted server-side forge integration. |

Assignment:

| Relation | `authority_domain` | `evidence_canonicality` | `assertion_origin` |
|---|---|---|---|
| `agent_session_capability` | `SHADOW_ONLY` | `NON_CANONICAL` | `SERVER_WRITTEN` |
| `agent_session_capability_event` | `SHADOW_ONLY` | `NON_CANONICAL` | `SERVER_WRITTEN` |
| `agent_session_issuance_request` | `SHADOW_ONLY` | `NON_CANONICAL` | `SERVER_WRITTEN` |
| `agent_session_issuance_confirmation` | `SHADOW_ONLY` | `NON_CANONICAL` | `SERVER_WRITTEN` |
| `agent_action_shadow_policy` | `SHADOW_ONLY` | `NON_CANONICAL` | `SERVER_WRITTEN` |
| `agent_shadow_observer_stream` | `NONE` | `NON_CANONICAL` | `SERVER_WRITTEN` (stream bookkeeping) |
| `agent_shadow_observation` | `NONE` | `NON_CANONICAL` | per column group: `client` and `action` are `CLIENT_ASSERTED`; `verdict` group is `SERVER_WRITTEN`; `head_relation` is `FORGE_VERIFIED` only when verified |
| `agent_shadow_rate_counter`, `agent_shadow_access_meta` | `NONE` | `NON_CANONICAL` | `SERVER_WRITTEN` |

**Invariant A2.** `NON_CANONICAL` never means "untrusted, so ignore". Inside the shadow domain, expiry, revocation,
supersession, mission state and policy identity MUST be checked on every request and every failure MUST fail closed
(no shadow answer). `NON_CANONICAL` only means the record is outside canonical task authority and evidence.

**Invariant A3.** A capability is trusted by KernelJSON for `SHADOW_ONLY` authentication and evaluation and is
`NON_CANONICAL` for every canonical authority or evidence purpose.

## 4. Session capability v3

Contract `kerneljson:agent-session-capability/v3`. One row in `kj_shadow.agent_session_capability` per completed
issuance ceremony.

| Field | Origin | Notes |
|---|---|---|
| `capability_id` | SERVER_WRITTEN | UUID, new for every ceremony |
| `generation` | SERVER_WRITTEN | 1 for a new capability; predecessor's generation + 1 for a replacement |
| `supersedes_capability_id` | SERVER_WRITTEN | null, or the one capability this replaces (section 7) |
| `tenant_id`, `mission_id` | SERVER_WRITTEN | copied after validation; no foreign key leaves `kj_shadow` |
| `mission_digest` | SERVER_WRITTEN | SHA-256 of the mission's canonical identity at issuance, so a recreated mission with the same id is detectable |
| `issued_by_principal_id` | SERVER_WRITTEN | the HUMAN requesting principal |
| `issuance_request_id` | SERVER_WRITTEN | the request it completed |
| `confirmation_id` | SERVER_WRITTEN | `UNIQUE NOT NULL`; the confirmation consumed to mint it |
| `issuance_digest` | SERVER_WRITTEN | equals the request's and the confirmation's |
| `agent_shell` | SERVER_WRITTEN label | `claude-code`, `openai-harness`, `deepseek-harness`, `grokbot`, `antigravity`; audit only, never matched by policy |
| `repo_id` | SERVER_WRITTEN | must be in KernelJSON's configured repository registry, e.g. `github:jonnyallum/kerneljson` |
| `bound_branch` | SERVER_WRITTEN as a record | existence on the forge is `FORGE_VERIFIED` or unverified |
| `base_sha` | SERVER_WRITTEN as a record, immutable anchor | existence in the repo is `FORGE_VERIFIED` or unverified |
| `policy_version`, `policy_digest` | SERVER_WRITTEN | identity of the live shadow policy at mint |
| `production_ceiling` | SERVER_WRITTEN | v3 permits only `NONE` |
| `issued_at`, `expires_at` | SERVER_WRITTEN | `expires_at - issued_at` is at most 30 minutes (CHECK) |
| `revoked_at`, `revoked_by_principal_id`, `revocation_reason` | SERVER_WRITTEN | null until revoked; reason in `REVOKED_BY_HUMAN`, `REVOKED_ALL_FOR_MISSION`, `SUPERSEDED`, `DELIVERY_LOST` |
| `credential_digest` | SERVER_WRITTEN, server-only | SHA-256 of the token; `UNIQUE`; never returned |
| `authority_domain`, `evidence_canonicality`, `assertion_origin` | constants | `SHADOW_ONLY`, `NON_CANONICAL`, `SERVER_WRITTEN` |

Not present, by design: any allow-list or copied rule, `protectedBranches`, `expectedHead`, `validUntil` in any form.

The client view, `GET /v1/agent-shadow/session`, returns the public record without `credential_digest`, plus
`canonicalRemotes` (the URL forms of the bound repository that the mod compares `origin` against) and
`observerStreams` (section 15).

## 5. Issuance, replacement and revocation

### 5.1 One issuer path

There is exactly one operation family that can create or end a capability: the **shadow issuance module** of the
KernelJSON gateway. It authenticates callers through the existing door authentication boundary and writes only through
the role `kj_shadow_issuer` (section 16.4). CLI and Telegram are interfaces onto it. Neither can mint by itself.

The following can never mint, replace or extend a capability: a Telegram bot credential alone, any Claude Code mod, a
shadow token (refused at every issuance route), a general task credential, a SERVICE principal, an admission bearer
lacking the issuance scope or lacking a fresh confirmation, or any model action.

Operations:

| Operation | Route (proposed) | Authentication | Confirmation |
|---|---|---|---|
| Issue new | `POST /v1/agent-session-issuance-requests`, then `POST /v1/agent-session-issuance-requests/{id}/complete` | HUMAN door principal with scope `agent_session:issue` | required |
| Replace one capability | as Issue, with `supersedesCapabilityId` | same, and the principal must be the predecessor's issuer, same tenant and mission | required |
| Revoke one | `POST /v1/agent-session-capabilities/{id}/revoke` | HUMAN door principal with scope `agent_session:revoke`, same tenant | not required (only removes authority) |
| Revoke all for a mission | `POST /v1/agent-session-capabilities/revoke-all` with `{missionId}` | same as revoke | not required; explicit human action |
| List own capabilities | `GET /v1/agent-session-capabilities?missionId=` | HUMAN door principal | not required; returns public records only, never a token |
| Read own issuance request | `GET /v1/agent-session-issuance-requests/{id}` | the requesting principal | returns state and, once minted, `capabilityId`; never a token or proof |

If the existing door bearer model has no scopes, the later ADR MUST add the two scopes or a separate HUMAN issuance
credential before implementation; general admission credentials MUST NOT gain the ability to issue.

### 5.2 Issue: request

1. The CLI, run by the HUMAN in their own terminal (not inside Claude Code), generates a **completion proof**: 32 bytes
   from the operating system CSPRNG, held only in CLI process memory (section 6.2).
2. It sends `POST /v1/agent-session-issuance-requests` with `missionId`, `repoId`, `boundBranch`, `baseSha`,
   `ttlMinutes`, `agentShell`, optional `supersedesCapabilityId`, and `completionProofDigest` (SHA-256 of the proof).
   The proof itself is not sent.
3. The module validates, before writing anything: principal kind `HUMAN`; scope present; tenant matches; mission exists,
   belongs to the tenant and is open; `repoId` in the registry; `boundBranch` matches `BRANCH` (S4); `baseSha` is 40 or 64
   lowercase hex; `ttlMinutes` is 1 to 30; for a replacement, the predecessor exists, is unrevoked, unexpired, not
   already superseded, and has the same tenant, mission and issuer. Failure is a typed refusal with nothing stored.
4. It writes one `agent_session_issuance_request` row in state `PENDING` with `issuance_digest` = SHA-256 of the RFC 8785
   canonical serialisation of `{tenantId, requestingPrincipalId, missionId, missionDigest, repoId, boundBranch, baseSha,
   ttlMinutes, agentShell, supersedesCapabilityId, issuanceRequestId}` and `expires_at = created_at + 5 minutes`.
5. It responds `201 {issuanceRequestId, issuanceDigestPrefix, expiresAt}`.

### 5.3 Issue: confirmation

1. The Telegram interface shows the HUMAN owner the request parameters and the first 12 hex characters of the
   issuance digest. It never shows or carries the token or the completion proof.
2. The owner answers `CONFIRM` or `REFUSE`. Telegram carries that answer to the shadow issuance module using the same
   signed hop assertion mechanism ADR-0019 uses for approval answers, bound to the issuance request id and full
   issuance digest.
3. The module verifies the assertion, verifies the confirming principal is a HUMAN owner of the tenant, verifies the
   request is `PENDING` and unexpired and that the digest matches, then writes one
   `agent_session_issuance_confirmation` row (5.4) and moves the request to `CONFIRMED` or `REFUSED`.

Telegram cannot create, alter or consume a confirmation by itself. It only transports the HUMAN's answer; the module
writes the row after verification, and only the mint transaction consumes it.

### 5.4 The single-purpose confirmation relation

`kj_shadow.agent_session_issuance_confirmation`. Its only possible subject is one pending agent-session issuance request
and that request's issuance digest.

| Column | Type and constraint |
|---|---|
| `confirmation_id` | uuid, primary key |
| `tenant_id` | uuid, not null |
| `issuance_request_id` | uuid, not null, **UNIQUE** (one decision per request) |
| `issuance_digest` | bytea, not null, length 32 |
| `requesting_principal_id` | uuid, not null |
| `confirming_principal_id` | uuid, not null |
| `decision` | text, not null, `CHECK (decision IN ('CONFIRM','REFUSE'))` |
| `assertion_key_id` | text, not null; key id of the verified hop assertion |
| `assertion_digest` | bytea, not null, length 32; digest of the verified assertion, for audit |
| `created_at` | timestamptz, not null |
| `expires_at` | timestamptz, not null, `CHECK (expires_at = created_at + interval '60 seconds')` |
| `consumed_at` | timestamptz, null |
| `consumed_by_capability_id` | uuid, null; `CHECK ((consumed_at IS NULL) = (consumed_by_capability_id IS NULL))`; `CHECK (consumed_at IS NULL OR decision = 'CONFIRM')` |
| `authority_domain` | `CHECK (= 'SHADOW_ONLY')` |
| `evidence_canonicality` | `CHECK (= 'NON_CANONICAL')` |
| `assertion_origin` | `CHECK (= 'SERVER_WRITTEN')` |

Structural binding:

- Composite foreign key `(issuance_request_id, tenant_id, issuance_digest, requesting_principal_id)` references the
  `UNIQUE` tuple of the same columns in `agent_session_issuance_request`. A confirmation therefore cannot name another
  request, tenant, digest or principal, and cannot be copied to another tenant, principal or mission (the mission is
  inside the digest).
- `agent_session_capability.confirmation_id` is `UNIQUE NOT NULL` with composite foreign key
  `(confirmation_id, tenant_id, issuance_digest)` into this relation. One confirmation can mint at most one capability,
  whatever happens to `consumed_at`.
- A `BEFORE UPDATE` trigger (security invoker, pinned `search_path`) refuses any update other than setting
  `consumed_at` and `consumed_by_capability_id` from null to non-null once. `kj_shadow_issuer` has column-level UPDATE on
  those two columns only, and no DELETE.

Forbidden columns, by design and checked by the topology test (16.7): no `subject_type`, no action or type
discriminator, no payload or JSON column, no resource id, no task id, no approval id, no identity candidate id, no
release id, no deployment id, no growth-window id, no operation field.

**Invariant C-CONF.** Reuse of this confirmation mechanism, its relation, or a copy of its pattern for any other yes/no
authority ceremony requires a new design revision with its own review. No such reuse is authorised by this design.

### 5.5 Issue: completion and mint

The CLI polls `POST /v1/agent-session-issuance-requests/{id}/complete` with body `{completionProof}` (the plaintext
proof), authenticated as the same requesting principal, every 2 seconds until a terminal answer or the request expiry.

| Request state | Answer | Effect |
|---|---|---|
| `PENDING` | `202 PENDING` | none; proof verified but not consumed |
| `REFUSED` | `409 REFUSED` | none |
| expired, or confirmation expired unconsumed | `410 EXPIRED` | request moves to `EXPIRED` |
| `MINTED` | `409 ALREADY_COMPLETED` | none; the token is not revealed again |
| `CONFIRMED` and proof valid | `200` with public record and token | mint transaction below |

Proof checks: the authenticated principal equals `requesting_principal_id`; SHA-256 of the presented proof is compared
in constant time with `completion_proof_digest`; five wrong proofs move the request to `EXPIRED`.

The mint transaction, in one database transaction under `kj_shadow_issuer`:

1. lock the request row; require `CONFIRMED`, unexpired;
2. consume the confirmation: `UPDATE ... SET consumed_at = now(), consumed_by_capability_id = $new WHERE
   issuance_request_id = $req AND decision = 'CONFIRM' AND consumed_at IS NULL AND expires_at > now() AND
   issuance_digest = $digest RETURNING confirmation_id`; exactly one row or abort;
3. re-read the live shadow policy identity and the mission state; abort if the mission is no longer open;
4. insert the capability with `credential_digest` (the token was generated before the transaction, section 6.3);
5. for a replacement: revoke the predecessor with reason `SUPERSEDED`, conditional on it still being unrevoked, else
   abort;
6. insert `issued` (and, for a replacement, `superseded`) events into `agent_session_capability_event`;
7. move the request to `MINTED` with `minted_capability_id`;
8. commit.

The mint cannot create an admission, task, approval, evidence or identity row, and cannot change a mission, policy or
identity: `kj_shadow_issuer` holds no such grant (16.4).

## 6. Token model and one-time delivery

### 6.1 Token

- Shape: `kjsc_` followed by 43 base64url characters encoding 32 bytes from the gateway's CSPRNG; 48 characters in total
  (length check: 48, regex `^kjsc_[A-Za-z0-9_-]{43}$`).
- At rest: only SHA-256, in `credential_digest`. Plaintext is never stored, encrypted or otherwise.
- Audience `kerneljson-agent-shadow/v3`: accepted only by `GET /v1/agent-shadow/session` and
  `POST /v1/agent-shadow/observations`. Every other route refuses a `kjsc_` credential before any lookup.
- TTL: default 15 minutes, maximum 30, set per issuance, enforced by CHECK. No refresh, no extension. The default is
  short because expiry costs only a display state (Claude continues; the console shows `CAPABILITY_EXPIRED`) while
  bounding a stolen token's useful life to about one edit-and-test burst; reissue is one CLI command and one
  confirmation.

### 6.2 Completion proof: why it exists and its exact properties

Because the HUMAN confirms asynchronously through Telegram, the request that starts issuance cannot simply wait for the
mint without holding an HTTP connection open for up to 5 minutes through the reverse proxy. Completion is therefore a
second authenticated request. Without a binding between the two, any other holder of the same door credential could
complete a request the HUMAN confirmed for themselves and receive the token. The completion proof closes that: only the
CLI process that started the request holds the proof.

It is a bearer secret, and is bounded so that it adds no standing authority:

| Property | Value |
|---|---|
| Generation | 32 bytes from the OS CSPRNG, in the CLI process |
| Server storage | SHA-256 only (`completion_proof_digest`), never plaintext |
| Scope | one issuance request id, and the authenticated requesting HUMAN principal |
| Validity | the request's lifetime (at most 5 minutes) and the confirmation's 60-second window |
| Comparison | constant-time digest comparison |
| Consumption | atomic with the mint; a minted request never accepts it again |
| Transport | only the body of the completion request over TLS; never a URL, query parameter, HTTP header, redirect, Telegram message, log, trace, telemetry record, repository file or KernelJSON evidence |
| Useless alone | it completes nothing without the principal's door credential and a valid `CONFIRM` |

It is not a retrieval nonce: no token exists before completion, so there is nothing to retrieve. The token is minted
inside the completion request and appears only in that request's response.

### 6.3 Exact lifetime of plaintext token material

Server side, inside the completion handler:

1. generate 32 bytes and encode the token, in handler-local memory;
2. compute `credential_digest`;
3. run the mint transaction (5.5) with the digest only; if it fails or aborts, the handler drops the token and returns
   an error; the token never left the process;
4. after commit, serialise the `200` response body with the token and write it to the socket;
5. drop every reference when the handler returns.

The token MUST NOT be passed to the logger, error reporter, tracer, metrics, cache or any persistence path. The route is
excluded from request and response body tracing. JavaScript cannot zero memory, so the plaintext persists in gateway
memory until garbage collection; that residual is stated in section 25.

Client side, inside the CLI:

1. parse the response in memory;
2. write the token to the per-worktree token file (6.5) by creating a temporary file readable only by the current user
   in the same directory, writing, flushing and atomically renaming;
3. drop the in-memory value; never print the token to the terminal.

### 6.4 Loss semantics (normative)

Once the mint transaction commits, plaintext token material is never stored anywhere by KernelJSON. If the response is
lost in transit, the client crashes before writing the file, or the file write fails:

- the token is unrecoverable;
- no GET endpoint reveals it, and there is no "retry reveal";
- the capability MUST be revoked: the CLI calls revoke itself with reason `DELIVERY_LOST` when it knows the capability
  id; otherwise the HUMAN reads the issuance request (which shows `MINTED` and the capability id) and revokes it;
- an unrevoked lost capability expires on its own within its TTL;
- the HUMAN repeats issuance.

The token is never returned through Telegram, never logged, never placed in a URL, query parameter or redirect, and
never written to application traces.

### 6.5 Local storage of the token

- The mod declares one non-sensitive `userConfig` option, `agentSessionDir`: a directory path chosen by the HUMAN.
- The token file for a worktree is `<agentSessionDir>/<worktreeKey>.token`, where `worktreeKey` is the lowercase hex
  SHA-256 of the worktree root after the path normalisation of 12.3. The key is a lookup name, not a secret.
- The mod reads only that file, only if it is at most 64 bytes; it strips one trailing LF, refuses a UTF-8 BOM or any
  other byte, and requires the 48-character regex exactly. Anything else is `CAPABILITY_UNKNOWN` locally.
- The file sits outside every repository. The mod never writes it.
- This is best-effort storage inside an untrusted environment: any process or mod with the user's permissions can read
  it. The security property comes from the token's low authority, short TTL, revocation, audience restriction and the
  pinned endpoint origin, not from local secrecy.

Revision 2 stored the token in a sensitive `userConfig` field. That would make the HUMAN copy plaintext through another
interface, so revision 3 replaces it with the CLI-written file.

### 6.6 Token location and file requirements (HARDENING_H3)

This subsection makes "readable only by the current user" (6.3) and "outside every repository" (6.5) exact. It adds no
state, no authority, no data flow, no new failure state and no recovery or reveal mechanism; every refusal maps to an
existing outcome. The mod does not write the token file (6.5).

Writer (the CLI), before writing the token file, MUST:

1. resolve `agentSessionDir` to its real path: every symbolic link and junction followed, `.` and `..` folded, before
   any of the following decisions;
2. refuse if the resolved directory, or any ancestor of it, contains an entry named `.git` (file or directory), which
   covers repositories and linked worktrees alike;
3. refuse if the target token file exists and is a symbolic link or junction;
4. on POSIX: require the directory to be owned by the current user with mode exactly `0700`; create the temporary file
   with mode `0600`, owned by the current user, independent of `umask`, so that the renamed token file is `0600`;
5. on Windows: require the directory's DACL to be protected (inheritance disabled) with the current user's SID as owner
   and exactly one access-control entry, allowing that SID full control; give the temporary file the same protected
   single-entry DACL at creation;
6. write atomically: create `<worktreeKey>.token.tmp-<16 random hex>` exclusively in the same directory with the
   permissions above, write exactly the 48 token bytes, flush to disk, then rename over `<worktreeKey>.token`
   (replace-existing on Windows);
7. on any failure in steps 1 to 6: delete the temporary file if it exists, write nothing else, and follow 6.4 (revoke
   with reason `DELIVERY_LOST`).

Reader (the mod), only at `session.start` and on rehydration, never inside `tool.call`, MUST:

1. stat `agentSessionDir` and the token file with `$.fs.stat(path, { resolve: true })` (2.1.289 `FsStat`: `kind`,
   `size`, `isLink`, `realPath`); require the directory to be `kind: 'dir'` with a `realPath`, and the file to be
   `kind: 'file'`, `isLink: false`, `size` at most 64, with a `realPath` directly inside the directory's `realPath`;
2. refuse if the directory's `realPath` equals or lies inside the resolved session worktree root, or if the directory
   or any ancestor of it (at most 64 levels) contains an entry named `.git`;
3. apply the content rule of 6.5: at most 64 bytes, one trailing LF stripped, a UTF-8 BOM refused, any other byte
   refused, and the 48-character regex matched exactly, so a malformed value, a truncated value, extra bytes or a BOM
   are all refused;
4. on any refusal: `CAPABILITY_UNKNOWN` locally (as in 6.5 and section 19), nothing sent.

The reader's stats read metadata only. Content is read only from the token file, as 6.5 requires. The pinned API does
not expose file permissions, so owner-only permissions are enforced by the writer and cannot be re-verified by the mod
(section 25).

## 7. Concurrent sessions

- One capability per issuance ceremony. Issuing a new capability never affects any other capability.
- A HUMAN may hold several active capabilities for the same mission (for example two worktrees). They do not invalidate
  one another.
- Replacement affects exactly the one capability named by `supersedesCapabilityId`, in the same mint transaction.
- "Revoke all for this mission" is a separate, explicit HUMAN operation (5.1).
- There is no session-sharing system. Two Claude Code sessions in the same worktree read the same token file and so
  share a capability; KernelJSON sees two observer epochs and the console shows `CAPABILITY_SHARED_OR_RESTARTED`
  (section 15). Child agents never inherit a capability (section 20).

## 8. Shadow policy identity, ceiling and consumer fence

### 8.1 Shadow policy

Contract `kerneljson:agent-action-shadow-policy/v1`, stored in `kj_shadow.agent_action_shadow_policy`, written only by
reviewed migration under the migration owner. `policy_digest` is SHA-256 of the RFC 8785 canonical serialisation of the
rule set. The name is deliberately shadow-specific: it is not KernelJSON's policy engine and shares no table, type or
code path with `policy-gate`.

### 8.2 Evaluation (every request)

1. Load the capability (by `credential_digest`), the live mission state, and the live shadow policy version and digest.
2. If the capability is unknown, expired or revoked: lifecycle response (14.4), nothing stored.
3. If the live digest differs from `capability.policy_digest`: `SESSION_STALE (POLICY_CHANGED)`, verdict
   `SHADOW_UNKNOWN`. A new ceremony is required. Nothing remains "allowed until expiry".
4. If the mission is no longer open: `SESSION_STALE (MISSION_NOT_OPEN)`, verdict `SHADOW_UNKNOWN`.
5. Rebinding checks (section 9): on failure `REBOUND_REQUIRED (reason)`, verdict `SHADOW_UNKNOWN`.
6. Otherwise apply rules in explicit priority order. Rules may match action class, server-side target facts (for
   example a protected-branch list held in the shadow policy, or protection reported by a trusted forge) and live mission
   attributes. Rules never match capability copies or `agent_shell`.

Fixed evaluator constants that policy cannot override:

- class `UNKNOWN_TOOL_ACTION`, or confidence `NONE`, gives `WOULD_REQUIRE_REVIEW`;
- no matching rule gives `WOULD_REQUIRE_REVIEW`;
- `WOULD_ALLOW` is impossible at confidence `NONE`.

### 8.3 Ceiling

Applied after rules; it can only lower a verdict. With `production_ceiling = NONE`, `DATABASE_PRODUCTION_MUTATION` and
`DEPLOY_PRODUCTION` give `WOULD_DENY (PRODUCTION_CEILING)` whatever the rule said.

### 8.4 Consumer fence

The only consumer of the shadow policy is the MOD-1 shadow evaluator. Forbidden consumers: admission, scheduler,
identity, task execution, approval, release, deployment, faculty, P8 reflection or adoption, and any future MOD-2
enforcement. The shadow policy produces `WOULD_*` telemetry only and cannot grant a tool or a capability. Enforcement of
the fence: canonical roles have no `USAGE` on `kj_shadow` (16.5), and the topology check (16.7) refuses any reference to
the policy relation or contract name outside the shadow module.

## 9. Repository truth

| Origin | Values | Use |
|---|---|---|
| `SERVER_WRITTEN` | capability id, generation, tenant, mission, mission state, issuer, confirmation, policy identity, ceiling, expiry, revocation, and `repo_id`/`bound_branch`/`base_sha` as recorded at issuance | evaluator inputs |
| `FORGE_VERIFIED` | only through a trusted server-side forge integration: a SHA exists in the bound repository; `base_sha` is an ancestor of the claimed HEAD; branch protection; canonical repository identity | evaluator inputs only when present. This design assumes no such integration exists unless the later ADR adds one, so these are reported unverified |
| `CLIENT_ASSERTED` | local branch, local HEAD, detached state, worktree root, `remoteMatch` (`CANONICAL`, `OTHER`, `NONE`, computed locally against `canonicalRemotes`), Claude Code version, platform, `agentLoop`, every classification output | telemetry only |

HEAD semantics, returned as `headRelation`:

| Value | Meaning | Effect |
|---|---|---|
| `EQUAL_BASE` | claimed HEAD equals `base_sha` | valid |
| `VERIFIED_DESCENDANT` | the forge proves `base_sha` is an ancestor of the claimed HEAD in the bound repository | valid |
| `UNVERIFIED` | no forge, or the forge does not know the SHA (for example an unpushed commit) | valid as telemetry; the console shows "repo facts client-asserted, unverified" |
| `VERIFIED_NOT_DESCENDANT` | the forge proves the claimed HEAD does not descend from `base_sha` | `REBOUND_REQUIRED (HEAD_NOT_DESCENDANT)` |

Legitimate commits during a session never make it stale by themselves. A claimed branch other than `bound_branch`, a
detached HEAD, or `remoteMatch` other than `CANONICAL` gives `REBOUND_REQUIRED` with reason `BRANCH_MISMATCH`,
`DETACHED` or `REPO_MISMATCH`. A matching branch proves nothing and grants nothing.

## 10. Generic action taxonomy

Contract `kerneljson:agent-action-class/v2`. Names are agent-neutral. `riskClass` uses KernelJSON's existing
`RiskClass` vocabulary and is a fixed function of the class.

Classes with a G1 production:

| Class | Risk |
|---|---|
| `READ_REPOSITORY` | LOW |
| `READ_LOCAL_OUTSIDE_WORKTREE` | MEDIUM |
| `SECRET_READ` | CRITICAL |
| `WRITE_WORKTREE` | MEDIUM |
| `WRITE_OUTSIDE_WORKTREE` | HIGH |
| `SECRET_WRITE` | CRITICAL |
| `GIT_STAGE` | LOW |
| `GIT_BRANCH_CREATE` | LOW |
| `GIT_PUSH_BRANCH` | MEDIUM (protection is a server-side fact, not a class) |
| `GIT_FORCE_PUSH` | CRITICAL |
| `FORGE_READ` | LOW |
| `OPEN_PR` | MEDIUM |
| `MERGE_PR` | HIGH |
| `DEPLOY_PREVIEW` | HIGH |
| `DEPLOY_PRODUCTION` | CRITICAL |
| `DATABASE_LOCAL_MUTATION` | HIGH |
| `DATABASE_PRODUCTION_MUTATION` | CRITICAL |
| `NETWORK_REQUEST` | HIGH |
| `ENVIRONMENT_READ` | HIGH |
| `AGENT_DELEGATE` | HIGH |
| `UNKNOWN_TOOL_ACTION` | HIGH |

Reserved, with no G1 production (such actions are `UNKNOWN_TOOL_ACTION` until a sealed grammar exists): `RUN_TEST`,
`RUN_LOCAL_COMMAND`, `PROCESS_SPAWN`, `PACKAGE_INSTALL`, `DELETE_FILE`, `GIT_COMMIT`, `FORGE_MUTATION`, `DATABASE_READ`,
`EXTERNAL_MESSAGE`.

Sealed class order, for tie-breaking under R2 (later wins): the order of the table above, then the reserved list in the
order given, with `UNKNOWN_TOOL_ACTION` last.

## 11. Sealed classifier rule

**R0.** An observation's components are the tool name and every input field that the tool's closed key set declares
consequential. The non-consequential fields are named per tool and nothing else is non-consequential: `Bash` and
`PowerShell`: `description`, `timeout`; `Read`: `offset`, `limit`, `pages`.

**R1.** If any consequential component falls outside the sealed closed grammar, the whole observation is
`UNKNOWN_TOOL_ACTION` with confidence `NONE`. This includes an unlisted tool, an unknown input key, a wrong value type, a
string outside its token class, an unmatched production, input above 64 KiB, and a classifier exception.

**R2.** Only when every consequential component is in grammar, the class is the highest-risk class any component
produces; ties go to the later class in the sealed class order. G1 has no multi-segment form, so R2 never changes a G1
result. It exists for future sealed grammars only.

**R3.** Confidence: `EXACT` for a structured tool matched through the closed table; `PATTERN` for a G1 shell
production; `NONE` otherwise.

**R4.** Flags never change the class. Closed flag set: `SECRET_SHAPED`, `ENV_REFERENCE`, `CREDENTIAL_URL`,
`BACKGROUND`, `SANDBOX_DISABLED`, `TARGET_ENV_UNVERIFIED`, `BROAD_CONTENT_READ`, `INPUT_TOO_LARGE`, `CLASSIFIER_ERROR`.
`ENV_REFERENCE` is set when the raw command contains `$` followed by `[A-Za-z_]`.

**R5.** The sealed vector file is normative. An implementation that disagrees with any vector is nonconformant.

**R5 vector provenance (HARDENING_H4).** The vector file MUST be derived from this grammar (sections 1, 11 and 12) and
MUST NOT introduce a production, tool entry, key, token class, zone or class result that the grammar does not produce. A
vector whose expected result is anything other than `UNKNOWN_TOOL_ACTION` with confidence `NONE` MUST cite the
structured entry (1.1) or production (P1 to P35) that produces it. A vector that contradicts the grammar is a defect in
the vector file, never an extension of G1; the vector file does not redefine G1, and widening G1 requires a sealed
grammar revision.

## 12. G1 closed grammar (pinned to Claude Code 2.1.289 tool declarations)

### 12.1 Closed tool table

Any tool not listed is `UNKNOWN_TOOL_ACTION`, including every MCP tool, `Skill`, `Workflow`, `TaskCreate`,
`TaskStop`, `SendMessage`, `SendFile`, `PushNotification`, `Artifact`, `RemoteTrigger`, `CronCreate`, `Monitor`, `LSP`,
`EnterWorktree`, and any renamed, aliased or proxied tool.

| Tool | Consequential keys (closed set; any other key, other than the R0 non-consequential keys, is UNKNOWN) | Rule |
|---|---|---|
| `Read` | `file_path` | path zone (12.3): `WORKTREE` gives `READ_REPOSITORY`, `OUTSIDE` gives `READ_LOCAL_OUTSIDE_WORKTREE`, `SECRET` gives `SECRET_READ` |
| `Glob` | `pattern`, `path` (optional) | zone of `path`, or of the session working directory if absent: `READ_REPOSITORY` or `READ_LOCAL_OUTSIDE_WORKTREE` |
| `Grep` | `pattern`, `path`, `glob`, and the option keys declared by the pinned tool schema | as Glob; if `path` or `glob` matches the secret list, `SECRET_READ`; always `BROAD_CONTENT_READ` |
| `Edit` | `file_path` (class key), `old_string`, `new_string`, `replace_all` (revision 3.1, 12.1.1) | zone of `file_path`: `WRITE_WORKTREE`, `WRITE_OUTSIDE_WORKTREE`, `SECRET_WRITE` |
| `Write` | `file_path` (class key), `content` (revision 3.1, 12.1.1) | zone of `file_path`: `WRITE_WORKTREE`, `WRITE_OUTSIDE_WORKTREE`, `SECRET_WRITE` |
| `NotebookEdit` | `notebook_path` (class key), `cell_id`, `new_source`, `cell_type`, `edit_mode` (revision 3.1, 12.1.1) | zone of `notebook_path`: `WRITE_WORKTREE`, `WRITE_OUTSIDE_WORKTREE`, `SECRET_WRITE` |
| `WebFetch` | `url`, `prompt` | URL rule (12.4); `NETWORK_REQUEST`, target host; `prompt` is screened and never sent |
| `WebSearch` | `query`, `allowed_domains`, `blocked_domains` | `NETWORK_REQUEST`, no target; the query is never sent |
| `Agent` | the type keys declared by the pinned schema | `AGENT_DELEGATE`, no target |
| `Bash` | `command`, `run_in_background` (sets `BACKGROUND`), `dangerouslyDisableSandbox` (sets `SANDBOX_DISABLED`) | shell grammar 12.5 |
| `PowerShell` | as `Bash` | shell grammar 12.5 |

#### 12.1.1 Edit, Write and NotebookEdit closed key sets (revision 3.1, NARROW SEMANTIC DELTA)

Source: the Claude Code 2.1.289 `BuiltinToolInputs` declarations written by that build (combined plugin-authoring file
SHA-256 `79ab1ef9555704ac479dfcbc61ef27aa11773da4b98258de19604b07ceae07af`, and the identical
`.claude-plugin/types/claude-code-tools/index.d.ts` laid beside the MOD-0 mod, SHA-256
`acf809b49b884ff52a901d53cc50fd90448150e0016516b98cb0e7ff431c0bb6`). Names and types are copied exactly.

| Tool | Class key | Other legal closed-set keys, with exact 2.1.289 types |
|---|---|---|
| `Edit` | `file_path: string` (required) | `old_string: string` (required), `new_string: string` (required), `replace_all: boolean` (optional) |
| `Write` | `file_path: string` (required) | `content: string` (required) |
| `NotebookEdit` | `notebook_path: string` (required) | `cell_id: string` (optional), `new_source: string` (required), `cell_type: "code" \| "markdown"` (optional), `edit_mode: "replace" \| "insert" \| "delete"` (optional) |

For these three tools only:

1. The listed keys are the complete closed set; each is a consequential component in the sense of R0. Any other key is
   `UNKNOWN_TOOL_ACTION` / `NONE` (R1).
2. The class key alone determines the class, by the zone of its value under the path rule (12.3): `WORKTREE` gives
   `WRITE_WORKTREE`, `OUTSIDE` gives `WRITE_OUTSIDE_WORKTREE`, `SECRET` gives `SECRET_WRITE`. A class key that fails the
   path rule is UNKNOWN.
3. Every other listed key:
   - MUST have exactly its pinned type: `string` or `boolean` as listed, and for `cell_type` and `edit_mode` one of the
     listed literal values; a missing required key, or any other type or value, is `UNKNOWN_TOOL_ACTION` / `NONE`
     (12.2, R1);
   - counts toward the existing 64 KiB total input ceiling (12.2, R1), so an oversize input is
     `UNKNOWN_TOOL_ACTION` / `NONE` with flag `INPUT_TOO_LARGE`;
   - is copied (13 step 2) and locally secret-screened (13 step 4); a match sets `SECRET_SHAPED` and does not change the
     class (R4);
   - is never transmitted to KernelJSON (14.2, 18) and is never retained in the shadow observation (13 step 6 discards
     the raw copy);
   - MUST NOT alter the class: it produces no class of its own, so it contributes nothing under R2.
4. A classifier exception is UNKNOWN with `CLASSIFIER_ERROR` (R1, 13).
5. No other structured tool's closed set or rule changes in revision 3.1 (Appendix R31).

ADR note (non-normative): the 2.1.289 declaration makes `NotebookEdit.cell_type` optional, although its comment says it
is needed when `edit_mode` is `"insert"`. This ADR, like revision 3.1, follows the pinned declaration and adds no
cross-field requirement. Enforcing any tool-schema invariant that the pinned declaration does not state requires a sealed
grammar update.

#### 12.1.2 Grep and Agent key enumeration (PINNED_SCHEMA_ENUMERATION)

The 12.1 rows for `Grep` ("the option keys declared by the pinned tool schema") and `Agent` ("the type keys declared by
the pinned schema") define their closed sets by reference to the pinned 2.1.289 declaration. This subsection pastes the
keys that declaration contains, verified against the combined declaration file (SHA-256
`79ab1ef9555704ac479dfcbc61ef27aa11773da4b98258de19604b07ceae07af`), `BuiltinToolInputs`. It adds no key, no type rule
beyond 12.2, and no classification rule: the 12.1 rule for each tool is unchanged, and the declared types are shown for
reference only.

| Tool | Keys in the pinned declaration (declared type) |
|---|---|
| `Grep` | `pattern` (string, required), `path` (string), `glob` (string), `output_mode` (`"content" \| "files_with_matches" \| "count"`), `-B` (number), `-A` (number), `-C` (number), `context` (number), `-n` (boolean), `-i` (boolean), `-o` (boolean), `type` (string), `head_limit` (number), `offset` (number), `multiline` (boolean) |
| `Agent` | `description` (string, required), `prompt` (string, required), `subagent_type` (string), `model` (`"sonnet" \| "opus" \| "haiku" \| "fable"`), `run_in_background` (boolean), `name` (string), `team_name` (string), `mode` (`"acceptEdits" \| "auto" \| "bypassPermissions" \| "default" \| "dontAsk" \| "plan"`), `isolation` (`"worktree" \| "remote"`) |

Keys without "required" are optional in the declaration. These are the same key lists the source design records in
Appendix R31.2. No `Agent` key affects the class: every in-grammar `Agent` call is `AGENT_DELEGATE` (12.1).

### 12.2 Value types

Every consequential value MUST be a string, number or boolean as declared by the pinned schema. Any other type is
UNKNOWN. Strings are capped individually by the rule that consumes them and in total at 64 KiB.

#### 12.2.1 Deterministic size unit (HARDENING_H5)

H5 is deterministic size-unit hardening, not a new MOD-1 authority semantic. It fixes how the existing 64 KiB ceiling
of 12.2, R1 and section 13 step 2 is measured. It does not change the threshold, the data inspected, what is sent or
retained, or any ordinary input's result.

1. 64 KiB means **65,536 bytes**.
2. The measured size of a structured tool input is the sum, over the consequential keys present (the closed set of
   12.1, 12.1.1 and 12.1.2, excluding the R0 non-consequential keys, which section 13 step 2 does not copy), of the
   encoded size of each value. Key names are not counted.
3. Encoded size of a value, computed on the exact value received, before secret screening or any transformation:
   - a string (including a literal such as `"code"`): its length in UTF-8 bytes, not in JavaScript UTF-16 code units.
     Each Unicode scalar value counts 1 to 4 bytes as UTF-8 defines; an unpaired surrogate code unit counts 3 bytes (the
     size of its WTF-8 encoding, and of U+FFFD);
   - a boolean: 4 for `true`, 5 for `false`;
   - a number: the length in bytes of its shortest round-trip decimal form as produced by ECMAScript
     `Number.prototype.toString`.
   A value of any other type is UNKNOWN by 12.2 before size is considered.
4. A measured size of at most 65,536 is within the ceiling. A measured size of 65,537 or more is
   `UNKNOWN_TOOL_ACTION` / `NONE` with flag `INPUT_TOO_LARGE` (R1, R4).
5. Identical inputs give an identical measured size in every conforming implementation; the second implementation
   required by section 24 MUST compute the same value.
6. The shell `command` keeps its own S1 limit of 512 ASCII bytes, which is reached long before this ceiling.

Threshold vectors are in 24.2.

### 12.3 Path rule

Applied in order; failing any step gives UNKNOWN.

1. Length 1 to 1024, with no NUL or other control character.
2. Replace `\` with `/`.
3. The path MUST start with `[A-Za-z]:/` or `/`. A leading `//` (UNC, `//?/`, `//./`) fails.
4. Lowercase the drive letter.
5. Split on `/`. A segment fails if it is empty, `.` or `..`; ends in `.` or a space; contains `:`; matches `~[0-9]`
   anywhere (8.3 short name); or is a reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to
   `LPT9`, case-insensitive, with or without an extension).
6. Zone `WORKTREE` if and only if the client-asserted worktree root, normalised by steps 1 to 5, is a segment prefix of
   the path. Comparison is case-insensitive on `win32` and case-sensitive elsewhere. Otherwise zone `OUTSIDE`.
7. Zone `SECRET` (overriding 6) if any segment matches the sealed secret list, case-insensitively: `.env`, `.env.*`,
   `.ssh`, `.aws`, `.gnupg`, `.docker`, `.npmrc`, `.pypirc`, `.netrc`, `_netrc`, `.git-credentials`, `id_rsa*`,
   `id_ed25519*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `credentials*`, `secrets*`, `jvault*`, `.vault*`. `*` matches any
   run of characters within one segment.

### 12.4 URL rule (structured tools)

1. Scheme `https` or `http`, case-insensitive; anything else is UNKNOWN.
2. The authority is everything after `://` up to the first `/`, `?` or `#`.
3. If the authority contains `@`: UNKNOWN, flag `CREDENTIAL_URL`; the userinfo is discarded and never processed,
   stored, displayed or sent.
4. The host, lowercased, MUST match `HOST` (12.5, S4) with an optional `:port` of 1 to 5 digits; otherwise UNKNOWN.
5. Only the host is sent.

### 12.5 Shell grammar G1 (the `command` of `Bash` or `PowerShell`)

**S1, characters.** The command MUST be ASCII, 1 to 512 bytes, and every byte MUST be in `[A-Za-z0-9]`, space (0x20),
`-`, `_`, `.`, `/` or `:`. Therefore all of these are excluded and any command containing one is UNKNOWN: `"`, `'`, `\`,
`$`, backtick, `;`, `&`, `|`, `<`, `>`, `(`, `)`, `{`, `}`, `[`, `]`, `*`, `?`, `~`, `!`, `#`, `%`, `^`, `,`, `@`, `+`,
`=`, tab, CR, LF and every non-ASCII byte.

**S2, tokens.** Trim leading and trailing 0x20; split on runs of 0x20. The result is argv, 1 to 16 tokens.

**S3, executable.** argv[0] MUST be exactly, case-sensitive, with no path and no extension:

- `Bash`: `git`, `gh`, `vercel`, `supabase`, `curl`, `printenv`, `env`;
- `PowerShell`: `git`, `gh`, `vercel`, `supabase` (`curl` and `wget` are built-in aliases in Windows PowerShell 5.1).

**S4, token classes.**

| Class | Rule |
|---|---|
| `BRANCH` | `^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$`; MUST NOT contain `..`, `//` or `/.`; MUST NOT end in `/`, `.` or `.lock`; MUST NOT equal `HEAD` |
| `PR` | `^[1-9][0-9]{0,6}$` |
| `PATHTOK` | `^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$`; no `..` segment; relative only |
| `HOST` | `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$` |
| `URL` | `^https://HOST(/[A-Za-z0-9._/-]{0,200})?$`; no port, no query |

**S5, productions.** argv MUST equal one of P1 to P35 in section 1.2 exactly. Anything else is UNKNOWN.

### 12.6 Explicit UNKNOWN catalogue

Each of these is `UNKNOWN_TOOL_ACTION`, confidence `NONE`, because S1, S3 or S5 excludes it:

- pipelines, `&&`, `||`, `;`, redirection, here-docs, command substitution;
- nested shells: `bash -c`, `sh -c`, `pwsh -Command`, `pwsh -EncodedCommand`, `powershell`, `cmd /c`;
- `eval`, `source`, `.`, indirect script execution (`./x.sh`, `node x.js`, `python x.py`), variable-as-command,
  environment assignments (`FOO=1 cmd`), shell aliases and functions;
- git: `git -C`, `git -c` and every other git global option; refspecs containing `:` or `+`; `HEAD` as a push target;
  `--force-with-lease`; submodules; `git worktree`; symbolic refs; bare `git push`; every `git commit`;
- credential-bearing URLs; `gh api`; `ssh`, `scp`, `rsync`;
- `node -e`, `python -c`, `npx`, `pnpm dlx`, every `npm` and `pnpm` command (including `npm install` and `npm test`);
- `docker`, `docker compose`, `docker-compose`;
- response files (`@file`);
- `git.exe`, any path-qualified executable, any case variant (`Git`);
- unlisted MCP tools; renamed or proxied tools.

### 12.7 Behaviour caveats (not defects)

- G1 assumes argv[0] names the standard program. A user-defined shell function or alias of that name, a `PATH` or
  `PATHEXT` substitution, or a shim cannot be detected lexically.
- git honours local configuration and hooks that can run programs; G1 classifies the git operation requested.
- `curl` reads `~/.curlrc`; `vercel` and `supabase` read local link files. G1 does not read them.
- Symlinks and junctions inside the worktree can point outside it; the path rule is lexical.

All of these follow from 1.3: a G1 result describes the preimage, not the effect.

## 13. Immutable pre-next observation

In the `tool.call` hook, all synchronous, in module memory, with no `$` engine call before `next(e)`:

1. **Sequence.** `n = ++counter`. Each module instance has a random 128-bit `observerEpoch` created when it registers;
   every module load, including a hot reload, starts a new epoch at `n = 1`. Both are immutable for the observation.
2. **Copy.** Copy only the tool's consequential keys, as primitives, into a fresh object; reject non-primitives;
   stop at 64 KiB in total. Either failure is UNKNOWN.
3. **Classify** the copy with the pure G1 classifier.
4. **Screen** every string in the copy with the sealed local secret screen: prefixes `sb_secret_`, `sb_publishable_`,
   `sk-or-v1-`, `ghp_`, `github_pat_`, `kjsc_`, `AKIA`; PEM headers; JWT shape; `Bearer` or `Authorization`; URL userinfo;
   base64 or hex runs of 32 or more characters. Output is flags only.
5. **Derive** bounded metadata: class, risk, confidence, flags, `targetKind`; the clear target (branch or host) only if
   screening flagged nothing on it, otherwise `WITHHELD`; `toolName` (18.4); `agentLoop`; and the repository facts from
   the module's cache (branch, HEAD, detached, `remoteMatch`, `repoFactsAsOfSeq`). The cache is refreshed after calls,
   outside the tool path; no file is read before `next`.
6. **Freeze** a `ShadowObservation` recursively, discard the raw copy, and append it to the in-module pending list in
   state `QUEUED`.
7. **Call `next(e)`** with the original `e`, unchanged.
8. **Finally**, whether `next` resolved or threw: schedule delivery with `$.clock.after(0, flush)`, then return the
   result unchanged or rethrow the error unchanged.

If any of steps 1 to 6 throws, the observation is UNKNOWN with `CLASSIFIER_ERROR`; if that also fails, the drop is
counted and coverage is incomplete. `next(e)` is always called. `next` cannot change the observation: it is frozen and
built from a copy.

## 14. Async shadow delivery and wire contracts

### 14.1 Delivery

- `flush` copies the pending list into `$.state` (session memory; never `$.store`, never disk), then sends.
- At most 4 attempts in flight. Each attempt is raced against a 2,000 ms `$.clock.after` timer. `$.http.fetch` cannot be
  aborted, so at most 16 fetches may be outstanding; beyond that no new attempt starts, the list fills, and overflow
  is `DROPPED`.
- A timed-out attempt is retried with the same key after 1 s and after 4 s, then marked `UNACKNOWLEDGED`.
- A response is matched only by `(capabilityId, observerEpoch, n)`. Out-of-order responses are normal. A late response
  for an `UNACKNOWLEDGED` entry is accepted for 60 s. A response for an unknown key is discarded and counted in
  `strayIgnored`.
- The token is sent only in the `Authorization` header and only to an `https` origin on a list compiled into the mod.

### 14.2 Request

`POST /v1/agent-shadow/observations`, contract `kerneljson:agent-action-shadow-request/v3`:

```
{ contract, capabilityId, observerEpoch, n,
  observedAt,
  client: { branch, head, detached, remoteMatch, repoFactsAsOfSeq, claudeCodeVersion, platform },
  action: { actionClass, riskClass, confidence, flags, targetKind, target },
  tool:   { toolKind, toolName },
  agentLoop: "main" }
```

`observedAt` and the `client` and `action` groups are `CLIENT_ASSERTED`. `toolKind` is one of `READ`, `EDIT`, `WRITE`,
`SHELL`, `FETCH`, `AGENT`, `MCP`, `MESSAGE`, `OTHER`. `target` is present only for `targetKind` `branch` or `host`.

### 14.3 Verdict response

Contract `kerneljson:agent-action-shadow-response/v3`. Strict parse: an unknown key, a bad enum, or a body above 2 KiB is
`MALFORMED`.

```
{ contract, authority: "NONE", evidenceCanonicality: "NON_CANONICAL",
  capabilityId, generation, observerEpoch, n, requestDigest,
  sessionState: ACTIVE | SESSION_STALE | REBOUND_REQUIRED,
  staleReason:   POLICY_CHANGED | MISSION_NOT_OPEN            (only with SESSION_STALE),
  reboundReason: BRANCH_MISMATCH | DETACHED | REPO_MISMATCH | HEAD_NOT_DESCENDANT (only with REBOUND_REQUIRED),
  shadowVerdict: WOULD_ALLOW | WOULD_DENY | WOULD_REQUIRE_APPROVAL | WOULD_REQUIRE_REVIEW | SHADOW_UNKNOWN,
  reasonCode, ruleId, livePolicyVersion, livePolicyDigest,
  headRelation: EQUAL_BASE | VERIFIED_DESCENDANT | UNVERIFIED | VERIFIED_NOT_DESCENDANT,
  evaluatedAt }
```

If `sessionState` is not `ACTIVE`, `shadowVerdict` MUST be `SHADOW_UNKNOWN`; any other combination is `MALFORMED`.
`reasonCode` is a closed enum: `CLASS_RULE_MATCHED`, `NO_RULE_MATCHED`, `UNKNOWN_ACTION`, `PROTECTED_TARGET`,
`PRODUCTION_CEILING`, `POLICY_CHANGED`, `MISSION_NOT_OPEN`, `REBOUND`.

### 14.4 Lifecycle response

Contract `kerneljson:agent-shadow-session-state/v3`, sent with HTTP 401; nothing is stored:
`{ contract, authority: "NONE", sessionState: CAPABILITY_EXPIRED | CAPABILITY_REVOKED | CAPABILITY_UNKNOWN }`.

### 14.5 Non-authority clause (normative text in both response contracts)

"This response cannot authorise execution, cannot satisfy an approval, cannot satisfy an admission, cannot satisfy task
completion, and cannot be consumed as enforcement authority."

## 15. Coverage accounting

Per-observation states: `QUEUED`, `IN_FLIGHT`, `RETRY_WAIT`, `RESPONDED`, `REJECTED` (lifecycle response, sequence
mismatch, or HTTP 429 after retries), `MALFORMED`, `UNACKNOWLEDGED`. A `DROPPED` observation never entered the list.

Counters, per epoch, saturating at 2^31 - 1 (saturation makes coverage `UNPROVEN`): `classified`, `enqueued`,
`dropped` (list full at 128 non-terminal entries, or a pre-`next` failure), `sent` (at least one attempt), `responded`,
`rejected`, `malformed`, `unacknowledged`, `timedOut` (attempt timeouts, an event count), `strayIgnored`, and the gauges
`queued`, `inFlight`, `retryWait`.

Invariants, asserted after every transition; a failure is itself `UNPROVEN`:

- I1: `classified = enqueued + dropped`
- I2: `enqueued = queued + sent`
- I3: `sent = inFlight + retryWait + responded + rejected + malformed + unacknowledged`

Display:

- `SHADOW_COVERAGE_INCOMPLETE` when `dropped`, `rejected`, `malformed` or `unacknowledged` is above zero, or there is an
  epoch gap. This latches for the epoch; a late response updates counters but not the latch.
- `PENDING` when `queued + inFlight + retryWait > 0`.
- `COMPLETE` otherwise.

The console never shows a clean summary while incomplete. `/kj-status` prints the counters and "Coverage incomplete:
N observation(s) not acknowledged by KernelJSON."

**Module reload.** A new module instance MAY treat an earlier epoch as `PROVEN` only if that epoch's counters and list
are present in `$.state`, I1 to I3 reconcile, and every entry ends `RESPONDED`. Any reload that cannot prove continuity
in exactly that way is equivalent to process restart: `PRIOR_COVERAGE_UNPROVEN`. A reload never silently inherits
`COMPLETE`.

**Process death** loses all session memory. On restart a new epoch begins. `GET /v1/agent-shadow/session` returns
`observerStreams`: for each earlier epoch `{epoch, firstN, lastN, gapCount, lastReceivedAt}`. Whenever an earlier epoch
exists the console shows `PRIOR_COVERAGE_UNPROVEN`, because the server sees only what it received. If the server is
unreachable: "prior coverage: UNKNOWN". There is no disk journal and no fabricated history.

Child-agent observations (section 20) are counted separately and are outside these invariants.

## 16. Shadow-only storage model

This is the storage contract for the later ADR. Nothing is built by this design.

ADR note on "the later ADR" (FRONT_MATTER). The source design refers in sections 5.1, 16.4, 16.7, 22 and 26 to "the
later ADR" for items it deliberately left to be fixed before implementation: the door scopes or a separate HUMAN
issuance credential (5.1), each shadow function's exact privileges (16.4), the delta manifest (22, 26), the Telegram
confirmation transport wiring (26), and the final allowed-path set of the topology check (16.7, where the source design
gives a proposal). This ADR fixes everything the source design fixed and does not invent the rest. In this ADR each
"later ADR" reference means a sealed amendment to this ADR, or a sealed successor ADR, that MUST define those items
before any implementation (section 26). They are valid deferred preconditions; implementation is prohibited until they
are separately sealed.

### 16.1 Schema

Schema `kj_shadow`, schema comment `kerneljson:shadow/v1 authority_domain=SHADOW_ONLY|NONE
evidence_canonicality=NON_CANONICAL`. Relations:

| Relation | Purpose |
|---|---|
| `agent_session_issuance_request` | pending, confirmed, refused, minted and expired issuance requests; holds `completion_proof_digest`, `issuance_digest`, `minted_capability_id`; `UNIQUE (issuance_request_id, tenant_id, issuance_digest, requesting_principal_id)` |
| `agent_session_issuance_confirmation` | section 5.4 |
| `agent_session_capability` | section 4 |
| `agent_session_capability_event` | append-only `issued`, `superseded`, `revoked` events |
| `agent_action_shadow_policy` | section 8.1 |
| `agent_shadow_observer_stream` | one row per observer epoch |
| `agent_shadow_observation` | shadow observations |
| `agent_shadow_rate_counter` | operational rate limits |
| `agent_shadow_access_meta` | last-used time and access metadata |

Every row carries `authority_domain`, `evidence_canonicality` and `assertion_origin` with CHECK constraints fixing the
values in 3.2.

#### 16.1.1 Issuance request columns and mutability (HARDENING_H2)

`agent_session_issuance_request` holds exactly these columns: `issuance_request_id`, `tenant_id`,
`requesting_principal_id`, `mission_id`, `mission_digest`, `repo_id`, `bound_branch`, `base_sha`, `ttl_minutes`,
`agent_shell`, `supersedes_capability_id`, `issuance_digest`, `completion_proof_digest`, `state`, `failed_proof_count`,
`minted_capability_id`, `created_at`, `expires_at`, `state_changed_at`, `authority_domain`, `evidence_canonicality`,
`assertion_origin`.

- `state` is `CHECK (state IN ('PENDING','CONFIRMED','REFUSED','MINTED','EXPIRED'))`, the states of 5.3 and 5.5.
- `expires_at = created_at + interval '5 minutes'` (CHECK), as in 5.2.
- `failed_proof_count` is an integer from 0 to 5 (CHECK); reaching 5 moves the request to `EXPIRED` (5.5).
- The only columns that may change after insert are the state-machine fields `state`, `failed_proof_count`,
  `minted_capability_id` and `state_changed_at`. `kj_shadow_issuer` has column-level UPDATE on those four only (this is
  the "column-limited UPDATE" of 16.4), and no other grant on this relation beyond the INSERT and SELECT of 16.4. Every
  other column, including `issuance_digest` and `completion_proof_digest`, is immutable after creation.
- A `BEFORE UPDATE` trigger (SECURITY INVOKER, `SET search_path = pg_catalog, kj_shadow`, as 5.4's and 16.4's) refuses:
  any change to an immutable column; a `state` transition other than `PENDING` to `CONFIRMED`, `REFUSED` or `EXPIRED`,
  or `CONFIRMED` to `MINTED` or `EXPIRED`; a decrease of `failed_proof_count`; and any change of
  `minted_capability_id` other than null to non-null once, together with the move to `MINTED`.

### 16.2 Foreign keys

- Foreign keys inside `kj_shadow` are permitted (they are how 5.4 binds confirmations to requests and capabilities).
- No foreign key leaves `kj_shadow`: none into missions, tasks, approvals, admissions, evidence, identity, release,
  deployment, growth windows or the scheduler. Mission id and mission digest are values checked at issuance and at every
  evaluation.
- No foreign key from any canonical relation into `kj_shadow`.

### 16.3 Side-effect classes on the shadow endpoint

1. **Evaluation**: pure and deterministic; no I/O inside the function.
2. **Telemetry storage**: inserts into `agent_shadow_observer_stream` and `agent_shadow_observation`; idempotent;
   `authority_domain = NONE`; purged after 14 days.
3. **Operational data**: `agent_shadow_rate_counter` (120 requests per minute per capability, burst 240, then HTTP
   429), `agent_shadow_access_meta`, and access-log metadata. All inside `kj_shadow` (or, for process logs, never
   containing the token or a request body), `authority_domain = NONE`, `NON_CANONICAL`, purgeable.

None of the three can become mission or task evidence.

### 16.4 Shadow roles

Two future runtime roles, `kj_shadow_door` and `kj_shadow_issuer`, each:

- `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`;
- own nothing; are members of no role; have no members; therefore cannot `SET ROLE` to any canonical role or the
  migration owner;
- cannot change any schema, function, trigger or policy ownership or definition;
- have no canonical write grant, no migration authority, no release, identity, admission or approval authority.

Grants:

| Role | Grants |
|---|---|
| `kj_shadow_door` | SELECT on `agent_session_capability`, `agent_action_shadow_policy`; INSERT and SELECT on `agent_shadow_observer_stream`, `agent_shadow_observation`; INSERT and UPDATE on `agent_shadow_rate_counter`, `agent_shadow_access_meta`; outside the schema, column-scoped SELECT on mission id, tenant and state through a `security_invoker` view |
| `kj_shadow_issuer` | INSERT, SELECT and column-limited UPDATE on `agent_session_issuance_request`; INSERT, SELECT and UPDATE of (`consumed_at`, `consumed_by_capability_id`) only on `agent_session_issuance_confirmation`; INSERT, SELECT and UPDATE of revocation columns only on `agent_session_capability`; INSERT on `agent_session_capability_event`; SELECT on `agent_action_shadow_policy`; the same mission view |

Neither role has DELETE anywhere. MOD-1 introduces no SECURITY DEFINER function. ADR-0023 section 27.9 remains unrelated
and unchanged. Any shadow function or trigger is SECURITY INVOKER, pins `SET search_path = pg_catalog, kj_shadow`, and
has `EXECUTE` revoked from `PUBLIC`; the later ADR states each one's privileges.

### 16.5 Structural exclusion of canonical paths

- `kj_worker` has no `USAGE` on `kj_shadow`.
- `kj_door` has no `USAGE` on `kj_shadow`.
- No canonical role has SELECT on any `kj_shadow` relation, including `agent_session_issuance_confirmation`.
- No canonical function, view or trigger references `kj_shadow`.

Consequently no approval consumer, identity-change code, deployment or release path, growth-window path, scheduler path,
admission path, completion path or evidence verifier can read a shadow row: the database refuses.

No promotion: no function, trigger or role holds both SELECT on `kj_shadow` and INSERT on a canonical evidence,
approval or admission relation, apart from the migration owner.

The gateway authenticates the HUMAN through the existing door authentication code, then performs every shadow write with
a separate `kj_shadow_issuer` pool and every shadow read with a separate `kj_shadow_door` pool, each with its own
runtime guard in the style of B1's `runtimePool`.

### 16.6 Privilege checks (each with a planted negative case)

- `has_schema_privilege` for `kj_worker`, `kj_door` and every other canonical role on `kj_shadow` with `USAGE` is false;
  fails when a grant is planted.
- `has_table_privilege` for every canonical role on `agent_session_issuance_confirmation` is false for every privilege;
  fails when a grant is planted.
- Shadow roles have the attributes in 16.4, no memberships, no members, no owned objects, and no write grant outside
  `kj_shadow`; each fails when planted.
- A catalogue query finds no foreign key crossing the `kj_shadow` boundary in either direction; fails when one is
  planted.
- CHECK constraints refuse `evidence_canonicality = 'CANONICAL'`, an `authority_domain` outside the vocabulary, and a
  confirmation `decision` outside `CONFIRM`/`REFUSE`.

### 16.7 Static topology check

Only the MOD-1 shadow modules and their migrations may reference these identifiers: `kj_shadow`,
`agent_session_issuance_confirmation`, `agent_session_issuance_request`, `agent_session_capability`,
`agent_action_shadow_policy`, `agent-action-shadow-policy`, `agent-action-shadow-request`,
`agent-action-shadow-response`, `kjsc_`. The later ADR names the allowed paths; proposed: `packages/agent-shadow/`,
`apps/gateway/src/agent-shadow/`, and migrations whose names contain `kj_shadow`. A planted reference from any other path
MUST fail qualification. The same check refuses any column named in the forbidden list of 5.4 inside
`agent_session_issuance_confirmation`.

## 17. Idempotency and replay

- Key `(capabilityId, observerEpoch, n)`, unique in `agent_shadow_observation`.
- `requestDigest` is SHA-256 of the RFC 8785 canonical request body.
- Same key and same digest: return the stored response byte for byte, without re-evaluation, even if policy changed.
- Same key and different digest: HTTP 409 `SHADOW_SEQUENCE_MISMATCH`; nothing stored; the client marks `REJECTED`.
- At most 64 epochs per capability and `n` at most 1,000,000 per epoch; beyond either, HTTP 409.
- An expired, revoked or unknown token stores nothing.
- A replay by a thief returns only answers the token already earned; after expiry, only the lifecycle response.

## 18. Secret and target handling

1. Revision 3 sends no target digest and holds no salt. Correlation uses `observerEpoch`, a random 128-bit value. The
   only hash of a client value is `worktreeKey` (6.5), a local file-name key that is never sent.
2. Sent in clear only after bounding and screening: branch (MUST match `BRANCH`, else `INVALID`; screened, else
   `WITHHELD`), HEAD (40 or 64 hex, else `INVALID`), URL host (`HOST`, after userinfo refusal), tool name.
3. Never sent: raw tool input, commands, paths (only the zone), URL paths or queries, prompts, model output, source,
   environment values, remote URLs (only `remoteMatch`), the completion proof.
4. Tool names: built-in names MUST match `^[A-Za-z][A-Za-z0-9_]{0,63}$`; MCP names `^mcp__[A-Za-z0-9_-]{1,123}$`; both
   are screened. Malformed or flagged names are sent as `MALFORMED` and the observation is UNKNOWN.
5. Local retention: a display ring of the last 50 terminal entries `{epoch, n, toolKind, actionClass, flags,
   shadowVerdict, reasonCode, sessionState}`, the counters, and the public capability record. No token in `$.state`.
   Nothing in `$.store`, the transcript or any file written by the mod.

## 19. Failure states

None grants anything, and in every case `next(e)` runs unchanged.

| Condition | Shown |
|---|---|
| No token file for this worktree | `UNBOUND`; classified locally, nothing sent, coverage N/A |
| Token file malformed (length, BOM, regex), or token location refused (6.6) | `CAPABILITY_UNKNOWN`; nothing sent |
| KernelJSON unreachable, 5xx, or timeout after retries | `SHADOW_UNKNOWN`, entry `UNACKNOWLEDGED`, coverage incomplete |
| Malformed response | `SHADOW_UNKNOWN (malformed)`, coverage incomplete |
| Token expired, revoked or unknown | `CAPABILITY_EXPIRED`, `CAPABILITY_REVOKED`, `CAPABILITY_UNKNOWN`; sending stops; coverage incomplete |
| Live policy digest differs | `SESSION_STALE (POLICY_CHANGED)` |
| Mission not open | `SESSION_STALE (MISSION_NOT_OPEN)` |
| Capability replaced | `CAPABILITY_REVOKED` (reason `SUPERSEDED` on the public record) |
| Branch mismatch, detached, `remoteMatch` not canonical, HEAD proven not descendant | `REBOUND_REQUIRED (reason)` |
| HEAD unverifiable | normal verdict, labelled "repo facts UNVERIFIED" |
| List full | `SHADOW_DROPPED`, coverage incomplete |
| Idempotency mismatch | `REJECTED`, coverage incomplete |
| Rate limited after retries | `REJECTED`, coverage incomplete |
| Restart, or reload without proven continuity | `PRIOR_COVERAGE_UNPROVEN` |
| Concurrent epochs on one capability | `CAPABILITY_SHARED_OR_RESTARTED` |
| Unknown action | `WOULD_REQUIRE_REVIEW` |

## 20. Child agent boundary

**Invariant C1.** A delegated agent, subagent, teammate, workflow agent or engine fork does not inherit the parent's
KernelJSON session capability.

- The parent's `Agent` call is the parent's own action and is observed as `AGENT_DELEGATE`.
- A `tool.call` whose `AgentLoop.agentId` is present (Claude Code 2.1.289: absent on the main loop, present for
  subagents, teammates, workflow agents and engine forks) is classified locally and recorded as `UNBOUND_CHILD`. It is
  never sent under the parent's token. It has its own counter `childObserved`, outside the coverage invariants. The
  console shows "N child-agent actions observed, unbound."
- If a future engine makes the loop undeterminable, the adapter treats the call as `UNBOUND_CHILD`, never as main.
- `agentLoop` and `agentId` are `CLIENT_ASSERTED` telemetry, not identity.
- Child-capability issuance is not designed in MOD-1.

## 21. MOD-1 / MOD-2 non-reuse fence

**Invariant F1.** Any enforcing adapter MUST use a different versioned contract namespace (not
`agent-action-shadow`), a different endpoint, a different token audience and prefix, and its own sealed policy
evaluated fresh at decision time.

MOD-2 MUST NOT reuse any of the following as authority. Each may serve only as research input to a new MOD-2 design:

| MOD-1 artefact | Status |
|---|---|
| G1 classifier and grammar | SHADOW_ONLY |
| G1 confidence levels | SHADOW_ONLY |
| shadow request schema | SHADOW_ONLY |
| shadow verdict response schema and lifecycle response schema | SHADOW_ONLY |
| shadow token (`kjsc_`) and its audience | SHADOW_ONLY |
| shadow endpoints | SHADOW_ONLY |
| retrospective ordering (observe, run, report) | SHADOW_ONLY |
| tolerance of dropped telemetry | SHADOW_ONLY |
| `CLIENT_ASSERTED` git facts | SHADOW_ONLY |
| coverage counters and the epoch model | SHADOW_ONLY |
| ring state | SHADOW_ONLY |
| `kj_shadow` observation rows and all `kj_shadow` storage | SHADOW_ONLY |
| shadow policy (`agent-action-shadow-policy`) | SHADOW_ONLY |
| issuance ceremony, completion proof and `agent_session_issuance_confirmation` | SHADOW_ONLY (and invariant C-CONF) |
| abstract action class names | POTENTIALLY_REUSABLE_AFTER_NEW_REVIEW |
| opaque token shape (prefix pattern, entropy, digest-only storage) | POTENTIALLY_REUSABLE_AFTER_NEW_REVIEW |
| audience-restriction principle | POTENTIALLY_REUSABLE_AFTER_NEW_REVIEW |
| "UNKNOWN means not understood" | POTENTIALLY_REUSABLE_AFTER_NEW_REVIEW |
| path, URL and secret-screen rules | POTENTIALLY_REUSABLE_AFTER_NEW_REVIEW |

Enforcement: shadow tokens are refused at every non-shadow route; a type-level test asserts no shadow response type is
assignable to any authority input type (`Decision`, approval, admission) and fails on purpose when one is made
assignable; MOD-2 cannot begin without its own design and seal.

Consequence of F1, stated for the avoidance of doubt (FRONT_MATTER): there is no "enable enforcement" switch or mode. No
configuration, flag, policy rule or response value turns MOD-1 into enforcement. Future enforcement requires a new
design, a new seal, a new contract, a new endpoint, a different token audience and prefix, and fresh decision-time
evaluation.

## 22. P8 / B1 separation

- P8 and B1 proceed on their existing programme: B1 -> P8A-0 -> B2 -> P8A-1 -> P8A-2 -> P8B. MOD-1 enters none of
  these steps and P8 does not wait for MOD-1.
- The B1 candidate `108db1b0db5923993eb17888d3039c5a32890c2c` and its frozen grant manifest are unchanged. No MOD-1
  schema, role or grant enters B1. ADR-0023 is unchanged.
- MOD-1 track: MOD-0 (draft PR #51) -> MOD-1 design (this document) -> independent hostile review of this exact
  document SHA -> a separately numbered ADR (not ADR-0023) defining `kj_shadow`, its roles and a delta manifest, plus
  privilege checks asserting the B1 roles have no access to `kj_shadow` -> implementation only once B1 is merged, its
  least-privilege health check is green where it runs, and no P8 change window is open.

ADR statement of the same separation (FRONT_MATTER). In this ADR the "separately numbered ADR" above is this ADR-0024
together with its sealed amendment or successor (section 16 note). Explicitly:

- MOD-1 is not a prerequisite for P8A-0, or for any P8 step; P8 does not wait for MOD-1.
- The B1 candidate `108db1b0db5923993eb17888d3039c5a32890c2c` is unchanged by this ADR.
- No MOD-1 object (the `kj_shadow` schema, its relations, `kj_shadow_door`, `kj_shadow_issuer`, their grants) enters
  the frozen B1 manifest. MOD-1 objects enter only through a separate delta manifest.
- ADR-0023 is unchanged.
- MOD-1 implementation may occur only later, after B1 is merged and qualified, and outside any active P8 change window.

## 23. Hostile attack tables

### 23.1 Classification examples under G1

| Input (tool) | G1 result | Reason | Expected display |
|---|---|---|---|
| `git push origin main` (Bash or PowerShell) | `GIT_PUSH_BRANCH`, `PATTERN`, target `main` | P13 | per live shadow policy; with `main` protected in that policy, `WOULD_DENY (PROTECTED_TARGET)`. Preimage only (1.3) |
| `git push origin feature/x` | `GIT_PUSH_BRANCH`, target `feature/x` | P13 | per policy |
| `git push --force origin feature/x` | `GIT_FORCE_PUSH` | P15 | per policy |
| `git push --force-with-lease origin HEAD:main` | UNKNOWN / NONE | no production; `HEAD:main` fails `BRANCH` | `WOULD_REQUIRE_REVIEW` |
| `git -C .. push origin main` | UNKNOWN | git global option | `WOULD_REQUIRE_REVIEW` |
| `bash -c "git push origin main"` | UNKNOWN | S1 (`"`), S3 | `WOULD_REQUIRE_REVIEW` |
| `pwsh -EncodedCommand ...` | UNKNOWN | S3 | `WOULD_REQUIRE_REVIEW` |
| `node -e ...` | UNKNOWN | S3 | `WOULD_REQUIRE_REVIEW` |
| `python -c ...` | UNKNOWN | S3 | `WOULD_REQUIRE_REVIEW` |
| `npm install package` | UNKNOWN | S3; lifecycle scripts are indirect execution | `WOULD_REQUIRE_REVIEW` |
| package with postinstall | UNKNOWN | same | `WOULD_REQUIRE_REVIEW` |
| `npx some-tool` | UNKNOWN | S3 | `WOULD_REQUIRE_REVIEW` |
| `curl https://example.com` (Bash) | `NETWORK_REQUEST`, host `example.com` | P31 | per policy; `~/.curlrc` residual |
| `curl https://example.com` (PowerShell) | UNKNOWN | S3 | `WOULD_REQUIRE_REVIEW` |
| curl with an `Authorization` header | UNKNOWN, `SECRET_SHAPED` | S1, no `-H` production | `WOULD_REQUIRE_REVIEW`; header never retained or sent |
| `gh api -X DELETE ...` | UNKNOWN | no production | `WOULD_REQUIRE_REVIEW` |
| `supabase db push` | `DATABASE_PRODUCTION_MUTATION`, `TARGET_ENV_UNVERIFIED` | P30 | `WOULD_DENY (PRODUCTION_CEILING)` |
| `supabase db push --linked` | UNKNOWN | no production | `WOULD_REQUIRE_REVIEW` |
| `psql "$DATABASE_URL" -c ...` | UNKNOWN, `ENV_REFERENCE` | S1, S3 | `WOULD_REQUIRE_REVIEW` |
| `vercel --prod` | `DEPLOY_PRODUCTION` | P27 | `WOULD_DENY (PRODUCTION_CEILING)` |
| unknown MCP wrapper | UNKNOWN | 12.1 | `WOULD_REQUIRE_REVIEW` |
| `FOO=1 git push origin main` | UNKNOWN | S1 (`=`) | `WOULD_REQUIRE_REVIEW` |
| `git push` | UNKNOWN | no production | `WOULD_REQUIRE_REVIEW` |
| `git.exe push origin main`, `Git push origin main` | UNKNOWN | S3 | `WOULD_REQUIRE_REVIEW` |
| `git  push  origin  main` (repeated spaces) | as `git push origin main` | S2 collapses runs | as P13 |
| `git commit -m "..."` | UNKNOWN | S1; no `GIT_COMMIT` production | `WOULD_REQUIRE_REVIEW` |
| `git push origin main` with `description: "harmless read"` | as P13 | `description` is non-consequential (R0) | as P13 |
| Read `C:\Users\x\.ssh\id_rsa` | `SECRET_READ`, `EXACT` | 12.3 step 7 | per policy |
| Read `C:/repo/PROGRA~1/x` | UNKNOWN | 12.3 step 5 | `WOULD_REQUIRE_REVIEW` |
| WebFetch `https://user:tok@host/` | UNKNOWN, `CREDENTIAL_URL` | 12.4 step 3 | `WOULD_REQUIRE_REVIEW`; userinfo discarded |
| Bash with an unknown extra input key | UNKNOWN | 12.1 closed key set | `WOULD_REQUIRE_REVIEW` |

### 23.2 Design threats

| # | Threat | Guard | Residual |
|---|---|---|---|
| 1 | Malicious mod reads the token file | shadow-only audience, 15-minute default TTL, revocation, pinned origin | theft possible by design; impact is read-only shadow questions for one mission |
| 2 | Token used in another repo or branch | `remoteMatch` and branch give `REBOUND_REQUIRED` | client-asserted; a lying client gains nothing |
| 3 | Replay after expiry | lifecycle response, nothing stored | none |
| 4 | Mission closes mid-session | live check, `SESSION_STALE` | one request of lag |
| 5 | Classifier understates; nested shell hides a mutation | closed G1 and R1 | preimage caveats, 12.7 |
| 6 | Tool renamed or proxied through MCP | closed table | none |
| 7 | KernelJSON unavailable | nothing on the tool path; coverage incomplete | none |
| 8 | Stale policy | digest checked live | none |
| 9 | Model influences classification | R0, argv-exact matching | command text is model-written |
| 10 | Raw secret in tool input | never sent; flags only | secret remains in Claude's own transcript |
| 11 | Response tampered | strict schema; nothing consumes it as authority | display falsification only |
| 12 | MOD-2 trusts MOD-1 | F1 and the type fence | discipline at the MOD-2 gate |
| 13 | Confirmation reused for another ceremony | single-purpose relation, composite FK, `UNIQUE(confirmation_id)` on capability, topology check, C-CONF | none within this design |
| 14 | Confirmation copied to another tenant, principal or mission | composite FK to the request tuple; mission inside the digest | none |
| 15 | Confirmation consumed twice | `UNIQUE(confirmation_id)` on capability; trigger; conditional UPDATE | none |
| 16 | Canonical code reads a confirmation as "human approved" | no `USAGE`, no SELECT, topology check, planted negatives | none |
| 17 | Co-holder of the door credential claims a confirmed token | completion proof bound to the requesting CLI | an attacker holding both the door credential and the CLI process memory |
| 18 | Token lost after mint | unrecoverable; revoke `DELIVERY_LOST`; expiry bounds it | none |
| 19 | Token leaks through logs or traces | route excluded from body tracing; static test that the token value is never passed to logger, tracer or error reporter | garbage-collection lifetime in gateway memory |
| 20 | New issuance silently kills a parallel session | one capability per ceremony; replacement names exactly one predecessor | none |
| 21 | `NON_CANONICAL` read as "ignore revocation" | A2: shadow-domain checks are mandatory and fail closed | none |
| 22 | Telegram forges or replays a confirmation | signed hop assertion bound to request id and full digest; `UNIQUE(issuance_request_id)`; 60-second expiry | single-owner deployment: requester and confirmer are the same person |

## 24. Test and mutation requirements

Every check has a negative case that fails on purpose, added in the same change.

- **Normative vectors**, at least 300: every S1 excluded character alone and embedded; every S3 program on each shell;
  every production P1 to P35 and one-character variants of each; every item in 12.6; every path-rule step; the secret
  list; URL userinfo; 64 KiB and 64 KiB plus one byte; unknown keys and wrong types for every tool; every row of 23.1.
- **Two implementations**: an independent Python implementation of G1 MUST agree with the TypeScript implementation on
  every vector and on a 100,000-case grammar-aware fuzz corpus; any difference fails.
- **Classifier mutations to kill**: remove R1; allow R2 with an UNKNOWN component; add `+`, `=` or `"` to S1; add `npm`
  to S3; accept `HEAD:main`; drop the 8.3 rule; read `description`; give `PowerShell` `curl`; add a production not in
  1.2.
- **Ordering**: `next` receives the identical `e`; result or exception unchanged under every verdict, outage, hang and
  malformed response; zero `$` calls before `next`; the observation is deep-equal after `next`; a hung fetch adds no tool
  latency. Mutations: build after `next`; await the fetch before `next`; reuse a sequence.
- **Coverage**: I1 to I3 after every transition in a randomised stream; overflow latches incomplete with the console
  text; a late response does not clear the latch; restart and unproven reload show `PRIOR_COVERAGE_UNPROVEN`; proven
  reload handover; out-of-order matching. Mutations: silent drop; clear the latch; match by arrival order; inherit
  `COMPLETE` across an unproven reload.
- **Secrets**: fixtures for each prefix appear nowhere in requests, state, ring or display; the token appears only in
  the `Authorization` header; userinfo discarded; the token file reader refuses a BOM, a 47- or 49-character value and
  trailing junk. Mutation: persist the raw command.
- **Evaluator**: purity; policy-digest mismatch is `SESSION_STALE`; `UNKNOWN` never becomes `WOULD_ALLOW`; ceiling only
  lowers; idempotency (same digest returns stored result, different digest 409); lifecycle response stores nothing;
  shadow token refused at every other route.
- **Issuance**: refuses a SERVICE principal, a missing scope, a missing, refused, expired or digest-mismatched
  confirmation, TTL above 30, a mission not open, a replacement of another principal's or an already superseded
  capability; a wrong completion proof returns no token and five end the request; a second completion returns
  `ALREADY_COMPLETED` without the token; a confirmation cannot mint twice even with `consumed_at` reset; a
  confirmation row for another request, tenant or principal is refused by the composite FK; concurrent issuance for the
  same mission leaves both capabilities active; replacement revokes exactly the named predecessor; the token never
  appears in logs, traces, the database or Telegram payloads (planted logging call fails the test).
- **Structural**: every check in 16.6; the topology check in 16.7 with a planted canonical reference; the forbidden
  confirmation columns with a planted column.
- **Type fence**: no shadow response type is assignable to `Decision` or to any approval or admission input; fails when
  aligned.
- **Mod CI**: `claude plugin validate --strict` and `claude plugin test` pinned to a Claude Code release, plus the
  vendored-library digest check.

### 24.1 Revision 3.1 normative vectors (Edit, Write, NotebookEdit)

These vectors are part of the R5 vector file. `<wt>` is the worktree root, `<out>` a path outside it. Each oversize case
makes the whole input exceed 64 KiB through the named field.

| # | Tool and input | Expected |
|---|---|---|
| V31-E1 | `Edit {file_path: "<wt>/src/a.ts", old_string: "x", new_string: "y", replace_all: false}` | `WRITE_WORKTREE` / `EXACT` |
| V31-E2 | as E1 without `replace_all` | `WRITE_WORKTREE` / `EXACT` |
| V31-E3 | as E1 with `file_path: "<out>/a.ts"` | `WRITE_OUTSIDE_WORKTREE` / `EXACT` |
| V31-E4 | as E1 with `file_path: "<wt>/.env"` | `SECRET_WRITE` / `EXACT` |
| V31-E5 | as E1 plus undeclared key `extra: "z"` | `UNKNOWN_TOOL_ACTION` / `NONE` |
| V31-E6 | as E1 with `replace_all: "true"` (string) | `UNKNOWN_TOOL_ACTION` / `NONE` |
| V31-E7 | as E1 without `new_string` | `UNKNOWN_TOOL_ACTION` / `NONE` |
| V31-E8 | as E1 with `new_string` making the input exceed 64 KiB | `UNKNOWN_TOOL_ACTION` / `NONE`, `INPUT_TOO_LARGE` |
| V31-E9 | as E1 with `new_string` holding a `sk-or-v1-` fixture | `WRITE_WORKTREE` / `EXACT`, `SECRET_SHAPED`; fixture absent from request, state, ring and display |
| V31-W1 | `Write {file_path: "<wt>/b.md", content: "hello"}` | `WRITE_WORKTREE` / `EXACT` |
| V31-W2 | as W1 with `file_path: "<out>/b.md"` | `WRITE_OUTSIDE_WORKTREE` / `EXACT` |
| V31-W3 | as W1 with `file_path: "<wt>/secrets.json"` | `SECRET_WRITE` / `EXACT` |
| V31-W4 | as W1 plus undeclared key `mode: "0600"` | `UNKNOWN_TOOL_ACTION` / `NONE` |
| V31-W5 | as W1 with `content: 42` (number) | `UNKNOWN_TOOL_ACTION` / `NONE` |
| V31-W6 | as W1 with `content` making the input exceed 64 KiB | `UNKNOWN_TOOL_ACTION` / `NONE`, `INPUT_TOO_LARGE` |
| V31-W7 | as W1 with `content` holding a `ghp_` fixture | `WRITE_WORKTREE` / `EXACT`, `SECRET_SHAPED`; class from `file_path` only; raw content never transmitted |
| V31-W8 | as W1 with `content` holding a path string `"<out>/x"` | `WRITE_WORKTREE` / `EXACT` (a non-class key cannot alter the class) |
| V31-N1 | `NotebookEdit {notebook_path: "<wt>/n.ipynb", cell_id: "c1", new_source: "print(1)", cell_type: "code", edit_mode: "replace"}` | `WRITE_WORKTREE` / `EXACT` |
| V31-N2 | `NotebookEdit {notebook_path: "<wt>/n.ipynb", new_source: "x"}` | `WRITE_WORKTREE` / `EXACT` |
| V31-N3 | as N1 with `notebook_path: "<out>/n.ipynb"` | `WRITE_OUTSIDE_WORKTREE` / `EXACT` |
| V31-N4 | as N1 plus undeclared key `kernel: "py"` | `UNKNOWN_TOOL_ACTION` / `NONE` |
| V31-N5 | as N1 with `cell_type: "raw"` (not a declared value) | `UNKNOWN_TOOL_ACTION` / `NONE` |
| V31-N6 | as N1 with `edit_mode: true` (boolean) | `UNKNOWN_TOOL_ACTION` / `NONE` |
| V31-N7 | as N1 with `new_source` making the input exceed 64 KiB | `UNKNOWN_TOOL_ACTION` / `NONE`, `INPUT_TOO_LARGE` |
| V31-X1 | `Read {file_path: "<wt>/a.ts", content: "x"}` (an Edit/Write key on another tool) | `UNKNOWN_TOOL_ACTION` / `NONE` (non-interference) |

Mutations to kill: classify `Edit`/`Write`/`NotebookEdit` from a non-class key; accept an undeclared key on these
tools; accept a wrong type or undeclared literal; skip screening of non-class keys; send or retain a non-class key's
value; extend the 12.1.1 key set to any other tool.

### 24.2 ADR hardening tests and vectors

- **HARDENING_H2**: updating `issuance_digest`, `completion_proof_digest` or any other immutable column of
  `agent_session_issuance_request` is refused; an illegal `state` transition, a decrease of `failed_proof_count` and a
  second change of `minted_capability_id` are refused; each fails when the trigger or column grant is removed.
- **HARDENING_H3**: the writer refuses a directory inside a repository or worktree, a directory reached through a
  symbolic link or junction that resolves inside one, a target that is a link, a POSIX mode other than `0700` on the
  directory, and a Windows DACL with a second entry or inheritance; the token file is `0600` (POSIX) or carries the
  protected single-entry DACL (Windows); the write is atomic (a killed write leaves no partial token file); a writer
  failure revokes with `DELIVERY_LOST`; the reader refuses a directory whose real path is inside the worktree, a linked
  token file, a BOM, a malformed value, a truncated value and extra bytes, each as `CAPABILITY_UNKNOWN`. Each fails when
  its check is removed.
- **HARDENING_H4**: a vector-file lint rejects any vector with a non-UNKNOWN expectation that cites no structured entry
  or production; a planted vector for an unlisted production fails the lint.
- **HARDENING_H5** threshold vectors. `<p>` is the UTF-8 byte length of the `file_path` value `<wt>/s.txt`; `sp×n` is
  n ASCII space characters (U+0020), chosen so that the secret screen of section 13 step 4 sets no flag; each
  expected result therefore has no flag other than the one listed.

| # | Tool and input | Measured size | Expected |
|---|---|---|---|
| V-H5-1 | `Write {file_path: "<wt>/s.txt", content: sp×(65,536 - <p>)}` | 65,536 | `WRITE_WORKTREE` / `EXACT` |
| V-H5-2 | `Write {file_path: "<wt>/s.txt", content: sp×(65,537 - <p>)}` | 65,537 | `UNKNOWN_TOOL_ACTION` / `NONE`, `INPUT_TOO_LARGE` |
| V-H5-3 | `Write`, `content: sp×(65,535 - <p>)` + `"é"` (U+00E9: 2 UTF-8 bytes, 1 UTF-16 unit) | 65,537 (UTF-16 count would be 65,536) | `UNKNOWN_TOOL_ACTION` / `NONE`, `INPUT_TOO_LARGE` |
| V-H5-4 | `Write`, `content: sp×(65,532 - <p>)` + U+1F600 (4 UTF-8 bytes, 2 UTF-16 units) | 65,536 | `WRITE_WORKTREE` / `EXACT` |
| V-H5-5 | `Write`, `content: sp×(65,533 - <p>)` + `"€"` (U+20AC: 3 UTF-8 bytes) | 65,536 | `WRITE_WORKTREE` / `EXACT` |
| V-H5-6 | `Write`, `content: sp×(65,534 - <p>)` + `"€"` | 65,537 | `UNKNOWN_TOOL_ACTION` / `NONE`, `INPUT_TOO_LARGE` |
| V-H5-7 | `Write`, `content: sp×(65,533 - <p>)` + one unpaired surrogate U+D800 | 65,536 | `WRITE_WORKTREE` / `EXACT` |
| V-H5-8 | `Edit {file_path: "<wt>/s.txt", old_string: "x", new_string: sp×(65,531 - <p>), replace_all: true}` | 65,536 | `WRITE_WORKTREE` / `EXACT` |
| V-H5-9 | as V-H5-8 with `replace_all: false` | 65,537 | `UNKNOWN_TOOL_ACTION` / `NONE`, `INPUT_TOO_LARGE` |
| V-H5-10 | `Bash {command: "git status", description: sp×70,000}` | 10 (`description` is R0 non-consequential, not counted) | `READ_REPOSITORY` / `PATTERN` |

Mutations to kill: measure in UTF-16 code units (V-H5-3, V-H5-4 fail); use `>=` instead of `>` at the threshold
(V-H5-1 fails); count key names (V-H5-1 fails); count R0 non-consequential keys (V-H5-10 fails); measure after
redaction.

## 25. Residual risks

1. A malicious mod or process with the user's permissions can read the token file and fake the display. Impact is
   bounded by audience, TTL and revocation.
2. G1 results describe the preimage only (1.3, 12.7): aliases, functions, `PATH`/`PATHEXT`, git configuration and
   hooks, `~/.curlrc`, link files, symlinks and junctions.
3. Coverage of benign work is low by design: most commits, tests and installs are `WOULD_REQUIRE_REVIEW` until a sealed
   grammar revision widens G1.
4. Without a forge integration every HEAD relation is `UNVERIFIED` and rebinding rests on client assertions.
5. Single-owner deployment: requester and confirmer are the same person, as ADR-0019 records.
6. Plaintext token material lives in gateway and CLI memory until garbage collection; JavaScript cannot zero it.
7. The Mod API is early access; G1 is pinned to the 2.1.289 tool declarations and an engine update requires re-sealing
   the closed key sets.
8. Verdicts are retrospective; acceptable only because MOD-1 is shadow (SHADOW_ONLY, section 21).
9. Process death loses unsent telemetry; this is shown, never hidden.
10. (ADR, HARDENING_H3) Token location checks (6.6) are made at write time and at `session.start`; a change between
    check and use, an administrator who overrides a Windows DACL, or permissions changed after writing cannot be
    detected by the mod, which cannot read permissions through the pinned API. Impact is bounded as in item 1.

## 26. Implementation preconditions and open items

Not blockers on this design; required before implementation:

1. Independent hostile review of this exact document SHA.
2. A separately numbered ADR, sealed, defining `kj_shadow`, the two roles, the delta manifest, the door scopes or HUMAN
   issuance credential, the Telegram confirmation transport, and the allowed paths for 16.7.
3. B1 merged, with its least-privilege health check green where it runs, and no P8 change window open.
4. A mod CI job for validate and test, pinned to a Claude Code release.
5. The neutral `agent-actions` package with the normative vector file and the second implementation.
6. No production use until a separate change window.

Unresolved blockers in this design: none known.

ADR status of these preconditions (non-normative). Item 1 was met by the source design's APPROVE at
`55180c83997f7913ffafec0db4a70aaa2ed38cb8` (revision 3.1, on approved revision 3 `201dcb7`). Item 2 is met by this ADR
only in part: it fixes `kj_shadow`, its relations and the two roles as the source design did; the deferred items in the
section 16 note (door scopes or separate HUMAN issuance credential, delta manifest, Telegram confirmation transport
wiring, each shadow function's exact privileges, the topology check's final allowed paths) still require a sealed
amendment or successor before implementation. Items 3 to 6 are unchanged. This ADR is not itself sealed until an
independent hostile review approves its exact commit SHA.

## Appendix R31. Revision 3 to revision 3.1 delta record (non-normative)

### R31.1 Semantic delta

Exactly one: the closed key sets of `Edit`, `Write` and `NotebookEdit` (12.1 rows and 12.1.1). Class: NARROW SEMANTIC
DELTA, reason ADR24-B1 / `C1_SEMANTIC_DELTA`. Other semantic deltas: none.

Editorial changes that carry no semantics: the title and status lines, the opening paragraph naming revision 3.1, two
provenance rows and a note in 0.1, two rows in 0.4, section 2.4, the vectors in 24.1, and this appendix.

### R31.2 Non-interference: structured tools whose semantics are unchanged

Each row is revision 3's text, unchanged in revision 3.1. The 2.1.289 declaration was re-read for every tool. Every key
named in revision 3 exists in 2.1.289 with that name, so revision 3.1 reports no further delta.

| Tool | Revision 3 closed set and rule (unchanged) | 2.1.289 declared keys (verified) |
|---|---|---|
| `Read` | `file_path`; R0 non-consequential `offset`, `limit`, `pages` | `file_path`, `offset`, `limit`, `pages` |
| `Glob` | `pattern`, `path` | `pattern`, `path` |
| `Grep` | `pattern`, `path`, `glob`, and the option keys declared by the pinned schema | `pattern`, `path`, `glob`, `output_mode`, `-B`, `-A`, `-C`, `context`, `-n`, `-i`, `-o`, `type`, `head_limit`, `offset`, `multiline` |
| `WebFetch` | `url`, `prompt` | `url`, `prompt` |
| `WebSearch` | `query`, `allowed_domains`, `blocked_domains` | `query`, `allowed_domains`, `blocked_domains` |
| `Agent` | the type keys declared by the pinned schema | `description`, `prompt`, `subagent_type`, `model`, `run_in_background`, `name`, `team_name`, `mode`, `isolation` |
| `Bash` | `command`, `run_in_background`, `dangerouslyDisableSandbox`; R0 non-consequential `description`, `timeout` | `command`, `timeout`, `description`, `run_in_background`, `dangerouslyDisableSandbox` |
| `PowerShell` | as `Bash` | as `Bash` |

Revision 3's `Grep` and `Agent` rows name their key sets by reference to the pinned schema rather than by listing them.
Revision 3.1 leaves those rows exactly as approved and does not interpret them; the right-hand column records only
what the pinned schema declares.

### R31.3 Unchanged counts and scope

| Item | Revision 3 | Revision 3.1 |
|---|---|---|
| G1 structured entries (1.1) | 11 | 11 |
| G1 shell productions (1.2) | P1 to P35 | P1 to P35 |
| Action classes (10) | unchanged | no class added or removed |
| R0 to R5, path rule, URL rule, S1 to S5, UNKNOWN catalogue | as approved | unchanged |
| Authority, capability, issuance, confirmation, token, TTL, local token storage, policy, roles, repository truth, ordering, coverage, storage, idempotency, child agents, MOD-2 fence, P8/B1 separation | as approved | unchanged |

ADR-stage hardening H2, H3 and H4 from the ADR-0024 candidate are not part of revision 3.1.

## Appendix A. Source to ADR equivalence (non-normative)

Source: `docs/design/KJ_MOD1_SHADOW_ADMISSION_R3_1.md` at `55180c83997f7913ffafec0db4a70aaa2ed38cb8` (revision 3.1,
APPROVE). Not revision 3 and not the blocked candidate `bfe08fb`. This ADR was created by copying the source file byte for
byte and then making only the additions below. Every source section keeps its number, heading and normative text.

### A.1 Section map

| Source section | ADR destination | ADR-only addition and its class |
|---|---|---|
| Title, status, revision-3.1 paragraph, "complete design" paragraph | ADR title, Status, Date, Numbering, Provenance, Method, References, Normative status | replaced: `FRONT_MATTER`; the key-words sentence is kept verbatim |
| (none) | Decision | `FRONT_MATTER` (restates 0.2 and section 3) |
| (none) | Non-goals | `FRONT_MATTER` (restates 0.3, A1 and section 21) |
| 0 Provenance and scope (0.1 to 0.4) | 0 | none |
| 1 G1 positive set (1.1, 1.2 P1 to P35, 1.3 preimage) | 1 | none |
| 2 Blocker closure (2.1 to 2.4) | 2 | heading marked non-normative and a framing paragraph: `NON_NORMATIVE_HISTORY` |
| 3 Authority model, A1 to A3, record dimensions | 3 | none |
| 4 Session capability v3 | 4 | none |
| 5 Issuance, confirmation, C-CONF | 5 | none |
| 6 Token model and delivery (6.1 to 6.5) | 6 | 6.6 added: `HARDENING_H3` |
| 7 Concurrent sessions | 7 | none |
| 8 Shadow policy, ceiling, consumer fence | 8 | none |
| 9 Repository truth | 9 | none |
| 10 Action taxonomy and reserved classes | 10 | none |
| 11 R0 to R5 | 11 | R5 vector provenance paragraph: `HARDENING_H4` |
| 12.1 closed tool table, 12.1.1 Edit/Write/NotebookEdit (C-1) | 12.1, 12.1.1 | NotebookEdit `cell_type` note: `NON_NORMATIVE_HISTORY`; 12.1.2 Grep and Agent keys: `PINNED_SCHEMA_ENUMERATION` |
| 12.2 value types | 12.2 | 12.2.1 size unit: `HARDENING_H5` |
| 12.3 to 12.7 path rule, URL rule, S1 to S5, UNKNOWN catalogue, caveats | 12.3 to 12.7 | none |
| 13 Immutable pre-next observation | 13 | none |
| 14 Async delivery and wire contracts | 14 | none |
| 15 Coverage | 15 | none |
| 16 Shadow-only storage (16.1 to 16.7) | 16 | note on "the later ADR" and deferred preconditions: `FRONT_MATTER`; 16.1.1: `HARDENING_H2` |
| 17 Idempotency | 17 | none |
| 18 Secret and target handling | 18 | none |
| 19 Failure states | 19 | one row widened to name the 6.6 refusals, mapped to the existing `CAPABILITY_UNKNOWN`: `HARDENING_H3` |
| 20 Child agents | 20 | none |
| 21 MOD-2 fence | 21 | "no enable-enforcement switch" consequence paragraph: `FRONT_MATTER` |
| 22 P8 / B1 separation | 22 | explicit ADR statement of the same separation: `FRONT_MATTER` |
| 23 Attack tables | 23 | none |
| 24 Tests, 24.1 R3.1 vectors | 24, 24.1 | 24.2 added: `HARDENING_H2`, `HARDENING_H3`, `HARDENING_H4`, `HARDENING_H5` |
| 25 Residual risks | 25 | item 10: `HARDENING_H3` |
| 26 Preconditions | 26 | ADR status paragraph: `NON_NORMATIVE_HISTORY` |
| Appendix R31 | Appendix R31 | none |
| (none) | Appendix A, Appendix B | `FRONT_MATTER` |

### A.2 Result

- C-1 (Edit, Write and NotebookEdit closed key sets) is approved source-design semantics, carried unchanged in 12.1 and
  12.1.1. It is not an ADR delta.
- Unapproved semantic deltas: none.
- G1: 11 structured entries; productions P1 to P35 unchanged; no class or production added.
- Normative keywords: every MUST and MUST NOT in the source appears unchanged. The ADR adds MUST requirements only in
  6.6, R5 vector provenance, 12.2.1, 16.1.1 and the section 16 note. It adds no SHOULD or MAY requirement. Wording such
  as "optional" in the ADR either is the source's own or marks keys the 2.1.289 declaration declares optional (12.1.2);
  there is no added "best effort" or "implementation-dependent" requirement.

## Appendix B. Hardening and enumeration carried in this ADR

Each item makes an existing requirement of revision 3.1 exact. None adds authority, state, data flow, an action class, a
shell production, a failure state, or a token recovery or reveal path.

| Item | Where | What it makes exact |
|---|---|---|
| HARDENING_H2 | 16.1.1, 24.2 | the issuance-request columns; only the state-machine fields `state`, `failed_proof_count`, `minted_capability_id`, `state_changed_at` may change; `issuance_digest` and `completion_proof_digest` are immutable; security-invoker trigger with pinned `search_path`; the 16.4 grant ceiling |
| HARDENING_H3 | 6.6, 19, 24.2, 25 | `agentSessionDir` outside every repository and worktree after link and junction resolution; linked target refused; POSIX `0700` directory and `0600` file; Windows protected owner-only DACL; atomic temporary-file write, flush and rename; malformed, BOM, truncated and extra-byte refusal; writer failure follows `DELIVERY_LOST`; reader failure is `CAPABILITY_UNKNOWN`; the mod never writes the file |
| HARDENING_H4 | 11 (R5), 24.2 | the vector file is derived from the grammar, cannot create a production, and must cite the entry or production for any non-UNKNOWN vector |
| HARDENING_H5 | 12.2.1, 24.2 | 64 KiB is 65,536 UTF-8 bytes measured deterministically over consequential values; threshold vectors at 65,536, 65,537 and across multibyte boundaries |
| PINNED_SCHEMA_ENUMERATION | 12.1.2 | the 2.1.289 key names for the `Grep` and `Agent` rows, which the source defines by reference to the pinned declaration |
