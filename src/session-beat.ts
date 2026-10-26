// cyphor-role: CORE
// S5-2.02: Scaffolded by the orchestrator, run 20261025-st5 (plan documentation/plans/implementation-plans/2026-10-25_st5-server-boundary).
// The session beat (contract §4 route, §8 files, §10 cadence and leash): one POST per beat, the beat file after every
// attempt, the started marker at start, and the content-cache leash. Readers: PhanOS session-reaper.js, session-end.js,
// session-set.js and mcp-check.js (field use checked by tests/session-beat.test.ts).
//
// Consecutive-failure state is module-level: one MCP process runs one session runtime, so the count and the
// once-per-streak purge flag live here. resetBeatState() clears them (tests only). A successful beat ends the streak.

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PLUGIN_VERSION_RE } from './content-manifest.js';
import type { BeatAnswer } from './session-api.js';
import { beatFile, projectDirOf, readInstallId, readSessionId, readSessionTree, sessionKeyOf, startedFile } from './session-context.js';
import type { SessionRunContext } from './session-runtime.js';
import { readLocalState, readToken } from './state.js';
import { MCP_VERSION } from './version.js';

/** The beat interval when the server does not name one (contract §10). */
export const BEAT_INTERVAL_S = 600;
/** A beat is fresh when its lastOkAt is within this window (contract §8; the PhanOS readers' FRESH_MS). */
const FRESH_MS = 20 * 60 * 1000;
/** Two consecutive missed beats arm the leash (contract §10). */
const LEASH_MISSES = 2;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export type BeatStatus = 'ok' | 'failed' | 'skip';

export interface BeatResult {
  status: BeatStatus;
  /** `ok`, `failed (beat request)`, or `skip (<reason>)`. */
  text: string;
  /** The server's intervalS on ok (600 when the server names none); null on skip and on failure. */
  intervalS: number | null;
}

export type StartedResult = 'written' | 'skip (no session id)';

let missedBeats = 0;
let purgedThisStreak = false;

/** Clears the consecutive-failure count and the streak's purge flag. For tests only. */
export function resetBeatState(): void {
  missedBeats = 0;
  purgedThisStreak = false;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The session id, or null when absent or not a plain file-name segment (it names the beat and marker files). */
function sessionIdOf(env: NodeJS.ProcessEnv): string | null {
  const id = readSessionId(env);
  return id !== null && SAFE_ID.test(id) ? id : null;
}

/** `Phanes/edition-id.json` of the installed Pro tree when it is a Pro edition with a plugin version, else null (C-1, as content.ts reads it). */
async function installedProVersion(pluginDir: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(pluginDir, 'Phanes', 'edition-id.json'), 'utf8')) as unknown;
    if (!isRecord(raw) || raw.edition !== 'pro' || typeof raw.version !== 'string') return null;
    return PLUGIN_VERSION_RE.test(raw.version) ? raw.version : null;
  } catch {
    return null;
  }
}

/** The previous beat file's lastOkAt and intervalS, both null when the file is absent or unreadable. */
async function readPreviousBeat(file: string): Promise<{ lastOkAt: string | null; intervalS: number | null }> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (!isRecord(raw)) return { lastOkAt: null, intervalS: null };
    return {
      lastOkAt: typeof raw.lastOkAt === 'string' ? raw.lastOkAt : null,
      intervalS: typeof raw.intervalS === 'number' && Number.isFinite(raw.intervalS) ? raw.intervalS : null,
    };
  } catch {
    return { lastOkAt: null, intervalS: null };
  }
}

/** Writes the JSON through a temp file and a rename, so a reader never sees a half-written file. The temp name ends in .tmp, which no reader lists. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`, 'utf8');
  await rename(tmp, file);
}

/** True when any beat file in the folder has a lastOkAt within the fresh window. */
async function anyFreshBeat(home: string, nowMs: number): Promise<boolean> {
  const dir = path.join(home, 'session-set', 'beats');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as unknown;
      const t = isRecord(raw) && typeof raw.lastOkAt === 'string' ? Date.parse(raw.lastOkAt) : NaN;
      if (Number.isFinite(t) && nowMs - t < FRESH_MS) return true;
    } catch {
      // An unreadable beat is not fresh.
    }
  }
  return false;
}

