# KJ-P8 ADR-0023 revision 2.7.2: independent hostile design seal

This file is the durable record of the independent hostile review result for ADR-0023 revision 2.7.2.

| Item | Value |
|---|---|
| ADR | ADR-0023 |
| Revision | R2.7.2 |
| Sealed design SHA | `3acd6b2180ad6d231e1b1693aa63bc49c07cf780` |
| Hostile verdict | `APPROVE_R27_2_DESIGN` |
| Previous blockers | R271-B1 CLOSED; R271-B2 CLOSED |

**The seal covers DESIGN ONLY.** It does not authorise B1 implementation, production mutation, ledger repair, a B1
target baseline, merge, deployment or P8A-0. B1 implementation remediation against this design needs its own explicit
authorisation from the owner.

## What is sealed

| Item | Value |
|---|---|
| Repository | `jonnyallum/kerneljson` |
| Sealed design commit | `3acd6b2180ad6d231e1b1693aa63bc49c07cf780` |
| Parent (revision 2.7.1, blocked) | `cf3b953e2f381f7f8d80de5cdf16e17ae9efe9cc` |
| Branch | `design/kjp8-reflection-governed-growth` (tip at the time of this record, no later commit) |
| Files changed by the sealed commit | `docs/adr/0023-reflection-self-model-governed-growth.md` (modified), `docs/operations/KJ_P8_R272_DISPOSABLE_PG176_EVIDENCE_2026-10-08.md` (added) |
| SHA-256 of the ADR blob at `3acd6b2` | `efe83af4def31bc37e848d68d19ffaa0e6a2dd4269cdaf28093a77a50f23aac3` |
| SHA-256 of the sequence document blob at `3acd6b2` | `17a3ec17739886389e455d1abf0d8a120196bda8d3becaba4a3a24527049ad1f` |
| SHA-256 of the evidence document blob at `3acd6b2` | `a2e68524ac6ae82764980cb990e34a6bdc1661410c2538d177ade3477a1878dd` |
| Frozen pre-remediation B1 | `0ff2919c1bbf722b4842aa56fdc94ef9b74e5a51` (not changed, not covered by this seal) |

The seal applies to `3acd6b2` itself. **The commit that adds this record is not the sealed design commit** and is not a
design revision. It changes no ADR text. Any later change to the design files is unsealed until reviewed again. The
sealed ADR stays on the design branch; `main` receives the records only.

Hashes are of Git blobs (`git show 3acd6b2:<path> | sha256sum`). This repository normalises line endings, so a
Windows checkout may write the files with CRLF and hash differently; hash the blob, or strip carriage returns first.

## Lineage

| Revision | Commit | Result |
|---|---|---|
| 2.3 | `679e3a3dfc7a33f9106ed77913d49cdac19166d5` | APPROVE (record `KJ_P8_ADR0023_R23_HOSTILE_SEAL_679e3a3.md`) |
| 2.4 | `8a17de1` | BLOCK on one item (recorded in ADR-0023 section 0) |
| 2.5 | `424f85c283a543ba00a650ecc2ecc3a4346623df` | APPROVE (recorded in ADR-0023 section 0) |
| 2.6 | `7712702020ef5d3d841f68f4d425d9707fb703eb` | hostile-sealed (stated by the owner in the R2.7 briefs) |
| 2.7 | `4d1e809b9487e4862a1759521a220180bc7c1050` | reviewed together with 2.7.1 |
| 2.7.1 | `cf3b953e2f381f7f8d80de5cdf16e17ae9efe9cc` | `BLOCK_R27_1_DESIGN`: R271-B1, R271-B2 |
| 2.7.2 | `3acd6b2180ad6d231e1b1693aa63bc49c07cf780` | **`APPROVE_R27_2_DESIGN`** |

The review reports for revisions 2.4 to 2.7.2 are not held in this repository.

## Verdict as supplied

Reproduced exactly as relayed by Jonny on 08/10/2026. Nothing has been added to the reviewer's findings.

```
HOSTILE VERDICT

APPROVE_R27_2_DESIGN

The hostile reviewer independently verified the repository and evidence.

Previous blockers:

R271-B1: CLOSED
R271-B2: CLOSED

Review findings:

ACL_PRESERVATION:
PASS

STANDARD_ENGINE_LEDGER_ATOMICITY:
PASS_CONDITIONAL_ON_PINNED_ENGINE

EXACT_PRE_B1_LEDGER_GATE:
PASS

EXACT_POST_B1_LEDGER_EQUALITY:
PASS

SIX_HISTORICAL_ROWS_STILL_BLOCK_PRODUCTION:
YES

MIGRATION_BLOB_BINDING:
PASS

CO_RESIDENT_PROVENANCE_BINDING:
PASS

SERIALISATION:
PASS

NEW_RUNTIME_AUTHORITY:
NONE

AUTHORITY FENCE FROM REVIEW

PRODUCTION_MUTATION_AUTHORISED:
NO

LEDGER_REPAIR_AUTHORISED:
NO

B1_TARGET_BASELINE_AUTHORISED:
NO

B1_IMPLEMENTATION_AUTHORISED:
NO, by the review itself

B1_DEPLOYMENT_AUTHORISED:
NO

P8A0_AUTHORISED:
NO
```

