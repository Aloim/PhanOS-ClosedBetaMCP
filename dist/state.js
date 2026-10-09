// cyphor-role: IO
import { readFile, rm } from 'node:fs/promises';
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
