import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * KJ-P2.2B: no production doc may teach putting a Telegram token in a command.
 * The old runbook's `curl .../bot<TOKEN>/getUpdates` put it in argv and shell
 * history. The token-safe path is `pnpm telegram:discover-chat --token-file <path>`;
 * the only place the Bot API URL is built is source code that never logs it.
 */
const CLIENT = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i;

export function findUnsafeTokenExamples(text: string): string[] {
  const hits: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const n = i + 1;
    if (/api\.telegram\.org\/bot/i.test(line)) hits.push(`${n}: token-bearing Bot API URL`);
    else if (/\/bot(<[^>\n]*>|\$\{?[A-Za-z_]+|%[A-Za-z_]+%)/.test(line)) hits.push(`${n}: bot<token> URL template`);
    else if (CLIENT.test(line) && /TOKEN/i.test(line)) hits.push(`${n}: HTTP client command mentioning a token`);
  });
  return hits;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? markdownFiles(p) : p.endsWith(".md") ? [p] : [];
  });
}

describe("KJ-P2.2B production docs contain no unsafe token-bearing examples", () => {
  const files = markdownFiles("docs");

  it("scans a meaningful set of docs, including the Telegram runbook", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.replaceAll("\\", "/").endsWith("PHASE_KJ_P2.2A_TELEGRAM_PRODUCTION_ACTIVATION_RUNBOOK_2026-09-18.md"))).toBe(true);
  });

  for (const file of files) {
    it(`${file.replaceAll("\\", "/")}`, () => {
      expect(findUnsafeTokenExamples(readFileSync(file, "utf8"))).toEqual([]);
    });
  }

  describe("negative cases: the scanner must fail on the exact patterns it exists to catch", () => {
    const unsafe = [
      'curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates"',
      "curl https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage",
      'Invoke-RestMethod "https://x.example/bot${env:TG}/getMe"',
      "wget https://host/bot%TG_TOKEN%/getMe",
      "  curl -H \"x: $TELEGRAM_BOT_TOKEN\" https://example.com",
      "iwr $url -Headers @{t=$BOT_TOKEN}",
    ];
    for (const line of unsafe) it(`flags: ${line}`, () => expect(findUnsafeTokenExamples(line)).not.toEqual([]));

    it("does not flag the safe, token-free instructions", () => {
      const safe = [
        "pnpm telegram:discover-chat --token-file C:\\tmp\\tg.tok",
        "python AgentHub\\scripts\\secretctl.py get kerneljson/TELEGRAM_BOT_TOKEN --out C:\\tmp\\tg.tok --expect-len 46",
        "Confirm TELEGRAM_BOT_TOKEN is SET (presence only).",
      ].join("\n");
      expect(findUnsafeTokenExamples(safe)).toEqual([]);
    });
  });
});
