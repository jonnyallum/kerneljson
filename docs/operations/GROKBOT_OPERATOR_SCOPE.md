# Grok Bot operator-scope upgrade — 4 November 2026

Jonny authorised Keith/Grok Bot to have full access to the authorised KernelJSON estate. This change gives its existing `grokbot` OAuth profile the same MCP tool set as ChatGPT. The door still decides which task recipes and actions are allowed. The room and its credentials are a separate deployment.

## Current change

- Grok Bot's consent page states that it can read, start a brief or repository analysis, request a bounded code change that ends in a draft PR, and cancel eligible tasks. It cannot approve a task through MCP.
- The MCP service issues `kerneljson.operator` to the Grok Bot profile. A token issued earlier with `kerneljson.read` fails verification and cannot be refreshed after this release. Keith must disconnect and reconnect the KernelJSON custom connector, then complete Jonny's Google sign-in and the new consent screen. The MCP registration can stay closed: an existing signed client id remains valid; if Grok Bot discards it, open a short `grokbot` registration window using the current runtime procedure and close it afterward.
- An admission from Grok Bot carries `grokbot-mcp/v1`, recorded as `kerneljson:channel/grokbot-mcp/v1`. Its idempotency keys begin `grokbot-mcp:`. ChatGPT retains `chatgpt-mcp/v1` and its previous `mcp:` key format, so retries of existing ChatGPT requests remain stable.
- OAuth still requires the allowed Google subject, an allowed redirect URI, consent and the existing expiry. The two clients are distinguished by profile in the MCP audit log. The MCP process continues to hold its existing door credential, so the ledger principal is shared; the channel source distinguishes admissions. A separate Grok ledger principal would require an additional door credential and identity registration.

## Release check

1. Qualify the exact merge commit. Deploy the worker, admission door and MCP at one release id using the established zero-active-task switch. The gateway must be updated before Grok Bot's new admission route is exercised; it is the component that accepts `grokbot-mcp/v1`.
2. Confirm KernelJSON health: door release equals active release, binding mismatches and nonterminal tasks are zero, schedules remain enabled, and worker/door/MCP are healthy.
3. In Grok Bot, reconnect the KernelJSON custom connector and approve the **operator** consent. Confirm `kj_run_brief`, `kj_run_analysis`, `kj_run_code_change` and `kj_cancel_task` appear, alongside the read tools. A previous read-scope token should get 401 until reauthorised.
4. Submit at most one harmless, bounded task from Keith for proof. Confirm its admission source is `kerneljson:channel/grokbot-mcp/v1` and the MCP log records `profile=grokbot`. Do not infer this from a visible tool list alone.

Rollback: restore the previous release and reconnect Grok Bot under its read-scope profile. Do not restore old runtime env files over a later authorised change; preserve the exact pre-switch files and compare first.
