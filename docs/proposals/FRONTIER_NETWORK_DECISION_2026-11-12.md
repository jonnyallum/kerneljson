# Frontier Network: agents first, KernelJSON optional
**Decision date:** 12 November 2026  
**Status:** Founder-approved direction; implementation pending test and separately authorised deployment  
**Scope:** The Unfinished Frontier (independent mission), its connected AI agents, Obsidian, and KernelJSON  
**Canonical destination:** Future independent Frontier repository / Obsidian mission charter. This copy is staged in the existing KernelJSON repository solely because the independent repository has not yet been established.

## Decision
**The Unfinished Frontier is not a KernelJSON subproject.** It is an independent, long-term human-progress and science initiative, pursuing useful enterprises and research. KernelJSON is a replaceable worker for scheduled, durable, evidenced jobs, not a compulsory gateway for thought, messages, research, or draft code.

Agents should talk, investigate public sources, critique ideas, use the shared room and produce candidate Obsidian notes without KernelJSON task admission. Use simple direct integrations first. Stop adding gateways, identities and approval layers to KernelJSON unless a specific, tested task cannot work without them.

## Three operating levels
1. **Explore**: communicate, read public research, develop hypotheses, critique, draft in authorised workspaces without per-message task admission.
2. **Build within existing authority**: work in branches, run tests, create candidate research notes, propose changes and record evidence. Protect canonical Obsidian notes with source reconciliation; do not confuse candidate assertions with validated results. No per-message approval.
3. **Consequential effects**: require explicit appropriate human authorisation for spending, production deployment, external publication or commitments, credentials/permissions, sensitive data or equivalent high-impact actions. Safety and evidence validation are execution quality, not a governance-first mission.

## Communication architecture
- **Room:** existing shared agent room for human/agent collaboration; its current hosting inside KernelJSON is an implementation detail, not a dependency to impose on agents. If practical, extract/mirror to a small standalone transport while preserving history, identity attribution, message ordering and per-agent acknowledgements.
- **Wake-ups:** asynchronous event notification on @mentions plus periodic fallback sweeps. Message delivery != agent response. Capture event id, recipient, attempted delivery, callback outcome and agent response timestamp. Use idempotency, authenticated signatures, retries with bounded backoff, dead-letter handling, abuse protection and failure visibility. No secrets in chat, logs, notes or PR.
- **Knowledge:** Obsidian-compatible Markdown; agents submit candidates, a reconciler/qualified reviewer promotes verified claims to canonical notes, recording sources and task/evidence pointers. No resurrection of retired Boardroom.
- **Task execution:** agents may accept and own direct work through native supported interfaces; KernelJSON remains available for jobs benefitting from durable scheduling, replay, reconciliation and audits. KJ should not be a prerequisite to a normal conversation.
- **Portability:** plain-text source documents, versioned protocols and exportable task logs. The mission must survive replacement of KernelJSON, Grok or Claude.

## Important correction reported by Keith, 12 November 2026
Keith reports a weekday room sweep at approximately **09:00 and 15:00 UK time**, introduced since 08:00 today. He also reports that Grok Bot can be woken promptly by a webhook when @grok is tagged. These are **Keith-reported**, not independently tested from a webhook, and supersede the blanket statement that Grok cannot be woken automatically.
Keith proposes configuring his webhook receiver, then asking Claude to make a **small room notification change on a branch**, followed by founder sign-off **before it goes live**. This document and room handoff do **not** constitute that live deployment approval.

## First acceptance test: one cross-agent loop
1. Keith finds a real public-good or commercial opportunity and posts a sourced room event.
2. A room notification delivers the event to Claude from its real connected session, without manual forwarding.
3. Claude investigates and writes a provenance-bearing **candidate** Obsidian note; no unreviewed canonical write.
4. DeepSeek independently challenges at least one claim with traceable model execution, or is correctly reported as unavailable.
5. The team records accepted, contested and unsupported statements, exact timestamps, model identity, source provenance, duplicate prevention and any failure.
6. One bounded next-step proposal is surfaced to the founder. No unauthorised deployment, publishing or spending.

**Pass:** full transcript + evidence and one reproducible validated result. **Fail:** missing wake-up, model answer, source or actual write, without papering over failure.

## Current ground truth and gaps
- KernelJSON epoch 19 healthy on 12 November, existing morning brief completes. Its presence does not imply an autonomous discovery team.
- Claude and Keith each confirmed room access and replied on 12 November. Both previously reported lacking wake-ups from posts; Keith's newly reported weekday sweep/webhook capability requires independent proof.
- Claude's operator-MCP work merged in KJ PR #78 but remains undeployed. Frontier communication must not wait for this.
- Obsidian mission workspace was reported started by Claude; sync from KJ host to vault not demonstrated.
- DeepSeek and Codex have historical room presence but their participation in the new test is not yet confirmed.
- Earlier KJ read-only repository analysis failed deterministic citation-path reconciliation; that failure remains evidence of an unresolved source-integrity issue, not a reason to stop free research.

## What we will NOT do
No teardown of working KernelJSON; no new auth machinery as a substitute for successful collaboration; no secret-bearing webhook address committed; no changes to live room notification service, infrastructure, business accounts, credentials, spending, public scientific claims or existing work without specific authorisation.

## 7-day review
Evaluate one fully observed event-driven loop, real latency, false wakes, delivery and review failures, note provenance, operating cost and actual human usefulness. Keep the existing operational work running. Choose architecture based on measured ability to deliver, not a preferred platform.

## References
- The Unfinished Frontier founding mission: GitHub issues #79 and #80
- Prior KJ-centric discovery proposal (superseded where it assumes KJ is mandatory): GitHub issue #81
- Shared agent founding thread: `6a51dddc-e5cf-460d-8af8-543b16470a8f`
- Claude operator MCP: PR #78 (merged, not yet deployed)
