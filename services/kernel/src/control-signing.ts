import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { ApprovalAnswer, PrincipalRef } from "../../../packages/contracts/src/index.js";

/**
 * KJ-P4B.1 - Restate-safe control request signing.
 *
 * WHY THIS EXISTS. Restate journals every header of an incoming request (the invocation's `Input`
 * entry) and keeps it for 24 hours after completion, readable through its admin SQL and its data
 * volume (measured in the KJ-P4B live window, recorded in
 * docs/operations/PHASE_KJ_P4B_TELEGRAM_APPROVALS_LIVE_RESULT_2026-09-20.md). A long-lived bearer
 * credential on the door-to-workflow hop is therefore a credential written into a durable store. So
 * the long-lived key is NEVER transmitted. For each request the door sends a short-lived assertion,
 * an HMAC over that exact request, in dedicated `X-KJ-Control-*` headers (never `Authorization`).
 * Everything Restate can journal here is a bounded, request-bound, non-secret assertion.
 *
 * WHAT IS SIGNED (the canonical payload). A domain tag, a newline, then a JSON array of thirteen
 * strings in this fixed order:
 *
 *   version, keyId, method, service, handler, key, tenantId, principalId,
 *   scopeDigest, decision, bodySha256, issuedAt, nonce
 *
 * JSON string escaping makes every field boundary unambiguous, so no two different field tuples can
 * encode to the same bytes. `key` is the workflow key (the task id). `scopeDigest` and `decision`
 * are read from the request body for `approve` and are the empty string otherwise, so an approval
 * signature names the exact task, tenant, approver, full scope digest and decision, and also the
 * hash of the whole body. `issuedAt` is unix seconds. The signature is
 * HMAC-SHA256(signingKey, canonical payload), compared in constant time.
 *
 * WHAT THE WORKER DOES NOT TRUST. It does not read the route, task, tenant, principal, digest or
 * decision from any header. It rebuilds the canonical payload from what it actually received (its own
 * service name, the handler being run, the workflow key, the raw body) and from its own configured
 * tenant and principal, so an assertion only verifies for the request it was made for.
 *
 * REPLAY MODEL. Restate legitimately redelivers durable work with identical headers and body, so
 * "seen before" cannot simply mean "reject". The nonce is recorded with the sha256 of the canonical
 * payload in `kernel_private.control_assertions`, on the DATABASE clock:
 *   first sight        -> the signature must already have verified, and issuedAt must be within the
 *                         freshness window of the database's now(); then it is recorded
 *   seen, same digest  -> accepted (an idempotent replay; freshness is not re-checked)
 *   seen, other digest -> rejected
 *   never seen, stale  -> rejected
 * The signature is verified BEFORE the store is touched, so unauthenticated traffic writes nothing.
 */
export const CONTROL_VERSION = "1";
export const CONTROL_DOMAIN = "kj-control/v1";
export const DEFAULT_FRESHNESS_SECONDS = 300;
export const MIN_SIGNING_KEY_LENGTH = 32;
/** Nonce rows older than this are purged. A replay older than this is stale, so still rejected. */
export const NONCE_RETENTION_DAYS = 7;

export const CONTROL_HEADERS = {
  version: "x-kj-control-version",
  keyId: "x-kj-control-key-id",
  timestamp: "x-kj-control-timestamp",
  nonce: "x-kj-control-nonce",
  bodySha256: "x-kj-control-body-sha256",
  signature: "x-kj-control-signature",
} as const;

const KEY_ID = /^[A-Za-z0-9._-]{1,16}$/;
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const SECONDS = /^[0-9]{1,12}$/;

export const isKeyId = (v: string): boolean => KEY_ID.test(v);

/** Authentication failed. `code` is a fixed vocabulary; nothing about a value is ever carried. */
export class ControlAuthError extends Error {
  constructor(readonly code: string) {
    super("control assertion refused");
    this.name = "ControlAuthError";
  }
}

/**
 * The verifier could not decide (for example the database is down). This is not a refusal: callers
 * must retry, not treat it as "unauthenticated", or an outage would permanently fail durable work.
 */
export class AuthenticatorUnavailableError extends Error {
  constructor() {
    super("control verification temporarily unavailable");
    this.name = "AuthenticatorUnavailableError";
  }
}

/** What a request is, independent of any credential. */
export interface ControlRequest {
  service: string;
  handler: string;
  /** The workflow key: the task id. */
  key: string;
  body: Uint8Array | string;
}

export interface CanonicalFields {
  version: string;
  keyId: string;
  method: "POST";
  service: string;
  handler: string;
  key: string;
  tenantId: string;
  principalId: string;
  scopeDigest: string;
  decision: string;
  bodySha256: string;
  issuedAt: string;
  nonce: string;
}

export const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

