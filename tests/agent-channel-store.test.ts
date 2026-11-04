import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChannelService,
  InMemoryChannelStore,
  PostgresAgentRegistry,
  PostgresChannelStore,
  type ChannelStore,
  type MessageDraft,
} from "../packages/agent-channel/src/index.js";
import type { TenantContext } from "../packages/contracts/src/index.js";
import { DATABASE, compose, until } from "./support/local.js";

const ROOM_DATABASE = "agent_room_test";

function draft(author: MessageDraft["author"], handle: string, body: string, key: string, threadId: string): MessageDraft {
  return {
    kind: "NOTE",
    author,
    handle,
    body,
    redacted: false,
    threadId,
    inReplyTo: null,
    taskRef: null,
    idempotencyKey: key,
  };
}

/**
 * Store-level checks. These call the store directly, with no route in front.
 * The same steps run against the in-memory store and against the disposable Postgres
 * at DATABASE (tests/support/local.ts), the same URL the other database suites use.
 */
async function exerciseStore(store: ChannelStore) {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const authorA = { id: randomUUID(), kind: "SERVICE" as const };
  const authorB = { id: randomUUID(), kind: "SERVICE" as const };
  const shared = randomUUID();
  const otherA = randomUUID();
  const threadA = randomUUID();
  const threadB = randomUUID();
  const recipientsA = [
    { principalId: shared, handle: "shared" },
    { principalId: otherA, handle: "other-a" },
  ];
  const recipientsB = [{ principalId: shared, handle: "shared-b" }];

  const first = await store.append(tenantA, draft(authorA, "alpha", "only-a", "store-key-1", threadA), recipientsA);
  expect(first.duplicate).toBe(false);
  expect(first.message.tenantId).toBe(tenantA);
  expect(first.message.author).toEqual(authorA);
  expect((await store.list(tenantB, { after: 0, limit: 20 })).map((m) => m.body)).toEqual([]);
  expect(await store.get(tenantB, first.message.id)).toBeNull();

  const replay = await store.append(tenantA, draft(authorA, "alpha", "only-a", "store-key-1", threadA), recipientsA);
  expect(replay.duplicate).toBe(true);
  expect(replay.message.id).toBe(first.message.id);
  expect(await store.deliveries(tenantA, [first.message.id])).toHaveLength(2);
  await expect(
    store.append(tenantA, draft(authorA, "alpha", "changed", "store-key-1", threadA), recipientsA),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await store.deliveries(tenantA, [first.message.id])).toHaveLength(2);

  const second = await store.append(tenantB, draft(authorB, "beta", "only-b", "store-key-b", threadB), recipientsB);
  expect((await store.list(tenantA, { after: 0, limit: 20 })).map((m) => m.body)).toEqual(["only-a"]);
  expect((await store.list(tenantB, { after: 0, limit: 20 })).map((m) => m.id)).toEqual([second.message.id]);

  await store.markDelivered(tenantB, shared, [first.message.id]);
  expect((await store.deliveries(tenantA, [first.message.id])).every((row) => row.state === "pending")).toBe(true);
  await store.ack(tenantB, { principalId: shared, handle: "shared-b", upToSeq: 1 });
  expect(await store.acks(tenantA)).toEqual([]);
  expect((await store.deliveries(tenantA, [first.message.id])).every((row) => row.state === "pending")).toBe(true);
  expect((await store.deliveries(tenantB, [second.message.id])).every((row) => row.state === "acked")).toBe(true);

  const third = await store.append(tenantA, draft(authorA, "alpha", "later", "store-key-2", threadA), recipientsA);
  const page = await store.list(tenantA, { after: first.message.seq, limit: 20 });
  expect(page.map((m) => [m.seq, m.body])).toEqual([[third.message.seq, "later"]]);
  expect(page.map((m) => m.seq)).toEqual([...page.map((m) => m.seq)].sort((a, b) => a - b));

  await store.markDelivered(tenantA, shared, [first.message.id, third.message.id]);
  expect((await store.deliveries(tenantA)).filter((row) => row.recipientId === shared).map((row) => row.state)).toEqual([
    "delivered",
    "delivered",
  ]);
  const acked = await store.ack(tenantA, { principalId: shared, handle: "shared", upToSeq: third.message.seq });
  const again = await store.ack(tenantA, { principalId: shared, handle: "shared", upToSeq: third.message.seq });
  const rewind = await store.ack(tenantA, { principalId: shared, handle: "shared", upToSeq: first.message.seq });
  expect(acked.upToSeq).toBe(third.message.seq);
  expect(again.upToSeq).toBe(third.message.seq);
  expect(rewind.upToSeq).toBe(third.message.seq);
  await store.markDelivered(tenantA, shared, [first.message.id, third.message.id]);
  expect((await store.deliveries(tenantA)).filter((row) => row.recipientId === shared).every((row) => row.state === "acked")).toBe(true);
  expect((await store.deliveries(tenantA)).filter((row) => row.recipientId === otherA).every((row) => row.state === "pending")).toBe(true);

  const threads = await store.threads(tenantA);
  expect(threads.map((thread) => thread.threadId)).toContain(threadA);
  expect(threads.some((thread) => thread.threadId === threadB)).toBe(false);
  await expect(store.list("not-a-tenant", { after: 0, limit: 1 })).rejects.toThrow();
  return { tenantA, tenantB, authorA, authorB, shared, otherA, firstId: first.message.id };
}

