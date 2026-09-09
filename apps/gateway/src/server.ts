import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { ApprovalAnswer, Id, KernelSubmission, Task, TenantContext, type ExecutionBinding } from "../../../packages/contracts/src/index.js";
import { withTenant } from "../../../packages/identity/src/index.js";
import { compileIntent, stableId } from "../../../services/kernel/src/compiler/index.js";
import { bindingFor,persistBinding,readBinding,workflowTargets } from "../../../services/kernel/src/execution-binding.js";
import { capabilityDigest } from "../../../packages/capabilities/src/index.js";
import { readOutcome,assertResolvedEffects,UnresolvedEffectError } from "../../../services/kernel/src/terminal.js";
import { MissionControlStore } from "../../mission-control/src/store.js";
import { MemoryStore } from "../../../services/memory/src/index.js";
import { WorldStore } from "../../../services/world-model/src/index.js";
import type { ControlPort } from "../../mission-control/src/server.js";
import { Signal } from "../../../services/kernel/src/deterministic.js";
export const ADMISSION_ONLY_RECIPES=new Set<string>(['estate-email-triage/v1']);
export const PublicSubmission=z.strictObject({recipe:z.enum(['uppercase/v1','uppercase-reverse/v1','estate-email-triage/v1']),objective:z.string().trim().min(1).max(8000)});
export type PublicSubmission=z.infer<typeof PublicSubmission>;
const Key=z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
export type Dispatch=(binding:ExecutionBinding,payload:KernelSubmission,context:TenantContext)=>Promise<{status:'ACCEPTED'|'UNRESOLVED';invocationId?:string}>;
class GatewayError extends Error {constructor(readonly status:number,readonly code:string){super(code);}}
/** Resolver must validate the credential with the deployment's identity authority. No default or body identity. */
export function bearerAuthenticator(resolve:(token:string)=>Promise<TenantContext|null>){
 return async(headers:IncomingHttpHeaders)=>{
  const value=headers.authorization;
  if(typeof value!=='string'||!/^Bearer [^\s]{1,4096}$/.test(value))throw new GatewayError(401,'UNAUTHENTICATED');
  const context=await resolve(value.slice(7));if(!context)throw new GatewayError(401,'UNAUTHENTICATED');return TenantContext.parse(context);
 };
}
export function createRestateDispatch(ingress:string,credentialsFor:(context:TenantContext)=>Promise<Record<string,string>>):Dispatch{
 const base=new URL(ingress);if(!['http:','https:'].includes(base.protocol))throw new Error('Invalid internal endpoint');
 return async(binding,payload,context)=>{
  const known=Object.values(workflowTargets).some(t=>t.service===binding.service&&t.version===binding.version&&t.routingId===binding.routingId);
  if(!known)throw new Error('Unsupported deployment binding');
  const response=await fetch(new URL(`/${binding.service}/${binding.executionKey}/run/send`,base),{method:'POST',headers:{...(await credentialsFor(context)),'content-type':'application/json'},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(15000)});
  const id=response.headers.get('x-restate-invocation-id');
  return {status:response.ok||response.status===409?'ACCEPTED':'UNRESOLVED',...(id&&/^[A-Za-z0-9_-]{1,160}$/.test(id)?{invocationId:id}:{})};
 };
}
export interface GatewayOptions {
 pool:pg.Pool;releaseId:string;
 authenticate:(headers:IncomingHttpHeaders)=>Promise<TenantContext>;
 admit:(context:TenantContext,operation:'submit'|'control')=>Promise<boolean>;
 dispatch:Dispatch; controls:ControlPort;
}
async function body(req:IncomingMessage){
 if(req.headers['content-type']?.split(';')[0]!=='application/json')throw new GatewayError(415,'JSON_REQUIRED');
 if(Number(req.headers['content-length']??0)>16384){req.resume();throw new GatewayError(413,'PAYLOAD_TOO_LARGE');}
 const chunks:Buffer[]=[];let size=0;
 for await(const part of req){const b=Buffer.isBuffer(part)?part:Buffer.from(String(part));size+=b.length;if(size>16384)throw new GatewayError(413,'PAYLOAD_TOO_LARGE');chunks.push(b);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{throw new GatewayError(400,'INVALID_JSON');}
}
export function createGateway(options:GatewayOptions){
 if(typeof options.authenticate!=='function'||typeof options.admit!=='function'||! /^[A-Za-z0-9._:-]{1,160}$/.test(options.releaseId))throw new Error('Explicit authentication, admission and release configuration required');
 const views=new MissionControlStore(options.pool),memory=new MemoryStore(options.pool),world=new WorldStore(options.pool);
 const status=async(context:TenantContext,taskId:string)=>withTenant(options.pool,context,async(db,ctx)=>{
  const rows=await db.query<{contract:unknown}>('select contract from tasks where id=$1 and tenant_id=$2',[taskId,ctx.tenantId]);
  const admission=await db.query<{payload:unknown}>('select payload from kernel_private.task_admissions where task_id=$1 and tenant_id=$2',[taskId,ctx.tenantId]);
  if(!rows.rows[0]&&!admission.rows[0])throw new GatewayError(404,'TASK_NOT_FOUND');
  const task=rows.rows[0]?Task.parse(rows.rows[0].contract):compileIntent(admission.rows[0]!.payload).task;
  const dispatch=await db.query<{status:string}>('select status from kernel_private.dispatch_events where task_id=$1 order by occurred_at desc,id desc limit 1',[taskId]);
  const confirmed=await db.query("select 1 from kernel_private.effect_receipts where task_id=$1 and disposition='CONFIRMED' limit 1",[taskId]);
  let effectDisposition:'CONFIRMED'|'UNRESOLVED'|'NOT_STARTED'=confirmed.rowCount?'CONFIRMED':'NOT_STARTED';
  try{await assertResolvedEffects(db,taskId);}catch(error){if(!(error instanceof UnresolvedEffectError))throw error;effectDisposition='UNRESOLVED';}
  return {taskId:task.id,status:task.status,traceId:task.traceId,outcome:await readOutcome(db,taskId),dispatch:dispatch.rows[0]?.status??null,effectDisposition};
 });
 return async(req:IncomingMessage,res:ServerResponse)=>{
  const correlationId=randomUUID();res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('x-correlation-id',correlationId);
  const reply=(code:number,value:unknown)=>{res.statusCode=code;res.end(JSON.stringify(value));};
  try{
   let context:TenantContext;try{context=TenantContext.parse(await options.authenticate(req.headers));}catch{throw new GatewayError(401,'UNAUTHENTICATED');}
   const url=new URL(req.url??'/','http://gateway.invalid');
   if(req.method==='POST'&&url.pathname==='/v1/tasks'){
    const input=PublicSubmission.parse(await body(req)),key=Key.parse(req.headers['idempotency-key']);
    const keyDigest=capabilityDigest(key),requestDigest=capabilityDigest(input);
    const accepted=await withTenant(options.pool,context,async(db,ctx)=>{
     if(!(await options.admit(ctx,'submit')))throw new GatewayError(429,'ADMISSION_DENIED');
     await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`${ctx.tenantId}:${ctx.principal.id}:${keyDigest}`]);
     const prior=await db.query<{task_id:string;request_digest:string;payload:unknown}>('select task_id,request_digest,payload from kernel_private.task_admissions where tenant_id=$1 and principal_id=$2 and key_digest=$3',[ctx.tenantId,ctx.principal.id,keyDigest]);
     if(prior.rows[0]){
      if(prior.rows[0].request_digest!==requestDigest)throw new GatewayError(409,'IDEMPOTENCY_CONFLICT');
      const binding=await readBinding(db,prior.rows[0].task_id);if(!binding)throw new Error('Missing admission binding');return {binding,payload:KernelSubmission.parse(prior.rows[0].payload),replay:true as const};
     }
     const trace= req.headers['x-correlation-id']===undefined ? correlationId : Id.parse(req.headers['x-correlation-id']);
     const payload=KernelSubmission.parse({recipe:input.recipe,intent:{id:stableId(['gateway/v1',ctx.tenantId,ctx.principal.id,keyDigest]),principal:ctx.principal,tenant:{id:ctx.tenantId},source:'kerneljson:gateway/v1',objective:input.objective,attachments:[],contextRefs:[],receivedAt:new Date().toISOString(),trace:{traceId:trace,correlationId:trace}}});
     const task=compileIntent(payload).task,target=input.recipe==='uppercase/v1'?workflowTargets.GoldenTaskWorkflowV1:workflowTargets.KernelWorkflowV1;
     const binding=await persistBinding(db,bindingFor(task,target,options.releaseId));
     await db.query('insert into kernel_private.task_admissions(task_id,tenant_id,principal_id,key_digest,request_digest,payload) values($1,$2,$3,$4,$5,$6)',[task.id,ctx.tenantId,ctx.principal.id,keyDigest,requestDigest,payload]);
     return {binding,payload,replay:false as const};
    },'submit');
    // estate-email-triage/v1 and other ADMISSION_ONLY recipes: durable task_admissions only — never dispatch/execute.
    if(ADMISSION_ONLY_RECIPES.has(input.recipe)){
     res.setHeader('location',`/v1/tasks/${accepted.binding.taskId}`);
     reply(202,{...await status(context,accepted.binding.taskId),dispatch:null,admission:accepted.replay?'REPLAY':'ADMITTED'});return;
    }
    const dispatched=await withTenant(options.pool,context,async(db,ctx)=>{
     await db.query("insert into kernel_private.dispatch_events(id,task_id,status) values($1,$2,'REQUESTED')",[randomUUID(),accepted.binding.taskId]);
     let result:Awaited<ReturnType<Dispatch>>;try{result=await options.dispatch(accepted.binding,accepted.payload,ctx);}catch{result={status:'UNRESOLVED'};}
     await db.query('insert into kernel_private.dispatch_events(id,task_id,status,invocation_id) values($1,$2,$3,$4)',[randomUUID(),accepted.binding.taskId,result.status,result.invocationId??null]);return result;
    },'submit');
    res.setHeader('location',`/v1/tasks/${accepted.binding.taskId}`);
    reply(202,{...await status(context,accepted.binding.taskId),dispatch:dispatched.status,admission:accepted.replay?'REPLAY':'ADMITTED'});return;
   }
   if(req.method==='GET'&&url.pathname==='/v1/memory'){reply(200,await memory.retrieve(context,Object.fromEntries(url.searchParams)));return;}
   if(req.method==='GET'&&url.pathname==='/v1/world'){reply(200,await world.view(context,Object.fromEntries(url.searchParams)));return;}
   const match=/^\/v1\/tasks\/([^/]+)(?:\/(history|evidence|outcome|cancel|signal|approve))?$/.exec(url.pathname);if(!match)throw new GatewayError(404,'NOT_FOUND');
   const taskId=Id.parse(match[1]),action=match[2];
   if(req.method==='GET'){
    if(!action){reply(200,await status(context,taskId));return;}
    if(!['history','evidence','outcome'].includes(action))throw new GatewayError(405,'METHOD_NOT_ALLOWED');
    const view=await views.task(context,taskId);if(!view)throw new GatewayError(404,'TASK_NOT_FOUND');reply(200,action==='history'?view.events:action==='evidence'?view.evidence:view.outcome);return;
   }
   if(req.method!=='POST'||!action||!['cancel','signal','approve'].includes(action))throw new GatewayError(405,'METHOD_NOT_ALLOWED');
   await withTenant(options.pool,context,async(_db,ctx)=>{if(!(await options.admit(ctx,'control')))throw new GatewayError(429,'ADMISSION_DENIED');},action as 'cancel'|'signal'|'approve');
   const input=await body(req);
   const result=action==='approve'?await options.controls.approve(context,taskId,ApprovalAnswer.parse(input)):action==='signal'?await options.controls.signal?.(context,taskId,Signal.parse(input)):(z.strictObject({}).parse(input),await options.controls.cancel(context,taskId));
   if(!result){reply(409,{taskId,action,status:'UNSUPPORTED'});return;}
   reply(result.status==='UNSUPPORTED'||result.status==='FAILED'?409:result.status==='UNRESOLVED'?503:result.status==='COMPLETED'?200:202,result);
  }catch(error){
   const code=error instanceof GatewayError?error.status:error instanceof z.ZodError?400:error instanceof Error&&error.message==='Tenant access denied'?403:error instanceof Error&&error.message==='Task not found'?404:500;
   reply(code,{error:error instanceof GatewayError?error.code:code===400?'INVALID_REQUEST':code===403?'FORBIDDEN':code===404?'TASK_NOT_FOUND':'INTERNAL_ERROR',correlationId});
  }
 };
}
