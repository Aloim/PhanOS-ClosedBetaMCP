// WE-3.03 M6b pointer prune (C-3). For each <home>/projects/<installId>/pointer.json, drops a roots[] entry
// whose folder is gone, or whose .phanos/manifest.json is absent or names another installId, unless that root
// holds a live lease (.cyphor/state/leases.json; D-73 expiry, no pid test). The lease file is read only for a
// root that would otherwise be pruned. Never throws: every failure skips the one pointer it concerns.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil.js';

export interface PruneOptions {
  /** Clock in ms since epoch; injectable for tests. Defaults to Date.now. */
  now?: () => number;
  /** Test seam for the control row: when true, the lease file is never read. */
  __skipLeaseRead?: boolean;
}

const EDITIONS = new Set(['pro', 'basic', 'source']);

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRootEntry(value: unknown): value is { root: string; key: string } {
  return isRecord(value) && typeof value.root === 'string' && typeof value.key === 'string';
}

async function readJson(file: string): Promise<Json | null> {
  try {
    const parsed: unknown = JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isPruneCandidate(root: string, installId: string): Promise<boolean> {
  if (!(await isDirectory(root))) return true;
  const manifest = await readJson(join(root, '.phanos', 'manifest.json'));
  return manifest === null || manifest.installId !== installId;
}

// D-73 expiry without the pid test: a lease is live when its state is `live` and renewed + ttl_s*1000 is in the
// future by the caller's clock. An unparseable renewed value is not live (lease.js treats it as expired).
async function hasLiveLease(root: string, nowMs: number): Promise<boolean> {
  const store = await readJson(join(root, '.cyphor', 'state', 'leases.json'));
  if (store === null || !isRecord(store.leases)) return false;
  return Object.values(store.leases).some(
    (lease) =>
      isRecord(lease) &&
      lease.state === 'live' &&
      typeof lease.renewed === 'string' &&
      typeof lease.ttl_s === 'number' &&
      lease.ttl_s > 0 &&
      Date.parse(lease.renewed) + lease.ttl_s * 1000 > nowMs,
  );
}

async function pruneOne(file: string, nowMs: number, opts: PruneOptions): Promise<number> {
  const pointer = await readJson(file);
  if (pointer === null || typeof pointer.installId !== 'string') return 0;
  if (typeof pointer.edition !== 'string' || !EDITIONS.has(pointer.edition)) return 0;
  const installId = pointer.installId;
  const roots: unknown[] = Array.isArray(pointer.roots) ? pointer.roots : [];

  const dropKeys = new Set<string>();
  for (const entry of roots) {
    if (!isRootEntry(entry)) continue;
    if (!(await isPruneCandidate(entry.root, installId))) continue;
    if (!opts.__skipLeaseRead && (await hasLiveLease(entry.root, nowMs))) continue;
    dropKeys.add(entry.key);
  }
  if (dropKeys.size === 0) return 0;

  // Re-read just before writing, so a writer that added a root meanwhile keeps it; merge by key.
  const fresh = await readJson(file);
  if (fresh === null || !Array.isArray(fresh.roots)) return 0;
  const kept = fresh.roots.filter((entry) => !(isRootEntry(entry) && dropKeys.has(entry.key)));
  const removed = fresh.roots.length - kept.length;
  if (removed === 0) return 0;
  fresh.roots = kept;
  await writeFileAtomic(file, `${JSON.stringify(fresh, null, 2)}\n`);
  return removed;
}

export async function pruneProjectPointers(home: string, opts: PruneOptions = {}): Promise<{ pruned: number }> {
  const clock = opts.now ?? (() => Date.now());
  const nowMs = clock();
  let pruned = 0;
  try {
    const projects = join(home, 'projects');
    for (const dirent of await readdir(projects, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      try {
        pruned += await pruneOne(join(projects, dirent.name, 'pointer.json'), nowMs, opts);
      } catch {
        // one unwritable or unreadable pointer does not stop the others
      }
    }
  } catch {
    // no projects folder under this home: nothing to prune
  }
  return { pruned };
}
