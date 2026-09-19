import { closeSync, fstatSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

/**
 * KJ-P2.2B — token-safe Telegram chat-ID discovery (read-only `getUpdates`).
 *
 * Replaces the runbook's old shell command, which put the token in argv and
 * shell history. Here:
 *  - the token comes ONLY from a file whose PATH is the sole argument (the
 *    file is produced by `secretctl get ... --out`), never argv, env or stdin
 *    typed by hand;
 *  - the token-bearing URL is built in-process, is never printed, and is never
 *    attached to an error: every failure is a fixed-message class, and no
 *    caught error's message, stack or cause is ever read or chained;
 *  - only chat id, type and a display label are returned — no message text;
 *  - the token file is overwritten and deleted afterwards, on success or failure.
 * It is read-only: `getUpdates` sends nothing to any chat.
 */

const TOKEN_SHAPE = /^\d{6,12}:[A-Za-z0-9_-]{35}$/;
const TOKEN_LIKE = /\d{6,12}:[A-Za-z0-9_-]{30,}/;
const API_BASE = "https://api.telegram.org";
const TIMEOUT_MS = 15_000;

export class DiscoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoverError";
  }
}

export interface DiscoveredChat {
  id: number;
  type: string;
  label: string;
}

/** Refuses a token-shaped value passed anywhere on the command line. */
export function assertNoTokenInArgv(argv: readonly string[]): void {
  if (argv.some((a) => TOKEN_LIKE.test(a))) {
    throw new DiscoverError("a token must never be passed as an argument; pass --token-file <path>");
  }
}

/** A token file must not be group/world readable. POSIX modes are meaningless on Windows. */
export function assertPrivateMode(mode: number, platform: NodeJS.Platform): void {
  if (platform === "win32") return;
  if ((mode & 0o077) !== 0) throw new DiscoverError("token file must be mode 600");
}

/** Strips a UTF-8 BOM and surrounding whitespace, then checks the token's shape. */
export function readTokenShape(raw: string): string {
  const token = raw.replace(/^\uFEFF/, "").trim();
  if (!TOKEN_SHAPE.test(token)) throw new DiscoverError("token file does not hold a bot token of the expected shape");
  return token;
}

function printable(text: string): string {
  return text.replace(/[^\x20-\x7E]/g, "?").slice(0, 60);
}

function shred(path: string): void {
  try {
    const fd = openSync(path, "r+");
    try {
      const size = fstatSync(fd).size;
      writeSync(fd, Buffer.alloc(size, 0), 0, size, 0);
    } finally {
      closeSync(fd);
    }
    unlinkSync(path);
  } catch {
    // Already gone, or unwritable: nothing more this helper can safely do.
  }
}

interface Chat {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  username?: unknown;
  first_name?: unknown;
}

export function extractChats(body: unknown): DiscoveredChat[] {
  const result = (body as { result?: unknown } | null)?.result;
  if (!Array.isArray(result)) return [];
  const seen = new Map<number, DiscoveredChat>();
  for (const update of result as Record<string, { chat?: Chat } | undefined>[]) {
    for (const key of ["message", "channel_post", "my_chat_member"]) {
      const chat = update?.[key]?.chat;
      if (!chat || typeof chat.id !== "number" || seen.has(chat.id)) continue;
      const label = [chat.title, chat.username, chat.first_name].find((v) => typeof v === "string" && v.length > 0);
      seen.set(chat.id, {
        id: chat.id,
        type: typeof chat.type === "string" ? printable(chat.type) : "unknown",
        label: typeof label === "string" ? printable(label) : "(no title)",
      });
    }
  }
  return [...seen.values()];
}

export interface DiscoverOptions {
  tokenFile: string;
  keepFile?: boolean;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
}

export async function discoverChats(options: DiscoverOptions): Promise<DiscoveredChat[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    let token: string;
    try {
      const fd = openSync(options.tokenFile, "r");
      try {
        assertPrivateMode(fstatSync(fd).mode, options.platform ?? process.platform);
      } finally {
        closeSync(fd);
      }
      token = readTokenShape(readFileSync(options.tokenFile, "utf8"));
    } catch (err) {
      if (err instanceof DiscoverError) throw err;
      throw new DiscoverError("token file could not be read");
    }

    let response: Response;
    try {
      response = await fetchImpl(`${API_BASE}/bot${token}/getUpdates?limit=50`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new DiscoverError("network failure or timeout calling Telegram");
    }
    if (response.status === 401) throw new DiscoverError("Telegram rejected the token (401)");
    if (response.status !== 200) throw new DiscoverError(`Telegram returned HTTP ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new DiscoverError("Telegram returned an unparseable body");
    }
    if ((body as { ok?: unknown } | null)?.ok !== true) throw new DiscoverError("Telegram reported ok=false");
    return extractChats(body);
  } finally {
    if (!options.keepFile) shred(options.tokenFile);
  }
}
