# CLAUDE.md — kerneljson (cross-repo takeover pointer)

THIS REPOSITORY IS PART OF THE KERNELJSON / NEW-SYSTEM MIGRATION.

It contains **the kernel and the scheduler (Phase S1)** — it is NOT a second
control plane.

The canonical migration state lives in the **new-system** repo. Before any
implementation, read (source of truth is git + these files, never chat history):

- `C:\Users\jonny\Desktop\new-system\CLAUDE.md`  (operating constitution)
- `C:\Users\jonny\Desktop\new-system\docs\migration\STATE_OF_RECORD.md`
- `C:\Users\jonny\Desktop\new-system\docs\migration\CURRENT_PHASE.md`
- `C:\Users\jonny\Desktop\new-system\docs\migration\NEXT_ACTION.md`
- `C:\Users\jonny\Desktop\new-system\docs\migration\CHANGE_WINDOWS.md`
- `C:\Users\jonny\Desktop\new-system\docs\migration\RISKS_AND_BLOCKERS.md`

(On the new-system remote these are on `main`.) Do NOT duplicate the state-of-record
here — there is ONE canonical source, in new-system.

## Essential constitution (restated)
- **KernelJSON is the sole target task authority** (admission, identity, priority,
  assignment, approvals, retry, completion, cancellation, evidence).
- **This repo contains the kernel, not a second control plane.** The scheduler
  decides only WHEN an admission request is emitted; KJ decides whether canonical
  work exists. The scheduler must never mint.
- **Evidence beats assertion** (tag FACT / INFERENCE / RECOMMENDATION; a check is
  untrustworthy until it has failed on purpose).
- **Production changes require an explicit change window** (see new-system
  `docs/migration/CHANGE_WINDOWS.md`). Preparation is always allowed.
- **Phase 8.1 (natural EMAIL soak) must not be disturbed.**
- **The builder/model must remain removable:** if removing it would break runtime
  task authority, the architecture is wrong.

## Phase S1 pointer
S1 (production scheduler MVP prep) is on branch
`feat/phase-s1-production-scheduler-mvp-prep`. Current checkpoint and next action
are recorded in new-system `docs/migration/CURRENT_PHASE.md` and `NEXT_ACTION.md`.