/**
 * The leash (contract §10): after two consecutive missed beats, when the installed tree is a session-set tree and no
 * beat in the folder is fresh, the content cache is purged once for the streak.
 */
async function leash(ctx: SessionRunContext): Promise<void> {
  if (missedBeats < LEASH_MISSES || purgedThisStreak) return;
  if (!readSessionTree(ctx.paths).sessionSet) return;
  if (await anyFreshBeat(ctx.paths.home, ctx.now().getTime())) return;
  purgedThisStreak = true;
  try {
    await ctx.purgeCache(ctx.paths.home);
    ctx.log('beat: content cache purged');
  } catch {
    ctx.log('beat: content cache purge failed');
  }
}

/**
 * One beat (contract §4, §8, §10). Skips without a request and without a file when the session id, the install id, the
 * device id or the Pro token is absent. Otherwise posts the beat and writes the beat file after the attempt, whatever
 * its outcome: on success lastOkAt is the attempt's time and intervalS the server's; on failure lastOkAt and intervalS
 * are kept from the previous file (600 when there was none) and `at` is the attempt's time.
 */
export async function beatOnce(ctx: SessionRunContext): Promise<BeatResult> {
  const skip = (reason: string): BeatResult => ({ status: 'skip', text: `skip (${reason})`, intervalS: null });

  const sessionId = sessionIdOf(ctx.env);
  if (sessionId === null) return skip('no session id');
  const projectDir = projectDirOf(ctx.env);
  const installId = projectDir === null ? null : readInstallId(projectDir);
  if (installId === null) return skip('no install id');
  const token = await readToken(ctx.paths);
  if (token === null) return skip('no Pro token');
  const deviceId = (await readLocalState(ctx.paths)).deviceId;
  if (typeof deviceId !== 'string' || deviceId.length === 0) return skip('no device id');

  const body = {
    deviceId,
    installId,
    sessionKey: sessionKeyOf(sessionId),
    pluginVersion: await installedProVersion(ctx.paths.marketplace.pro.pluginDir),
  };
  const file = beatFile(ctx.paths.home, sessionId);
  const at = ctx.now().toISOString();

  let answer: BeatAnswer | null;
  try {
    answer = await ctx.api.beat(token, body);
  } catch {
    answer = null;
  }

  if (answer !== null) {
    const intervalS = Number.isFinite(answer.intervalS) && answer.intervalS > 0 ? answer.intervalS : BEAT_INTERVAL_S;
    missedBeats = 0;
    purgedThisStreak = false;
    await writeJsonAtomic(file, { pid: process.pid, at, lastOkAt: at, intervalS });
    ctx.log('beat: ok');
    return { status: 'ok', text: 'ok', intervalS };
  }

  missedBeats += 1;
  const previous = await readPreviousBeat(file);
  await writeJsonAtomic(file, {
    pid: process.pid,
    at,
    lastOkAt: previous.lastOkAt,
    intervalS: previous.intervalS ?? BEAT_INTERVAL_S,
  });
  await leash(ctx);
  ctx.log('beat: failed');
  return { status: 'failed', text: 'failed (beat request)', intervalS: null };
}

/** The started marker (contract §8): {pid, at, version}, written once at start. */
export async function writeStartedMarker(ctx: SessionRunContext): Promise<StartedResult> {
  const sessionId = sessionIdOf(ctx.env);
  if (sessionId === null) return 'skip (no session id)';
  await writeJsonAtomic(startedFile(ctx.paths.home, sessionId), {
    pid: process.pid,
    at: ctx.now().toISOString(),
    version: MCP_VERSION,
  });
  return 'written';
}
