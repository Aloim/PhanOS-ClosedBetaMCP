import { BEAT_INTERVAL_S, beatOnce, writeStartedMarker } from './session-beat.js';
import { closeSession } from './session-close.js';
import { startCoordDrain } from './coord-drain.js';
import { materializeSessionSet } from './session-set.js';
/**
 * Starts the session runtime after the MCP handshake: the started marker, one set materialization, the first beat, the
 * coordination drain, then a beat every `intervalS` seconds (600 when the server names none). The set is materialized again
 * after each ok beat, never after a failed or skipped one. Returns at once; the chain runs in the background and every error
 * is logged as one line with no message text. On end of input the timers and the drain stop and `closeSession` runs once.
 */
export function startSessionRuntime(ctx) {
    let stopped = false;
    let closed = false;
    let timer = null;
    let drain = null;
    const schedule = (seconds) => {
        if (stopped)
            return;
        const handle = ctx.timers.setTimeout(() => {
            timer = null;
            void beat();
        }, seconds * 1000);
        if (typeof handle === 'object' && handle !== null && typeof handle.unref === 'function') {
            handle.unref();
        }
        timer = handle;
    };
    const beat = async () => {
        if (stopped)
            return;
        try {
            const result = await beatOnce(ctx);
            if (result.status === 'ok')
                await materializeSessionSet(ctx);
            schedule(result.intervalS ?? BEAT_INTERVAL_S);
        }
        catch {
            ctx.log('session beat: error');
            schedule(BEAT_INTERVAL_S);
        }
    };
    const run = async () => {
        try {
            await writeStartedMarker(ctx);
        }
        catch {
            ctx.log('session marker: error');
        }
        try {
            await materializeSessionSet(ctx);
        }
        catch {
            ctx.log('session set: error');
        }
        const first = beat();
        drain = startCoordDrain(ctx);
        if (stopped)
            await drain.stop();
        await first;
    };
    ctx.stdin.once('end', () => {
        if (closed)
            return;
        closed = true;
        stopped = true;
        if (timer !== null)
            ctx.timers.clearTimeout(timer);
        timer = null;
        void (async () => {
            try {
                if (drain !== null)
                    await drain.stop();
            }
            catch {
                ctx.log('session drain stop: error');
            }
            try {
                await closeSession(ctx);
            }
            catch {
                ctx.log('session close: error');
            }
        })();
    });
    void run();
    return {
        coordRole: () => drain?.role(),
        async stop() {
            stopped = true;
            if (timer !== null)
                ctx.timers.clearTimeout(timer);
            timer = null;
            if (drain !== null)
                await drain.stop();
        },
    };
}
