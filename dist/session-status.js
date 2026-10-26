// cyphor-role: CORE
// S5-2.07: Scaffolded by the orchestrator, run 20261025-st5 (plan documentation/plans/implementation-plans/2026-10-25_st5-server-boundary).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectDirOf, readCoordinationMode, readSessionTree, sessionScriptsDir } from './session-context.js';
/**
 * The three status lines of the session set (S5-2.07), in order: the scripts folder, the freshest beat, the coordination mode.
 * Facts come from files on disk; a file that cannot be read answers `never` or `absent`, never a throw.
 */
export async function sessionStatusLines(ctx) {
    return [await sessionSetLine(ctx.paths), await beatLine(ctx.paths), coordinationLine(ctx)];
}
async function sessionSetLine(paths) {
    if (!readSessionTree(paths).sessionSet)
        return 'session set: not enabled';
    let files = 0;
    try {
        const entries = await readdir(sessionScriptsDir(paths), { withFileTypes: true });
        files = entries.filter((entry) => entry.isFile()).length;
    }
    catch {
        files = 0;
    }
    return files === 0 ? 'session set: absent' : `session set: present (${files} files)`;
}
/**
 * The beats folder holds one file per session on this home. The freshest `lastOkAt` across it answers, because the status
 * call does not know which session it serves and any fresh beat shows the machine is beating. Malformed files are skipped.
 */
async function beatLine(paths) {
    const dir = path.join(paths.home, 'session-set', 'beats');
    let names;
    try {
        names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    }
    catch {
        return 'beat: never';
    }
    let freshest = null;
    for (const name of names) {
        try {
            const raw = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
            const iso = typeof raw?.lastOkAt === 'string' ? raw.lastOkAt : null;
            const ms = iso === null ? NaN : Date.parse(iso);
            if (iso !== null && Number.isFinite(ms) && (freshest === null || ms > freshest.ms))
                freshest = { ms, iso };
        }
        catch {
            // A malformed beat file is skipped.
        }
    }
    return freshest === null ? 'beat: never' : `beat: last ok ${freshest.iso}`;
}
/**
 * Coordination is off unless the project's mode is `mirror` or `required`. When it is on, the drain's own role answers;
 * a process that runs no drain has no role on disk to read, so it reports `mirror (follower)` as the fallback.
 */
function coordinationLine(ctx) {
    const projectDir = projectDirOf(ctx.env);
    if (projectDir === null || !readCoordinationMode(projectDir))
        return 'coordination: off';
    const role = ctx.coordRole?.();
    if (role === undefined)
        return 'coordination: mirror (follower)';
    if (role === 'off')
        return 'coordination: off';
    if (role === 'unreachable')
        return 'coordination: unreachable';
    return `coordination: mirror (${role})`;
}
