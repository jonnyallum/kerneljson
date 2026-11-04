/**
 * Redaction safety net for channel text. Patterns are built from pieces so this file never
 * contains a literal credential prefix that a secret scanner would flag.
 */
const pieces = (...p: string[]) => p.join("");
const RULES: Array<[RegExp, string]> = [
  [new RegExp(pieces("sk-", "or-v1-", "[A-Za-z0-9]{16,}"), "g"), "[REDACTED:openrouter]"],
  [new RegExp(pieces("sb_", "secret_", "[A-Za-z0-9_-]{8,}"), "g"), "[REDACTED:supabase]"],
  [new RegExp(pieces("sb_", "publishable_", "[A-Za-z0-9_-]{8,}"), "g"), "[REDACTED:supabase]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:jwt]"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi, "[REDACTED:connection-string]"],
  [/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/g, "[REDACTED:github]"],
  [/\b[0-9]{8,10}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED:telegram]"],
  [/\b[A-Za-z0-9+/_-]{48,}={0,2}(?=\s|$)/g, "[REDACTED:token]"],
];
/** A 40 or 64 character hex string right after one of these words is a git SHA or release id, not a key. */
const SHA_CONTEXT = /(?:commit|sha|release|rev)[\s:=@#`'"(-]*$/i;
const HEX = /\b[A-Fa-f0-9]{40,}\b/g;
function redactHex(text: string): string {
  return text.replace(HEX, (m, offset: number) =>
    (m.length === 40 || m.length === 64) && SHA_CONTEXT.test(text.slice(Math.max(0, offset - 16), offset))
      ? m
      : "[REDACTED:hex]",
  );
}

export function redactSecrets(text: string): { text: string; redacted: boolean } {
  let out = text;
  for (const [re, label] of RULES) out = out.replace(re, label);
  out = redactHex(out);
  return { text: out, redacted: out !== text };
}
