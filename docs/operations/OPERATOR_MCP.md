# Operator MCP server: setup, deploy and ChatGPT connection

ADR-0025. The server lets ChatGPT, in ordinary chat, read KernelJSON and start a morning brief, a read-only repository analysis or a cancellation, through the admission door and nothing else. It holds its own door credential and no database, Restate or shell access. Approvals stay on Telegram.

Status: built and tested; **not deployed**. Deploying it is a production change and needs its own approved window. The deploy steps are in [OPERATOR_MCP_DEPLOY_CHECKLIST.md](OPERATOR_MCP_DEPLOY_CHECKLIST.md). The daily brief, the canary and Phase 8.1 are not touched by any step except the door and worker release, which follows `RELEASE_PROVENANCE.md`.

## What it serves

| Path | Purpose |
|---|---|
| `POST /mcp` | MCP over Streamable HTTP, JSON responses only, stateless. Bearer token required |
| `/.well-known/oauth-protected-resource[/mcp]` | RFC 9728: names this server as the resource and its own authorisation server |
| `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | RFC 8414 metadata |
| `POST /oauth/register` | RFC 7591 registration; redirect URIs limited to ChatGPT's connector callback; can be closed |
| `GET /oauth/authorize` | Authorisation code + PKCE S256 only; sends the browser to Google |
| `GET /oauth/google/callback` | Google returns here; the Google subject must equal `MCP_ALLOWED_GOOGLE_SUB` |
| `POST /oauth/consent` | Explicit Allow or Deny page before any code is issued |
| `POST /oauth/token` | `authorization_code` and `refresh_token` (rotated; a replay ends the family) |
| `GET /healthz` | Container liveness only |

Tokens: access 1 hour, refresh 30 days, both audience-bound to `https://kj-mcp.jonnyai.co.uk/mcp` and HMAC-signed with `MCP_TOKEN_SIGNING_KEY`. The permitted subject is re-checked on every request.

**Rate limits** on every `/oauth/*` request (discovery is not limited). Over a limit the answer is `429` with `Retry-After`, and the log line `rate_limited` names the route and rule, never the address.

| Rule | Limit |
|---|---|
| One client address, all `/oauth/*` | 30 a minute |
| One client address, `/oauth/register` | 10 an hour |
| Everyone together, all `/oauth/*` | 300 a minute |

The client address is the last `X-Forwarded-For` entry, which Caddy writes.

## Identity at the door

The MCP server does **not** use the worker's door bearer. It has its own:

| | Worker, scheduler, Telegram | Operator MCP |
|---|---|---|
| Door bearer | `KJ_ADMISSION_BEARER` | `KJ_MCP_BEARER` (jVault `kerneljson/KJ_MCP_BEARER`, 64 characters) |
| Principal | the existing HUMAN owner | a new SERVICE principal, `KJ_MCP_PRINCIPAL_ID` |
| Membership | `owner` | `operator` |
| May start | every admissible recipe | `morning-brief/v1`, `repo-analysis-mission/v1` only |
| May control | approve, signal, cancel | cancel only, and only tasks it started |
| May read | everything in the tenant | tasks, evidence, history, memory, world, health |

Three layers hold it there:
1. The door's scope check refuses any other recipe or control with `403 OUT_OF_SCOPE`, before any admission row exists.
2. Membership: a SERVICE principal can never approve or schedule, whatever its role.
3. Cancellation in the kernel requires the cancelling principal to be the one that started the task.

Health needs the `health` permission (owner or operator, either kind), which confers no power to change anything.

The door accepts the MCP credential only when `KJ_MCP_BEARER`, `KJ_MCP_PRINCIPAL_ID` and `KJ_MCP_PRINCIPAL_KIND=SERVICE` are all set. It refuses to start if they are partly set, if the bearer equals the worker's, or if the principal is the worker's.

## Kill switches

Fastest first. Each one is independent; none touches the brief, canary or Phase 8.1.

1. `docker stop kerneljson-mcp`. The whole public surface goes.
2. Revoke the MCP membership: `mcp-principal.js revoke` (checklist R2). The door then refuses every MCP request with 403 while the container still runs.
3. Rotate `MCP_TOKEN_SIGNING_KEY` and recreate the container. Every token and client registration becomes invalid.
4. Change `MCP_ALLOWED_GOOGLE_SUB` and recreate the container. Every token stops working.
5. Rotate `KJ_MCP_BEARER` in jVault, the door env and the MCP env, then recreate both. The worker is unaffected.

## One-time setup (owner, before the window)

1. **Google OAuth client**, in the `kerneljson` GCP project (`project-c407f628-c71c-45fa-994`), signed in as `kerneljson@gmail.com`.
   1. Google Auth Platform, Branding: app name `KernelJSON operator`, support email `kerneljson@gmail.com`.
   2. Audience: External, publishing status **Testing**, test user `jonnyallum@gmail.com` only. Testing mode is enough: the server keeps no Google token.
   3. Data access: scope `openid` only.
   4. Clients, Create client: Web application, name `kj-mcp`. Authorised redirect URI: `https://kj-mcp.jonnyai.co.uk/oauth/google/callback`. No JavaScript origins.
   5. Record the client id (public).
   6. Save the client secret straight into jVault as `kerneljson/MCP_GOOGLE_CLIENT_SECRET`. It never goes through chat.
