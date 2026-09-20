-- KJ-P4B.1 - replay memory for signed control assertions.
--
-- PREPARED ONLY. NOT APPLIED TO PRODUCTION BY THIS CHANGE - same convention as the earlier migrations:
-- written and tested against a disposable Postgres, and applied to production only in a separate,
-- explicitly authorised change window (see docs/operations/KJ_P4B_TELEGRAM_APPROVALS.md).
--
-- Restate journals every header of an incoming request for 24 hours, so the long-lived control key is
-- never sent. The door sends a short-lived HMAC assertion over each exact request instead
-- (services/kernel/src/control-signing.ts). Restate also redelivers durable work with identical
-- headers, so "seen before" cannot mean "reject": each nonce is remembered together with the sha256
-- of the canonical payload it was first used with.
--   first sight, fresh on THIS database's clock      -> recorded, accepted
--   seen again with the identical payload digest     -> accepted (an idempotent replay)
--   seen again with a different digest               -> rejected
--   never seen and older than the freshness window   -> rejected
--
-- This table holds nothing secret: a random nonce, a digest, the key id and the route parts. It is
-- not an authority and is never read to decide an approval. Rows are purged after seven days by the
-- verifier itself; an assertion older than that is stale, so a purge can only make a replay fail.
create table kernel_private.control_assertions (
  nonce text primary key check (nonce ~ '^[A-Za-z0-9_-]{22,64}$'),
  key_id text not null check (key_id ~ '^[A-Za-z0-9._-]{1,16}$'),
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  service text not null check (length(service) between 1 and 80),
  handler text not null check (length(handler) between 1 and 40),
  workflow_key text not null check (length(workflow_key) between 1 and 200)
);
-- The purge and any audit scan by time.
create index control_assertions_first_seen on kernel_private.control_assertions(first_seen_at);

alter table kernel_private.control_assertions enable row level security;
revoke all on kernel_private.control_assertions from public, anon, authenticated;
