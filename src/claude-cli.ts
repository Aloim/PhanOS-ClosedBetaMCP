// cyphor-role: IO
import { execFile } from 'node:child_process';
import { PLUGIN_IDS } from './config.js';

/** `timeoutMs` bounds one run (default 120 s); a probe passes 10 s. */
export type ClaudeRunner = (args: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

export function quoteForCmd(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/** `exec` is a test seam for the child-process spawn; production uses node's execFile. */
export function createCommandRunner(cmd: string, platform: NodeJS.Platform = process.platform, exec: typeof execFile = execFile): ClaudeRunner {
  return (args, opts) =>
    new Promise((resolve) => {
      const timeout = opts?.timeoutMs ?? 120_000;
      const attempt = (useShell: boolean) =>
        exec(cmd, useShell ? args.map(quoteForCmd) : args, { shell: useShell, timeout, windowsHide: true }, (err, stdout, stderr) => {
          const code = (err as NodeJS.ErrnoException | null)?.code;
          // npm-installed claude.cmd: pre-CVE-2024-27980 Node reports ENOENT for a shell-less
          // execFile of a .cmd; Node 22+ instead refuses synchronously with EINVAL (F-3153).
          if ((code === 'ENOENT' || code === 'EINVAL') && platform === 'win32' && !useShell) return attempt(true);
          resolve({ code: err ? (typeof code === 'number' ? code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err?.message ?? '') });
        });
      attempt(false);
    });
}

export const createClaudeRunner = (platform: NodeJS.Platform = process.platform): ClaudeRunner => createCommandRunner('claude', platform);

// ---------------------------------------------------------------------------
// Full-id plugin wrappers (C1 §1 rule 1, §4 rule 1). A bare `phanos` hits the first match in
// Claude Code, so every id passed to `claude plugin` is checked by assertFullId first.
// The CLI's success messages name the bare `phanos`, so a wrapper never decides success from
// stdout; only `marketplace add` and `install` keep the /already/ rule (M3b judges the rest
// from the listing).
// ---------------------------------------------------------------------------

export type CliResult = { code: number; stdout: string; stderr: string };
export type CliOutcome = CliResult & { ok: boolean };
export type PluginScope = 'user' | 'project' | 'local';

export interface PluginState {
  installed: true;
  enabled: boolean;
  projectEnabled: boolean;
  version?: string;
  notes?: string[];
}

const ALLOWED_IDS: ReadonlySet<string> = new Set<string>(Object.values(PLUGIN_IDS));

/** Throws unless `id` is one of PLUGIN_IDS (config.ts). */
export function assertFullId(id: string): void {
  if (!ALLOWED_IDS.has(id)) {
    throw new Error(`refusing plugin id "${id}": a full id is required (${[...ALLOWED_IDS].join(' | ')}); a bare "phanos" resolves to the first match in Claude Code`);
  }
}

const call = (run: ClaudeRunner, args: string[]): Promise<CliResult> =>
  run(args).catch((e: Error): CliResult => ({ code: -1, stdout: '', stderr: e.message }));

const withAlready = (r: CliResult): CliOutcome => ({ ...r, ok: r.code === 0 || /already/i.test(`${r.stdout}\n${r.stderr}`) });

/** The manual-fallback line for a `claude` invocation; every plugin id in it must be a full id. */
export function manualCommand(args: string[]): string {
  for (const a of args) if (a === 'phanos' || a.startsWith('phanos@')) assertFullId(a);
  return `claude ${args.map(quoteForCmd).join(' ')}`;
}

/** The two manual commands for a missing CLI: add the marketplace folder, install the full id. */
export function manualInstallCommands(marketplaceDir: string, id: string): string[] {
  assertFullId(id);
  return [manualCommand(['plugin', 'marketplace', 'add', marketplaceDir]), manualCommand(['plugin', 'install', id])];
}

/** Parses `plugin list --json` into `{id -> state}`; null when the shape is not understood. */
export function parsePluginList(stdout: string): Record<string, PluginState> | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const entries: [string, PluginState][] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) return null;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || e.id === '' || typeof e.enabled !== 'boolean') return null;
    if (e.projectEnabled !== undefined && typeof e.projectEnabled !== 'boolean') return null;
    const state: PluginState = { installed: true, enabled: e.enabled, projectEnabled: e.projectEnabled === true };
    if (typeof e.version === 'string') state.version = e.version;
    if (Array.isArray(e.notes) && e.notes.every((n) => typeof n === 'string')) state.notes = e.notes as string[];
    entries.push([e.id, state]);
  }
  return Object.fromEntries(entries);
}

/** Runs `plugin list --json`; null on a failing run, a throwing runner or an unknown shape. */
export async function listPlugins(run: ClaudeRunner): Promise<Record<string, PluginState> | null> {
  const r = await call(run, ['plugin', 'list', '--json']);
  return r.code === 0 ? parsePluginList(r.stdout) : null;
}

export async function addMarketplace(run: ClaudeRunner, dir: string): Promise<CliOutcome> {
  return withAlready(await call(run, ['plugin', 'marketplace', 'add', dir]));
}

export async function installPlugin(run: ClaudeRunner, id: string): Promise<CliOutcome> {
  assertFullId(id);
  return withAlready(await call(run, ['plugin', 'install', id]));
}

const scoped = (verb: 'enable' | 'disable', id: string, opts?: { scope?: PluginScope }): string[] =>
  ['plugin', verb, id, ...(opts?.scope ? ['--scope', opts.scope] : [])];

/** Exit 1 means "already enabled" as often as a failure: the code is returned as-is; read the listing. */
export async function enablePlugin(run: ClaudeRunner, id: string, opts?: { scope?: PluginScope }): Promise<CliResult> {
  assertFullId(id);
  return call(run, scoped('enable', id, opts));
}

/** Project-scope off needs `{ scope: 'project' }` and a runner whose cwd is inside that project. */
export async function disablePlugin(run: ClaudeRunner, id: string, opts?: { scope?: PluginScope }): Promise<CliResult> {
  assertFullId(id);
  return call(run, scoped('disable', id, opts));
}

export async function uninstallPlugin(run: ClaudeRunner, id: string): Promise<CliResult> {
  assertFullId(id);
  return call(run, ['plugin', 'uninstall', id]);
}

export async function removeMarketplace(run: ClaudeRunner, name: string): Promise<CliResult> {
  return call(run, ['plugin', 'marketplace', 'remove', name]);
}
