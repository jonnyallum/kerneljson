import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { GoogleSignIn } from "./google.js";
import { DEFAULT_RATE_LIMITS, RateLimiter, clientAddress, type RateLimits } from "./rate-limit.js";
import {
  AccessClaims,
  ClientClaims,
  RefreshClaims,
  TokenSigner,
  pkceChallenge,
  randomToken,
  safeEqual,
  type AccessClaims as Access,
  type ClientClaims as Client,
} from "./tokens.js";

/**
 * ADR-0025: the operator MCP server's own OAuth 2.1 authorisation server, for exactly one human.
 *
 *   discovery     RFC 9728 protected-resource metadata, RFC 8414 authorisation-server metadata
 *   registration  RFC 7591 dynamic client registration, redirect URIs limited to an exact allow-list
 *   authorise     authorisation code + PKCE S256 only; sign-in delegated to Google; the Google subject
 *                 must equal MCP_ALLOWED_GOOGLE_SUB; then an explicit consent page (the defence against
 *                 a confused deputy: a client someone else registered cannot get a code silently)
 *   token         authorisation_code and refresh_token (rotated, reuse kills the family)
 *
 * Tokens are audience-bound to this server's /mcp resource and are never forwarded anywhere.
 */
export const SCOPE = "kerneljson.operator";
export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_MS = 5 * 60_000;
const LOGIN_TTL_MS = 10 * 60_000;
const MAX_PENDING = 1000;
const MAX_FORM_BYTES = 8192;

export interface OAuthConfig {
  /** Public origin, e.g. https://kj-mcp.jonnyai.co.uk. The issuer, and the base of every URL served. */
  publicUrl: string;
  allowedGoogleSub: string;
  /** Exact redirect URIs a client may register (ChatGPT's connector callback). */
  allowedRedirectUris: readonly string[];
  /**
   * Close once ChatGPT is connected: an already-issued client id keeps working (it is self-contained),
   * but nobody else can register a lookalike "ChatGPT" client to phish a consent.
   */
  registrationOpen: boolean;
  signer: TokenSigner;
  google: GoogleSignIn;
  now?: () => number;
  /** Security events, never tokens, codes or secrets. */
  log?: (event: Record<string, unknown>) => void;
  /** Limits for /oauth/*. Defaults to DEFAULT_RATE_LIMITS. */
  rateLimits?: RateLimits;
}

interface PendingLogin {
  client: Client;
  clientId: string;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  scope: string;
  nonce: string;
  googleVerifier: string;
  expiresAt: number;
}
interface PendingConsent extends PendingLogin {
  sub: string;
}
interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  sub: string;
  expiresAt: number;
}

