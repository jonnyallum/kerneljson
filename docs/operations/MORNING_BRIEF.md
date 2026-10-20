# Morning brief (`morning-brief/v1`)

A daily brief of the last 24 hours, delivered to Telegram at 07:00 Europe/London, run as an ordinary KernelJSON task.

## What it does

The recipe has the repository-analysis mission's four steps and adds no new kind of step:

1. `GITHUB_EVIDENCE` reads two sources, read-only:
   - GitHub activity across every repository `GITHUB_READ_TOKEN` can see that was pushed to in the window: default-branch commits, open pull requests, and the latest default-branch workflow run (`CapabilityServiceV1.githubActivity`);
   - KernelJSON's own task counts and latest canary, from the ledger.
2. `RUNTIME_ANALYSE`: the analyst model (`MISSION_ANALYST_MODEL`) writes the brief as JSON. Every item cites references from the evidence (`commit:`, `pr:`, `ci:`, `repo:`, `kj:`, `memory:`, `scan`).
3. `RUNTIME_REVIEW`: the reviewer model (`MISSION_REVIEWER_MODEL`, which must be a different model) checks that each item's claim follows from what it cites.
4. `RECONCILE`: the kernel checks the window, that every item is cited, that every reference exists in the evidence, that the review is bound to this brief, and that the two models are independent.
   - Items the reviewer flags are withheld and the rest are delivered.
   - The brief fails if the reviewer rejects it outright, flags every item, or flags an item that does not exist.

The ledger re-derives all of this from persisted evidence before it commits COMPLETED (`mission/verify-brief.ts`). Only then is the brief queued in the outbox.

A completed brief is delivered as its own text, the one exception besides operator replies (`alerting/brief-notice.ts`). A failed brief is an ordinary redacted P2 notice.

## Configuration

- No new secret. It uses the existing `MISSION_*` runtimes and `GITHUB_READ_TOKEN`, and the token must be able to list repositories (`GET /user/repos`). It also needs read access to Contents on every repository it can list: a 403 on commits fails the whole brief (fail closed).
- `SCHED_BRIEF_SCHEDULE_ID` is the UUID of the brief's schedule:
  - unset or empty means no schedule admits a brief;
  - set, the worker refuses to start without the mission runtimes, the read token and the admission seam.

That schedule admits `morning-brief/v1`; every other schedule keeps `SCHED_RECIPE`.

## Local dry run (writes nothing)

```
pnpm brief:dry-run [--send-to-telegram] [--out run.json]
```

- Run it with `--env-file` holding `MISSION_*`, `GITHUB_READ_TOKEN` and, for `--send-to-telegram`, `ALERT_TRANSPORT=telegram`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
- It drives the real mission, the real model ports and the real completion verifier against an in-memory ledger.
- KernelJSON's own state is empty in a dry run, and a sent dry run is labelled as one.

## Release (production change window, owner approval required)

This release changes `KERNELJSON_RELEASE_ID`, so [RELEASE_PROVENANCE.md](RELEASE_PROVENANCE.md) applies in the same window. Record the baseline first: release, current `release_epoch`, both image IDs, the runtime env files, the Restate deployment and the canary's state and next wake.

1. **Deploy** the worker and admission door images from the merged commit, with matching `KERNELJSON_RELEASE_ID`.
   - Both images are needed, because the door's recipe allowlist gains `morning-brief/v1`.
   - Quiesce binding ingress first: stop the door (the scheduler and Telegram admit through it) and confirm binding and admission counts stop changing and no task is nonterminal. Preserve Restate and the canary's pending wake.
   - Re-register the worker's Restate deployment: `CapabilityServiceV1` gains a `githubActivity` handler.
   - Keep the door stopped until step 2 commits.
2. **Activate the release (mandatory).** As the database owner, in a dedicated transaction:
   ```sql
   BEGIN;
   SET LOCAL lock_timeout = '10s';
   SELECT kernel_private.activate_release(:request_uuid, :release_sha, :current_epoch, :evidence_json);
   COMMIT;
   ```
   - Choose `:request_uuid` once and reuse it for any uncertain retry. `:current_epoch` is the baseline epoch; the call must return that epoch plus one.
   - From a fresh connection, verify the singleton epoch and its activation record name `:release_sha`, worker and door report the same release, there are zero binding/epoch mismatches and the canary is unchanged. Then start the door.
   - From here a brief can already be admitted by hand through the door (`recipe: morning-brief/v1`, `objective: morning brief`). Use that for the first verified run before any schedule exists.
3. **Seed the schedule (disabled):**
   ```
   canary-runner install-brief --schedule-id <new uuid> --tenant-id <tenant> --owner-id <Jonny's principal> --created-at <iso>
   ```
4. **Enable it:**
   ```
   canary-runner enable-canary --schedule-id <uuid> --tenant-id <tenant> --actor-id <Jonny's principal> --from-version v1 --to-version v2 --created-at <iso> --expected-state disabled
   ```
5. **Point the worker at it:** set `SCHED_BRIEF_SCHEDULE_ID=<uuid>` in the worker's runtime env and recreate the worker.
6. **Arm the first wake**, as for the canary (`docs/production/phase-s1-canary/DURABLE_RESTATE_WAKE_RESULT_2026-09-13.md`): one `POST /ScheduleDriver/<uuid>/fire/send` for the next 07:00 window. With `SCHED_ARM_NEXT=true` it then re-arms itself.

**Rollback:**
- `disable-canary` on the brief's schedule, and unset `SCHED_BRIEF_SCHEDULE_ID`. The disable is required, not optional: an armed brief schedule on a worker without the variable would fire as the canary.
- To revert the release as well: quiesce ingress again and drain nonterminal tasks, restore the prior images and env files, re-register Restate, then activate the prior release with a **new** request UUID and the then-current epoch. Never reuse the forward request or move the epoch back. Verify epoch and parity before starting the door.
- The canary is unaffected throughout.

## Verification

- **Task:** COMPLETED, with exactly four evidence rows: `kerneljson:github-activity/v1`, `runtime/analyst`, `runtime/reviewer` and `brief-reconcile/v1`. `/task <id>` shows it.
- **Scope:** `facts.github.reposVisible` in the evidence shows how many repositories the production token can see. If it is lower than expected, the token's scope is the cause.
- **Memory:** after `/remember` a priority, the next brief's analyst evidence lists it under `memory_context` and may cite it.
- **Delivery:** one `MISSION.morningBrief.<task>.completed` outbox row reaches DELIVERED, and the brief arrives once.
- **Failure path:** a failed brief commits FAILED with evidence and a single P2 notice.
- **Unattended:** two consecutive 07:00 briefs with no manual trigger, and the 08:00 canary unchanged.