2. **Two generated secrets**, each 48 random bytes in base64url (64 characters), into jVault without the value ever being printed:

   ```
   python -c "import os,secrets;fd=os.open('mcpkey.tmp',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.write(fd,secrets.token_urlsafe(48).encode());os.close(fd)"
   python C:\Users\jonny\Desktop\new-system\AgentHub\scripts\secretctl.py put kerneljson/MCP_TOKEN_SIGNING_KEY --in mcpkey.tmp --expect-len 64
   python C:\Users\jonny\Desktop\new-system\AgentHub\scripts\secretctl.py shred mcpkey.tmp
   ```

   Repeat for `kerneljson/KJ_MCP_BEARER`.
3. **DNS.** `vercel dns add jonnyai.co.uk kj-mcp A 34.105.219.103`, which is the reserved static address `kerneljson-prod-01-ip`. Verify with `nslookup kj-mcp.jonnyai.co.uk`.
4. **Your Google subject id.** It is a number, not your email address.
   - Until it is known, deploy with the placeholder `0`.
   - Signing in once with `jonnyallum@gmail.com` then shows the "Not permitted" page, which prints your own id.
   - Put that into `MCP_ALLOWED_GOOGLE_SUB` and recreate the container (checklist step 9).

## Which ChatGPT plans can use it

Checked 21/10/2026. OpenAI's help page returned 403 to an automated fetch, so this rests on search summaries of that page, a dated September 2026 guide and a June-July 2026 community thread. **Treat it as a guide and let the connection test decide.**

| Plan | Custom MCP server | Write tools (`kj_run_brief`, `kj_run_analysis`, `kj_cancel_task`) |
|---|---|---|
| Business | Yes. An admin or owner must first allow Developer mode for the workspace. Then each person turns it on for themselves | Supported, in beta. ChatGPT asks for confirmation before each write call |
| Enterprise, Edu | Yes, with role-based access. Admins choose which actions a published app may use, and new actions start **disabled** | As Business, once the admin enables the actions |
| Plus, Pro | **Unclear.** Developer mode launched on Plus and Pro in September 2025. A September 2026 guide says custom servers have since moved to workspace plans only | Unclear. Some sources say write actions are available to everyone, others that they are not |
| Free | No | No |

**Admin path (Business).** Workspace settings, then Permissions & roles, then Connected data: allow "Developer mode / Create custom MCP connectors".

**Personal path.** Settings, then Apps (or Apps & Connectors), then Advanced settings: turn on Developer mode.

**Using it in ordinary conversations.** A connector you create is a draft visible only to you, marked "Dev". Enable it for a chat from the composer's **+** menu; it then works in that conversation like any other app. On a workspace plan an admin can publish it to the workspace instead. On Business a published app cannot be edited in place: any change to tool descriptions means recreating and republishing it. A draft is enough for one person.

**Known failure: "This tool call was blocked by OpenAI's safety checks".** In June and July 2026 builders on Business and Plus reported this, mostly on write tools, sometimes on read tools. OpenAI has not confirmed a cause.
- Workarounds reported: tool descriptions that state plainly what a tool changes and that it is not destructive; a new chat after a block.
- Ours already describe exactly what each tool does, and `kj_run_brief` and `kj_run_analysis` are marked non-destructive.
- If it happens, record which tool, then retry in a new chat. A block happens inside ChatGPT, so nothing reaches the server and nothing appears in its log.

**What to check on your own plan before the window.** Open ChatGPT Settings, then Apps.
- If there is no Developer mode toggle, or no **Create** button after turning it on, the plan does not allow custom servers. Stop there: the deploy would serve nobody.
- If both are there, the connection test (checklist step 10) settles write access.

Sources:
- https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta
- https://peliqan.io/blog/chatgpt-mcp/ (21/09/2026)
- https://community.openai.com/t/write-actions-blocked-on-custom-mcp-server-business-plan-workspace-developer-mode-unavailable-at-workspace-level/1384381

## Connecting ChatGPT

The labels below are ChatGPT's at the time of writing; they move occasionally.

1. ChatGPT on the web, signed in as yourself, with Developer mode on (see above).
2. Settings, Apps, then **Create** (add a custom app or connector):
   - Name: `KernelJSON`.
   - Description: `Jonny's task kernel: read tasks and health, run a morning brief or a repository analysis, cancel a task started from ChatGPT.`
   - MCP server URL: `https://kj-mcp.jonnyai.co.uk/mcp`.
   - Authentication: **OAuth**. Leave client id and secret empty; ChatGPT registers itself.
   - Tick that you trust the application, then Create.
3. ChatGPT opens the sign-in:
   1. Google account chooser: pick `jonnyallum@gmail.com`.
   2. KernelJSON's "Allow access to KernelJSON?" page: check it names ChatGPT and `https://chatgpt.com`, then choose **Allow**.
   3. You land back in ChatGPT, connected. The ten `kj_*` tools should be listed.
