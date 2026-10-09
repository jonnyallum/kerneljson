# KJ-P8 ADR-0023 revision 2.7.9: independent hostile design seal

This file is the durable record of the independent hostile review result for ADR-0023 revision 2.7.9.

| Item | Value |
|---|---|
| ADR | ADR-0023 |
| Revision | R2.7.9 |
| Sealed design SHA | `af2f7320aae32eaa0ce699b1c09d015371f156d5` |
| Reviewed parent (revision 2.7.8, blocked) | `8c0f8e73435386623fff2b252bbb37a1515491e3` |
| Hostile verdict | `APPROVE_R279_DESIGN` |
| Previous blockers | R276-B1, R276-B2, R277-B1, R277-B2, R277-B3, R278-B1 and R278-B2, all CLOSED |

**The seal covers DESIGN ONLY.** It does not by itself grant B1 implementation authority, and it does not authorise a
merge of a B1 implementation, B1 deployment, production mutation, migration ledger repair, a B1 target baseline
capture, or the start of P8A-0. The next activity, repository implementation of B1, needs its own separate
authorisation.

## What is sealed

| Item | Value |
|---|---|
| Repository | `jonnyallum/kerneljson` |
| Sealed design commit | `af2f7320aae32eaa0ce699b1c09d015371f156d5` |
| Branch | `design/kjp8-reflection-governed-growth` (tip at the time of this record, no later commit) |
| Files changed by the sealed commit against its parent | `docs/adr/0023-reflection-self-model-governed-growth.md` (modified), `docs/operations/KJ_P8_R276_REGRESSION_INVENTORY_2026-10-09.md` (modified) |
| Files changed since the R2.7.5 seal (`c7c0fba`) | `docs/adr/0023-reflection-self-model-governed-growth.md` (modified), `docs/operations/KJ_P8_R276_REGRESSION_INVENTORY_2026-10-09.md` (added) |
| SHA-256 of the ADR blob at `af2f732` | `c8a2cffa33180d9517534a88e815713248ca903ede21ccc3ac9d6144ca54aad7` (Git blob `03d369a50cce0d00a410bef7f2bba382edd58163`) |
| SHA-256 of the regression inventory blob at `af2f732` | `cc2d6fdea8d8e5dc48e9d4e9009fa74f04d12e4dbd1a0c4c8372f74fc67f4f60` (Git blob `f9175b2e41b2e468c2e25317c21b9e5ae6ccd327`) |
| SHA-256 of the sequence document blob at `af2f732` | `17a3ec17739886389e455d1abf0d8a120196bda8d3becaba4a3a24527049ad1f` (unchanged since `3acd6b2`) |
| SHA-256 of the R2.7.2 evidence document blob at `af2f732` | `a2e68524ac6ae82764980cb990e34a6bdc1661410c2538d177ade3477a1878dd` (unchanged since `3acd6b2`) |
| SHA-256 of the R2.7.3 evidence document blob at `af2f732` | `2ec5b5036332ffad998ce1afa97c14229c72506186f3e60201480fb99097925c` (unchanged since `e936571`) |
| Frozen pre-remediation B1 | `0ff2919c1bbf722b4842aa56fdc94ef9b74e5a51` (not changed, not covered by this seal) |

The seal applies to `af2f732` itself, which is frozen. **The commit that adds this record is not the sealed design
commit** and is not a design revision. It changes no ADR text. Any later change to the design files is unsealed until
reviewed again. As with the earlier ADR-0023 seals, the sealed ADR stays on the design branch; `main` receives the
records only.

Hashes are of Git blobs (`git show af2f732:<path> | sha256sum`). This repository normalises line endings, so a
Windows checkout may write the files with CRLF and hash differently; hash the blob, or strip carriage returns first.

## Lineage since the R2.7.5 seal

