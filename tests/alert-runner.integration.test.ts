import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import pg from "pg";
import { migrate, until } from "./support/local.js";
import { monitorReport } from "./support/alert-runner-fixture.js";
import { runMonitor } from "../services/kernel/src/alerting/runner.js";
import { postgresMonitorExclusive } from "../services/kernel/src/alerting/runner-postgres.js";
import { RecordingNotifier } from "../services/kernel/src/alerting/notifier.js";
import { collectHealthSnapshot } from "../services/kernel/src/health/collect.js";
import { evaluateHealthSnapshot } from "../services/kernel/src/health/run.js";
import { loadHealthExpectations } from "../services/kernel/src/health/config.js";
import { createRestateAdminClient } from "../services/kernel/src/health/restate-client.js";

// Ungated, local disposable containers only. No supplied URL or production credential.
describe("KJ-P1.3 disposable Postgres and Restate", () => {
  const suffix = randomUUID().slice(0, 8);
  const dbName = `kj-p13-db-${suffix}`;
  const restateName = `kj-p13-restate-${suffix}`;
  const created: string[] = [];
  let pool: pg.Pool,
    dbUrl: string,
    ingress: string,
    admin: string,
    workerPort: number;
  let worker: ChildProcess | undefined;
  const logs: string[] = [];
  const docker = (...args: string[]) =>
    execFileSync("docker", ["--context", "default", ...args], {
      encoding: "utf8",
      timeout: 60000,
      windowsHide: true,
    });
  const port = (container: string, internal: number) =>
    Number(
      docker("port", container, `${internal}/tcp`).trim().split(":").at(-1),
    );
  async function startWorker() {
    worker = spawn(
      process.execPath,
      ["--import", "tsx", "tests/support/alert-runner-worker.ts"],
      {
        env: {
          ...process.env,
          PORT: String(workerPort),
          KJ_MONITOR_TEST_DB: dbUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    worker.stdout?.on("data", (d) => logs.push(String(d)));
    worker.stderr?.on("data", (d) => logs.push(String(d)));
    await until(
      () =>
        new Promise<boolean>((resolve) => {
          const socket = createConnection(workerPort, "127.0.0.1");
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("error", () => {
            socket.destroy();
            resolve(false);
          });
          socket.setTimeout(1000, () => {
            socket.destroy();
            resolve(false);
          });
        }),
      Boolean,
      20000,
    );
  }
  async function stopWorker() {
    if (!worker || worker.exitCode !== null) return;
    const stopped = new Promise<void>((resolve) =>
      worker!.once("exit", () => resolve()),
    );
    worker.kill("SIGKILL");
    await stopped;
    worker = undefined;
  }
  const post = async (path: string, body: unknown = {}) => {
    const response = await fetch(
      `${ingress}/ProductionAlertMonitor/production/${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) throw Error(`Monitor response ${response.status}`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  beforeAll(async () => {
    // Reject remote default Docker endpoints as well as caller-supplied URLs.
    const endpoint = docker(
      "context",
      "inspect",
      "default",
      "--format",
      "{{.Endpoints.docker.Host}}",
    ).trim();
    if (!endpoint.startsWith("npipe://") && !endpoint.startsWith("unix://"))
      throw Error("Local Docker required");
    docker(
      "run",
      "-d",
      "--name",
      dbName,
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "-e",
      "POSTGRES_DB=monitor",
      "-p",
      "127.0.0.1::5432",
      "postgres:17.6",
    );
    created.push(dbName);
    docker(
      "run",
      "-d",
      "--name",
      restateName,
      ...(process.platform === "linux"
        ? ["--add-host", "host.docker.internal:host-gateway"]
        : []),
      "-p",
      "127.0.0.1::8080",
      "-p",
      "127.0.0.1::9070",
      "docker.restate.dev/restatedev/restate:1.7.9",
    );
    created.push(restateName);
    dbUrl = `postgresql://postgres@127.0.0.1:${port(dbName, 5432)}/monitor`;
    ingress = `http://127.0.0.1:${port(restateName, 8080)}`;
    admin = `http://127.0.0.1:${port(restateName, 9070)}`;
    pool = new pg.Pool({
      connectionString: dbUrl,
      connectionTimeoutMillis: 1000,
    });
    await until(
      () => pool.query("select 1"),
      () => true,
      30000,
    );
    await migrate(pool);
    await until(
      () => fetch(`${admin}/health`),
      (r) => r.ok,
      30000,
    );
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    workerPort = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 120000);
  afterAll(async () => {
    await stopWorker();
    await pool?.end();
    for (const name of created.reverse()) docker("rm", "-f", "-v", name);
  });
  beforeEach(async () => {
    await pool.query("delete from kernel_private.alert_state");
  });

  it("real state persists, deduplicates and recovers across independent pools", async () => {
    const second = new pg.Pool({ connectionString: dbUrl });
    try {
      const notifier = new RecordingNotifier();
      const deps = {
        collect: async () => monitorReport("CRITICAL"),
        exclusive: postgresMonitorExclusive(pool),
        notifier,
        canonicalScheduleId: "pg-monitor",
      };
      expect((await runMonitor(deps)).notificationsAttempted).toBe(2);
      expect(
        (
          await runMonitor({
            ...deps,
            exclusive: postgresMonitorExclusive(second),
          })
        ).notificationsAttempted,
      ).toBe(0);
      expect(
        (await runMonitor({ ...deps, collect: async () => monitorReport() }))
          .notificationsAttempted,
      ).toBe(2);
      expect(
        (
          await pool.query(
            "select current_state from kernel_private.alert_state where entity_id='pg-monitor'",
          )
        ).rows.every((r) => r.current_state === "RECOVERED"),
      ).toBe(true);
    } finally {
      await second.end();
    }
  });
  it("database-wide lock excludes independent connections and releases after a failed run", async () => {
    const exclusive = postgresMonitorExclusive(pool);
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const first = exclusive(async () => {
      acquired();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw Error("crash");
    });
    const outcome = first.catch(() => false);
    await ready;
    expect(
      await exclusive(async () => {
        throw Error("must never execute");
      }),
    ).toBe(false);
    release();
    await outcome;
    expect(await exclusive(async () => {})).toBe(true);
  });
  it("state schema failure is fail-closed and never collects or notifies", async () => {
    await pool.query(
      "alter table kernel_private.alert_state rename to alert_state_test_hidden",
    );
    try {
      const result = await runMonitor({
        exclusive: postgresMonitorExclusive(pool),
        collect: async () => {
          throw Error("must not collect");
        },
        notifier: new RecordingNotifier(),
        canonicalScheduleId: "failure",
      });
      expect(result.result).toBe("STATE_FAILED");
      expect(result.overall).toBeNull();
      expect(result.notificationsAttempted).toBe(0);
    } finally {
      await pool.query(
        "alter table kernel_private.alert_state_test_hidden rename to alert_state",
      );
    }
  });
  it("the actual manual alert CLI shares the runner lock", async () => {
    await postgresMonitorExclusive(pool)(async () => {
      const outcome = await new Promise<{
        code: number | null;
        output: string;
      }>((resolve) => {
        const cli = spawn(
          process.execPath,
          ["--import", "tsx", "services/kernel/src/alerting/cli.ts", "--json"],
          {
            env: {
              ...process.env,
              DATABASE_URL: dbUrl,
              ALERT_STATE_STORE: "postgres",
            },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        );
        let output = "";
        cli.stdout.on("data", (data) => {
          output += String(data);
        });
        cli.stderr.on("data", (data) => {
          output += String(data);
        });
        cli.once("exit", (code) => resolve({ code, output }));
      });
      expect(outcome.code).toBe(4);
      expect(outcome.output).toContain("already running");
    });
    expect(
      (await pool.query("select count(*) as n from kernel_private.alert_state"))
        .rows[0].n,
    ).toBe("0");
  });
  it("a lost lock session cannot reconnect and persist stale decisions", async () => {
    const notifier = new RecordingNotifier();
    const result = await runMonitor({
      exclusive: postgresMonitorExclusive(pool),
      notifier,
      canonicalScheduleId: "lost-session",
      collect: async () => {
        const owner = await pool.query(
          "select pid from pg_locks where locktype='advisory' and granted",
        );
        expect(owner.rowCount).toBe(1);
        await pool.query("select pg_terminate_backend($1)", [
          owner.rows[0].pid,
        ]);
        return monitorReport("CRITICAL");
      },
    });
    expect(result.result).toBe("STATE_FAILED");
    expect(notifier.sent).toEqual([]);
    expect(
      (await pool.query("select count(*) as n from kernel_private.alert_state"))
        .rows[0].n,
    ).toBe("0");
    expect(await postgresMonitorExclusive(pool)(async () => {})).toBe(true);
  });
  it("real collector observes unavailable Restate without writing business tables", async () => {
    const expectations = loadHealthExpectations({});
    const before = await pool.query(
      "select (select count(*) from tasks) as tasks, (select count(*) from schedule_fires) as fires, (select count(*) from schedule_state) as schedules",
    );
    const summary = await runMonitor({
      exclusive: postgresMonitorExclusive(pool),
      notifier: new RecordingNotifier(),
      canonicalScheduleId: expectations.scheduleId,
      collect: async () =>
        evaluateHealthSnapshot(
          await collectHealthSnapshot({
            pool,
            connection: {
              databaseUrl: dbUrl,
              restateAdminUrl: "http://127.0.0.1:1",
            },
            expectations,
            selfEnv: {},
          }),
          expectations,
        ),
    });
    expect(summary.result).toBe("OK");
    expect(summary.overall).not.toBe("HEALTHY");
    expect(
      (
        await pool.query(
          "select (select count(*) from tasks) as tasks, (select count(*) from schedule_fires) as fires, (select count(*) from schedule_state) as schedules",
        )
      ).rows,
    ).toEqual(before.rows);
  });
  it("real durable recurrence survives worker and Restate restart; duplicate bootstrap creates no second chain", async () => {
    await startWorker();
    const registration = await fetch(`${admin}/deployments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        uri: `http://host.docker.internal:${workerPort}`,
        force: true,
      }),
    });
    expect(registration.ok).toBe(true);
    expect((await post("tick", { sequence: 0 })).result).toBe("OK");
    expect((await post("tick", { sequence: 0 })).result).toBe(
      "DUPLICATE_OR_OUT_OF_ORDER",
    );
    await until(
      () => post("status"),
      (s) => Number(s.nextSequence) >= 2,
      20000,
    );
    const stoppedAt = Number((await post("status")).nextSequence);
    await stopWorker();
    // The journal/timer belongs to this disposable container and survives restart.
    docker("restart", restateName);
    // Docker can reassign ephemeral published ports on container restart.
    admin = `http://127.0.0.1:${port(restateName, 9070)}`;
    ingress = `http://127.0.0.1:${port(restateName, 8080)}`;
    await until(
      () => fetch(`${admin}/health`),
      (r) => r.ok,
      20000,
    );
    await startWorker();
    await until(
      () => post("status"),
      (s) => Number(s.nextSequence) >= Math.max(stoppedAt + 1, 3),
      30000,
    );
    const rows = await pool.query(
      "select occurrence_count from kernel_private.alert_state where entity_id='live-monitor-test'",
    );
    expect(rows.rowCount).toBe(2);
    expect(rows.rows.every((r) => r.occurrence_count >= 3)).toBe(true);
    const pending = await until(
      () => createRestateAdminClient(admin).invocationsForKey("production"),
      (invocations) => invocations.filter((i) => i.status === "scheduled").length === 1,
      10000,
    );
    expect(pending.filter((i) => i.status === "scheduled")).toHaveLength(1);
    expect(logs.join("")).toContain('"notificationsAttempted":2');
    expect(logs.join("").match(/"notificationsAttempted":2/g)).toHaveLength(1);
    expect(logs.join("")).toContain('"notificationsAttempted":0');
    expect(logs.join("")).not.toContain("credential-like-test-marker");
  }, 90000);
});
