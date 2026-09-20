import { describe, it, expect } from "vitest";
import { CliError, admitMission, idempotencyKey, missionStatus, parseArgs, readBearer } from "../services/kernel/src/mission/mission-cli.js";

const BEARER = "SYNTHETIC-BEARER-VALUE-0123456789-abcdef";
const TASK = "842f3f95-cef9-8dfd-ae96-96a8c11382c7";
const read = () => `\uFEFF${BEARER}\r\n`;
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const base = { "door-url": "http://127.0.0.1:8081", "bearer-file": "/run/bearer" };

describe("KJ-P3 mission CLI", () => {
  it("refuses any flag that would carry a credential on the command line", () => {
    for (const flag of ["--bearer", "--token", "--authorization", "--secret", "--password"]) {
      expect(() => parseArgs(["admit", flag, BEARER])).toThrow(/never be passed as an argument/);
    }
  });

  it("requires the flags each command needs, and only --key value pairs", () => {
    expect(() => parseArgs(["admit", "--repo", "a/b"])).toThrow(/--label is required/);
    expect(() => parseArgs(["status", "--door-url", "http://x"])).toThrow(/--task-id is required/);
    expect(() => parseArgs(["admit", "--repo"])).toThrow(/key value pairs/);
    expect(() => parseArgs(["bogus"])).toThrow(/usage/);
    expect(parseArgs(["admit", "--repo", "a/b", "--label", "l1", "--door-url", "http://x", "--bearer-file", "/p"]).command).toBe("admit");
  });

  it("reads the bearer from a file, tolerating a BOM and CRLF, and rejects a malformed one without echoing it", () => {
    expect(readBearer("/p", read)).toBe(BEARER);
    let message = "";
    try { readBearer("/p", () => "short"); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/expected shape/);
    expect(() => readBearer("/missing", () => { throw new Error(`ENOENT ${BEARER}`); })).toThrow("bearer file could not be read");
  });

  it("admits the mission recipe through the door with the bearer only in a header, and a stable idempotency key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return ok({ taskId: TASK, status: "RECEIVED", dispatch: "ACCEPTED" }, 202); }) as unknown as typeof fetch;
    const out = await admitMission({ ...base, repo: "jonnyallum/kerneljson", label: "first", question: "What are the risks?" }, { fetch: fetchImpl, readFile: read });
    expect(out).toEqual([`admitted task ${TASK} status=RECEIVED dispatch=ACCEPTED`]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8081/v1/tasks");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["authorization"]).toBe(`Bearer ${BEARER}`);
    expect(h["idempotency-key"]).toBe(idempotencyKey("jonnyallum/kerneljson", "What are the risks?", "first"));
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ recipe: "repo-analysis-mission/v1", objective: "jonnyallum/kerneljson What are the risks?" });
    expect(out.join("")).not.toContain(BEARER);
  });

  it("KJ-P3.1 carries the requested finding count into the objective as a structured directive", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => { calls.push({ init }); return ok({ taskId: TASK, status: "RECEIVED", dispatch: "ACCEPTED" }, 202); }) as unknown as typeof fetch;
    await admitMission({ ...base, repo: "a/b", label: "l", findings: "3", question: "Top improvements?" }, { fetch: fetchImpl, readFile: read });
    await admitMission({ ...base, repo: "a/b", label: "l", "max-findings": "5" }, { fetch: fetchImpl, readFile: read });
    const objectives = calls.map((c) => (JSON.parse(c.init.body as string) as { objective: string }).objective);
    expect(objectives).toEqual(["a/b findings=3 Top improvements?", "a/b max-findings=5"]);
  });

  it("KJ-P3.1 treats a different requested count as a different request, and leaves an unchanged request's key alone", () => {
    expect(idempotencyKey("a/b", "q", "one", "findings=3")).not.toBe(idempotencyKey("a/b", "q", "one"));
    expect(idempotencyKey("a/b", "q", "one", "findings=3")).not.toBe(idempotencyKey("a/b", "q", "one", "findings=4"));
    expect(idempotencyKey("a/b", "q", "one", "findings=3")).toBe(idempotencyKey("a/b", "q", "one", "findings=3"));
    // Without a directive the key is exactly what it was before KJ-P3.1, so an existing label still replays.
    expect(idempotencyKey("a/b", "q", "one", "")).toBe(idempotencyKey("a/b", "q", "one"));
  });

  it("KJ-P3.1 rejects a bad count before any network call", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return ok({}); }) as unknown as typeof fetch;
    for (const bad of ["0", "13", "three", "-1", "2.5"]) {
      await expect(admitMission({ ...base, repo: "a/b", label: "l", findings: bad }, { fetch: fetchImpl, readFile: read }), bad).rejects.toThrow();
      await expect(admitMission({ ...base, repo: "a/b", label: "l", "max-findings": bad }, { fetch: fetchImpl, readFile: read }), bad).rejects.toThrow();
    }
    await expect(admitMission({ ...base, repo: "a/b", label: "l", findings: "3", "max-findings": "5" }, { fetch: fetchImpl, readFile: read })).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("uses a different key for a different label, and the same key for the same one", () => {
    expect(idempotencyKey("a/b", "q", "one")).toBe(idempotencyKey("a/b", "q", "one"));
    expect(idempotencyKey("a/b", "q", "one")).not.toBe(idempotencyKey("a/b", "q", "two"));
    expect(idempotencyKey("a/b", "q", "one")).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  });

  it("rejects a bad repository, a bad label and a non-http door before any network call", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return ok({}); }) as unknown as typeof fetch;
    await expect(admitMission({ ...base, repo: "../etc/passwd", label: "l" }, { fetch: fetchImpl, readFile: read })).rejects.toThrow();
    await expect(admitMission({ ...base, repo: "a/b", label: "bad label" }, { fetch: fetchImpl, readFile: read })).rejects.toThrow(/label/);
    await expect(admitMission({ ...base, "door-url": "file:///etc/passwd", repo: "a/b", label: "l" }, { fetch: fetchImpl, readFile: read })).rejects.toThrow(/http/);
    expect(called).toBe(false);
  });

  it("reports the door's refusals by status only", async () => {
    const respond = (status: number) => (async () => ok({ error: `nope ${BEARER}` }, status)) as unknown as typeof fetch;
    await expect(admitMission({ ...base, repo: "a/b", label: "l" }, { fetch: respond(409), readFile: read })).rejects.toThrow(/already used/);
    for (const s of [401, 429, 500]) {
      const err = await admitMission({ ...base, repo: "a/b", label: "l" }, { fetch: respond(s), readFile: read }).catch((e: unknown) => e as CliError);
      expect((err as Error).message).toBe(`the admission door returned HTTP ${s}`);
      expect((err as Error).message).not.toContain(BEARER);
    }
  });

  it("shows the task status, the outcome summary and evidence digests, never runtime text", async () => {
    const fetchImpl = (async (url: string) => url.endsWith("/evidence")
      ? ok([{ type: "TOOL_RECEIPT", source: "kerneljson:github-read/v1", digest: "a".repeat(64), metadata: { text: "SECRET RUNTIME TEXT" } }])
      : ok({ status: "COMPLETED", outcome: { status: "COMPLETED", summary: "Accepted: fine" } })) as unknown as typeof fetch;
    const out = (await missionStatus({ ...base, "task-id": TASK }, { fetch: fetchImpl, readFile: read })).join("\n");
    expect(out).toContain(`task ${TASK} status=COMPLETED`);
    expect(out).toContain("outcome COMPLETED: Accepted: fine");
    expect(out).toContain("evidence TOOL_RECEIPT kerneljson:github-read/v1 aaaaaaaaaaaa");
    expect(out).not.toContain("SECRET RUNTIME TEXT");
    expect(out).not.toContain(BEARER);
  });

  it("rejects a task id that is not a uuid", async () => {
    await expect(missionStatus({ ...base, "task-id": "../../x" }, { readFile: read })).rejects.toBeTruthy();
  });
});
