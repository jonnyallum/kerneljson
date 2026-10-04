# KJ-MOD-0 qualification: kj-console, read-only session console

Status: QUALIFIED LOCALLY, not installed. Engineering spike, separate from KJ-P8 and B1. No production, schema,
deployment or runtime change. Claude Code Mods are early access.

## Pinned versions

| Item | Value |
|---|---|
| Claude Code CLI used for `plugin validate` and `plugin test` | `2.1.289 (Claude Code)` (`C:\Users\jonny\Anaconda3\claude`) |
| Claude Code that wrote the type declarations used for the type check | `2.1.287` (first line: `// Written by Claude Code 2.1.287.`) |
| Declaration file SHA-256 | `c44e1319ade6e25e7672899cda3bda6ff43d0d7c5747c2a893cb6a2c8c5d4a8f` |
| Mod API surface | early access, as declared by that file; no separate version number is published |
| TypeScript | 7.0.2 and 6.0.3, both clean |

The CLI updated from 2.1.287 to 2.1.289 during the spike. Validation and all tests were re-run on 2.1.289 and pass.
The type check used the 2.1.287 declarations, the newest this session could obtain without an interactive load.
The first interactive `--plugin-dir` load writes the 2.1.289 declarations into `.claude-plugin/types/`; re-run
`tsc -p` there as part of the manual test.

## Source

| Item | Value |
|---|---|
| Branch | `feat/kj-mod0-readonly-session`, created from `main` `20e39f797be9c4c982bc32fb40b6aa1427b5c09c` |
| HEAD | the commit that adds this record (see `git log`) |
| Location | `integrations/claude-code/kerneljson-mod/` (outside every KernelJSON authority and domain directory) |
| Plugin name | `kj-console`, version `0.1.0` |

## What the module hooks and calls

`claude plugin validate` (2.1.289), verbatim:

```
types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
types ./types/index.d.ts declares state: kj-console.view, kj-console.shadow
./register.ts hooks: session.start, command.run{command=kj-status}, tool.call
./register.ts calls: $.command.register, $.fs.read, $.fs.stat, $.session.repo, $.state.get, $.state.set, $.ui.status
./register.ts state writes: kj-console.shadow, kj-console.view
./register.ts state reads: kj-console.shadow, kj-console.view
Validation passed
```

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

**The tests fail on purpose.** Each deliberate mutation was applied alone, the suite run, and the file restored:

| Mutation | Failing tests |
|---|---|
| M1 rewrite the tool call's input | 1 |
| M2 deny every tool call | 2 |
| M3 accept unexpected status-document keys | 1 |
| M4 read an environment variable | 16 |
| M5 make a network request | 16 |
| M6 show a malformed HEAD instead of UNKNOWN | 1 |

After restoring: 19 pass, 0 fail.

## Type check and repository checks

- `tsc -p` with the declaration file's recommended options (kept outside the mod folder), covering `hooks/`, `types/`
  and `tests/`: clean on TypeScript 7.0.2 and 6.0.3.
- The repository's own `tsconfig.json`, ESLint scope and Vitest include list do not cover `integrations/`; this change
  adds files only under `integrations/claude-code/kerneljson-mod/`, so the existing KernelJSON checks are unaffected
  by construction. No existing file is modified.

## Known early-access API risks

- The Mod API is early access and may change between releases, as the declaration file states. Re-run validation,
  tests and the type check on every Claude Code update before relying on the mod.
- In the test kit, calls beneath the plugin answer `{ value }` while events answer their result directly; this was
  learned from the kit's own error message, not documentation, and could change.
- `$.session.repo()` reports the main working tree's root for a worktree, so the mod finds the worktree's own git
  directory by walking up from the session's working directory instead.

## Manual test (not run here)

```
cd C:\Users\jonny\Desktop\kerneljson
claude --plugin-dir C:\tmp\kj-mod0\integrations\claude-code\kerneljson-mod
```

Expected: a status-line entry `KJ <branch>@<sha7> | ... | OBSERVE ONLY | SHADOW`, and `/kj-status` printing the
console. Started from a directory that is not a KernelJSON checkout, the entry reads `KJ n/a`. Nothing is installed;
closing the session unloads it.
