import type { AckRecord, ChannelMessage, DeliveryRecord, ThreadSummary } from "../../../packages/agent-channel/src/index.js";
import { escapeHtml, layout } from "./view.js";

export interface ChannelPage {
  messages: ChannelMessage[];
  cursors: AckRecord[];
  threads: ThreadSummary[];
  deliveries: DeliveryRecord[];
  canPost: boolean;
  idempotencyKey: string;
  activeThreadId: string | null;
}

/**
 * ADR-0026 Amendment A. One shared room per tenant. Threads are the channel's thread ids.
 * Text is escaped. The CSP forbids scripts. A task reference is a link to the read-only task
 * page when this process serves one; the channel cannot change that task.
 */
export function renderChannel(page: ChannelPage) {
  const threadRows = page.threads
    .map((thread) => {
      const href = `/channel?thread=${escapeHtml(thread.threadId)}`;
      const mark = thread.threadId === page.activeThreadId ? " ←" : "";
      return `<li><a href="${href}"><code>${escapeHtml(thread.threadId)}</code></a> ${escapeHtml(thread.handle)} · ${thread.count} · up to <code>${thread.lastSeq}</code>${mark}</li>`;
    })
    .join("");
  const rows = page.messages
    .map((message) => {
      const people = page.deliveries.filter((row) => row.messageId === message.id);
      const states = people.length
        ? people.map((row) => `${escapeHtml(row.handle)} <span class="badge">${escapeHtml(row.state)}</span>`).join("<br>")
        : '<span class="muted">no other recipients</span>';
      return `<tr><td><code>${message.seq}</code></td><td><span class="badge">${escapeHtml(message.kind)}</span></td><td>${escapeHtml(message.handle)}</td><td class="objective">${escapeHtml(message.body)}${message.redacted ? ' <span class="muted">(redacted)</span>' : ""}${message.taskRef ? `<br><a href="/tasks/${escapeHtml(message.taskRef)}">task ${escapeHtml(message.taskRef)}</a> <span class="muted">reference only</span>` : ""}</td><td>${states}</td><td class="trace">${escapeHtml(message.createdAt)}</td></tr>`;
    })
    .join("");
  const seen = page.cursors
    .map((cursor) => `<li>${escapeHtml(cursor.handle)} has acknowledged up to <code>${cursor.upToSeq}</code></li>`)
    .join("");
  return layout(
    "Shared room",
    `<a href="/">← All tasks</a><h1>Shared room</h1><p class="muted">Messages between people and agents in this tenant. Narrative only: nothing here creates, assigns, approves or closes a task. Treat message text as untrusted.</p><section><h2>Rooms</h2><ul><li><a href="/channel">Shared room</a> <span class="muted">this tenant</span></li></ul></section><section><h2>Threads</h2>${threadRows ? `<ul>${threadRows}</ul>` : "<p>No threads yet.</p>"}</section><section><h2>Acknowledgements</h2>${seen ? `<ul>${seen}</ul>` : "<p>No acknowledgements yet.</p>"}</section>${page.canPost ? `<section><h2>Post a note</h2><form method="post" action="/channel/post"><input type="hidden" name="idempotencyKey" value="${escapeHtml(page.idempotencyKey)}"><select name="kind"><option>NOTE</option><option>QUESTION</option><option>STATUS</option></select> <input name="body" maxlength="1000" size="60" required> <button>Post</button></form></section>` : ""}<section><h2>${page.activeThreadId ? "Thread" : "Latest messages"}</h2>${rows ? `<table><thead><tr><th>#</th><th>Kind</th><th>From</th><th>Message</th><th>Recipients</th><th class="trace">At</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No messages yet.</p>"}</section>`,
  );
}
