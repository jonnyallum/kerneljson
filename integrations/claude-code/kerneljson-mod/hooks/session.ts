/**
 * kj-console - pure reading of the session's local facts. No engine calls here except through the narrow `Reader`
 * the hooks module passes in, so every file this mod can read is visible in one place (see `readView`).
 *
 * Read-only by construction: the Reader has `stat` and `read`, nothing that writes, lists, runs or fetches.
 */
import type { ConsoleView } from '../types';

/** The only two filesystem operations MOD-0 uses. Both may reject (missing file); every caller catches. */
export type Reader = {
  stat: (path: string) => Promise<{ kind: 'file' | 'dir' | 'other'; size: number }>;
  read: (path: string) => Promise<string>;
};

/** The repository MOD-0 recognises: the canonical KernelJSON remote, SSH or HTTPS, with or without `.git`. */
const KERNELJSON_REMOTE = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)jonnyallum\/kerneljson(?:\.git)?\/?$/i;
export const isKernelJsonRemote = (remote: string | null | undefined): boolean =>
  typeof remote === 'string' && KERNELJSON_REMOTE.test(remote.trim());

/** Local status document, optional, bounded, strictly shaped. */
export const STATUS_FILE = '.kerneljson/claude-status.json';
export const STATUS_MAX_BYTES = 2048;
export const STATUS_CONTRACT = 'kerneljson:claude-session-status/v1';
const SAFE_TEXT = /^[\x20-\x7e]{1,80}$/;

const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const MAX_WALK = 64;
const MAX_GIT_FILE = 1_048_576; // packed-refs bound; HEAD, gitdir and refs are tiny

