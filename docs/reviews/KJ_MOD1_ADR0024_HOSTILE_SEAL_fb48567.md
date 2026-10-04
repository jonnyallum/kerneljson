**EXECUTIVE VERDICT: APPROVE**

ADR-0024 at `fb485675855c702b23d9c95eee855a8e15f148a7` transcribes approved Revision 3.1. The C-1 key sets are source semantics, not an ADR invention. H2 through H5 only pin implementation of rules Revision 3.1 already stated.

**EXACT ADR SHA REVIEWED**

`fb485675855c702b23d9c95eee855a8e15f148a7`

File: `docs/adr/0024-agent-session-capability-shadow-admission.md` (1641 lines, SHA-256 `ec37e3f73a89052494663f4291d073c317b89aacd9e6721419f276a290fa71e9`)

**SOURCE DESIGN SHA**

`55180c83997f7913ffafec0db4a70aaa2ed38cb8`

File: `docs/design/KJ_MOD1_SHADOW_ADMISSION_R3_1.md` (SHA-256 `5153b6c291194e44b165e956671bb0c1a3c8aa3b4a783ea02bccf7fb5a65cedb`, the hash the ADR prints)

**REPOSITORY / SCOPE VERIFICATION**

The commit exists. Its only parent is canonical main `20e39f797be9c4c982bc32fb40b6aa1427b5c09c`. It adds one file, the ADR, 1641 lines and no deletions. No code, migration, B1, P8, MOD-0, or production file changed. The blocked candidate `bfe08fb` is not the parent.

**SEMANTIC EQUIVALENCE**

PASS

Shared Revision 3.1 sections are the same text, or that text plus an ADR-only tail. The one rewritten row is the section 19 token-location refusal, and it still ends in `CAPABILITY_UNKNOWN`. The additions are front matter, Decision, Non-goals, §6.6, §12.1.1's non-normative `cell_type` note, §12.1.2, §12.2.1, §16.1.1, the R5 provenance paragraph, the §24.2 vectors, and restatements of the MOD-2 fence, the P8 split, and the deferred preconditions.

**C-1 LINEAGE**

C1_SOURCE_SEMANTIC_PRESERVED

§12.1.1 matches approved Revision 3.1 and the Claude Code 2.1.289 `BuiltinToolInputs` in the combined declaration file, SHA-256 `79ab1ef9555704ac479dfcbc61ef27aa11773da4b98258de19604b07ceae07af`.

Edit: `file_path` string required, `old_string` string required, `new_string` string required, `replace_all` boolean optional.

Write: `file_path` string required, `content` string required.

NotebookEdit: `notebook_path` string required, `cell_id` string optional, `new_source` string required, `cell_type` `"code"` or `"markdown"` optional, `edit_mode` `"replace"`, `"insert"`, or `"delete"` optional.

The class is still the zone of the path key. The other keys are type-checked, counted toward the ceiling, secret-screened, and never sent or retained. This is not ADR24-B1.

**G1 CANONICALITY**

- Structured entries: 11
- Shell productions: 35 (P1 through P35)
- New classes: 0
- New productions: 0

R0 through R5, S1 through S5, the path rule, the URL rule, the UNKNOWN default, and preimage-only meaning are unchanged. A G1 result still describes the captured call, not the effect.

**PINNED SCHEMA ENUMERATION**

ENUMERATION_ONLY

§12.1.2 pastes the 2.1.289 Grep and Agent keys. I read those declarations. Every name, required or optional mark, and literal union matches. No key is added or dropped. The §12.1 rules stay "option keys declared by the pinned schema" for Grep and "type keys declared by the pinned schema" for Agent. The subsection says the types are reference only and add no classification rule beyond §12.2. Every in-grammar Agent call is still `AGENT_DELEGATE`.

**HARDENING TABLE**

- H2: HARDENING_ONLY
- H3: HARDENING_ONLY
- H4: HARDENING_ONLY
- H5: HARDENING_ONLY

**H5 ALGORITHM REVIEW**

The ceiling stays 64 KiB, now defined as 65,536 bytes. The sum is the encoded size of consequential values that are present. R0 keys are excluded, which matches §13 step 2, because that step does not copy them. Key names are not counted. Strings are UTF-8 bytes. An unpaired surrogate is 3 bytes, which is both its WTF-8 size and the size of U+FFFD, so TypeScript `TextEncoder` and a Python counter that follows this sentence agree. `true` is 4 and `false` is 5. A number is the byte length of ECMAScript `Number.prototype.toString`. Anything else is already UNKNOWN. 65,536 is allowed. 65,537 is `UNKNOWN_TOOL_ACTION` / `NONE` with `INPUT_TOO_LARGE`. Shell commands keep the separate 512 ASCII-byte S1 limit.

Counting booleans and numbers, and not counting key names, chooses one measurement Revision 3.1 left open. It stays inside the existing ceiling on the copied consequential input. It does not add a class, a key, or a way for content to change the path-derived class. Ordinary inputs are far under the ceiling, so their class does not move. V-H5-10 is faithful: a 70,000-space Bash `description` is R0 and is not copied, and `git status` remains P1.

