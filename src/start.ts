// cyphor-role: CORE

export interface StartMcpOptions<T> {
  /** Starts listening (for stdio: `serveStdio(...)`). Called first, before any network call. */
  serve: () => T;
  /** The start check (`svc.startCheck()`): account read, flip, token renewal. May hang or fail. */
  startCheck: () => Promise<void>;
  /** Hands the check to a later turn of the event loop, so the handshake is never queued behind it. */
  defer?: (fn: () => void) => unknown;
  /** Failure sink (stderr in production). */
  log: (message: string) => void;
}

/**
 * C1 section 4 rule 6: never block the MCP handshake on a network call. Serves first, then defers the start check; a
 * failing check is logged, never thrown, and never awaited here. Returns whatever `serve` returned.
 */
export function startMcp<T>({ serve, startCheck, defer = setImmediate, log }: StartMcpOptions<T>): T {
  const served = serve();
  defer(() => {
    Promise.resolve()
      .then(startCheck)
      .catch((e: unknown) => log(`start check failed: ${e instanceof Error ? e.message : String(e)}`));
  });
  return served;
}
