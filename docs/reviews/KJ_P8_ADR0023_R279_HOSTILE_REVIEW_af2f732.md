# KJ-P8 ADR-0023 revision 2.7.9: hostile review, verbatim

## Provenance (recording session, outside the verbatim body)

| Item | Value |
|---|---|
| Supplied by | Jonny, pasted into the Claude Code session on 09/10/2026 |
| Reviewer | Grokbot |
| Reviewed SHA | `af2f7320aae32eaa0ce699b1c09d015371f156d5` |
| Verdict | `APPROVE_R279_DESIGN` |
| SHA-256 of the verbatim body (UTF-8, LF, as between the fences below, without the final line feed) | `62283b2e8255b350c80b849729534f339c585b97c540eaf41386747f7ee0d7b3` |

This repository record is a relay of the review text. It does not itself attest to the reviewer's local evidence files
or scripts (the review places them under `/workspace/r279` on the reviewer's computer; they are not in this
repository). The body below is reproduced exactly as supplied, inside a text fence so that Markdown does not reflow
it; nothing in it has been corrected. Where its wording appears to have lost characters in transit, the seal record
`KJ_P8_ADR0023_R279_HOSTILE_SEAL_af2f732.md` says so in a recording-session note and does not change the text here.

## Review (verbatim)

```text
Starting the final R2.7.9 review of af2f732, focused on R278-B1 and B2. I'll re-run the pinned collection on the frozen tree with a placeholder listener, and test the log extraction and fingerprint rules on PostgreSQL with interleaved backends and tabs inside the SQL.

The review is running in the background. Alongside your attack list, I'm checking whether SQL containing a newline followed by kjlog| can forge a log record, and whether vite's .env loading can sneak in an unpinned database URL. I'll send the verdict in your format when it's done.

R2.7.9 is approved. Every earlier blocker is closed, and I found no new blocker at af2f732.

REVIEWED_SHA: af2f7320aae32eaa0ce699b1c09d015371f156d5. I checked it independently: it's the branch tip, and its real parent field is the commit below.
PARENT: 8c0f8e73435386623fff2b252bbb37a1515491e3. The chain is af2f732 then 8c0f8e7 then 5ee7f6c, and 1b2b7e7, c7c0fba and 0ff2919 all resolve.

Finding    Status
R276_B1    CLOSED
R276_B2    CLOSED
R277_B1    CLOSED
R277_B2    CLOSED
R277_B3    CLOSED
R278_B1    CLOSED
R278_B2    CLOSED
PASS checklist

PINNED_COLLECTION_CONTRACT: PASS.
I ran it on Linux with Node 22.19.0, using the exact environment and a separate network namespace. A real listener sat on 54999 and every connect call was recorded.
Result: 2192 entries, 107 of 107 files, every entry located. Accepted connections were 0 and connect calls were 0. A deliberate test connection was caught by both counters, so the detection works.
The tree has no .env file, and vitest 5.0.0 doesn't load one. Tests only change what they register based on the four pinned flags, KJ_TEST_PG_URL and one KJ_RUNTIME_ROLES skip. A mismatch in any of these can only fail the check, never pass it wrongly.
COLLECTION_COMPLETENESS: PASS. Every collected location has a report entry. 224 of 224 protected tests and 62 of 62 intentional skips match by full name. The four files not run in CI contain exactly their declared skips.
ZERO_EXPANSION_RULE: PASS. The leftover gap is a brand-new .each table that is empty from the start and isn't protected. It can't remove anything from the required B1 list or the baseline, so it bypasses no coverage. I accept it.
SKIP_GATE_RULE: PASS. I re-ran the attack where the skip gate is removed and beforeAll fails. The report showed zero failed tests and an empty failure message, but success was false and the file status was failed. The new rule rejects it, whereas a check on failed tests or the message alone would have let it through. CON-37 is now correct.
CON47: PASS. Every negative is caught.
Static parse gives 104 files, and leaving out locations gives unlocated entries. Leaving out JSON gives output that isn't JSON.
A missing flag, a flag set to 0 or a flag set to true each give 106 files. A missing KJ_TEST_PG_URL gives 101.
A different URL, or an extra DATABASE_URL, still collects 107 files. Only the static test's exact-environment assertion catches those, and the design requires that assertion.
PRIMARY_LOG_EVENT_EXTRACTION: PASS.
CONTEXT, STATEMENT and DETAIL records that carry 42501 are not counted as events.
A FATAL connection refusal by kj_door has no matching statement, so the suite fails as specified.
SQL text containing a newline followed by kjlog|, inside a literal or an identifier, gets a leading TAB from PostgreSQL. It's read as a continuation line, not a new record, so it can't forge one.
BACKEND_CORRELATION: PASS.
Matching was exact with up to 100 concurrent backends, statements up to about 6 KB and both roles.
Statements of 30–80 KB did interleave across backends in the pipe, but the parser marked those lines untrusted and the suite failed. That's a limited false failure, not a false pass.
TRACE_FINGERPRINT: PASS. pg 8.23.0 sends the query text unchanged, and the repository only sends plain string queries.
LOG_FINGERPRINT: PASS.
Log and trace hashes matched byte for byte across CRLF, tabs, double spaces in literals, trailing and leading newlines, comments, $n placeholders with a cast, prepared statements, statements over 600 characters, non-ASCII text and a trailing ; .
'x y' and 'x y' hash differently. The separator is exactly STATEMENT: (two spaces).
ADDITIVE_LOG_PROJECTION: PASS. The same SQL from two tests counts twice, and the same SQL from the other role is a separate key. All 18 keys matched the trace.
CON48: PASS. I reproduced it on PostgreSQL 17.11, with 20 refusals across both roles, the FATAL case, the forgery attempts and the concurrency runs.
CON43_ACL_PRECONDITION: PASS.
Base ACL {postgres=X/postgres}.
The perturbation hook produces exactly owner, anon and authenticated EXECUTE.
After frozen B1 the ACL is exactly the owner ACL again, with prosecdef true and an empty search_path.
When proacl is NULL, the exact three-item match is impossible, so that trap can't pass the check.
SEALED_INVARIANTS_REGRESSED: NO. None of the 28 removed lines is in sealed c7c0fba.
NEW_AUTHORITY: NONE
P8_SEQUENCE_CHANGED: NO
IMPLEMENTATION_AUTHORISED: NO
MERGE_AUTHORISED: NO
PRODUCTION_MUTATION_AUTHORISED: NO
NONBLOCKING_HARDENING

Pin logging_collector=on or jsonlog to avoid pipe interleaving. Otherwise, state plainly that statements over 4 KB under concurrency can cause false failures.
Define a line as ending in LF only, because a CR inside a literal must not split a line.
State explicitly that an empty line counts as untrusted.
Accept markers only from the runner's own process and user. A kj_worker session could RAISE LOG a matching marker; that already fails against the trace, but it's cleaner to exclude it.
Treat an orphan 42501 STATEMENT from a runtime role as untrusted. Optionally, check that %l line numbers run consecutively within each event.
The author's pinned stdout hash 73ccff08… depends on the file path, so it won't reproduce on another host. Bind the normalised set of file, name and location instead. My Linux output hash was e127d120….
All previously carried-forward items stay nonblocking.
NOT VERIFIED

The PostgreSQL 17.6 Docker image and reading the Docker log. I used PostgreSQL 17.11 locally because my computer has no Docker.
A HINT record.
A live database run, including the recovery ≥27 count.
Windows collection.
CI on af2f732.
lanes.json, b1-required.json, the hook registry and the fixture SQL, which still don't exist at this candidate.
For the CON-43 check, I applied frozen B1 with psql to a scratch database, not through the runner, only to read the ACL.
The evidence and scripts are under /workspace/r279 on my computer.

FINAL: APPROVE_R279_DESIGN. It's bound to af2f7320aae32eaa0ce699b1c09d015371f156d5 and ready for a seal record at that SHA. It authorises no implementation, merge, B1 application, production action, ledger repair or P8A-0.
```
