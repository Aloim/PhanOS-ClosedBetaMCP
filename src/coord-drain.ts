// cyphor-role: CORE
// S5-2.05: Scaffolded by the orchestrator, run 20261025-st5 (plan documentation/plans/implementation-plans/2026-10-25_st5-server-boundary).
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './fsutil.js';
import type { CoordBatchAnswer, CoordBatchBody } from './session-api.js';
import { projectDirOf, readCoordinationMode, readInstallId, readSessionId, sessionKeyOf, stateRootOf } from './session-context.js';
import type { SessionRunContext } from './session-runtime.js';
import { readToken, StateLockBusyError, withFileLock } from './state.js';

type Role = 'off' | 'leader' | 'follower' | 'unreachable';

const TICK_MS = 15_000;
const VIEW_MS = 30_000;
const BATCH_MAX_RECORDS = 500;
const BATCH_MAX_BYTES = 512 * 1024;
const ROOT_ID = /^[0-9a-f]{32}$/;

interface OutboxLine {
  seq: number;
  raw: string;
  record: unknown;
}

interface DrainState {
  drainedSeq: number;
  rootId: string;
  resync?: boolean;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Complete outbox lines in file order. A last line with no line break is torn and waits; CR is stripped; non-JSON lines are skipped. */
function parseOutbox(text: string): OutboxLine[] {
  const parts = text.split('\n');
  parts.pop();
  const lines: OutboxLine[] = [];
  for (const part of parts) {
    const raw = part.endsWith('\r') ? part.slice(0, -1) : part;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    const seq = (record as { seq?: unknown } | null)?.seq;
    if (typeof seq === 'number' && Number.isInteger(seq)) lines.push({ seq, raw, record });
  }
  return lines;
}

async function readOutbox(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/** Reads drain.json; a missing or malformed file starts at drainedSeq 0, and a root id is created once (F-16966). */
async function loadDrain(file: string): Promise<{ state: DrainState; created: boolean }> {
  let parsed: Partial<DrainState> | null = null;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<DrainState> | null;
  } catch {
    parsed = null;
  }
  const storedRoot = parsed?.rootId;
  const rootId = typeof storedRoot === 'string' && ROOT_ID.test(storedRoot) ? storedRoot : randomBytes(16).toString('hex');
  const stored = parsed?.drainedSeq;
  const drainedSeq = typeof stored === 'number' && Number.isInteger(stored) && stored >= 0 ? stored : 0;
  return { state: { drainedSeq, rootId }, created: rootId !== storedRoot };
}

async function writeDrain(file: string, state: DrainState): Promise<void> {
  const body: DrainState = { drainedSeq: state.drainedSeq, rootId: state.rootId };
  if (state.resync === true) body.resync = true;
  await writeFileAtomic(file, `${JSON.stringify(body)}\n`);
}

/**
 * The coordination drain. A tick takes the leader lock without waiting: the holder posts the outbox in
 * batches and refreshes view.json; everyone else is a follower. A thrown network error marks the drain
 * unreachable and keeps every record (drainedSeq is written only after a 200 answer, or a 400 answer that refuses the batch for good).
 */
export function startCoordDrain(ctx: SessionRunContext): { stop(): Promise<void>; role(): 'off' | 'leader' | 'follower' | 'unreachable' } {
  let role: Role = 'off';
  let stopped = false;
  let handle: unknown = null;
  let running: Promise<void> = Promise.resolve();
  let coord = '';
  let lockFile = '';
  let token = '';
  let installId = '';
  let lastViewMs: number | null = null;
  const nowMs = (): number => ctx.now().getTime();

  async function leaderLoop(): Promise<void> {
    const entitlement = await readToken(ctx.paths);
    if (entitlement === null) return;
    token = entitlement;
    role = 'leader';
    const drainFile = path.join(coord, 'drain.json');
    const loaded = await loadDrain(drainFile);
    let drain = loaded.state;
    if (loaded.created) await writeDrain(drainFile, drain);
    const unsent = parseOutbox(await readOutbox(path.join(coord, 'outbox.jsonl'))).filter((line) => line.seq > drain.drainedSeq);
    const sessionKey = sessionKeyOf(readSessionId(ctx.env) ?? '');
    let from = drain.drainedSeq + 1;
    let replayed = false;
    for (;;) {
      const batch: OutboxLine[] = [];
      let bytes = 0;
      for (const line of unsent) {
        if (line.seq < from) continue;
        const size = Buffer.byteLength(line.raw, 'utf8');
        if (batch.length >= BATCH_MAX_RECORDS || (batch.length > 0 && bytes + size > BATCH_MAX_BYTES)) break;
        batch.push(line);
        bytes += size;
      }
      if (batch.length === 0) break;

      const body: CoordBatchBody = {
        rootId: drain.rootId,
        fromSeq: batch[0]!.seq,
        sessionKey,
        records: batch.map((line) => line.record),
      };
      let answer: CoordBatchAnswer;
      try {
        answer = await ctx.api.coordBatch(token, installId, body);
      } catch {
        role = 'unreachable';
        return;
      }

      if ('lastSeq' in answer) {
        if (answer.lastSeq <= drain.drainedSeq) break;
        drain = { drainedSeq: answer.lastSeq, rootId: drain.rootId, resync: answer.resync };
        await writeDrain(drainFile, drain);
        from = answer.lastSeq + 1;
        continue;
      }

      if ('expectedSeq' in answer) {
        if (unsent.some((line) => line.seq === answer.expectedSeq)) {
          if (!replayed) {
            replayed = true;
            from = answer.expectedSeq;
            continue;
          }
          ctx.log(`coordination drain: the server again expects seq ${answer.expectedSeq}; the batch is kept for the next tick`);
          return;
        }
        drain = { drainedSeq: answer.expectedSeq - 1, rootId: drain.rootId };
        await writeDrain(drainFile, drain);
        ctx.log(`coordination drain: the server expects seq ${answer.expectedSeq}, which the outbox does not hold; drainedSeq set to ${drain.drainedSeq}`);
        return;
      }

      if (answer.status === 400) {
        drain = { drainedSeq: batch[batch.length - 1]!.seq, rootId: drain.rootId };
        await writeDrain(drainFile, drain);
        ctx.log('coordination drain: batch refused (400), skipped');
        from = drain.drainedSeq + 1;
        continue;
      }

      ctx.log(`coordination drain: the server answered ${answer.status} (${answer.error}); the batch is kept for the next tick`);
      return;
    }

    if (lastViewMs !== null && nowMs() - lastViewMs < VIEW_MS) return;
    const viewToken = await readToken(ctx.paths);
    if (viewToken === null) return;
    try {
      const view = await ctx.api.coordView(viewToken, installId, drain.rootId);
      await writeFileAtomic(
        path.join(coord, 'view.json'),
        `${JSON.stringify({ schema: 1, at: ctx.now().toISOString(), records: view.records, ids: view.ids })}\n`,
      );
      lastViewMs = nowMs();
    } catch (err) {
      ctx.log(`coordination view: ${errorText(err)}`);
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      await mkdir(coord, { recursive: true });
      await withFileLock(lockFile, leaderLoop, { waitMs: 0, now: nowMs });
    } catch (err) {
      if (err instanceof StateLockBusyError) {
        if (token !== '') role = 'follower';
      } else ctx.log(`coordination drain: ${errorText(err)}`);
    }
    schedule();
  }

  function schedule(): void {
    if (stopped) return;
    handle = ctx.timers.setTimeout(() => {
      handle = null;
      running = tick();
    }, TICK_MS);
  }

  /** The gate, read at start: coordination mode on and a valid install id. The token may arrive later; every tick re-reads it from disk, and the role stays 'off' until one exists. */
  async function open(): Promise<void> {
    const projectDir = projectDirOf(ctx.env);
    if (projectDir === null || !readCoordinationMode(projectDir)) return;
    const id = readInstallId(projectDir);
    if (id === null) return;
    const entitlement = await readToken(ctx.paths);
    installId = id;
    token = entitlement ?? '';
    coord = path.join(stateRootOf(projectDir), '.cyphor', 'state', 'coord');
    lockFile = path.join(coord, 'leader.lock');
    if (entitlement !== null) role = 'follower';
    await tick();
  }

  running = open().catch((err: unknown) => {
    ctx.log(`coordination drain: ${errorText(err)}`);
  });

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (handle !== null) ctx.timers.clearTimeout(handle);
      handle = null;
      await running;
    },
    role: () => role,
  };
}
