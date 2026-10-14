// cyphor-role: IO
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, open, readFile, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { readJsonOr, writeFileAtomic } from './fsutil.js';
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const SCHEMA1_KEYS = new Set(['edition', 'installedVersion', 'registeredWithClaude']);
function upgradeSchema1(raw) {
    const out = { schema: 2 };
    for (const [k, v] of Object.entries(raw))
        if (!SCHEMA1_KEYS.has(k) && k !== 'schema')
            out[k] = v;
    const local = raw.edition === 'pro' ? 'pro' : raw.edition === 'free' ? 'basic' : null;
    if (local) {
        out.enabled = local;
        const record = {};
        if (typeof raw.installedVersion === 'string')
            record.version = raw.installedVersion;
        if (typeof raw.registeredWithClaude === 'boolean')
            record.registered = raw.registeredWithClaude;
        out[local] = record;
    }
    return out;
}
/** Reads the state file as schema 2. A file with no `schema` is schema 1 and is upgraded in memory only. Corrupt or missing reads as empty. */
export async function readLocalState(p) {
    let raw;
    try {
        raw = await readJsonOr(p.stateFile, {});
    }
    catch {
        return { schema: 2 };
    }
    if (!isRecord(raw))
        return { schema: 2 };
    if (raw.schema === undefined || raw.schema === 1)
        return upgradeSchema1(raw);
    return raw;
}
export async function writeLocalState(p, s) {
    const clean = Object.fromEntries(Object.entries({ ...s, schema: 2 }).filter(([, v]) => v !== undefined));
    await writeFileAtomic(p.stateFile, `${JSON.stringify(clean, null, 2)}\n`, 0o600);
}
const finiteOrUndefined = (v) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
/** The larger of a stored and a seen server time (epoch seconds). A non-finite value counts as absent; undefined when neither is finite. */
export function maxServerTime(stored, seen) {
    const a = finiteOrUndefined(stored);
    const b = finiteOrUndefined(seen);
    if (a === undefined)
        return b;
    if (b === undefined)
        return a;
    return Math.max(a, b);
}
/**
 * Records how this MCP was launched. Returns false and writes nothing when the stored record already has the same
 * entry, node and version; otherwise writes the record (other keys preserved) and returns true.
 */
