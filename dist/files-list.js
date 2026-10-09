// cyphor-role: CORE
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { ReleaseVerificationError } from './release.js';
import { assertSafeEntryName } from './unzip.js';
const HEX64 = /^[0-9a-f]{64}$/;
function refuse(message) {
    throw new ReleaseVerificationError(`Invalid file list: ${message}. Nothing was installed.`);
}
/** Byte order of the UTF-8 encoding, never a locale or code-unit order. */
function byteCompare(a, b) {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
export function parseFilesList(bytes, opts) {
    let raw;
    try {
        raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
    }
    catch {
        return refuse('not valid JSON');
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return refuse('not a JSON object');
    const obj = raw;
    if (obj.schema !== 1)
        return refuse(`schema must be 1, got ${JSON.stringify(obj.schema)}`);
    if (typeof obj.archive !== 'string' || obj.archive !== opts.archive) {
        return refuse(`archive is ${JSON.stringify(obj.archive)}, expected ${JSON.stringify(opts.archive)}`);
    }
    if (!Array.isArray(obj.files))
        return refuse('files must be an array');
    const files = [];
    const folded = new Map();
    let previous;
    for (const item of obj.files) {
        if (typeof item !== 'object' || item === null || Array.isArray(item))
            return refuse('a files entry is not an object');
        const e = item;
        const path = e.path;
        if (typeof path !== 'string')
            return refuse('a files entry has no string path');
        if (path.endsWith('/'))
            return refuse(`directory entry ${JSON.stringify(path)} (directories never appear)`);
        assertSafeEntryName(path);
        if (typeof e.sha256 !== 'string' || !HEX64.test(e.sha256)) {
            return refuse(`sha256 of ${JSON.stringify(path)} is not 64 lowercase hex characters`);
        }
        if (typeof e.size !== 'number' || !Number.isInteger(e.size) || e.size < 0) {
            return refuse(`size of ${JSON.stringify(path)} is not an integer of 0 or more`);
        }
        if (previous !== undefined) {
            const cmp = byteCompare(previous, path);
            if (cmp === 0)
                return refuse(`duplicate path ${JSON.stringify(path)} (each path appears once)`);
            if (cmp > 0)
                return refuse(`entries are not sorted by path in byte order (${JSON.stringify(path)} follows ${JSON.stringify(previous)})`);
        }
        const key = path.toLowerCase();
        const clash = folded.get(key);
        if (clash !== undefined)
            return refuse(`case collision between ${JSON.stringify(clash)} and ${JSON.stringify(path)}`);
        folded.set(key, path);
        previous = path;
        files.push({ path, sha256: e.sha256, size: e.size });
    }
    return { schema: 1, archive: obj.archive, files };
}
async function walk(root, rel, out) {
    const entries = await readdir(rel === '' ? root : join(root, ...rel.split('/')), { withFileTypes: true });
    for (const entry of entries) {
        const childRel = rel === '' ? entry.name : posix.join(rel, entry.name);
        if (entry.isDirectory()) {
            await walk(root, childRel, out);
            continue;
        }
        let digest = '';
        try {
            digest = createHash('sha256').update(await readFile(join(root, ...childRel.split('/')))).digest('hex');
        }
        catch {
            digest = ''; // unreadable or a broken link: never equals a listed hash
        }
        out.set(childRel, digest);
    }
}
/**
 * Compares a directory tree to a parsed list by raw bytes (a CRLF rewrite is a change).
 * Returns POSIX paths, each array sorted in byte order.
 */
export async function compareTree(dir, list) {
    const actual = new Map();
    await walk(dir, '', actual);
    const listed = new Map(list.files.map((f) => [f.path, f]));
    const changed = [];
    const added = [];
    const missing = [];
    for (const [path, digest] of actual) {
        const want = listed.get(path);
        if (!want)
            added.push(path);
        else if (want.sha256 !== digest)
            changed.push(path);
    }
    for (const path of listed.keys())
        if (!actual.has(path))
            missing.push(path);
    return { changed: changed.sort(byteCompare), added: added.sort(byteCompare), missing: missing.sort(byteCompare) };
}
