# Provenance of the KJ-MOD-1 ADR-0024 hostile seal record

This file is local metadata. It is **not** reviewer text. The reviewer's complete report is the file beside it:

`docs/reviews/KJ_MOD1_ADR0024_HOSTILE_SEAL_fb48567.md`

That file is the independent hostile review, verbatim and complete, with nothing added, removed or reworded apart from
the line-ending note below. All local notes are kept here so the two cannot be confused.

**This record does not authorise implementation, migration, merge of implementation, deployment or enforcement.**
MOD-1 stays parked behind B1.

## Identity

| Item | Value |
|---|---|
| Verdict | APPROVE, for exact commit `fb485675855c702b23d9c95eee855a8e15f148a7` only |
| ADR | `ADR-0024: KJ-MOD-1, agent session capability and shadow admission` |
| ADR path | `docs/adr/0024-agent-session-capability-shadow-admission.md` |
| ADR file SHA-256 (blob at `fb48567`) | `ec37e3f73a89052494663f4291d073c317b89aacd9e6721419f276a290fa71e9` (reviewer-declared; recomputed here, equal) |
| Source design | revision 3.1, `55180c83997f7913ffafec0db4a70aaa2ed38cb8`, `docs/design/KJ_MOD1_SHADOW_ADMISSION_R3_1.md` |
| Source design file SHA-256 | `5153b6c291194e44b165e956671bb0c1a3c8aa3b4a783ea02bccf7fb5a65cedb` (reviewer-declared; recomputed here, equal) |
| Base main reviewed against | `20e39f797be9c4c982bc32fb40b6aa1427b5c09c` |
| SHA-256 of the review file committed here | `c1b65d5ca4d9cfa346bb72a1c12146616674543dab442bf03420b5a837d09c2e` |
| Size of the review file | 9,110 bytes, 136 lines, UTF-8, LF line endings |
| Recorded | 4 October 2026, 23:07 BST (22:07 UTC) |

The reviewer did not declare a SHA-256 for the review text itself, so there is no reviewer value to compare against.
The value above is computed on the committed Git blob (`git show <commit>:<path> | sha256sum`).

One caution for anyone re-checking: this repository normalises line endings. A Windows checkout may write the file
with CRLF, and hashing that working copy gives a different value. Hash the blob, or strip carriage returns first.

## How the review text was obtained

- 4 October 2026: the first recording request named the review's verdict and closing sentence but did not contain the
  review. The recording session searched the session transcript and local folders, found no copy, and stopped
  without creating anything rather than reconstruct the text.
- 4 October 2026, 22:06 UTC: Jonny pasted the complete review into the recording session, under the instruction to
  treat everything after it as the reviewer record, verbatim, and to normalise line endings to LF only.
- The file was extracted programmatically from that message as stored in the session transcript, from
  `**EXECUTIVE VERDICT: APPROVE**` through the closing sentence ending "B1 modification or P8 modification.", so that
  no character was retyped. Line endings were normalised to LF (the pasted text contained none other), and one final
  LF was added to end the file. No other byte was changed.
- The recording session authored the ADR under review. It cannot attest that the review took place; it attests to
  the extraction above and to the checks below.

## Checks made by the recording session

`git ls-remote`, `git show` and `sha256sum`, on 4 October 2026:

- `origin/main` was `20e39f797be9c4c982bc32fb40b6aa1427b5c09c`;
- `origin/design/kj-mod1-shadow-admission-adr-r31` was `fb485675855c702b23d9c95eee855a8e15f148a7`, with no later commit;
- the only parent of `fb48567` is `20e39f797be9c4c982bc32fb40b6aa1427b5c09c`, and the commit adds exactly one file,
  `docs/adr/0024-agent-session-capability-shadow-admission.md`;
- `origin/design/kj-mod1-shadow-admission-r31` was `55180c83997f7913ffafec0db4a70aaa2ed38cb8`;
- the ADR and source design blob hashes equal the reviewer-declared values above.

These agree with the report's sections "EXACT ADR SHA REVIEWED", "SOURCE DESIGN SHA" and "REPOSITORY / SCOPE
VERIFICATION".

## Lineage

| Step | Commit | Result |
|---|---|---|
| Revision 1 | (chat design, not committed) | BLOCK: MOD1-B1 to MOD1-B6 |
| Revision 2 | (chat design, not committed) | BLOCK: MOD1-R2-B1, MOD1-R2-B2, MOD1-R2-B3 (MOD1-B2 later found closed by revision 2) |
| Revision 3 | `201dcb720aaa6a8ebec90fa77ae2ce19f94bea08` | APPROVE |
| First ADR-0024 candidate | `bfe08fb72f907a579527e6a4c6e0bb796c4bc066` | BLOCK: `ADR24-B1 / C1_SEMANTIC_DELTA` |
| Revision 3.1 | `55180c83997f7913ffafec0db4a70aaa2ed38cb8` | APPROVE |
| Replacement ADR-0024 | `fb485675855c702b23d9c95eee855a8e15f148a7` | **APPROVE / SEALED** |

The reports for revisions 1, 2, 3, 3.1 and the first ADR candidate are not held in this repository; they were relayed
as pasted text.

## What is sealed, and what is not

- The seal applies only to the exact commit `fb485675855c702b23d9c95eee855a8e15f148a7`.
- It does not apply to the branch name `design/kj-mod1-shadow-admission-adr-r31`, to any later commit on it, or to any
  future ADR commit; any change to the ADR file is unsealed until reviewed again.
- It does not apply to the blocked candidate `bfe08fb72f907a579527e6a4c6e0bb796c4bc066`.
- It does not apply to any implementation, to MOD-0 (draft PR #51, `c8ce383`), to B1 (`108db1b`), to P8 (ADR-0023), or
  to production.
- The commit that adds this record is **not** the sealed ADR commit and is not a design revision.
- At the time of this record the sealed ADR is on its design branch, not on `main`. `main` receives the records only.

## What APPROVE means

It means ADR-0024 is sufficiently complete and coherent as the canonical MOD-1 architecture decision, transcribed from
hostile-approved revision 3.1.

It does **not** authorise:

- implementation;
- migration;
- deployment;
- merge of any implementation;
- enforcement;
- MOD-2;
- B1 modification;
- P8 modification;
- production use.

## Deferred implementation preconditions

Still open before any MOD-1 implementation (ADR-0024 section 16 note and section 26). They are not seal blockers.

- final door scopes, or a separate HUMAN issuance credential if needed;
- the delta manifest;
- Telegram confirmation transport wiring;
- the exact privileges of each shadow function;
- the final allowed-path set of the topology check;
- B1 merged and qualified;
- no active P8 change window;
- a mod CI job for validate and test, pinned to a Claude Code release;
- the neutral `agent-actions` implementation with the normative vectors and the second implementation;
- a separate production change window.

## Related records

- `docs/reviews/KJ_P8_ADR0023_R23_HOSTILE_SEAL_679e3a3.md` and its provenance file: the pattern this record follows.
