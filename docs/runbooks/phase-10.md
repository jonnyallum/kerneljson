# Phase 10: Memory fabric

`MemoryStore.remember(context, { taskId, evidenceId, validUntil? })` derives
memory from a completed task's verified Outcome. `retrieve(context, {text, at,
limit?})` returns matching result records with full provenance. `text` is a
literal case-insensitive substring, not SQL wildcards or an instruction.
Limits are 1–50, default 10; ordering is observation time then ID.

The authenticated context is supplied by the trusted caller. The service checks
current principal kind and tenant membership in the database transaction; public
Supabase roles remain denied. Memory is not automatically injected into tasks.
Expiry is exclusive and immutable. Invalid evidence, unverified tasks, conflicting
retries and content injection fail. SQL blocks UPDATE, DELETE and TRUNCATE.

Migration `20260905173500_memory_provenance.sql` adds mutation protection and a
tenant/time index to the existing table. Validate locally with `pnpm typecheck`,
`pnpm build` and `pnpm exec vitest run tests/memory.test.ts tests/database.test.ts`.
Remote application remains subject to explicit approval. No vector store,
embedding call or new secret is required. STATE.yaml records executed evidence.
