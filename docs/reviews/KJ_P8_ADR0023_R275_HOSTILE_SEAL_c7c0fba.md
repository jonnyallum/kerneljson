# KJ-P8 ADR-0023 revision 2.7.5: independent hostile design seal

This file is the durable record of the independent hostile review result for ADR-0023 revision 2.7.5.

| Item | Value |
|---|---|
| ADR | ADR-0023 |
| Revision | R2.7.5 |
| Sealed design SHA | `c7c0fba524655b19e06deb39cec5b6d5426c4ce4` |
| Hostile verdict | `APPROVE_R275_DESIGN` |
| Previous blockers | R273-B1 CLOSED; R273-B2 CLOSED; R274-B1 CLOSED |

**The seal covers DESIGN ONLY.** It does not authorise B1 implementation remediation, production mutation, ledger
repair or backfill, `--include-all`, a B1 target baseline, deployment or P8A-0. B1 implementation remediation against
this design needs its own explicit authorisation from the owner.

## What is sealed

| Item | Value |
|---|---|
| Repository | `jonnyallum/kerneljson` |
| Sealed design commit | `c7c0fba524655b19e06deb39cec5b6d5426c4ce4` |
| Parent (revision 2.7.4, blocked) | `0436cff8a331c9129dfa9fa6248a5851988798a8` |
| Branch | `design/kjp8-reflection-governed-growth` (tip at the time of this record, no later commit) |
| Files changed by the sealed commit | `docs/adr/0023-reflection-self-model-governed-growth.md` (modified) |
| Files changed since the R2.7.2 seal (`3acd6b2`) | `docs/adr/0023-reflection-self-model-governed-growth.md` (modified), `docs/operations/KJ_P8_R273_EPHEMERAL_EVIDENCE_2026-10-09.md` (added) |
| SHA-256 of the ADR blob at `c7c0fba` | `dfeacb3b1578ff8df4c8eebf173b73dce25c5a6a5a4f67087a47f0aa9fbee837` (Git blob `ebccb06785b2a87e1a4890852c1ed82572192ebd`) |
| SHA-256 of the sequence document blob at `c7c0fba` | `17a3ec17739886389e455d1abf0d8a120196bda8d3becaba4a3a24527049ad1f` (unchanged since `3acd6b2`) |
| SHA-256 of the R2.7.2 evidence document blob at `c7c0fba` | `a2e68524ac6ae82764980cb990e34a6bdc1661410c2538d177ade3477a1878dd` (unchanged since `3acd6b2`) |
| SHA-256 of the R2.7.3 evidence document blob at `c7c0fba` | `2ec5b5036332ffad998ce1afa97c14229c72506186f3e60201480fb99097925c` (Git blob `431b7625d26d0bb07544ec73602449e17eca251c`) |
| Frozen pre-remediation B1 | `0ff2919c1bbf722b4842aa56fdc94ef9b74e5a51` (not changed, not covered by this seal) |

The seal applies to `c7c0fba` itself, which is frozen. **The commit that adds this record is not the sealed design
commit** and is not a design revision. It changes no ADR text. Any later change to the design files is unsealed until
reviewed again. As with the R2.7.2 seal, the sealed ADR stays on the design branch; `main` receives the records only.

Hashes are of Git blobs (`git show c7c0fba:<path> | sha256sum`). This repository normalises line endings, so a
Windows checkout may write the files with CRLF and hash differently; hash the blob, or strip carriage returns first.

## Lineage

| Revision | Commit | Result |
|---|---|---|
| 2.7.2 | `3acd6b2180ad6d231e1b1693aa63bc49c07cf780` | `APPROVE_R27_2_DESIGN` (record `KJ_P8_ADR0023_R272_HOSTILE_SEAL_3acd6b2.md`) |
| 2.7.3 | `e93657198cb4ac363ad8af6c96d6d678f9e8883e` | BLOCK: R273-B1, R273-B2 (recorded in ADR-0023 section 0) |
| 2.7.4 | `0436cff8a331c9129dfa9fa6248a5851988798a8` | `BLOCK_R274_DESIGN`: R274-B1; R273-B1 and R273-B2 CLOSED |
| 2.7.5 | `c7c0fba524655b19e06deb39cec5b6d5426c4ce4` | **`APPROVE_R275_DESIGN`** |

Revision 2.7.3 corrected a contradiction found when B1 remediation began against R2.7.2: a disposable database gets a
new system identifier each time, so no declaration committed at the release commit could match it (ADR-0023 section 0,
R272-EPHEMERAL). Revisions 2.7.4 and 2.7.5 close the hostile findings on that correction. The R2.7.2 seal record is not
altered by this record.

## Verdict as supplied

Reproduced exactly as relayed by Jonny on 09/10/2026. Nothing has been added to the reviewer's findings.

```
R2.7.5 has now received independent hostile approval from Grok.

VERDICT: APPROVE_R275_DESIGN

APPROVED_SHA:
c7c0fba524655b19e06deb39cec5b6d5426c4ce4

R273-B1: CLOSED
R273-B2: CLOSED
R274-B1: CLOSED

Architecture ruling:

1. Leave N2 unchanged. Record it as nonblocking editorial debt in the seal.
2. Do not create another ADR revision or commit.
3. Freeze the approved R2.7.5 SHA.
4. Preserve N3–N9 as documented implementation-hardening obligations.
5. Keep both CLI executable pins.
6. Do not change the H1 environment contract to address telemetry without separate review.
```

## Nonblocking items from the R2.7.4 review

