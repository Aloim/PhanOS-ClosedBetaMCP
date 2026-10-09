// cyphor-role: CORE
/**
 * C1 section 4 rule 6: never block the MCP handshake on a network call. Serves first, then defers the start check; a
 * failing check is logged, never thrown, and never awaited here. Returns whatever `serve` returned.
 */
export function startMcp({ serve, startCheck, defer = setImmediate, log }) {
    const served = serve();
    defer(() => {
        Promise.resolve()
            .then(startCheck)
            .catch((e) => log(`start check failed: ${e instanceof Error ? e.message : String(e)}`));
    });
    return served;
}
