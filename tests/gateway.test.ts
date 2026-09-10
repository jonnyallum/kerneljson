import {beforeAll,afterAll,it,expect} from 'vitest';
import {createServer,type Server} from 'node:http';
import {randomUUID} from 'node:crypto';
import {knowledgeDatabase} from './support/knowledge-db.js';
import {createGateway,bearerAuthenticator} from '../apps/gateway/src/server.js';
import {createRestateControls} from '../apps/gateway/src/index.js';
import {createMissionControl} from '../apps/mission-control/src/server.js';
import {MissionControlStore} from '../apps/mission-control/src/store.js';
import type {TenantContext} from '../packages/contracts/src/index.js';
let fixture:Awaited<ReturnType<typeof knowledgeDatabase>>,server:Server,mission:Server,url:string,missionUrl:string;
let foreign:TenantContext,reader:TenantContext;
let dispatches=0,mode:'ACCEPTED'|'UNRESOLVED'='ACCEPTED',admit=true;
const input={recipe:'uppercase/v1',objective:'gateway qualification'};
const headers=(token='owner')=>({authorization:`Bearer ${token}`,'content-type':'application/json'});
async function post(path:string,body:unknown,token='owner',key=randomUUID()){
 return fetch(url+path,{method:'POST',headers:{...headers(token),'idempotency-key':key},body:JSON.stringify(body)});
}
beforeAll(async()=>{
 fixture=await knowledgeDatabase();foreign={...fixture.context,tenantId:randomUUID()};reader={...fixture.context,principal:{id:randomUUID(),kind:'HUMAN'}};
 await fixture.pool.query("insert into tenants(id,name) values($1,'foreign')",[foreign.tenantId]);
 await fixture.pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'owner')",[foreign.tenantId,foreign.principal.id]);
 await fixture.pool.query("insert into principals(id,kind) values($1,'HUMAN')",[reader.principal.id]);
 await fixture.pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'reader')",[reader.tenantId,reader.principal.id]);
 const authenticate=bearerAuthenticator(async token=>token==='owner'?fixture.context:token==='foreign'?foreign:token==='reader'?reader:null);
 const controls=createRestateControls('http://not-called.invalid',async()=>({}),{pool:fixture.pool,fetch:async()=>{throw new Error('unexpected transport');}});
 const handler=createGateway({pool:fixture.pool,releaseId:'test-release',authenticate,admit:async()=>admit,controls,dispatch:async()=>{dispatches++;return {status:mode};}});
 server=createServer((req,res)=>{void handler(req,res);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();if(!a||typeof a==='string')throw Error();url=`http://127.0.0.1:${a.port}`;
 let mh:ReturnType<typeof createMissionControl>;mission=createServer((req,res)=>{void mh(req,res);});await new Promise<void>(r=>mission.listen(0,'127.0.0.1',r));const b=mission.address();if(!b||typeof b==='string')throw Error();missionUrl=`http://127.0.0.1:${b.port}`;
 mh=createMissionControl({store:new MissionControlStore(fixture.pool),origin:missionUrl,authenticate,controls});
});
afterAll(async()=>{await Promise.all([server,mission].filter(Boolean).map(s=>new Promise<void>((r,j)=>s.close(e=>e?j(e):r()))));await fixture?.close();});
it('authenticates outside the body and persists stable admission across concurrent equivalent retries',async()=>{
 const key=randomUUID();const responses=await Promise.all(Array.from({length:5},()=>post('/v1/tasks',input,'owner',key)));
 expect(responses.every(r=>r.status===202)).toBe(true);const results=await Promise.all(responses.map(r=>r.json()));const id=results[0].taskId;expect(new Set(results.map(r=>r.taskId)).size).toBe(1);
 const response=await fetch(url+`/v1/tasks/${id}`,{headers:headers()});expect(response.status).toBe(200);expect((await response.json()).status).toBe('RECEIVED');
 expect((await fixture.pool.query('select 1 from kernel_private.task_admissions where task_id=$1',[id])).rowCount).toBe(1);
 expect((await post('/v1/tasks',{...input,objective:'changed'},'owner',key)).status).toBe(409);
 const foreignResponse=await post('/v1/tasks',input,'foreign',key);expect((await foreignResponse.json()).taskId).not.toBe(id);
});
it('keeps dispatch uncertainty durable and retries the same task identity',async()=>{
 const key=randomUUID();mode='UNRESOLVED';const first=await (await post('/v1/tasks',input,'owner',key)).json();expect(first.dispatch).toBe('UNRESOLVED');
 const state=await (await fetch(url+`/v1/tasks/${first.taskId}`,{headers:headers()})).json();expect(state.dispatch).toBe('UNRESOLVED');expect(state.status).toBe('RECEIVED');expect(state.outcome).toBeNull();
 mode='ACCEPTED';expect((await (await post('/v1/tasks',input,'owner',key)).json()).taskId).toBe(first.taskId);
});
it.each([{principal:{id:'fake'}},{tenant:{id:'fake'}},{workflow:'TaskWorkflow'},{service:'Admin'},{releaseId:'forged'},{routingId:'admin'}])('rejects authority and workflow injection %j',async(extra)=>{
 const before=dispatches;expect((await post('/v1/tasks',{...input,...extra})).status).toBe(400);expect(dispatches).toBe(before);
});
it('enforces authentication, role, admission, content size and idempotency header',async()=>{
 const before=dispatches;
 expect((await post('/v1/tasks',input,'unknown')).status).toBe(401);
 expect((await post('/v1/tasks',input,'reader')).status).toBe(403);
 admit=false;expect((await post('/v1/tasks',input)).status).toBe(429);admit=true;
 expect((await post('/v1/tasks',{...input,objective:'x'.repeat(18000)})).status).toBe(413);
 expect((await fetch(url+'/v1/tasks',{method:'POST',headers:headers(),body:JSON.stringify(input)})).status).toBe(400);
 expect(dispatches).toBe(before);
});
it.each(['','/history','/evidence','/outcome'])('isolates cross-tenant task read %s',async(suffix)=>{
 expect((await fetch(url+`/v1/tasks/${fixture.task.id}${suffix}`,{headers:headers('foreign')})).status).toBe(404);
 expect((await fetch(url+`/v1/tasks/${fixture.task.id}${suffix}`,{headers:headers()})).status).toBe(200);
});
it.each(['REVOKED','REMOVED'] as const)('denies %s HTTP and Mission Control operations while preserving records',async(status)=>{
 await fixture.pool.query('update tenant_memberships set status=$1 where tenant_id=$2 and principal_id=$3',[status,fixture.context.tenantId,fixture.context.principal.id]);
 try{
  expect((await post('/v1/tasks',input)).status).toBe(403);
  for(const suffix of ['','/history','/evidence','/outcome'])expect((await fetch(url+`/v1/tasks/${fixture.task.id}${suffix}`,{headers:headers()})).status).toBe(403);
  for(const action of ['cancel','signal','approve'])expect((await post(`/v1/tasks/${fixture.task.id}/${action}`,{})).status).toBe(403);
  expect((await fetch(url+'/v1/memory?text=test&at=2026-09-09T00%3A00%3A00.000Z',{headers:headers()})).status).toBe(403);
  expect((await fetch(url+`/v1/world?entityId=${randomUUID()}&at=2026-09-09T00%3A00%3A00.000Z`,{headers:headers()})).status).toBe(403);
  expect((await fetch(missionUrl,{headers:headers()})).status).toBe(403);
  expect((await fetch(missionUrl+`/tasks/${fixture.task.id}/cancel`,{method:'POST',headers:{...headers(),origin:missionUrl},body:'{}'})).status).toBe(403);
 }finally{await fixture.pool.query("update tenant_memberships set status='ACTIVE' where tenant_id=$1 and principal_id=$2",[fixture.context.tenantId,fixture.context.principal.id]);}
 expect((await fixture.pool.query('select 1 from tasks where id=$1',[fixture.task.id])).rowCount).toBe(1);
});

