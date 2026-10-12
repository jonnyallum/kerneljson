/**
 * KJ-P8 B1 A10.7 Point 2 (2-R3, 2-R4, 2-R4a-d): running-image verification for the lane A database container.
 *
 * Binding (2-R4c): the container ID comes from `docker compose -f <validation compose> ps -q db`; that ID is inspected
 * (image ID, then the image's RepoDigests must contain the b1-engine-pins.json `image` digest) and its published
 * 5432/tcp binding (host 127.0.0.1) is the only address a lane A connection may use. The server identity
 * (version(), inet_server_port(), pg_control_system() system identifier) is read inside that ID with `docker exec`
 * and must equal what every handed-out connection reports. Only the image metadata is cached, keyed by container ID
 * (2-R4d); binding and identity are rechecked before every hand-out (installHandOutVerification), and a new container
 * ID is verified afresh (2-R4b).
 *
 * Attempt records (2-R4e): when a G7 driver set the attempt context, every verification attempt writes a started record
 * and then a completed or failed record (scripts/b1/mutation-infra.mjs). Classification only; no authenticity (F-4).
 * CLI: `node --import tsx scripts/b1/verify-engine-image.ts [--json]` exits nonzero on any mismatch or error.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { attemptContext, newAttemptId, RECORD_KIND, VERIFIER_PREFIX, writeAttemptRecord } from "./mutation-infra.mjs";

export const COMPOSE_FILE = "infrastructure/docker/validation.compose.yaml";
export const PINS_PATH = "infrastructure/database/b1-engine-pins.json";
export const IDENTITY_SQL = "select pg_catalog.version() as version, pg_catalog.inet_server_port() as port, " +
  "(select system_identifier::text from pg_catalog.pg_control_system()) as sid";
const DIGEST = /^postgres@sha256:[0-9a-f]{64}$/;

export interface Pins { image: string; serverVersion: string }
export interface Identity { version: string; serverPort: number; systemIdentifier: string }
export interface Verified { containerId: string; imageId: string; digest: string; repoDigestMatch: true; host: string; port: number; binding: string; identity: Identity }
/** Runs `docker <args>` and returns stdout; throws on a nonzero exit or spawn error. */
export type DockerRun = (args: readonly string[]) => string;
export interface Queryable { query(sql: string): Promise<{ rows: Record<string, unknown>[] }> }

export class EngineRefusal extends Error {
  constructor(readonly check: string, readonly detail: string, options?: ErrorOptions) { super(`${VERIFIER_PREFIX}: ${check}: ${detail}`, options); }
}
const refuse = (check: string, detail: string, cause?: unknown): never => { throw new EngineRefusal(check, detail, cause === undefined ? undefined : { cause }); };
const message = (error: unknown): string => String((error as Error)?.message ?? error);

export function readPins(root = process.cwd()): Pins {
  const pins = JSON.parse(readFileSync(join(root, PINS_PATH), "utf8")) as Partial<Pins>;
  if (typeof pins.image !== "string" || !DIGEST.test(pins.image) || typeof pins.serverVersion !== "string" || !pins.serverVersion)
    refuse("pins", "b1-engine-pins.json image or serverVersion is invalid");
  return { image: pins.image!, serverVersion: pins.serverVersion! };
}

/**
 * 2-R3 (static, DB-free): every `image:` in every compose file under infrastructure/docker that names postgres must
 * be byte-equal to the pinned reference; tag-only, tag@digest and any second digest are refused, and the
 * validation stack's db service must carry the pin.
 */
export function composeImageProblems(files: ReadonlyMap<string, string>, pins: Pins): string[] {
  const problems: string[] = [];
  let validationDb = false;
  for (const [name, text] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const lines = text.split(/\r?\n/);
    let service: string | undefined, inServices = false;
    lines.forEach((line, i) => {
      if (/^services:\s*$/.test(line)) { inServices = true; return; }
      if (/^\S/.test(line)) inServices = false;
      const svc = inServices ? /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line) : null;
      if (svc) service = svc[1];
      const m = /^\s*image:\s*["']?([^"'\s#]+)["']?\s*(#.*)?$/.exec(line);
      const mentions = /postgres/i.test(line) || /sha256:/.test(line);
      if (!m) { if (/^\s*image:/.test(line) || (mentions && /image/i.test(line))) problems.push(`${name}:${i + 1}: unparsable image reference`); return; }
      const ref = m[1]!;
      if (!/postgres/i.test(ref) && !/sha256:/.test(ref)) return;
      if (ref !== pins.image) problems.push(`${name}:${i + 1}: postgres image ${ref} is not the pinned ${pins.image}`);
      if (name.endsWith("validation.compose.yaml") && service === "db" && ref === pins.image) validationDb = true;
    });
  }
  if (!validationDb) problems.push(`validation.compose.yaml service db does not use the pinned ${pins.image}`);
  return problems;
}
export function readComposeFiles(root = process.cwd()): Map<string, string> {
  const dir = join(root, "infrastructure/docker");
  return new Map(readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).map(f => [`infrastructure/docker/${f}`, readFileSync(join(dir, f), "utf8")]));
}