/** The exact bytes that are signed. Pinned by a golden-vector test: changing it breaks every assertion. */
export function canonicalPayload(f: CanonicalFields): string {
  return (
    CONTROL_DOMAIN +
    "\n" +
    JSON.stringify([
      f.version,
      f.keyId,
      f.method,
      f.service,
      f.handler,
      f.key,
      f.tenantId,
      f.principalId,
      f.scopeDigest,
      f.decision,
      f.bodySha256,
      f.issuedAt,
      f.nonce,
    ])
  );
}

/** For `approve`, the scope digest and decision named in the body; otherwise, or if unparseable, empty strings. */
export function approvalFields(handler: string, body: Uint8Array | string): { scopeDigest: string; decision: string } {
  if (handler !== "approve") return { scopeDigest: "", decision: "" };
  try {
    const text = typeof body === "string" ? body : new TextDecoder("utf-8", { fatal: true }).decode(body);
    const parsed = ApprovalAnswer.safeParse(JSON.parse(text));
    return parsed.success ? { scopeDigest: parsed.data.scopeDigest, decision: parsed.data.decision } : { scopeDigest: "", decision: "" };
  } catch {
    return { scopeDigest: "", decision: "" };
  }
}

const mac = (key: string, canonical: string): string => createHmac("sha256", key).update(canonical, "utf8").digest("hex");

