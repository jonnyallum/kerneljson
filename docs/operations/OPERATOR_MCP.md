# Operator MCP server: setup, deploy and ChatGPT connection

ADR-0025. The server lets ChatGPT, in ordinary chat, read KernelJSON and start a morning brief, a read-only repository analysis or a cancellation, through the admission door and nothing else. It holds one door bearer and no database, Restate or shell access. Approvals stay on Telegram.

Status: built and tested; **not deployed**. Deploying it is a production change and needs its own approved window. The daily brief, the canary and Phase 8.1 are not touched by any step here except the door release in step 5, which follows `RELEASE_PROVENANCE.md`.

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

**Kill switches.** To cut access immediately, do either of these and recreate the container:
- Rotate `MCP_TOKEN_SIGNING_KEY`. Every token and every client registration becomes invalid.
- Change `MCP_ALLOWED_GOOGLE_SUB`. Every token stops working.

Stopping the container (`docker stop kerneljson-mcp`) also removes the whole surface without touching anything else.

## One-time setup (owner)

1. **Google OAuth client**, in the `kerneljson` GCP project (`project-c407f628-c71c-45fa-994`), signed in as `kerneljson@gmail.com`.
   1. Google Auth Platform, Branding: app name `KernelJSON operator`, support email `kerneljson@gmail.com`.
   2. Audience: External, publishing status **Testing**, test user `jonnyallum@gmail.com` only. Testing mode is enough: the server keeps no Google token.
   3. Data access: scope `openid` only.
   4. Clients, Create client: Web application, name `kj-mcp`. Authorised redirect URI: `https://kj-mcp.jonnyai.co.uk/oauth/google/callback`. No JavaScript origins.
   5. Record the client id (public).
   6. Save the client secret straight into jVault as `kerneljson/MCP_GOOGLE_CLIENT_SECRET`. It never goes through chat.
2. **Signing key.** Generate 48 random bytes into jVault as `kerneljson/MCP_TOKEN_SIGNING_KEY`, file to file, using `secretctl` (`--expect-len 64` for 48 bytes in base64url).
3. **DNS.** `vercel dns add jonnyai.co.uk kj-mcp A 34.105.219.103` (the reserved static address `kerneljson-prod-01-ip`). Verify with `nslookup kj-mcp.jonnyai.co.uk`.
4. **Your Google subject id.** It is a number, not your email address. Until it is known, deploy with any placeholder digits (for example `0`). Signing in once with `jonnyallum@gmail.com` then shows the "Not permitted" page, which prints your own id. Put that into `MCP_ALLOWED_GOOGLE_SUB` and recreate the container.

## Deploy window (separate approval)

Prerequisites: PR #60 is merged, and CI is green on the merge commit.

5. **Door release.**
   - Release the merge commit as a normal worker-and-door release, with the same steps and scripts as the 21/10 `07eac9f` release, including `activate_release`.
   - The door gains `GET /v1/tasks`, `GET /v1/health` and the `chatgpt-mcp/v1` channel. The worker changes only by release id.
6. **Networks.**
   - `docker network create kj-mcp-edge`.
   - Add `kj-mcp-edge` (external) to the `caddy` service in `/opt/n8n/compose.yaml`.
   - Recreate only `caddy`. Check that n8n stays up and that `n8n.jonnyai.co.uk` still returns 200.
