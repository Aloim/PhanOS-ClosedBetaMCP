// cyphor-role: CORE
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { ReleaseVerificationError } from './release.js';
import { assertSafeEntryName } from './unzip.js';

/** C1 section 2.2: the per-file checksum list (`*.files.json`). */
export interface FilesListEntry {
  path: string;
  sha256: string;
  size: number;
}
export interface FilesList {
  schema: 1;
  archive: string;
  files: FilesListEntry[];
}
export interface TreeComparison {
  changed: string[];
  added: string[];
  missing: string[];
}
/** WE-5.01 ruling 6: how one relative path is treated when a release is applied over a live tree. */
export type FileClass = 'overwrite' | 'same' | 'kept' | 'conflict' | 'carried';

const HEX64 = /^[0-9a-f]{64}$/;

function refuse(message: string): never {
  throw new ReleaseVerificationError(`Invalid file list: ${message}. Nothing was installed.`);
}

/** Byte order of the UTF-8 encoding, never a locale or code-unit order. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function parseFilesList(bytes: Buffer | Uint8Array, opts: { archive: string }): FilesList {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return refuse('not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return refuse('not a JSON object');
  const obj = raw as Record<string, unknown>;
  if (obj.schema !== 1) return refuse(`schema must be 1, got ${JSON.stringify(obj.schema)}`);
  if (typeof obj.archive !== 'string' || obj.archive !== opts.archive) {
    return refuse(`archive is ${JSON.stringify(obj.archive)}, expected ${JSON.stringify(opts.archive)}`);
  }
  if (!Array.isArray(obj.files)) return refuse('files must be an array');

  const files: FilesListEntry[] = [];
  const folded = new Map<string, string>();
  let previous: string | undefined;
  for (const item of obj.files as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return refuse('a files entry is not an object');
    const e = item as Record<string, unknown>;
    const path = e.path;
    if (typeof path !== 'string') return refuse('a files entry has no string path');
    if (path.endsWith('/')) return refuse(`directory entry ${JSON.stringify(path)} (directories never appear)`);
    assertSafeEntryName(path);
    if (typeof e.sha256 !== 'string' || !HEX64.test(e.sha256)) {
      return refuse(`sha256 of ${JSON.stringify(path)} is not 64 lowercase hex characters`);
    }
    if (typeof e.size !== 'number' || !Number.isInteger(e.size) || e.size < 0) {
      return refuse(`size of ${JSON.stringify(path)} is not an integer of 0 or more`);
    }
    if (previous !== undefined) {
      const cmp = byteCompare(previous, path);
      if (cmp === 0) return refuse(`duplicate path ${JSON.stringify(path)} (each path appears once)`);
      if (cmp > 0) return refuse(`entries are not sorted by path in byte order (${JSON.stringify(path)} follows ${JSON.stringify(previous)})`);
    }
    const key = path.toLowerCase();
    const clash = folded.get(key);
    if (clash !== undefined) return refuse(`case collision between ${JSON.stringify(clash)} and ${JSON.stringify(path)}`);
    folded.set(key, path);
    previous = path;
    files.push({ path, sha256: e.sha256, size: e.size });
  }
  return { schema: 1, archive: obj.archive, files };
}

async function walk(root: string, rel: string, out: Map<string, string>): Promise<void> {
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
    } catch {
      digest = ''; // unreadable or a broken link: never equals a listed hash
    }
    out.set(childRel, digest);
  }
}

/**
 * Compares a directory tree to a parsed list by raw bytes (a CRLF rewrite is a change).
 * Returns POSIX paths, each array sorted in byte order.
 */
export async function compareTree(dir: string, list: FilesList): Promise<TreeComparison> {
  const actual = new Map<string, string>();
  await walk(dir, '', actual);
  const listed = new Map(list.files.map((f) => [f.path, f] as const));
  const changed: string[] = [];
  const added: string[] = [];
  const missing: string[] = [];
  for (const [path, digest] of actual) {
    const want = listed.get(path);
    if (!want) added.push(path);
    else if (want.sha256 !== digest) changed.push(path);
  }
  for (const path of listed.keys()) if (!actual.has(path)) missing.push(path);
  return { changed: changed.sort(byteCompare), added: added.sort(byteCompare), missing: missing.sort(byteCompare) };
}

/**
 * Pure three-way classification over sha256 hashes (no disk access). stored = the live tree's files.json
 * (rel -> sha256; null = no stored list, uncheckable); next = the verified release list; disk = sha256 of
 * each file on disk. Returns one class per path that needs one, keys in byte order; a path absent from
 * disk and not in next produces no entry.
 */
export function classifyThreeWay(
  stored: ReadonlyMap<string, string> | null,
  next: ReadonlyMap<string, string>,
  disk: ReadonlyMap<string, string>,
): Map<string, FileClass> {
  const paths = new Set<string>([...next.keys(), ...disk.keys(), ...(stored?.keys() ?? [])]);
  const out = new Map<string, FileClass>();
  for (const rel of [...paths].sort(byteCompare)) {
    const cls = classifyOne(stored === null, stored?.get(rel), next.get(rel), disk.get(rel));
    if (cls !== undefined) out.set(rel, cls);
  }
  return out;
}

function classifyOne(
  uncheckable: boolean,
  s: string | undefined,
  n: string | undefined,
  d: string | undefined,
): FileClass | undefined {
  // provisional decision: a path in next and absent from disk is restored (overwrite) even when uncheckable,
  // because nothing on disk can be lost; alternative: conflict, the literal "D differs from N" reading.
  if (d === undefined) return n === undefined ? undefined : 'overwrite';
  // provisional decision: when stored is null, a disk file absent from next is a conflict (it cannot be
  // proven ours to replace); alternative: carried.
  if (uncheckable) return n === d ? 'same' : 'conflict';
  // provisional decision: stored = disk = next gives overwrite (the written rule order: D = S first);
  // alternative: same, since the bytes already match.
  if (s !== undefined && d === s) return 'overwrite';
  if (n !== undefined && d === n) return 'same';
  if (s === undefined) return n === undefined ? 'carried' : 'conflict';
  if (n === undefined) return 'carried';
  return n === s ? 'kept' : 'conflict';
}
