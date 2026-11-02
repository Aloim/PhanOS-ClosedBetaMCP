// cyphor-role: IO
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonOr, writeFileAtomic } from './fsutil.js';
import { readLocalState, withStateLock, writeLocalState } from './state.js';
const FILE_NAMES = {
    warning: 'quota-warning.json',
    exhausted: 'quota-exhausted.json',
};
const quotaFilePath = (paths, which) => join(paths.home, FILE_NAMES[which]);
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Epoch milliseconds of an ISO string, or null when it does not parse. */
const epochMs = (iso) => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : ms;
};
const ignoreEnoent = (err) => {
    if (err.code !== 'ENOENT')
        throw err;
};
/** A quota file is current only while its resetAt lies in the future (C-W5); anything else is stale or invalid. */
function isCurrent(raw, now) {
    if (!isRecord(raw) || raw.v !== 1)
        return false;
    if (typeof raw.limitSec !== 'number' || typeof raw.usedSec !== 'number')
        return false;
    if (typeof raw.weekStart !== 'string' || typeof raw.at !== 'string' || typeof raw.resetAt !== 'string')
        return false;
    const reset = epochMs(raw.resetAt);
    return reset !== null && reset > now.getTime();
}
/** Reads one quota marker file; null when it is missing, invalid, or its resetAt has passed. */
export async function readQuotaFile(paths, which, now) {
    let raw;
    try {
        raw = await readJsonOr(quotaFilePath(paths, which), null);
    }
    catch {
        return null;
    }
    return isCurrent(raw, now) ? raw : null;
}
/** Writes the marker file atomically when wanted, otherwise deletes it (a missing file is not an error). */
async function settleFile(paths, which, quota, now) {
    const file = quotaFilePath(paths, which);
    if (quota === null) {
        await unlink(file).catch(ignoreEnoent);
        return;
    }
    const body = {
        v: 1,
        limitSec: quota.limitSec,
        usedSec: quota.usedSec,
        weekStart: quota.weekStart,
        resetAt: quota.resetAt,
        at: now.toISOString(),
    };
    await writeFileAtomic(file, `${JSON.stringify(body, null, 2)}\n`, 0o600);
}
/**
 * Records the Pro Budget as the server sent it. The warning and exhausted files follow the flags and are deleted
 * once their resetAt has passed; an undefined quota (a pro account) deletes both and drops lastConfirmed.quota.
 * A lastConfirmed record is updated only when one already exists; this function never invents one.
 */
export async function recordQuota(paths, quota, now) {
    await withStateLock(paths, async () => {
        const reset = quota === undefined ? null : epochMs(quota.resetAt);
        const live = quota !== undefined && reset !== null && reset > now.getTime();
        await settleFile(paths, 'warning', quota !== undefined && live && quota.warn ? quota : null, now);
        await settleFile(paths, 'exhausted', quota !== undefined && live && quota.exhausted ? quota : null, now);
        const state = await readLocalState(paths);
        if (state.lastConfirmed === undefined)
            return;
        if (quota === undefined) {
            if (state.lastConfirmed.quota === undefined)
                return;
            const lastConfirmed = { ...state.lastConfirmed };
            delete lastConfirmed.quota;
            await writeLocalState(paths, { ...state, lastConfirmed });
            return;
        }
        await writeLocalState(paths, { ...state, lastConfirmed: { ...state.lastConfirmed, quota } });
    });
}
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** The reset moment as `Monday 2026-11-09, 00:00 UTC` (the PhanOS copy's `{date}` form); the raw string when it does not parse. */
const resetMoment = (iso) => {
    const ms = epochMs(iso);
    if (ms === null)
        return iso;
    const d = new Date(ms);
    const s = d.toISOString();
    return `${WEEKDAYS[d.getUTCDay()]} ${s.slice(0, 10)}, ${s.slice(11, 16)} UTC`;
};
/**
 * The one-line Pro Budget text for `phanos_status` (plan WB2.06, spec PB-6/PB-9). Normal: hours used and the weekly reset.
 * Warn (30 minutes or fewer left, not used up): the minutes left and what happens when they run out. Used up: when Pro returns.
 */
export function quotaLine(q) {
    const limitHours = Math.round(q.limitSec / 3600);
    const used = (q.usedSec / 3600).toFixed(1);
    if (q.exhausted) {
        return `Pro Budget: all ${limitHours} hours of this week are used. Pro returns on ${resetMoment(q.resetAt)}; PhanOS Basic keeps working until then.`;
    }
    if (q.warn) {
        const minutes = Math.max(1, Math.ceil((q.limitSec - q.usedSec) / 60));
        return `Pro Budget: ${used} of ${limitHours} hours used this week, about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left. When they run out, this session keeps Pro until you close it, and the next one starts on PhanOS Basic until ${resetMoment(q.resetAt)}.`;
    }
    return `Pro Budget: ${used} of ${limitHours} hours used this week; resets Monday 00:00 UTC.`;
}
