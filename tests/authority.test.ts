import {beforeAll,afterAll,it,expect} from "vitest";
import {randomUUID} from "node:crypto";
import {knowledgeDatabase} from "./support/knowledge-db.js";
import {authorize,withTenant,permissions} from "../packages/identity/src/index.js";
import {MissionControlStore} from "../apps/mission-control/src/store.js";
let fixture:Awaited<ReturnType<typeof knowledgeDatabase>>;
beforeAll(async()=>{fixture=await knowledgeDatabase();});afterAll(async()=>{await fixture?.close();});
it.each(['REVOKED','REMOVED'] as const)("%s denies every current permission and retains historical task attribution",async(status)=>{
 await fixture.pool.query("update tenant_memberships set status=$1 where tenant_id=$2 and principal_id=$3",[status,fixture.context.tenantId,fixture.context.principal.id]);
 try{
  for(const action of Object.keys(permissions) as (keyof typeof permissions)[])await expect(authorize(fixture.pool,fixture.context,action)).rejects.toThrow('Tenant access denied');
  await expect(new MissionControlStore(fixture.pool).task(fixture.context,fixture.task.id)).rejects.toThrow('Tenant access denied');
  expect((await fixture.pool.query("select contract from tasks where id=$1",[fixture.task.id])).rows[0].contract.principal).toEqual(fixture.context.principal);
  expect((await fixture.pool.query("select 1 from kernel_private.membership_events where principal_id=$1",[fixture.context.principal.id])).rowCount).toBeGreaterThan(0);
 }finally{await fixture.pool.query("update tenant_memberships set status='ACTIVE' where tenant_id=$1 and principal_id=$2",[fixture.context.tenantId,fixture.context.principal.id]);}
});
it("rejects principal kind forgery, foreign tenant and unknown roles",async()=>{
 await expect(authorize(fixture.pool,{...fixture.context,principal:{...fixture.context.principal,kind:'SERVICE'}})).rejects.toThrow();
 await expect(authorize(fixture.pool,{...fixture.context,tenantId:randomUUID()})).rejects.toThrow();
 await fixture.pool.query("update tenant_memberships set role='superadmin' where principal_id=$1",[fixture.context.principal.id]);
 try{await expect(authorize(fixture.pool,fixture.context,'submit')).rejects.toThrow();}finally{await fixture.pool.query("update tenant_memberships set role='owner' where principal_id=$1",[fixture.context.principal.id]);}
});
it("reader membership permits reads but cannot submit, signal, cancel, approve or schedule",async()=>{
 const id=randomUUID();await fixture.pool.query("insert into principals(id,kind) values($1,'HUMAN')",[id]);await fixture.pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'reader')",[fixture.context.tenantId,id]);
 const context={...fixture.context,principal:{id,kind:'HUMAN' as const}};
 await expect(withTenant(fixture.pool,context,async()=>true)).resolves.toBe(true);
 for(const action of ['submit','cancel','signal','approve','schedule'] as const)await expect(authorize(fixture.pool,context,action)).rejects.toThrow();
 await fixture.pool.query("delete from tenant_memberships where principal_id=$1",[id]);
 await expect(authorize(fixture.pool,context)).rejects.toThrow();
});
