/**
 * kj-console - KernelJSON MOD-0, the read-only session console.
 *
 * Hooks: `session.start` (read local facts, register /kj-status, set the status line), `command.run` for
 * `kj-status` (answer with the console text), and `tool.call` in SHADOW mode (count, then pass the call through
 * exactly as received and return exactly what the engine returned).
 *
 * Engine calls: `$.session.repo` (origin remote, regex-tested only, never shown or stored), `$.fs.stat`,
 * `$.fs.read`, `$.state` (via atom/read/update), `$.ui.status`, `$.command.register`. Nothing else: no network,
 * no process, no environment, no writes, no prompt hook, no permission decisions.
 */
import { atom, read, update } from 'claude-code';
import type { Register } from 'claude-code';

import type { ConsoleView, ShadowTally } from '../types';
import { consoleLines, readView, statusLine, type Reader } from './session';

const view = atom({ plugin: 'kj-console', key: 'view' } as const, null as ConsoleView | null);
const shadow = atom({ plugin: 'kj-console', key: 'shadow' } as const, { observed: 0, lastTool: null } as ShadowTally);

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const reader: Reader = {
      stat: path => $.fs.stat(path),
      read: path => $.fs.read(path),
    };
    let repo: { remote: string | null } | null = null;
    try {
      repo = await $.session.repo();
    } catch {
      repo = null;
    }
    let v: ConsoleView;
    try {
      v = await readView(reader, e.cwd, repo === null ? undefined : repo.remote);
    } catch {
      v = { applicable: true, repo: 'kerneljson', branch: 'UNKNOWN', head: 'UNKNOWN', mission: 'UNKNOWN', p8: 'UNKNOWN (read failed)' };
    }
    // A fresh session (or a reload) rebuilds the view from files and starts the shadow tally again.
    await update($, view, () => v);
    await update($, shadow, () => ({ observed: 0, lastTool: null }));
    await $.command.register({ name: 'kj-status', description: 'KernelJSON MOD-0: show the read-only session console' });
    $.ui.status(statusLine(v));
    return next(e);
  });

  on('command.run', { command: 'kj-status' }, async $ => {
    const v = await read($, view);
    const s = await read($, shadow);
    const lines = consoleLines(v);
    lines.push(`Shadow: ${s.observed} tool call(s) observed${s.lastTool ? `, last ${s.lastTool}` : ''}; none decided or changed`);
    return { text: lines.join('\n') };
  });

  // SHADOW: never deny, never rewrite. The call goes on exactly as received; the result comes back exactly as given.
  on('tool.call', async ($, e, next) => {
    const result = await next(e);
    try {
      const tool = String(e.tool).slice(0, 64);
      await update($, shadow, s => ({ observed: s.observed + 1, lastTool: tool }));
    } catch {
      /* observation must never affect the call */
    }
    return result;
  });
};
