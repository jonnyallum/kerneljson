import { z } from "zod";

/**
 * Sign-in is delegated to Google. The server never sees a Google password, never keeps a Google token,
 * and asks only for `openid`: the one thing it needs is the account's stable subject id, which it
 * compares with the single permitted subject. Email text is never used to decide anything.
 */
export interface GoogleSignIn {
  authorizeUrl(input: { state: string; nonce: string; codeChallenge: string }): string;
  /** The verified subject for a Google authorisation code, or null on any failure. */
  exchange(input: { code: string; codeVerifier: string; nonce: string }): Promise<{ sub: string } | null>;
}

const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export const IdTokenClaims = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().regex(/^[0-9]{1,64}$/),
  exp: z.number(),
  nonce: z.string().optional(),
});

/**
 * OIDC Core 3.1.3.7: an ID token received directly from the token endpoint over TLS may be validated by
 * that TLS connection instead of its signature. This server only ever takes ID tokens from Google's
 * token endpoint, in the same exchange that redeemed its own single-use code, so it checks issuer,
 * audience, expiry and nonce and does not fetch Google's signing keys.
 */
export function checkIdToken(idToken: unknown, expected: { clientId: string; nonce: string; nowSeconds: number }): { sub: string } | null {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let claims: z.infer<typeof IdTokenClaims>;
  try {
    const parsed = IdTokenClaims.safeParse(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
    if (!parsed.success) return null;
    claims = parsed.data;
  } catch {
    return null;
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!ISSUERS.has(claims.iss)) return null;
  if (audiences.length !== 1 || audiences[0] !== expected.clientId) return null;
  if (claims.exp <= expected.nowSeconds) return null;
  if (claims.nonce !== expected.nonce) return null;
  return { sub: claims.sub };
}

export class HttpGoogleSignIn implements GoogleSignIn {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #redirectUri: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(config: { clientId: string; clientSecret: string; redirectUri: string }, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
    if (!/^[0-9A-Za-z._-]{10,200}\.apps\.googleusercontent\.com$/.test(config.clientId)) throw new Error("GOOGLE_CLIENT_ID is not a Google OAuth client id");
    if (config.clientSecret.length < 10) throw new Error("GOOGLE_CLIENT_SECRET missing or malformed");
    this.#clientId = config.clientId;
    this.#clientSecret = config.clientSecret;
    this.#redirectUri = config.redirectUri;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  authorizeUrl(input: { state: string; nonce: string; codeChallenge: string }): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.#clientId,
      redirect_uri: this.#redirectUri,
      response_type: "code",
      scope: "openid",
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return url.toString();
  }

  async exchange(input: { code: string; codeVerifier: string; nonce: string }): Promise<{ sub: string } | null> {
    let response: Response;
    try {
      response = await this.#fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: input.code,
          client_id: this.#clientId,
          client_secret: this.#clientSecret,
          redirect_uri: this.#redirectUri,
          grant_type: "authorization_code",
          code_verifier: input.codeVerifier,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    try {
      const body = (await response.json()) as { id_token?: unknown };
      return checkIdToken(body.id_token, { clientId: this.#clientId, nonce: input.nonce, nowSeconds: Math.floor(this.#now() / 1000) });
    } catch {
      return null;
    }
  }
}
