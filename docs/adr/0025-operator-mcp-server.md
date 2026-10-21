# ADR-0025: an operator MCP server lets ChatGPT drive KernelJSON through the door, never around it

Status: PROPOSED

Date: 2026-10-21

Extends ADR-0014 (mission control control port), ADR-0017 (production authority and execution binding) and ADR-0019
(Telegram approvals interface). It changes none of them. ADR numbers 0023 and 0024 are taken on unmerged branches, so
this is 0025.

## Context

Jonny wants to direct KernelJSON from ChatGPT in plain chat, without Codex, including asking it to make changes to his
projects. ChatGPT reaches tools only through a remote MCP server it can call over the public internet (a developer-mode
connector). The first request was "full access": database, releases, schedules, everything.

Two facts shape the answer:

1. **The door already exposes the whole operator surface.** `apps/gateway/src/server.ts` admits work
   (`POST /v1/tasks`), reads a task and its history, evidence and outcome, cancels, signals and approves, and serves the
   memory and world views. Telegram (ADR-0019) and Mission Control use exactly this surface. Every admission is bound to
   a release (ADR-0017), rate-limited by `admit()`, idempotent per key and attributed to a source on a fixed allow-list.
2. **The risk is the chat model, not a stranger.** ChatGPT reads web pages, files and repository content, and any of
   them can carry instructions. A chat model holding unrestricted tools does whatever the last thing it read says. "Only
   Jonny uses it" limits who should use it; it does not limit what reaches the model's context.

## Decision

Build `apps/mcp`: a remote MCP server that is a **thin, stateless adapter onto the door**, in the same way the
Telegram channel is. It adds no authority path.

1. It holds one credential: a door bearer for Jonny's principal, like the Telegram operator's. It has no database
   credential, no Restate admin access, no runtime secrets and no shell.
2. Every action is a door call. Every admission carries `x-kj-channel: chatgpt-mcp/v1`, a new entry on the door's
   `CHANNEL_SOURCES` allow-list, so the ledger records `kerneljson:channel/chatgpt-mcp/v1` as its source.
3. It writes nothing of its own except a request log (tool name, task id, outcome code, correlation id; never arguments
   that could hold content, never tokens).
4. **Removability:** deleting the server removes a way of asking, nothing else. Every task, approval and schedule keeps
   working through the door, Telegram and the CLI.

### Tools (phase 1)

Read (MCP annotation `readOnlyHint: true`):

| Tool | Door route | Notes |
|---|---|---|
| `kj_list_tasks` | `GET /v1/tasks` (new, see below) | Recent tasks for the tenant: id, recipe, status, created, updated |
| `kj_get_task` | `GET /v1/tasks/:id` | Status, outcome, dispatch, effect disposition |
| `kj_task_evidence` | `GET /v1/tasks/:id/evidence` | Evidence rows; model text included, marked as untrusted content |
| `kj_task_history` | `GET /v1/tasks/:id/history` | Ledger events |
| `kj_memory` | `GET /v1/memory` | Existing memory view |
| `kj_world` | `GET /v1/world` | Existing world view |
| `kj_health` | `GET /v1/health` (new, see below) | Ledger-side health: release parity, epoch, mismatches, schedules, outbox |

Act:

| Tool | Door route | Notes |
|---|---|---|
| `kj_run_brief` | `POST /v1/tasks` `morning-brief/v1` | Same as a manual brief |
| `kj_run_analysis` | `POST /v1/tasks` `repo-analysis-mission/v1` | Same as Telegram `/review` and `/brief <repo>` |
| `kj_cancel_task` | `POST /v1/tasks/:id/cancel` | `destructiveHint: true`; cancelling is the safe direction |

Deliberately absent: `approve` and `signal` (an approval is Jonny's, on Telegram, per ADR-0019; a hijacked chat must
not be able to approve its own request), `identity-change/v1`, the test and canary recipes, and anything that is not a
door route (database writes, `activate_release`, schedule enable, disable or arm, Restate admin, env files).

**Idempotency.** Each act tool takes a `request_id` argument (8 to 128 characters, the door's `Key` shape). The server
passes it as `Idempotency-Key`, so a retried tool call converges on the same task, and a changed request under the
same id is refused with 409 by the door, as today.

### Two small door additions

The door has no list or health route. Both are read-only, tenant-scoped and served from the ledger, so the MCP server
never needs a database credential:

- `GET /v1/tasks?limit=` lists recent tasks through `MissionControlStore.list`, which already exists.
- `GET /v1/health` returns the ledger-side subset of `services/kernel/src/health`: release parity, epoch, binding
  mismatches, schedule state and next fire, nonterminal count and outbox status. Restate-side checks (registration,
  pending wakes) stay in the operator CLI; the door has no Restate admin access and does not gain any.

Both are added with their negative tests (wrong tenant, no bearer, unknown task) in the same change.

### Authentication and transport

- Streamable HTTP MCP at `https://kj-mcp.jonnyai.co.uk/mcp`, published through the existing Caddy on
  `kerneljson-prod-01` (ports 80 and 443 are already open through `allow-n8n-web`; the external IP is now reserved as
  `kerneljson-prod-01-ip`). DNS is an A record in Vercel.
- OAuth 2.1 as the MCP authorisation spec describes, so ChatGPT can register and sign in. The server is its own
  authorisation server with exactly one permitted identity: sign-in is delegated to Google, and only Jonny's account
  (configured by its Google subject id, not by email text) is issued a token. Tokens are short-lived and audience-bound
  to this server. There is no static bearer that would work if copied.
- The door bearer the server holds never leaves the VM and never appears in an MCP response. The OAuth access token is
  never forwarded to the door or to Restate (Restate journals headers; ADR-0019's KJ-P4B.1 lesson).

### Content from tools is data

Evidence and briefs contain model output and repository text. The server returns them inside a field labelled as
untrusted content and never as instructions. This does not make ChatGPT immune, which is why the tool set above is the
safety boundary: at worst a hijacked chat can start a read-only analysis or cancel a task.

## Later phases (not decided here)

- **Phase 2, Mission #2 (`request_change`).** A recipe in which KernelJSON makes a change on a branch, runs the tests,
  has an independent model review it and opens a pull request with evidence. Its own ADR. It needs a sandboxed coding
  runtime; the `e2-standard-2` VM is probably too small to build alongside the estate, so it needs a sizing decision.
  When it exists, the MCP server gains one act tool that admits it.
- **Phase 3, merge and deploy.** Approved through the existing approval machinery and answered on Telegram, never by
  the MCP server.

## Consequences

- ChatGPT can do through chat what Jonny can do on Telegram today, minus approvals, plus reading the ledger.
- No new authority path, no new database credential, no second control plane. The constitution's removability test
  holds.
- New public surface: one HTTPS route behind single-identity OAuth. Deploying it is a production change and needs its
  own window, after the morning brief's two clean mornings.
- The "full access" request is answered by scope through KernelJSON rather than by credentials: changes to projects
  arrive as reviewed pull requests (phase 2), not as direct writes.

## Decisions taken (21/10/2026)

1. Hostname: `kj-mcp.jonnyai.co.uk`.
2. Permitted identity: `jonnyallum@gmail.com`, the human account Jonny signs into ChatGPT with, protected by 2-step
   verification and matched by its Google subject id. `kerneljson@gmail.com` owns the GCP project and stays a separate,
   infrastructure-only identity, so compromising one does not hand over the other.
3. `kj_cancel_task` is in phase 1.
4. Phase 2 sizing is decided with Mission #2's own ADR, against a measured build workload.
