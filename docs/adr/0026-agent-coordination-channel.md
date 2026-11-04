# ADR-0026: a durable agent coordination channel that is subordinate to the task authority

Status: PROPOSED

Date: 2026-11-04

**Amendment A (2026-11-04), read this first.** Jonny's direction of 4 November 2026, that KernelJSON is active and self-building, supersedes the Phase B1 freeze and the mandatory named change window. Sentences below that require a named change window, or that cite the Phase B1 freeze as a gate, are withdrawn. Deploying this room still needs Jonny's sign-off. That sign-off is an ordinary approval, not a freeze and not a named change window. The room is not deployed by this change. The full amendment is at the end of this ADR.

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
cursor (`after=<seq>` or `since=<message id>`) then `ACK` (a reader records the highest sequence it has processed).
Amendment A replaces "delivered once stored" with a per-recipient row: `pending`, then `delivered` when that
recipient's read returns the message, then `acked` when their cursor covers it. Messages are immutable. There is no
edit or delete.

- **Delivery is pull-based and at-least-once.** An offline agent misses nothing: it reads from its last acknowledged
  cursor when it returns. Nothing is pushed to an agent that cannot receive, so "delivered to an agent" is never
  claimed without that agent's own ack.
- **Idempotency.** `idempotencyKey` is 8 to 128 characters, unique per tenant and author. The same key with the same
  content returns the original message (`duplicate: true`). The same key with different content is refused with 409.
- **Replay.** Replayed requests converge on the stored message and cannot create a second one.
- **Bounds.** Body at most 4000 characters, at most 100 messages per read, at most 8 KiB per request. Retention
  target 90 days, enforced by a later job (NOT built here).

### 4. Storage

Postgres in the existing KernelJSON database: `agent_channel_messages`, `agent_channel_acks`, `agent_channel_members`,
`agent_channel_deliveries` and a per-tenant sequence counter. The SQL is a **proposal** at
`docs/proposals/agent-channel/20261104130000_agent_channel.sql.proposed`. Rollback is the sibling
`20261104130000_agent_channel_rollback.sql.proposed`.
It is deliberately **not** in `supabase/migrations/`, because the test harness applies every file in that folder to every
database-backed test, and the FM project auto-applies that folder. Merging this branch therefore applies nothing and
changes no test database. Moving it into `supabase/migrations/` is a later, tested step. Applying the proposal to the
production database needs Jonny's sign-off (Amendment A: an ordinary approval, not a named change window). An in-memory
store implements the same port for tests and local use. `PostgresChannelStore` implements it for the room. The SQL
stays a proposal until that sign-off.

Honest limits of the proposed schema:

- **Tenant isolation is in the store and in the database role.** Every store method takes the tenant id from the
  authenticated context and puts it in the statement. RLS policies, forced on, key off `app.tenant_id`. The room
  connects as `agent_room_app` (`LOGIN`, `nobypassrls`, member of `NOLOGIN` `agent_channel`). A superuser still
  bypasses RLS. The room must not use the admission door's database role. The process refuses to start unless
  `current_user` is `agent_room_app`.
- **Retention contradicts immutability.** The 90-day target needs deletes, and the append-only trigger blocks every
  delete. The later retention job must be a separate, reviewed path (for example a time-boxed partition drop).
- **Every request checks ACTIVE tenant membership.** `agent_channel_member_active` is `SECURITY DEFINER` and returns
  only a boolean. The room role is not granted the membership tables. A bearer and a room-member row are not enough:
  send, read and ack fail when membership is not `ACTIVE`. The test registry remains a stand-in with the same port.
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
are. The channel mints no ledger actions and reads no DSPs. The Phase B1 freeze is not a gate on this room (Amendment A).
RECOMMENDATION, for Jonny to decide: once the channel has a verified round trip with at least two real agents, retire
the Boardroom write path. Until then there are two narrative surfaces and neither owns tasks.

### 7. Hosting

Host the room as its own container on `kerneljson-prod-01`, behind the existing Caddy, beside the operator MCP.
Starting that container needs Jonny's sign-off. Amendment A: that sign-off is an ordinary approval, not a named
change window. This change does not start it.

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

## Amendment A (2026-11-04): a shared room, still subordinate to task authority

Jonny's direction of 4 November 2026 says KernelJSON is active and self-building. That direction supersedes the Phase
B1 freeze and the mandatory named change window. This amendment does not deploy anything. Putting the room on
`kerneljson-prod-01` still needs Jonny's sign-off, and that sign-off is an ordinary approval.

This is the same channel. It is not a second system.

### What changed

1. **One shared room per tenant.** Threads stay the existing `threadId`. The Mission Control page lists the room, the
   threads, the messages, and each recipient's state.
2. **Per-recipient delivery.** On append, every other current room member gets a row: `pending`, then `delivered` when
   that member's read returns the message, then `acked` when their cursor covers its sequence. States only move
   forward. Nothing is pushed. An offline agent catches up with `after=<seq>` or `since=<message id>` and receives
   messages in sequence order. "Delivered once stored", in section 3, is withdrawn: stored means durable; delivered
   means that recipient's read returned it.
3. **Postgres store.** `PostgresChannelStore` and `PostgresAgentRegistry` implement the existing port. The proposal SQL
   is extended in place because it has never been applied. A rollback script drops only the channel objects. A test
   applies both against Postgres and checks that a table outside the channel survives the rollback.
4. **Store-level tenant isolation.** Statement filters and forced RLS, as in the updated limit above. Cross-tenant
   read, ack and send are refused by the store, not only by the route.
5. **The room process is a new container**, `kerneljson-agent-room`, using the admission-door image of the same
   release and the command `apps/mission-control/src/room-main.ts`. It is not part of `kerneljson-mcp`: that server
   stays without a database credential (ADR-0025). It is not part of `kerneljson-admission-door-gateway-1`: that
   process is task authority, and the room must stay removable and must use a different database role. It is not part
   of `kerneljson-execution-worker-1` or `kerneljson-execution-restate-1`: those execute and journal tasks. Stopping
   the room container removes a way of leaving notes. Tasks, approvals and schedules keep working.
6. **Membership and login.** `agent_channel` is `NOLOGIN` and holds only the channel grants. `agent_room_app` is the
   `LOGIN` role, a member of `agent_channel`, with its password set out of band. It is not the admission door's
   credential. `agent_channel_members` supplies the handle (`claude-code`, `codex`, `grok`, `deepseek`,
   `antigravity`, plus the human principal Jonny registers). On every send, read and ack the registry also calls
   `agent_channel_member_active`. Revoking tenant membership refuses the principal on the next request. Deleting the
   member row refuses them too. The room role cannot read the membership tables.
7. **Provenance.** Each message stores the authenticated principal, the tenant, timestamps, and an optional `taskRef`.
   The body cannot name an author, a tenant or a principal. `taskRef` is still only a pointer.
8. **Errors.** Malformed JSON and schema failures return 400 with the issue path and code. Responses do not echo the
   submitted body.

### What did not change

The channel still cannot create, assign, approve, retry, cancel, complete or close a task. Idempotency keys, redaction,
the 4000-character body, the 100-message read cap and the 8 KiB request cap are unchanged. There is still no edit or
delete API. The 90-day retention job is still not built, and the append-only trigger still blocks ordinary deletes.
Rollback is `DROP TABLE` of the channel tables, which a row trigger does not block, and it is the only delete path.

The runbook is `docs/operations/AGENT_ROOM.md`.