| Revision | Commit | Result |
|---|---|---|
| 2.7.5 | `c7c0fba524655b19e06deb39cec5b6d5426c4ce4` | `APPROVE_R275_DESIGN` (record `KJ_P8_ADR0023_R275_HOSTILE_SEAL_c7c0fba.md`) |
| 2.7.6 | `93a00d11d97b9054f29fbefd5945492666504223` | BLOCK: R276-B1, R276-B2 |
| 2.7.7 | `5ee7f6ce54cf44e80a79cf4efdc3a454ee15cc22` | `BLOCK_R277_DESIGN`: R276-B1 closed; R277-B1 to R277-B3 |
| 2.7.8 | `8c0f8e73435386623fff2b252bbb37a1515491e3` | `BLOCK_R278_DESIGN`: R278-B1, R278-B2 |
| 2.7.9 | `af2f7320aae32eaa0ce699b1c09d015371f156d5` | **`APPROVE_R279_DESIGN`** |

Revision 2.7.6 began when B1 remediation against R2.7.5 stopped before any code: the existing regression suite could
not use a database holding B1 under the R2.7.5 runner contract (ADR-0023 section 0, R275-HARNESS). Revisions 2.7.6
to 2.7.9 integrate the regression suite (ADR-0023 27.12.15) and close the hostile findings on that integration. The
R2.7.2 and R2.7.5 seal records are not altered by this record.

## Verdict as supplied

Reproduced as relayed by Jonny on 09/10/2026. Nothing has been added to the reviewer's findings.

Correction (child commit of `e02f026`): the reviewer's complete R2.7.9 review was supplied on 09/10/2026 and is
stored verbatim in `docs/reviews/KJ_P8_ADR0023_R279_HOSTILE_REVIEW_af2f732.md`. It is the authoritative text; the
block below is the summary relayed with the seal brief, kept unchanged.

```
Grok independently reviewed exact:

af2f7320aae32eaa0ce699b1c09d015371f156d5

and returned:

APPROVE_R279_DESIGN

All previous design blockers are closed:

R276_B1 CLOSED
R276_B2 CLOSED
R277_B1 CLOSED
R277_B2 CLOSED
R277_B3 CLOSED
R278_B1 CLOSED
R278_B2 CLOSED

Approved checks include:

PINNED_COLLECTION_CONTRACT PASS
COLLECTION_COMPLETENESS PASS
ZERO_EXPANSION_RULE PASS
SKIP_GATE_RULE PASS
CON47 PASS

PRIMARY_LOG_EVENT_EXTRACTION PASS
BACKEND_CORRELATION PASS
TRACE_FINGERPRINT PASS
LOG_FINGERPRINT PASS
ADDITIVE_LOG_PROJECTION PASS
CON48 PASS

CON43_ACL_PRECONDITION PASS

SEALED_INVARIANTS_REGRESSED NO
NEW_AUTHORITY NONE
P8_SEQUENCE_CHANGED NO
```

Authority boundary, as relayed: design approval only. It does not grant B1 implementation authority by itself, merge
of B1 implementation, B1 deployment, production mutation, migration ledger repair, target baseline capture, or the
start of P8A-0.

## Reviewer's evidence (REVIEWER SAID, summarised from the stored review)

Positive evidence the reviewer reported; the full wording is in the stored review, and nothing here is stronger
than it:
- **Collection.** Run on Linux with Node 22.19.0, the exact pinned environment, in a separate network namespace with
  a real listener on 54999 recording every connect call: 2192 entries, 107 of 107 files, every entry located, zero
  accepted connections and zero connect calls; a deliberate test connection was caught by both counters. No `.env`
  file in the tree, and Vitest 5.0.0 does not load one.
- **Completeness.** Every collected location has a report entry; 224 of 224 protected tests and 62 of 62 intentional
  skips match by full name; the four files not run in CI contain exactly their declared skips.
- **Skip gate.** The CON-37 attack (skip gate removed, `beforeAll` failing) reproduced: zero failed tests and an empty
  failure message, but `success` false and the file status failed, which the new rule rejects.
