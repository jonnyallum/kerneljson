/**
 * kj-console (KernelJSON MOD-0) - the values this mod keeps in `$.state` for the session.
 * Mod-local only: nothing here is KernelJSON state and nothing is written anywhere else.
 */

/** What the console knows about the session, rebuilt from local files at every `session.start`. */
export type ConsoleView =
  | { applicable: false; reason: 'no-repository' | 'not-kerneljson' }
  | {
      applicable: true;
      repo: 'kerneljson';
      /** Branch name, `(detached)`, or `UNKNOWN` when git metadata could not be read. */
      branch: string;
      /** Full commit SHA of HEAD, or `UNKNOWN`. */
      head: string;
      /** From the local status document: the bound mission, `UNBOUND` when none, `UNKNOWN` when unreadable. */
      mission: string;
      /** From the local status document: the P8 line, or `UNKNOWN (...)` with the reason. */
      p8: string;
    };

/** Shadow observation of tool calls: counts and the last tool's name only, never inputs or outputs. */
export type ShadowTally = { observed: number; lastTool: string | null };

declare module 'claude-code' {
  interface PluginState {
    'kj-console': { view: ConsoleView | null; shadow: ShadowTally };
  }
}
