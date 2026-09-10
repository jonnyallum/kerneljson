import type pg from "pg";
import { TenantContext } from "../../contracts/src/index.js";
export const permissions = {
 read: ["owner","operator","member","reviewer","reader"],
 submit: ["owner","operator","member"],
 cancel: ["owner","operator","member"],
 signal: ["owner","operator","member"],
 approve: ["owner","operator","reviewer"],
 schedule: ["owner","operator"],
 "knowledge-write": ["owner","operator","member"],
} as const;
export type Permission = keyof typeof permissions;
export async function authorize(db:Pick<pg.PoolClient,"query">, raw:TenantContext,action:Permission="read") {
 const context=TenantContext.parse(raw);
 const membership=await db.query<{role:string}>("select m.role from tenant_memberships m join principals p on p.id=m.principal_id where m.tenant_id=$1 and p.id=$2 and p.kind=$3 and m.status='ACTIVE' for share of m,p",[context.tenantId,context.principal.id,context.principal.kind]);
 const role=membership.rows[0]?.role;
 if(!role || !(permissions[action] as readonly string[]).includes(role) || ((action==='approve'||action==='schedule')&&context.principal.kind!=='HUMAN'))throw new Error("Tenant access denied");
 return context;
}
/** Caller identity must be established outside task/browser/model payloads. */
export async function withTenant<T>(pool:pg.Pool,raw:TenantContext,action:(db:pg.PoolClient,context:TenantContext)=>Promise<T>,permission:Permission="read"):Promise<T>{
 const db=await pool.connect();try{
  await db.query("begin");const context=await authorize(db,raw,permission);
  const result=await action(db,context);await db.query("commit");return result;
 }catch(error){await db.query("rollback");throw error;}finally{db.release();}
}
