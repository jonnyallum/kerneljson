import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiscoverError,
  assertNoTokenInArgv,
  assertPrivateMode,
  discoverChats,
  extractChats,
  readTokenShape,
} from "../services/kernel/src/alerting/telegram-discover.js";
import { parseArgs } from "../services/kernel/src/alerting/telegram-discover-cli.js";

// Obviously synthetic, correct shape: 9 digits, colon, 35 chars.
const FAKE_TOKEN = `123456789:${"AAFakeDiscoverTestToken".padEnd(35, "0")}`;
const dirs: string[] = [];

function tokenFile(contents = FAKE_TOKEN): string {
  const dir = mkdtempSync(join(tmpdir(), "kj-discover-"));
  dirs.push(dir);
  const file = join(dir, "tg.tok");
  writeFileSync(file, contents, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const okBody = {
  ok: true,
  result: [
    { update_id: 1, message: { text: "secret words", chat: { id: 4242, type: "private", first_name: "Jonny" } } },
    { update_id: 2, message: { chat: { id: 4242, type: "private", first_name: "Jonny" } } },
    { update_id: 3, my_chat_member: { chat: { id: -100777, type: "supergroup", title: "KJ ops" } } },
  ],
};
const respond = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

/** Every string the helper can surface: return value, error text, class name, stack. */
function surfaced(x: unknown): string {
  if (x instanceof Error) return `${x.name} ${x.message} ${x.stack ?? ""} ${String(x.cause ?? "")}`;
  return JSON.stringify(x);
}

describe("KJ-P2.2B token-safe Telegram chat discovery", () => {
  it("returns distinct chats (id, type, label only) and never message text or the token", async () => {
    const file = tokenFile();
    const chats = await discoverChats({ tokenFile: file, fetchImpl: respond(200, okBody) });
    expect(chats).toEqual([
      { id: 4242, type: "private", label: "Jonny" },
      { id: -100777, type: "supergroup", label: "KJ ops" },
    ]);
    const shown = surfaced(chats);
    expect(shown).not.toContain(FAKE_TOKEN);
    expect(shown).not.toContain("secret words");
  });

  it("deletes the token file after use, on success", async () => {
    const file = tokenFile();
    await discoverChats({ tokenFile: file, fetchImpl: respond(200, okBody) });
    expect(existsSync(file)).toBe(false);
  });

  it("deletes the token file after use, on every failure path too", async () => {
    for (const impl of [respond(401, {}), respond(500, {}), respond(200, { ok: false }), respond(200, "not json{")]) {
      const file = tokenFile();
      await expect(discoverChats({ tokenFile: file, fetchImpl: impl })).rejects.toBeInstanceOf(DiscoverError);
      expect(existsSync(file)).toBe(false);
    }
  });

  it("keeps the file only when explicitly asked", async () => {
    const file = tokenFile();
    await discoverChats({ tokenFile: file, fetchImpl: respond(200, okBody), keepFile: true });
    expect(existsSync(file)).toBe(true);
  });

  it("the token never appears in any thrown error, across every failure path", async () => {
    const hostile = (async (url: string) => {
      // A fetch that tries to leak the token-bearing URL through its own error and cause.
      throw Object.assign(new Error(`connect failed for ${url}`), { cause: new Error(url) });
    }) as unknown as typeof fetch;
    const cases: typeof fetch[] = [respond(401, {}), respond(403, {}), respond(500, {}), respond(200, { ok: false }), respond(200, "not json{"), hostile];
    for (const impl of cases) {
      const err = await discoverChats({ tokenFile: tokenFile(), fetchImpl: impl }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DiscoverError);
      expect(surfaced(err)).not.toContain(FAKE_TOKEN);
      expect(surfaced(err)).not.toContain("api.telegram.org");
      expect((err as Error).cause).toBeUndefined();
    }
  });

  it("the token-bearing URL is only ever handed to fetch, never written to console", async () => {
    const logged: unknown[][] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    console.log = (...a: unknown[]) => void logged.push(a);
    console.error = (...a: unknown[]) => void logged.push(a);
    console.warn = (...a: unknown[]) => void logged.push(a);
    let seen = "";
    try {
      await discoverChats({
        tokenFile: tokenFile(),
        fetchImpl: (async (url: string) => {
          seen = url;
          return new Response(JSON.stringify(okBody), { status: 200 });
        }) as unknown as typeof fetch,
      });
    } finally {
      Object.assign(console, { log: orig.log, error: orig.error, warn: orig.warn });
    }
    expect(seen).toContain(FAKE_TOKEN);
    expect(logged).toEqual([]);
  });

  it("accepts a BOM-prefixed file (BOM corruption lesson) and rejects a malformed one without echoing it", () => {
    expect(readTokenShape(`\uFEFF${FAKE_TOKEN}\r\n`)).toBe(FAKE_TOKEN);
    let message = "";
    try {
      readTokenShape("999888777:tooShort");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/expected shape/);
    expect(message).not.toContain("999888777");
  });

  it("refuses a group/world-readable token file on POSIX and ignores modes on Windows", () => {
    expect(() => assertPrivateMode(0o100644, "linux")).toThrow(/mode 600/);
    expect(() => assertPrivateMode(0o100660, "linux")).toThrow(/mode 600/);
    expect(() => assertPrivateMode(0o100600, "linux")).not.toThrow();
    expect(() => assertPrivateMode(0o100666, "win32")).not.toThrow();
  });

  it("refuses a token passed on the command line, in any position or form", () => {
    expect(() => assertNoTokenInArgv([FAKE_TOKEN])).toThrow(/never be passed as an argument/);
    expect(() => assertNoTokenInArgv(["--token-file", "a", `--token=${FAKE_TOKEN}`])).toThrow();
    expect(() => parseArgs(["--token", FAKE_TOKEN])).toThrow();
    expect(() => assertNoTokenInArgv(["--token-file", "C:/tmp/tg.tok"])).not.toThrow();
  });

  it("requires --token-file and reads only the path from argv", () => {
    expect(() => parseArgs([])).toThrow(/--token-file/);
    expect(() => parseArgs(["--token-file"])).toThrow(/--token-file/);
    expect(parseArgs(["--token-file", "/tmp/x", "--keep-file"])).toEqual({ tokenFile: "/tmp/x", keepFile: true });
  });

  it("extractChats ignores updates without a numeric chat id and control characters in labels", () => {
    const chats = extractChats({
      ok: true,
      result: [{ message: { chat: { id: "nope", type: "private" } } }, { message: { chat: { id: 9, type: "group", title: "a\u001b[31mb" } } }],
    });
    expect(chats).toEqual([{ id: 9, type: "group", label: "a?[31mb" }]);
  });
});
