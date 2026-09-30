# KJ-P7B live qualification, 30 September 2026

**P7B-1 PASS. P7B-2 PASS. G13 live qualification complete.** Production runs epoch
13 with cognition **ON**, the original model routes restored, and Class C/D frozen.

## Release and window

Jonny authorised PR #48 and the epoch-13 OFF deployment in this Codex session.
After cutover started, he asked to move to the next phase. The operator explicitly
identified that next window as cognition ON, a REQUIRED mission and the live
cross-provider proofs, with Class C/D still frozen.

- [Implementation PR #48](https://github.com/jonnyallum/kerneljson/pull/48), merged
  at `2026-09-30T22:00:52Z`.
- Deployed release: `cebbb0dfe32e913ac3d4cd2860abce6ca9ecf05e`.
- Tree: `d546b62896f3b2633b7ff6b50e4aa0c07605cb20`.
- [Qualification run](https://github.com/jonnyallum/kerneljson/actions/runs/36779293871):
  both jobs successful; the retained tested-commit artifact names the deployed SHA.
  Main was fast-forwarded to that exact tested merge commit, preserving both parents.
- Regression: **1,794 passed, 62 declared skips, zero failures**. Baseline, typecheck,
  lint, build, faculty/identity mutations and production image startup passed.
  Cognition mutations: **59 test kills + 3 pre-COMMIT refusals; zero survivors or
  inconclusive cases**. The final validate attempt passed after an earlier deliberate
  crash test left the disposable Restate process unreachable; its five cascading
  failures and the passing rerun evidence were retained.
- Worker image: `sha256:1501b7217162ca450a9511072a06cd2fabeb1a531f716ebfded5cd82717eb8ff`.
- Door image: `sha256:7450971fbc1292755701de842bf108613152468e6619af2a2853b001dcd7b553`.
- Prior release: `4127361860700085453f86aa09adfa7bf81ef7d3`, epoch 12.

Target was only `kerneljson-prod-01`, project `project-c407f628-c71c-45fa-994`,
zone `europe-west2-b`, Supabase project `banqdzddfganzfhckdps`.

## Migration and atomic activation

Fresh preflight at 22:01:38Z observed worker role `postgres`, 52 bindings, 51
admissions, no nonterminal tasks, no identity pins, no open P0/P1, no poisoned
notification delivery and no release-provenance failures. The approved current
Kernel v1 and its core/Class A digests matched. The scheduler remained enabled/v2,
with its next wake at `2026-10-01T08:00:00.014Z`.

Twenty historical admissions without task projections were accounted for: 19
epoch-0 records and the documented epoch-9 P6 incident
`71a00a16-24d9-8193-a64f-ec9c47c41ea0`. None was rewritten or replayed. Pending
Restate work consisted only of TelegramOperator, ScheduleDriver and
ProductionAlertMonitor. Telegram and scheduler admission paths use the stopped
HTTP door; direct localhost workflow ingress was held by the operator. Counts
remained 52/51 after ingress quiescence and the drain check.

Only migration `20260929120000_identity_cognition_binding.sql` was applied.
Its canonical blob is 30,955 bytes, SHA-256
`29eb36204b4d9f49a47a0ad4d908d26c4ed968213153da09b5580971defa770a`.
The operator wrapped it and its single migration-ledger insert in one explicit
transaction. COMMIT at 22:01:43Z was followed by a fresh connection verifying:

- empty marker; epoch still 12;
- all persisted version digests have SQL/TypeScript parity;
- two enabled, initially deferred constraint triggers;
- four enabled immutability triggers;
- two RLS tables and exact non-owner grants;
- nine SECURITY INVOKER functions with no anon/authenticated/service_role EXECUTE;
- the one new migration-ledger record.

The executor had first been rehearsed on a disposable database with Supabase-style
default ACLs. An injected extra grant caused full rollback with no tables or
ledger row left behind. The clean migration, activation and identical-request
retry passed. No production migration assertion was weakened or retried with edits.
Historical migration-ledger drift was preserved; no old rows were backfilled.

Images were built from a clean archive of the tested commit before quiescence,
then the production checkout was pinned to that same commit. Both image startup
modes and the missing-memory negative control passed. `runtime_env_merge.py`
independently verified only release IDs and the explicit cognition=false setting
changed. Signing/bearer parity held; all other runtime values were preserved.
Prior images and mode-600 environment files were retained for rollback.

At **22:04:31Z**, request
`98f4f62c-d830-45f0-a08c-7ac218e2abe3` atomically activated **epoch 13** and inserted
the immutable `kerneljson:identity-cognition/v1` marker at **first_release_epoch=13**.
A fresh transaction verified release, epoch, marker and schema. Eight production
services were registered. Restate's original container, volume and journal remained
in place. The door reopened, healthy; probes returned **200/401/401**.

## P7B-1 live OFF proof

Canonical task **`45064c50-9fa2-818d-a299-a867844071cc`** completed through the normal
admission/workflow path. Its bounded objective requested one repository architecture
finding supported by the captured README/tree. It used the production model routes
and canonical memory; no fixture provider or manufactured completion was used.

The operational checker reconstructed both old `4127361` and deployed requests in
memory from the same persisted semantic inputs, faculty pins, repository facts and
transient journaled memory assembly. Full request bytes matched for analyst and
reviewer. Each request digest also matched its actual validated receipt and runtime
evidence. Only digests, identifiers and comparison results were retained; prompt
and memory text were not copied to the proof record or immutable MODEL_CALLED.

| OFF observation | Value |
|---|---|
| Analyst latch / identity pins / MODEL_CALLED | NONE / 0 / 1 |
| Analyst assembly digest | `cb479c3b3a5dc0c117201327f6b7367b39013b62bd3020f991203412db21d5ec` |
| Reviewer assembly digest | `79d2288508395e3fd9d8a018650db12c41dff0556327018270cfc7fbe49b9931` |
| Analyst request digest | `4a8d6cfbe8e15f21b5b645cba91a3c3c5a12524be0cc64785d2cc33faf3b3eeb` |
| Reviewer request digest | `395e6fc341606648f2b466a4d764b298a3fb946bf55defedddc74c6e70765ec0` |
| Memory assembly digest | `e5c2d5b9818229d85849f5783c0437ece0c210094005c76c4b8a7bc3bec01e27` |

At 22:05:54Z, release-provenance checks and all Group A identity checks were
HEALTHY. Reviewer isolation was HEALTHY. `identity.analystRunsBound` was the expected
NO_OBSERVATION, mapped to P3 with notification disabled. There were no new critical
checks. The pre-existing P6 materialisation degradation remained visible.

## P7B-2 REQUIRED and G2 proofs

After the completed OFF proof, a fresh zero-task drain and no-P0/P1 preflight,
the same worker image was recreated with only cognition changed to true. Source,
release epoch and marker did not change. The original model routes were
analyst `deepseek/deepseek-flash`, reviewer `openrouter/anthropic/claude-sonnet-5`.

Task **`9b623096-95d7-88db-a41b-7436ef54ab6e`** completed with one REQUIRED latch,
one Kernel v1 pin, one MODEL_CALLED binding, matching runtime evidence and validated
request receipt. The pure completion verifier independently accepted the persisted
facts. SQL version parity, reconstructed request/assembly/continuity digests and
reviewer isolation all passed. All seven identity health checks were HEALTHY.

G2's seven local test cases passed. The deployed evaluator and explicit policy rows
were additionally exercised using **in-memory copies of the freshly collected live
snapshot**. Each of the seven broken invariants produced its specified P0/P1/P2
severity. Both NO_OBSERVATION cases produced UNKNOWN/P3/notify:false; database
unavailability produced seven UNKNOWN/P3 results. These were negative evaluation
proofs: no production rows were corrupted, no alert episodes were inserted and no
notifications were sent by the proof helper.

## G5 and final closeout

The two fresh G5 missions passed in the 22:13Z verification:

| Field | Mission 1 | Mission 2 |
|---|---|---|
| Task | `8e925614-fa52-88fc-a3ed-f640de052bec` | `a1d5cabb-17c8-88eb-abaa-4dfbdf00bf6d` |
| Analyst provider | `deepseek` | `openrouter` |
| Requested and reported model | `deepseek-flash` | `anthropic/claude-sonnet-5` |
| Provider request ID | `f49998ec-f70f-47f2-9843-fa12ae2e090d` | `gen-1790806324-GrEK7TlMeqkbwWlzzghs` |
| Request digest | `9b69d19a02b786238f502c6a30276cc7356afe5fd6235189b0d5ed06af712fb9` | `41f4081c9671a8bfa8fb8873a4e231b0dda1cd0ca0201ddf16d307b14661acbc` |
| Completion / latch / pin / binding | COMPLETED / REQUIRED / 1 / 1 | COMPLETED / REQUIRED / 1 / 1 |

The complete ADR-0022 stable equality set passed, including the full identity pin
apart from task/step IDs, the faculty definition/policy/operation/routing reason,
semantic mission input, repository head/facts, memory, assembly and continuity.
Both validated receipts bound their reconstructed requests. Task/step IDs, actual
provider, model and request digest differed. Generated output text was not compared.

| Equal field | Value in both missions |
|---|---|
| Repository head | `cebbb0dfe32e913ac3d4cd2860abce6ca9ecf05e` |
| Identity version | `08be5e20-2606-4809-b81f-11552bb67502` (Kernel v1) |
| Identity core | `4f6dc581f06701c207d5cdf8bc1ced59fa0741c15bab18c30537d0b17a7bf9ed` |
| Projection | `c154e47c1533a81e01e9605cac1150151af2c734ab497d426f79740b2b93b7d3` |
| Stable identity-pin fields | `0dd4fba25dd77b666c1f5ac0ed07964e14f58d27d6c3ab838ae4f8ef4560948a` |
| Stable faculty fields | `b6b82a82b43ed39b9fd786336095f7a786be6761874a1e7764f718daf96f3fe9` |
| Semantic inputs | `33ecb79fa0c3aac873c82cef2edb2493bc27fbe7abe191f6568a711d48847795` |
| Repository facts | `f38af5865815e22289ac6b298d929f9499704514c0a6b57c7a970fcd9d1487cb` |
| Memory assembly | `e5c2d5b9818229d85849f5783c0437ece0c210094005c76c4b8a7bc3bec01e27` |
| Assembly (D9) | `829e980914329bea9b33bdd5179fbd99d3c49b7a24bf04a7eff5fee080967a37` |
| Continuity | `f0c6ece24dcdcae9fd018097fee7d44a043499a018be7f95fe8d44a44ef774fe` |

The configuration-only provider change temporarily swapped both analyst and
reviewer routes. The existing startup guard refuses a configured provider key
unused by either role, so changing only the analyst to OpenRouter would correctly
refuse startup. Swapping the existing supported routes preserved both credentials
and the reviewer independence requirement. Reviewer output is downstream of the
analyst and outside the G5 equality set. No faculty, policy, memory, identity or
source change was made. Both missions proved reviewer isolation. The original
analyst/reviewer routes are restored before final closeout; cognition remains ON.

The final sweep at **22:13:59Z–22:14:00Z** found:

- epoch and marker both 13; worker/door/source release unchanged at `cebbb0d...`;
- cognition ON; original analyst `deepseek-flash` and reviewer
  `anthropic/claude-sonnet-5` restored; every unrelated environment value unchanged;
- signing/bearer parity, localhost-only door, unpublished worker, unchanged Restate
  container and zero container restart counts;
- all four authorised missions COMPLETED: one NONE and three REQUIRED latches;
- zero nonterminal tasks, version parity failures, unfrozen identities, poisoned
  notifications or open P0/P1 alerts;
- all seven identity checks HEALTHY; release parity, admission, scheduler,
  execution, Restate, database, evidence and production configuration HEALTHY;
- scheduler still enabled/v2 with the same armed next wake; clean production checkout.

Overall health remains DEGRADED solely because of the preserved historical P6
`authority.admittedFiresMaterialised` incident. The pre-existing
`legacyAuthority.b1FreezeObservable` observability gap remains UNKNOWN. Neither is
silently treated as resolved by this release. No maintenance P0/P1 remained open.

G13 closes P7B live qualification only. **No C/D policy was added and no freeze was
opened.** Any future governance expansion is a separate phase.

The [machine-readable evidence](evidence/kj-p7b-2026-09-30.json) retains the
activation input, OFF/REQUIRED/G2/G5 proof results and final health/state/config
observations. The operational helpers used read-only queries and transient Restate
journals for verification; they did not become completion authority. Ledger remained
the only completion authority throughout. The later documentation commit is not
the deployed release; production stays pinned to the qualified `cebbb0d...` image.
