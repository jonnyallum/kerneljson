import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { HttpOperatorDoor } from "./door.js";
import { HttpGoogleSignIn, type GoogleSignIn } from "./oauth/google.js";
import { CHATGPT_REDIRECT_URIS, CLIENT_PROFILES, PROFILE_NAMES, type ClientProfileName } from "./oauth/profiles.js";
import { createOAuthServer } from "./oauth/server.js";
import type { RateLimits } from "./oauth/rate-limit.js";
import { TokenSigner } from "./oauth/tokens.js";
import { createMcpServer, requestGuard } from "./server.js";

/**
 * ADR-0025 operator MCP server.
 *
 *   MCP_AUTH=oauth                   production: OAuth 2.1, one Google subject, behind Caddy on MCP_PUBLIC_URL
 *   MCP_AUTH=local-unauthenticated   development only: loopback bind, and every proxied or non-loopback
 *                                    request is refused (server.ts requestGuard)
 *
 * Common:  KJ_ADMISSION_URL, KJ_MCP_BEARER (the MCP principal's own door bearer, never the worker's;
 *          from an env file, never argv),
 *          MCP_HOST, MCP_PORT (default 8090), KERNELJSON_RELEASE_ID
 * OAuth:   MCP_PUBLIC_URL (https origin), MCP_ALLOWED_GOOGLE_SUB, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
 *          MCP_TOKEN_SIGNING_KEY (>= 32 bytes), MCP_ALLOWED_REDIRECT_URIS (comma list; default ChatGPT's
 *          connector callback), MCP_ALLOWED_ORIGINS (comma list; default ChatGPT's origins),
 *          MCP_REGISTRATION (open | closed | open-until=<UTC time, at most 24 hours ahead>; close it once
 *          the client is connected), MCP_REGISTRATION_PROFILES (optional comma list of client profiles that
 *          may register while it is open, e.g. grokbot; default every profile)
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
export { CHATGPT_REDIRECT_URIS };
export const CHATGPT_ORIGINS = ["https://chatgpt.com", "https://chat.openai.com"];

const list = (value: string | undefined, fallback: readonly string[]): string[] =>
  value ? value.split(",").map((v) => v.trim()).filter(Boolean) : [...fallback];

export const MAX_ENROLMENT_MS = 24 * 3600_000;

/** `open-until=` bounds an enrolment: it closes by itself, and a window longer than a day refuses to start. */
function registration(value: string | undefined, nowMs: number): { open: boolean; until?: number } {
  if (value === "open") return { open: true };
  if (value === "closed") return { open: false };
  const m = /^open-until=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z)$/.exec(value ?? "");
  const until = m ? Date.parse(m[1]!) : NaN;
  if (!Number.isFinite(until)) throw new Error("MCP_REGISTRATION must be open, closed or open-until=<UTC time>");
  if (until - nowMs > MAX_ENROLMENT_MS) throw new Error("MCP_REGISTRATION open-until must be at most 24 hours ahead");
  return { open: true, until };
}

function registrationProfiles(value: string | undefined): ClientProfileName[] | undefined {
  if (!value) return undefined;
  const names = value.split(",").map((v) => v.trim()).filter(Boolean);
  if (names.length === 0 || names.some((n) => !(PROFILE_NAMES as string[]).includes(n)))
    throw new Error(`MCP_REGISTRATION_PROFILES must list profiles from: ${PROFILE_NAMES.join(", ")}`);
  return names as ClientProfileName[];
}

