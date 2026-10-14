// cyphor-role: IO
// P-1 (WE-7.01): the grace-bound content cache under <PHANOS_HOME>/content-cache (03_c9-wire-client.md sections 5 and 7).
// Nothing outside `content-cache/` and its lock `content-cache.lock` is written. A cached file is never trusted by name:
// every read re-verifies the cached manifest pair and the item's sha256 and length, and deletes what fails.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { TrustedKey } from './trusted-keys.js';
import { CONTENT_VERSION_RE, contentNameProblem, isContentKind, PLUGIN_VERSION_RE, verifyContentManifest, type ContentManifest } from './content-manifest.js';
import { writeFileAtomic } from './fsutil.js';
import { StateLockBusyError, tokenExpiry, withFileLock, type StateLockOptions } from './state.js';

/** PhanOS `licence.js` GRACE_SECONDS (D-851). */
export const GRACE_SECONDS = 604800;
const LOCK_WAIT_MS = 5000;

export interface ContentIndexItem {
  sha256: string;
  bytes: number;
  fetchedAt: number;
}

export interface ContentIndex {
  schema: 1;
  pluginVersion: string;
  contentVersion: string;
  manifestSha256: string;
  kid: string;
  fetchedAt: number;
  /** Epoch seconds: the end of grace, token expiry plus GRACE_SECONDS. */
  expiresAt: number;
  items: Record<string, ContentIndexItem>;
}

export interface ContentCachePaths {
  dir: string;
  indexFile: string;
  lockFile: string;
}

export function contentCachePaths(home: string): ContentCachePaths {
  const dir = join(home, 'content-cache');
  return { dir, indexFile: join(dir, 'index.json'), lockFile: join(home, 'content-cache.lock') };
}

const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The cache's own lock (never state.json.lock); waits 5 s, then throws StateLockBusyError. Re-entrant per async chain. */
export async function withCacheLock<T>(home: string, fn: () => Promise<T>, opts: StateLockOptions = {}): Promise<T> {
  return await withFileLock(contentCachePaths(home).lockFile, fn, { waitMs: LOCK_WAIT_MS, ...opts });
}

// ---- grace -------------------------------------------------------------------------------------------------------

export interface GraceInput {
  token?: string | null;
  /** `state.tokenExpiresAt`, an ISO date, used when the token carries no `exp`. */
  tokenExpiresAt?: string;
  /** `state.serverTime`, epoch seconds: a floor for the clock that never decreases. */
  serverTime?: number;
  /** Clock override, epoch ms; default Date.now. */
  nowMs?: number;
}

export interface Grace {
  /** Token expiry plus GRACE_SECONDS, epoch seconds; null when no expiry is known. */
  expiresAt: number | null;
  /** The larger of the clock and serverTime, epoch seconds. */
  now: number;
  /** True when no expiry is known, or now is beyond expiresAt. */
  pastGrace: boolean;
}

export function computeGrace(input: GraceInput): Grace {
  let expirySec: number | null = null;
  const fromJwt = input.token ? tokenExpiry(input.token) : null;
  if (fromJwt !== null) expirySec = Math.floor(fromJwt.getTime() / 1000);
  else if (input.tokenExpiresAt !== undefined) {
    const t = Date.parse(input.tokenExpiresAt);
    if (Number.isFinite(t)) expirySec = Math.floor(t / 1000);
  }
  const clock = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const now = Math.max(clock, typeof input.serverTime === 'number' && Number.isFinite(input.serverTime) ? input.serverTime : 0);
  if (expirySec === null) return { expiresAt: null, now, pastGrace: true };
  const expiresAt = expirySec + GRACE_SECONDS;
  return { expiresAt, now, pastGrace: now > expiresAt };
}

/** Deletes the whole `content-cache/` under the cache lock; the lock file beside it stays. */
export async function purgeContentCache(home: string): Promise<void> {
  const paths = contentCachePaths(home);
  await withCacheLock(home, async () => {
    await rm(paths.dir, { recursive: true, force: true });
  });
}

/** The reconcile: past grace purges the cache. Returns whether it was past grace. A busy lock leaves the cache and throws. */
export async function reconcileGrace(home: string, input: GraceInput): Promise<boolean> {
  const grace = computeGrace(input);
  if (grace.pastGrace) await purgeContentCache(home);
  return grace.pastGrace;
}

// ---- index -------------------------------------------------------------------------------------------------------

