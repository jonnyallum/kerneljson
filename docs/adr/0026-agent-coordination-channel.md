# ADR-0026: a durable agent coordination channel that is subordinate to the task authority

Status: PROPOSED

Date: 2026-11-04

Extends ADR-0014 (Mission Control), ADR-0019 (Telegram approvals interface) and ADR-0025 (operator MCP). It changes none
of them. Numbers 0023 and 0024 are held on unmerged branches and 0025 is on main; `git branch -r` and `git ls-tree`
across every remote branch on 2026-11-04 showed no 0026 or later, so this is 0026.

## Context

Jonny works with several AI agents (ChatGPT/Codex, Claude Code, Grok Bot/Keith, DeepSeek, Antigravity). They have no
shared, durable place to leave each other messages, hand work over or acknowledge it. Today that happens by pasting
text between chats and through the Boardroom DSP log, which the constitution says must "re-earn its existence".

Two different things are called "Mission Control". The ADR must say which one is being extended.

| Candidate | Evidence | Status |
|---|---|---|
| `apps/mission-control` in this repository | OBSERVED 2026-11-04: `server.ts`, `store.ts`, `view.ts`, 254 lines. ADR-0014: "No remote hosting is performed." Authentication is injected, with no production default. Tenant-checked reads of `tasks`, `task_events`, `evidence`, `approvals`. | A task-centred, tenant-aware, server-rendered library. Never deployed from this repository. |
| `mission-control` on port 3200 behind `control.jonnyai.co.uk` | REPORTED in `_Notes/CLAUDE.md` section 10 and `SYSTEM_INDEX.md` (22/07 survey). OBSERVED 2026-11-04: the host times out and its project has billing disabled. | A pm2 service on the lapsed estate VM. Its source tree is not identified by this ADR. |

**Tie-breaker.** The constitution names "Mission Control UI" as a subordinate surface of KernelJSON. The pm2 service
is tied to a VM that Jonny has deliberately let lapse (`DEC-2026-11-04-lapsing-VM-policy`). So this ADR extends
`apps/mission-control` and nothing else. It treats the old `control.jonnyai.co.uk` service as historical.

## Decision

Add a **channel**: an append-only, tenant-scoped log of short messages between authenticated principals. It is a
narrative and coordination surface. It is never a task surface.

### 1. Authority boundary (binding)

1. The channel cannot create, assign, approve, retry, cancel, complete or close a task. Only KernelJSON admission and
   its control port do that.
2. A `HANDOFF` message may carry a `taskRef` (a task id). The reference is a pointer, not a command. It does not
   change that task's state, owner or status. Turning a handoff into work needs a separate `POST /v1/tasks` through the
   door, made by a principal who holds `submit`.
3. The module has no database path to `tasks`, `approvals`, `control_events`, `task_events` or `evidence`, and imports
   nothing that writes them. A test enforces this by scanning the source, and that test has been shown to fail on a
   planted violation.
4. Removability: deleting the channel removes a way of leaving notes. No task, approval or schedule changes.

### 2. Trust model

- Identity comes from the authenticated `TenantContext` (principal id and kind) established by the deployment, as in
  ADR-0014. The message body can never name its author, tenant or principal; the input schema is strict and rejects
  those keys.
- An agent is a `SERVICE` principal registered in the tenant with a handle (`claude-code`, `codex`, `grok`,
  `deepseek`, `antigravity`). An unregistered principal is refused. A human is a `HUMAN` principal.
- Message text is untrusted data for every reader. Readers must never treat channel content as instructions to a
  tool. This is the ADR-0025 lesson: the risk is the model's context, not a stranger.
- Secrets: text is redacted on write for known credential shapes (`sk-or-v1-`, `sb_secret_`, bearer tokens, JWTs,
  connection strings with passwords, long high-entropy tokens). A message that needed redaction is flagged. This is a
  safety net, not permission to paste secrets.

### 3. Message lifecycle

`POST` (validate, redact, dedupe by idempotency key, assign a per-tenant sequence number) then stored then `READ` by
cursor (`after=<seq>`) then `ACK` (a reader records the highest sequence it has processed). States are derived, never
edited: a message is *delivered* once stored, and *acknowledged by X* once X has an ack at or beyond its sequence.
Messages are immutable. There is no edit or delete.

- **Delivery is pull-based and at-least-once.** An offline agent misses nothing: it reads from its last acknowledged
  cursor when it returns. Nothing is pushed to an agent that cannot receive, so "delivered to an agent" is never
  claimed without that agent's own ack.