export type McpConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv, nowMs: number = Date.now()) {
  const host = env["MCP_HOST"] || "127.0.0.1";
  const port = Number(env["MCP_PORT"] || 8090);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MCP_PORT must be a port number");
  const doorUrl = env["KJ_ADMISSION_URL"];
  const bearer = env["KJ_MCP_BEARER"];
  if (!doorUrl || !bearer) throw new Error("KJ_ADMISSION_URL and KJ_MCP_BEARER are required");
  const common = { host, port, doorUrl, bearer, release: env["KERNELJSON_RELEASE_ID"] || "unreleased-development" };
  const mode = env["MCP_AUTH"];
  if (mode === "local-unauthenticated") {
    if (!LOOPBACK.has(host)) throw new Error("Local unauthenticated mode binds only to a loopback address");
    return { ...common, auth: { kind: "local" as const } };
  }
  if (mode !== "oauth") throw new Error("MCP_AUTH must be oauth or local-unauthenticated");
  const publicUrl = env["MCP_PUBLIC_URL"] ?? "";
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new Error("MCP_PUBLIC_URL must be a URL");
  }
  if (parsed.protocol !== "https:" && !LOOPBACK.has(parsed.hostname)) throw new Error("MCP_PUBLIC_URL must be https");
  const required = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`${name} is required in oauth mode`);
    return v;
  };
  return {
    ...common,
    auth: {
      kind: "oauth" as const,
      publicUrl: parsed.origin,
      publicHost: parsed.host,
      allowedGoogleSub: required("MCP_ALLOWED_GOOGLE_SUB"),
      googleClientId: required("GOOGLE_CLIENT_ID"),
      googleClientSecret: required("GOOGLE_CLIENT_SECRET"),
      signingKey: required("MCP_TOKEN_SIGNING_KEY"),
      allowedRedirectUris: list(env["MCP_ALLOWED_REDIRECT_URIS"], CHATGPT_REDIRECT_URIS),
      allowedOrigins: list(env["MCP_ALLOWED_ORIGINS"], CHATGPT_ORIGINS),
      registration: registration(env["MCP_REGISTRATION"], nowMs),
      registrationProfiles: registrationProfiles(env["MCP_REGISTRATION_PROFILES"]),
    },
  };
}

/** `google`, `now` and `rateLimits` exist for tests; production passes none of them. */
export function buildHandler(
  config: McpConfig,
  deps: { fetchImpl?: typeof fetch; now?: () => number; log?: (line: string) => void; google?: GoogleSignIn; rateLimits?: RateLimits } = {},
) {
  const door = new HttpOperatorDoor(config.doorUrl, config.bearer, deps.fetchImpl);
  const log = (entry: object) => deps.log?.(JSON.stringify({ at: new Date().toISOString(), ...entry }));
  if (config.auth.kind === "local") {
    const local = { profile: "local", readOnly: false, client: "local" };
    return createMcpServer({ door, release: config.release, verify: async () => local, guard: requestGuard({ kind: "local" }), allowedOrigins: [], log });
  }
  const a = config.auth;
  const oauth = createOAuthServer({
    publicUrl: a.publicUrl,
    allowedGoogleSub: a.allowedGoogleSub,
    allowedRedirectUris: a.allowedRedirectUris,
    registrationOpen: a.registration.open,
    ...(a.registration.until !== undefined ? { registrationUntil: a.registration.until } : {}),
    ...(a.registrationProfiles ? { registrationProfiles: a.registrationProfiles } : {}),
    signer: new TokenSigner(a.signingKey),
    google: deps.google ?? new HttpGoogleSignIn({ clientId: a.googleClientId, clientSecret: a.googleClientSecret, redirectUri: `${a.publicUrl}/oauth/google/callback` }, deps.fetchImpl, deps.now),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.rateLimits ? { rateLimits: deps.rateLimits } : {}),
    log,
  });
  return createMcpServer({
    door,
    release: config.release,
    verify: async (authorization) => {
      const access = oauth.verifyAccess(authorization);
      return access ? { profile: access.profile.name, readOnly: CLIENT_PROFILES[access.profile.name].readOnly, client: access.clientName } : null;
    },
    guard: requestGuard({ kind: "oauth", publicHost: a.publicHost }),
    allowedOrigins: a.allowedOrigins,
    resourceMetadataUrl: oauth.resourceMetadataUrl,
    routes: oauth.handle,
    log,
  });
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const handler = buildHandler(config, { log: (line) => process.stderr.write(line + "\n") });
  const server = createServer((req, res) => void handler(req, res));
  server.listen(config.port, config.host, () =>
    process.stderr.write(`kerneljson-operator MCP (${config.auth.kind}) listening on ${config.host}:${config.port}\n`),
  );
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`kerneljson-operator MCP failed to start: ${err instanceof Error ? err.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