/** Constant-time equality of two lower-case hex sha256 strings. */
function sameHex(a: string, b: string): boolean {
  if (!HEX64.test(a) || !HEX64.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export interface SignerOptions {
  keyId: string;
  /** SENSITIVE. Held in the door's environment only. Never returned, logged or transmitted. */
  key: string;
  now?: () => number;
  nonce?: () => string;
}

export type ControlSigner = (request: ControlRequest & { tenantId: string; principalId: string }) => Record<string, string>;

/** The door's side. Returns headers that carry an assertion and never the key. */
export function createControlSigner(options: SignerOptions): ControlSigner {
  if (!KEY_ID.test(options.keyId)) throw new Error("invalid control key id");
  if (options.key.length < MIN_SIGNING_KEY_LENGTH) throw new Error("control signing key is too short");
  const now = options.now ?? (() => Date.now());
  const nonce = options.nonce ?? (() => randomBytes(16).toString("base64url"));
  return (request) => {
    const bodySha256 = sha256Hex(request.body);
    const { scopeDigest, decision } = approvalFields(request.handler, request.body);
    const fields: CanonicalFields = {
      version: CONTROL_VERSION,
      keyId: options.keyId,
      method: "POST",
      service: request.service,
      handler: request.handler,
      key: request.key,
      tenantId: request.tenantId,
      principalId: request.principalId,
      scopeDigest,
      decision,
      bodySha256,
      issuedAt: String(Math.floor(now() / 1000)),
      nonce: nonce(),
    };
    return {
      [CONTROL_HEADERS.version]: fields.version,
      [CONTROL_HEADERS.keyId]: fields.keyId,
      [CONTROL_HEADERS.timestamp]: fields.issuedAt,
      [CONTROL_HEADERS.nonce]: fields.nonce,
      [CONTROL_HEADERS.bodySha256]: fields.bodySha256,
      [CONTROL_HEADERS.signature]: mac(options.key, canonicalPayload(fields)),
    };
  };
}

export type ReplayVerdict = "FIRST_SEEN" | "REPLAY" | "STALE" | "CONFLICT";

export interface ReplayRecord {
  nonce: string;
  keyId: string;
  /** sha256 of the canonical payload. */
  digest: string;
  issuedAt: number;
  service: string;
  handler: string;
  key: string;
  freshnessSeconds: number;
}

/** Where nonces are remembered. Authoritative freshness is the store's own clock, not the caller's. */
export interface ReplayStore {
  admit(record: ReplayRecord): Promise<ReplayVerdict>;
}

/** Postgres store. `now()` is the database's clock, so a skewed worker clock cannot widen or shrink the window. */
export class PgControlReplayStore implements ReplayStore {
  constructor(private readonly pool: pg.Pool) {}

  async admit(r: ReplayRecord): Promise<ReplayVerdict> {
    try {
      const inserted = await this.pool.query(
        `insert into kernel_private.control_assertions(nonce, key_id, request_digest, issued_at, service, handler, workflow_key)
         select $1, $2, $3, to_timestamp($4::bigint), $5, $6, $7
          where abs(extract(epoch from now()) - $4::bigint) <= $8::int
         on conflict (nonce) do nothing
         returning nonce`,
        [r.nonce, r.keyId, r.digest, r.issuedAt, r.service, r.handler, r.key, r.freshnessSeconds],
      );
      if (inserted.rowCount === 1) {
        // Housekeeping only; a failure here must never fail an authentic request.
        await this.pool
          .query(
            `delete from kernel_private.control_assertions
              where nonce in (select nonce from kernel_private.control_assertions
                               where first_seen_at < now() - ($1::int * interval '1 day') limit 50)`,
            [NONCE_RETENTION_DAYS],
          )
          .catch(() => {});
        return "FIRST_SEEN";
      }
      const existing = await this.pool.query<{ request_digest: string }>(
        "select request_digest from kernel_private.control_assertions where nonce = $1",
        [r.nonce],
      );
      const row = existing.rows[0];
      if (!row) return "STALE";
      return row.request_digest === r.digest ? "REPLAY" : "CONFLICT";
    } catch {
      throw new AuthenticatorUnavailableError();
    }
  }
}

/** In-memory store with an injectable clock (seconds), for unit tests. Same semantics as the Postgres one. */
export class InMemoryReplayStore implements ReplayStore {
  readonly seen = new Map<string, string>();
  admits = 0;
  constructor(private readonly nowSeconds: () => number = () => Date.now() / 1000) {}
  async admit(r: ReplayRecord): Promise<ReplayVerdict> {
    this.admits += 1;
    if (Math.abs(this.nowSeconds() - r.issuedAt) <= r.freshnessSeconds && !this.seen.has(r.nonce)) {
      this.seen.set(r.nonce, r.digest);
      return "FIRST_SEEN";
    }
    const digest = this.seen.get(r.nonce);
    if (digest === undefined) return "STALE";
    return digest === r.digest ? "REPLAY" : "CONFLICT";
  }
}

export interface VerifierConfig {
  /** key id -> signing key. Current and, during a controlled rotation, previous. SENSITIVE. */
  keys: ReadonlyMap<string, string>;
  tenantId: string;
  principalId: string;
  freshnessSeconds: number;
  replay: ReplayStore;
}

export type ControlVerifier = (headers: ReadonlyMap<string, string>, request: ControlRequest) => Promise<PrincipalRef>;

function header(headers: ReadonlyMap<string, string>, name: string): string | undefined {
  const direct = headers.get(name);
  if (direct !== undefined) return direct;
  for (const [k, v] of headers) if (k.toLowerCase() === name) return v;
  return undefined;
}

/**
 * The worker's side. Resolves the door's fixed principal, or throws `ControlAuthError` (refusal) or
 * `AuthenticatorUnavailableError` (could not decide, retry).
 */
export function createControlVerifier(config: VerifierConfig): ControlVerifier {
  for (const [id, key] of config.keys) {
    if (!KEY_ID.test(id)) throw new Error("invalid control key id");
    if (key.length < MIN_SIGNING_KEY_LENGTH) throw new Error("control signing key is too short");
  }
  if (config.keys.size === 0) throw new Error("no control signing key configured");
  const principal = PrincipalRef.parse({ id: config.principalId, kind: "HUMAN" });
  return async (headers, request) => {
    const version = header(headers, CONTROL_HEADERS.version);
    const keyId = header(headers, CONTROL_HEADERS.keyId);
    const timestamp = header(headers, CONTROL_HEADERS.timestamp);
    const nonce = header(headers, CONTROL_HEADERS.nonce);
    const claimedBody = header(headers, CONTROL_HEADERS.bodySha256);
    const signature = header(headers, CONTROL_HEADERS.signature);
    if ([version, keyId, timestamp, nonce, claimedBody, signature].some((v) => v === undefined)) throw new ControlAuthError("MISSING");
    if (version !== CONTROL_VERSION) throw new ControlAuthError("VERSION");
    if (!KEY_ID.test(keyId!) || !NONCE.test(nonce!) || !SECONDS.test(timestamp!) || !HEX64.test(claimedBody!) || !HEX64.test(signature!))
      throw new ControlAuthError("MALFORMED");
    const key = config.keys.get(keyId!);
    if (key === undefined) throw new ControlAuthError("UNKNOWN_KEY");

    const bodySha256 = sha256Hex(request.body);
    if (!sameHex(bodySha256, claimedBody!)) throw new ControlAuthError("BODY");
    const { scopeDigest, decision } = approvalFields(request.handler, request.body);
    const canonical = canonicalPayload({
      version: CONTROL_VERSION,
      keyId: keyId!,
      method: "POST",
      service: request.service,
      handler: request.handler,
      key: request.key,
      tenantId: config.tenantId,
      principalId: config.principalId,
      scopeDigest,
      decision,
      bodySha256,
      issuedAt: timestamp!,
      nonce: nonce!,
    });
    if (!sameHex(mac(key, canonical), signature!)) throw new ControlAuthError("SIGNATURE");

    // Authentic. Only now does anything touch the store.
    const verdict = await config.replay.admit({
      nonce: nonce!,
      keyId: keyId!,
      digest: sha256Hex(canonical),
      issuedAt: Number(timestamp),
      service: request.service,
      handler: request.handler,
      key: request.key,
      freshnessSeconds: config.freshnessSeconds,
    });
    if (verdict === "FIRST_SEEN" || verdict === "REPLAY") return principal;
    throw new ControlAuthError(verdict);
  };
}
