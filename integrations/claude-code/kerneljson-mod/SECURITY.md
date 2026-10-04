# kj-console (MOD-0) security note

## Threat model

A Claude Code Mod runs inside the Claude Code process and reaches the outside world through the engine interface
`$`. Assume it can do anything that interface allows: read and write files, run processes, make network requests,
read the environment. A mod is therefore only as safe as the calls it actually makes, and a credential the Claude
Code process can see is a credential a mod could reach.

## What MOD-0 relies on

| Control | How it holds |
|---|---|
| No credential exists for it to misuse | MOD-0 needs none and is given none. It is not configured with any KernelJSON, Supabase, Vercel, GitHub, model-provider or deployment credential, and it declares no `userConfig`. |
| It makes only the calls listed | `claude plugin validate` reports the module's calls: `$.command.register`, `$.fs.read`, `$.fs.stat`, `$.session.repo`, `$.state.get`, `$.state.set`, `$.ui.status`. No `$.http`, `$.process`, `$.env`, `$.fs.write`, `$.fs.list`, `$.store`, `$.model`, `$.agent` or `$.tool.register`. |
| It reads only named files | `hooks/session.ts` reads git metadata (`.git`, its `HEAD`, the one ref HEAD names, `commondir`, `packed-refs`) and the one status document. Paths come from the session's own directory and git's own files, never from the model, a prompt or a tool call. |
| Reads are bounded | the status document is read only if it is a file of at most 2 KiB; `packed-refs` at most 1 MiB; other git files at most 4 KiB; the directory walk stops after 64 levels. |
| It cannot change what Claude does | its `tool.call` hook calls `next(e)` with the call unchanged and returns the result unchanged; it hooks no prompt event and no permission event. |
| It fails closed and quietly | every read is caught; a defect becomes `UNKNOWN` on screen, never an exception that could affect the session. |
| The remote URL is not exposed | `origin` can embed credentials (`https://token@host/...`). It is only tested against a fixed pattern; it is never shown, stored or logged. |

## What the tests prove

`tests/console.test.ts` answers every engine call beneath the plugin from memory and counts the forbidden ones
(`http.fetch`, `process.run`, `env.get`, `env.set`, `fs.write`, `fs.list`, `store.set`): every test requires zero. A
deliberate-mutation run (rewriting the tool call, denying it, reading the environment, making a network call,
loosening the status parser, trusting a malformed HEAD) fails at least one test each time. See
`KJ_MOD0_QUALIFICATION.md`.

## Residual risks

- **Early-access API.** The Mod API may change between Claude Code releases. MOD-0 is qualified on 2.1.287 only.
- **A mod is code with the process's reach.** These guarantees hold for this code. Any change to it needs the same
  validation, tests and review; a future mod that talks to KernelJSON must use a separately designed, short-lived,
  narrowly scoped capability, never a long-lived credential.
- **Shadow observation adds a hook to every tool call.** It awaits the call and then updates a counter. It cannot
  change the decision, but it is on the path; a defect in the engine's state service could surface as a skipped hook,
  which the engine reports and passes over.
- **The status document is local and unauthenticated.** Whatever writes it decides what the console says. It is a
  display, never an authority, and nothing reads it as one.
