import { execFileSync, spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { assertBaseEnvironment, assertBaseTarget, baseMigrationFiles } from "../../scripts/b1/base-guard.mjs";
export const DATABASE = "postgresql://postgres@127.0.0.1:55432/kerneljson";
export const INGRESS = "http://127.0.0.1:18080";
export const ADMIN = "http://127.0.0.1:19070";
export function holdRuntime(): () => void {
  const distro = process.env["KERNELJSON_DOCKER_WSL"];
  if (process.platform !== "win32" || !distro) return () => {};
  // WSL systemd services do not prevent idle shutdown. Keep one foreground process
  // alive for the suite; closing its stdin lets it exit without changing WSL settings.
  const child = spawn("wsl", ["-d", distro, "--", "cat"], {
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  return () => {
    child.stdin.end();
  };
}
/**
 * The compose stack of a database-backed file (ADR-0023 27.12.15). The file names its plan database with
 * useStackDatabase() before it starts the stack, and the worker connects to that database:
 *   - stage T: the suite's registered regression compose file (worker and Restate only, on the run network); the
 *     worker logs in as kj_worker to kj-eph-db:5432/<plan database>; no database service exists to start or stop;
 *   - lane A (harness mode `base`): the validation stack; no runtime role exists there, so the worker connects as the
 *     owner, exactly as it did before B1. Lane A never applies B1 and establishes nothing about it.
 */
const STAGE_T = process.env["KJ_B1_STAGE_T"] === "1";
let stackDatabase: string | undefined;
export function useStackDatabase(name: string): void {
  if (!/^kj_[a-z0-9_]+$/.test(name)) throw new Error("STACK_REFUSED: invalid plan database name");
  stackDatabase = name;
}
function composeEnvironment(args: readonly string[]): NodeJS.ProcessEnv {
  if (STAGE_T) {
    // compose interpolates the whole file even for `down`, which connects to nothing: a file may stop the project
    // before it names its plan database, with the same placeholder the runner uses for its own `down` after stage T.
    const database = stackDatabase ?? (args[0] === "down" ? "kj_down" : undefined);
    if (!database) throw new Error("STACK_REFUSED: the file has not named its plan database");
    return { ...process.env, KJ_WORKER_DATABASE_URL: `postgresql://kj_worker@kj-eph-db:5432/${database}`,
      KJ_TEST_OWNER_DATABASE_URL: `postgresql://postgres@kj-eph-db:5432/${database}` };
  }
  if (process.env["KJ_RUNTIME_ROLES"] !== "base") return process.env;
  const database = stackDatabase ?? "kerneljson";
  return { ...process.env, KJ_WORKER_DATABASE_URL: `postgresql://postgres@db:5432/${database}`,
    KJ_TEST_OWNER_DATABASE_URL: `postgresql://postgres@db:5432/${database}`, KJ_RUNTIME_ROLES: "base" };
}
function composeFile(): string {
  if (!STAGE_T) return resolve("infrastructure/docker/validation.compose.yaml");
  const file = process.env["KJ_B1_COMPOSE_FILE"];
  if (!file || !/regression\.compose\.yaml$/.test(file)) throw new Error("STACK_REFUSED: no regression compose file for this suite");
  return file;
}
export function compose(...args: string[]): string {
  const file = composeFile();
  if (STAGE_T && args.includes("db")) throw new Error("STACK_REFUSED: the run's cluster is not a compose service");
  const dockerArgs = ["compose", "-f", file, ...args];
  if (process.platform === "win32" && process.env["KERNELJSON_DOCKER_WSL"]) {
    const linuxFile =
      "/mnt/" + file[0]!.toLowerCase() + file.slice(2).replaceAll("\\", "/");
    return execFileSync(
      "wsl",
      [
        "-d",
        process.env["KERNELJSON_DOCKER_WSL"],
        "--",
        "docker",
        "compose",
        "-f",
        linuxFile,
        ...args,
      ],
      { encoding: "utf8", timeout: 300000 },
    );
  }
  return execFileSync("docker", dockerArgs, {
    encoding: "utf8",
    timeout: 300000,
    env: composeEnvironment(args),
  });
}
export async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeout = 60000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await read();
      if (accept(result)) return result;
      last = result;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Local readiness timeout: ${String(last)}`);
}
/** Lane A only: working-copy base migrations, including authorized mutants, never B1. */
export async function migrate(pool: pg.Pool, options: { exclude?: readonly string[]; only?: readonly string[] } = {}): Promise<void> {
  assertBaseEnvironment();
  const files=baseMigrationFiles((await readdir("supabase/migrations")).filter(f=>f.endsWith(".sql")),options);
  await assertBaseTarget(pool);
  await pool.query(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  end $$`);
  for (const file of files) {
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query(await readFile(`supabase/migrations/${file}`, "utf8"));
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    } finally {
      db.release();
    }
  }
  await assertBaseTarget(pool);
}
export async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${INGRESS}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}
