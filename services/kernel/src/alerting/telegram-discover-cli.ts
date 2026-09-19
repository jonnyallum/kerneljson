import { pathToFileURL } from "node:url";
import { DiscoverError, assertNoTokenInArgv, discoverChats } from "./telegram-discover.js";

/**
 * `pnpm telegram:discover-chat --token-file <path> [--keep-file]`
 *
 * Run on the workstation after `secretctl get kerneljson/TELEGRAM_BOT_TOKEN
 * --out <path> --expect-len <N>`. The token file is deleted when this finishes
 * unless `--keep-file` is given. Prints chat id, type and a display label only.
 * See telegram-discover.ts for the guarantees.
 */
export function parseArgs(argv: readonly string[]): { tokenFile: string; keepFile: boolean } {
  assertNoTokenInArgv(argv);
  const at = argv.indexOf("--token-file");
  const tokenFile = at >= 0 ? argv[at + 1] : undefined;
  if (!tokenFile || tokenFile.startsWith("--")) throw new DiscoverError("--token-file <path> is required");
  return { tokenFile, keepFile: argv.includes("--keep-file") };
}

async function main(): Promise<void> {
  const { tokenFile, keepFile } = parseArgs(process.argv.slice(2));
  const chats = await discoverChats({ tokenFile, keepFile });
  if (chats.length === 0) {
    process.stdout.write("no chats found: send any message to the bot (or in the group) from your own account, then re-run.\n");
    return;
  }
  for (const chat of chats) process.stdout.write(`chat id=${chat.id} type=${chat.type} label=${chat.label}\n`);
  process.stdout.write("confirm the label is the intended destination before storing the id.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    const detail = err instanceof DiscoverError ? err.message : "unexpected failure";
    process.stderr.write(`telegram discover failed: ${detail}\n`);
    process.exitCode = 4;
  });
}