- **CON-47.** Every negative caught: static parse 104 files; no locations gives unlocated entries; no JSON gives
  non-JSON output; a missing flag, a flag set to `0` or to `true` 106; no `KJ_TEST_PG_URL` 101. A different URL or an
  extra `DATABASE_URL` still collects 107 files and is caught only by the static test's exact-environment assertion,
  which the design requires.
- **Log extraction and correlation.** On PostgreSQL 17.11 locally: `CONTEXT`, `STATEMENT` and `DETAIL` records
  carrying `42501` not counted; a `FATAL` connection refusal by `kj_door` with no statement fails the suite as
  specified; SQL containing a newline followed by `kjlog|` is read as a continuation, so it cannot forge a record;
  exact matching with up to 100 concurrent backends, statements up to about 6 KB and both runtime roles; statements of
  30 to 80 KB interleaved in the pipe, were marked untrusted and failed the suite (a limited false failure, not a
  false pass).
- **Fingerprints.** pg 8.23.0 sends the query text unchanged; log and trace hashes matched byte for byte across CRLF,
  tabs, double spaces in literals, leading and trailing newlines, comments, `$n` placeholders with a cast, prepared
  statements, statements over 600 characters, non-ASCII text and a trailing `;`.
- **Projection and CON-48.** The same SQL from two tests counts twice, the same SQL from the other role is a separate
  key, all 18 keys matched; CON-48 reproduced with 20 refusals across both roles, the `FATAL` case, the forgery
  attempts and the concurrency runs.
- **CON-43.** Base ACL `{postgres=X/postgres}`; the hook produces exactly owner, `anon` and `authenticated` EXECUTE;
  after frozen B1 the ACL is exactly the owner ACL again, with `prosecdef` true and an empty `search_path`; a null
  `proacl` cannot satisfy the exact three-item match.
- **Regression.** None of the 28 removed lines is in sealed `c7c0fba`. All previous blockers CLOSED.

**Recording session notes** (not the reviewer's words):
- The stored review reads "'x y' and 'x y' hash differently" and "The separator is exactly STATEMENT: (two spaces)."
  As supplied, both quoted literals show a single space, and the separator shows one space. The surrounding wording
  (two literals that differ, "two spaces") indicates that double spaces were collapsed in transit. The review is
  stored as supplied; this note is the only interpretation offered, and it is the recording session's, not the
  reviewer's.
- The reviewer's Linux collection output hash is quoted in the review as `e127d120...`; the author's Windows hash in
  the regression inventory is `73ccff08...`. Neither is a pin (hardening item 6).

## Nonblocking hardening (implementation considerations)

From the stored review (corrected in the child commit of `e02f026`). These are **not design blockers** and do not
change revision 2.7.9. They are carried into B1 implementation and its own hostile review.

1. Pin `logging_collector=on` or `jsonlog` to avoid pipe interleaving, or state plainly that statements over 4 KB
   under concurrency can cause false failures.
2. Define a line as ending in LF only, because a CR inside a literal must not split a line.
3. State explicitly that an empty line counts as untrusted.
4. Accept markers only from the runner's own process and user.
5. Treat an orphan `42501` `STATEMENT` from a runtime role as untrusted; optionally, check that `%l` line numbers run
   consecutively within each event.
6. Do not use the author's host-specific collection standard-output hash (`73ccff08...`, which depends on the file
   path) as a portable pin; bind the normalised set of file, name and location instead.
7. All previously carried-forward items stay nonblocking: the implementation obligations already carried forward from earlier reviews remain nonblocking: those listed in
   ADR-0023 27.12.15 ("Implementation obligations from the R2.7.7 review" and "... from the R2.7.6 review"), and the
   items the R2.7.9 brief kept nonblocking (`log_error_verbosity`, function-level `proconfig` logging settings, a scan
   for service-issued SQL exception handlers, exact-text pinning of each B1 `DO` block, the exact `", "` separator in
   the gapped-ledger message, the discover-twin intentional-skip clarification, result binding to commit, suite and
   digest, the stage T timeout, database OIDs, the Docker network id, paused state, Docker events, teardown order,
   compose restrictions, working directory and environment, the two-layer forms of CON-4 and CON-5, and the CON-9
   hook), the seven hardening items of the R2.7.2 seal record, and N3 to N9 of the R2.7.5 seal record.

