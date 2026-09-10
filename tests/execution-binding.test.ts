import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { knowledgeDatabase } from "./support/knowledge-db.js";
import { bindingFor, persistBinding, readBinding, workflowTargets } from "../services/kernel/src/execution-binding.js";
import { Ledger } from "../services/kernel/src/ledger.js";
import { ExecutionBinding, Task, TaskEvent } from "../packages/contracts/src/index.js";
let fixture: Awaited<ReturnType<typeof knowledgeDatabase>>;
beforeAll(async()=>{fixture=await knowledgeDatabase();});
afterAll(async()=>{await fixture?.close();});
it("reads historical tasks without guessing an execution binding",async()=>{
 expect(await readBinding(fixture.pool,fixture.task.id)).toBeNull();
 expect(await new Ledger(fixture.pool).status(fixture.task.id)).not.toBeNull();
});
it.each(Object.keys(workflowTargets) as (keyof typeof workflowTargets)[])("persists trusted %s binding atomically with creation",async(name)=>{
 const task=Task.parse({...fixture.task,id:randomUUID(),status:"RECEIVED"});
 const event=TaskEvent.parse({id:randomUUID(),taskId:task.id,type:"TASK_CREATED",occurredAt:task.createdAt,actor:task.principal,traceId:task.traceId,payload:{}});
 const ledger=new Ledger(fixture.pool).forWorkflow(name);
 await ledger.write({key:"create",task,event});await ledger.write({key:"create",task,event});
 const b=await readBinding(fixture.pool,task.id);
 expect(b?.service).toBe(name);expect(b?.executionKey).toBe(task.id);
 expect((await fixture.pool.query("select 1 from kernel_private.execution_bindings where task_id=$1",[task.id])).rowCount).toBe(1);
 await expect(fixture.pool.query("update kernel_private.execution_bindings set contract=contract where task_id=$1",[task.id])).rejects.toThrow();
});
it("keeps historical release identity and rejects incompatible family/version rebinding",async()=>{
 const task=Task.parse({...fixture.task,id:randomUUID(),status:"RECEIVED"});
 const b=bindingFor(task,workflowTargets.GoldenTaskWorkflowV1,"release-1");
 const db=await fixture.pool.connect();try {
  await persistBinding(db,b);
  expect((await persistBinding(db,{...b,releaseId:"release-2"})).releaseId).toBe("release-1");
  await expect(persistBinding(db,{...b,version:"2"})).rejects.toThrow("binding conflict");
 } finally {db.release();}
 expect(ExecutionBinding.safeParse({...b,service:"../admin"}).success).toBe(false);
 expect(ExecutionBinding.safeParse({...b,executionKey:randomUUID()}).success).toBe(false);
});

it('rejects a new task on the wrong release without destroying its reserved binding',async()=>{
 const task=Task.parse({...fixture.task,id:randomUUID(),status:'RECEIVED'});
 const db=await fixture.pool.connect();try{await persistBinding(db,bindingFor(task,workflowTargets.TaskWorkflow,'older-release'));}finally{db.release();}
 const event=TaskEvent.parse({id:randomUUID(),taskId:task.id,type:'TASK_CREATED',occurredAt:task.createdAt,actor:task.principal,traceId:task.traceId,payload:{}});
 await expect(new Ledger(fixture.pool,undefined,'TaskWorkflow','newer-release').write({key:'create',task,event})).rejects.toThrow('bound worker release');
 expect(await new Ledger(fixture.pool).status(task.id)).toBeNull();expect((await readBinding(fixture.pool,task.id))?.releaseId).toBe('older-release');
});
