// cyphor-role: IO
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil.js';
export const GENESIS = '0'.repeat(64);
const HEX64 = /^[0-9a-f]{64}$/;
export function ledgerPath(home) {
    return join(home, 'session-set', 'activity', 'ledger.jsonl');
}
export function ackPath(home) {
    return join(home, 'session-set', 'activity', 'ack.json');
}
export function lineHash(prev, start, end, sid) {
    return createHash('sha256').update(`${prev}|${start}|${end}|${sid}`).digest('hex');
}
export async function readLedgerDetailed(home) {
    let text;
    try {
        text = await readFile(ledgerPath(home), 'utf8');
    }
    catch (err) {
        if (err.code === 'ENOENT') {
            return { lines: [], badIndex: null };
        }
        throw err;
    }
    const lines = [];
    const physical = text.split('\n');
    for (let i = 0; i < physical.length; i++) {
        const raw = (physical[i] ?? '').replace(/\r$/, '');
        if (raw.trim() === '')
            continue;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return { lines, badIndex: i };
        }
        lines.push(parsed);
    }
    return { lines, badIndex: null };
}
export async function readLedger(home) {
    return (await readLedgerDetailed(home)).lines;
}
export function batchAfter(lines, ackedHead, max = 200) {
    // Rotated ledger, or a fresh device acking GENESIS: the first line chains from the acked head.
    if (lines[0] !== undefined && lines[0].prev === ackedHead) {
        return { from: ackedHead, intervals: lines.slice(0, max) };
    }
    const found = lines.findIndex((l) => l.hash === ackedHead);
    if (found >= 0) {
        return { from: ackedHead, intervals: lines.slice(found + 1, found + 1 + max) };
    }
    return { from: GENESIS, intervals: lines.slice(0, max) };
}
export async function readAck(home) {
    let raw;
    try {
        raw = JSON.parse(await readFile(ackPath(home), 'utf8'));
    }
    catch {
        return GENESIS;
    }
    if (typeof raw !== 'object' || raw === null)
        return GENESIS;
    const rec = raw;
    if (rec.v !== 1 || typeof rec.hash !== 'string' || !HEX64.test(rec.hash))
        return GENESIS;
    return rec.hash;
}
export async function writeAck(home, hash, now) {
    const body = JSON.stringify({ v: 1, hash, at: now.toISOString() });
    await writeFileAtomic(ackPath(home), body);
}
