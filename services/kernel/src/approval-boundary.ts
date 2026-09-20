import { UPPERCASE } from "../../../packages/capabilities/src/index.js";
import {
  DEFAULT_FRESHNESS_SECONDS,
  MIN_SIGNING_KEY_LENGTH,
  PgControlReplayStore,
  createControlVerifier,
  isKeyId,
  type ReplayStore,
} from "./control-signing.js";
import { createGoldenWorkflow, type Authenticator } from "./golden-workflow.js";
import type { Ledger } from "./ledger.js";
import { PolicyRules } from "./policy.js";

/**
 * KJ-P4B - the production approval boundary: the existing golden workflow, registered for real.
 *
 * `GoldenTaskWorkflowV1` and its policy, approval store and human `approve` control were built and
 * qualified in earlier phases but never registered in the production worker: ADR-0008 says
 * registration awaits "a real authentication boundary". This is that boundary, and nothing more. It
 * adds no approval logic. The workflow, the policy evaluation, the ApprovalStore and every check in
 * it are unchanged; this file only supplies the two things the workflow was built to be given:
 *
 *  1. The policy rules: ONE rule, for the harmless deterministic `uppercase` capability (it uppercases
 *     the task's own text, touches no file, network or account), that requires approval by the door's
 *     one HUMAN principal. This is the synthetic approval boundary for the first live approval. It is
 *     not a mutation of anything and it is not a general policy.
 *  2. The authenticator (KJ-P4B.1): the door signs each control request with an HMAC assertion in
 *     dedicated `X-KJ-Control-*` headers; the worker verifies the assertion against the request it
 *     actually received and remembers the nonce so a Restate redelivery is idempotent and an
 *     attacker's replay is not. The long-lived signing key is NEVER transmitted, because Restate
 *     journals every request header for 24 hours. See `control-signing.ts` for the format and the
 *     replay model. The identity is fixed by configuration, never read from the request.
 *
 * Fail closed and secret-safe, in the same style as the canary, admission, mission and Telegram seams:
 * unset serves no approval workflow (the worker's existing behaviour), and a partial or ambiguous
 * configuration stops the worker at startup naming only the variable, never a value.
 *
 *   KJ_APPROVAL_ENABLED             "true" turns it on; unset, empty or "false" leaves it off
 *   KJ_ADMISSION_TENANT_ID          the door's tenant (non-secret; the same value the door already has)
 *   KJ_ADMISSION_PRINCIPAL_ID       the door's principal, who is also the named approver (non-secret)
 *   KJ_CONTROL_SIGNING_KEY          secret, at least 32 characters; the door holds the same value
 *   KJ_CONTROL_KEY_ID               id of that key, default "v1"
 *   KJ_CONTROL_SIGNING_KEY_PREVIOUS optional, during a controlled rotation only: the previous key ...
 *   KJ_CONTROL_KEY_ID_PREVIOUS      ... and its id; both or neither, and both must differ from the current
 *   KJ_CONTROL_FRESHNESS_SECONDS    optional, 30 to 3600, default 300
 *   KJ_APPROVAL_TTL_SECONDS         optional, 30 to 86400, default 600
 */
export const APPROVAL_POLICY_VERSION = "kj-approval-policy/1";
export const DEFAULT_APPROVAL_TTL_SECONDS = 600;
export const DEFAULT_CONTROL_KEY_ID = "v1";

