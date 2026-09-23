import type pg from "pg";
import { FacultyPin, FacultyVersion } from "../../../../packages/contracts/src/faculty.js";
import { ExecutionPlan, Task, type ModelRequest } from "../../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../../packages/capabilities/src/index.js";
import { planTask } from "../planner/index.js";
import { boundFacultyRequest, FacultyRefusal, routeFaculty, validateFacultyPin } from "./policy.js";

export interface FacultyRoute { provider: "deepseek" | "openrouter"; model: string }
/** No configuration writes, admission, approval or task mutation exposed to execution. */
export interface MissionFacultyPort {
  pin(input: { tenantId: string; taskId: string; stepId: string }): Promise<FacultyPin>;
  authorize(pin: FacultyPin, request: ModelRequest): Promise<void>;
}
export class PgFacultyRegistry implements MissionFacultyPort {
  constructor(private readonly pool: pg.Pool, private readonly routes: { analyst: FacultyRoute; reviewer: FacultyRoute }) {}
  async pin(input: { tenantId: string; taskId: string; stepId: string }): Promise<FacultyPin> {
    const db = await this.pool.connect();
    try {
      await db.query("begin");
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`faculty-pin:${input.taskId}:${input.stepId}`]);
      const row = (await db.query("select contract from public.tasks where id=$1 and tenant_id=$2", [input.taskId, input.tenantId])).rows[0];
      if (!row) throw new FacultyRefusal("FACULTY_TASK_REFUSED");
      const task = Task.parse(row.contract);
      const prior = (await db.query("select pin from public.faculty_pins where task_id=$1 and step_id=$2 and tenant_id=$3", [input.taskId, input.stepId, input.tenantId])).rows[0];
      if (prior) {
        const pin = validateFacultyPin(prior.pin);
        await db.query("commit");
        return pin;
      }
      if (task.status !== "RUNNING") throw new FacultyRefusal("FACULTY_TASK_NOT_RUNNING");
      const events = await db.query("select payload from public.task_events where task_id=$1 and type='PLAN_COMPILED'", [task.id]);
      if (events.rows.length !== 1) throw new FacultyRefusal("FACULTY_PLAN_REFUSED");
      const plan = ExecutionPlan.parse(events.rows[0].payload.plan);
      if (capabilityDigest(plan) !== capabilityDigest(planTask(task, plan.recipe))) throw new FacultyRefusal("FACULTY_PLAN_REFUSED");
      const step = plan.steps.find(s => s.id === input.stepId);
      if (!step) throw new FacultyRefusal("FACULTY_STEP_REFUSED");
      const route = routeFaculty(step.operation);
      const current = (await db.query("select definition,digest from public.faculty_current where tenant_id=$1 and faculty_id=$2", [input.tenantId, route.id])).rows[0];
      if (!current) throw new FacultyRefusal("FACULTY_NOT_CONFIGURED");
      const faculty = FacultyVersion.parse(current.definition);
      const pin = validateFacultyPin({ ...input, operation: step.operation, faculty, facultyDigest: current.digest,
        routingReason: route.reason, policyVersion: faculty.policyVersion,
        ...this.routes[step.operation === "RUNTIME_ANALYSE" ? "analyst" : "reviewer"] });
      await db.query("insert into public.faculty_pins(tenant_id,task_id,step_id,faculty_id,faculty_version,pin) values($1,$2,$3,$4,$5,$6)", [input.tenantId, task.id, step.id, faculty.id, faculty.version, pin]);
      await db.query("commit");
      return pin;
    } catch (error) { await db.query("rollback"); throw error; }
    finally { db.release(); }
  }
  async authorize(raw: FacultyPin, request: ModelRequest): Promise<void> {
    const pin = validateFacultyPin(raw);
    const bounded = boundFacultyRequest(pin, request);
    if (bounded.maxOutputTokens !== request.maxOutputTokens) throw new FacultyRefusal("FACULTY_OUTPUT_BUDGET_REFUSED");
    const route = this.routes[pin.operation === "RUNTIME_ANALYSE" ? "analyst" : "reviewer"];
    if (route.provider !== pin.provider || route.model !== pin.model) throw new FacultyRefusal("FACULTY_PINNED_ROUTE_UNAVAILABLE");
    const rows = await this.pool.query(`select p.pin,t.status,c.definition from public.faculty_pins p
      join public.tasks t on t.id=p.task_id and t.tenant_id=p.tenant_id
      join public.faculty_current c on c.tenant_id=p.tenant_id and c.faculty_id=p.faculty_id
      where p.task_id=$1 and p.step_id=$2 and p.tenant_id=$3`, [pin.taskId, pin.stepId, pin.tenantId]);
    const row = rows.rows[0];
    if (!row || row.status !== "RUNNING" || capabilityDigest(row.pin) !== capabilityDigest(pin)) throw new FacultyRefusal("FACULTY_EXECUTION_REFUSED");
    if (!FacultyVersion.parse(row.definition).enabled) throw new FacultyRefusal("FACULTY_DISABLED");
  }
}
