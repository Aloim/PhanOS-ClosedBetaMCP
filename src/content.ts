// cyphor-role: CORE
// P-2 (WE-7.01): the phanos_content client and tool core (C-9; 03_c9-wire-client.md sections 1 to 6). Every byte served is
// checked against the Ed25519-signed manifest first (S0a verifyContentManifest, P-1 cache); the result strings are the
// fixed set of section 4 and never carry server text.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, type Api, type ContentEnvelope } from './api.js';
import type { Paths } from './config.js';
import {
  computeGrace,
  contentCachePaths,
  purgeContentCache,
  readCachedItem,
  readCachedSet,
  readContentIndex,
  reconcileGrace,
  storeItem,
  storeManifestSet,
  withCacheLock,
  type CachedSet,
  type ContentIndex,
  type Grace,
} from './content-cache.js';
import {
  ContentVerificationError,
  PLUGIN_VERSION_RE,
  contentNameProblem,
  isContentKind,
  parseContentPin,
  verifyContentManifest,
  type ContentFile,
  type ContentKind,
  type ContentManifest,
  type ContentPin,
} from './content-manifest.js';
import { readLocalState, readToken, StateLockBusyError, tokenExpiry } from './state.js';
import { TRUSTED_RELEASE_KEYS, type TrustedKey } from './trusted-keys.js';
import { MCP_VERSION } from './version.js';

/** PROVISIONAL (03_c9-wire-client.md section 6): the Pro plugin versions this MCP serves text to, `min <= v < below` by core triple. */
export const SUPPORTS_PLUGIN = { min: '0.2.5', below: '0.3.0' } as const;

/** Mirrors the service's token refresh window (service.ts REFRESH_BEFORE_MS): inside it the service is asked for a fresh token. */
const REFRESH_WINDOW_MS = 3 * 86_400_000;

export interface ContentInput {
  kind: ContentKind | 'manifest';
  /** Required unless `kind` is `manifest`. */
  name?: string;
  /** Default: the installed Pro tree's `Phanes/edition-id.json` version (C-1). */
  pluginVersion?: string;
}

export interface ContentOutcome {
  ok: boolean;
  version?: string;
  contentVersion?: string;
  sha256?: string;
  body?: string;
  /** Present exactly when `ok` is false. */
  result?: string;
}

export interface ContentDeps {
  api: Pick<Api, 'getContentManifest' | 'getContentItem'>;
  paths: Paths;
  /** Clock; default the system clock. */
  now?: () => Date;
  /**
   * The service's `ensureToken` under its lock. Asked only when the disk token is missing or inside the refresh window; a
   * thrown error (busy lock, offline) keeps the disk token as it is.
   */
  refreshToken?: () => Promise<string | null>;
}

