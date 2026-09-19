import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Synthetic values only. Distinct, greppable markers so a leak into output is obvious.
const DB = "postgresql://svc:SYNTH-DB-PASSWORD-9137@db.example.invalid:5432/kj";
const BEARER = "SYNTH-BEARER-VALUE-5521";
const TOKEN = `123456789:${"AAFakeEnvMergeToken".padEnd(35, "0")}`;
const CHAT = "-1001234567890";
const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

const BASE = [
  "# worker runtime env",
  `DATABASE_URL=${DB}`,
  `KERNELJSON_RELEASE_ID=${OLD_SHA}`,
  "ALERT_RUNNER_ENABLED=true",
  "ALERT_RUNNER_CADENCE_MS=300000",
  "ALERT_STATE_STORE=postgres",
  "KJ_ADMISSION_URL=http://gateway:8081",
  `KJ_ADMISSION_BEARER=${BEARER}`,
  "SCHED_ARM_NEXT=true",
  "",
].join("\n");

const REQUIRE = "DATABASE_URL,ALERT_RUNNER_ENABLED,ALERT_RUNNER_CADENCE_MS,ALERT_STATE_STORE,KJ_ADMISSION_BEARER,SCHED_ARM_NEXT";
const SECRETS = [DB, BEARER, TOKEN, CHAT, "SYNTH-DB-PASSWORD-9137"];

const SCRIPT = "scripts/runtime_env_merge.py";
const python = ["python3", "python"].find((c) => spawnSync(c, ["--version"]).status === 0);
const dirs: string[] = [];
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "kj-envmerge-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function run(args: string[]): { code: number; out: string; err: string } {
  if (!python) throw new Error("python3/python is required to run the env merge tests");
  const r = spawnSync(python, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}
function fixture(base = BASE) {
  const d = dir();
  writeFileSync(join(d, "base.env"), base);
  writeFileSync(join(d, "token.txt"), `\uFEFF${TOKEN}\r\n`); // BOM + CRLF on purpose
  writeFileSync(join(d, "chat.txt"), CHAT);
  return d;
}
const activate = (d: string, extra: string[] = []) =>
  run([
    "merge", "--base", join(d, "base.env"), "--out", join(d, "new.env"),
    "--require-keys", REQUIRE,
    "--set-public", "ALERT_TRANSPORT=telegram",
    "--set-public", `KERNELJSON_RELEASE_ID=${NEW_SHA}`,
    "--set-from", `TELEGRAM_BOT_TOKEN=${join(d, "token.txt")}`,
    "--set-from", `TELEGRAM_CHAT_ID=${join(d, "chat.txt")}`,
    ...extra,
  ]);

