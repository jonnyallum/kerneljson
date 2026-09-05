import type pg from "pg";
import { TenantContext } from "../../contracts/src/index.js";
/** Context must come from a trusted authenticator, never request JSON or model output. */
export async function withTenant<T>(
  pool: pg.Pool,
  raw: TenantContext,
  action: (db: pg.PoolClient, context: TenantContext) => Promise<T>,
): Promise<T> {
  const context = TenantContext.parse(raw),
    db = await pool.connect();
  try {
    await db.query("begin");
    const membership = await db.query(
      "select 1 from tenant_memberships m join principals p on p.id=m.principal_id where m.tenant_id=$1 and p.id=$2 and p.kind=$3 for share of m,p",
      [context.tenantId, context.principal.id, context.principal.kind],
    );
    if (membership.rowCount !== 1) throw new Error("Tenant access denied");
    const result = await action(db, context);
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}
