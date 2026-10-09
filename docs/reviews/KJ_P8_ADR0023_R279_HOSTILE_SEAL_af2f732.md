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

## Nonblocking hardening (implementation considerations)

Relayed with the verdict. These are **not design blockers** and do not change revision 2.7.9. They are carried into
B1 implementation and its own hostile review. Wording follows the relay.

1. Prefer `logging_collector=on` or `jsonlog`, or explicitly document the false-failure behaviour for large concurrent
   statements.
2. Define line endings for the log extraction as LF.
3. Treat an empty log line as untrusted.
4. Restrict marker provenance to the runner's process and user.
5. Treat an orphan runtime-role `42501` `STATEMENT` record as untrusted.
6. Optionally check `%l` continuity.
7. Do not use the author's host-dependent collection standard-output hash as a portable pin. (The hash recorded in
   the regression inventory, `73ccff08...2f88`, is evidence from one Windows host, not a pin.)
8. The implementation obligations already carried forward from earlier reviews remain nonblocking: those listed in
   ADR-0023 27.12.15 ("Implementation obligations from the R2.7.7 review" and "... from the R2.7.6 review"), and the
   items the R2.7.9 brief kept nonblocking (`log_error_verbosity`, function-level `proconfig` logging settings, a scan
   for service-issued SQL exception handlers, exact-text pinning of each B1 `DO` block, the exact `", "` separator in
   the gapped-ledger message, the discover-twin intentional-skip clarification, result binding to commit, suite and
   digest, the stage T timeout, database OIDs, the Docker network id, paused state, Docker events, teardown order,
   compose restrictions, working directory and environment, the two-layer forms of CON-4 and CON-5, and the CON-9
   hook). The seven hardening items of the R2.7.2 seal record and N3 to N9 of the R2.7.5 seal record also remain.

## Evidence limitations

- **Reviewer's evidence.** The relay gives the verdict, the closure statuses, the PASS checklist, the authority
  boundary and the hardening list. It gives no separate statement of the reviewer's own evidence limitations, so this
  record states none on the reviewer's behalf. The reviewer's earlier R2.7.7 and R2.7.8 reports (relayed in this
  session, not committed) described their environment as Vitest 5.0.0 on Node 20 in an offline disposable copy and a
  socket-only PostgreSQL 17.11 cluster, not the pinned 17.6 image, with no database-backed suite, Docker or runner
  run; whether the same applied to the R2.7.9 review is not stated in the relay.
- **The reviewer's complete R2.7.9 report is not held.** If it is later supplied, it is to be committed verbatim
  beside this file, with a provenance file, as was done for revision 2.3.
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

- `docs/reviews/KJ_P8_ADR0023_R275_HOSTILE_SEAL_c7c0fba.md`: the R2.7.5 seal, unchanged.
- `docs/reviews/KJ_P8_ADR0023_R272_HOSTILE_SEAL_3acd6b2.md`: the R2.7.2 seal, unchanged.
- `docs/reviews/KJ_P8_ADR0023_R23_HOSTILE_SEAL_679e3a3.md` and its provenance file: the earlier ADR-0023 seal.
