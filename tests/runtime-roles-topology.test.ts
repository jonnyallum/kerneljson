import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - plain .mjs inventory script shared with the qualification tooling
import { ENTRY_POINTS, DEPLOYMENT_MODULES, reach } from "../scripts/b1/runtime-graph.mjs";

/**
 * KJ-P8 B1 gate 10 - no hidden second path around the runtime roles. Static, no database.
 * Every database connection a runtime process can open must come from `runtimePool`, which refuses any session that
 * is not the sealed role. A raw pool or client constructed anywhere in runtime-reachable code would be an escape
 * hatch, so its mere presence fails this test.
 */
const GUARD = "services/kernel/src/database/runtime-roles.ts";
const read = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}(),])\/\/[^\n]*/g, "$1");
const entries = ENTRY_POINTS as Record<string, string[]>;
const runtimeFiles = [...new Set(Object.values(entries).flatMap((e) => reach(e, DEPLOYMENT_MODULES) as string[]))].sort();

describe("B1 runtime connection topology", () => {
  it("only the guard constructs a database connection in runtime-reachable code", () => {
    const offenders = runtimeFiles.filter((f) => f !== GUARD && /new\s+(pg\.)?(Pool|Client)\s*\(/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it("the guard is reachable from every runtime entry point", () => {
    for (const [role, files] of Object.entries(entries))
      for (const entry of files) expect(reach([entry], DEPLOYMENT_MODULES), `${role} ${entry}`).toContain(GUARD);
  });

  it("runtime code never changes role, never names an owner credential and never reads an alternate database URL", () => {
    const patterns: [string, RegExp][] = [
      ["SET ROLE", /set\s+(local\s+)?role\b/i],
      ["SET SESSION AUTHORIZATION", /set\s+session\s+authorization/i],
      ["session_replication_role", /session_replication_role/i],
      ["owner database URL variable", /(OWNER|ADMIN|MIGRATION|SERVICE_ROLE|SUPERUSER)_?DATABASE_URL|DATABASE_URL_(OWNER|ADMIN)/],
      ["literal postgres credential", /postgres(ql)?:\/\/postgres[:@]/],
    ];
    const hits = runtimeFiles.flatMap((f) => patterns.filter(([, re]) => re.test(read(f))).map(([name]) => `${f}: ${name}`));
    expect(hits).toEqual([]);
  });

  it("deployment-authority modules are not imported by any runtime entry point", () => {
    const all = [...new Set(Object.values(entries).flatMap((e) => reach(e, []) as string[]))];
    expect((DEPLOYMENT_MODULES as string[]).filter((m) => all.includes(m))).toEqual([]);
  });

  it("the role harness is test-only", () => {
    expect(runtimeFiles.filter((f) => f.startsWith("tests/"))).toEqual([]);
  });
});
