import { randomUUID } from "node:crypto";
import type pg from "pg";
import { ApprovalAnswer, ControlResult, Id, Task, ExecutionTarget, type ExecutionBinding, type TenantContext, type ControlAction } from "../../../packages/contracts/src/index.js";
import { withTenant } from "../../../packages/identity/src/index.js";
import { readBinding, workflowTargets } from "../../../services/kernel/src/execution-binding.js";
import { Signal } from "../../../services/kernel/src/deterministic.js";
import type { ControlPort } from "../../mission-control/src/server.js";
export interface ControlOptions {
 pool: pg.Pool;
 targets?: ExecutionTarget[];
 fetch?: typeof globalThis.fetch;
 endpointFor?: (binding:ExecutionBinding)=>string;
}
/** Internal endpoints and targets are deployment-owned, never selected by request JSON. */
export function createRestateControls(ingress:string,credentialsFor:(context:TenantContext)=>Promise<Record<string,string>>,options:ControlOptions):ControlPort {
 const base=new URL(ingress);if(!['http:','https:'].includes(base.protocol))throw new Error('Invalid Restate URL');
 const targets=(options.targets??Object.values(workflowTargets)).map(t=>ExecutionTarget.parse(t));
 const send=async(context:TenantContext,taskId:string,action:ControlAction,body:unknown):Promise<ControlResult>=>{
  Id.parse(taskId);
  return withTenant(options.pool,context,async(db,ctx)=>{
   const rows=await db.query<{contract:unknown}>('select contract from tasks where id=$1 and tenant_id=$2',[taskId,ctx.tenantId]);
   if(!rows.rows[0])throw new Error('Task not found');
   const task=Task.parse(rows.rows[0].contract),binding=await readBinding(db,taskId);
   if(action!=='approve' && task.principal.id!==ctx.principal.id)throw new Error('Tenant access denied');
   const result=(status:ControlResult['status'])=>ControlResult.parse({taskId,action,status});
   if(!binding||binding.tenantId!==ctx.tenantId||binding.principal.id!==task.principal.id||!binding.controls.includes(action)||!targets.some(t=>t.service===binding.service&&t.version===binding.version&&t.routingId===binding.routingId&&t.controls.includes(action)))return result('UNSUPPORTED');
   if(action==='cancel'&&task.status==='CANCELLED')return result('COMPLETED');
   if(['COMPLETED','FAILED','CANCELLED'].includes(task.status))return result('UNSUPPORTED');
   if(action==='approve'){
    const answer=ApprovalAnswer.parse(body);
    const tickets=await db.query<{requested_from:string;payload:{evaluation:{scopeDigest:string;expiresAt:string}}}>("select a.requested_from,e.payload from approvals a join task_events e on e.task_id=a.task_id and e.event_key='policy-approval:'||a.id::text where a.task_id=$1 and a.status='PENDING'",[taskId]);
    const ticket=tickets.rows[0];
    if(!ticket||ticket.requested_from!==ctx.principal.id||ticket.payload.evaluation.scopeDigest!==answer.scopeDigest||Date.parse(ticket.payload.evaluation.expiresAt)<=Date.now())throw new Error('Tenant access denied');
   }
   if((binding.service==='GoldenTaskWorkflowV1'||binding.service==='PolicyCapabilityWorkflowV1'||binding.service==='AutonomousChildTaskWorkflowV1')&&action==='cancel'&&task.status!=='APPROVAL_REQUIRED')return result('UNSUPPORTED');
   if(action==='signal' && task.status!=='WAITING')return result('UNSUPPORTED');
   const record=async(value:ControlResult)=>{await db.query('insert into kernel_private.control_events(id,task_id,principal_id,contract) values($1,$2,$3,$4)',[randomUUID(),taskId,ctx.principal.id,value]);return value;};
   await record(result('REQUESTED'));
   let value:ControlResult;
   try {
    const endpoint=new URL(options.endpointFor?options.endpointFor(binding):base);
    if(!['http:','https:'].includes(endpoint.protocol))throw new Error('Invalid deployment endpoint');
    const response=await (options.fetch??fetch)(new URL(`/${binding.service}/${binding.executionKey}/${action}`,endpoint),{method:'POST',headers:{...(await credentialsFor(ctx)),'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
    value=result(response.ok?'ACCEPTED':response.status>=500?'UNRESOLVED':'FAILED');
    if(response.ok && (binding.service==='TaskWorkflow'||binding.service==='KernelWorkflowV1')) {
     const answer=await response.json().catch(()=>null) as {decision?:{action?:string}}|null;
     const requested=action==='cancel'?'CANCEL':Signal.parse(body).action;
     if(answer?.decision?.action && answer.decision.action!==requested)value=result('FAILED');
    }
   } catch {value=result('UNRESOLVED');}
   if(action==='cancel'&&value.status==='ACCEPTED'){
    const current=await db.query<{status:string}>('select status from tasks where id=$1',[taskId]);if(current.rows[0]?.status==='CANCELLED')value=result('COMPLETED');else if(['COMPLETED','FAILED'].includes(current.rows[0]?.status??''))value=result('FAILED');
   }
   return record(value);
  },action);
 };
 return {approve:(ctx,id,answer)=>send(ctx,id,'approve',ApprovalAnswer.parse(answer)),cancel:(ctx,id)=>send(ctx,id,'cancel',{}),signal:(ctx,id,signal)=>send(ctx,id,'signal',Signal.parse(signal))};
}
