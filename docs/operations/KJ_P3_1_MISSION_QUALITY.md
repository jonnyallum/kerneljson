# KJ-P3.1 - mission contract, claim grounding and cross-provider review

**Status: code complete, PR open, not deployed.** Nothing in production changes until a release is built and activated.
**Builds on:** `docs/operations/KJ_P3_FIRST_AGENT_MISSION.md` and the frozen first live mission (main `9f28732`).
**Scope:** `repo-analysis-mission/v1` only. No redesign: the same four steps, the same ledger backstop, the same outbox notice.

Evidence tags: OBSERVED means read or run in this work. INFERRED means reasoned, not run.

## Why

The first live mission passed, and its own result record named three weaknesses:

1. The question asked for three findings and the analyst returned eight. The kernel did not check the count.
2. The kernel verified that cited paths exist, not that a finding stands on anything the commit actually holds.
3. Analyst and reviewer were both DeepSeek, so they could share blind spots.

KJ-P3.1 closes each with the smallest change that is enforced by the kernel and not by prompt wording.

## 1. Mission contract

The requested count is carried by the task objective, which is immutable once admitted, so the workflow and the ledger
backstop both re-derive the same contract from it and neither can relax it.

```
owner/repo findings=3 <question>        exactly 3 findings
owner/repo max-findings=5 <question>    between 1 and 5
owner/repo <question>                   between 1 and 8 (the default)
```

| Field | Meaning |
|---|---|
| `outputSchema` | `repo-analysis-findings/v2`, the required output shape |
| `requestedFindings` | the exact count asked for, or null when only a ceiling applies |
| `minFindings`, `maxFindings` | the bounds the reconciler enforces (an exact count fixes both) |

- **Parsed at admission.** `parseMissionObjective` runs in `compileIntent`, so a malformed directive (`findings=0`, `findings=13`,
  `findings=three`, both directives together, a repeated directive) is refused at the door and never becomes a task.
- **Directives count only straight after the slug.** The English in the question is never read for a number, so a question that says
  "the three best improvements" does not change the contract. To ask for three, say `findings=3`. This is deliberate: a contract
  that depends on parsing prose is a contract a model can talk its way around.
- **Enforced by a new reconcile check**, `analysis_finding_count_within_contract`, plus the existing schema check for missing
  required fields and a new `analysis_findings_cited` for uncited findings. The default ceiling is 8, which is what the analyst
  prompt already told the model; the schema's hard cap stays 12.
- **Re-derived by the ledger.** `verifyMissionCompletion` reads the contract from `task.objective` and recomputes the
  reconciliation, so a workflow that accepted the wrong count is refused and the task ends FAILED.
- **The task's acceptance criterion is unchanged**, so task identity and the plan are exactly as before.
- **CLI:** `mission admit --findings N` or `--max-findings N`. A different count is a different idempotency key; a request with no
  directive keeps exactly the key it had, so an existing label still replays.

## 2. Claim grounding

**What it proves:** each finding stands on named files at the exact captured commit. **What it does not prove:** that the finding is
true. A grounded claim can still be a wrong claim; that is what the reviewer runtime is for, and the reviewer can approve badly.

**Mechanism.**

1. The GitHub reader already fetches the recursive tree at the captured commit, and GitHub returns each entry's git object id
   (a file's blob id, a directory's tree id) in that response. The reader now records it. **No extra request**: still four GETs, all
   pinned to the captured sha. The object ids are part of the facts and so part of the evidence digest.
2. The analyst is shown each entry as `f <12 character object id prefix> <path>` and must cite each finding as
   `{"path": ..., "blobSha": <that prefix>}` in an `evidence` array (replacing the old bare `paths`).
3. The reconciler resolves every citation against the persisted tree:
   - `analysis_findings_cited`: every finding cites at least one entry.
   - `analysis_paths_exist_in_evidence`: every cited path is in the tree.
   - `analysis_evidence_binds_to_commit`: every cited path carries the object id the tree holds for it, and the analysis names the
     captured head. A path that exists with the wrong id, or an id from another commit's version of the file, is refused.
4. For a fully grounded analysis the kernel computes one digest per finding over `{headSha, path, full object id}` for what that
   finding cites, and records them as `findingEvidenceDigests` in the reconciliation evidence. A model cannot compute a hash, so the
   kernel does. A citation may carry the full 40 characters or a prefix of at least 12.

**Why this and not excerpts.** Verifying a quoted excerpt needs the file's content in the evidence, which means fetching files the
analyst has not yet chosen, or a second evidence phase. That is a redesign. Object-id binding gives the property that matters most
for "grounded in this exact repository evidence": a finding cannot stand on a file version the commit does not hold, and a change to
a cited file changes the digest.

## 3. Cross-provider review

The provider is now chosen **per role** from the shape of the model name, so the two roles can use different providers.

| Model shape | Provider | Key |
|---|---|---|
| bare `deepseek-...` | DeepSeek direct | `MISSION_DEEPSEEK_API_KEY` |
| `family/slug` (`anthropic/`, `x-ai/`, `deepseek/`) | OpenRouter | `MISSION_OPENROUTER_API_KEY` |

Rules, all fail closed at worker start: each key a model needs must be set; **a key no model uses is refused** (a worker should
not hold a credential it never exercises); every model must be in an allowed family; and the two models must be different models,
judged on the slug after any `family/` prefix, so `deepseek-v4-pro` direct and `deepseek/deepseek-v4-pro` through OpenRouter count
as one model. No new environment variable: the compose file, the topology check and the env-merge allow-list already carry all four.

