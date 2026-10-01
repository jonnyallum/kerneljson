# Provenance of the KJ-P8 ADR-0023 revision 2.3 hostile seal record

This file is local metadata. It is **not** reviewer text. The reviewer's complete report is the file beside it:

`docs/reviews/KJ_P8_ADR0023_R23_HOSTILE_SEAL_679e3a3.md`

That file is the independent hostile review, verbatim and complete, with nothing added, removed or reworded. All
local notes are kept here so the two cannot be confused.

**This record does not authorise implementation, merge or deployment.** B1 needs its own explicit authorisation.

## Identity of the artefact

| Item | Value |
|---|---|
| Verdict | APPROVE, for exact commit `679e3a3dfc7a33f9106ed77913d49cdac19166d5` only |
| Base main reviewed against | `750d5b7926f320d8e9d3f64789b8f7035eaa4f3d` |
| Reviewer's original path | `/workspace/docs/reviews/KJ_P8_ADR0023_R23_HOSTILE_SEAL_679e3a3.md` (the reviewer's environment) |
| Reviewer-declared SHA-256 | `beae9a3d9068bd1511a77ea28da4cfdb2b980e3e3e25bef3bf4f9d36ba3a1c92` |
| SHA-256 of the copy committed here | `beae9a3d9068bd1511a77ea28da4cfdb2b980e3e3e25bef3bf4f9d36ba3a1c92` |
| Size | 22,911 bytes, 342 lines, LF line endings |
| Seal written (per the report) | 1 October 2026, 23:42 BST |

**The committed copy is byte-identical to the reviewer's original.** The hash was computed on the file as recovered
and again on the Git blob after commit (`git show <commit>:<path> | sha256sum`), and both equal the declared value.

One caution for anyone re-checking: this repository normalises line endings. A Windows checkout may write the file
with CRLF, and hashing that working copy gives a different value. Hash the blob, or strip carriage returns first.

## How it was recovered

- 1 October 2026: only the verdict block was available, pasted into the recording session. A first version of this
  record held that block and said plainly that the full review was not held.
- 2 October 2026, 00:06: the complete report was placed at
  `C:\Users\jonny\Desktop\kerneljson\docs\reviews\KJ_P8_ADR0023_R23_HOSTILE_SEAL_679e3a3.md` by Jonny. Its hash
  matched the reviewer-declared value exactly, so it was copied here unchanged.
- The recording session authored the design under review. It cannot attest that the review took place; it attests
  to the hash match and to the checks below.

## Checks made by the recording session

`git ls-remote`, `git rev-parse` and `git diff`, on 1 and 2 October 2026:

- `origin/main` was `750d5b7926f320d8e9d3f64789b8f7035eaa4f3d`;
- `origin/design/kjp8-reflection-governed-growth` was `679e3a3dfc7a33f9106ed77913d49cdac19166d5`, with no later commit;
- the parent of `679e3a3` is `53f2ab011f0de627f3de97fd76d287b2beeb18c9`;
- the diff from base main to `679e3a3` is exactly `docs/adr/0023-reflection-self-model-governed-growth.md` and
  `docs/operations/KJ_P8_IMPLEMENTATION_SEQUENCE.md`.

These agree with section 1 of the report.

## What is sealed, and what is not

- The seal applies to `679e3a3dfc7a33f9106ed77913d49cdac19166d5` itself.
- The commit that adds this record is **not** the sealed design commit and is not a design revision.
- Any later change to the two design files is unsealed until reviewed again.
- At the time of this record the sealed ADR is on the design branch, not on `main`. `main` holds the records only.

## Review history of ADR-0023

| Revision | Commit | Result |
|---|---|---|
| 1 | `f2b36fa928a475307c6913f87f0d6dc0e031a243` | BLOCK: B-RL, B-SEC, B-EV, B-GW, B-CHK, B-ISO |
| 2 | `12580fd0b9c36f328c8868d8ddf4a2abcc44cb98` | not sealed; superseded by the author before review |
| 2.1 | `90264f4e314313a4bb372ba4e1ea2522e1d1a5e4` | BLOCK: B-DEDUP-NORM (the original six passed) |
| 2.2 | `53f2ab011f0de627f3de97fd76d287b2beeb18c9` | BLOCK: P8-R22-B1-LP, P8-R22-LIST-EDIT (see the note below) |
| 2.3 | `679e3a3dfc7a33f9106ed77913d49cdac19166d5` | **APPROVE** |

**Note on revision 2.2.** The report records two results for `53f2ab0`: a local seal by this reviewer that returned
APPROVE, and a separate independent hostile re-seal, relayed by Jonny, that returned BLOCK. The reviewer treated the
BLOCK findings as the defects revision 2.3 had to close, and re-reviewed the whole design. The BLOCK is the result
that governed. The reports for revisions 1, 2.1 and 2.2 are not held in this repository; they were relayed as pasted
text and live at the `/workspace` paths the report names.

## Related records

- `docs/reviews/KJ_P8_PR49_K2_RECONCILIATION.md`: PR #49 and the pre-seal K2 work against the sealed design.
- `docs/operations/KJ_P8_B1_ENTRY_BRIEF.md`: the B1 contract extracted from ADR section 27.