The R2.7.4 hostile review (verdict `BLOCK_R274_DESIGN`, relayed on 09/10/2026) listed these as hardening that does not
block. The architecture ruling above keeps N2 as editorial debt and N3 to N9 as implementation-hardening obligations.
They do not change revision 2.7.5. Wording follows the relay.

- **N2, editorial debt (not corrected, by ruling 1).** 27.12.13.2 still says hosted mode adds "one added refusal"; the
  27.10.4 "Artefact" and "Snapshot procedure" paragraphs should name `HOSTED_COMMITTED`. The normative text elsewhere
  (27.10.4 "Mode and run binding", 27.12.6 step 2, 27.12.13.11) governs.
- **N3, status channel.** Define where the runner's emitted status and record SHA live; the runner's own CI step output
  would do.
- **N4, hook location.** Hooks should be named effects implemented inside the runner, not in-process callbacks from
  test files.
- **N5, engine telemetry.** The engine contacts `*.i.posthog.com` on port 443 on every run (observed by the reviewer on
  Linux). Allow `DO_NOT_TRACK=1` or state the egress policy. By ruling 6, the H1 environment contract (27.12.13.7 item
  4) is not changed for this without separate review.
- **N6, deployed health.** It should have no path to run-directory artefacts; how it tells the two contexts apart is
  unspecified (inherited H6).
- **N7, baseline blob.** Put the baseline's blob SHA in the hosted cutover record, and re-read it in post-migration
  qualification.
- **N8, S4 comparisons.** S4 should explicitly compare `run.application` and `containerCreated` with the current
  values.
- **N9, post-COMMIT state.** State that B1 stays committed after a post-COMMIT failure outside `public` and
  `kernel_private`.

The reviewer also reported, as its own reproduction on Linux with the pinned 2.120.0 binaries against a disposable
PostgreSQL 17.11 (not the pinned 17.6 image): the H1 environment worked; injected `PGOPTIONS`, `PGHOST`, `PGSERVICE`,
`PGPASSFILE` and `SUPABASE_ACCESS_TOKEN` did not reach the engine; fakes on the parent's `PATH` never ran; and only the
`supabase` launcher executed, with `supabase-go` never opened. Windows was not verified. By ruling 5, both CLI
executable pins stay.

The R2.7.3 review's further hardening recommendations, other than H1, H2 and H5 (folded into revision 2.7.4), remain
implementation obligations by the owner's R2.7.4 brief. Their text is not held in this repository.

## Provenance and limits of this record

- **FACT:** the verdict and ruling above, and the R2.7.4 review report from which N2 to N9 are taken, were pasted into
  the Claude Code session by Jonny on 09/10/2026, relayed from the independent reviewer.
- **The R2.7.5 reviewer's complete report is not held.** Only the verdict and ruling were supplied. If it is later
  supplied, it is to be committed verbatim beside this file, with a provenance file, as was done for revision 2.3.
- The recording session authored the design under review. It cannot attest that the review took place; it attests to
  the relay and to the checks below.

## Checks made by the recording session

`git ls-remote`, `git log`, `git diff` and `sha256sum`, on 09/10/2026:

- `origin/design/kjp8-reflection-governed-growth` was `c7c0fba524655b19e06deb39cec5b6d5426c4ce4`, with no later commit;
- the parent of `c7c0fba` is `0436cff8a331c9129dfa9fa6248a5851988798a8`, whose parent is
  `e93657198cb4ac363ad8af6c96d6d678f9e8883e`, whose parent is `3acd6b2180ad6d231e1b1693aa63bc49c07cf780`;
- `git diff --name-status 3acd6b2 c7c0fba` is exactly `M docs/adr/0023-reflection-self-model-governed-growth.md` and
  `A docs/operations/KJ_P8_R273_EPHEMERAL_EVIDENCE_2026-10-09.md`;
- CI run 37908550313 ("Kernel qualification") on `c7c0fba` succeeded, `validate` and `identity-cognition-mutations`;
  the change is documents only, so this proves nothing about the runner;
- `origin/feat/kjp8-b1-runtime-least-privilege` was `0ff2919c1bbf722b4842aa56fdc94ef9b74e5a51`;
- `origin/main` was `3984afd717d4a7359c45f71f08508d2681955bc9`;
- the blob hashes in the table above were computed on the blobs at `c7c0fba`.

## Remaining B1 implementation obligations

Carried into B1 implementation remediation and checked by B1's own hostile review:

- everything ADR-0023 revision 2.7.5 specifies and nothing yet implements: the hook registry, the platform baseline
  and declaration artefacts, the runner's two entry points, the single connection factory with L5, the
  `plannedApplications` constant, the per-step outcome record and the single status function, each with its static and
  negative cases (27.12.9 and 27.12.13.9, including EPH-1 to EPH-27);
- the seven hardening items of the R2.7.2 seal record;
- N3 to N9 above;
- facts the design states but has not observed: the CI image store's `Config.Image`, the pinned CLI starting under the
  H1 environment on each pinned platform, and EPH-26 and EPH-27 end to end;
- the six historical production ledger rows remain unresolved and unauthorised, so production refuses at the ledger
  gate.

## Related records

- `docs/reviews/KJ_P8_ADR0023_R272_HOSTILE_SEAL_3acd6b2.md`: the R2.7.2 seal, unchanged.
- `docs/reviews/KJ_P8_ADR0023_R23_HOSTILE_SEAL_679e3a3.md` and its provenance file: the earlier ADR-0023 seal.