/** The text form of the tool answer: the body when `ok`, else the one-line `result: ...`. */
export function contentOutcomeText(outcome: ContentOutcome): string {
  return outcome.ok ? (outcome.body ?? '') : `result: ${outcome.result ?? 'unavailable'}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

const refused = (reason: string): ContentOutcome => ({ ok: false, result: `refused (${reason})` });
const unavailable = (reason: string): ContentOutcome => ({ ok: false, result: `unavailable (${reason})` });
const MISMATCH: ContentOutcome = { ok: false, result: 'mismatch (manifest)' };

// ---- plugin version ----------------------------------------------------------------------------------------------

interface Triple {
  core: [number, number, number];
  prerelease: boolean;
}

function parseTriple(version: string): Triple | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] !== undefined };
}

function compareCore(a: Triple['core'], b: Triple['core']): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

/** `min <= v < below` by core triple; a prerelease counts below its own core (so `0.2.5-rc.1` is refused, and so is `0.3.0-rc.1`). */
export function supportsPlugin(pluginVersion: string): boolean {
  const v = parseTriple(pluginVersion);
  const min = parseTriple(SUPPORTS_PLUGIN.min);
  const below = parseTriple(SUPPORTS_PLUGIN.below);
  if (!v || !min || !below) return false;
  const lo = compareCore(v.core, min.core);
  if (lo < 0 || (lo === 0 && v.prerelease)) return false;
  return compareCore(v.core, below.core) < 0;
}

async function readText(file: string): Promise<string | null> {
  try {
    const text = await readFile(file, 'utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // a BOM is tolerated (C-* rule)
  } catch {
    return null;
  }
}

/** The request's plugin version, else the installed Pro tree's C-1 file. */
async function resolvePluginVersion(paths: Paths, given: string | undefined): Promise<{ version: string } | { reason: string }> {
  if (given !== undefined) return PLUGIN_VERSION_RE.test(given) ? { version: given } : { reason: 'bad_plugin_version' };
  const text = await readText(join(paths.marketplace.pro.pluginDir, 'Phanes', 'edition-id.json'));
  if (text === null) return { reason: 'no_plugin_version' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { reason: 'no_plugin_version' };
  }
  if (!isRecord(raw) || raw.edition !== 'pro' || typeof raw.version !== 'string' || !PLUGIN_VERSION_RE.test(raw.version)) return { reason: 'no_plugin_version' };
  return { version: raw.version };
}

/** `Phanes/content-pin.json` when it parses and names the requested plugin version; otherwise no pin. */
async function readPin(paths: Paths, pluginVersion: string): Promise<ContentPin | null> {
  const text = await readText(join(paths.marketplace.pro.pluginDir, 'Phanes', 'content-pin.json'));
  if (text === null) return null;
  try {
    const pin = parseContentPin(text);
    return pin.pluginVersion === pluginVersion ? pin : null;
  } catch (e) {
    if (e instanceof ContentVerificationError) return null;
    throw e;
  }
}

// ---- the call ----------------------------------------------------------------------------------------------------

interface Ctx {
  deps: ContentDeps;
  home: string;
  pluginVersion: string;
  pin: ContentPin | null;
  token: string;
  keys: TrustedKey[];
  /** Epoch seconds. */
  fetchedAt: number;
  /** Epoch seconds: the end of grace. */
  expiresAt: number;
}

/** The cache is best effort: a busy lock or a failing disk never blocks an answer that is already verified. */
async function tryCache<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

const okManifest = (ctx: Ctx, set: CachedSet): ContentOutcome => ({
  ok: true,
  version: ctx.pluginVersion,
  contentVersion: set.manifest.contentVersion,
  sha256: sha256Hex(set.manifestText),
  body: set.manifestText,
});

const okItem = (ctx: Ctx, set: CachedSet, entry: ContentFile, body: Uint8Array): ContentOutcome => ({
  ok: true,
  version: ctx.pluginVersion,
  contentVersion: set.manifest.contentVersion,
  sha256: entry.sha256,
  body: Buffer.from(body).toString('utf8'),
});

/** A cached set may answer for this request only at or above the pin, and bound to the pin's hash when it is the pinned set. */
function usable(ctx: Ctx, set: CachedSet | null): CachedSet | null {
  if (set === null || set.index.pluginVersion !== ctx.pluginVersion) return null;
  const pin = ctx.pin;
  if (pin !== null) {
    if (set.manifest.counter < pin.counter) return null;
    if (set.manifest.contentVersion === pin.contentVersion && set.index.manifestSha256 !== pin.manifestSha256) return null;
  }
  return set;
}

type Step<T> = ({ value: T } & { out?: never; degrade?: never }) | { out: ContentOutcome; value?: never; degrade?: never } | { degrade: string; value?: never; out?: never };

const SAFE_CODE = /^[a-z][a-z0-9_]{0,39}$/;

/** Section 4, steps 4 and 5: the answer of a non-200, non-304 status. Server text never reaches a result string. */
function failure(answer: { status: number; error: string }): { out: ContentOutcome } | { degrade: string } {
  if (answer.status === 429 || answer.status >= 500) return { degrade: String(answer.status) };
  if (answer.status === 409) return refusedStep('no content set for this plugin version; run phanos_update');
  if (answer.status === 426) return refusedStep('plugin below minimum; run phanos_update');
  return refusedStep(SAFE_CODE.test(answer.error) ? answer.error : `http_${answer.status}`);
}

const refusedStep = (reason: string): { out: ContentOutcome } => ({ out: refused(reason) });

/** The manifest envelope verified and bound to this request; null on any failure (the caller answers `mismatch (manifest)`). */
function verifyEnvelope(ctx: Ctx, env: unknown): { manifest: ContentManifest; text: string; signature: { kid: string; sig: string } } | null {
  if (!isRecord(env)) return null;
  const { pluginVersion, contentVersion, sha256, manifest: text, signature } = env as Partial<Record<keyof ContentEnvelope, unknown>>;
  if (typeof pluginVersion !== 'string' || typeof contentVersion !== 'string' || typeof sha256 !== 'string' || typeof text !== 'string') return null;
  if (!isRecord(signature) || typeof signature.kid !== 'string' || typeof signature.sig !== 'string') return null;
  const sig = { kid: signature.kid, sig: signature.sig };
  let manifest: ContentManifest;
  try {
    manifest = verifyContentManifest({ manifest: text, signature: sig }, ctx.keys);
  } catch (e) {
    if (e instanceof ContentVerificationError) return null;
    throw e;
  }
  if (sha256Hex(text) !== sha256) return null;
  if (manifest.pluginVersion !== ctx.pluginVersion || pluginVersion !== ctx.pluginVersion || contentVersion !== manifest.contentVersion) return null;
  const pin = ctx.pin;
  if (pin !== null) {
    if (manifest.counter < pin.counter) return null;
    if (manifest.contentVersion === pin.contentVersion && sha256 !== pin.manifestSha256) return null;
  }
  return { manifest, text, signature: sig };
}

/**
 * Step 4: the manifest request. `cached` is a usable cached set (its sha256 becomes `If-None-Match` when `useEtag`).
 * `store: false` verifies and returns the set without touching the cache (the refresh swaps it in itself).
 */
async function fetchManifest(ctx: Ctx, cached: CachedSet | null, useEtag: boolean, store = true): Promise<Step<CachedSet>> {
  const call = ctx.deps.api.getContentManifest;
  if (call === undefined) return { degrade: 'offline, grace' };
  const etag = useEtag && cached !== null ? cached.index.manifestSha256 : undefined;
  let answer;
  try {
    answer = await call.call(ctx.deps.api, ctx.pluginVersion, ctx.pin?.contentVersion ?? null, ctx.token, etag);
  } catch (e) {
    if (e instanceof ApiError && e.status === 0) return { degrade: 'offline, grace' };
    throw e;
  }
  if ('error' in answer) return failure(answer);
  if (!('body' in answer)) {
    // 304: only legitimate when we sent the validator for a set we hold.
    if (cached === null || etag === undefined) return { out: MISMATCH };
    await tryCache(() => storeManifestSet(ctx.home, { manifestText: cached.manifestText, signature: cached.signature, manifest: cached.manifest, fetchedAt: ctx.fetchedAt, expiresAt: ctx.expiresAt }));
    return { value: cached };
  }
  const verified = verifyEnvelope(ctx, answer.body);
  if (verified === null) return { out: MISMATCH };
  const index: ContentIndex | null = store
    ? await tryCache(() =>
        storeManifestSet(ctx.home, { manifestText: verified.text, signature: verified.signature, manifest: verified.manifest, fetchedAt: ctx.fetchedAt, expiresAt: ctx.expiresAt }),
      )
    : null;
  const set: CachedSet = {
    index: index ?? {
      schema: 1,
      pluginVersion: verified.manifest.pluginVersion,
      contentVersion: verified.manifest.contentVersion,
      manifestSha256: sha256Hex(verified.text),
      kid: verified.manifest.kid,
      fetchedAt: ctx.fetchedAt,
      expiresAt: ctx.expiresAt,
      items: {},
    },
    manifest: verified.manifest,
    manifestText: verified.text,
    signature: verified.signature,
  };
  return { value: set };
}

/** Step 6: offline, 429 or a 5xx inside grace. The cached set (re-verified at read) answers when it holds the object. */
async function serveFromCache(ctx: Ctx, set: CachedSet | null, reason: string, key: string | null): Promise<ContentOutcome> {
  if (set === null) return unavailable(reason);
  if (key === null) return okManifest(ctx, set);
  const entry = set.manifest.files[key];
  if (entry === undefined) return unavailable(reason);
  const body = await readCachedItem(ctx.home, set, key);
  return body === null ? unavailable(reason) : okItem(ctx, set, entry, body);
}

/** Step 5 for an item: the verified `set` names it; the bytes are checked against the manifest entry before anything is cached. */
async function fetchItem(ctx: Ctx, first: CachedSet, kind: ContentKind, name: string): Promise<ContentOutcome> {
  const call = ctx.deps.api.getContentItem;
  const key = `${kind}/${name}`;
  let set = first;
  let refetched = false;
  let withEtag = true;
  for (;;) {
    const entry = set.manifest.files[key];
    if (entry === undefined) return refused('not_found');
    if (call === undefined) return await serveFromCache(ctx, set, 'offline, grace', key);
    const held = withEtag ? await readCachedItem(ctx.home, set, key) : null;
    let answer;
    try {
      answer = await call.call(ctx.deps.api, ctx.pluginVersion, kind, name, set.manifest.contentVersion, ctx.token, held === null ? undefined : entry.sha256, entry.bytes);
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) return await serveFromCache(ctx, set, 'offline, grace', key);
      throw e;
    }
    if ('error' in answer) {
      const f = failure(answer);
      return 'out' in f ? f.out : await serveFromCache(ctx, set, f.degrade, key);
    }
    if (!('body' in answer)) {
      if (held === null) return MISMATCH; // a 304 for a validator we did not send
      const again = await readCachedItem(ctx.home, set, key); // section 5: a cached file is re-checked on every read
      if (again !== null) return okItem(ctx, set, entry, again);
      withEtag = false;
      continue;
    }
    if (answer.contentVersion !== set.manifest.contentVersion) {
      // a newer set answered: one manifest re-fetch without a validator, then the item once more
      if (refetched) return MISMATCH;
      refetched = true;
      const next = await fetchManifest(ctx, null, false);
      if (next.out !== undefined) return next.out;
      if (next.degrade !== undefined) return await serveFromCache(ctx, set, next.degrade, key);
      set = next.value;
      withEtag = true;
      continue;
    }
    const body = Buffer.from(answer.body);
    if (body.length !== entry.bytes || sha256Hex(body) !== entry.sha256) return MISMATCH; // nothing is cached
    await tryCache(() => storeItem(ctx.home, set, key, body, ctx.fetchedAt));
    return okItem(ctx, set, entry, body);
  }
}

function withinRefreshWindow(token: string, now: Date): boolean {
  const exp = tokenExpiry(token);
  return exp === null || exp.getTime() - now.getTime() <= REFRESH_WINDOW_MS;
}

/**
 * Section 4 step 3, shared by a call and the refresh: the Pro token (renewed through `refreshToken` when missing or inside the
 * refresh window), then grace. Past grace purges the cache (best effort) and answers `refused (past_grace)`, or `refused
 * (no_token)` when there is neither a token nor a known expiry; a live grace with no token is `refused (no_token)` too.
 */
async function resolveAccess(deps: ContentDeps, now: Date): Promise<{ token: string; grace: Grace; expiresAt: number } | { out: ContentOutcome }> {
  let token = await readToken(deps.paths);
  if (deps.refreshToken !== undefined && (token === null || withinRefreshWindow(token, now))) {
    try {
      token = (await deps.refreshToken()) ?? (await readToken(deps.paths));
    } catch {
      // a busy lock or an offline refresh keeps the disk token as it is
    }
  }
  const state = await readLocalState(deps.paths);
  const grace = computeGrace({ token, tokenExpiresAt: state.tokenExpiresAt, serverTime: state.serverTime, nowMs: now.getTime() });
  if (grace.pastGrace) {
    await tryCache(() => purgeContentCache(deps.paths.home));
    return { out: refused(token === null && grace.expiresAt === null ? 'no_token' : 'past_grace') };
  }
  if (token === null || grace.expiresAt === null) return { out: refused('no_token') };
  return { token, grace, expiresAt: grace.expiresAt };
}

/**
 * One phanos_content call (03_c9-wire-client.md section 4): validate, support range, token and grace, manifest, then the
 * item. `keys` default to the release-signing keys; tests pass throwaway keys.
 */
export async function loadContent(deps: ContentDeps, input: ContentInput, keys: TrustedKey[] = TRUSTED_RELEASE_KEYS): Promise<ContentOutcome> {
  const now = deps.now ?? (() => new Date());
  const isManifest = input.kind === 'manifest';

  // 1. input
  if (!isManifest && (!isContentKind(input.kind) || input.name === undefined || contentNameProblem(input.name) !== null)) return refused('bad_name');
  const resolved = await resolvePluginVersion(deps.paths, input.pluginVersion);
  if ('reason' in resolved) return refused(resolved.reason);
  const pluginVersion = resolved.version;

  // 2. the supported range, before any request
  if (!supportsPlugin(pluginVersion)) return refused(`mcp ${MCP_VERSION} does not support plugin ${pluginVersion}; run phanos_update`);

  // 3. token, then grace
  const home = deps.paths.home;
  const access = await resolveAccess(deps, now());
  if ('out' in access) return access.out;
  const { token } = access;

  const ctx: Ctx = {
    deps,
    home,
    pluginVersion,
    pin: await readPin(deps.paths, pluginVersion),
    token,
    keys,
    fetchedAt: Math.floor(now().getTime() / 1000),
    expiresAt: access.expiresAt,
  };

  // 4. the manifest
  const cached = usable(ctx, await readCachedSet(home, keys));
  const step = await fetchManifest(ctx, cached, true);
  if (step.out !== undefined) return step.out;
  if (step.degrade !== undefined) return await serveFromCache(ctx, cached, step.degrade, isManifest ? null : `${input.kind}/${input.name}`);
  const set = step.value;

  // 5. the answer
  if (isManifest) return okManifest(ctx, set);
  return await fetchItem(ctx, set, input.kind as ContentKind, input.name as string);
}

// ---- P-3: the refresh, the status lines and the reconcile ---------------------------------------------------------------

/**
 * `phanos_update { corpus: "refresh" }` (03_c9-wire-client.md section 8): resolve the Pro plugin version and pin, fetch the manifest
 * without If-None-Match, verify it as in section 4 step 4, then swap in a set that holds only that manifest (every cached item
 * goes). Answers the text of the tool: three lines on success, `skip (offline)` twice offline (nothing cleared), otherwise one
 * `result:` line. A verification failure or a refusal leaves the cache untouched; past grace purges it (section 5). A busy cache
 * lock clears nothing and answers `skip (busy)` twice (the sheet is silent here; the wording follows the offline form).
 */
export async function refreshContent(deps: ContentDeps, keys: TrustedKey[] = TRUSTED_RELEASE_KEYS): Promise<string> {
  const now = deps.now ?? (() => new Date());
  const resolved = await resolvePluginVersion(deps.paths, undefined);
  if ('reason' in resolved) return 'result: skip (no Pro plugin installed)';
  const pluginVersion = resolved.version;
  if (!supportsPlugin(pluginVersion)) return `result: ${refused(`mcp ${MCP_VERSION} does not support plugin ${pluginVersion}; run phanos_update`).result}`;

  const access = await resolveAccess(deps, now());
  if ('out' in access) return `result: ${access.out.result}`;

  const home = deps.paths.home;
  const ctx: Ctx = {
    deps,
    home,
    pluginVersion,
    pin: await readPin(deps.paths, pluginVersion),
    token: access.token,
    keys,
    fetchedAt: Math.floor(now().getTime() / 1000),
    expiresAt: access.expiresAt,
  };
  const step = await fetchManifest(ctx, null, false, false);
  if (step.out !== undefined) return `result: ${step.out.result}`;
  if (step.degrade !== undefined) {
    return step.degrade === 'offline, grace' ? 'content manifest: skip (offline)\nresult: skip (offline)' : `result: ${unavailable(step.degrade).result}`;
  }
  const { manifest, manifestText, signature } = step.value;
  let cleared = 0;
  try {
    await withCacheLock(home, async () => {
      cleared = Object.keys((await readContentIndex(home))?.items ?? {}).length;
      await purgeContentCache(home);
      await storeManifestSet(home, { manifestText, signature, manifest, fetchedAt: ctx.fetchedAt, expiresAt: ctx.expiresAt });
    });
  } catch (e) {
    if (e instanceof StateLockBusyError) return 'content cache: skip (busy)\nresult: skip (busy)';
    throw e;
  }
  return [`content cache: cleared (${cleared} items)`, `content manifest: ok (${manifest.contentVersion})`, `result: ok (content ${manifest.contentVersion})`].join('\n');
}

/**
 * The two `content:` lines of `phanos_status` (03_c9-wire-client.md section 9). `probe` makes the one manifest request (with
 * If-None-Match when the cache holds this plugin version) when a Pro token is on disk and the Pro tree has a C-1 file; without
 * it, or without either, `reachable` reads `unchecked`. Reads the cache index only, never writes it.
 */
export async function contentStatusLines(deps: ContentDeps, opts: { probe: boolean }): Promise<string[]> {
  const resolved = await resolvePluginVersion(deps.paths, undefined);
  const pluginVersion = 'version' in resolved ? resolved.version : null;
  const token = await readToken(deps.paths);
  const index = await readContentIndex(deps.paths.home);
  const pin = pluginVersion === null ? null : await readPin(deps.paths, pluginVersion);
  let reachable = 'unchecked';
  let served = 'none';
  if (opts.probe && pluginVersion !== null && token !== null) {
    const call = deps.api.getContentManifest;
    if (call === undefined) reachable = 'no';
    else {
      try {
        const etag = index !== null && index.pluginVersion === pluginVersion ? index.manifestSha256 : undefined;
        const answer = await call.call(deps.api, pluginVersion, pin?.contentVersion ?? null, token, etag);
        reachable = 'yes';
        if (!('error' in answer)) served = answer.contentVersion;
      } catch {
        reachable = 'no';
      }
    }
  }
  const items = index === null ? 0 : Object.keys(index.items).length;
  const expires = index === null ? 'none' : new Date(index.expiresAt * 1000).toISOString();
  return [
    `content: reachable ${reachable}, contentVersion ${served}, cacheItems ${items}, cacheExpires ${expires}`,
    `content: ${index?.contentVersion ?? 'none'} (pin ${pin?.contentVersion ?? 'none'})`,
  ];
}

/**
 * The reconcile of section 5 for the status pass and the start check: past grace (by the token on disk, state.tokenExpiresAt and the
 * server clock floor) deletes the whole cache. Returns whether it is past grace. With no cache folder nothing is written, the
 * lock file included. A busy cache lock throws StateLockBusyError and leaves the cache; the caller logs it.
 */
export async function reconcileContentCache(paths: Paths, now: Date): Promise<boolean> {
  const state = await readLocalState(paths);
  const input = { token: await readToken(paths), tokenExpiresAt: state.tokenExpiresAt, serverTime: state.serverTime, nowMs: now.getTime() };
  if (!existsSync(contentCachePaths(paths.home).dir)) return computeGrace(input).pastGrace;
  return await reconcileGrace(paths.home, input);
}