**Preferred production configuration:** analyst `deepseek-flash` (or `deepseek-v4-flash`) direct, reviewer
`anthropic/claude-sonnet-5` through OpenRouter. Claude first; Grok (`x-ai/grok-4.6`) is the alternative.
OBSERVED 20/09/2026, from OpenRouter's public model list: `anthropic/claude-sonnet-5` is listed (1,000,000 context, 2 and 10 per
million tokens in and out), as are `anthropic/claude-opus-5` and `x-ai/grok-4.6`. **INFERRED, not run:** that the slug answers on
Jonny's account; no funded key is in the vault yet, so no live call was made.

**What the record holds, per role:** the requested model, the model the provider reports it ran (`response_model`), the provider
label, and the artifact digest (sha256 of the returned text), all on the runtime's own evidence row. The reconciliation adds
`independence`: both providers, both families, `crossProvider` and `crossFamily`.

**Honest limits.** Model identity through a router is **provider-reported, not cryptographically proven**; the record says so and
the kernel makes no stronger claim. `crossProvider` is a fact about two ports; `crossFamily` is the one that matters for
independent blind spots, so DeepSeek direct plus DeepSeek through OpenRouter is `crossProvider: true, crossFamily: false` and is
recorded as such. A same-provider pair is still accepted as the fallback and is recorded as the weaker configuration.

## Reconciliation checks (13, in order)

`analysis_schema_valid`, `analysis_head_sha_matches_evidence`, **`analysis_finding_count_within_contract`**,
**`analysis_findings_cited`**, `analysis_paths_exist_in_evidence`, **`analysis_evidence_binds_to_commit`**, `review_schema_valid`,
`review_binds_to_analysis`, `analyst_runtime_allowed`, `reviewer_runtime_allowed`, `reviewer_is_independent`,
`review_verdict_acceptable`, `review_flags_no_unsupported_findings`. Bold are new. The reconciliation also records `contract`,
`findingCount`, `findingEvidenceDigests` and `independence`.

## Tests

Every required case is a deterministic test, and each was checked by breaking the implementation on purpose.

| Required case | Where |
|---|---|
| asks for 3, receives 8: reject | `mission-core` "asks for 3 and receives 8"; end to end and in the ledger in `mission-workflow.integration` |
| asks for 3, receives exactly 3: eligible | `mission-core` "asks for 3 and receives exactly 3"; end to end "asked for exactly three findings and got three" |
| missing citation: reject | `mission-core` "rejects an uncited finding"; schema-level "required field missing" |
| path exists, evidence digest does not bind: reject | `mission-core` "path exists but the evidence digest does not bind" (only the binding check fails) |
| evidence from the wrong head SHA: reject | `mission-core` "another commit" and "different head sha"; end to end "another commit's version" |
| valid grounded finding: accept | `mission-core` "accepts a valid grounded finding" with the expected per-finding digest computed independently |
| same-model analyst and reviewer: reject | `mission-core` "same model", including the same model through two routes |
| cross-provider analyst and reviewer: accept | `mission-core` "cross-provider, cross-family pair"; end to end on the real ledger |

The existing replay, idempotency, ledger-tamper, notice-isolation and no-business-table-mutation tests are unchanged and pass.
Negative controls run: with the count check disabled four tests fail; with the binding check disabled seven fail; with independence
compared on raw strings the two-routes test fails; with the ledger verifier ignoring the admitted contract, the
"workflow accepted eight, admitted three" test completes the mission instead of failing it.

## Compatibility and deployment notes

- **Evidence format changes** for new missions: tree entries carry an object id, findings carry `evidence`, the reconciliation has
  four new fields. The completed first mission's evidence is not re-verified anywhere (the verifier runs only at completion), so it
  is untouched, but it would not parse under the new schema. INFERRED from a search of every parse site.
- **Deploy with no mission in flight.** A mission whose GitHub facts were journalled by the old worker lacks object ids and would end
  FAILED with `GITHUB_READ_FAILED` on replay by the new one. There is no in-flight mission today.
- `ANALYST_MAX_TOKENS` rises from 4096 to 6144 because the analysis now carries an object id per citation. INFERRED headroom: the
  first mission's analysis used 1872 output tokens for eight findings.
- The tree in the prompt grows by about 13 characters per entry (about 13KB at the 1000-entry cap), still inside the prompt guard.

## What remains before one production mission can use Claude review

1. Review and merge the PR (not merged here).
2. A key from Jonny's funded OpenRouter account, stored in jVault under a **new** name (for example
   `kerneljson/MISSION_OPENROUTER_API_KEY`), with a length check of 73. Not present today.
3. One live call to confirm `anthropic/claude-sonnet-5` answers on that account, before any activation.
4. Build and deploy a release on `kerneljson-prod-01` inside a change window, keeping the DeepSeek key and analyst model, adding
   the OpenRouter key and `MISSION_REVIEWER_MODEL=anthropic/claude-sonnet-5` through the env-merge tool, then activate the epoch.
5. Run one mission with `--findings 3` and read the reconciliation's `independence` and `findingEvidenceDigests`.

## Known limits

- Grounding proves a claim is bound to repository evidence, not that it is true.
- No excerpt or symbol-level check: that needs file content captured before analysis and is the natural next hardening.
- No automatic retry: a mission the kernel rejects ends FAILED with evidence.
