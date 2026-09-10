import type {
  Task,
  TenantContext,
} from "../../../packages/contracts/src/index.js";
import type { TaskView } from "./store.js";
export const escapeHtml = (value: unknown) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const css = `:root{font:16px system-ui,sans-serif;color:#172b35;background:#f3f5f4}*{box-sizing:border-box}body{margin:0}header{background:#132e35;color:white;padding:24px 5vw;display:flex;justify-content:space-between;align-items:center}header a{color:white;text-decoration:none;font-weight:700}header small{color:#b8d3cd}main{max-width:1180px;margin:40px auto;padding:0 24px}h1{font-size:34px;letter-spacing:-1px;margin:8px 0 12px}h2{font-size:20px}.muted{color:#52656c}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:24px 0}.card,section{background:white;border:1px solid #d6dfdc;border-radius:10px;padding:22px;margin-bottom:20px}.number{display:block;font-size:30px;font-weight:700;margin-top:8px}.badge{display:inline-block;padding:5px 10px;border-radius:20px;background:#e9eff1;font-size:12px;font-weight:700;letter-spacing:.5px}.COMPLETED{background:#d5eee0;color:#174c34}.FAILED,.CANCELLED{background:#f8deda;color:#852c27}.APPROVAL_REQUIRED{background:#fff0c9;color:#71501a}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:14px 8px;border-bottom:1px solid #e4e9e7;vertical-align:top}th{font-size:12px;text-transform:uppercase;color:#53666d}a{color:#135c62}code,pre{font:12px ui-monospace,monospace;overflow-wrap:anywhere}pre{white-space:pre-wrap;background:#f4f7f6;padding:16px;border-radius:6px}form{display:inline-block;margin:8px 8px 0 0}button{background:#17665e;color:white;padding:11px 20px;border:0;border-radius:6px;font:inherit;cursor:pointer}button.deny{background:#8b3932}details{margin:8px 0}summary{cursor:pointer}footer{font-size:12px;color:#52656c;margin:32px 0}.objective{max-width:540px;overflow-wrap:anywhere}@media(max-width:700px){.grid{grid-template-columns:1fr}header small{display:none}main{padding:0 12px;margin-top:24px}h1{font-size:27px}table{font-size:13px}th,td{padding:10px 4px}.trace{display:none}}`;
export function layout(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · KernelJSON</title><style>${css}</style></head><body><header><a href="/">KERNELJSON <span class="muted">/</span> MISSION CONTROL</a><small>A task is the primitive.</small></header><main>${body}<footer>Task state and provenance from the kernel. Refresh to see new activity.</footer></main></body></html>`;
}
const badge = (status: string) =>
  `<span class="badge ${escapeHtml(status)}">${escapeHtml(status.replaceAll("_", " "))}</span>`;
export function renderList(tasks: Task[]) {
  return layout(
    "Tasks",
    `<p class="muted">WORKSPACE OVERVIEW</p><h1>Tasks, with evidence.</h1><p class="muted">Track work, inspect outcomes and resolve requests for approval.</p><div class="grid"><div class="card">Recent tasks<span class="number">${tasks.length}</span></div><div class="card">Awaiting approval<span class="number">${tasks.filter((t) => t.status === "APPROVAL_REQUIRED").length}</span></div><div class="card">Completed<span class="number">${tasks.filter((t) => t.status === "COMPLETED").length}</span></div></div><section><h2>Recent activity</h2><p class="muted">Up to 50 most recent tasks in this tenant.</p>${tasks.length ? `<table><thead><tr><th>Task</th><th>Status</th><th class="trace">Created</th></tr></thead><tbody>${tasks.map((t) => `<tr><td class="objective"><a href="/tasks/${t.id}">${escapeHtml(t.objective)}</a><br><code>${t.id}</code></td><td>${badge(t.status)}</td><td class="trace">${escapeHtml(t.createdAt)}</td></tr>`).join("")}</tbody></table>` : "<p>No tasks yet.</p>"}</section>`,
  );
}
export function renderTask(
  view: TaskView,
  context: TenantContext,
  controls: boolean,
) {
  const { task, outcome, pending } = view,
    base = `/tasks/${task.id}`;
  const canApprove =
    controls && view.controls.includes("approve") &&
    pending?.requestedFrom === context.principal.id &&
    context.principal.kind === "HUMAN";
  const canCancel =
    controls && view.controls.includes("cancel") && task.principal.id === context.principal.id;
  return layout(
    task.objective,
    `<a href="/">← All tasks</a><h1 class="objective">${escapeHtml(task.objective)}</h1>${badge(task.status)}<p><code>${task.id}</code></p>${pending ? `<section><h2>Approval requested</h2><p>${escapeHtml(pending.evaluation.decision.reasonCode)}</p><p class="muted">Expires ${escapeHtml(pending.evaluation.expiresAt)}</p>${canApprove ? `<form method="post" action="${base}/approve"><input type="hidden" name="scopeDigest" value="${pending.evaluation.scopeDigest}"><button name="decision" value="GRANTED">Approve</button> <button class="deny" name="decision" value="DENIED">Deny</button></form>` : ""}</section>` : ""}${canCancel ? `<form method="post" action="${base}/cancel"><button class="deny">Cancel task</button></form>` : ""}${controls && view.controls.includes("signal") ? `<form method="post" action="${base}/signal"><button name="action" value="RESUME">Resume task</button></form>` : ""}${view.lastControl ? `<p>Last control: ${escapeHtml(view.lastControl.action)} ${escapeHtml(view.lastControl.status)}${view.lastControl.action === "cancel" && task.status === "CANCELLED" ? " — cancellation completed" : ""}</p>` : ""}<section><h2>Outcome</h2>${outcome ? `<p>${escapeHtml(outcome.summary)}</p><ul>${outcome.acceptanceResults.map((r) => `<li>${r.passed ? "✓" : "×"} ${escapeHtml(r.criterion)}</li>`).join("")}</ul>` : "<p>No verified outcome has been recorded.</p>"}</section><section><h2>Evidence</h2><p class="muted">Up to 100 records. References remain attached to this task.</p>${view.evidence.map((e) => `<details><summary>${escapeHtml(e.type)} · ${escapeHtml(e.source)}</summary><p><code>${e.id}</code></p><code>${escapeHtml(e.digest ?? "Reference evidence")}</code></details>`).join("") || "<p>No evidence recorded.</p>"}</section><section><h2>Event history</h2><p class="muted">Latest 200 events, newest first.</p>${view.events.map((e) => `<details><summary>${escapeHtml(e.type)} <span class="muted">${escapeHtml(e.at.toISOString())}</span></summary><pre>${escapeHtml(JSON.stringify(e.payload, null, 2))}</pre></details>`).join("")}</section>`,
  );
}
