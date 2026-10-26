// cyphor-role: GLUE
// S5-2.02: Scaffolded by the orchestrator, run 20261025-st5 (plan documentation/plans/implementation-plans/2026-10-25_st5-server-boundary).
import type { Paths } from './config.js';
import type { ContentDeps } from './content.js';
import { BEAT_INTERVAL_S, beatOnce, writeStartedMarker } from './session-beat.js';
import type { SessionApi } from './session-api.js';
import { closeSession } from './session-close.js';
import { startCoordDrain } from './coord-drain.js';
import { materializeSessionSet } from './session-set.js';

/** The timers the runtime schedules its beat with; production passes the global ones. */
export interface SessionTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The event source the runtime watches for the session's end; production passes `process.stdin`. */
export interface SessionStdin {
  once(event: 'end', callback: () => void): unknown;
}

/**
 * Everything the session runtime and its beat read or write, injected so tests run on temp folders, fake clocks
 * and fake timers. Production wiring (the next slice) passes `resolvePaths(process.env)`, the real `HttpSessionApi`,
 * the content deps, `process.env`, `() => new Date()`, the global timers, a stderr logger, `process.stdin` and
 * `purgeContentCache`.
 */
export interface SessionRunContext {
  paths: Paths;
  api: SessionApi;
  content: ContentDeps;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  timers: SessionTimers;
  log: (line: string) => void;
  stdin: SessionStdin;
  /** The content cache purge the beat's leash calls (production: `purgeContentCache` from content-cache.ts). */
  purgeCache: (home: string) => Promise<void>;
}

/** What `startSessionRuntime` hands back: `stop()` ends the beat timer and the coordination drain. */
export interface SessionRuntimeHandle {
  stop(): Promise<void>;
  /** The live coordination drain role; `undefined` until the drain has started (the status line then falls back). */
  coordRole(): 'off' | 'leader' | 'follower' | 'unreachable' | undefined;
}

/**
 * Starts the session runtime after the MCP handshake: the started marker, one set materialization, the first beat, the
 * coordination drain, then a beat every `intervalS` seconds (600 when the server names none). The set is materialized again
 * after each ok beat, never after a failed or skipped one. Returns at once; the chain runs in the background and every error
 * is logged as one line with no message text. On end of input the timers and the drain stop and `closeSession` runs once.
 */
export function startSessionRuntime(ctx: SessionRunContext): SessionRuntimeHandle {
  let stopped = false;
  let closed = false;
  let timer: unknown = null;
  let drain: ReturnType<typeof startCoordDrain> | null = null;

  const schedule = (seconds: number): void => {
    if (stopped) return;
    const handle = ctx.timers.setTimeout(() => {
      timer = null;
      void beat();
    }, seconds * 1000);
    if (typeof handle === 'object' && handle !== null && typeof (handle as { unref?: unknown }).unref === 'function') {
      (handle as { unref: () => void }).unref();
    }
    timer = handle;
  };

  const beat = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await beatOnce(ctx);
      if (result.status === 'ok') await materializeSessionSet(ctx);
      schedule(result.intervalS ?? BEAT_INTERVAL_S);
    } catch {
      ctx.log('session beat: error');
      schedule(BEAT_INTERVAL_S);
    }
  };

  const run = async (): Promise<void> => {
    try {
      await writeStartedMarker(ctx);
    } catch {
      ctx.log('session marker: error');
    }
    try {
      await materializeSessionSet(ctx);
    } catch {
      ctx.log('session set: error');
    }
    const first = beat();
    drain = startCoordDrain(ctx);
    if (stopped) await drain.stop();
    await first;
  };

  ctx.stdin.once('end', () => {
    if (closed) return;
    closed = true;
    stopped = true;
    if (timer !== null) ctx.timers.clearTimeout(timer);
    timer = null;
    void (async () => {
      try {
        if (drain !== null) await drain.stop();
      } catch {
        ctx.log('session drain stop: error');
      }
      try {
        await closeSession(ctx);
      } catch {
        ctx.log('session close: error');
      }
    })();
  });

  void run();

  return {
    coordRole: () => drain?.role(),
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== null) ctx.timers.clearTimeout(timer);
      timer = null;
      if (drain !== null) await drain.stop();
    },
  };
}