it('admits estate-email-triage/v1 without dispatch and replays by Idempotency-Key',async()=>{
 const before=dispatches;const key=randomUUID();
 const emailInput={recipe:'estate-email-triage/v1',objective:'Email triage: KERNELJSON EMAIL AUTHORITY CANARY REAL ADMISSION'};
 const first=await post('/v1/tasks',emailInput,'owner',key);expect(first.status).toBe(202);
 const body=await first.json();expect(body.admission).toBe('ADMITTED');expect(body.dispatch).toBeNull();
 expect(body.taskId).toMatch(/^[0-9a-f-]{36}$/);expect(dispatches).toBe(before);
 expect((await fixture.pool.query('select 1 from kernel_private.task_admissions where task_id=$1',[body.taskId])).rowCount).toBe(1);
 expect((await fixture.pool.query('select 1 from kernel_private.dispatch_events where task_id=$1',[body.taskId])).rowCount).toBe(0);
 const second=await post('/v1/tasks',emailInput,'owner',key);expect(second.status).toBe(202);
 const replay=await second.json();expect(replay.admission).toBe('REPLAY');expect(replay.taskId).toBe(body.taskId);
 expect(replay.dispatch).toBeNull();expect(dispatches).toBe(before);
});
it('rejects unknown public recipes still',async()=>{
 const before=dispatches;expect((await post('/v1/tasks',{recipe:'shell/v1',objective:'nope'})).status).toBe(400);expect(dispatches).toBe(before);
});
