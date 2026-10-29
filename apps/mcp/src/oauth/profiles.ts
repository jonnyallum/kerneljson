/**
 * Which kind of client an OAuth registration is, decided ONLY by its redirect URIs. Those are signed into the
 * self-contained client id at registration, so a client's profile can never change afterwards, and an existing
 * ChatGPT client id (issued before profiles existed) resolves to the chatgpt profile without being re-issued.
 *
 *   chatgpt   operator scope: every tool in tools.ts. Unchanged from ADR-0025 phase 1.
 *   grokbot   read scope: the read tools only. Grok Bot's MCP client is Cursor's public client, identified by
 *             its client id metadata document https://cursor.com/oauth/mcp-client.json (read 23/10/2026),
 *             whose redirect_uris are exactly the five below. Anyone holding a Cursor-family client therefore
 *             lands here, and still needs Jonny's own Google sign-in and an explicit consent.
 *
 * A registration whose redirect URIs span two profiles, or match none, is refused. The deployment's
 * MCP_ALLOWED_REDIRECT_URIS still gates every URI on top of this, so adding a profile here enables nothing.
 */
export const OPERATOR_SCOPE = "kerneljson.operator";
export const READ_SCOPE = "kerneljson.read";

export const CHATGPT_REDIRECT_URIS = ["https://chatgpt.com/connector_platform_oauth_redirect"] as const;
export const GROKBOT_REDIRECT_URIS = [
  "https://www.cursor.com/bot/mcp/oauth/callback",
  "https://www.cursor.com/agents/mcp/oauth/callback",
  "https://grok.com/connectors-oauth-exchange-code/",
  "http://localhost:8787/callback",
  "http://127.0.0.1:8787/callback",
] as const;

export type ClientProfileName = "chatgpt" | "grokbot";

export interface ClientProfile {
  name: ClientProfileName;
  /** Shown on the consent page and in the audit log. */
  label: string;
  scope: typeof OPERATOR_SCOPE | typeof READ_SCOPE;
  readOnly: boolean;
  redirectUris: readonly string[];
  /** What the consent page says the client will be able to do. */
  grants: string;
}

export const CLIENT_PROFILES: Readonly<Record<ClientProfileName, ClientProfile>> = {
  chatgpt: {
    name: "chatgpt",
    label: "ChatGPT",
    scope: OPERATOR_SCOPE,
    readOnly: false,
    redirectUris: CHATGPT_REDIRECT_URIS,
    grants: "read your tasks, evidence, memory and health, start a morning brief or a read-only repository analysis, and cancel tasks. It cannot approve anything.",
  },
  grokbot: {
    name: "grokbot",
    label: "Grok Bot (Cursor MCP client)",
    scope: READ_SCOPE,
    readOnly: true,
    redirectUris: GROKBOT_REDIRECT_URIS,
    grants: "read your tasks, evidence, history, memory and health. It cannot start, cancel or approve anything.",
  },
};

export const PROFILE_NAMES = Object.keys(CLIENT_PROFILES) as ClientProfileName[];

export function profileFor(redirectUris: readonly string[]): ClientProfile | null {
  if (redirectUris.length === 0) return null;
  const matches = PROFILE_NAMES.filter((name) => redirectUris.every((u) => CLIENT_PROFILES[name].redirectUris.includes(u)));
  return matches.length === 1 ? CLIENT_PROFILES[matches[0]!] : null;
}