`STANDARD_ENGINE_LEDGER_ATOMICITY` passes on condition of the pinned engine: the atomicity is the observed behaviour of
the exact Supabase CLI version pinned by ADR-0023 27.12.8 item 13 (2.120.0 was the version observed). A different
engine version is not covered until its behaviour is shown by the LEDGER cases of 27.12.9.

## Nonblocking hardening (implementation and qualification considerations)

Relayed with the verdict. These are **not design blockers** and do not change revision 2.7.2. They are to be carried
into B1 implementation remediation and its qualification, and checked by B1's own hostile review. Wording follows the
relay.

1. Ensure P1 to P3 run after all authority-relevant ACL and DDL mutation in B1.
2. Sanitise the migration engine environment: `PGOPTIONS`; `PGSERVICE` and `PGSERVICEFILE`; `PGHOST`, `PGPORT` and
   `PGDATABASE`; relevant `SUPABASE_*` variables; a temporary `HOME`; and invoke the exact pinned binary path whose
   checksum was verified.
3. Hosted targets should require verified TLS, equivalent to `sslmode=verify-full`, subject to the exact production
   connection mechanism.
4. Keep statements about the six historical versions precise: because they are behind the current ledger head, the
   observed CLI refuses them without `--include-all`. No `--include-all` is authorised.
5. Reconcile the disposable `set_config` exception wording so that only explicitly authorised P3 negative tests bypass
   the normal runner.
6. The entry-level JSON schema should be exact. A global event-trigger inventory outside `public` and
   `kernel_private` remains nonblocking and must not silently expand this implementation's scope.
7. Post-migration qualification should assert that the ledger table shape remains the sealed expected shape after
   engine execution.

Note on item 4: ADR-0023 27.12.11 ("Production consequence") says that without the gate the engine would re-execute
the six historical migrations as pending. The reviewer's precise statement is that they lie behind the current ledger
head, where the observed CLI refuses them unless `--include-all` is given (and `--include-all` re-executes them). The
runner's gate refuses production either way. This record does not edit the sealed ADR; the precise wording governs
implementation documents.

## Provenance and limits of this record

- **FACT:** the verdict and the hardening list above were pasted into the Claude Code session by Jonny on 08/10/2026,
  relayed from the independent reviewer.
- **The reviewer's complete report is not held.** Only the verdict block and the hardening list were supplied. If the
  full report is later supplied, it is to be committed verbatim beside this file, with a provenance file, as was done
  for revision 2.3.
- The recording session authored the design under review. It cannot attest that the review took place; it attests to
  the relay and to the checks below.

## Checks made by the recording session

`git ls-remote`, `git rev-parse`, `git log`, `git diff` and `sha256sum`, on 08/10/2026:

- `origin/design/kjp8-reflection-governed-growth` was `3acd6b2180ad6d231e1b1693aa63bc49c07cf780`, with no later commit;
- the parent of `3acd6b2` is `cf3b953e2f381f7f8d80de5cdf16e17ae9efe9cc`, whose parent is
  `4d1e809b9487e4862a1759521a220180bc7c1050`, whose parent is `7712702020ef5d3d841f68f4d425d9707fb703eb`;
- `git diff --name-status cf3b953 3acd6b2` is exactly `M docs/adr/0023-reflection-self-model-governed-growth.md` and
  `A docs/operations/KJ_P8_R272_DISPOSABLE_PG176_EVIDENCE_2026-10-08.md`;
- `origin/feat/kjp8-b1-runtime-least-privilege` was `0ff2919c1bbf722b4842aa56fdc94ef9b74e5a51`;
- `origin/main` was `20e39f797be9c4c982bc32fb40b6aa1427b5c09c`;
- the blob hashes in the table above were computed on the blobs at `3acd6b2`.

## Related records

- `docs/reviews/KJ_P8_ADR0023_R23_HOSTILE_SEAL_679e3a3.md` and its provenance file: the earlier ADR-0023 seal.
- `docs/operations/KJ_P8_B1_ENTRY_BRIEF.md`: the B1 contract as of revision 2.3; to be reconciled to revisions 2.7 to
  2.7.2 during B1 remediation (ADR-0023 27.12.8 item 11).
