import { beforeAll,afterAll,it,expect } from "vitest";
import { randomUUID } from "node:crypto";
import { knowledgeDatabase } from "./support/knowledge-db.js";
import { createRestateControls } from "../apps/gateway/src/index.js";
import { bindingFor,persistBinding,workflowTargets } from "../services/kernel/src/execution-binding.js";
import { Task } from "../packages/contracts/src/index.js";
let fixture:Awaited<ReturnType<typeof knowledgeDatabase>>;
beforeAll(async()=>{fixture=await knowledgeDatabase();});afterAll(async()=>{await fixture?.close();});
async function seed(name:keyof typeof workflowTargets){
 const initial=Task.parse({...fixture.task,id:randomUUID(),status:'RECEIVED'});
 const status=['TaskWorkflow','KernelWorkflowV1','BoundedScheduleWorkflowV1'].includes(name)?'WAITING':'APPROVAL_REQUIRED';
 const task=Task.parse({...initial,status});
 const db=await fixture.pool.connect();try{await persistBinding(db,bindingFor(initial,workflowTargets[name],'test-release'));}finally{db.release();}
 await fixture.pool.query("insert into tasks(id,tenant_id,principal_id,trace_id,status,contract,created_at) values($1,$2,$3,$4,$5,$6,$7)",[task.id,task.tenant.id,task.principal.id,task.traceId,task.status,task,task.createdAt]);return task;
}
it.each(Object.keys(workflowTargets) as (keyof typeof workflowTargets)[])("routes cancellation through persisted %s identity",async(name)=>{
 const task=await seed(name);const paths:string[]=[];
 const controls=createRestateControls('http://private.test',async()=>({}),{pool:fixture.pool,fetch:async(input)=>{paths.push(String(input));return new Response('{}');}});
 expect((await controls.cancel(fixture.context,task.id))?.status).toBe('ACCEPTED');
 expect(paths).toEqual([`http://private.test/${name}/${task.id}/cancel`]);
 expect((await fixture.pool.query("select contract->>'status' as status from kernel_private.control_events where task_id=$1 order by occurred_at",[task.id])).rows.map(r=>r.status)).toEqual(['REQUESTED','ACCEPTED']);
});
it("signals only supported bindings and never guesses a legacy task target",async()=>{
 const task=await seed('KernelWorkflowV1');let count=0;
 const controls=createRestateControls('http://private.test',async()=>({}),{pool:fixture.pool,fetch:async()=>{count++;return new Response('{}');}});
 expect((await controls.signal!(fixture.context,task.id,{action:'RESUME'}))?.status).toBe('ACCEPTED');
 const schedule=await seed('BoundedScheduleWorkflowV1');expect((await controls.signal!(fixture.context,schedule.id,{action:'RESUME'}))?.status).toBe('UNSUPPORTED');
 expect((await controls.cancel(fixture.context,fixture.task.id))?.status).toBe('UNSUPPORTED');expect(count).toBe(1);
});
it("keeps transport uncertainty distinct from failed and completed cancellation",async()=>{
 const task=await seed('TaskWorkflow');
 for(const [status,transport] of [ ['UNRESOLVED',async()=>{throw new Error('timeout');}],['FAILED',async()=>new Response('{}',{status:403})] ] as const){
  const c=createRestateControls('http://private.test',async()=>({}),{pool:fixture.pool,fetch:transport});expect((await c.cancel(fixture.context,task.id))?.status).toBe(status);
 }
 await fixture.pool.query("update tasks set status='CANCELLED',contract=jsonb_set(contract,'{status}','\"CANCELLED\"') where id=$1",[task.id]);
 const c=createRestateControls('http://private.test',async()=>({}),{pool:fixture.pool,fetch:async()=>{throw new Error('must not call');}});
 expect((await c.cancel(fixture.context,task.id))?.status).toBe('COMPLETED');
});
it.each(['REVOKED','REMOVED'] as const)("rejects %s controls before transport",async(status)=>{
 const task=await seed('TaskWorkflow');let count=0;
 const c=createRestateControls('http://private.test',async()=>({}),{pool:fixture.pool,fetch:async()=>{count++;return new Response('{}');}});
 await fixture.pool.query('update tenant_memberships set status=$1 where principal_id=$2',[status,fixture.context.principal.id]);
 try{await expect(c.cancel(fixture.context,task.id)).rejects.toThrow();await expect(c.signal!(fixture.context,task.id,{action:'RESUME'})).rejects.toThrow();}finally{await fixture.pool.query("update tenant_memberships set status='ACTIVE' where principal_id=$1",[fixture.context.principal.id]);}
 expect(count).toBe(0);
});

it('does not report cancellation accepted when a previous RESUME decision won',async()=>{
 const task=await seed('TaskWorkflow');
 const controls=createRestateControls('http://private.test',async()=>({}),{pool:fixture.pool,fetch:async()=>new Response(JSON.stringify({decision:{action:'RESUME'}}))});
 expect((await controls.cancel(fixture.context,task.id))?.status).toBe('FAILED');
});

it('rejects cancellation during golden verification without claiming acceptance',async()=>{
 const task=await seed('GoldenTaskWorkflowV1');
 await fixture.pool.query("update tasks set status='RUNNING',contract=jsonb_set(contract,'{status}','\"RUNNING\"') where id=$1",[task.id]);
 await fixture.pool.query("update tasks set status='VERIFYING',contract=jsonb_set(contract,'{status}','\"VERIFYING\"') where id=$1",[task.id]);
 let calls=0;const controls=createRestateControls('http://private.test',async()=>({}),{pool:fixture.pool,fetch:async()=>{calls++;return new Response('{}');}});
 expect((await controls.cancel(fixture.context,task.id))?.status).toBe('UNSUPPORTED');expect(calls).toBe(0);
});

it('requires an explicitly supported historical version and routes through trusted deployment configuration',async()=>{
 const initial=Task.parse({...fixture.task,id:randomUUID(),status:'RECEIVED'});
 const target={...workflowTargets.TaskWorkflow,version:'2'};
 const db=await fixture.pool.connect();try{await persistBinding(db,bindingFor(initial,target,'release-two'));}finally{db.release();}
 const task=Task.parse({...initial,status:'WAITING'});
 await fixture.pool.query('insert into tasks(id,tenant_id,principal_id,trace_id,status,contract,created_at) values($1,$2,$3,$4,$5,$6,$7)',[task.id,task.tenant.id,task.principal.id,task.traceId,task.status,task,task.createdAt]);
 let path='';const transport:typeof fetch=async input=>{path=String(input);return new Response('{}');};
 const unsupported=createRestateControls('http://private.test',async()=>({}),{pool:fixture.pool,fetch:transport});
 expect((await unsupported.cancel(fixture.context,task.id))?.status).toBe('UNSUPPORTED');expect(path).toBe('');
 const supported=createRestateControls('http://private.test',async()=>({}),{pool:fixture.pool,targets:[target],endpointFor:b=>`http://${b.releaseId}.private.test`,fetch:transport});
 expect((await supported.cancel(fixture.context,task.id))?.status).toBe('ACCEPTED');expect(path).toBe(`http://release-two.private.test/TaskWorkflow/${task.id}/cancel`);
});
