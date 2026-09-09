# KJ-000000 Canonical Runtime Qualification (Track A)

**Status:** EXECUTION PROOF PASSED · CANONICAL RUNTIME QUALIFICATION PASSED  
**Authority:** Qualification evidence only — **not** production authority. Does not grant KernelJSON control-plane ownership, cutover rights, or estate go-live.

**Recorded (UTC):** 2026-09-09T18:50:01Z · **Local (Europe/London):** 2026-09-09 19:50 BST

## Scope

- Harmless `repository.read` of a fixture `NOTES.md` via Spawner `input_data`.
- Canonical proof host: laptop Spawner `http://127.0.0.1:8766` (Track A). **Not** `:8876`.
- Production VM Spawner was **not** modified in this phase.

## Landed merges

| Repo | PR | Merge SHA | Notes |
| --- | --- | --- | --- |
| `jonnyallum/new-system` | #21 | `c3472f26f7c5987fd3e5a6bf7001a1b7524e21a0` | Track A Spawner `input_data` preserve; merge commit |
| `jonnyallum/kerneljson` | #2 | `6daa4fbad2f2b70af2d1060177d9720a77f0fb47` | NewSystemRuntimeAdapter + KJ-000000; into `docs/kerneljson-prep-track-c` |

## Canonical runtime

- Checkout: `C:\Users\jonny\Desktop\new-system` @ `c3472f2` (`main`)
- Process: `python -m spawner.server` on `127.0.0.1:8766`
- OpenAPI `SpawnRequest` properties include **`input_data`** (proven after restart onto merged HEAD)

## Proof checks (all true)

| Check | Result |
| --- | --- |
| OpenAPI includes `input_data` on `:8766` | PASS |
| First spawn `status=completed`, `exit_code=0` | PASS |
| Independent SHA-256 of fixture bytes matches Spawner `content_sha256` | PASS (`ca0c81d91534b8dcd03e782ef1677bdae0298d2196e3192015d41486044c8061`) |
| `mutations_detected=0` | PASS |
| `target_path` ends with `NOTES.md` under `.tmp-kj000000` | PASS |
| Replay same `task_id`: same digest, no mutation | PASS |
| Path scan: no `public.actions` / Conductor coupling in Spawner responses | PASS |
| `dsp_posted` false/absent | PASS |

Machine-readable artifact (gitignored local): `artifacts/local/kj-000000-canonical-proof.json`.

## Explicit non-claims

- Not production authority.
- Not Track B / estate changes.
- Not Telegram / WhatsApp / email / boardroom / dsp / Conductor / OpenClaw / n8n / `public.actions` cutover.
- VM Spawner still presumed on pre-`input_data` HEAD until separately upgraded — remaining production-host blocker for VM-side qualification only.
