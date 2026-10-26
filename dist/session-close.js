// cyphor-role: CORE
// S5-2.04: Scaffolded by the orchestrator, run 20261025-st5 (plan documentation/plans/implementation-plans/2026-10-25_st5-server-boundary).
import { readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { beatFile, projectDirOf, readInstallId, readSessionId, readSessionTree, sessionKeyOf, sessionScriptsDir, } from './session-context.js';
import { readLocalState, readToken } from './state.js';
/** The end post is capped at this many milliseconds; the close never holds the session longer (contract: 3 s). */
export const END_CAP_MS = 3000;
/** A beat is live for this long after its lastOkAt; the same window as the session beat's fresh check (contract: 20 min). */
const LIVE_WINDOW_MS = 20 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
/** One close per context: a second call on the same context does nothing. */
const closed = new WeakSet();
/**
 * Closes the session when its transport ends. Best effort throughout: posts the end (capped), deletes this session's
 * beat, and deletes the session-set labelled files from the scripts folder only when no other session's beat is live.
 * Nothing else is ever deleted. Sets the exit code to 0; never exits the process.
 */
export async function closeSession(ctx) {
    if (closed.has(ctx))
        return;
    closed.add(ctx);
    const sessionId = sessionIdOf(ctx.env);
    await postEnd(ctx, sessionId);
    if (sessionId !== null)
        await removeOwnBeat(ctx, sessionId);
    if (!(await liveForeignBeat(ctx, sessionId)))
        await removeLabelled(ctx);
    process.exitCode = 0;
}
function sessionIdOf(env) {
    const id = readSessionId(env);
    return id !== null && SAFE_ID.test(id) ? id : null;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Posts sessions/end through the context's SessionApi, capped at END_CAP_MS. A missing credential skips the post. */
async function postEnd(ctx, sessionId) {
    if (sessionId === null) {
        ctx.log('session end: skip (no session id)');
        return;
    }
    const projectDir = projectDirOf(ctx.env);
    const installId = projectDir === null ? null : readInstallId(projectDir);
    const token = await readToken(ctx.paths);
    const deviceId = (await readLocalState(ctx.paths)).deviceId;
    if (installId === null || token === null || typeof deviceId !== 'string' || deviceId.length === 0) {
        ctx.log('session end: skip (no credentials)');
        return;
    }
    let handle = null;
    const cap = new Promise((resolve) => {
        handle = ctx.timers.setTimeout(() => resolve(), END_CAP_MS);
    });
    try {
        await Promise.race([ctx.api.end(token, { deviceId, installId, sessionKey: sessionKeyOf(sessionId) }), cap]);
    }
    catch {
        ctx.log('session end: error');
    }
    finally {
        if (handle !== null)
            ctx.timers.clearTimeout(handle);
    }
}
/** Deletes this session's own beat file. A missing file is not an error. */
async function removeOwnBeat(ctx, sessionId) {
    try {
        await rm(beatFile(ctx.paths.home, sessionId), { force: true });
    }
    catch {
        ctx.log('session beat: remove error');
    }
}
/**
 * True when another session's beat file in the beats folder has a lastOkAt within the live window. This session's own
 * beat is never counted. An unreadable beats folder (other than absent) counts as live, so the files are kept.
 */
async function liveForeignBeat(ctx, ownId) {
    const dir = path.join(ctx.paths.home, 'session-set', 'beats');
    let names;
    try {
        names = await readdir(dir);
    }
    catch (err) {
        return err.code !== 'ENOENT';
    }
    const own = ownId === null ? null : `${ownId}.json`;
    const nowMs = ctx.now().getTime();
    for (const name of names) {
        if (!name.endsWith('.json') || name === own)
            continue;
        try {
            const raw = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
            const t = isRecord(raw) && typeof raw.lastOkAt === 'string' ? Date.parse(raw.lastOkAt) : NaN;
            if (Number.isFinite(t) && nowMs - t < LIVE_WINDOW_MS)
                return true;
        }
        catch {
            // An unreadable beat is not live.
        }
    }
    return false;
}
/**
 * Deletes every session-set label name in the scripts folder, in the reaper's form: rename to `<name>.deleting-<ts>`,
 * then remove. Names come from the session-set tree only; a tree that is not a session set deletes nothing.
 */
async function removeLabelled(ctx) {
    const tree = readSessionTree(ctx.paths);
    if (!tree.sessionSet)
        return;
    const dir = sessionScriptsDir(ctx.paths);
    const ts = ctx.now().getTime();
    for (const name of tree.names) {
        const file = path.join(dir, name);
        const tombstone = path.join(dir, `${name}.deleting-${ts}`);
        try {
            await rename(file, tombstone);
            await rm(tombstone, { force: true });
        }
        catch (err) {
            if (err.code !== 'ENOENT')
                ctx.log('session files: remove error');
        }
    }
}
