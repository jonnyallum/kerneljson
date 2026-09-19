import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { DATABASE, compose, migrate, until, holdRuntime } from "./support/local.js";
import { PgNotificationOutboxStore } from "../services/kernel/src/alerting/pg-outbox-store.js";
import { enqueueTestNotification } from "../services/kernel/src/alerting/test-notification.js";
import { evaluateOutboxGate, readOutboxGateInput } from "../services/kernel/src/alerting/outbox-gate.js";

// Real Postgres (the disposable validation stack), every migration applied.
const name = `kj_p22b_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const admin = new pg.Pool({ connectionString: DATABASE, max: 1 });
let pool: pg.Pool;
let releaseRuntime = () => {};

beforeAll(async () => {
  releaseRuntime = holdRuntime();
  compose("up", "-d", "db");
  await until(
    () => admin.query("select 1"),
    (r) => r.rowCount === 1,
  );
  await admin.query(`create database ${name}`);
  pool = new pg.Pool({ connectionString: DATABASE.replace(/\/kerneljson$/, `/${name}`), max: 2 });
  await migrate(pool);
});

afterAll(async () => {
  await pool?.end();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
  releaseRuntime();
});

/** Row count of every base table in every non-system schema, keyed schema.table. */
async function snapshot(): Promise<Record<string, number>> {
  const tables = await pool.query<{ table_schema: string; table_name: string }>(
    `select table_schema, table_name from information_schema.tables
     where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog','information_schema')
     order by 1, 2`,
  );
  const out: Record<string, number> = {};
  for (const t of tables.rows) {
    const res = await pool.query<{ n: string }>(`select count(*)::text as n from "${t.table_schema}"."${t.table_name}"`);
    out[`${t.table_schema}.${t.table_name}`] = Number(res.rows[0]!.n);
  }
  return out;
}

it("queues exactly one durable outbox row and mutates no other table (admissions, fires, bindings, alert_state, ledger)", async () => {
  const before = await snapshot();
  expect(Object.keys(before).length).toBeGreaterThan(10);
  expect(before["kernel_private.task_admissions"]).toBeDefined();
  expect(before["public.schedule_fires"]).toBeDefined();
  expect(before["kernel_private.execution_bindings"]).toBeDefined();
  expect(before["kernel_private.alert_state"]).toBeDefined();

  const outbox = new PgNotificationOutboxStore(pool);
  await outbox.probe();
  const { notificationId } = await enqueueTestNotification(outbox, "pg-proof");

  const after = await snapshot();
  const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
  expect(changed).toEqual(["kernel_private.notification_outbox"]);
  expect(after["kernel_private.notification_outbox"]).toBe(1);
  expect(after["kernel_private.notification_delivery_events"]).toBe(0);

  const row = (await pool.query("select * from kernel_private.notification_outbox")).rows[0];
  expect(row).toMatchObject({
    notification_id: notificationId,
    severity: "P3",
    kind: "NEW",
    status: "PENDING",
    attempt_count: 0,
    check_id: "TEST.telegramActivationVerification",
  });
});

it("re-running with the same label leaves exactly one row (db-level idempotency, no second intent)", async () => {
  const outbox = new PgNotificationOutboxStore(pool);
  await enqueueTestNotification(outbox, "pg-proof", () => new Date(Date.now() + 3_600_000));
  const res = await pool.query("select count(*)::int as n from kernel_private.notification_outbox");
  expect(res.rows[0].n).toBe(1);
});

it("the POISON gate reads real rows: PASS while the test row is fresh PENDING, FAIL on POISON, FAIL on a duplicate delivery event", async () => {
  const opts = { baselinePoison: 0 };
  const fresh = await readOutboxGateInput(pool);
  expect(fresh.counts).toEqual({ PENDING: 1 });
  expect(evaluateOutboxGate(fresh, opts).pass).toBe(true);

  await pool.query("update kernel_private.notification_outbox set status = 'POISON', last_error = 'TelegramBadRequestError'");
  const poisoned = await readOutboxGateInput(pool);
  expect(poisoned.poisonErrorClasses).toEqual({ TelegramBadRequestError: 1 });
  const verdict = evaluateOutboxGate(poisoned, opts);
  expect(verdict.pass).toBe(false);
  expect(verdict.failures.join(" ")).toContain("TelegramBadRequestError=1");

  await pool.query("update kernel_private.notification_outbox set status = 'DELIVERED', delivered_at = now(), last_error = null");
  await pool.query(
    `insert into kernel_private.notification_delivery_events(notification_id, attempt_number, attempted_at, outcome, transport)
     select notification_id, n, now(), 'DELIVERED', 'telegram' from kernel_private.notification_outbox, generate_series(1, 2) n`,
  );
  const dup = await readOutboxGateInput(pool);
  expect(dup.duplicateDelivered).toBe(1);
  expect(evaluateOutboxGate(dup, opts).pass).toBe(false);
});
