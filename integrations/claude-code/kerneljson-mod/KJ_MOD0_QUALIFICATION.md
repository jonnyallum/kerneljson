# KJ-MOD-0 qualification: kj-console, read-only session console

Status: QUALIFIED LOCALLY, not installed. Engineering spike, separate from KJ-P8 and B1. No production, schema,
deployment or runtime change. Claude Code Mods are early access.

## Pinned versions

**Authoritative runtime and type version: Claude Code 2.1.289.**

| Item | Value |
|---|---|
| Claude Code CLI for `plugin validate`, `plugin test` and the load | `2.1.289 (Claude Code)` (`C:\Users\jonny\Anaconda3\claude`) |
| Declarations used for the type check | written by Claude Code 2.1.289 itself; first line `// Written by Claude Code 2.1.289.` |
| `.claude-plugin/types/claude-code/index.d.ts` (the API, laid beside the mod by the 2.1.289 `--plugin-dir` load) | SHA-256 `6116f6c69db6e3c5b5433eaa7283dcb15e2ee98c91ff47166e87d4d05d45378b` |
| The plugin-authoring skill's combined file from the same build (API plus built-in tool inputs) | SHA-256 `79ab1ef9555704ac479dfcbc61ef27aa11773da4b98258de19604b07ceae07af` |
| Mod API surface | early access, as those declarations state; no separate version number is published |
| TypeScript | 7.0.2 and 6.0.3, both clean |

How the 2.1.289 declarations were obtained, without editing or approximating them:

1. A headless 2.1.289 run (`claude -p "/plugin-authoring ..."`, all editing and shell tools disallowed) loaded the
   bundled plugin-authoring skill, which writes that build's declarations to
   `%TEMP%\claude\bundled-skills\2.1.289\49826bcc38738390ad57d1f0f9c1a2c5\plugin-authoring\types\claude-code.d.ts`.
2. The headless `--plugin-dir` load of the integration test (below) laid the same build's declarations beside the
   mod in `.claude-plugin/types/`, with a `tsconfig.json` that extends them. The API file is the first 15,197 lines
   of the combined file, line for line; the built-in tool inputs sit in the sibling `claude-code-tools/` file.
   Both are ignored by git.

The earlier type check used the 2.1.287 declarations (SHA-256 `c44e1319ade6e25e7672899cda3bda6ff43d0d7c5747c2a893cb6a2c8c5d4a8f`).
Between 2.1.287 and 2.1.289 the declarations changed only in agent and teammate types, none of which MOD-0 uses. No
code change was needed.

## Source

| Item | Value |
|---|---|
| Branch | `feat/kj-mod0-readonly-session`, created from `main` `20e39f797be9c4c982bc32fb40b6aa1427b5c09c` |
| HEAD | the commit that adds this record (see `git log`) |
| Location | `integrations/claude-code/kerneljson-mod/` (outside every KernelJSON authority and domain directory) |
| Plugin name | `kj-console`, version `0.1.0` |

## What the module hooks and calls

`claude plugin validate --strict` (2.1.289), verbatim:

```
types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
types ./types/index.d.ts declares state: kj-console.view, kj-console.shadow
./register.ts hooks: session.start, command.run{command=kj-status}, tool.call
./register.ts calls: $.command.register, $.fs.read, $.fs.stat, $.session.repo, $.state.get, $.state.set, $.ui.status
./register.ts state writes: kj-console.shadow, kj-console.view
./register.ts state reads: kj-console.shadow, kj-console.view
Validation passed
```

Every call listed is declared in the 2.1.289 API file, with the shape the module uses (the type check is clean, and
it fails on purpose: renaming `$.fs.stat` to `$.fs.statt` gives TS2551 and exit 1).

| Question | Answer |
|---|---|
| Events handled | `session.start`; `command.run` for `kj-status` only; `tool.call` (shadow: pass through unchanged) |
| Engine capabilities called | `$.session.repo`, `$.fs.stat`, `$.fs.read`, `$.state` (get/set through `atom`, `read`, `update`), `$.ui.status`, `$.command.register` |
| Files read | `<dir>/.git` (stat) for each directory from the session's working directory up to the repository root; a worktree's `.git` file; `<gitDir>/commondir`; `<gitDir>/HEAD`; the single ref file HEAD names, in `gitDir` or `commonDir`; `<commonDir>/packed-refs`; `<root>/.kerneljson/claude-status.json`. Nothing outside the KernelJSON repository is read: elsewhere the mod stops at the remote check |
| Files written | NONE |
| Network calls | NONE |
| Credentials required | NONE |
| Environment variables read | NONE |
| Process execution | NONE (git metadata is read from files; git is never run) |
| Prompt or system-prompt hooks | NONE |
| Permission decisions | NONE; `tool.call` never denies, never rewrites, never answers in place of the engine |
| KernelJSON writes (tasks, admissions, evidence, policy, identity, schedules, approvals) | NONE |

## Tests

`claude plugin test` (2.1.289): **19 pass, 0 fail**. Every engine call is answered beneath the plugin from an
in-memory fixture; forbidden calls (`http.fetch`, `process.run`, `env.get`, `env.set`, `fs.write`, `fs.list`,
`store.set`) are counted and must stay at zero.

