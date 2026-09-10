import { execFileSync, spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
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
export function compose(...args: string[]): string {
  const file = resolve("infrastructure/docker/validation.compose.yaml");
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
export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  end $$`);
  for (const file of (await readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
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
}
export async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${INGRESS}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}
