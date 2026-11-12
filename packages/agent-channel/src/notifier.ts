import type { ChannelMessage } from "./contract.js";

/**
 * Wake notifier (ADR-0026 follow-on, PROPOSED). Tells an agent that a message mentions it, so it can
 * open a session and read the room. The ping carries NO message text: the room stays the only place
 * the body is read, behind the reader's own bearer. A ping is a hint, never a command, and never
 * admits a task. Delivery is best effort: it must not block or fail a post.
 */
export interface WakeTarget {
  /** Room handle this target wakes, for example "grok". */
  handle: string;
  /** https URL of the agent's own wake endpoint. Operator configuration only, never message content. */
  url: string;
  /** Sent as the `x-room-wake-key` header so the receiver can verify the sender. */
  key: string;
}

export interface WakePing {
  seq: number;
  id: string;
  threadId: string;
  handle: string;
  kind: string;
}

export interface MessageNotifier {
  notify(message: ChannelMessage): Promise<void>;
}

export type WakeLogger = (entry: { handle: string; seq: number; outcome: string }) => void;

export const WAKE_TIMEOUT_MS = 3000;
const ALL_TOKENS = ["all", "agents"];

function mentions(body: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])@${escaped}(?![\\w-])`, "i").test(body);
}

export function wakeHandles(body: string, authorHandle: string, targets: readonly WakeTarget[]): WakeTarget[] {
  const everyone = ALL_TOKENS.some((token) => mentions(body, token));
  return targets.filter(
    (target) => target.handle !== authorHandle && (everyone || mentions(body, target.handle)),
  );
}

export class WebhookWakeNotifier implements MessageNotifier {
  private readonly sent = new Set<string>();

  constructor(
    private readonly targets: readonly WakeTarget[],
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: WakeLogger = () => undefined,
  ) {
    for (const target of targets) {
      if (!target.url.startsWith("https://")) throw new Error("WAKE_URL_NOT_HTTPS");
    }
  }

  async notify(message: ChannelMessage): Promise<void> {
    for (const target of wakeHandles(message.body, message.handle, this.targets)) {
      const dedupe = `${target.handle}:${message.id}`;
      if (this.sent.has(dedupe)) continue;
      this.sent.add(dedupe);
      if (this.sent.size > 2000) this.sent.delete(this.sent.values().next().value as string);
      const ping: WakePing = {
        seq: message.seq,
        id: message.id,
        threadId: message.threadId,
        handle: message.handle,
        kind: message.kind,
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WAKE_TIMEOUT_MS);
      try {
        const res = await this.fetchImpl(target.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-room-wake-key": target.key },
          body: JSON.stringify(ping),
          signal: controller.signal,
          redirect: "error",
        });
        this.log({ handle: target.handle, seq: message.seq, outcome: res.ok ? "delivered" : `http_${res.status}` });
      } catch {
        this.log({ handle: target.handle, seq: message.seq, outcome: "failed" });
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
