import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { CliError } from "../services/kernel/src/mission/mission-cli.js";
import { admitApprovalTest, idempotencyKeyFor, objectiveFor, parseArgs } from "../services/kernel/src/approval-test-cli.js";

/** KJ-P4B: the harmless trigger for the first live approval. It submits and reads; it cannot approve. */
const BEARER = "SYNTHETIC-DOOR-BEARER-0123456789-abcdef";
const TASK = randomUUID();
const readFile = () => `${BEARER}\n`;

function capture(status = 202, body: unknown = { taskId: TASK, status: "RECEIVED", dispatch: "ACCEPTED" }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const values = { label: "first-approval", "door-url": "http://door:8081/", "bearer-file": "/tmp/bearer" };

describe("KJ-P4B approval-test CLI", () => {
  it("submits a fixed, harmless uppercase task through the door, with the bearer in the header only", async () => {
    const c = capture();
    const out = await admitApprovalTest(values, { fetch: c.fetchImpl, readFile });
    expect(out).toEqual([`admitted task ${TASK} status=RECEIVED dispatch=ACCEPTED`]);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.url).toBe("http://door:8081/v1/tasks");
    expect(JSON.parse(String(c.calls[0]!.init.body))).toEqual({ recipe: "uppercase/v1", objective: "approval test first-approval" });
    const headers = c.calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${BEARER}`);
    expect(String(c.calls[0]!.init.body)).not.toContain(BEARER);
    expect(out.join("\n")).not.toContain(BEARER);
  });

  it("the same label is the same request, a different label a different one", () => {
    expect(idempotencyKeyFor("a")).toBe(idempotencyKeyFor("a"));
    expect(idempotencyKeyFor("a")).not.toBe(idempotencyKeyFor("b"));
    expect(idempotencyKeyFor("a")).toMatch(/^approval-test-[a-f0-9]{32}$/);
    expect(objectiveFor("a")).toBe("approval test a");
  });

  it("refuses a credential as an argument, a missing flag, and a label that is not plain", () => {
    expect(() => parseArgs(["admit", "--bearer", "x", "--label", "a", "--door-url", "u", "--bearer-file", "f"])).toThrow(CliError);
    expect(() => parseArgs(["admit", "--label", "a", "--door-url", "http://d"])).toThrow(/--bearer-file is required/);
    expect(() => parseArgs(["approve", "--label", "a"])).toThrow(/usage/);
    expect(parseArgs(["status", "--task-id", TASK, "--door-url", "http://d", "--bearer-file", "f"]).command).toBe("status");
  });

  it.each(["", "has space", "semi;colon", "x".repeat(41), "new\nline"])("rejects the label %j before any request", async (label) => {
    const c = capture();
    await expect(admitApprovalTest({ ...values, label }, { fetch: c.fetchImpl, readFile })).rejects.toThrow(CliError);
    expect(c.calls).toHaveLength(0);
  });

  it("maps the door's refusals to plain errors without echoing anything", async () => {
    await expect(admitApprovalTest(values, { fetch: capture(409, {}).fetchImpl, readFile })).rejects.toThrow(/already used/);
    await expect(admitApprovalTest(values, { fetch: capture(401, {}).fetchImpl, readFile })).rejects.toThrow(/HTTP 401/);
    await expect(admitApprovalTest(values, { fetch: capture(202, { taskId: "not-a-uuid" }).fetchImpl, readFile })).rejects.toThrow();
    const down = (async () => {
      throw new Error(`ECONNREFUSED ${BEARER}`);
    }) as typeof fetch;
    const error = await admitApprovalTest(values, { fetch: down, readFile }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toBe("the admission door could not be reached");
  });

  it("refuses a bearer file of the wrong shape, and a door URL that is not http(s)", async () => {
    const c = capture();
    await expect(admitApprovalTest(values, { fetch: c.fetchImpl, readFile: () => "short" })).rejects.toThrow(/expected shape/);
    await expect(admitApprovalTest({ ...values, "door-url": "file:///etc/passwd" }, { fetch: c.fetchImpl, readFile })).rejects.toThrow(/http\(s\)/);
    expect(c.calls).toHaveLength(0);
  });

  it("only submits and reads: it never names the approve or cancel control", () => {
    const src = readFileSync("services/kernel/src/approval-test-cli.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\/approve|\/cancel|\/signal/);
  });
});
