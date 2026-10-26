// cyphor-role: CORE
// S5-2.07: Scaffolded by the orchestrator, run 20261025-st5 (plan documentation/plans/implementation-plans/2026-10-25_st5-server-boundary).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Paths } from './config.js';
import { projectDirOf, readCoordinationMode, readSessionTree, sessionScriptsDir } from './session-context.js';

/** The coordination role the drain reports in this process (coord-drain.ts `role()`). */
export type CoordRole = 'off' | 'leader' | 'follower' | 'unreachable';

export interface SessionStatusCtx {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  /** The drain's role, when this process runs the drain; undefined when it does not. */
  coordRole?: () => CoordRole | undefined;
}

/**
 * The three status lines of the session set (S5-2.07), in order: the scripts folder, the freshest beat, the coordination mode.
 * Facts come from files on disk; a file that cannot be read answers `never` or `absent`, never a throw.
 */
export async function sessionStatusLines(ctx: SessionStatusCtx): Promise<string[]> {
  return [await sessionSetLine(ctx.paths), await beatLine(ctx.paths), coordinationLine(ctx)];
}

async function sessionSetLine(paths: Paths): Promise<string> {
  if (!readSessionTree(paths).sessionSet) return 'session set: not enabled';
  let files = 0;
  try {
    const entries = await readdir(sessionScriptsDir(paths), { withFileTypes: true });
    files = entries.filter((entry) => entry.isFile()).length;
  } catch {
    files = 0;
  }
  return files === 0 ? 'session set: absent' : `session set: present (${files} files)`;
}

/**
 * The beats folder holds one file per session on this home. The freshest `lastOkAt` across it answers, because the status
 * call does not know which session it serves and any fresh beat shows the machine is beating. Malformed files are skipped.
 */
async function beatLine(paths: Paths): Promise<string> {
  const dir = path.join(paths.home, 'session-set', 'beats');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    return 'beat: never';
  }
  let freshest: { ms: number; iso: string } | null = null;
  for (const name of names) {
    try {
      const raw = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as { lastOkAt?: unknown } | null;
      const iso = typeof raw?.lastOkAt === 'string' ? raw.lastOkAt : null;
      const ms = iso === null ? NaN : Date.parse(iso);
      if (iso !== null && Number.isFinite(ms) && (freshest === null || ms > freshest.ms)) freshest = { ms, iso };
    } catch {
      // A malformed beat file is skipped.
    }
  }
  return freshest === null ? 'beat: never' : `beat: last ok ${freshest.iso}`;
}

/**
 * Coordination is off unless the project's mode is `mirror` or `required`. When it is on, the drain's own role answers;
 * a process that runs no drain has no role on disk to read, so it reports `mirror (follower)` as the fallback.
 */
function coordinationLine(ctx: SessionStatusCtx): string {
  const projectDir = projectDirOf(ctx.env);
  if (projectDir === null || !readCoordinationMode(projectDir)) return 'coordination: off';
  const role = ctx.coordRole?.();
  if (role === undefined) return 'coordination: mirror (follower)';
  if (role === 'off') return 'coordination: off';
  if (role === 'unreachable') return 'coordination: unreachable';
  return `coordination: mirror (${role})`;
}
