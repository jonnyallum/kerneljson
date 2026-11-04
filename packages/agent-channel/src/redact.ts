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
  [/\b[A-Fa-f0-9]{40,}\b/g, "[REDACTED:hex]"],
  [/\b[A-Za-z0-9+/_-]{48,}={0,2}(?=\s|$)/g, "[REDACTED:token]"],
];
export function redactSecrets(text: string): { text: string; redacted: boolean } {
  let out = text;
  for (const [re, label] of RULES) out = out.replace(re, label);
  return { text: out, redacted: out !== text };
}