/** The real docker runner, mirroring tests/support/local.ts compose() (including the WSL route). */
export function realDocker(): DockerRun {
  return (args) => {
    const wsl = process.platform === "win32" ? process.env["KERNELJSON_DOCKER_WSL"] : undefined;
    const mapped = wsl ? args.map(a => /^[A-Za-z]:\\/.test(a) ? "/mnt/" + a[0]!.toLowerCase() + a.slice(2).replaceAll("\\", "/") : a) : args;
    return wsl ? execFileSync("wsl", ["-d", wsl, "--", "docker", ...mapped], { encoding: "utf8", timeout: 120000, windowsHide: true })
      : execFileSync("docker", [...args], { encoding: "utf8", timeout: 120000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  };
}

function identityOf(row: Record<string, unknown> | undefined, check: string): Identity {
  if (!row || typeof row["version"] !== "string" || row["port"] === null || row["port"] === undefined || typeof row["sid"] !== "string")
    return refuse(check, "server identity row is incomplete");
  return { version: row["version"] as string, serverPort: Number(row["port"]), systemIdentifier: row["sid"] as string };
}

export interface VerifierDeps { docker: DockerRun; pins: Pins; composeFile: string; env?: NodeJS.ProcessEnv; now?: () => Date }
export class EngineVerifier {
  /** image metadata only, keyed by container ID (2-R4d) */
  private readonly images = new Map<string, { imageId: string; repoDigests: string[] }>();
  /** the identity recorded at verification, keyed by container ID */
  private readonly identities = new Map<string, Identity>();
  constructor(private readonly deps: VerifierDeps) {}
  private docker(check: string, args: readonly string[]): string {
    try { return this.deps.docker(args); } catch (error) { return refuse(check, `docker ${args.slice(0, 2).join(" ")} failed: ${String((error as Error).message ?? error).split("\n")[0]}`); }
  }
  containerId(): string {
    const ids = this.docker("container", ["compose", "-f", this.deps.composeFile, "ps", "-q", "db"]).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (ids.length !== 1 || !/^[0-9a-f]{64}$/.test(ids[0]!)) refuse("container", `expected exactly one running db container, found ${JSON.stringify(ids)}`);
    return ids[0]!;
  }
  /** docker inspect <id>: image ID, running state and the published 5432/tcp binding of that same ID. */
  private inspect(id: string): { imageId: string; host: string; port: number } {
    let info: { Id?: string; Image?: string; State?: { Running?: boolean }; NetworkSettings?: { Ports?: Record<string, { HostIp: string; HostPort: string }[] | null> } };
    try { info = (JSON.parse(this.docker("inspect", ["inspect", "--type", "container", id])) as typeof info[])[0]!; }
    catch (error) { if (error instanceof EngineRefusal) throw error; return refuse("inspect", "docker inspect output does not parse"); }
    if (!info || info.Id !== id) refuse("inspect", "docker inspect returned another container");
    if (info.State?.Running !== true) refuse("inspect", "the db container is not running");
    if (!/^sha256:[0-9a-f]{64}$/.test(info.Image ?? "")) refuse("image", "container image ID is malformed");
    const ports = info.NetworkSettings?.Ports?.["5432/tcp"] ?? [];
    if (ports.length !== 1 || ports[0]!.HostIp !== "127.0.0.1" || !/^[0-9]{1,5}$/.test(ports[0]!.HostPort))
      refuse("binding", `5432/tcp must be published exactly once on 127.0.0.1, found ${JSON.stringify(ports)}`);
    return { imageId: info.Image!, host: "127.0.0.1", port: Number(ports[0]!.HostPort) };
  }
  private image(id: string, imageId: string) {
    const cached = this.images.get(id);
    if (cached && cached.imageId === imageId) return cached;
    let repoDigests: unknown;
    try { repoDigests = JSON.parse(this.docker("image", ["image", "inspect", "--format", "{{json .RepoDigests}}", imageId])); }
    catch (error) { if (error instanceof EngineRefusal) throw error; return refuse("image", "RepoDigests do not parse"); }
    if (!Array.isArray(repoDigests) || !repoDigests.includes(this.deps.pins.image))
      refuse("digest", `image ${imageId} RepoDigests ${JSON.stringify(repoDigests)} lack the pinned ${this.deps.pins.image}`);
    const value = { imageId, repoDigests: repoDigests as string[] };
    this.images.set(id, value);
    return value;
  }
  private containerIdentity(id: string): Identity {
    const sql = `select json_build_object('version',version,'port',port,'sid',sid)::text from (${IDENTITY_SQL}) i`;
    const out = this.docker("identity", ["exec", id, "psql", "-X", "-q", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-At", "-c", sql]);
    let row: Record<string, unknown>;
    try { row = JSON.parse(out.trim()) as Record<string, unknown>; } catch { return refuse("identity", "container identity does not parse"); }
    return identityOf(row, "identity");
  }
  /** True once the db container answers inside its ID (readiness only; establishes nothing). */
  ready(): boolean {
    try { this.containerIdentity(this.containerId()); return true; } catch { return false; }
  }
  /** 2-R4 / 2-R4b: full container verification for the current ID; identity is recorded per ID. */
  verifyContainer(): Verified {
    const id = this.containerId(), meta = this.inspect(id), image = this.image(id, meta.imageId);
    let identity = this.identities.get(id);
    if (!identity) { identity = this.containerIdentity(id); this.identities.set(id, identity); }
    if (identity.version !== this.deps.pins.serverVersion) refuse("version", `version() ${JSON.stringify(identity.version)} differs from serverVersion`);
    return { containerId: id, imageId: image.imageId, digest: this.deps.pins.image, repoDigestMatch: true, host: meta.host, port: meta.port,
      binding: `${meta.host}:${meta.port}`, identity };
  }
  /**
   * 2-R4c / 2-R4d: before a connection is handed out. Rechecks the current binding (ps -q ID, inspect) and that the
   * connection's address is that binding, then compares the identity over the connection with the one recorded inside
   * the container. A mismatch drops the recorded identity, re-verifies once, and then refuses.
   */
  async verifyConnection(db: Queryable, target: { host: string; port: number }, file: string): Promise<Verified> {
    return this.attempt(file, async () => {
      for (let round = 0; ; round++) {
        const v = this.verifyContainer();
        if (target.host !== v.host || Number(target.port) !== v.port)
          refuse("url", `connection address ${target.host}:${target.port} is not the verified binding ${v.binding}`);
        let rows: Record<string, unknown>[];
        try { rows = (await db.query(IDENTITY_SQL)).rows; } catch (error) { return refuse("identity-connection", (error as Error).message); }
        const seen = identityOf(rows[0], "identity-connection");
        if (seen.version === v.identity.version && seen.serverPort === v.identity.serverPort && seen.systemIdentifier === v.identity.systemIdentifier) return v;
        if (round > 0) return refuse("identity-connection", `the connection reaches another server (system identifier ${seen.systemIdentifier}, verified ${v.identity.systemIdentifier})`);
        this.identities.delete(v.containerId);
      }
    });
  }
  /**
   * One verification attempt with its started and completed/failed records (2-R4e(1)). Every record write that fails
   * is itself a refusal carrying the verifier prefix, with the write error as its cause: a raw filesystem error would
   * reach a G7 report as an ordinary failed test and be counted as a kill (A10.7 v7 review R1).
   */
  async attempt(file: string, run: () => Promise<Verified>): Promise<Verified> {
    const ctx = attemptContext(this.deps.env ?? process.env), now = this.deps.now ?? (() => new Date());
    const base = ctx ? { kind: RECORD_KIND, nonce: ctx.nonce, label: ctx.label, attemptId: newAttemptId(), file } : undefined;
    const record = (phase: "started" | "completed" | "failed", fields: Record<string, unknown>): void => {
      if (!ctx || !base) return;
      try { writeAttemptRecord(ctx.dir, { ...base, phase, ...fields }); }
      catch (error) { refuse("record", `${phase} attempt record not written: ${message(error)}`, error); }
    };
    record("started", { startedAt: now().toISOString() });
    let v: Verified;
    try { v = await run(); }
    catch (error) {
      const refusal = error instanceof EngineRefusal ? error : new EngineRefusal("error", message(error), { cause: error });
      // A failed record that cannot be written leaves the started record unmatched, which the driver treats as FATAL.
      try { record("failed", { check: refusal.check, error: message(error).slice(0, 2000), failedAt: now().toISOString() }); }
      catch (written) { throw new EngineRefusal(refusal.check, `${refusal.detail}; ${(written as EngineRefusal).detail}`, { cause: refusal }); }
      throw refusal;
    }
    record("completed", { containerId: v.containerId, imageId: v.imageId, digest: v.digest, repoDigestMatch: true, binding: v.binding,
      version: v.identity.version, serverPort: v.identity.serverPort, systemIdentifier: v.identity.systemIdentifier, completedAt: now().toISOString() });
    return v;
  }
}

/** 2-R4c "no unproven URLs": an out-of-band database URL must address the verified binding. */
export function unprovenUrlProblems(env: NodeJS.ProcessEnv, v: Pick<Verified, "host" | "port" | "binding">): string[] {
  const out: string[] = [];
  for (const key of ["DATABASE_URL", "KJ_TEST_PG_URL"]) {
    const text = env[key];
    if (text === undefined) continue;
    let url: URL | undefined;
    try { url = new URL(text); } catch { /* refused below */ }
    if (!url || url.hostname !== v.host || Number(url.port) !== v.port) out.push(`${key} does not address the verified binding ${v.binding}`);
  }
  return out;
}

let shared: EngineVerifier | undefined;
/** One verifier per process (the image cache is per process, keyed by container ID). */
export function engineVerifier(root = process.cwd()): EngineVerifier {
  return shared ??= new EngineVerifier({ docker: realDocker(), pins: readPins(root), composeFile: resolve(root, COMPOSE_FILE) });
}

type PoolCallback = (err: Error | undefined, client?: pg.PoolClient, release?: pg.PoolClient["release"]) => void;
type ErrorListener = (error: Error) => void;
interface Connection extends Queryable { on(event: "error", listener: ErrorListener): unknown; removeListener(event: "error", listener: ErrorListener): unknown }
interface PoolState { options?: { onConnect?: unknown; verify?: unknown }; _clients?: unknown }
interface HandOutClasses { Pool: { prototype: object }; Client: { prototype: object } }
const NOOP = () => {};

/**
 * pg.Pool is pg's BoundPool, a subclass of pg-pool's Pool, and checkouts live on that base class: a hook on pg.Pool alone
 * misses a pg-pool Pool built directly (A10.7 v7 R2 hostile review). Refuses unless pg.Pool inherits both connect and
 * newClient from its base unchanged, so nothing in between can shadow the hook.
 */
export function pgPoolBase(): { prototype: object } {
  const base = Object.getPrototypeOf(pg.Pool) as { prototype: object } | null;
  const own = (o: object | undefined, k: string) => o !== undefined && Object.prototype.hasOwnProperty.call(o, k);
  if (!base?.prototype || own(pg.Pool.prototype, "connect") || own(pg.Pool.prototype, "newClient")
    || !own(base.prototype, "connect") || !own(base.prototype, "newClient"))
    refuse("hand-out", "pg.Pool does not inherit connect and newClient from pg-pool's Pool");
  return base!;
}

/**
 * 2-R4d: every connection the process hands out is verified for that hand-out (A10.7 v7 review R2). Installed on
 * pg-pool's Pool prototype (which pg.Pool inherits) and pg's Client prototype, so it covers every pool and client whoever
 * built it (the base factory, a consumer's pool on database.url or DATABASE, the pool given to migrate, a pg-pool Pool
 * built directly): every Pool checkout, a fresh client or a reused idle one (pool.query checks out through connect), and
 * every direct Client.connect. The caller receives the client only after the verification of that hand-out succeeded;
 * a refused pool client is destroyed (release with an error), never returned to the idle list, and a refused direct
 * client is ended. Nothing beyond 2-R4d's image metadata is cached.
 *
 * Exactly one verification per hand-out: a pool's new client is verified when the pool hands it out, not also when it
 * connects (newClient marks it). A pool with an onConnect or verify option hands the client to that code first, so its
 * new clients are also verified on connect. While a verification runs, an 'error' on the connection is captured and
 * refuses it (pg-pool has removed its idle listener at checkout; a direct client is still inside connect()), and the
 * listener stays until the refused connection is released or ended. Promise and callback forms keep pg's contracts:
 * Client.connect() resolves the client and its callback gets (null, client); a failed pool checkout calls back
 * (error, undefined, NOOP). In-process code can still replace these prototypes (F-4 trust boundary). Returns the
 * uninstall function.
 */
export function installHandOutVerification(verifier: () => EngineVerifier, file: () => string,
  { Pool, Client }: HandOutClasses = { Pool: pgPoolBase(), Client: pg.Client }): () => void {
  const pool = Pool.prototype as { connect: (cb?: PoolCallback) => Promise<pg.PoolClient> | void; newClient: (...args: unknown[]) => unknown };
  const client = Client.prototype as { connect: (cb?: (err: Error | null, client?: unknown) => void) => Promise<unknown> | void };
  const poolConnect = pool.connect, newClient = pool.newClient, clientConnect = client.connect;
  if (typeof poolConnect !== "function" || typeof newClient !== "function" || typeof clientConnect !== "function")
    refuse("hand-out", "the pool or client prototype lacks connect or newClient");
  const target = (c: object) => { const t = c as { host: string; port: number | string }; return { host: t.host, port: Number(t.port) }; };
  /** The pool whose newClient is running (synchronously, so its client's connect is the one marked). */
  let connecting: PoolState | undefined;
  const verify = async (c: Connection, cleanup: (error: Error) => Promise<unknown> | unknown): Promise<void> => {
    let failure: Error | undefined;
    const onError: ErrorListener = (error) => { failure ??= error; };
    c.on("error", onError);
    try {
      await verifier().verifyConnection(c, target(c), file());
      if (failure) refuse("identity-connection", `the connection failed during verification: ${message(failure)}`, failure);
    } catch (error) {
      await cleanup(error instanceof Error ? error : new Error(message(error)));
      throw error;
    } finally { c.removeListener("error", onError); }
  };
  pool.newClient = function (this: PoolState, ...args: unknown[]) {
    const outer = connecting;
    connecting = this.options?.onConnect || this.options?.verify ? undefined : this;
    try { return newClient.apply(this, args); } finally { connecting = outer; }
  };
  pool.connect = function (this: pg.Pool, cb?: PoolCallback) {
    const done = (poolConnect.call(this) as Promise<pg.PoolClient>).then(async (c) => {
      await verify(c as unknown as Connection, (error) => c.release(error));
      return c;
    });
    if (!cb) return done;
    void done.then((c) => cb(undefined, c, c.release), (error: Error) => cb(error, undefined, NOOP));
  };
  client.connect = function (this: pg.Client, cb?: (err: Error | null, client?: unknown) => void) {
    const clients = connecting?._clients;
    if (Array.isArray(clients) && clients.includes(this)) return clientConnect.call(this, cb);
    // Only a refused verification ends the client; pg's own connect errors (for example a second connect() on a live
    // client) pass through untouched, as without the wrapper.
    const done = (clientConnect.call(this) as Promise<unknown>)
      .then(() => verify(this as unknown as Connection, () => this.end().catch(() => {}))).then(() => this);
    if (!cb) return done;
    void done.then(() => cb(null, this), (error: Error) => cb(error));
  };
  return () => { pool.connect = poolConnect; pool.newClient = newClient; client.connect = clientConnect; };
}

async function main(argv: readonly string[]): Promise<number> {
  const json = argv.includes("--json");
  try {
    const problems = composeImageProblems(readComposeFiles(), readPins());
    if (problems.length) throw new EngineRefusal("compose", problems.join("; "));
    const verifier = engineVerifier(), v = verifier.verifyContainer();
    const client = new pg.Client({ host: v.host, port: v.port, user: "postgres", database: "postgres" });
    await client.connect();
    try { await verifier.verifyConnection(client, { host: v.host, port: v.port }, "scripts/b1/verify-engine-image.ts"); } finally { await client.end(); }
    const out = { containerId: v.containerId, imageId: v.imageId, digest: v.digest, binding: v.binding, version: v.identity.version,
      serverPort: v.identity.serverPort, systemIdentifier: v.identity.systemIdentifier };
    process.stdout.write(json ? `${JSON.stringify(out)}\n` : `ENGINE IMAGE VERIFIED ${v.containerId} ${v.digest} ${v.binding} sid ${v.identity.systemIdentifier}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
