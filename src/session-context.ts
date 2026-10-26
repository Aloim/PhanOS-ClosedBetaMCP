// cyphor-role: CORE
// S5-2.01: Scaffolded by the orchestrator, run 20261025-st5 (plan documentation/plans/implementation-plans/2026-10-25_st5-server-boundary).
// Session-context readers: the session id, project dir, install id, coordination mode and the
// lease state root. Each reader returns null or false on absent or malformed input and never throws.
// The state-root rule mirrors PhanOS Cyphor lease/state-root.js at commit c23fb7a26 (D-787).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { contentNameProblem } from './content-manifest.js';
import type { Paths } from './config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GITDIR_LINE = /^gitdir:[ \t]*(\S(?:.*\S)?)[ \t]*\r?$/m;

/** sha256 hex (64 lowercase hex characters) of a session id. */
export function sessionKeyOf(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex');
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The session id from `CLAUDE_CODE_SESSION_ID`, or null when absent or empty. */
export function readSessionId(env: NodeJS.ProcessEnv): string | null {
  return nonEmpty(env.CLAUDE_CODE_SESSION_ID);
}

/** The project directory from `CLAUDE_PROJECT_DIR`, or null when absent or empty. No cwd fallback. */
export function projectDirOf(env: NodeJS.ProcessEnv): string | null {
  return nonEmpty(env.CLAUDE_PROJECT_DIR);
}

function readJsonObject(projectDir: string, file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(projectDir, file), 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `installId` from `<projectDir>/.phanos/manifest.json` when it is a lowercase UUID, else null. */
export function readInstallId(projectDir: string): string | null {
  const installId = readJsonObject(projectDir, path.join('.phanos', 'manifest.json'))?.installId;
  return typeof installId === 'string' && UUID.test(installId) ? installId : null;
}

/** True when `<projectDir>/.phanos/config.json` `coordination` is `mirror` or `required`; false otherwise. */
export function readCoordinationMode(projectDir: string): boolean {
  const coordination = readJsonObject(projectDir, path.join('.phanos', 'config.json'))?.coordination;
  return coordination === 'mirror' || coordination === 'required';
}

/**
 * The directory whose `.cyphor/state/` holds the lease store: the main checkout when `projectDir` is a
 * linked worktree (a `.git` FILE whose `gitdir:` line resolves to `<X>/.git/worktrees/<name>`, with
 * `commondir` pointing back at `<X>/.git`), else `projectDir` unchanged. Never throws.
 */
export function stateRootOf(projectDir: string): string {
  try {
    const dotGit = path.join(projectDir, '.git');
    if (!fs.statSync(dotGit).isFile()) return projectDir;

    const match = GITDIR_LINE.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!match) return projectDir;
    const adminDir = path.resolve(projectDir, match[1]!);

    const worktreesDir = path.dirname(adminDir);
    const commonGit = path.dirname(worktreesDir);
    if (path.basename(worktreesDir) !== 'worktrees' || path.basename(commonGit) !== '.git') return projectDir;

    const commondirText = fs.readFileSync(path.join(adminDir, 'commondir'), 'utf8');
    const commondir = commondirText.split(/\r?\n/, 1)[0]!.trim();
    if (commondir.length === 0) return projectDir;

    const commonReal = fs.realpathSync.native(commonGit);
    if (fs.realpathSync.native(path.resolve(adminDir, commondir)) !== commonReal) return projectDir;

    return fs.realpathSync.native(path.dirname(commonReal));
  } catch {
    return projectDir;
  }
}

/** `<stateRoot>/.cyphor/state/coord`. */
export function coordDirOf(stateRoot: string): string {
  return path.join(stateRoot, '.cyphor', 'state', 'coord');
}

/** `<home>/session-set/beats/<id>.json`. */
export function beatFile(home: string, id: string): string {
  return path.join(home, 'session-set', 'beats', `${id}.json`);
}

/** `<home>/mcp/started/<id>.json`. */
export function startedFile(home: string, id: string): string {
  return path.join(home, 'mcp', 'started', `${id}.json`);
}

/** `<paths.marketplace.pro.pluginDir>/Phanes/templates/scripts`. */
export function sessionScriptsDir(paths: Paths): string {
  return path.join(paths.marketplace.pro.pluginDir, 'Phanes', 'templates', 'scripts');
}

/** The session set read from the pro plugin: whether it is set, and its label names. */
export interface SessionTree {
  sessionSet: boolean;
  names: string[];
}

/**
 * The session set, read from `<pluginDir>/Phanes/edition-id.json` (`schema` 1, `sessionSet` true) and
 * `<pluginDir>/Phanes/session-labels.json` (`schema` 1, `root` `Phanes/templates/scripts`, `names`). Either
 * file absent, malformed or wrong-shaped gives `{sessionSet: false, names: []}`. A label name that is not a
 * string, fails `contentNameProblem`, or spans more than one path segment is dropped. Never throws.
 */
export function readSessionTree(paths: Paths): SessionTree {
  const none: SessionTree = { sessionSet: false, names: [] };
  try {
    const phanes = path.join(paths.marketplace.pro.pluginDir, 'Phanes');
    const edition = readJsonObject(phanes, 'edition-id.json');
    if (edition === null || edition.schema !== 1 || edition.sessionSet !== true) return none;

    const labels = readJsonObject(phanes, 'session-labels.json');
    if (labels === null || labels.schema !== 1 || labels.root !== 'Phanes/templates/scripts') return none;
    if (!Array.isArray(labels.names)) return none;

    const names = (labels.names as unknown[]).filter(
      (name): name is string =>
        typeof name === 'string' && !/[\\/]/.test(name) && contentNameProblem(name) === null,
    );
    return { sessionSet: true, names };
  } catch {
    return none;
  }
}
