import { createHash, timingSafeEqual } from "node:crypto";
import { UPPERCASE } from "../../../packages/capabilities/src/index.js";
import { PrincipalRef } from "../../../packages/contracts/src/index.js";
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
 *  2. The authenticator: the door forwards `Authorization: Bearer <KJ_CONTROL_TOKEN>` on the internal
 *     hop to the workflow; the worker compares it in constant time and, on a match, names the door's
 *     principal. Any other or missing credential is refused. The token is a separate secret from the
 *     admission bearer, so a leak of one does not open the other. The identity is fixed by
 *     configuration, never read from the request.
 *
 * Fail closed and secret-safe, in the same style as the canary, admission, mission and Telegram seams:
 * unset serves no approval workflow (the worker's existing behaviour), and a partial or ambiguous
 * configuration stops the worker at startup naming only the variable, never a value.
 *
 *   KJ_APPROVAL_ENABLED       "true" turns it on; unset, empty or "false" leaves it off
 *   KJ_ADMISSION_TENANT_ID    the door's tenant (non-secret; the same value the door already has)
 *   KJ_ADMISSION_PRINCIPAL_ID the door's principal, who is also the named approver (non-secret)
 *   KJ_CONTROL_TOKEN          secret, at least 32 characters; the door holds the same value
 *   KJ_APPROVAL_TTL_SECONDS   optional, 30 to 86400, default 600
 */
export const APPROVAL_POLICY_VERSION = "kj-approval-policy/1";
export const DEFAULT_APPROVAL_TTL_SECONDS = 600;
export const MIN_CONTROL_TOKEN_LENGTH = 32;

export interface ApprovalBoundaryConfig {
  tenantId: string;
  principalId: string;
  /** SENSITIVE: never logged, never returned to a printer. */
  token: string;
  ttlMs: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function loadApprovalBoundaryConfig(env: NodeJS.ProcessEnv): ApprovalBoundaryConfig | undefined {
  const flag = env["KJ_APPROVAL_ENABLED"];
  if (flag === undefined || flag === "" || flag === "false") return undefined;
  if (flag !== "true") throw new Error('KJ_APPROVAL_ENABLED must be exactly "true" or "false" when set - refusing to guess');

  const tenantId = env["KJ_ADMISSION_TENANT_ID"];
  const principalId = env["KJ_ADMISSION_PRINCIPAL_ID"];
  const token = env["KJ_CONTROL_TOKEN"];
  const missing = [
    ["KJ_ADMISSION_TENANT_ID", tenantId],
    ["KJ_ADMISSION_PRINCIPAL_ID", principalId],
    ["KJ_CONTROL_TOKEN", token],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0)
    throw new Error(`KJ_APPROVAL_ENABLED=true requires ${missing.join(", ")} - refusing to start half-configured`);
  if (!UUID.test(tenantId!) || !UUID.test(principalId!))
    throw new Error("KJ_ADMISSION_TENANT_ID and KJ_ADMISSION_PRINCIPAL_ID must be UUIDs");
  if (token!.length < MIN_CONTROL_TOKEN_LENGTH)
    throw new Error(`KJ_CONTROL_TOKEN must be at least ${MIN_CONTROL_TOKEN_LENGTH} characters`);

  const rawTtl = env["KJ_APPROVAL_TTL_SECONDS"];
  const seconds = rawTtl === undefined || rawTtl === "" ? DEFAULT_APPROVAL_TTL_SECONDS : Number(rawTtl);
  if (
    !(rawTtl === undefined || rawTtl === "" || /^[0-9]{1,5}$/.test(rawTtl)) ||
    !Number.isInteger(seconds) ||
    seconds < 30 ||
    seconds > 86_400
  )
    throw new Error("KJ_APPROVAL_TTL_SECONDS must be a whole number from 30 to 86400");

  return { tenantId: tenantId!, principalId: principalId!, token: token!, ttlMs: seconds * 1000 };
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

const sha256 = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

/**
 * Constant-time over SHA-256 digests (no length or early-exit leak). One token, one fixed identity.
 * The workflow wraps any throw as 401 "Unauthenticated", so nothing here needs to describe why.
 */
export function createControlTokenAuthenticator(config: Pick<ApprovalBoundaryConfig, "token" | "principalId">): Authenticator {
  const expected = sha256(config.token);
  const principal = PrincipalRef.parse({ id: config.principalId, kind: "HUMAN" });
  return async (headers) => {
    const header = headers.get("authorization");
    const match = typeof header === "string" ? /^Bearer (.+)$/.exec(header) : null;
    if (!match) throw new Error("unauthenticated");
    const got = sha256(match[1]!);
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new Error("unauthenticated");
    return principal;
  };
}

/** The golden workflow, wired to the production boundary. Undefined unless KJ_APPROVAL_ENABLED=true. */
export function productionApprovalWorkflow(ledger: Ledger, env: NodeJS.ProcessEnv) {
  const config = loadApprovalBoundaryConfig(env);
  if (!config) return undefined;
  return createGoldenWorkflow(ledger, approvalPolicyRules(config), createControlTokenAuthenticator(config));
}