| # | Requirement | Test |
|---|---|---|
| 1 | outside KernelJSON: safely not applicable | `1.` (other remote; also asserts no git file is read), `1b.` (no repository) |
| 2 | KernelJSON recognised | `2. 3. 4.`, `4c.` (SSH remote) |
| 3 | branch read correctly | `2. 3. 4.`, `4b.` (worktree), `4c.` (detached) |
| 4 | HEAD read correctly | `2. 3. 4.` (loose ref), `4b.` (`packed-refs` through `commondir`), `4c.` (detached) |
| 5 | missing status file: safe fallback | `2. 3. 4.` (`UNBOUND`, `UNKNOWN (no local status file)`); `5.` shows a valid document |
| 6 | malformed status: UNKNOWN, no crash | `6.` seven cases (not JSON, array, extra key, wrong contract, control character, over-long value, over 2 KiB); `6b.` malformed `HEAD` |
| 7 | no tool-call decision changed | `7.` (input reaches the engine unchanged, result returned unchanged), `7b.` (a deny beneath stays a deny) |
| 8 | no prompt changed | `8.` |
| 9 | no network | `9. 10. 12.` (`http.fetch` count zero) |
| 10 | no secret or environment enumeration | `9. 10. 12.` (`env.get`/`env.set` zero; every read is git metadata or the one status file) |
| 11 | restart reconstructs state deterministically | `11.` |
| 12 | works without KernelJSON production | `9. 10. 12.` (no production endpoint exists in the mod; the network answers only by refusing) |

**The tests fail on purpose.** Each deliberate mutation was applied alone, the suite run on 2.1.289, and the file
restored:

| Mutation | Failing tests |
|---|---|
| M1 rewrite the tool call's input | 1 |
| M2 deny every tool call | 2 |
| M3 accept unexpected status-document keys | 1 |
| M4 read an environment variable | 16 |
| M5 make a network request | 16 |
| M6 show a malformed HEAD instead of UNKNOWN | 1 |

No mutation survived. After restoring: 19 pass, 0 fail, and `git status` clean.

## Type check and repository checks

- `tsc -p <mod folder>` through the engine's own `tsconfig.json` (2.1.289 declarations): clean on TypeScript 7.0.2
  and 6.0.3. The same check with the declaration file's recommended options in a tsconfig outside the mod folder:
  clean.
- The repository's own `tsconfig.json`, ESLint scope and Vitest include list do not cover `integrations/`; the
  branch adds files only under `integrations/claude-code/kerneljson-mod/`, so the existing KernelJSON checks are
  unaffected by construction. No existing file is modified.

## Integration load (headless, real engine)

Against a clean worktree of `main` at `20e39f797be9c4c982bc32fb40b6aa1427b5c09c` (`C:\tmp\kj-mod0-load`, branch
`main`), with only a display fixture added (`.kerneljson/claude-status.json`, untracked, never committed):

```json
{"contract": "kerneljson:claude-session-status/v1", "mission": null, "p8": "ADR-0023 R2.4 8a17de1 awaiting independent hostile re-seal; B1 frozen 108db1b"}
```

The status contract allows `mission` and `p8` only, each at most 80 characters, so the fixture carries the design and
B1 SHAs in short form; `Authority`, `Production` and `Mod` are the mod's own lines.

Command: `claude -p --input-format stream-json --output-format stream-json --verbose --plugin-dir <mod>
--max-turns 4 --allowedTools Read`, with editing, shell, network and agent tools disallowed, and two user messages in
one session: a request to read the first three lines of `README.md`, then `/kj-status`.

Observed in the engine's own output stream:

| Check | Result |
|---|---|
| mod loaded | `init.plugins` lists `kj-console` 0.1.0 from the mod folder; `/kj-status` appears in the slash commands |
| status surface | `system/ui_status` from `kj-console`: `KJ main@20e39f7 \| UNBOUND \| OBSERVE ONLY \| SHADOW` |
| ordinary operation | the model called Read on `README.md`; the result came back correct (`# KernelJSON ...`), not an error, and the turn completed |
| shadow pass-through | `/kj-status` then reported `Shadow: 1 tool call(s) observed, last Read; none decided or changed` |
| repository, branch, HEAD | `Repo: kerneljson`, `Branch: main`, `HEAD: 20e39f797be9c4c982bc32fb40b6aa1427b5c09c` |
| bounded view | `Mission: UNBOUND`, `P8: ADR-0023 R2.4 8a17de1 awaiting independent hostile re-seal; B1 frozen 108db1b`, `Authority: OBSERVE ONLY`, `Production: LOCKED`, `Mod: SHADOW` |
| writes | the load worktree's `git status` shows only the fixture; the mod wrote nothing |

What this run does **not** prove, said plainly:

- The terminal status line itself was not seen: a headless run draws nothing. The engine emitted the status text as
  `ui_status`, which is what the terminal draws.
- No interactive key press was automated. `/kj-status` was sent as a user message in a headless session.
- The absence of network, process and environment calls by the mod during the live run was not instrumented. It
  rests on the module's call surface, which validation lists and which contains none of them, and on the tests,
  which count them at zero. The run's own network traffic is the engine's model API traffic, not the mod's.

## Known early-access API risks

- The Mod API is early access and may change between releases, as the declaration file states. Re-run validation,
  tests and the type check on every Claude Code update before relying on the mod.
- In the test kit, calls beneath the plugin answer `{ value }` while events answer their result directly; this was
  learned from the kit's own error message, not documentation, and could change.
- `$.session.repo()` reports the main working tree's root for a worktree, so the mod finds the worktree's own git
  directory by walking up from the session's working directory instead.

## Manual interactive test (for Jonny)

From the clean checkout of `main` (not the Desktop checkout, which is on the closed PR #49 branch):

```
cd C:\tmp\kj-mod0-load
claude --plugin-dir C:\tmp\kj-mod0\integrations\claude-code\kerneljson-mod
```

Expected: the status line shows `KJ main@20e39f7 | UNBOUND | OBSERVE ONLY | SHADOW`; `/kj-status` prints the console
as in the table above. Started outside a KernelJSON checkout the entry reads `KJ n/a`. Nothing is installed; closing
the session unloads it.
