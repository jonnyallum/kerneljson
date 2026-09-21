import type pg from "pg";
import type { TenantContext } from "../../../../packages/contracts/src/index.js";
import { PgPromotionApprovals } from "./approval-binding.js";
import { CanonicalMemory } from "./service.js";

/**
 * KJ-P5 - deployment configuration for canonical memory, in the same fail-closed style as the other seams: unset
 * serves no memory (missions run exactly as before, the Telegram memory commands answer "not switched on"), and a
 * partial or ambiguous configuration stops the worker at startup instead of serving something different.
 *
 *   KJ_MEMORY_ENABLED                 "true" turns memory on; unset, empty or "false" leaves it off
 *   KJ_MEMORY_APPROVER_ID             optional: the human who may approve protected promotions. Unset means protected
 *                                     promotions stay held candidates (nothing is promoted without an approver).
 *   KJ_MEMORY_APPROVAL_TTL_SECONDS    optional deadline for such an approval, 60 to 604800 (default 86400)
 *
 * The operator's identity is the door's own non-secret identity, KJ_ADMISSION_TENANT_ID and KJ_ADMISSION_PRINCIPAL_ID,
 * which are the tenant and principal every Telegram mission already runs as. No secret is read here.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DEFAULT_MEMORY_APPROVAL_TTL_SECONDS = 86_400;

export interface MemoryConfig {
  tenantId: string;
  principalId: string;
  approverId: string | null;
  approvalTtlSeconds: number;
}

export function loadMemoryConfig(env: NodeJS.ProcessEnv): MemoryConfig | undefined {
  const flag = env["KJ_MEMORY_ENABLED"];
  if (flag === undefined || flag === "" || flag === "false") return undefined;
  if (flag !== "true") throw new Error('KJ_MEMORY_ENABLED must be exactly "true" or "false" when set - refusing to guess');

  const tenantId = env["KJ_ADMISSION_TENANT_ID"];
  const principalId = env["KJ_ADMISSION_PRINCIPAL_ID"];
  const missing = [
    ["KJ_ADMISSION_TENANT_ID", tenantId],
    ["KJ_ADMISSION_PRINCIPAL_ID", principalId],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) throw new Error(`KJ_MEMORY_ENABLED=true requires ${missing.join(", ")} - refusing to start half-configured`);
  if (!UUID.test(tenantId!) || !UUID.test(principalId!)) throw new Error("KJ_ADMISSION_TENANT_ID and KJ_ADMISSION_PRINCIPAL_ID must be UUIDs");

  const approver = env["KJ_MEMORY_APPROVER_ID"] || undefined;
  if (approver !== undefined && !UUID.test(approver)) throw new Error("KJ_MEMORY_APPROVER_ID must be a UUID");

  const rawTtl = env["KJ_MEMORY_APPROVAL_TTL_SECONDS"];
  let ttl = DEFAULT_MEMORY_APPROVAL_TTL_SECONDS;
  if (rawTtl !== undefined && rawTtl !== "") {
    if (!/^[0-9]{2,6}$/.test(rawTtl)) throw new Error("KJ_MEMORY_APPROVAL_TTL_SECONDS must be a whole number of seconds");
    ttl = Number(rawTtl);
    if (ttl < 60 || ttl > 604_800) throw new Error("KJ_MEMORY_APPROVAL_TTL_SECONDS must be from 60 to 604800");
  }
  return { tenantId: tenantId!, principalId: principalId!, approverId: approver ?? null, approvalTtlSeconds: ttl };
}

/** The service and the operator's context, on a caller-owned pool. */
export function createConfiguredMemory(pool: pg.Pool, config: MemoryConfig): { memory: CanonicalMemory; context: TenantContext } {
  const approvals =
    config.approverId === null
      ? undefined
      : new PgPromotionApprovals(pool, { approver: { id: config.approverId, kind: "HUMAN" }, ttlMs: config.approvalTtlSeconds * 1000 });
  return {
    memory: new CanonicalMemory(pool, approvals ? { approvals } : {}),
    context: { tenantId: config.tenantId, principal: { id: config.principalId, kind: "HUMAN" } },
  };
}