**H5 VECTOR ARITHMETIC**

All ten match. `<p>` cancels.

| Vector  | Computed                                | Claimed |
| ------- | --------------------------------------- | ------- |
| V-H5-1  | 65536                                   | 65536   |
| V-H5-2  | 65537                                   | 65537   |
| V-H5-3  | 65537 (`é` is 2)                        | 65537   |
| V-H5-4  | 65536 (U+1F600 is 4)                    | 65536   |
| V-H5-5  | 65536 (`€` is 3)                        | 65536   |
| V-H5-6  | 65537                                   | 65537   |
| V-H5-7  | 65536 (one unpaired surrogate is 3)     | 65536   |
| V-H5-8  | 65536 (`x` is 1, `true` is 4)           | 65536   |
| V-H5-9  | 65537 (`x` is 1, `false` is 5)          | 65537   |
| V-H5-10 | 10 (`git status`; description excluded) | 10      |

**NOTEBOOKEDIT REVIEW**

The declaration marks `cell_type` optional. Its comment says `cell_type` is required when `edit_mode` is `insert`. The ADR follows the type, as Revision 3.1 did, and adds no cross-field rule. That is correct.

**AUTHORITY REVIEW**

Unchanged: `authority_domain`, `evidence_canonicality`, `assertion_origin`, the capability, issuance, confirmation, token audience `kerneljson-agent-shadow/v3`, TTL (default 15 minutes, maximum 30), no refresh and no reveal, policy, roles, repository truth, ordering, coverage, storage, replay, and child agents. H5 cannot turn UNKNOWN into authority. A classified write is still a shadow preimage.

**TOKEN REVIEW**

Audience, shape (`kjsc_` plus 43 base64url characters), digest-only storage, and loss behaviour are unchanged. §6.6 makes "outside every repository" and "readable only by the current user" exact: real path, refuse a `.git` ancestor, refuse a linked target, POSIX `0700` and `0600`, a protected Windows owner-only DACL, and an atomic temp write. Writer failure is still `DELIVERY_LOST`. Reader failure is still `CAPABILITY_UNKNOWN`. The mod still never writes the file. No recovery path is added.

**ROLE / PRIVILEGE REVIEW**

`kj_shadow_door` and `kj_shadow_issuer` keep the §16.4 ceiling. The issuer's column-limited UPDATE is now exactly `state`, `failed_proof_count`, `minted_capability_id`, and `state_changed_at`. `issuance_digest` and `completion_proof_digest` are immutable. The trigger is security invoker with the pinned search path. Allowed transitions are `PENDING` to `CONFIRMED`, `REFUSED`, or `EXPIRED`, and `CONFIRMED` to `MINTED` or `EXPIRED`, which is the §5.3 and §5.5 machine. No new role and no SECURITY DEFINER function.

**ASYNC / COVERAGE REVIEW**

Unchanged. Confirmation is still the second request bound by the completion proof. Coverage and the queue states are the source text.

**DEFERRED PRECONDITIONS**

VALID_DEFERRED_PRECONDITIONS

Still deferred before implementation: door scopes or a separate HUMAN issuance credential, the delta manifest, Telegram transport wiring, each shadow function's privileges, and the final topology allowed paths. Section 26's six preconditions are the source list. The ADR does not fill them in.

**MOD-2 FENCE REVIEW**

There is still no enforcement switch. A future MOD-2 needs its own design, its own seal, a new contract, a new endpoint, a different token audience and prefix, and fresh decision-time evaluation. Shadow tokens stay refused on every non-shadow route.

**B1 / P8 REVIEW**

The order stays `B1 → P8A-0 → B2 → P8A-1 → P8A-2 → P8B`. MOD-1 is not a P8 prerequisite. No MOD-1 object enters the B1 manifest. B1 candidate `108db1b0db5923993eb17888d3039c5a32890c2c` is untouched. ADR-0023 is untouched.

**NEW BLOCKERS**

None.

**NON-BLOCKING HARDENING**

None required. The size unit, the column list, the token-path checks, and the vector-file constraint are the hardening this seal was asked to judge, and they hold.

**RESIDUAL RISKS**

A non-finite number is not named. If one were received, ECMAScript `toString` still fixes the size: `NaN` is 3, `Infinity` is 8, `-Infinity` is 9, and `-0` is `"0"` (1). A JSON tool call cannot carry those values. The Python classifier must emulate that `toString`, which §12.2.1 point 5 already requires. The mod cannot re-check the POSIX mode, because the pinned `FsStat` does not expose permissions. The writer enforces it, and §25 says so. The reader's `.git` walk stops at 64 ancestors.

**FINAL VERDICT**

APPROVE

ADR-0024 SHA fb485675855c702b23d9c95eee855a8e15f148a7 is hostile-sealed as the canonical KJ-MOD-1 agent session capability and shadow admission decision, authored from hostile-approved Revision 3.1. This seal authorises no implementation, migration, merge, deployment, enforcement, B1 modification or P8 modification.