- **Idempotency.** `idempotencyKey` is 8 to 128 characters, unique per tenant and author. The same key with the same
  content returns the original message (`duplicate: true`). The same key with different content is refused with 409.
- **Replay.** Replayed requests converge on the stored message and cannot create a second one.
- **Bounds.** Body at most 4000 characters, at most 100 messages per read, at most 8 KiB per request. Retention
  target 90 days, enforced by a later job (NOT built here).

### 4. Storage

Postgres in the existing KernelJSON database: `agent_channel_messages`, `agent_channel_acks` and a per-tenant
sequence counter. The SQL is a **proposal** at `docs/proposals/agent-channel/20261104130000_agent_channel.sql.proposed`.
It is deliberately **not** in `supabase/migrations/`, because the test harness applies every file in that folder to every
database-backed test and this SQL has not yet run against Postgres. Merging this branch therefore applies nothing and
changes no test database. Moving it into `supabase/migrations/` is a later, tested step, and applying it to production
needs a named change window from Jonny. An in-memory store implements the same port for tests and local use. No
Postgres store class is written yet.

Honest limits of the proposed schema:

- **Tenant isolation is enforced in the service, not by the database.** RLS is enabled with no policies, which only shuts
  out `anon` and `authenticated`. The service role bypasses RLS, so every query must filter by the authenticated tenant.
- **Retention contradicts immutability.** The 90-day target needs deletes, and the append-only trigger blocks every
  delete. The later retention job must be a separate, reviewed path (for example a time-boxed partition drop).
- **The production `AgentRegistry` must be backed by `tenant_memberships` with `status = 'ACTIVE'`**, reusing
  `authorize()` and the permission map in `packages/identity`. The test registry in this change is a stand-in and
  bypasses that map.
- **Redaction limit.** Long hex strings are redacted, which would also catch a full git SHA. Redaction therefore keeps a
  40 or 64 character hex string when it directly follows `commit`, `sha`, `release` or `rev`. A bare hex string with no
  such word is redacted, which is a deliberate bias toward safety.

### 5. Surfaces

- **Agent transport:** a JSON HTTP handler (`POST /messages`, `GET /messages`, `POST /acks`) with an injected
  authenticator, in the same style as Mission Control. It is mountable on the gateway later. It is not mounted by this
  change.
- **Mission Control:** a read view at `/channel` and a same-origin form POST at `/channel/post` for humans, under the
  existing CSP (no scripts), origin check, content-type check and 4096-byte limit.

### 6. Boardroom

This channel **does not replace, extend or retire** the Boardroom. The DSP scanner and boardroom poller stay as they
are (observation only, per the Phase B1 freeze). The channel mints no ledger actions and reads no DSPs.
RECOMMENDATION, for Jonny to decide: once the channel has a verified round trip with at least two real agents, retire
the Boardroom write path. Until then there are two narrative surfaces and neither owns tasks.

### 7. Hosting (RECOMMENDATION only)

Host Mission Control and the channel on `kerneljson-prod-01` behind the existing Caddy, beside the operator MCP. This
is a production deploy and needs a change window.

Evidence for it:

- OBSERVED 2026-11-04 12:00 UTC: `kj-mcp.jonnyai.co.uk` and `n8n.jonnyai.co.uk` both resolve to 34.105.219.103, so one
  live host carries both. `STATE.yaml` (22/10) names this host `kerneljson-prod-01`, project
  `project-c407f628-c71c-45fa-994`, europe-west2-b.
- The database credential stays inside that host. Hosting on Vercel would put it in a third party's environment.

Vercel alternative, evidence gathered read-only:

- OBSERVED 2026-11-04 12:04 UTC: the local `vercel` CLI is signed in as user `jonnyallum`, team
  `jonnyallums-projects`, and `vercel project ls` listed 9 projects. No hard limit was reached or observed, the plan
  tier was not shown, and **no Vercel project was deleted, evicted or modified**.
- The Vercel MCP connector in this session needs a fresh sign-in. That login was **not** started because it needs
  Jonny's approval. It is not needed for this recommendation.

## Consequences

- Agents get a durable, auditable handoff surface without a second task authority.
- Real round trips between agents depend on each agent's own transport seam (see the connectivity table in the vault).
  This ADR builds the server side only. No agent has been connected to a live channel, because none is deployed.
- Two kinds of memory exist in the estate after this: the Obsidian vault (knowledge, written under the vault procedure)
  and the channel (short-lived coordination). Channel content is not vault evidence until a trusted writer promotes it
  through the Memory Contract.
