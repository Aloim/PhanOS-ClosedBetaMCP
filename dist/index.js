#!/usr/bin/env node
// cyphor-role: GLUE
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { HttpApi } from './api.js';
import { createClaudeRunner, createCommandRunner } from './claude-cli.js';
import { API_BASE, resolvePaths } from './config.js';
import { purgeContentCache } from './content-cache.js';
import { createSecretStore } from './secrets.js';
import { buildServer } from './server.js';
import { createPhanosService } from './service.js';
import { HttpSessionApi } from './session-api.js';
import { startSessionRuntime } from './session-runtime.js';
import { startMcp } from './start.js';
import { TRUSTED_RELEASE_KEYS } from './trusted-keys.js';
const { version } = createRequire(import.meta.url)('../package.json');
const paths = resolvePaths();
// C1 section 18 item 6: `--feedback-only` serves phanos_feedback alone, runs no start check and writes nothing.
const feedbackOnly = process.argv.includes('--feedback-only');
const platform = (['win32', 'darwin', 'linux'].includes(process.platform) ? process.platform : 'linux');
// S5-2.07: the service is created before the session runtime, so the status line reads the drain role through this late-bound handle.
let runtime = null;
const svc = createPhanosService({
    api: new HttpApi(API_BASE),
    secrets: await createSecretStore({ paths, apiBase: API_BASE }),
    paths,
    trustedKeys: TRUSTED_RELEASE_KEYS,
    runClaude: createClaudeRunner(),
    commandRunner: createCommandRunner,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    hostname: hostname(),
    platform,
    apiBase: API_BASE,
    ...(feedbackOnly ? {} : { launchRecord: { entry: fileURLToPath(import.meta.url), node: process.execPath, version } }),
    coordRole: () => runtime?.coordRole(),
    log: (m) => console.error(`[phanos] ${m}`),
});
startMcp({
    serve: () => serveStdio(() => buildServer(svc, version, feedbackOnly ? { only: ['phanos_feedback'] } : {})),
    startCheck: feedbackOnly ? async () => undefined : () => svc.startCheck(),
    log: (m) => console.error(`[phanos] ${m}`),
});
// S5-2.02: the session runtime (started marker, set, beat, drain, close) never starts in `--feedback-only` mode.
if (!feedbackOnly) {
    runtime = startSessionRuntime({
        paths,
        api: new HttpSessionApi(API_BASE),
        content: svc.contentDeps(),
        env: process.env,
        now: () => new Date(),
        timers: { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (h) => clearTimeout(h) },
        log: (m) => console.error(`[phanos] ${m}`),
        stdin: process.stdin,
        purgeCache: purgeContentCache,
    });
}
