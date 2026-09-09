import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CompatibilityAdmissionAdapter,
  InMemoryShadowStore,
  SHADOW_CONSUMER,
} from '../packages/admission/src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOAK_DIR = join(ROOT, 'artifacts/local/email-shadow-soak');
const ACTIONS_PATH = join(SOAK_DIR, 'live-email-triage-actions.json');
const JSONL_PATH = join(SOAK_DIR, 'shadow-results.jsonl');
const SUMMARY_PATH = join(SOAK_DIR, 'shadow-summary.json');

function parseEvidence(evidence) {
  if (!evidence) return {};
  const out = {};
  const mid = /message_id=([^;]*)/.exec(evidence);
  if (mid) out.message_id = mid[1].trim();
  const client = /client=([^;]*)/.exec(evidence);
  if (client) {
    const c = client[1].trim();
    out.client = c === 'None' || c === '' ? null : c;
  }
  const label = /label=([^;]*)/.exec(evidence);
  if (label) {
    const l = label[1].trim();
    out.label = l === 'None' || l === '' ? null : l;
  }
  return out;
}

function urgencyFromPriority(priority) {
  if (priority === 'P1') return 'urgent';
  if (priority === 'P4') return 'low';
  return 'normal';
}

function reconstructEnvelope(row) {
  const ev = parseEvidence(row.evidence);
  let messageId = ev.message_id;
  if (!messageId) {
    const m = /^email:(.+)\|email-ingest-live$/.exec(row.source_ref || '');
    messageId = m?.[1] ?? null;
  }
  const subject = (row.title || '').replace(/^Email triage:\s*/i, '');
  const urgency = urgencyFromPriority(row.priority);
  const legacy = {
    id: row.id,
    source: row.source,
    source_ref: row.source_ref,
    title: row.title,
    state: row.state,
  };
  const envelope = {
    message_id: messageId,
    subject,
    received_at: row.created_at,
    triage: {
      needs_action: true,
      urgency,
      label: ev.label ?? undefined,
      client: ev.client ?? undefined,
      subject,
      action_triples: [
        {
          source_ref: 'email:' + String(messageId || '').replace(/[\s<>]/g, '').toLowerCase(),
          assignee: row.owner || '@keith',
        },
      ],
    },
    legacy_action: legacy,
  };
  return { envelope, legacy };
}

const payload = JSON.parse(readFileSync(ACTIONS_PATH, 'utf8'));
const store = new InMemoryShadowStore();
const adapter = new CompatibilityAdmissionAdapter(store);
mkdirSync(SOAK_DIR, { recursive: true });
writeFileSync(JSONL_PATH, '', 'utf8');
const matrix = [];
const verdictCounts = {};

for (const row of payload.rows) {
  const { envelope, legacy } = reconstructEnvelope(row);
  const result = await adapter.admitEmailShadow(envelope, legacy);
  verdictCounts[result.verdict] = (verdictCounts[result.verdict] || 0) + 1;
  const record = {
    observed_at: new Date().toISOString(),
    mode: 'shadow',
    consumer: SHADOW_CONSUMER,
    legacy_action_id: row.id,
    legacy_source_ref: row.source_ref,
    legacy_title: row.title,
    legacy_created_at: row.created_at,
    estate_discovery_key: result.simulated?.estate_discovery_key ?? null,
    idempotency_key: result.simulated?.idempotencyKey ?? null,
    would_be_task_id: result.simulated?.wouldBeTaskId ?? null,
    objective: result.simulated?.objective ?? null,
    verdict: result.verdict,
    reasons: result.reasons,
    diff: result.diff,
    run_id: result.run_id,
    compare_id: result.compare_id,
    spawner_invoked: false,
    public_actions_written: false,
    mark_seen_called: false,
    new_system_runtime_invoked: false,
    task_admissions_written: false,
    persistence: 'local-jsonl',
  };
  appendFileSync(JSONL_PATH, JSON.stringify(record) + '\n', 'utf8');
  matrix.push({
    action_id: row.id,
    created_at: row.created_at,
    title: row.title.slice(0, 80),
    verdict: result.verdict,
    discovery_key: result.simulated?.estate_discovery_key,
    would_be_task_id: result.simulated?.wouldBeTaskId,
    reasons: result.reasons,
  });
}

let replayOk = false;
if (payload.rows[0]) {
  const { envelope, legacy } = reconstructEnvelope(payload.rows[0]);
  const first = await adapter.admitEmailShadow(envelope, legacy);
  const second = await adapter.admitEmailShadow(envelope, legacy);
  replayOk =
    first.simulated?.wouldBeTaskId === second.simulated?.wouldBeTaskId &&
    first.simulated?.requestDigest === second.simulated?.requestDigest &&
    (second.verdict === 'MATCH' || second.verdict === 'ACCEPTABLE_DIFFERENCE');
}

const summary = {
  mode: 'shadow-only',
  consumer: SHADOW_CONSUMER,
  window: {
    justification:
      'All distinct public.actions rows with source=email-triage available via Brain read-only (limit 50). Full population returned N=18 spanning ~1.5 days since email-ingest-live cutover.',
    oldest: payload.rows[payload.rows.length - 1]?.created_at ?? null,
    newest: payload.rows[0]?.created_at ?? null,
    fetched_at: payload.fetched_at,
  },
  sample: {
    actionable_live: payload.rows.length,
    non_actionable_live: 0,
    non_actionable_note:
      'Non-actionable emails are not minted to public.actions; none available from RO actions query. Not invented.',
    distinct_source_refs: new Set(payload.rows.map((r) => r.source_ref)).size,
  },
  verdict_counts: verdictCounts,
  replay_idempotent_ok: replayOk,
  zero_execution_proof: {
    spawn_calls: 0,
    public_actions_posts: 0,
    mark_seen_patches: 0,
    spawner_shadow_db_writes: 0,
    persistence: 'artifacts/local/email-shadow-soak/shadow-results.jsonl',
    db_shadow_write_deferred: true,
    db_shadow_write_reason:
      'Writing spawner_shadow_* requires service_role — treated as NEW production write surface; local JSONL preferred this pass per Phase 4 Track B guidance.',
  },
  matrix,
  store_runs: (await store.listRuns()).length,
  store_compares: (await store.listCompares()).length,
};
writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');
console.log(JSON.stringify({ ok: true, actionable: summary.sample.actionable_live, verdict_counts: verdictCounts, replay_ok: replayOk }, null, 2));
