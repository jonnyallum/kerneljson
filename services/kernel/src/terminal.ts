import type pg from "pg";
import { Id, Outcome } from "../../../packages/contracts/src/index.js";
export class UnresolvedEffectError extends Error { constructor(){super("Effect outcome is UNRESOLVED");} }
export async function assertResolvedEffects(db: Pick<pg.PoolClient,"query">,taskId:string) {
 const r=await db.query("select 1 from kernel_private.effect_receipts u where u.task_id=$1 and u.disposition='UNRESOLVED' and not exists(select 1 from kernel_private.effect_receipts c where c.task_id=u.task_id and c.operation_id=u.operation_id and c.disposition='CONFIRMED') limit 1",[taskId]);
 if(r.rowCount)throw new UnresolvedEffectError();
}
/** Trusted internal reconciliation only; this does not invoke any external effect. */
async function recordEffectTx(db: pg.PoolClient, taskId:string,stepId:string,operationId:string,evidenceId?:string) {
 for(const id of [taskId,stepId,operationId,...(evidenceId?[evidenceId]:[])])Id.parse(id);
 await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[taskId]);
 const task=await db.query<{status:string}>("select status from tasks where id=$1 for update",[taskId]);
 if(!task.rows[0] || ["COMPLETED","FAILED","CANCELLED"].includes(task.rows[0].status))throw new Error("Effect task is terminal or missing");
 if(evidenceId){const e=await db.query("select 1 from evidence where id=$1 and task_id=$2 and step_id=$3",[evidenceId,taskId,stepId]);if(!e.rowCount)throw new Error("Effect evidence scope mismatch");}
 await db.query("insert into kernel_private.effect_receipts(task_id,operation_id,step_id,disposition,evidence_id) values($1,$2,$3,$4,$5) on conflict do nothing",[taskId,operationId,stepId,evidenceId?'CONFIRMED':'UNRESOLVED',evidenceId??null]);
 const r=await db.query<{step_id:string;evidence_id:string|null}>("select step_id,evidence_id from kernel_private.effect_receipts where task_id=$1 and operation_id=$2 and disposition=$3",[taskId,operationId,evidenceId?'CONFIRMED':'UNRESOLVED']);
 if(r.rows[0]?.step_id!==stepId||r.rows[0]?.evidence_id!==(evidenceId??null))throw new Error("Effect receipt conflict");
}
export async function readOutcome(db: Pick<pg.PoolClient,"query">,taskId:string):Promise<Outcome|null>{
 const r=await db.query<{contract:unknown}>("select coalesce(o.contract,t.contract) as contract from tasks x left join outcomes o on o.task_id=x.id left join kernel_private.terminal_results t on t.task_id=x.id where x.id=$1 and coalesce(o.contract,t.contract) is not null",[taskId]);
 return r.rows[0]?Outcome.parse(r.rows[0].contract):null;
}

export async function recordEffect(pool:pg.Pool,taskId:string,stepId:string,operationId:string,evidenceId?:string){
 const db=await pool.connect();try{await db.query("begin");await recordEffectTx(db,taskId,stepId,operationId,evidenceId);await db.query("commit");}catch(error){await db.query("rollback");throw error;}finally{db.release();}
}
