import { randomUUID } from "node:crypto";
import pg from "pg";
import { DATABASE, compose, holdRuntime, migrate, until } from "./local.js";
import { verificationFixture } from "../../evals/fixtures/verification.js";
import {
  Task,
  TaskStep,
  Evidence,
  type TenantContext,
} from "../../packages/contracts/src/index.js";
import { VerificationStore } from "../../services/kernel/src/verification-store.js";
import { capabilityDigest } from "../../packages/capabilities/src/index.js";
export async function knowledgeDatabase() {
  const release = holdRuntime(),
    name = `knowledge_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: DATABASE });
  compose("up", "-d", "db");
  await until(
    () => admin.query("select 1"),
    (r) => r.rowCount === 1,
  );
  await admin.query(`create database ${name}`);
  const pool = new pg.Pool({
    connectionString: DATABASE.replace("/kerneljson", `/${name}`),
  });
  await migrate(pool);
  const bundle = verificationFixture(),
    task = Task.parse(bundle.task),
    step = TaskStep.parse(bundle.steps[0]),
    evidence = Evidence.parse(bundle.evidence[0]),
    run = bundle.runs[0]!,
    policy = bundle.policies[0]!;
  const context: TenantContext = {
    tenantId: task.tenant.id,
    principal: task.principal,
  };
  await pool.query("insert into principals(id,kind) values($1,$2)", [
    task.principal.id,
    task.principal.kind,
  ]);
  await pool.query("insert into tenants(id,name) values($1,'knowledge-test')", [
    task.tenant.id,
  ]);
  await pool.query(
    "insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'owner')",
    [task.tenant.id, task.principal.id],
  );
  await pool.query(
    "insert into tasks(id,tenant_id,principal_id,trace_id,status,contract,created_at) values($1,$2,$3,$4,'VERIFYING',$5,$6)",
    [
      task.id,
      task.tenant.id,
      task.principal.id,
      task.traceId,
      task,
      task.createdAt,
    ],
  );
  await pool.query(
    "insert into task_steps(id,task_id,status,contract) values($1,$2,'COMPLETED',$3)",
    [step.id, task.id, step],
  );
  await pool.query(
    "insert into evidence(id,task_id,step_id,type,source,digest,captured_at,metadata) values($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      evidence.id,
      task.id,
      step.id,
      evidence.type,
      evidence.source,
      evidence.digest,
      evidence.capturedAt,
      evidence.metadata,
    ],
  );
  const capability = step.requiredCapabilities[0]!,
    versionId = randomUUID();
  await pool.query(
    "insert into capabilities(id,name) values($1,'knowledge-uppercase')",
    [capability.id],
  );
  await pool.query(
    "insert into capability_versions(id,capability_id,version,contract) values($1,$2,$3,$4)",
    [versionId, capability.id, capability.version, run.descriptor],
  );
  await pool.query(
    "insert into capability_runs(id,task_id,step_id,capability_version_id,idempotency_key,request_digest,result,evidence_id,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      run.id,
      task.id,
      step.id,
      versionId,
      step.idempotencyKey,
      capabilityDigest(policy.payload.invocation),
      run.result,
      evidence.id,
      task.createdAt,
    ],
  );
  await pool.query(
    "insert into task_events(id,task_id,event_key,request_digest,type,occurred_at,actor_id,trace_id,payload) values($1,$2,$3,$4,'POLICY_CHECKED',$5,$6,$7,$8)",
    [
      policy.id,
      task.id,
      `policy-approval:${policy.payload.approvalId}`,
      capabilityDigest(policy.payload),
      task.createdAt,
      task.principal.id,
      task.traceId,
      policy.payload,
    ],
  );
  const outcome = await new VerificationStore(pool).finish(task.id, {
    eventId: randomUUID(),
    verificationEventId: randomUUID(),
    at: new Date().toISOString(),
  });
  if (outcome.status !== "COMPLETED")
    throw new Error("Knowledge fixture failed independent verification");
  return {
    pool,
    context,
    task,
    evidence,
    outcome,
    close: async () => {
      await pool.end();
      await admin.query(`drop database ${name}`);
      await admin.end();
      release();
    },
  };
}