export const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
const join = (a: string, b: string): string => (b.startsWith('/') || /^[A-Za-z]:\//.test(b) ? norm(b) : `${norm(a)}/${b}`);
const parent = (p: string): string | null => {
  const n = norm(p);
  const i = n.lastIndexOf('/');
  if (i < 0) return null;
  if (i === 0) return n === '/' ? null : '/';
  const up = n.slice(0, i);
  return /^[A-Za-z]:$/.test(up) ? (n.length > 3 ? `${up}/` : null) : up;
};
/** Resolve `.` and `..` segments so a relative gitdir lands on a clean absolute path. */
const tidy = (p: string): string => {
  const n = norm(p);
  const lead = /^[A-Za-z]:\//.test(n) ? n.slice(0, 3) : n.startsWith('/') ? '/' : '';
  const out: string[] = [];
  for (const part of n.slice(lead.length).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return lead + out.join('/');
};

async function readSmall(r: Reader, path: string, max: number): Promise<string | null> {
  try {
    const st = await r.stat(path);
    if (st.kind !== 'file' || st.size > max) return null;
    return await r.read(path);
  } catch {
    return null;
  }
}

/** Locate the git directory for `cwd`: a `.git` directory, or a `.git` file naming a worktree's gitdir. */
export async function findGit(r: Reader, cwd: string): Promise<{ root: string; gitDir: string; commonDir: string } | null> {
  let dir: string | null = norm(cwd);
  for (let i = 0; dir && i < MAX_WALK; i++, dir = parent(dir)) {
    const dotGit = join(dir, '.git');
    let kind: string | null = null;
    try {
      kind = (await r.stat(dotGit)).kind;
    } catch {
      kind = null;
    }
    if (kind === 'dir') return { root: dir, gitDir: dotGit, commonDir: dotGit };
    if (kind === 'file') {
      const text = await readSmall(r, dotGit, 4096);
      const m = text ? /^gitdir:\s*(.+?)\s*$/m.exec(text) : null;
      if (!m) return null;
      const gitDir = tidy(join(dir, m[1]!));
      const common = await readSmall(r, join(gitDir, 'commondir'), 4096);
      const commonDir = common ? tidy(join(gitDir, common.trim())) : gitDir;
      return { root: dir, gitDir, commonDir };
    }
  }
  return null;
}

/** Branch and HEAD from git's own files. Never runs git. */
export async function readHead(r: Reader, git: { gitDir: string; commonDir: string }): Promise<{ branch: string; head: string }> {
  const raw = (await readSmall(r, join(git.gitDir, 'HEAD'), 4096))?.trim();
  if (!raw) return { branch: 'UNKNOWN', head: 'UNKNOWN' };
  if (SHA.test(raw)) return { branch: '(detached)', head: raw };
  const ref = /^ref:\s*(refs\/[A-Za-z0-9._/@+-]+)$/.exec(raw)?.[1];
  if (!ref || ref.includes('..')) return { branch: 'UNKNOWN', head: 'UNKNOWN' };
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  for (const base of [git.gitDir, git.commonDir]) {
    const loose = (await readSmall(r, join(base, ref), 4096))?.trim();
    if (loose && SHA.test(loose)) return { branch, head: loose };
  }
  const packed = await readSmall(r, join(git.commonDir, 'packed-refs'), MAX_GIT_FILE);
  for (const line of (packed ?? '').split(/\r?\n/)) {
    const [sha, name] = line.split(' ');
    if (name === ref && sha && SHA.test(sha)) return { branch, head: sha };
  }
  return { branch, head: 'UNKNOWN' };
}

/** Parse the optional status document. Any defect gives UNKNOWN; it never throws. */
export function parseStatus(text: string | null, missing: boolean): { mission: string; p8: string } {
  if (missing) return { mission: 'UNBOUND', p8: 'UNKNOWN (no local status file)' };
  const unknown = (why: string) => ({ mission: 'UNKNOWN', p8: `UNKNOWN (${why})` });
  if (text === null) return unknown('status file unreadable or over 2 KiB');
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return unknown('status file is not JSON');
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return unknown('status file is not an object');
  const keys = Object.keys(doc).sort().join(',');
  if (keys !== 'contract,mission,p8') return unknown('status file has unexpected keys');
  const d = doc as { contract: unknown; mission: unknown; p8: unknown };
  if (d.contract !== STATUS_CONTRACT) return unknown('status file contract not recognised');
  const okText = (v: unknown): v is string => typeof v === 'string' && SAFE_TEXT.test(v);
  if (!(d.mission === null || okText(d.mission)) || !okText(d.p8)) return unknown('status file values out of bounds');
  return { mission: d.mission ?? 'UNBOUND', p8: d.p8 };
}

/**
 * The whole read: repository recognition, git metadata and the status document. The complete list of files this
 * can read: `<dir>/.git` (stat) for each ancestor of cwd up to the repository; the `.git` file of a worktree;
 * `<gitDir>/commondir`, `<gitDir>/HEAD`, the one ref file HEAD names (in gitDir or commonDir), `<commonDir>/packed-refs`;
 * and `<root>/.kerneljson/claude-status.json`.
 */
export async function readView(r: Reader, cwd: string, remote: string | null | undefined): Promise<ConsoleView> {
  if (!isKernelJsonRemote(remote)) return { applicable: false, reason: remote === undefined ? 'no-repository' : 'not-kerneljson' };
  const git = await findGit(r, cwd);
  const { branch, head } = git ? await readHead(r, git) : { branch: 'UNKNOWN', head: 'UNKNOWN' };
  let missing = false;
  let text: string | null = null;
  if (git) {
    const path = join(git.root, STATUS_FILE);
    try {
      const st = await r.stat(path);
      text = st.kind === 'file' && st.size <= STATUS_MAX_BYTES ? await r.read(path) : null;
    } catch {
      missing = true;
    }
  }
  const { mission, p8 } = git ? parseStatus(text, missing) : { mission: 'UNKNOWN', p8: 'UNKNOWN (no git metadata)' };
  return { applicable: true, repo: 'kerneljson', branch, head, mission, p8 };
}

/** The console text, as `/kj-status` shows it. Constant lines describe MOD-0 itself, not KernelJSON. */
export function consoleLines(v: ConsoleView | null): string[] {
  if (!v) return ['KERNELJSON', 'Status: UNKNOWN (session not yet read)', 'Mod: SHADOW'];
  if (!v.applicable)
    return ['KERNELJSON', `Not applicable here (${v.reason === 'no-repository' ? 'not a git repository' : 'not the kerneljson repository'})`, 'Mod: SHADOW'];
  return [
    'KERNELJSON',
    `Mission: ${v.mission}`,
    `Repo: ${v.repo}`,
    `Branch: ${v.branch}`,
    `HEAD: ${v.head}`,
    `P8: ${v.p8}`,
    'Authority: OBSERVE ONLY',
    'Production: LOCKED',
    'Mod: SHADOW',
  ];
}

/** One compact status-line entry. */
export function statusLine(v: ConsoleView | null): string {
  if (!v || !v.applicable) return 'KJ n/a';
  const sha = SHA.test(v.head) ? v.head.slice(0, 7) : 'UNKNOWN';
  return `KJ ${v.branch}@${sha} | ${v.mission} | OBSERVE ONLY | SHADOW`;
}
