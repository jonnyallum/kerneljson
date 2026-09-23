# KJ-P5 CANONICAL MEMORY LIVE — PASS

Observed 2026-09-23. This closes P5's live memory qualification. It does not claim completion of faculties, identity, reflection, Shared Brain integration, or final system qualification.

## Release and scope

Worker and admission door both run `a577e7439f830a1fbc795a0dddd331d7d7edca78`, release epoch **9**, on `kerneljson-prod-01`. Packaging, migration, activation, CI (1,470 passed / 62 intentional skips), and rollback details are frozen in [the pre-live record](PHASE_KJ_P5_PRE_LIVE_ACTIVATION_RESULT_2026-09-23.md). No additional code, schema, or release change was needed for this live proof.

## Operator write, correction, and retrieval

Telegram update `461282861` created memory `e369f848-7be4-8d43-a998-228be7ea2884` v1 as PREFERENCE, OPERATOR_INSTRUCTION, USER_AUTHORED. There was exactly one candidate, promotion, and version. Earlier malformed command attempts created no memory.

The first pasted instruction accidentally included “Then tell me the reply so I can verify the saved memory.” Jonny subsequently authorized the correction with “your choice”. The existing canonical service's CORRECT path appended v2, preserving the complete v1 row and its original Telegram provenance. The correction records the Codex authorization and references v1; it does not pretend to be another Telegram update.

Current v2 is exactly:

> I prefer concise deployment summaries unless I explicitly ask for detail

Content digest: `49d04fb659cc275f6c258b701ce38cff21310400f48dc599bec243a0a0443be3`.

The current projection contains only v2. Both versions remain auditable. Telegram `/memories` and `/memory e369f848` updates `461282862` and `461282863` completed ANSWERED, and Jonny supplied the resulting current-memory and history replies.

## Replay boundary

Replaying the persisted original update ID and digest-verified exact command body through the production inbox claim and memory port returned the same v1 with `replayed=true`. Candidate/promotion/version counts stayed 1/1/1 and complete-row digest stayed `f28badddd5fcb706fb46358b9ca28b5570e554508b2ced40885244234923cf35`. Inbox state stayed DONE. Replaying the governed correction likewise returned the same v2 without duplicates.

This is a persisted-input/application replay proof, **not Telegram transport redelivery**. No raw original Telegram envelope was available after acknowledgement. The live poller was not duplicated and its cursor was not rewound. Transport-level qualification remains explicitly distinct.

## Live mission and request binding

Jonny's `/brief jonnyallum/kerneljson findings=3` (update `461282864`) admitted task `386c31d6-451d-8961-a634-87ccbb8fbb54` under epoch 9 and the exact deployed release. It completed with exactly three findings. Reconciliation ACCEPTED with all 13 checks passing.

Persisted assembly `7a7eeabf-ff52-8a2b-acbe-0fbecf9d4a9b` selected only memory v2, using 29 of 1,500 tokens. It contains no external context. Its digest, independently recomputed from persisted inputs, is `d51a9bd93638ad900fcdf85081a65888cad702bb5dcbf210449ac98fd02760d2` and matches analyst evidence metadata.

The complete analyst and reviewer requests were reconstructed from canonical prompt functions, persisted task metadata, repository facts, analyst output, and exact call/step/trace identifiers. Both reconstructed request digests matched recorded evidence:

| Role | Provider | Provider-reported model | Request SHA-256 |
| --- | --- | --- | --- |
| Analyst | deepseek | deepseek-flash | `c152b92a5544ccba39c2f036c9bc18a070115a906a4a3c3fdc40ae5df5f0f765` |
| Reviewer | openrouter | anthropic/claude-sonnet-5 | `b4a9bd446a57b3f7330dcddbd243bf1e93660d5f21feedebed798356f315ba9f` |

The analyst request contained the exact canonical preference. The reviewer request contained neither the memory block nor that preference; reviewer metadata also had no memory context. Model identity is provider-reported, not cryptographically attested. Completion notification `6cf89160b023f268ea692f8b72de8395` was delivered once, on attempt 1.

## Final health and limitations

At `2026-09-23T14:04:54.218Z`, all three containers were healthy with zero restarts; worker/door sources matched the canonical release. Seven unique Restate services remained registered, with Telegram, monitor, and scheduler chains intact. Tasks in flight = 0, pending approvals = 0, POISON = 0. No current P0/P1 alert was open. No literal configured credential was found in deployment-window logs.

Memory state: 2 candidates, 2 promotions, 2 historical versions, 1 current memory, 1 context assembly. Legacy memory remains empty and unchanged. All five new tables retain RLS; the view uses security_invoker; PUBLIC/anon/authenticated grants remain absent.

Health has zero critical and zero degraded issues. Overall remains UNKNOWN solely for the previously unwired cross-system Shared Brain check; it is not an all-green assertion. Release-binding checks now have real mission evidence and recovered. The next natural scheduled wake is `2026-09-24T08:00:00.012Z`; it was not advanced artificially. Protected memory promotion remains held while no memory approver is configured. Retraction and competing-supersession stress tests were not performed on the real preference. Telegram replies still expose some escaped formatting; this does not change persisted memory or mission evidence.

## Evidence

- [Initial write](evidence/kj-p5-live/first-memory-proof.json)
- [Original-input replay](evidence/kj-p5-live/first-memory-replay.json)
- [Authorized correction and replay](evidence/kj-p5-live/preference-correction-proof.json)
- [Mission, memory assembly, request reconstruction, reconciliation, notification](evidence/kj-p5-live/mission-memory-proof.json)
- [Final read-only health and invariants](evidence/kj-p5-live/final-health.json)

Continue to P6 using the accepted Core Team definitions in ADR 0006 and the cognition plan. P5 introduces no second task, approval, or memory authority.
