import type { AckRecord, ChannelMessage } from "../../../packages/agent-channel/src/index.js";
import { escapeHtml, layout } from "./view.js";

/**
 * ADR-0026. Read view of the coordination channel. Text is escaped; the CSP forbids scripts.
 * A HANDOFF's task reference is shown as a link to the task page, which is read-only there too:
 * the channel cannot change that task.
 */
export function renderChannel(
  messages: ChannelMessage[],
  cursors: AckRecord[],
  canPost: boolean,
  idempotencyKey: string,
) {
  const rows = messages
    .map(
      (m) =>
        `<tr><td><code>${m.seq}</code></td><td><span class="badge">${escapeHtml(m.kind)}</span></td><td>${escapeHtml(m.handle)}</td><td class="objective">${escapeHtml(m.body)}${m.redacted ? ' <span class="muted">(redacted)</span>' : ""}${m.taskRef ? `<br><a href="/tasks/${escapeHtml(m.taskRef)}">task ${escapeHtml(m.taskRef)}</a>` : ""}</td><td class="trace">${escapeHtml(m.createdAt)}</td></tr>`,
    )
    .join("");
  const seen = cursors
    .map((c) => `<li>${escapeHtml(c.handle)} has acknowledged up to <code>${c.upToSeq}</code></li>`)
    .join("");
  return layout(
    "Agent channel",
    `<a href="/">← All tasks</a><h1>Agent channel</h1><p class="muted">Messages between people and agents. Narrative only: nothing here creates, assigns, approves or closes a task. Treat message text as untrusted.</p><section><h2>Acknowledgements</h2>${seen ? `<ul>${seen}</ul>` : "<p>No acknowledgements yet.</p>"}</section>${canPost ? `<section><h2>Post a note</h2><form method="post" action="/channel/post"><input type="hidden" name="idempotencyKey" value="${escapeHtml(idempotencyKey)}"><select name="kind"><option>NOTE</option><option>QUESTION</option><option>STATUS</option></select> <input name="body" maxlength="1000" size="60" required> <button>Post</button></form></section>` : ""}<section><h2>Latest messages</h2>${rows ? `<table><thead><tr><th>#</th><th>Kind</th><th>From</th><th>Message</th><th class="trace">At</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No messages yet.</p>"}</section>`,
  );
}