export async function recordLaunch(p, launch, now) {
    const state = await readLocalState(p);
    const stored = state.mcp;
    if (isRecord(stored) &&
        stored.entry === launch.entry &&
        stored.node === launch.node &&
        stored.version === launch.version) {
        return false;
    }
    await writeLocalState(p, {
        ...state,
        mcp: { entry: launch.entry, node: launch.node, version: launch.version, recordedAt: now.toISOString() },
    });
    return true;
}
export async function readToken(p) {
    try {
        return (await readFile(p.tokenFile, 'utf8')).trim() || null;
    }
    catch {
        return null;
    }
}
export async function writeToken(p, token) {
    await writeFileAtomic(p.tokenFile, token, 0o600);
}
export async function deleteToken(p) {
    await rm(p.tokenFile, { force: true });
}
export function tokenExpiry(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
        return typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null;
    }
    catch {
        return null;
    }
}
/** Thrown when `withStateLock` is still held after its `waitMs` (at once for `waitMs: 0`). */
export class StateLockBusyError extends Error {
    constructor(message = 'state.json is locked by another PhanOS process') {
        super(message);
        this.name = 'StateLockBusyError';
    }
}
const ignoreEnoent = (err) => {
    if (err.code !== 'ENOENT')
        throw err;
};
const defaultIsAlive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === 'EPERM';
    }
};
const lockBody = (pid, at) => `${JSON.stringify({ pid, at })}\n`;
async function readLock(lockFile) {
    let raw;
    try {
        raw = await readFile(lockFile, 'utf8');
    }
    catch (err) {
        return err.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'busy' };
    }
    let body = null;
    try {
        body = JSON.parse(raw);
    }
    catch {
        body = null;
    }
    const rec = isRecord(body) ? body : {};
    return {
        kind: 'seen',
        raw,
        pid: typeof rec.pid === 'number' ? rec.pid : null,
        at: typeof rec.at === 'number' ? rec.at : null,
    };
}
/** Exclusive create; false when the lock already exists (or is still pending removal on Windows). */
async function createLock(lockFile, pid, now) {
    const handle = await open(lockFile, 'wx').catch((err) => {
        if (err.code === 'EEXIST' || err.code === 'EPERM')
            return null;
        throw err;
    });
    if (!handle)
        return false;
    try {
        await handle.writeFile(lockBody(pid, now()));
    }
    finally {
        await handle.close();
    }
    return true;
}
/** Removes a stale lock only if it still reads exactly as judged stale, so a fresh lock created in between survives. */
async function breakLock(lockFile, judged) {
    const current = await readFile(lockFile, 'utf8').catch(() => null);
    if (current === judged)
        await unlink(lockFile).catch(ignoreEnoent);
}
async function beat(lockFile, pid, now) {
    try {
        const seen = await readLock(lockFile);
        if (seen.kind === 'seen' && seen.pid === pid)
            await writeFileAtomic(lockFile, lockBody(pid, now()), 0o600);
    }
    catch {
        // a missed beat is caught up on the next tick
    }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The locks held by the current async call chain, keyed by lock file; copied on write so sibling chains never see each other's entries. */
const heldLocks = new AsyncLocalStorage();
const lockKey = (file) => (process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file));
/**
 * Runs `fn` while holding `<home>/state.json.lock`. A contender waits (polling), and breaks the lock only when its
 * pid is dead or its `at` is older than `staleMs`; the holder rewrites `at` every `heartbeatMs`. Removes the lock
 * afterwards only if it still carries this process's pid. Re-entrant per async call chain: a call made inside fn for
 * the same lock file, while fn has not returned, runs its own fn at once and ignores its options; a call from any
 * other chain (another process, or another task in this process) waits or throws as before. Await nested calls: one
 * started and not awaited runs alongside the outer fn without exclusion.
 */
export async function withStateLock(p, fn, opts = {}) {
    return await withFileLock(join(p.home, 'state.json.lock'), fn, opts);
}
/** The lock of `withStateLock` on any lock file (same pid, heartbeat, stale and re-entrancy rules); a busy lock throws StateLockBusyError. */
export async function withFileLock(lockFile, fn, opts = {}) {
    const key = lockKey(lockFile);
    const mine = heldLocks.getStore()?.get(key);
    if (mine !== undefined && !mine.released)
        return await fn();
    const waitMs = opts.waitMs ?? 60_000;
    const pollMs = opts.pollMs ?? 200;
    const heartbeatMs = opts.heartbeatMs ?? 10_000;
    const staleMs = opts.staleMs ?? 30_000;
    const now = opts.now ?? Date.now;
    const isAlive = opts.isAlive ?? defaultIsAlive;
    const pid = process.pid;
    const deadline = now() + waitMs;
    await mkdir(dirname(lockFile), { recursive: true });
    for (;;) {
        if (await createLock(lockFile, pid, now))
            break;
        const seen = await readLock(lockFile);
        if (seen.kind === 'absent')
            continue;
        if (seen.kind === 'seen') {
            const stale = seen.pid === null || seen.at === null || !isAlive(seen.pid) || now() - seen.at > staleMs;
            if (stale) {
                await breakLock(lockFile, seen.raw);
                continue;
            }
        }
        if (now() >= deadline)
            throw new StateLockBusyError();
        await pause(pollMs);
    }
    const held = { released: false };
    const store = new Map(heldLocks.getStore() ?? []);
    store.set(key, held);
    let beating = Promise.resolve();
    const timer = setInterval(() => {
        beating = beating.then(() => beat(lockFile, pid, now));
    }, heartbeatMs);
    timer.unref();
    try {
        return await heldLocks.run(store, fn);
    }
    finally {
        held.released = true;
        clearInterval(timer);
        await beating;
        const seen = await readLock(lockFile);
        if (seen.kind === 'seen' && seen.pid === pid)
            await unlink(lockFile).catch(ignoreEnoent);
    }
}
