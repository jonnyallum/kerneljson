import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { DATABASE, compose, holdRuntime, migrate, until } from "./support/local.js";
import {
  AuthenticatorUnavailableError,
  ControlAuthError,
  PgControlReplayStore,
  createControlSigner,
  createControlVerifier,
  sha256Hex,
  type ReplayRecord,
} from "../services/kernel/src/control-signing.js";
import { CONTROL_TEST_KEY } from "./support/control-test-key.js";

/**
 * KJ-P4B.1 against a real Postgres: the nonce table's SQL, its constraints, and the replay model on the
 * DATABASE's clock. Concurrency matters here because Restate can deliver the same durable work twice at once.
 */
const name = `kj_p4b1_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const admin = new pg.Pool({ connectionString: DATABASE, max: 1 });
let pool: pg.Pool;
let store: PgControlReplayStore;
let releaseRuntime = () => {};

beforeAll(async () => {
  releaseRuntime = holdRuntime();
  compose("up", "-d", "db");
  await until(() => admin.query("select 1"), (r) => r.rowCount === 1);
  await admin.query(`create database ${name}`);
  pool = new pg.Pool({ connectionString: DATABASE.replace(/\/kerneljson$/, `/${name}`), max: 12 });
  pool.on("error", () => {});
  await migrate(pool);
  store = new PgControlReplayStore(pool);
});

afterAll(async () => {
  await pool?.end();
  await until(
    () => admin.query("select count(*)::int as n from pg_stat_activity where datname = $1", [name]),
    (r) => r.rows[0].n === 0,
    15000,
  );
  await admin.query(`drop database if exists ${name}`);
  await admin.end();
  releaseRuntime();
});

const q = async <T extends pg.QueryResultRow>(sql: string, args: unknown[] = []) => (await pool.query<T>(sql, args)).rows;
const dbNow = async (): Promise<number> => Math.floor(Number((await q<{ s: string }>("select extract(epoch from now())::text as s"))[0]!.s));
let counter = 0;
const nonce = (): string => `n${Date.now().toString(36)}${(++counter).toString(36)}`.padEnd(22, "0");
const digest = (s: string): string => sha256Hex(s);
const rec = (over: Partial<ReplayRecord> & { issuedAt: number }): ReplayRecord => ({
  nonce: nonce(),
  keyId: "t1",
  digest: digest("a"),
  service: "GoldenTaskWorkflowV1",
  handler: "approve",
  key: randomUUID(),
  freshnessSeconds: 300,
  ...over,
});
const rowsFor = (n: string) => q<{ request_digest: string; key_id: string; service: string; handler: string; workflow_key: string; first_seen_at: Date; issued_at: Date }>(
  "select request_digest, key_id, service, handler, workflow_key, first_seen_at, issued_at from kernel_private.control_assertions where nonce = $1", [n]);

describe("KJ-P4B.1 the replay model on the database clock", () => {
  it("records a first-seen nonce within the window, with its digest and route parts, and nothing secret", async () => {
    const r = rec({ issuedAt: await dbNow() });
    expect(await store.admit(r)).toBe("FIRST_SEEN");
    const [row] = await rowsFor(r.nonce);
    expect(row).toMatchObject({ request_digest: r.digest, key_id: "t1", service: "GoldenTaskWorkflowV1", handler: "approve", workflow_key: r.key });
    expect(Math.abs(row!.first_seen_at.getTime() - Date.now())).toBeLessThan(60_000);
    const columns = (await q<{ column_name: string }>("select column_name from information_schema.columns where table_schema='kernel_private' and table_name='control_assertions' order by ordinal_position")).map((c) => c.column_name);
    expect(columns).toEqual(["nonce", "key_id", "request_digest", "issued_at", "first_seen_at", "service", "handler", "workflow_key"]);
  });

  it("accepts an identical redelivery, refuses the same nonce with a different digest, and keeps one row", async () => {
    const r = rec({ issuedAt: await dbNow() });
    expect(await store.admit(r)).toBe("FIRST_SEEN");
    expect(await store.admit({ ...r })).toBe("REPLAY");
    expect(await store.admit({ ...r })).toBe("REPLAY");
    expect(await store.admit({ ...r, digest: digest("b") })).toBe("CONFLICT");
    expect(await rowsFor(r.nonce)).toHaveLength(1);
    expect((await rowsFor(r.nonce))[0]!.request_digest).toBe(r.digest);
  });

  it("accepts a redelivery even when the assertion is by now far outside the window", async () => {
    const r = rec({ issuedAt: await dbNow() - 100 });
    expect(await store.admit({ ...r, freshnessSeconds: 300 })).toBe("FIRST_SEEN");
    // The same record judged against a window it no longer fits: seen before, identical, so accepted.
    expect(await store.admit({ ...r, freshnessSeconds: 30 })).toBe("REPLAY");
  });

  it("refuses a never-seen assertion outside the window, in the past or the future, and records nothing", async () => {
    const now = await dbNow();
    for (const issuedAt of [now - 310, now + 310, now - 86_400]) {
      const r = rec({ issuedAt });
      expect(await store.admit(r), String(issuedAt - now)).toBe("STALE");
      expect(await rowsFor(r.nonce)).toHaveLength(0);
    }
    for (const issuedAt of [now - 290, now + 290]) expect(await store.admit(rec({ issuedAt })), String(issuedAt - now)).toBe("FIRST_SEEN");
  });

  it("takes freshness from the database, not the caller's clock: an hour-fast caller is refused, an hour-slow one too", async () => {
    const localNow = Math.floor(Date.now() / 1000);
    expect(await store.admit(rec({ issuedAt: localNow + 3600 }))).toBe("STALE");
    expect(await store.admit(rec({ issuedAt: localNow - 3600 }))).toBe("STALE");
  });

  it("the window is the caller's configured one, applied on the database clock", async () => {
    const now = await dbNow();
    expect(await store.admit(rec({ issuedAt: now - 50, freshnessSeconds: 30 }))).toBe("STALE");
    expect(await store.admit(rec({ issuedAt: now - 50, freshnessSeconds: 3600 }))).toBe("FIRST_SEEN");
  });

  it("twenty simultaneous deliveries of the same assertion give exactly one first sight and no error", async () => {
    const r = rec({ issuedAt: await dbNow() });
    const verdicts = await Promise.all(Array.from({ length: 20 }, () => store.admit({ ...r })));
    expect(verdicts.filter((v) => v === "FIRST_SEEN")).toHaveLength(1);
    expect(verdicts.filter((v) => v === "REPLAY")).toHaveLength(19);
    expect(await rowsFor(r.nonce)).toHaveLength(1);
  });

  it("twenty simultaneous deliveries with two different digests let exactly one digest win", async () => {
    const r = rec({ issuedAt: await dbNow() });
    const verdicts = await Promise.all(Array.from({ length: 20 }, (_, i) => store.admit({ ...r, digest: digest(i % 2 === 0 ? "even" : "odd") })));
    expect(verdicts.filter((v) => v === "FIRST_SEEN")).toHaveLength(1);
    const winner = (await rowsFor(r.nonce))[0]!.request_digest;
    expect([digest("even"), digest("odd")]).toContain(winner);
    expect(verdicts.filter((v) => v === "REPLAY")).toHaveLength(9);
    expect(verdicts.filter((v) => v === "CONFLICT")).toHaveLength(10);
  });

  it("purges rows older than a week when a new one arrives, and a purged assertion is then stale, not accepted", async () => {
    const old = nonce();
    const oldIssued = (await dbNow()) - 8 * 86_400;
    await pool.query(
      "insert into kernel_private.control_assertions(nonce,key_id,request_digest,issued_at,first_seen_at,service,handler,workflow_key) values ($1,'t1',$2,to_timestamp($3),now() - interval '8 days','S','approve','k')",
      [old, digest("x"), oldIssued],
    );
    const recent = rec({ issuedAt: await dbNow() });
    await store.admit(recent);
    expect(await rowsFor(old)).toHaveLength(0);
    expect(await rowsFor(recent.nonce)).toHaveLength(1);
    expect(await store.admit(rec({ nonce: old, issuedAt: oldIssued, digest: digest("x") }))).toBe("STALE");
  });

  it("reports an unreachable database as unavailable, not as a refusal", async () => {
    const dead = new pg.Pool({ connectionString: "postgresql://postgres@127.0.0.1:1/none", max: 1, connectionTimeoutMillis: 500 });
    dead.on("error", () => {});
    await expect(new PgControlReplayStore(dead).admit(rec({ issuedAt: 1 }))).rejects.toBeInstanceOf(AuthenticatorUnavailableError);
    await dead.end();
  });
});

describe("KJ-P4B.1 the table refuses impossible states, and nothing but the service can reach it", () => {
  const bad = async (sql: string, args: unknown[]): Promise<string> => {
    try {
      await pool.query(sql, args);
    } catch (e) {
      return (e as { code?: string }).code ?? "ERR";
    }
    return "NO_ERROR";
  };
  const INSERT = "insert into kernel_private.control_assertions(nonce,key_id,request_digest,issued_at,service,handler,workflow_key) values ($1,$2,$3,now(),$4,$5,$6)";

  it("enforces the shapes of the nonce, key id, digest and route fields", async () => {
    const ok = ["N".repeat(22), "t1", digest("a"), "S", "approve", "k"];
    expect(await bad(INSERT, ["short", ...ok.slice(1)])).toBe("23514");
    expect(await bad(INSERT, [ok[0], "bad id", ...ok.slice(2)])).toBe("23514");
    expect(await bad(INSERT, [ok[0], ok[1], "not-a-digest", ...ok.slice(3)])).toBe("23514");
    expect(await bad(INSERT, [ok[0], ok[1], ok[2], "", ok[4], ok[5]])).toBe("23514");
    expect(await bad(INSERT, ok)).toBe("NO_ERROR");
    expect(await bad(INSERT, ok)).toBe("23505");
  });

  it("has row level security on and no privileges for anon or authenticated", async () => {
    const [r] = await q<{ rls: boolean; anon: boolean; authed: boolean }>(
      "select relrowsecurity as rls, has_table_privilege('anon','kernel_private.control_assertions','select,insert,update,delete') as anon, has_table_privilege('authenticated','kernel_private.control_assertions','select,insert,update,delete') as authed from pg_class where oid = 'kernel_private.control_assertions'::regclass",
    );
    expect(r).toEqual({ rls: true, anon: false, authed: false });
  });
});

describe("KJ-P4B.1 the verifier over the real store", () => {
  const TENANT = randomUUID();
  const PRINCIPAL = randomUUID();
  const TASK = randomUUID();
  const body = JSON.stringify({ scopeDigest: "a".repeat(64), decision: "GRANTED" });
  const req = { service: "GoldenTaskWorkflowV1", handler: "approve", key: TASK, body };
  const verify = () =>
    createControlVerifier({ keys: new Map([["t1", CONTROL_TEST_KEY]]), tenantId: TENANT, principalId: PRINCIPAL, freshnessSeconds: 300, replay: store });
  const sign = () => new Map(Object.entries(createControlSigner({ keyId: "t1", key: CONTROL_TEST_KEY })({ ...req, tenantId: TENANT, principalId: PRINCIPAL })));

  it("accepts a real signed request, accepts its redelivery, refuses a tampered copy, and records one nonce", async () => {
    const h = sign();
    expect(await verify()(h, req)).toEqual({ id: PRINCIPAL, kind: "HUMAN" });
    expect(await verify()(h, req)).toEqual({ id: PRINCIPAL, kind: "HUMAN" });
    await expect(verify()(h, { ...req, key: randomUUID() })).rejects.toBeInstanceOf(ControlAuthError);
    expect(await rowsFor(h.get("x-kj-control-nonce")!)).toHaveLength(1);
  });

  it("writes nothing for an assertion that does not verify", async () => {
    const before = Number((await q<{ n: string }>("select count(*)::text as n from kernel_private.control_assertions"))[0]!.n);
    const forged = sign();
    forged.set("x-kj-control-signature", "0".repeat(64));
    await expect(verify()(forged, req)).rejects.toBeInstanceOf(ControlAuthError);
    await expect(verify()(new Map(), req)).rejects.toBeInstanceOf(ControlAuthError);
    expect(Number((await q<{ n: string }>("select count(*)::text as n from kernel_private.control_assertions"))[0]!.n)).toBe(before);
  });
});