export interface ApprovalBoundaryConfig {
  tenantId: string;
  principalId: string;
  ttlMs: number;
  control: {
    /** key id -> key. SENSITIVE: never logged, never returned to a printer. */
    keys: ReadonlyMap<string, string>;
    freshnessSeconds: number;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function whole(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!(raw === undefined || raw === "" || /^[0-9]{1,5}$/.test(raw)) || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return value;
}

export function loadApprovalBoundaryConfig(env: NodeJS.ProcessEnv): ApprovalBoundaryConfig | undefined {
  const flag = env["KJ_APPROVAL_ENABLED"];
  if (flag === undefined || flag === "" || flag === "false") return undefined;
  if (flag !== "true") throw new Error('KJ_APPROVAL_ENABLED must be exactly "true" or "false" when set - refusing to guess');

  const tenantId = env["KJ_ADMISSION_TENANT_ID"];
  const principalId = env["KJ_ADMISSION_PRINCIPAL_ID"];
  const key = env["KJ_CONTROL_SIGNING_KEY"];
  const missing = [
    ["KJ_ADMISSION_TENANT_ID", tenantId],
    ["KJ_ADMISSION_PRINCIPAL_ID", principalId],
    ["KJ_CONTROL_SIGNING_KEY", key],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0)
    throw new Error(`KJ_APPROVAL_ENABLED=true requires ${missing.join(", ")} - refusing to start half-configured`);
  if (!UUID.test(tenantId!) || !UUID.test(principalId!))
    throw new Error("KJ_ADMISSION_TENANT_ID and KJ_ADMISSION_PRINCIPAL_ID must be UUIDs");
  if (key!.length < MIN_SIGNING_KEY_LENGTH)
    throw new Error(`KJ_CONTROL_SIGNING_KEY must be at least ${MIN_SIGNING_KEY_LENGTH} characters`);

  const keyId = env["KJ_CONTROL_KEY_ID"] === undefined || env["KJ_CONTROL_KEY_ID"] === "" ? DEFAULT_CONTROL_KEY_ID : env["KJ_CONTROL_KEY_ID"];
  if (!isKeyId(keyId)) throw new Error("KJ_CONTROL_KEY_ID must be 1 to 16 characters from A-Z a-z 0-9 . _ -");
  const keys = new Map<string, string>([[keyId, key!]]);

  // A controlled rotation: the worker briefly recognises the previous key too. The door signs only with the current one.
  const previousKey = env["KJ_CONTROL_SIGNING_KEY_PREVIOUS"] || undefined;
  const previousId = env["KJ_CONTROL_KEY_ID_PREVIOUS"] || undefined;
  if ((previousKey === undefined) !== (previousId === undefined))
    throw new Error("KJ_CONTROL_SIGNING_KEY_PREVIOUS and KJ_CONTROL_KEY_ID_PREVIOUS must be set together or not at all");
  if (previousKey !== undefined && previousId !== undefined) {
    if (!isKeyId(previousId)) throw new Error("KJ_CONTROL_KEY_ID_PREVIOUS must be 1 to 16 characters from A-Z a-z 0-9 . _ -");
    if (previousKey.length < MIN_SIGNING_KEY_LENGTH)
      throw new Error(`KJ_CONTROL_SIGNING_KEY_PREVIOUS must be at least ${MIN_SIGNING_KEY_LENGTH} characters`);
    if (previousId === keyId) throw new Error("the previous control key id must differ from the current one");
    if (previousKey === key) throw new Error("the previous control signing key must differ from the current one");
    keys.set(previousId, previousKey);
  }

  return {
    tenantId: tenantId!,
    principalId: principalId!,
    ttlMs: whole(env, "KJ_APPROVAL_TTL_SECONDS", DEFAULT_APPROVAL_TTL_SECONDS, 30, 86_400) * 1000,
    control: { keys, freshnessSeconds: whole(env, "KJ_CONTROL_FRESHNESS_SECONDS", DEFAULT_FRESHNESS_SECONDS, 30, 3600) },
  };
}

/** The one rule: `uppercase` for the door's principal in the door's tenant needs that principal's approval. */
export function approvalPolicyRules(config: ApprovalBoundaryConfig): PolicyRules {
  return PolicyRules.parse({
    version: APPROVAL_POLICY_VERSION,
    rules: [
      {
        tenantId: config.tenantId,
        principalId: config.principalId,
        capability: UPPERCASE,
        effect: "APPROVAL_REQUIRED",
        approver: { id: config.principalId, kind: "HUMAN" },
        ttlMs: config.ttlMs,
      },
    ],
  });
}

/** The workflow's authenticator: verify the signed assertion against the request actually received. */
export function createControlAuthenticator(config: ApprovalBoundaryConfig, replay: ReplayStore): Authenticator {
  const verify = createControlVerifier({
    keys: config.control.keys,
    tenantId: config.tenantId,
    principalId: config.principalId,
    freshnessSeconds: config.control.freshnessSeconds,
    replay,
  });
  return (headers, request) => verify(headers, request);
}

/** The golden workflow, wired to the production boundary. Undefined unless KJ_APPROVAL_ENABLED=true. */
export function productionApprovalWorkflow(ledger: Ledger, env: NodeJS.ProcessEnv) {
  const config = loadApprovalBoundaryConfig(env);
  if (!config) return undefined;
  return createGoldenWorkflow(ledger, approvalPolicyRules(config), createControlAuthenticator(config, new PgControlReplayStore(ledger.pool)));
}
