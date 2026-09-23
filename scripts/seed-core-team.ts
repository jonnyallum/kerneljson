// Deployment-only provisioning. Never imported by the worker or reachable from a model.
// Usage: node --import tsx scripts/seed-core-team.ts <tenant UUID> <reviewed change reference>
import pg from "pg";
import { coreTeamTemplates } from "../services/kernel/src/faculty/templates.js";
import { capabilityDigest } from "../packages/capabilities/src/index.js";

const [tenantId, changeRef] = process.argv.slice(2);
if (!tenantId || !changeRef) throw new Error("Tenant UUID and reviewed change reference required");
const templates = coreTeamTemplates(tenantId, changeRef);
const db = new pg.Client({ connectionString: process.env["DATABASE_URL"] });
await db.connect();
try {
  await db.query("begin");
  const safety = (await db.query(`select
    (select count(*)::int from public.tasks where status not in ('COMPLETED','FAILED','CANCELLED')) tasks,
    (select count(*)::int from public.approvals where status='PENDING') approvals,
    (select count(*)::int from kernel_private.notification_outbox where status='POISON') poison`)).rows[0];
  if (Object.values(safety).some(n => n !== 0)) throw new Error("Production write safety gate refused");
  for (const f of templates) {
    const prior = (await db.query("select digest from public.faculty_versions where tenant_id=$1 and faculty_id=$2 and version=1", [tenantId, f.id])).rows[0];
    if (prior) {
      if (prior.digest !== capabilityDigest(f)) throw new Error("Seed differs from existing faculty version");
    } else {
      await db.query("insert into public.faculty_versions(tenant_id,faculty_id,version,definition,digest) values($1,$2,1,$3,$4)", [tenantId, f.id, f, capabilityDigest(f)]);
    }
  }
  await db.query("commit");
  console.log(JSON.stringify({ tenantId, facultyCount: templates.length, enabled: templates.filter(f => f.enabled).map(f => f.id), changeRef }));
} catch {
  await db.query("rollback");
  throw new Error("Core Team seed refused; no partial configuration committed");
} finally { await db.end(); }
