import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Signed, self-contained tokens for the operator MCP server's own OAuth 2.1 authorisation server.
 * Access tokens, refresh tokens and even dynamically registered client ids are HMAC-signed claims, so
 * a container restart neither logs ChatGPT out nor forgets its registration. Only single-use state
 * (authorisation codes, pending logins, used refresh tokens) lives in memory, and losing it on a
 * restart only ever makes the server refuse more, never accept more.
 *
 * Revocation is by rotating MCP_TOKEN_SIGNING_KEY (everything issued becomes invalid) or by changing
 * MCP_ALLOWED_GOOGLE_SUB (every token names its subject and is re-checked on every request).
 */
export const TOKEN_PREFIX = "kjm1";

export const AccessClaims = z.strictObject({
  typ: z.literal("access"),
  iss: z.string(),
  aud: z.string(),
  sub: z.string(),
  cid: z.string(),
  fam: z.string(),
  scope: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string(),
});
export const RefreshClaims = AccessClaims.extend({ typ: z.literal("refresh") });
export const ClientClaims = z.strictObject({
  typ: z.literal("client"),
  iss: z.string(),
  name: z.string().max(100),
  redirect_uris: z.array(z.string()).min(1).max(5),
  auth: z.enum(["none", "client_secret_post", "client_secret_basic"]),
  iat: z.number().int(),
  jti: z.string(),
});
export type AccessClaims = z.infer<typeof AccessClaims>;
export type RefreshClaims = z.infer<typeof RefreshClaims>;
export type ClientClaims = z.infer<typeof ClientClaims>;

const b64 = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export const pkceChallenge = (verifier: string): string => b64(createHash("sha256").update(verifier, "ascii").digest());

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class TokenSigner {
  readonly #key: Buffer;

  constructor(key: string) {
    // At least 32 bytes of key material. The value itself is never part of any message.
    if (Buffer.byteLength(key, "utf8") < 32) throw new Error("MCP_TOKEN_SIGNING_KEY must be at least 32 bytes");
    this.#key = Buffer.from(key, "utf8");
  }

  #mac(purpose: string, payload: string): string {
    return b64(createHmac("sha256", this.#key).update(`${TOKEN_PREFIX}.${purpose}.${payload}`).digest());
  }

  sign(claims: { typ: string } & Record<string, unknown>): string {
    const payload = b64(JSON.stringify(claims));
    return `${TOKEN_PREFIX}.${payload}.${this.#mac(claims.typ, payload)}`;
  }

  /** The claims if the token is well-formed, signed by this key for this purpose and matches the schema; otherwise null. */
  verify<T>(token: string | undefined, schema: z.ZodType<T>, typ: string): T | null {
    if (typeof token !== "string" || token.length > 4096) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
    const [, payload, mac] = parts as [string, string, string];
    if (!safeEqual(mac, this.#mac(typ, payload))) return null;
    try {
      const parsed = schema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** A confidential client's secret is derived from its id, so it needs no storage either. */
  clientSecret(clientId: string): string {
    return this.#mac("client-secret", clientId);
  }
}