describe("KJ-P2.2B runtime env merge (runner env preserved)", () => {
  it("has a python interpreter available", () => {
    expect(python).toBeDefined();
  });

  it("adds Telegram config and moves the release id while preserving every other line byte-for-byte", () => {
    const d = fixture();
    const r = activate(d);
    expect(r.code, r.err).toBe(0);
    const merged = readFileSync(join(d, "new.env"), "utf8");
    const expected = BASE.replace(`KERNELJSON_RELEASE_ID=${OLD_SHA}`, `KERNELJSON_RELEASE_ID=${NEW_SHA}`) +
      `ALERT_TRANSPORT=telegram\nTELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_CHAT_ID=${CHAT}\n`;
    expect(merged).toBe(expected);
    for (const kept of ["ALERT_RUNNER_ENABLED=true", "ALERT_RUNNER_CADENCE_MS=300000", "ALERT_STATE_STORE=postgres", "SCHED_ARM_NEXT=true", "# worker runtime env", `DATABASE_URL=${DB}`, `KJ_ADMISSION_BEARER=${BEARER}`]) {
      expect(merged).toContain(kept);
    }
  });

  it("prints key names, lengths and fingerprints only: no value ever reaches stdout or stderr", () => {
    const d = fixture();
    const r = activate(d);
    const all = r.out + r.err;
    for (const s of SECRETS) expect(all).not.toContain(s);
    expect(r.out).toMatch(/UNCHANGED\s+ALERT_RUNNER_ENABLED/);
    expect(r.out).toMatch(/ADDED\s+TELEGRAM_BOT_TOKEN\s+len=\d+\s+sha8=[0-9A-F]{8}/);
    expect(r.out).toMatch(/CHANGED\s+KERNELJSON_RELEASE_ID/);
  });

  it("verify passes: only the intended keys differ from the baseline", () => {
    const d = fixture();
    activate(d);
    const v = run(["verify", "--base", join(d, "base.env"), "--new", join(d, "new.env"), "--changed", "ALERT_TRANSPORT,TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID,KERNELJSON_RELEASE_ID"]);
    expect(v.code, v.err).toBe(0);
    expect(v.out).toContain("VERIFY OK");
    for (const s of SECRETS) expect(v.out + v.err).not.toContain(s);
  });

  it("REFUSES the D1 Stage 5 wipe: a DATABASE_URL-only base is rejected when runner keys are required", () => {
    const d = fixture(`DATABASE_URL=${DB}\n`);
    const r = activate(d);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/missing required key: ALERT_RUNNER_ENABLED/);
    expect(existsSync(join(d, "new.env"))).toBe(false);
    for (const s of SECRETS) expect(r.out + r.err).not.toContain(s);
  });

  it("refuses a base with no DATABASE_URL at all", () => {
    const d = fixture("ALERT_RUNNER_ENABLED=true\n");
    const r = run(["merge", "--base", join(d, "base.env"), "--out", join(d, "new.env"), "--set-public", "ALERT_TRANSPORT=console"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/no DATABASE_URL/);
  });

  it("verify FAILS on a tampered file: a changed runner value is named, not silently accepted", () => {
    const d = fixture();
    activate(d);
    const tampered = readFileSync(join(d, "new.env"), "utf8").replace("ALERT_RUNNER_CADENCE_MS=300000", "ALERT_RUNNER_CADENCE_MS=1000");
    writeFileSync(join(d, "tampered.env"), tampered);
    const v = run(["verify", "--base", join(d, "base.env"), "--new", join(d, "tampered.env"), "--changed", "ALERT_TRANSPORT,TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID,KERNELJSON_RELEASE_ID"]);
    expect(v.code).toBe(1);
    expect(v.err).toMatch(/CHANGED ALERT_RUNNER_CADENCE_MS/);
    expect(v.err).not.toContain("1000");
  });

  it("verify FAILS when a baseline key has been dropped, or an unexpected key added", () => {
    const d = fixture();
    activate(d);
    const dropped = readFileSync(join(d, "new.env"), "utf8").replace("ALERT_STATE_STORE=postgres\n", "");
    writeFileSync(join(d, "dropped.env"), dropped);
    const changed = "ALERT_TRANSPORT,TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID,KERNELJSON_RELEASE_ID";
    const a = run(["verify", "--base", join(d, "base.env"), "--new", join(d, "dropped.env"), "--changed", changed]);
    expect(a.code).toBe(1);
    expect(a.err).toMatch(/MISSING ALERT_STATE_STORE/);
    writeFileSync(join(d, "extra.env"), readFileSync(join(d, "new.env"), "utf8") + "SURPRISE=1\n");
    const b = run(["verify", "--base", join(d, "base.env"), "--new", join(d, "extra.env"), "--changed", changed]);
    expect(b.code).toBe(1);
    expect(b.err).toMatch(/ADDED SURPRISE/);
  });

  it("only allow-listed keys can be set: runner and database keys are refused", () => {
    for (const key of ["DATABASE_URL", "ALERT_RUNNER_ENABLED", "ALERT_RUNNER_CADENCE_MS", "ALERT_STATE_STORE", "KJ_ADMISSION_BEARER", "SCHED_ARM_NEXT"]) {
      const d = fixture();
      const r = run(["merge", "--base", join(d, "base.env"), "--out", join(d, "new.env"), "--set-public", `${key}=x`]);
      expect(r.code, key).toBe(2);
      expect(r.err).toMatch(/not settable/);
      expect(existsSync(join(d, "new.env"))).toBe(false);
    }
  });

  it("a secret can never be supplied via argv", () => {
    const d = fixture();
    for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
      const r = run(["merge", "--base", join(d, "base.env"), "--out", join(d, "new.env"), "--set-public", `${key}=${TOKEN}`]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/never argv/);
      expect(r.out + r.err).not.toContain(TOKEN);
    }
  });

  it("rejects malformed values without echoing them (transport, release id, token, chat id)", () => {
    const d = fixture();
    writeFileSync(join(d, "badtoken.txt"), "999888777:short");
    const cases: string[][] = [
      ["--set-public", "ALERT_TRANSPORT=banana"],
      ["--set-public", "KERNELJSON_RELEASE_ID=not-a-sha"],
      ["--set-from", `TELEGRAM_BOT_TOKEN=${join(d, "badtoken.txt")}`],
    ];
    for (const c of cases) {
      const r = run(["merge", "--base", join(d, "base.env"), "--out", join(d, "new.env"), ...c]);
      expect(r.code, c.join(" ")).toBe(2);
      expect(r.err).toMatch(/unexpected shape|expected shape/);
      expect(r.out + r.err).not.toContain("999888777");
      expect(r.out + r.err).not.toContain("banana");
    }
  });

  it("rollback path: ALERT_TRANSPORT=console is accepted and everything else stays identical", () => {
    const d = fixture();
    const r = run(["merge", "--base", join(d, "base.env"), "--out", join(d, "new.env"), "--require-keys", REQUIRE, "--set-public", "ALERT_TRANSPORT=console"]);
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(join(d, "new.env"), "utf8")).toBe(BASE + "ALERT_TRANSPORT=console\n");
  });

  it("replaces an existing ALERT_TRANSPORT in place rather than duplicating it", () => {
    const d = fixture(BASE + "ALERT_TRANSPORT=console\n");
    const r = run(["merge", "--base", join(d, "base.env"), "--out", join(d, "new.env"), "--set-public", "ALERT_TRANSPORT=telegram"]);
    expect(r.code, r.err).toBe(0);
    const merged = readFileSync(join(d, "new.env"), "utf8");
    expect(merged.match(/^ALERT_TRANSPORT=/gm)).toHaveLength(1);
    expect(merged).toContain("ALERT_TRANSPORT=telegram");
  });

  it("never overwrites an existing output file and writes the new one owner-only on POSIX", () => {
    const d = fixture();
    writeFileSync(join(d, "new.env"), "precious\n");
    const refused = activate(d);
    expect(refused.code).not.toBe(0);
    expect(readFileSync(join(d, "new.env"), "utf8")).toBe("precious\n");
    rmSync(join(d, "new.env"));
    expect(activate(d).code).toBe(0);
    if (process.platform !== "win32") expect(statSync(join(d, "new.env")).mode & 0o777).toBe(0o600);
  });

  it("refuses an ambiguous base with a duplicate key", () => {
    const d = fixture(BASE + "ALERT_RUNNER_ENABLED=false\n");
    const r = run(["fingerprint", join(d, "base.env")]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/duplicate key/);
  });
});