## Evidence limitations

- **Reviewer's NOT VERIFIED list** (REVIEWER SAID, from the stored review; corrected in the child commit of
  `e02f026`, which replaces the earlier statement that no reviewer limitations were supplied and that the full report
  was not held):
  1. the PostgreSQL 17.6 Docker image and reading the Docker log; the reviewer used PostgreSQL 17.11 locally because
     their computer has no Docker;
  2. a `HINT` record;
  3. a live database run, including the recovery count of at least 27;
  4. Windows collection;
  5. CI on `af2f732`;
  6. `lanes.json`, `b1-required.json`, the hook registry and the fixture SQL, which do not exist at this candidate;
  7. for the CON-43 check, frozen B1 was applied with `psql` to a scratch database, not through the runner, only to
     read the ACL.
- **The reviewer's complete R2.7.9 review is held**, verbatim, in
  `docs/reviews/KJ_P8_ADR0023_R279_HOSTILE_REVIEW_af2f732.md`. The reviewer's evidence files and scripts are on the
  reviewer's computer and are not in this repository.
- **Complementary coverage** (RECORDING SESSION NOTE): two of the reviewer's NOT VERIFIED items were covered by the
  author, not by the reviewer: the pinned 17.6 image with the Docker log read (author's log experiment, recorded in
  the regression inventory), and Windows collection (author's collection runs). CI on `af2f732` ran: run 37961376082
  succeeded (see the checks below).
- **Author-side evidence** (recorded in the regression inventory at `af2f732`): the pinned collection and its failing
  variants, reproduced on Windows with Node 25.2.1 (the repository pins 22.19.0); and the log extraction, reproduced
  on the pinned `postgres:17.6` image under Docker Desktop for Windows. Not reproduced by the author: the
  execution-report match of the 224 protected tests and 62 intentional skips (reviewer-derived), the Linux collection
  environment, concurrent backends, `kj_door`, a `FATAL` refusal and `DETAIL` or `HINT` records. The `_acl` hook's
  pre-hook ACL is inferred from the migration text.
- The recording session authored the design under review. It cannot attest that the review took place; it attests to
  the relay and to the checks below.

## Checks made by the recording session

`git ls-remote`, `git log`, `git diff` and `sha256sum`, on 09/10/2026:

- `origin/design/kjp8-reflection-governed-growth` was `af2f7320aae32eaa0ce699b1c09d015371f156d5`, with no later
  commit;
- the parent of `af2f732` is `8c0f8e73435386623fff2b252bbb37a1515491e3`;
- `git diff --name-status 8c0f8e7 af2f732` is exactly the two modified files above;
- CI run 37961376082 ("Kernel qualification") on `af2f732` succeeded, `validate` and `identity-cognition-mutations`;
  the change is documents only, so this proves nothing about the runner;
- `origin/feat/kjp8-b1-runtime-least-privilege` was `0ff2919c1bbf722b4842aa56fdc94ef9b74e5a51`;
- `origin/main` was `1b2b7e7be3d0de69ad49efbb47cc988822ab0f64`;
- the blob hashes in the table above were computed on the blobs at `af2f732`.

## Related records

- `docs/reviews/KJ_P8_ADR0023_R279_HOSTILE_REVIEW_af2f732.md`: the complete R2.7.9 hostile review, verbatim.

- `docs/reviews/KJ_P8_ADR0023_R275_HOSTILE_SEAL_c7c0fba.md`: the R2.7.5 seal, unchanged.
- `docs/reviews/KJ_P8_ADR0023_R272_HOSTILE_SEAL_3acd6b2.md`: the R2.7.2 seal, unchanged.
- `docs/reviews/KJ_P8_ADR0023_R23_HOSTILE_SEAL_679e3a3.md` and its provenance file: the earlier ADR-0023 seal.
