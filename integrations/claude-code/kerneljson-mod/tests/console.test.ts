/**
 * kj-console (KernelJSON MOD-0) qualification tests, run by `claude plugin test`.
 *
 * Every engine call the mod could make is answered here, beneath the plugin, from an in-memory fixture: the
 * filesystem, the repository, the network, processes and the environment. The forbidden ones count their calls and
 * the tests require zero. Nothing reaches a real disk, network or KernelJSON production.
 */
import { describe, expect, test } from 'claude-code/testing';
import type { On } from 'claude-code';

const REPO = 'C:/work/kerneljson';
const MAIN_SHA = '20e39f797be9c4c982bc32fb40b6aa1427b5c09c';
const OTHER_SHA = '8a17de18b26edd12a9f3af7ab6179552ff0cd20e';
const REMOTE = 'https://github.com/jonnyallum/kerneljson.git';
const STATUS = '.kerneljson/claude-status.json';

type Files = Record<string, string>;
type Ledger = { reads: string[]; forbidden: string[]; statuses: (string | undefined)[] };

/** A whole fake world beneath the plugin. `files` maps absolute paths to contents; directories are implied. */
function world(on: On, files: Files, remote: string | null | 'none'): Ledger {
  const ledger: Ledger = { reads: [], forbidden: [], statuses: [] };
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) dirs.add(p.slice(0, i));
  const norm = (p: string) => p.replace(/\\/g, '/');
  // The engine's own answers to the calls a plugin makes are `{ value }` (or `{ deny }`); events answer their result.
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('command.register', () => ({ value: undefined }) as never);
  on('session.repo', () => ({ value: remote === 'none' ? null : { root: REPO, remote, internal: false, name: null } }));
  on('fs.stat', (_$, e) => {
    const p = norm(e.path);
    ledger.reads.push(`stat ${p}`);
    if (p in files) return { value: { kind: 'file', size: new TextEncoder().encode(files[p]!).length, mtimeMs: 0, isLink: false } };
    if (dirs.has(p)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } };
    throw new Error('ENOENT');
  });
  on('fs.read', (_$, e) => {
    const p = norm(e.path);
    ledger.reads.push(`read ${p}`);
    if (p in files) return { value: files[p]! };
    throw new Error('ENOENT');
  });
  on('ui.status', (_$, e) => {
    ledger.statuses.push(e.text);
    return { value: undefined } as never;
  });
  const deny = (name: string) => () => {
    ledger.forbidden.push(name);
    throw new Error(`${name} is forbidden in MOD-0`);
  };
  on('http.fetch', deny('http.fetch'));
  on('process.run', deny('process.run'));
  on('env.get', deny('env.get'));
  on('env.set', deny('env.set'));
  on('fs.write', deny('fs.write'));
  on('fs.list', deny('fs.list'));
  on('store.set', deny('store.set'));
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never);
  return ledger;
}

const repoFiles = (extra: Files = {}): Files => ({
  [`${REPO}/.git/HEAD`]: 'ref: refs/heads/main\n',
  [`${REPO}/.git/refs/heads/main`]: `${MAIN_SHA}\n`,
  [`${REPO}/README.md`]: 'x',
  ...extra,
});

