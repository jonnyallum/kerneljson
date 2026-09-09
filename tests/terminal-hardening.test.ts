import { beforeAll,afterAll,it,expect } from "vitest";
import { randomUUID } from "node:crypto";
import { knowledgeDatabase } from "./support/knowledge-db.js";
import { Ledger } from "../services/kernel/src/ledger.js";
import { VerificationStore } from "../services/kernel/src/verification-store.js";
import { readOutcome,recordEffect,assertResolvedEffects } from "../services/kernel/src/terminal.js";
import { verificationFixture } from "../evals/fixtures/verification.js";
import { verifyTaskEvidence } from "../services/kernel/src/verification.js";
import { Task,TaskStep, Evidence } from "../packages/contracts/src/index.js";
let fixture:Awaited<ReturnType<typeof knowledgeDatabase>>;
beforeAll(async()=>{fixture=await knowledgeDatabase();});afterAll(async()=>{await fixture?.close();});
it.each(["FAILED","CANCELLED"] as const)("keeps durable %s result when a legacy workflow emits no Outcome",async(status)=>{
 const ledger=new Ledger(fixture.pool).forWorkflow("TaskWorkflow");
 const task=Task.parse({...fixture.task,id:randomUUID(),status:"RECEIVED"});
 const event={id:randomUUID(),taskId:task.id,type:"TASK_CREATED" as const,actor:task.principal,traceId:task.traceId,occurredAt:task.createdAt,payload:{}};
 await ledger.write({key:"create",task,event});
 const terminal={key:"stop",task:{...task,status},event:{...event,id:randomUUID(),type:status==='FAILED'?'TASK_FAILED' as const:'TASK_CANCELLED' as const}};
 await ledger.write(terminal);await ledger.write(terminal);
 expect((await readOutcome(fixture.pool,task.id))?.status).toBe(status);
 expect((await fixture.pool.query("select 1 from outcomes where task_id=$1",[task.id])).rowCount).toBe(0);
 await expect(fixture.pool.query("delete from kernel_private.terminal_results where task_id=$1",[task.id])).rejects.toThrow();
});
it.each(['stale','future','foreign-step','altered-digest'] as const)("rejects %s evidence",(change)=>{
 const bundle=verificationFixture(), task=Task.parse(bundle.task), e=Evidence.parse(bundle.evidence[0]);
 bundle.evidence=[{...e,...(change==='stale'?{capturedAt:'2000-01-01T00:00:00.000Z'}:change==='future'?{capturedAt:'2099-01-01T00:00:00.000Z'}:change==='foreign-step'?{stepId:randomUUID()}:{digest:'0'.repeat(64)})}];
 expect(verifyTaskEvidence(bundle,task.createdAt).status).toBe('FAILED');
});
it("keeps ambiguous effects unresolved, binds confirmation evidence, and deduplicates receipts",async()=>{
 const task=Task.parse({...fixture.task,id:randomUUID(),status:'VERIFYING'});
 await fixture.pool.query("insert into tasks(id,tenant_id,principal_id,trace_id,status,contract,created_at) values($1,$2,$3,$4,'VERIFYING',$5,$6)",[task.id,task.tenant.id,task.principal.id,task.traceId,task,task.createdAt]);
 const step=TaskStep.parse({...TaskStep.parse(verificationFixture().steps[0]),id:randomUUID(),taskId:task.id});
 await fixture.pool.query("insert into task_steps(id,task_id,status,contract) values($1,$2,$3,$4)",[step.id,task.id,step.status,step]);
 const op=randomUUID();await recordEffect(fixture.pool,task.id,step.id,op);await recordEffect(fixture.pool,task.id,step.id,op);
 await expect(assertResolvedEffects(fixture.pool,task.id)).rejects.toThrow('UNRESOLVED');
 await expect(new VerificationStore(fixture.pool).finish(task.id,{eventId:randomUUID(),verificationEventId:randomUUID(),at:new Date().toISOString()})).rejects.toThrow('UNRESOLVED');
 expect(await readOutcome(fixture.pool,task.id)).toBeNull();
 await expect(recordEffect(fixture.pool,task.id,step.id,op,fixture.evidence.id)).rejects.toThrow('scope mismatch');
 const id=randomUUID();await fixture.pool.query("insert into evidence(id,task_id,step_id,type,source,digest,captured_at,metadata) values($1,$2,$3,'DETERMINISTIC_RESULT','test',$4,$5,'{}')",[id,task.id,step.id,'a'.repeat(64),task.createdAt]);
 await recordEffect(fixture.pool,task.id,step.id,op,id);await recordEffect(fixture.pool,task.id,step.id,op,id);
 await expect(assertResolvedEffects(fixture.pool,task.id)).resolves.toBeUndefined();
 expect((await fixture.pool.query("select 1 from kernel_private.effect_receipts where task_id=$1",[task.id])).rowCount).toBe(2);
 // Confirmation of an interaction alone cannot produce a completed task.
 expect((await fixture.pool.query("select status from tasks where id=$1",[task.id])).rows[0].status).toBe('VERIFYING');
});

it('keeps an unclassified database disconnect retryable instead of manufacturing a failed outcome',async()=>{
 const task=Task.parse({...fixture.task,id:randomUUID(),status:'VERIFYING'});
 await fixture.pool.query("insert into tasks(id,tenant_id,principal_id,trace_id,status,contract,created_at) values($1,$2,$3,$4,'VERIFYING',$5,$6)",[task.id,task.tenant.id,task.principal.id,task.traceId,task,task.createdAt]);
 const failingPool=new Proxy(fixture.pool,{get(target,property){
  if(property==='connect')return async()=>{const client=await target.connect();return new Proxy(client,{get(db,key){
   if(key==='query')return (sql:string,...args:unknown[])=>sql.includes('from public.evidence')?Promise.reject(new Error('Connection terminated unexpectedly')):Reflect.apply(db.query,db,[sql,...args]);
   const value=Reflect.get(db,key) as unknown;return typeof value==='function'?value.bind(db):value;
  }});};
  const value=Reflect.get(target,property) as unknown;return typeof value==='function'?value.bind(target):value;
 }});
 const at=new Date().toISOString(),evidenceId=randomUUID();
 await expect(new Ledger(failingPool).finish({key:'complete',task:{...task,status:'COMPLETED',completedAt:at},outcome:{taskId:task.id,status:'COMPLETED',acceptanceResults:task.acceptanceCriteria.map(criterion=>({criterion,passed:true,evidenceRefs:[evidenceId]})),evidenceRefs:[evidenceId],summary:'not trusted',completedAt:at},event:{id:randomUUID(),taskId:task.id,type:'TASK_COMPLETED',occurredAt:at,traceId:task.traceId,actor:task.principal,payload:{}}})).rejects.toThrow('Connection terminated unexpectedly');
 expect(await readOutcome(fixture.pool,task.id)).toBeNull();expect((await fixture.pool.query('select status from tasks where id=$1',[task.id])).rows[0].status).toBe('VERIFYING');
});
