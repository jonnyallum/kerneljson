import type { IncomingMessage } from "node:http";

/**
 * ADR-0025: basic rate limiting for the public OAuth endpoints. Fixed windows, in memory, per client
 * address and in total. It bounds work and the pending sign-in table; it grants nothing, so losing the
 * counters on restart is harmless.
 */
export interface RateRule {
  limit: number;
  windowMs: number;
}
export interface RateLimits {
  /** Every /oauth/* request from one client address. */
  perClient: RateRule;
  /** /oauth/register from one client address, on top of perClient. */
  registerPerClient: RateRule;
  /** Every /oauth/* request from everyone together. */
  global: RateRule;
}
export const DEFAULT_RATE_LIMITS: RateLimits = {
  perClient: { limit: 30, windowMs: 60_000 },
  registerPerClient: { limit: 10, windowMs: 3_600_000 },
  global: { limit: 300, windowMs: 60_000 },
};
/** Distinct client addresses tracked at once. Beyond it a new address is refused until windows expire. */
const MAX_TRACKED = 10_000;

export type RateDecision = { ok: true } | { ok: false; rule: keyof RateLimits; retryAfterS: number };

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limits: RateLimits,
    private readonly now: () => number,
  ) {}

  /** Counts one request and says whether it may proceed. A refused request is not counted further. */
  check(client: string, register: boolean): RateDecision {
    const rules: Array<[keyof RateLimits, string]> = [["perClient", `c:${client}`]];
    if (register) rules.push(["registerPerClient", `r:${client}`]);
    rules.push(["global", "g"]);
    for (const [rule, key] of rules) {
      const refused = this.take(key, this.limits[rule]);
      if (refused !== null) return { ok: false, rule, retryAfterS: refused };
    }
    return { ok: true };
  }

  /** null when allowed, otherwise the seconds until this window ends. */
  private take(key: string, rule: RateRule): number | null {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= rule.windowMs) {
      if (!w && this.windows.size >= MAX_TRACKED) this.sweep(t);
      if (!w && this.windows.size >= MAX_TRACKED) return Math.ceil(rule.windowMs / 1000);
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    if (w.count >= rule.limit) return Math.max(1, Math.ceil((w.start + rule.windowMs - t) / 1000));
    w.count++;
    return null;
  }

  private sweep(t: number): void {
    const longest = Math.max(this.limits.perClient.windowMs, this.limits.registerPerClient.windowMs, this.limits.global.windowMs);
    for (const [k, w] of this.windows) if (t - w.start >= longest) this.windows.delete(k);
  }
}

/**
 * The client address. In OAuth mode the server is reachable only through Caddy, which sets
 * X-Forwarded-For to the address it saw (it ignores an incoming value unless trusted_proxies is set), so
 * the last entry is the one our proxy wrote. Without the header, the socket address.
 */
export function clientAddress(req: IncomingMessage): string {
  const header = req.headers["x-forwarded-for"];
  const value = Array.isArray(header) ? header[header.length - 1] : header;
  const last = value?.split(",").pop()?.trim();
  if (last && /^[0-9A-Fa-f:.]{2,45}$/.test(last)) return last;
  return req.socket.remoteAddress ?? "unknown";
}
