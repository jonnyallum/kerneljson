import type pg from "pg";
import { ExecutionBinding, ExecutionTarget, Task } from "../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../packages/capabilities/src/index.js";
/** Deployment-owned catalogue. Never built from HTTP request content. */
export const workflowTargets = {
 TaskWorkflow: {service:"TaskWorkflow",version:"1",routingId:"kernel",controls:["cancel","signal"]},
 KernelWorkflowV1: {service:"KernelWorkflowV1",version:"1",routingId:"kernel",controls:["cancel","signal"]},
 PolicyCapabilityWorkflowV1: {service:"PolicyCapabilityWorkflowV1",version:"1",routingId:"kernel",controls:["cancel","approve"]},
 GoldenTaskWorkflowV1: {service:"GoldenTaskWorkflowV1",version:"1",routingId:"kernel",controls:["cancel","approve"]},
 AutonomousChildTaskWorkflowV1: {service:"AutonomousChildTaskWorkflowV1",version:"1",routingId:"kernel",controls:["cancel","approve"]},
 BoundedScheduleWorkflowV1: {service:"BoundedScheduleWorkflowV1",version:"1",routingId:"kernel",controls:["cancel"]},
} satisfies Record<string, ExecutionTarget>;
export type WorkflowName = keyof typeof workflowTargets;
export function bindingFor(task: Task, target: ExecutionTarget, releaseId: string): ExecutionBinding {
 return ExecutionBinding.parse({...ExecutionTarget.parse(target),taskId:task.id,tenantId:task.tenant.id,principal:task.principal,releaseId,executionKey:task.id,boundAt:task.createdAt,definitionDigest:capabilityDigest(task)});
}
export async function readBinding(db: Pick<pg.PoolClient,"query">,taskId: string): Promise<ExecutionBinding|null> {
 const row=await db.query<{contract:unknown}>("select contract from kernel_private.execution_bindings where task_id=$1",[taskId]);
 return row.rows[0]?ExecutionBinding.parse(row.rows[0].contract):null;
}
export async function persistBinding(db: pg.PoolClient, raw: ExecutionBinding) {
 const binding=ExecutionBinding.parse(raw);
 await db.query("insert into kernel_private.execution_bindings(task_id,tenant_id,principal_id,contract) values($1,$2,$3,$4) on conflict(task_id) do nothing",[binding.taskId,binding.tenantId,binding.principal.id,binding]);
 const stored=await readBinding(db,binding.taskId);
 // Replays retain their original release. Identity, definition and route never drift.
 if (!stored || capabilityDigest({...stored,releaseId:binding.releaseId})!==capabilityDigest(binding)) throw new Error("Execution binding conflict");
 return stored;
}