function parseIndex(text: string): ContentIndex | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.schema !== 1) return null;
  const { pluginVersion, contentVersion, manifestSha256, kid, fetchedAt, expiresAt, items } = raw;
  if (typeof pluginVersion !== 'string' || !PLUGIN_VERSION_RE.test(pluginVersion)) return null;
  if (typeof contentVersion !== 'string') return null;
  const m = CONTENT_VERSION_RE.exec(contentVersion);
  if (!m || m[1] !== pluginVersion) return null;
  if (typeof manifestSha256 !== 'string' || typeof kid !== 'string') return null;
  if (typeof fetchedAt !== 'number' || typeof expiresAt !== 'number' || !isRecord(items)) return null;
  const clean: Record<string, ContentIndexItem> = {};
  for (const [key, v] of Object.entries(items)) {
    if (!isRecord(v) || typeof v.sha256 !== 'string' || typeof v.bytes !== 'number' || typeof v.fetchedAt !== 'number') continue;
    clean[key] = { sha256: v.sha256, bytes: v.bytes, fetchedAt: v.fetchedAt };
  }
  return { schema: 1, pluginVersion, contentVersion, manifestSha256, kid, fetchedAt, expiresAt, items: clean };
}

/** `index.json`, or null when absent or unparsable (an empty cache, rebuilt on the next fetch). */
export async function readContentIndex(home: string): Promise<ContentIndex | null> {
  try {
    return parseIndex(await readFile(contentCachePaths(home).indexFile, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeContentIndex(home: string, index: ContentIndex): Promise<void> {
  await writeFileAtomic(contentCachePaths(home).indexFile, `${JSON.stringify(index, null, 2)}\n`);
}

function setDir(home: string, pluginVersion: string, contentVersion: string): string | null {
  const m = CONTENT_VERSION_RE.exec(contentVersion);
  if (!m || m[1] !== pluginVersion) return null;
  return join(contentCachePaths(home).dir, pluginVersion, m[2]!);
}

function itemFile(dir: string, key: string): string | null {
  const parts = key.split('/');
  if (parts.length !== 2 || !isContentKind(parts[0]!) || contentNameProblem(parts[1]!) !== null) return null;
  return join(dir, parts[0]!, parts[1]!);
}

// ---- the set -----------------------------------------------------------------------------------------------------

export interface StoreSetInput {
  /** The exact manifest text. */
  manifestText: string;
  signature: { kid: string; sig: string };
  /** The manifest verified from `manifestText` and `signature` by the caller. */
  manifest: ContentManifest;
  /** Epoch seconds. */
  fetchedAt: number;
  /** Epoch seconds; the end of grace (computeGrace). */
  expiresAt: number;
}

/**
 * Stores a verified manifest as the one cached set. A manifest with another sha256 than the cached one is a swap: the new
 * set folder is written, then `index.json`, then the old set folder is removed. The same sha256 only refreshes
 * `fetchedAt` and `expiresAt` (items kept).
 */
export async function storeManifestSet(home: string, input: StoreSetInput): Promise<ContentIndex> {
  const { manifest } = input;
  const dir = setDir(home, manifest.pluginVersion, manifest.contentVersion);
  if (dir === null) throw new Error('storeManifestSet: manifest versions are inconsistent');
  const manifestSha256 = sha256Hex(input.manifestText);
  return await withCacheLock(home, async () => {
    const old = await readContentIndex(home);
    if (old !== null && old.manifestSha256 === manifestSha256) {
      const refreshed: ContentIndex = { ...old, fetchedAt: input.fetchedAt, expiresAt: input.expiresAt };
      await writeContentIndex(home, refreshed);
      return refreshed;
    }
    await writeFileAtomic(join(dir, 'manifest.json'), input.manifestText);
    await writeFileAtomic(join(dir, 'manifest.json.sig'), `${JSON.stringify({ kid: input.signature.kid, sig: input.signature.sig })}\n`);
    const next: ContentIndex = {
      schema: 1,
      pluginVersion: manifest.pluginVersion,
      contentVersion: manifest.contentVersion,
      manifestSha256,
      kid: manifest.kid,
      fetchedAt: input.fetchedAt,
      expiresAt: input.expiresAt,
      items: {},
    };
    await writeContentIndex(home, next);
    if (old !== null) {
      const oldDir = setDir(home, old.pluginVersion, old.contentVersion);
      if (oldDir !== null && oldDir !== dir) await rm(oldDir, { recursive: true, force: true });
    }
    return next;
  });
}

export interface CachedSet {
  index: ContentIndex;
  manifest: ContentManifest;
  manifestText: string;
  signature: { kid: string; sig: string };
}

async function dropSet(home: string, index: ContentIndex | null): Promise<void> {
  const paths = contentCachePaths(home);
  const dir = index === null ? null : setDir(home, index.pluginVersion, index.contentVersion);
  if (dir !== null) await rm(dir, { recursive: true, force: true });
  await rm(paths.indexFile, { force: true });
}

/**
 * The cached set with its manifest pair re-verified (signature, kid, sha256 against the index, versions against the
 * index). Any failure deletes the set and answers null. A busy cache lock answers null without deleting.
 */
export async function readCachedSet(home: string, keys: TrustedKey[]): Promise<CachedSet | null> {
  const index = await readContentIndex(home);
  if (index === null) return null;
  const dir = setDir(home, index.pluginVersion, index.contentVersion);
  if (dir === null) return null;
  try {
    return await withCacheLock(home, async () => {
      try {
        const manifestText = await readFile(join(dir, 'manifest.json'), 'utf8');
        const sigRaw: unknown = JSON.parse(await readFile(join(dir, 'manifest.json.sig'), 'utf8'));
        if (!isRecord(sigRaw) || typeof sigRaw.kid !== 'string' || typeof sigRaw.sig !== 'string') throw new Error('signature file');
        const signature = { kid: sigRaw.kid, sig: sigRaw.sig };
        const manifest = verifyContentManifest({ manifest: manifestText, signature }, keys);
        if (sha256Hex(manifestText) !== index.manifestSha256) throw new Error('manifest sha256');
        if (manifest.pluginVersion !== index.pluginVersion || manifest.contentVersion !== index.contentVersion) throw new Error('versions');
        return { index, manifest, manifestText, signature };
      } catch {
        await dropSet(home, index);
        return null;
      }
    });
  } catch (e) {
    if (e instanceof StateLockBusyError) return null;
    throw e;
  }
}

// ---- items -------------------------------------------------------------------------------------------------------

/** Writes one item of the cached set (atomic) and records it in the index. The bytes must match the manifest entry. */
export async function storeItem(home: string, set: CachedSet, key: string, body: Buffer, fetchedAt: number): Promise<void> {
  const entry = set.manifest.files[key];
  if (entry === undefined) throw new Error(`storeItem: ${key} is not in the manifest`);
  if (body.length !== entry.bytes || sha256Hex(body) !== entry.sha256) throw new Error(`storeItem: ${key} does not match the manifest`);
  const dir = setDir(home, set.manifest.pluginVersion, set.manifest.contentVersion);
  const file = dir === null ? null : itemFile(dir, key);
  if (file === null) throw new Error(`storeItem: bad key ${key}`);
  await withCacheLock(home, async () => {
    const current = await readContentIndex(home);
    if (current === null || current.manifestSha256 !== set.index.manifestSha256) throw new Error('storeItem: the cached set changed');
    await writeFileAtomic(file, body);
    current.items[key] = { sha256: entry.sha256, bytes: entry.bytes, fetchedAt };
    await writeContentIndex(home, current);
  });
}

/**
 * The cached bytes of an item, re-verified against the manifest entry (length and sha256). A failure deletes the file and
 * its index entry and answers null, as does an item never cached. A busy cache lock answers null without deleting.
 */
export async function readCachedItem(home: string, set: CachedSet, key: string): Promise<Buffer | null> {
  const entry = set.manifest.files[key];
  if (entry === undefined) return null;
  const dir = setDir(home, set.manifest.pluginVersion, set.manifest.contentVersion);
  const file = dir === null ? null : itemFile(dir, key);
  if (file === null) return null;
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return null;
  }
  if (body.length === entry.bytes && sha256Hex(body) === entry.sha256) return body;
  try {
    await withCacheLock(home, async () => {
      await rm(file, { force: true });
      const current = await readContentIndex(home);
      if (current !== null && current.manifestSha256 === set.index.manifestSha256 && key in current.items) {
        delete current.items[key];
        await writeContentIndex(home, current);
      }
    });
  } catch (e) {
    if (!(e instanceof StateLockBusyError)) throw e;
  }
  return null;
}
