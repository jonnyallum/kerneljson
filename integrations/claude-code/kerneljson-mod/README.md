# kj-console: KernelJSON MOD-0 (read-only session console)

A first-party Claude Code Mod that shows, inside Claude Code, which KernelJSON repository, branch and commit a session
is working in, and what the local status document says. It is a substrate proof. It observes; it never decides.

Status: EXPERIMENT (MOD-0). Not installed globally. Claude Code Mods are early access; this mod is qualified against
Claude Code **2.1.287** only (see `KJ_MOD0_QUALIFICATION.md`).

## What it does

- On `session.start` it reads, from local files only:
  - the session's `origin` remote, through `$.session.repo()`, and tests it against the canonical KernelJSON
    repository (`github.com/jonnyallum/kerneljson`). The URL is matched, never shown, stored or logged;
  - the branch and HEAD commit, from git's own files (`.git/HEAD`, the ref it names, `packed-refs`; worktrees through
    their `.git` file and `commondir`). It never runs git;
  - an optional status document, `.kerneljson/claude-status.json` at the working tree's root (see below).
- It sets one status-line entry, for example `KJ main@20e39f7 | UNBOUND | OBSERVE ONLY | SHADOW`.
- It registers `/kj-status`, which prints:

  ```
  KERNELJSON
  Mission: UNBOUND
  Repo: kerneljson
  Branch: main
  HEAD: 20e39f797be9c4c982bc32fb40b6aa1427b5c09c
  P8: R2.4 awaiting independent seal
  Authority: OBSERVE ONLY
  Production: LOCKED
  Mod: SHADOW
  Shadow: 3 tool call(s) observed, last Bash; none decided or changed
  ```

  `Authority`, `Production` and `Mod` describe this mod itself: it can only observe, it holds no production access,
  and it runs in shadow mode. They are not KernelJSON's live state.
- It observes tool calls in **shadow** mode: it passes each call on exactly as received, returns exactly what the
  engine returned, and afterwards counts the call and remembers the tool's name. It never reads a call's input or
  output.
- Outside the KernelJSON repository it shows `KJ n/a` and does nothing else (it reads no git file there).

## What it cannot do

It does not, and its code has no path to:

- allow, deny or rewrite a tool call, or answer a permission prompt;
- change a prompt or the system prompt (it hooks neither);
- make a network request, run a process, read or set environment variables, or write, list or delete files;
- read `.env` files, the vault, credentials or any file other than the git metadata and the one status document;
- call KernelJSON production, Supabase, Vercel or GitHub, or create a task, admission, evidence, policy, identity,
  schedule or approval.

`claude plugin validate` lists exactly what the module hooks and calls; the qualification record keeps that output.

## The status document (optional)

`.kerneljson/claude-status.json`, at the root of the working tree, at most 2 KiB, exactly these keys:

```json
{ "contract": "kerneljson:claude-session-status/v1", "mission": null, "p8": "R2.4 awaiting independent seal" }
```

`mission` is `null` (shown as `UNBOUND`) or printable ASCII up to 80 characters; `p8` likewise. Absent, the console
shows `Mission: UNBOUND` and `P8: UNKNOWN (no local status file)`. Any defect (not JSON, extra keys, wrong contract,
oversize, control characters) shows `UNKNOWN` with the reason and never stops the session. `status.example.json` is a
template. The document is local and is not created or kept up to date by anything in MOD-0.

## Running it from source (not installed)

From a KernelJSON checkout:

```
claude --plugin-dir <path to this folder>
```

Then type `/kj-status`. Nothing is installed and nothing persists: without the flag the mod is not loaded.

## Developing

```
claude plugin validate <this folder>
claude plugin test <this folder>
```

Loading the folder makes Claude Code write `.claude-plugin/types/` (its own type declarations) here; it is ignored.

## Where this goes next (not built)

- `kj-console`: this mod, read-only mission, gate and status display.
- `kj-guard` (future): an admission and policy adapter. Needs its own design and seal.
- `kj-ledger` (future): an evidence adapter. Needs its own design and seal.

KernelJSON does not depend on this mod or on any Claude Code API. The dependency points one way only: the mod reads
KernelJSON's repository; KernelJSON core never imports the mod.