4. In a new chat, use the composer's **+** menu and enable KernelJSON for that chat. Then ask in plain words, for example "Check KernelJSON's health", "What tasks ran today?" or "Run a morning brief".
   - ChatGPT asks you to confirm each call to `kj_run_brief`, `kj_run_analysis` and `kj_cancel_task`, because they are not read-only.
   - It passes a fresh `request_id` for each new run.
5. Close registration (checklist step 11).

**If the connection fails:** `docker logs kerneljson-mcp` shows OAuth events, never tokens.

| Log line | Meaning | Fix |
|---|---|---|
| `registration_refused` | ChatGPT used a different callback address than expected | Add the logged address to `MCP_ALLOWED_REDIRECT_URIS` and recreate the container |
| `signin_refused` | The account is not the permitted one | Check `MCP_ALLOWED_GOOGLE_SUB` |
| `rate_limited` | Too many OAuth requests from one address or in total | Wait for `Retry-After`; if it was you, it resets within a minute |
| no log line at all, tool "blocked" in ChatGPT | ChatGPT's own safety check | See "Known failure" above |

## Security review (focused, 21/10/2026)

One pass over the externally reachable surface. Each control is backed by a test in `tests/operator-mcp-oauth.test.ts`, `tests/operator-mcp.test.ts`, `tests/gateway-bootstrap.test.ts` or `tests/operator-mcp.integration.test.ts`. Critical checks were deliberately broken and the suite failed each time:
- the access-token subject, the Google subject, PKCE, refresh reuse and the local-mode proxy guard;
- the door scope, an extra control in the scope, bearer reuse, a HUMAN MCP kind;
- the rate limiter as a whole, the first rather than last forwarded address, the global rule and the registration rule.

| Threat | Control |
|---|---|
| Someone else signs in | The Google subject must equal `MCP_ALLOWED_GOOGLE_SUB`, compared in constant time, before any consent or code exists. It is re-checked on every token use |
| Code sent to an attacker | Redirect URIs are exact-match against ChatGPT's callback at registration and again at authorise. An unknown client or redirect gets an error page, never a redirect |
| Code interception or injection | PKCE S256 is mandatory. Codes are single-use, last 5 minutes, and are bound to client, redirect and challenge. The `iss` parameter is returned (mix-up defence) |
| Confused deputy or lookalike client | An explicit consent page shows the client name and destination. It is CSRF-protected (single-use ticket, Origin check) and cannot be framed (`frame-ancestors 'none'`, `X-Frame-Options`). Registration can be closed after the first connection |
| Token forgery or type confusion | HMAC-SHA256 with the purpose in the MAC, so an access token cannot pass as a refresh token or client id. Issuer, audience, expiry and scope are all checked |
| Stolen refresh token | Rotation on every use. A replay revokes the whole family, including the newest access token |
| Long-lived compromise | Tokens die on signing key rotation or subject change. Access tokens last 1 hour |
| Flooding the OAuth endpoints | Per-address, per-address registration and global limits (above). The 1,000 pending sign-in slots cannot be filled faster than the global limit |
| A compromised MCP server | It holds only `KJ_MCP_BEARER`: a SERVICE principal limited at the door to two read-only recipes and cancelling its own tasks. It cannot approve, signal, schedule, change identity or act as the worker. Revoking its membership cuts it off without touching the worker |
| Local mode exposed by the proxy | Local mode binds loopback only and refuses any forwarded header or non-loopback Host (421). The production compose file can only run `MCP_AUTH=oauth`. OAuth mode answers only to its own host name |
| Google ID token forgery | It is taken only from Google's token endpoint over TLS, in the exchange that redeemed our own code (OIDC Core 3.1.3.7). Issuer, audience, expiry and nonce are checked |
| Prompt injection through tool output | Tool results are wrapped as untrusted data. The tool set and the door scope are the bound: no approve, signal or identity tools. ChatGPT confirms every non-read-only call |
| Leaks | No token, code, secret or door bearer is logged or returned. Door failures return a classification only. The bearer is never forwarded. Rate-limit log lines carry no address |
| Oversized or malformed input | 8 KB OAuth forms, 64 KB MCP bodies, 128 KB at Caddy. Repeated OAuth parameters are refused. Only exact paths are proxied |

Residual risks, accepted for phase 1:
- **In-memory state is lost on restart.** Pending sign-ins, codes, the refresh-reuse record and the rate-limit counters live in memory. A restart lets a refresh token used just before it be used once more. The consequence is bounded by rotation and the 30-day expiry.
- **A distributed flood can lock you out briefly.** The global limit protects the server, not your own sign-in: many addresses together can use up the 300 a minute. It cannot gain access. An already-connected ChatGPT keeps working until its hourly access token needs refreshing, because `/mcp` itself is not rate limited.
- **Reads are tenant-wide.** The MCP principal sees every task in the tenant, including the worker's, as Jonny would. That is the purpose of the tool.