describe("in-memory store", () => {
  it("keeps tenants, idempotency, catch-up order and acks inside the store", async () => {
    await exerciseStore(new InMemoryChannelStore());
  });
});

function withDatabase(name: string): string {
  const url = new URL(DATABASE);
  url.pathname = `/${name}`;
  return url.toString();
}

async function ensureDatabase(name: string) {
  compose("up", "-d", "db");
  const admin = new pg.Pool({ connectionString: withDatabase("postgres") });
  try {
    await until(() => admin.query("select 1"), (result) => result.rowCount === 1);
    const exists = await admin.query("select 1 from pg_database where datname = $1", [name]);
    if ((exists.rowCount ?? 0) === 0) await admin.query(`create database ${quoteIdent(name)}`);
  } finally {
    await admin.end();
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-z_]+$/.test(name)) throw new Error("unsafe database name");
  return name;
}

async function applyProposal(pool: pg.Pool) {
  await pool.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$`);
  await pool.query(`create table if not exists principals (
    id uuid primary key,
    kind text not null check (kind in ('HUMAN','SERVICE'))
  )`);
  await pool.query("create table if not exists tenants (id uuid primary key, name text not null)");
  await pool.query(`create table if not exists tenant_memberships (
    tenant_id uuid not null references tenants(id),
    principal_id uuid not null references principals(id),
    role text not null,
    status text not null default 'ACTIVE' check (status in ('ACTIVE','REVOKED','REMOVED')),
    primary key (tenant_id, principal_id)
  )`);
  await pool.query(readFileSync("docs/proposals/agent-channel/20261104130000_agent_channel.sql.proposed", "utf8"));
  await pool.query("grant agent_channel to current_user");
}

describe("postgres store", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    await ensureDatabase(ROOM_DATABASE);
    pool = new pg.Pool({ connectionString: withDatabase(ROOM_DATABASE) });
    await applyProposal(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });

  async function reset(ids: { tenants: string[]; principals: { id: string; kind: "HUMAN" | "SERVICE" }[] }) {
    await pool.query(
      "truncate agent_channel_deliveries, agent_channel_acks, agent_channel_messages, agent_channel_members, agent_channel_counters",
    );
    for (const tenant of ids.tenants) {
      await pool.query("insert into tenants (id, name) values ($1, 'room') on conflict (id) do nothing", [tenant]);
    }
    for (const principal of ids.principals) {
      await pool.query("insert into principals (id, kind) values ($1, $2) on conflict (id) do nothing", [
        principal.id,
        principal.kind,
      ]);
    }
  }

  it("keeps tenants, idempotency, catch-up order and acks inside the database", async () => {
    const result = await exercisePrepared(pool, new PostgresChannelStore(pool));
    expect(result.firstId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses a backwards delivery update and an update of a stored message", async () => {
    const { tenantA, shared, firstId } = await exercisePrepared(pool, new PostgresChannelStore(pool));
    await expect(pool.query("update agent_channel_messages set body = 'rewritten' where id = $1", [firstId])).rejects.toThrow(
      /append-only/,
    );
    await expect(
      pool.query("update agent_channel_deliveries set state = 'pending' where tenant_id = $1 and recipient_id = $2", [
        tenantA,
        shared,
      ]),
    ).rejects.toThrow(/cannot move backwards/);
  });

  it("isolates rows with the agent_channel role and does not grant ledger tables", async () => {
    const { tenantA, tenantB, shared } = await exercisePrepared(pool, new PostgresChannelStore(pool));
    await pool.query("create table if not exists tasks (id int primary key)");
    await pool.query("insert into tasks (id) values (1) on conflict do nothing");
    const grantedByProposal = await pool.query(
      "select privilege_type from information_schema.role_table_grants where grantee = 'agent_channel' and table_name = 'tasks'",
    );
    expect(grantedByProposal.rows).toEqual([]);
    const messageUpdate = await pool.query(
      "select privilege_type from information_schema.role_table_grants where grantee = 'agent_channel' and table_name = 'agent_channel_messages' and privilege_type = 'update'",
    );
    expect(messageUpdate.rows).toEqual([]);
    await pool.query("grant select, insert on tasks to agent_channel");
    await pool.query("alter table tasks enable row level security");
    await pool.query("alter table tasks force row level security");

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role agent_channel");
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantA]);
      const messages = await client.query<{ tenant_id: string }>("select tenant_id from agent_channel_messages");
      expect(messages.rows.length).toBeGreaterThan(0);
      expect(messages.rows.every((row) => row.tenant_id === tenantA)).toBe(true);
      expect(messages.rows.some((row) => row.tenant_id === tenantB)).toBe(false);
      const ledger = await client.query("select id from tasks");
      expect(ledger.rows).toEqual([]);
      await client.query("savepoint bad_tenant");
      await expect(
        client.query(
          `insert into agent_channel_messages (
             id, tenant_id, seq, thread_id, kind, author_id, author_kind, handle,
             body, redacted, idempotency_key, content_hash
           ) values ($1,$2,1,$3,'NOTE',$4,'SERVICE','alpha','no',false,'store-key-9',$5)`,
          [randomUUID(), tenantB, randomUUID(), shared, "a".repeat(64)],
        ),
      ).rejects.toThrow(/row-level security|violates/);
      await client.query("rollback to savepoint bad_tenant");
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("resolves handles only inside the tenant on the registry", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const principal = randomUUID();
    await reset({
      tenants: [tenantA, tenantB],
      principals: [{ id: principal, kind: "SERVICE" }],
    });
    const other = randomUUID();
    await pool.query(
      `insert into agent_channel_members (id, tenant_id, handle, kind, status) values
         ($1,$2,'codex','SERVICE','ACTIVE'), ($3,$4,'grok','SERVICE','ACTIVE')`,
      [principal, tenantA, other, tenantB],
    );
    await expect(
      pool.query(
        `insert into agent_channel_members (id, tenant_id, handle, kind, status) values ($1,$2,'codex','SERVICE','ACTIVE')`,
        [randomUUID(), tenantA],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await pool.query(
      `insert into agent_channel_members (id, tenant_id, handle, kind, status) values ($1,$2,'codex','SERVICE','ACTIVE')`,
      [randomUUID(), tenantB],
    );
    const registry = new PostgresAgentRegistry(pool);
    const contextA: TenantContext = { tenantId: tenantA, principal: { id: principal, kind: "SERVICE" } };
    expect(await registry.handleFor(contextA)).toBe("codex");
    expect(await registry.members(tenantA)).toEqual([{ principalId: principal, handle: "codex" }]);
    expect(await registry.handleFor({ tenantId: tenantB, principal: { id: principal, kind: "SERVICE" } })).toBeNull();
    expect(await registry.members(tenantB)).toEqual([
      { principalId: expect.any(String), handle: "codex" },
      { principalId: other, handle: "grok" },
    ]);
    const store = new PostgresChannelStore(pool);
    const service = new ChannelService(store, registry);
    const posted = await service.post(contextA, { kind: "NOTE", body: "from codex", idempotencyKey: "registry-key-1" });
    expect(posted.message.handle).toBe("codex");
    await expect(service.read({ tenantId: tenantB, principal: { id: randomUUID(), kind: "SERVICE" } }, {})).rejects.toMatchObject({
      code: "DENIED",
    });
    await expect(service.read({ tenantId: tenantB, principal: { id: principal, kind: "SERVICE" } }, {})).rejects.toMatchObject({ code: "DENIED" });
    await expect(service.post({ tenantId: tenantB, principal: { id: principal, kind: "SERVICE" } }, { kind: "NOTE", body: "cross", idempotencyKey: "cross-tenant-key" })).rejects.toMatchObject({ code: "DENIED" });
    await expect(service.ack({ tenantId: tenantB, principal: { id: principal, kind: "SERVICE" } }, { upToSeq: 1 })).rejects.toMatchObject({ code: "DENIED" });
    expect((await service.read({ tenantId: tenantB, principal: { id: other, kind: "SERVICE" } }, {})).messages).toEqual([]);
  });

  it("logs in as agent_room_app, serves the channel, and refuses a revoked member", async () => {
    const password = randomBytes(24).toString("base64url");
    const built = await pool.query<{ sql: string }>(
      "select format('alter role agent_room_app with login password %L', $1::text) as sql",
      [password],
    );
    const statement = built.rows[0]?.sql;
    if (!statement) throw new Error("could not build the test role statement");
    try {
      await pool.query(statement);
    } catch {
      throw new Error("could not set the test role password");
    }
    const tenantId = randomUUID();
    const principalId = randomUUID();
    await pool.query(
      "truncate agent_channel_deliveries, agent_channel_acks, agent_channel_messages, agent_channel_members, agent_channel_counters",
    );
    await pool.query("insert into tenants (id, name) values ($1, 'room') on conflict (id) do nothing", [tenantId]);
    await pool.query(
      `insert into agent_channel_members (id, tenant_id, handle, kind, status) values ($1,$2,'codex','SERVICE','ACTIVE')`,
      [principalId, tenantId],
    );
    await pool.query("create table if not exists tasks (id int primary key)");
    await pool.query("create table if not exists task_events (id int primary key)");
    await pool.query("revoke all privileges on table tasks from public, agent_channel, agent_room_app");
    await pool.query("revoke all privileges on table task_events from public, agent_channel, agent_room_app");
    await pool.query("revoke all privileges on table tenant_memberships from public, agent_channel, agent_room_app");
    await pool.query("revoke all privileges on table principals from public, agent_channel, agent_room_app");

    const door = new URL(DATABASE);
    const app = new pg.Pool({
      host: door.hostname,
      port: Number(door.port || 5432),
      user: "agent_room_app",
      password,
      database: ROOM_DATABASE,
    });
    try {
      const who = await app.query<{ current_user: string }>("select current_user");
      expect(who.rows[0]?.current_user).toBe("agent_room_app");
      const context: TenantContext = { tenantId, principal: { id: principalId, kind: "SERVICE" } };
      const service = new ChannelService(new PostgresChannelStore(app), new PostgresAgentRegistry(app));
      const posted = await service.post(context, { kind: "NOTE", body: "from the room role", idempotencyKey: "app-role-key-1" });
      expect(posted.duplicate).toBe(false);
      const seen = await service.read(context, { after: 0 });
      expect(seen.messages.map((message) => message.id)).toEqual([posted.message.id]);
      const acked = await service.ack(context, { upToSeq: posted.message.seq });
      expect(acked.upToSeq).toBe(posted.message.seq);
      await expect(app.query("select 1 from tasks")).rejects.toMatchObject({ code: "42501" });
      await expect(app.query("insert into tasks (id) values (1)")).rejects.toMatchObject({ code: "42501" });
      await expect(app.query("select 1 from task_events")).rejects.toMatchObject({ code: "42501" });
      await expect(app.query("insert into task_events (id) values (1)")).rejects.toMatchObject({ code: "42501" });
      await expect(app.query("select * from tenant_memberships")).rejects.toMatchObject({ code: "42501" });
      await expect(app.query("select id from principals")).rejects.toMatchObject({ code: "42501" });

      await pool.query("update agent_channel_members set status = 'REVOKED' where id = $1", [principalId]);
      const note = { kind: "NOTE", body: "after revoke", idempotencyKey: "app-role-key-2" };
      await expect(service.post(context, note)).rejects.toMatchObject({ code: "DENIED" });
      await expect(service.read(context, {})).rejects.toMatchObject({ code: "DENIED" });
      await expect(service.ack(context, { upToSeq: posted.message.seq })).rejects.toMatchObject({ code: "DENIED" });
    } finally {
      await app.end();
    }
  });

  it("runs a two-agent round trip and records delivery and ack", async () => {
    const tenantId = randomUUID();
    const agentA = randomUUID();
    const agentB = randomUUID();
    await pool.query("insert into tenants (id, name) values ($1, 'room') on conflict (id) do nothing", [tenantId]);
    await pool.query(
      `insert into agent_channel_members (id, tenant_id, handle, kind, status) values
         ($1,$3,'codex','SERVICE','ACTIVE'), ($2,$3,'claude-code','SERVICE','ACTIVE')`,
      [agentA, agentB, tenantId],
    );
    const registry = new PostgresAgentRegistry(pool);
    const store = new PostgresChannelStore(pool);
    const service = new ChannelService(store, registry);
    const a: TenantContext = { tenantId, principal: { id: agentA, kind: "SERVICE" } };
    const b: TenantContext = { tenantId, principal: { id: agentB, kind: "SERVICE" } };
    const sent = await service.post(a, { kind: "NOTE", body: "from codex", idempotencyKey: "round-trip-key-1" });
    const seen = await service.read(b, { after: 0 });
    expect(seen.messages.map((message) => message.id)).toEqual([sent.message.id]);
    expect((await store.deliveries(tenantId, [sent.message.id])).find((row) => row.recipientId === agentB)?.state).toBe("delivered");
    const acked = await service.ack(b, { upToSeq: sent.message.seq });
    const cursors = await service.cursors(a);
    expect(cursors.find((cursor) => cursor.principalId === agentB)?.upToSeq).toBe(acked.upToSeq);
    const row = await pool.query<{ state: string; updated_at: Date; message_id: string }>(
      `select state, updated_at, message_id from agent_channel_deliveries where tenant_id = $1 and recipient_id = $2`,
      [tenantId, agentB],
    );
    expect(row.rows[0]?.message_id).toBe(sent.message.id);
    expect(row.rows[0]?.state).toBe("acked");
    expect(row.rows[0]?.updated_at).toBeInstanceOf(Date);
  });

  it("drops only the channel objects", async () => {
    await pool.query("create table if not exists tasks (id int primary key)");
    await pool.query("insert into tasks (id) values (7) on conflict (id) do update set id = excluded.id");
    await pool.query(readFileSync("docs/proposals/agent-channel/20261104130000_agent_channel_rollback.sql.proposed", "utf8"));
    await expect(pool.query("select 1 from agent_channel_messages")).rejects.toThrow(/does not exist|agent_channel_messages/);
    expect((await pool.query("select id from tasks where id = 7")).rows).toEqual([{ id: 7 }]);
    expect((await pool.query("select 1 from pg_roles where rolname = 'agent_channel'")).rowCount).toBe(0);
    expect((await pool.query("select 1 from pg_roles where rolname = 'agent_room_app'")).rowCount).toBe(0);
  });
});

async function exercisePrepared(pool: pg.Pool, store: ChannelStore) {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const authorA = { id: randomUUID(), kind: "SERVICE" as const };
  const authorB = { id: randomUUID(), kind: "SERVICE" as const };
  const shared = randomUUID();
  const otherA = randomUUID();
  await pool.query(
    "truncate agent_channel_deliveries, agent_channel_acks, agent_channel_messages, agent_channel_members, agent_channel_counters",
  );
  for (const tenant of [tenantA, tenantB]) {
    await pool.query("insert into tenants (id, name) values ($1, 'room') on conflict (id) do nothing", [tenant]);
  }
  const sharedB = randomUUID();
  const people = [
    [authorA.id, tenantA, "alpha"],
    [otherA, tenantA, "other-a"],
    [shared, tenantA, "shared"],
    [authorB.id, tenantB, "beta"],
    [sharedB, tenantB, "shared-b"],
  ] as const;
  for (const [id, tenant, handle] of people) {
    await pool.query(
      `insert into agent_channel_members (id, tenant_id, handle, kind, status) values ($1,$2,$3,'SERVICE','ACTIVE')`,
      [id, tenant, handle],
    );
  }
  const bound = new TenantBoundStore(store, { tenantA, tenantB, authorA, authorB, shared, sharedB, otherA });
  await bound.run();
  return { tenantA, tenantB, shared, firstId: bound.firstId };
}

class TenantBoundStore {
  firstId = "";
  constructor(
    private readonly store: ChannelStore,
    private readonly ids: {
      tenantA: string;
      tenantB: string;
      authorA: { id: string; kind: "SERVICE" };
      authorB: { id: string; kind: "SERVICE" };
      shared: string;
      sharedB: string;
      otherA: string;
    },
  ) {}
  async run() {
    const { tenantA, tenantB, authorA, authorB, shared, sharedB, otherA } = this.ids;
    const threadA = randomUUID();
    const threadB = randomUUID();
    const recipientsA = [
      { principalId: shared, handle: "shared" },
      { principalId: otherA, handle: "other-a" },
    ];
    const recipientsB = [{ principalId: sharedB, handle: "shared-b" }];
    const first = await this.store.append(tenantA, draft(authorA, "alpha", "only-a", "store-key-1", threadA), recipientsA);
    this.firstId = first.message.id;
    expect(first.duplicate).toBe(false);
    expect(await this.store.get(tenantB, first.message.id)).toBeNull();
    const replay = await this.store.append(tenantA, draft(authorA, "alpha", "only-a", "store-key-1", threadA), recipientsA);
    expect(replay).toMatchObject({ duplicate: true, message: { id: first.message.id } });
    expect(await this.store.deliveries(tenantA, [first.message.id])).toHaveLength(2);
    await expect(this.store.append(tenantA, draft(authorA, "alpha", "changed", "store-key-1", threadA), recipientsA)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const second = await this.store.append(tenantB, draft(authorB, "beta", "only-b", "store-key-b", threadB), recipientsB);
    expect((await this.store.list(tenantA, { after: 0, limit: 20 })).map((m) => m.body)).toEqual(["only-a"]);
    expect((await this.store.list(tenantB, { after: 0, limit: 20 })).map((m) => m.body)).toEqual(["only-b"]);
    await this.store.markDelivered(tenantB, sharedB, [first.message.id]);
    await this.store.ack(tenantB, { principalId: sharedB, handle: "shared-b", upToSeq: second.message.seq });
    expect(await this.store.acks(tenantA)).toEqual([]);
    expect((await this.store.deliveries(tenantA)).every((row) => row.state === "pending")).toBe(true);
    const third = await this.store.append(tenantA, draft(authorA, "alpha", "later", "store-key-2", threadA), recipientsA);
    const page = await this.store.list(tenantA, { after: first.message.seq, limit: 20 });
    expect(page.map((m) => m.body)).toEqual(["later"]);
    expect(page[0]?.seq).toBeGreaterThan(first.message.seq);
    expect(third.message.seq).toBe(page[0]?.seq);
    await this.store.ack(tenantA, { principalId: shared, handle: "shared", upToSeq: third.message.seq });
    const again = await this.store.ack(tenantA, { principalId: shared, handle: "shared", upToSeq: 1 });
    expect(again.upToSeq).toBe(third.message.seq);
    await this.store.markDelivered(tenantA, shared, [first.message.id, third.message.id]);
    expect((await this.store.deliveries(tenantA)).filter((row) => row.recipientId === shared).every((row) => row.state === "acked")).toBe(
      true,
    );
  }
}