7. **Runtime env.**
   - Build `/opt/kerneljson/runtime/mcp/runtime.env` (root, mode 600) with these values:

     | Key | Value | Source |
     |---|---|---|
     | `MCP_PUBLIC_URL` | `https://kj-mcp.jonnyai.co.uk` | public |
     | `MCP_ALLOWED_GOOGLE_SUB` | your Google subject id (step 4) | public |
     | `GOOGLE_CLIENT_ID` | the client id from step 1 | public |
     | `MCP_REGISTRATION` | `open` | public |
     | `KERNELJSON_RELEASE_ID` | the release | public |
     | `GOOGLE_CLIENT_SECRET` | `kerneljson/MCP_GOOGLE_CLIENT_SECRET` | jVault |
     | `MCP_TOKEN_SIGNING_KEY` | `kerneljson/MCP_TOKEN_SIGNING_KEY` | jVault |
     | `KJ_ADMISSION_BEARER` | the door bearer (the same value as the worker's) | jVault |

   - Secrets travel only vault to file, file to process, then shred.
   - Read the file back only with an allow-list of public keys.
8. **Start.**
   - Run `KJ_MCP_IMAGE=kerneljson-admission-door:<short-sha> docker compose --env-file /opt/kerneljson/runtime/mcp/runtime.env -f infrastructure/docker/mcp.compose.yaml up -d`.
   - Append `infrastructure/caddy/kj-mcp.Caddyfile` to `/opt/n8n/Caddyfile`.
   - Validate with `caddy validate`, then reload (`docker exec n8n-caddy-1 caddy reload --config /etc/caddy/Caddyfile`).
9. **Verify**, before connecting ChatGPT:
   - `curl -s https://kj-mcp.jonnyai.co.uk/.well-known/oauth-protected-resource/mcp` names the `/mcp` resource.
   - `curl -s -o /dev/null -w '%{http_code}' -X POST https://kj-mcp.jonnyai.co.uk/mcp` returns `401` with a `www-authenticate` header.
   - `curl -s -o /dev/null -w '%{http_code}' https://kj-mcp.jonnyai.co.uk/anything` returns `404` from Caddy.
   - `docker inspect kerneljson-mcp` shows it healthy with no published ports.
   - The door, worker, Restate and n8n are unchanged apart from the step 5 release: same IDs and StartedAt, epoch parity holds, and tomorrow's brief and canary wakes are still armed.

   After ChatGPT is connected (next section), set `MCP_REGISTRATION=closed` and recreate the container. ChatGPT stays connected.

**Rollback.**
- `docker compose -f infrastructure/docker/mcp.compose.yaml down`.
- Remove the Caddy block and reload Caddy.
- Optionally delete the DNS record.
- The door release rolls back separately under `RELEASE_PROVENANCE.md`.

## Connecting ChatGPT

The labels below are ChatGPT's at the time of writing; they move occasionally.

1. ChatGPT on the web, signed in as yourself.
2. Settings, Apps & Connectors, Advanced settings: turn on **Developer mode**.
3. Back on the Apps & Connectors page, choose **Create** (add a custom connector):
   - Name: `KernelJSON`.
   - Description: `Jonny's task kernel: read tasks and health, run a morning brief or a repository analysis, cancel a task.`
   - MCP server URL: `https://kj-mcp.jonnyai.co.uk/mcp`.
   - Authentication: **OAuth**. Leave client id and secret empty; ChatGPT registers itself.
   - Tick that you trust the application, then Create.
4. ChatGPT opens the sign-in:
   1. Google account chooser: pick `jonnyallum@gmail.com`.
   2. KernelJSON's "Allow access to KernelJSON?" page: check it names ChatGPT and `https://chatgpt.com`, then choose **Allow**.
   3. You land back in ChatGPT, connected. The tools listed should be the ten `kj_*` tools.
5. In a chat, use the composer's **+** menu, then Developer mode, and enable KernelJSON for that chat. Then ask, for example, "Check KernelJSON's health", "What tasks ran today?" or "Run a morning brief".
   - ChatGPT asks you to confirm each call to `kj_run_brief`, `kj_run_analysis` and `kj_cancel_task`, because they are not read-only.
   - It passes a fresh `request_id` for each new run.
6. Close registration (step 9 note).

**If the connection fails:** `docker logs kerneljson-mcp` shows OAuth events (never tokens).

| Log line | Meaning | Fix |
|---|---|---|
| `registration_refused` | ChatGPT used a different callback address than expected | Add the logged address to `MCP_ALLOWED_REDIRECT_URIS` and recreate the container |
| `signin_refused` | The account is not the permitted one | Check `MCP_ALLOWED_GOOGLE_SUB` |

## Security review (focused, 21/10/2026)

One pass over the externally reachable surface. Each control is backed by a test in `tests/operator-mcp-oauth.test.ts` or `tests/operator-mcp.test.ts`. Five of the critical checks were deliberately broken and the suite failed each time: the access-token subject, the Google subject, PKCE, refresh reuse and the local-mode proxy guard.

| Threat | Control |
|---|---|
| Someone else signs in | The Google subject must equal `MCP_ALLOWED_GOOGLE_SUB`, compared in constant time, before any consent or code exists. It is re-checked on every token use |
| Code sent to an attacker | Redirect URIs are exact-match against ChatGPT's callback at registration and again at authorise. An unknown client or redirect gets an error page, never a redirect |
| Code interception or injection | PKCE S256 is mandatory. Codes are single-use, last 5 minutes, and are bound to client, redirect and challenge. The `iss` parameter is returned (mix-up defence) |
| Confused deputy or lookalike client | An explicit consent page shows the client name and destination. It is CSRF-protected (single-use ticket, Origin check) and cannot be framed (`frame-ancestors 'none'`, `X-Frame-Options`). Registration can be closed after the first connection |
| Token forgery or type confusion | HMAC-SHA256 with the purpose in the MAC, so an access token cannot pass as a refresh token or client id. Issuer, audience, expiry and scope are all checked |
| Stolen refresh token | Rotation on every use. A replay revokes the whole family, including the newest access token |
| Long-lived compromise | Tokens die on signing key rotation or subject change. Access tokens last 1 hour |
| Local mode exposed by the proxy | Local mode binds loopback only and refuses any forwarded header or non-loopback Host (421). The production compose file can only run `MCP_AUTH=oauth`. OAuth mode answers only to its own host name |
| Google ID token forgery | It is taken only from Google's token endpoint over TLS, in the exchange that redeemed our own code (OIDC Core 3.1.3.7). Issuer, audience, expiry and nonce are checked |
| Prompt injection through tool output | Tool results are wrapped as untrusted data. The tool set itself is the bound: no approve, signal or identity tools. ChatGPT confirms every non-read-only call |
| Leaks | No token, code, secret or door bearer is logged or returned. Door failures return a classification only. The bearer is never forwarded |
| Oversized or malformed input | 8 KB OAuth forms, 64 KB MCP bodies, 128 KB at Caddy. Repeated OAuth parameters are refused. Only exact paths are proxied |

Residual risks, accepted for phase 1:
- **In-memory state is lost on restart.** Pending sign-ins, codes and the refresh-reuse record live in memory, so a restart lets a refresh token used just before it be used once more. The consequence is bounded by rotation and the 30-day expiry.
- **No rate limit at Caddy.** A flood of authorise requests can fill the 1,000 pending sign-in slots for 10 minutes, delaying your own sign-in. It cannot gain access.
- **The door bearer is shared with the worker.** Rotating it means updating both env files.