class OAuthError extends Error {
  constructor(readonly status: number, readonly code: string, readonly description: string) {
    super(code);
  }
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * `redirectOrigin` is set only on the consent page. Chrome applies form-action to the redirect that follows a
 * submit, so the client's own origin must be listed or the Allow redirect is silently blocked. Referrer-Policy is
 * same-origin, not no-referrer: under no-referrer a browser sends `Origin: null` on a form POST, which the consent
 * cross-site check rightly refuses (both found live, 22/10/2026).
 */
function page(res: ServerResponse, status: number, title: string, body: string, redirectOrigin?: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  const formAction = redirectOrigin ? `'self' ${redirectOrigin}` : "'self'";
  res.setHeader("content-security-policy", `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`);
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "same-origin");
  res.end(
    `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}button{font:inherit;padding:.5rem 1.2rem;margin-right:.5rem}code{background:#eee;padding:0 .2rem}</style>` +
      `</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
  );
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.setHeader("pragma", "no-cache");
  res.end(JSON.stringify(value));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const b = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
    size += b.length;
    if (size > MAX_FORM_BYTES) throw new OAuthError(413, "invalid_request", "Request too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/x-www-form-urlencoded")
    throw new OAuthError(400, "invalid_request", "Form encoding required");
  const form = new URLSearchParams(await readBody(req));
  for (const key of new Set(form.keys())) if (form.getAll(key).length > 1) throw new OAuthError(400, "invalid_request", `Repeated parameter: ${key}`);
  return form;
}

const RegistrationRequest = z.object({
  redirect_uris: z.array(z.string().max(500)).min(1).max(5),
  client_name: z.string().trim().max(100).optional(),
  token_endpoint_auth_method: z.enum(["none", "client_secret_post", "client_secret_basic"]).default("none"),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

/** Bounded single-use store. Overflow refuses new entries rather than evicting live ones. */
class OneShot<T extends { expiresAt: number }> {
  readonly #items = new Map<string, T>();
  constructor(private readonly now: () => number) {}
  put(key: string, value: T): boolean {
    for (const [k, v] of this.#items) if (v.expiresAt <= this.now()) this.#items.delete(k);
    if (this.#items.size >= MAX_PENDING) return false;
    this.#items.set(key, value);
    return true;
  }
  take(key: string | null | undefined): T | null {
    if (!key) return null;
    const value = this.#items.get(key);
    this.#items.delete(key);
    return value && value.expiresAt > this.now() ? value : null;
  }
}

export function createOAuthServer(config: OAuthConfig) {
  const now = config.now ?? Date.now;
  const origin = new URL(config.publicUrl).origin;
  if (origin !== config.publicUrl.replace(/\/+$/, "")) throw new Error("MCP_PUBLIC_URL must be an origin with no path");
  if (!/^[0-9]{1,64}$/.test(config.allowedGoogleSub)) throw new Error("MCP_ALLOWED_GOOGLE_SUB must be a Google subject id (digits)");
  const issuer = origin;
  const resource = `${origin}/mcp`;
  const redirectAllowList = new Set(config.allowedRedirectUris);
  const logins = new OneShot<PendingLogin>(now);
  const consents = new OneShot<PendingConsent>(now);
  const codes = new OneShot<IssuedCode>(now);
  const usedRefresh = new Map<string, number>();
  const revokedFamilies = new Map<string, number>();
  const seconds = () => Math.floor(now() / 1000);
  const audit = (event: string, detail: Record<string, unknown> = {}) => config.log?.({ oauth: event, ...detail });
  const limiter = new RateLimiter(config.rateLimits ?? DEFAULT_RATE_LIMITS, now);

  const resourceMetadata = {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
    resource_name: "KernelJSON operator",
  };
  const serverMetadata = {
    issuer,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };

  const clientFrom = (clientId: string | null | undefined): Client | null =>
    clientId ? config.signer.verify(clientId, ClientClaims, "client") : null;

  function pruneRefresh(): void {
    const t = seconds();
    for (const [k, exp] of usedRefresh) if (exp <= t) usedRefresh.delete(k);
    for (const [k, exp] of revokedFamilies) if (exp <= t) revokedFamilies.delete(k);
  }

  function issueTokens(input: { sub: string; clientId: string; scope: string; family?: string }) {
    const iat = seconds();
    const fam = input.family ?? randomToken(12);
    const common = { iss: issuer, aud: resource, sub: input.sub, cid: input.clientId, fam, scope: input.scope, iat };
    return {
      access_token: config.signer.sign({ typ: "access", ...common, exp: iat + ACCESS_TTL_S, jti: randomToken(12) }),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: config.signer.sign({ typ: "refresh", ...common, exp: iat + REFRESH_TTL_S, jti: randomToken(12) }),
      scope: input.scope,
    };
  }

  /** Bearer verifier for /mcp. Re-checks the permitted subject on every request. */
  function verifyAccess(authorization: string | undefined): Access | null {
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return null;
    const claims = config.signer.verify(authorization.slice(7), AccessClaims, "access");
    if (!claims) return null;
    if (claims.iss !== issuer || claims.aud !== resource || claims.exp <= seconds()) return null;
    if (claims.sub !== config.allowedGoogleSub || claims.scope !== SCOPE) return null;
    pruneRefresh();
    if (revokedFamilies.has(claims.fam)) return null;
    if (!clientFrom(claims.cid)) return null;
    return claims;
  }

  function redirectWith(res: ServerResponse, redirectUri: string, params: Record<string, string | undefined>): void {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    url.searchParams.set("iss", issuer);
    res.statusCode = 302;
    res.setHeader("location", url.toString());
    res.setHeader("cache-control", "no-store");
    res.end();
  }

  function register(body: unknown, res: ServerResponse): void {
    if (!config.registrationOpen) {
      audit("registration_refused_closed");
      return json(res, 403, { error: "access_denied", error_description: "Client registration is closed" });
    }
    const parsed = RegistrationRequest.safeParse(body);
    if (!parsed.success) return json(res, 400, { error: "invalid_client_metadata", error_description: "Malformed registration" });
    const r = parsed.data;
    if (!r.redirect_uris.every((u) => redirectAllowList.has(u))) {
      audit("registration_refused", { redirectUris: r.redirect_uris });
      return json(res, 400, { error: "invalid_redirect_uri", error_description: "This server accepts only the registered ChatGPT connector callback" });
    }
    if (r.grant_types && !r.grant_types.every((g) => ["authorization_code", "refresh_token"].includes(g)))
      return json(res, 400, { error: "invalid_client_metadata", error_description: "Unsupported grant type" });
    if (r.response_types && !r.response_types.every((t) => t === "code"))
      return json(res, 400, { error: "invalid_client_metadata", error_description: "Unsupported response type" });
    const iat = seconds();
    const clientId = config.signer.sign({
      typ: "client", iss: issuer, name: r.client_name ?? "Unnamed client", redirect_uris: r.redirect_uris, auth: r.token_endpoint_auth_method, iat, jti: randomToken(9),
    } satisfies Client);
    audit("client_registered", { name: r.client_name ?? "Unnamed client", redirectUris: r.redirect_uris, auth: r.token_endpoint_auth_method });
    json(res, 201, {
      client_id: clientId,
      ...(r.token_endpoint_auth_method === "none" ? {} : { client_secret: config.signer.clientSecret(clientId), client_secret_expires_at: 0 }),
      client_id_issued_at: iat,
      client_name: r.client_name ?? "Unnamed client",
      redirect_uris: r.redirect_uris,
      token_endpoint_auth_method: r.token_endpoint_auth_method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPE,
    });
  }

  function authorize(url: URL, res: ServerResponse): void {
    const q = url.searchParams;
    for (const key of new Set(q.keys())) if (q.getAll(key).length > 1) return page(res, 400, "Invalid request", "<p>A parameter was repeated.</p>");
    const clientId = q.get("client_id");
    const client = clientFrom(clientId);
    const redirectUri = q.get("redirect_uri");
    // Without a known client and one of its own redirect URIs, never redirect anywhere.
    if (!client || !clientId || !redirectUri || !client.redirect_uris.includes(redirectUri) || !redirectAllowList.has(redirectUri))
      return page(res, 400, "Invalid request", "<p>Unknown client or redirect address.</p>");
    const state = q.get("state") ?? undefined;
    const fail = (error: string, description: string) => redirectWith(res, redirectUri, { error, error_description: description, state });
    if (q.get("response_type") !== "code") return fail("unsupported_response_type", "Only the authorisation code flow is supported");
    const challenge = q.get("code_challenge");
    if (q.get("code_challenge_method") !== "S256" || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail("invalid_request", "PKCE with S256 is required");
    const requestedResource = q.get("resource");
    if (requestedResource !== null && requestedResource !== resource) return fail("invalid_target", "Unknown resource");
    const scope = q.get("scope");
    if (scope !== null && scope !== "" && !scope.split(" ").every((s) => s === SCOPE)) return fail("invalid_scope", "Unknown scope");
    const googleState = randomToken();
    const nonce = randomToken();
    const googleVerifier = randomToken(48);
    const stored = logins.put(googleState, {
      client, clientId, redirectUri, state, codeChallenge: challenge, scope: SCOPE, nonce, googleVerifier, expiresAt: now() + LOGIN_TTL_MS,
    });
    if (!stored) return fail("temporarily_unavailable", "Too many sign-ins in progress");
    res.statusCode = 302;
    res.setHeader("location", config.google.authorizeUrl({ state: googleState, nonce, codeChallenge: pkceChallenge(googleVerifier) }));
    res.setHeader("cache-control", "no-store");
    res.end();
  }

  async function googleCallback(url: URL, res: ServerResponse): Promise<void> {
    const login = logins.take(url.searchParams.get("state"));
    if (!login) return page(res, 400, "Sign-in expired", "<p>This sign-in link has expired or was already used. Start again from ChatGPT.</p>");
    const code = url.searchParams.get("code");
    if (!code) return redirectWith(res, login.redirectUri, { error: "access_denied", error_description: "Google sign-in was cancelled", state: login.state });
    const identity = await config.google.exchange({ code, codeVerifier: login.googleVerifier, nonce: login.nonce });
    if (!identity) return redirectWith(res, login.redirectUri, { error: "access_denied", error_description: "Google sign-in could not be verified", state: login.state });
    if (!safeEqual(identity.sub, config.allowedGoogleSub)) {
      audit("signin_refused", { sub: identity.sub });
      // Showing the person their own account id is how the permitted id is found at setup time.
      return page(
        res,
        403,
        "Not permitted",
        `<p>This Google account is not permitted to use KernelJSON. Nothing was shared with the application that asked.</p><p>Your Google account id is <code>${escapeHtml(identity.sub)}</code>.</p>`,
      );
    }
    const ticket = randomToken();
    if (!consents.put(ticket, { ...login, sub: identity.sub, expiresAt: now() + LOGIN_TTL_MS }))
      return redirectWith(res, login.redirectUri, { error: "temporarily_unavailable", state: login.state });
    const target = new URL(login.redirectUri);
    page(
      res,
      200,
      "Allow access to KernelJSON?",
      `<p><strong>${escapeHtml(login.client.name)}</strong> is asking to act as you in KernelJSON.</p>` +
        `<p>It will be able to read your tasks, evidence, memory and health, start a morning brief or a read-only repository analysis, and cancel tasks. It cannot approve anything.</p>` +
        `<p>Access goes to <code>${escapeHtml(target.origin)}</code>. Only allow this if you have just asked ChatGPT to connect to KernelJSON.</p>` +
        `<form method="post" action="/oauth/consent"><input type="hidden" name="ticket" value="${escapeHtml(ticket)}">` +
        `<button type="submit" name="decision" value="allow">Allow</button><button type="submit" name="decision" value="deny">Deny</button></form>`,
      target.origin,
    );
  }

  async function consent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The form is only ever posted from this origin's own page.
    const sent = req.headers.origin;
    if (sent !== undefined && sent !== origin) return page(res, 403, "Not permitted", "<p>Cross-site request refused.</p>");
    const form = await readForm(req);
    const pending = consents.take(form.get("ticket"));
    if (!pending) return page(res, 400, "Sign-in expired", "<p>This approval has expired or was already used. Start again from ChatGPT.</p>");
    audit(form.get("decision") === "allow" ? "consent_allowed" : "consent_denied", { client: pending.client.name });
    if (form.get("decision") !== "allow") return redirectWith(res, pending.redirectUri, { error: "access_denied", error_description: "Access was denied", state: pending.state });
    const code = randomToken();
    codes.put(code, {
      clientId: pending.clientId, redirectUri: pending.redirectUri, codeChallenge: pending.codeChallenge, scope: pending.scope, sub: pending.sub, expiresAt: now() + CODE_TTL_MS,
    });
    redirectWith(res, pending.redirectUri, { code, state: pending.state });
  }

  function authenticateClient(req: IncomingMessage, form: URLSearchParams): { clientId: string; client: Client } {
    let clientId = form.get("client_id");
    let secret = form.get("client_secret");
    const basic = req.headers.authorization;
    if (basic?.startsWith("Basic ")) {
      const decoded = Buffer.from(basic.slice(6), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon < 0) throw new OAuthError(401, "invalid_client", "Malformed client credentials");
      clientId = decodeURIComponent(decoded.slice(0, colon));
      secret = decodeURIComponent(decoded.slice(colon + 1));
    }
    const client = clientFrom(clientId);
    if (!client || !clientId) throw new OAuthError(401, "invalid_client", "Unknown client");
    if (client.auth !== "none" && (!secret || !safeEqual(secret, config.signer.clientSecret(clientId))))
      throw new OAuthError(401, "invalid_client", "Client authentication failed");
    return { clientId, client };
  }

  async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readForm(req);
    const { clientId } = authenticateClient(req, form);
    const grant = form.get("grant_type");
    const requestedResource = form.get("resource");
    if (requestedResource !== null && requestedResource !== resource) throw new OAuthError(400, "invalid_target", "Unknown resource");
    if (grant === "authorization_code") {
      const issued = codes.take(form.get("code"));
      const verifier = form.get("code_verifier");
      if (!issued || issued.clientId !== clientId || issued.redirectUri !== form.get("redirect_uri")) throw new OAuthError(400, "invalid_grant", "Invalid or expired code");
      if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(pkceChallenge(verifier), issued.codeChallenge))
        throw new OAuthError(400, "invalid_grant", "PKCE verification failed");
      return json(res, 200, issueTokens({ sub: issued.sub, clientId, scope: issued.scope }));
    }
    if (grant === "refresh_token") {
      pruneRefresh();
      const claims = config.signer.verify(form.get("refresh_token") ?? undefined, RefreshClaims, "refresh");
      if (!claims || claims.iss !== issuer || claims.aud !== resource || claims.exp <= seconds() || claims.cid !== clientId)
        throw new OAuthError(400, "invalid_grant", "Invalid refresh token");
      if (claims.sub !== config.allowedGoogleSub || revokedFamilies.has(claims.fam)) throw new OAuthError(400, "invalid_grant", "Access revoked");
      if (usedRefresh.has(claims.jti)) {
        // A refresh token presented twice means one copy is not ChatGPT's: end the whole family.
        revokedFamilies.set(claims.fam, seconds() + REFRESH_TTL_S);
        audit("refresh_reuse_family_revoked", { client: clientFrom(clientId)?.name ?? null });
        throw new OAuthError(400, "invalid_grant", "Refresh token reuse detected");
      }
      usedRefresh.set(claims.jti, claims.exp);
      return json(res, 200, issueTokens({ sub: claims.sub, clientId, scope: claims.scope, family: claims.fam }));
    }
    throw new OAuthError(400, "unsupported_grant_type", "Unsupported grant type");
  }

  /** Handles the OAuth and discovery routes; returns false for anything else. */
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const route = `${req.method} ${url.pathname}`;
    // Discovery is static and cheap; every /oauth/* request is counted, recognised route or not.
    if (url.pathname.startsWith("/oauth/")) {
      const decision = limiter.check(clientAddress(req), route === "POST /oauth/register");
      if (!decision.ok) {
        audit("rate_limited", { route, rule: decision.rule });
        req.resume();
        res.setHeader("retry-after", String(decision.retryAfterS));
        json(res, 429, { error: "rate_limited", error_description: "Too many requests; try again shortly" });
        return true;
      }
    }
    try {
      switch (route) {
        case "GET /.well-known/oauth-protected-resource":
        case "GET /.well-known/oauth-protected-resource/mcp":
          json(res, 200, resourceMetadata);
          return true;
        case "GET /.well-known/oauth-authorization-server":
        case "GET /.well-known/openid-configuration":
          json(res, 200, serverMetadata);
          return true;
        case "POST /oauth/register": {
          if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new OAuthError(400, "invalid_client_metadata", "JSON required");
          let body: unknown;
          try {
            body = JSON.parse(await readBody(req));
          } catch (e) {
            if (e instanceof OAuthError) throw e;
            throw new OAuthError(400, "invalid_client_metadata", "Malformed JSON");
          }
          register(body, res);
          return true;
        }
        case "GET /oauth/authorize":
          authorize(url, res);
          return true;
        case "GET /oauth/google/callback":
          await googleCallback(url, res);
          return true;
        case "POST /oauth/consent":
          await consent(req, res);
          return true;
        case "POST /oauth/token":
          await token(req, res);
          return true;
        default:
          return false;
      }
    } catch (e) {
      if (e instanceof OAuthError) {
        if (e.status === 401) res.setHeader("www-authenticate", 'Basic realm="kerneljson-operator"');
        json(res, e.status, { error: e.code, error_description: e.description });
      } else {
        json(res, 500, { error: "server_error" });
      }
      return true;
    }
  }

  return {
    handle,
    verifyAccess,
    resource,
    resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
    googleRedirectUri: `${origin}/oauth/google/callback`,
  };
}