type EngineLike = { session: { start: (e: { cwd: string; surface: 'terminal'; isInteractive: boolean }) => Promise<unknown> }; command: { run: (e: never) => Promise<{ text?: string }> } };
const run = async ($: unknown) =>
  ((await ($ as EngineLike).command.run({ command: 'kj-status', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)).text ?? '').split('\n');
const boot = async ($: unknown, cwd = REPO) => (($ as EngineLike).session.start({ cwd, surface: 'terminal', isInteractive: true }));

describe('kj-console MOD-0', () => {
  test('1. outside KernelJSON: not applicable, safely', async ($, on) => {
    const w = world(on, { 'C:/elsewhere/.git/HEAD': 'ref: refs/heads/dev\n' }, 'https://github.com/someone/other.git');
    await boot($, 'C:/elsewhere');
    const lines = await run($);
    expect(lines).toContain('Not applicable here (not the kerneljson repository)');
    expect(w.statuses.at(-1)).toBe('KJ n/a');
    // Not the repository: nothing of git is even read.
    expect(w.reads).toEqual([]);
  });

  test('1b. no git repository at all: not applicable', async ($, on) => {
    const w = world(on, {}, 'none');
    await boot($, 'C:/scratch');
    expect(await run($)).toContain('Not applicable here (not a git repository)');
    expect(w.statuses.at(-1)).toBe('KJ n/a');
  });

  test('2. 3. 4. KernelJSON: repository, branch and HEAD read from git files', async ($, on) => {
    world(on, repoFiles(), REMOTE);
    await boot($);
    const lines = await run($);
    expect(lines.slice(0, 9)).toEqual([
      'KERNELJSON',
      'Mission: UNBOUND',
      'Repo: kerneljson',
      'Branch: main',
      `HEAD: ${MAIN_SHA}`,
      'P8: UNKNOWN (no local status file)',
      'Authority: OBSERVE ONLY',
      'Production: LOCKED',
      'Mod: SHADOW',
    ]);
  });

  test('4b. a worktree: .git file, commondir and packed-refs', async ($, on) => {
    const wt = 'C:/tmp/kj-wt';
    world(
      on,
      {
        [`${wt}/.git`]: `gitdir: ${REPO}/.git/worktrees/kj-wt\n`,
        [`${REPO}/.git/worktrees/kj-wt/HEAD`]: 'ref: refs/heads/feat/kj-mod0-readonly-session\n',
        [`${REPO}/.git/worktrees/kj-wt/commondir`]: '../..\n',
        [`${REPO}/.git/packed-refs`]: `# pack-refs with: peeled fully-peeled sorted\n${OTHER_SHA} refs/heads/feat/kj-mod0-readonly-session\n`,
      },
      REMOTE,
    );
    await boot($, `${wt}/integrations`);
    const lines = await run($);
    expect(lines).toContain('Branch: feat/kj-mod0-readonly-session');
    expect(lines).toContain(`HEAD: ${OTHER_SHA}`);
  });

  test('4c. detached HEAD and SSH remote', async ($, on) => {
    world(on, { [`${REPO}/.git/HEAD`]: `${OTHER_SHA}\n` }, 'git@github.com:jonnyallum/kerneljson.git');
    await boot($);
    const lines = await run($);
    expect(lines).toContain('Branch: (detached)');
    expect(lines).toContain(`HEAD: ${OTHER_SHA}`);
  });

  test('5. valid status document is shown', async ($, on) => {
    const status = JSON.stringify({ contract: 'kerneljson:claude-session-status/v1', mission: 'kj-p8-b1', p8: 'R2.4 awaiting independent seal' });
    const w = world(on, repoFiles({ [`${REPO}/${STATUS}`]: status }), REMOTE);
    await boot($);
    const lines = await run($);
    expect(lines).toContain('Mission: kj-p8-b1');
    expect(lines).toContain('P8: R2.4 awaiting independent seal');
    expect(w.statuses.at(-1)).toBe(`KJ main@${MAIN_SHA.slice(0, 7)} | kj-p8-b1 | OBSERVE ONLY | SHADOW`);
  });

  for (const [name, body] of [
    ['not JSON', '{oops'],
    ['an array', '[]'],
    ['an extra key', JSON.stringify({ contract: 'kerneljson:claude-session-status/v1', mission: null, p8: 'x', token: 'y' })],
    ['a wrong contract', JSON.stringify({ contract: 'other', mission: null, p8: 'x' })],
    ['a control character', JSON.stringify({ contract: 'kerneljson:claude-session-status/v1', mission: 'a\u001bb', p8: 'x' })],
    ['an over-long value', JSON.stringify({ contract: 'kerneljson:claude-session-status/v1', mission: 'm'.repeat(81), p8: 'x' })],
    ['over 2 KiB', ' '.repeat(3000)],
  ] as const)
    test(`6. malformed status document (${name}) fails closed to UNKNOWN`, async ($, on) => {
      world(on, repoFiles({ [`${REPO}/${STATUS}`]: body }), REMOTE);
      await boot($);
      const lines = await run($);
      expect(lines).toContain('Mission: UNKNOWN');
      expect(lines.find(l => l.startsWith('P8: '))).toMatch(/^P8: UNKNOWN \(/);
      expect(lines).toContain('Authority: OBSERVE ONLY');
    });

  test('6b. unreadable git metadata gives UNKNOWN, not a crash', async ($, on) => {
    world(on, { [`${REPO}/.git/HEAD`]: 'garbage\n', [`${REPO}/x`]: '' }, REMOTE);
    await boot($);
    const lines = await run($);
    expect(lines).toContain('Branch: UNKNOWN');
    expect(lines).toContain('HEAD: UNKNOWN');
  });

  test('7. a tool call passes through unchanged and its result is returned unchanged', async ($, on) => {
    world(on, repoFiles(), REMOTE);
    const seen: unknown[] = [];
    const answer = { result: { ok: true }, isError: false };
    on('tool.call', (_$, e) => {
      seen.push(e);
      return answer as never;
    });
    await boot($);
    const input = { tool: 'mcp__probe__echo', tool_use_id: 'toolu_mod0_1', text: 'hello' };
    const got = await $.tool.call(input as never);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(expect.objectContaining(input));
    expect((got as { deny?: string }).deny).toBeUndefined();
    expect((got as { result?: unknown }).result).toEqual({ ok: true });
    expect(await run($)).toContain('Shadow: 1 tool call(s) observed, last mcp__probe__echo; none decided or changed');
  });

  test('7b. a call denied beneath stays denied: the mod neither allows nor hides it', async ($, on) => {
    world(on, repoFiles(), REMOTE);
    on('tool.call', () => ({ deny: 'denied beneath' }) as never);
    await boot($);
    const got = await $.tool.call({ tool: 'mcp__probe__echo', tool_use_id: 'toolu_mod0_2', text: 'x' } as never);
    expect(JSON.stringify(got)).toContain('denied beneath');
  });

  test('8. a prompt is not changed', async ($, on) => {
    world(on, repoFiles(), REMOTE);
    await boot($);
    const got = await ($ as unknown as { prompt: { submit: (e: never) => Promise<{ text: string }> } }).prompt.submit({ text: 'unchanged prompt', origin: { kind: 'composer' } } as never);
    expect(got.text).toBe('unchanged prompt');
  });

  test('9. 10. 12. no network, process, environment, write, listing or store use; works with production absent', async ($, on) => {
    const w = world(on, repoFiles({ [`${REPO}/${STATUS}`]: JSON.stringify({ contract: 'kerneljson:claude-session-status/v1', mission: null, p8: 'p' }) }), REMOTE);
    await boot($);
    await run($);
    await $.tool.call({ tool: 'mcp__probe__echo', tool_use_id: 'toolu_mod0_3', text: 'x' } as never).catch(() => undefined);
    expect(w.forbidden).toEqual([]);
    // Every file it touched is git metadata or the one status document.
    for (const r of w.reads) expect(r).toMatch(/\/\.git(\/|$)|\/\.kerneljson\/claude-status\.json$/);
  });

  test('11. a restart rebuilds the same view and starts the shadow tally again', async ($, on) => {
    world(on, repoFiles(), REMOTE);
    on('tool.call', () => ({ result: null }) as never);
    await boot($);
    await $.tool.call({ tool: 'mcp__probe__echo', tool_use_id: 'toolu_mod0_4', text: 'x' } as never);
    const first = await run($);
    await boot($);
    const second = await run($);
    expect(second.slice(0, 9)).toEqual(first.slice(0, 9));
    expect(second.at(-1)).toBe('Shadow: 0 tool call(s) observed; none decided or changed');
  });
});

