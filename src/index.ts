#!/usr/bin/env node
// cyphor-role: GLUE
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { HttpApi } from './api.js';
import { createClaudeRunner, createCommandRunner, manualInstallCommands } from './claude-cli.js';
import { API_BASE, PLUGIN_IDS, resolvePaths } from './config.js';
import { purgeContentCache } from './content-cache.js';
import { startDeviceLogin } from './device-login.js';
import { blockerLine, checkPrerequisites } from './prereqs.js';
import { createSecretStore } from './secrets.js';
import { buildServer } from './server.js';
import { createPhanosService } from './service.js';
import { HttpSessionApi } from './session-api.js';
import { startSessionRuntime, type SessionRuntimeHandle } from './session-runtime.js';
import { parseInstallArgs, startMcp } from './start.js';
import { runTerminalInstall, type TerminalDeps } from './terminal.js';
import { TRUSTED_RELEASE_KEYS } from './trusted-keys.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
const paths = resolvePaths();
// C1 section 18 item 6: `--feedback-only` serves phanos_feedback alone, runs no start check and writes nothing.
const feedbackOnly = process.argv.includes('--feedback-only');
const platform = (['win32', 'darwin', 'linux'].includes(process.platform) ? process.platform : 'linux') as 'win32' | 'darwin' | 'linux';
// IN-2: `install` runs the terminal installer in place of the MCP server; the flags are read here, once.
const installArgs = parseInstallArgs(process.argv);
const installMode = installArgs.install;

// S5-2.07: the service is created before the session runtime, so the status line reads the drain role through this late-bound handle.
let runtime: SessionRuntimeHandle | null = null;

// One API client and one secret store, shared by the service and the terminal login.
const api = new HttpApi(API_BASE);
const secrets = await createSecretStore({ paths, apiBase: API_BASE });

const svc = createPhanosService({
  api,
  secrets,
  paths,
  trustedKeys: TRUSTED_RELEASE_KEYS,
  runClaude: createClaudeRunner(),
  commandRunner: createCommandRunner,
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  hostname: hostname(),
  platform,
  apiBase: API_BASE,
  ...(feedbackOnly || installMode ? {} : { launchRecord: { entry: fileURLToPath(import.meta.url), node: process.execPath, version } }),
  coordRole: () => runtime?.coordRole(),
  log: (m) => console.error(`[phanos] ${m}`),
});

if (installMode) {
  // IN-2: the terminal installer runs in the foreground; no MCP server, no session runtime.
  const deps: TerminalDeps = {
    checkPrerequisites: async () => {
      const pre = await checkPrerequisites({ run: createCommandRunner, platform });
      // TerminalDeps takes blocking as strings; blocking is empty by plan (F-9529), so each blocker is named with its reason by blockerLine.
      return { ...pre, blocking: pre.blocking.map(blockerLine) };
    },
    login: () =>
      startDeviceLogin({ api, secrets, paths, now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), hostname: hostname(), platform }),
    install: () => svc.install(),
    run: createClaudeRunner(),
    manualCommands: () => (['pro', 'basic'] as const).flatMap((e) => manualInstallCommands(paths.marketplace[e].dir, PLUGIN_IDS[e])),
    createShortcut: () => svc.ui({ shortcut: 'create' }),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(question);
        return ['y', 'yes'].includes(answer.trim().toLowerCase());
      } finally {
        rl.close();
      }
    },
    print: (line) => console.log(line),
    isTTY: Boolean(process.stdout.isTTY && process.stdin.isTTY),
    flags: { yesShortcut: installArgs.yesShortcut, noShortcut: installArgs.noShortcut },
  };
  process.exit(await runTerminalInstall(deps));
} else {
  startMcp({
    serve: () => serveStdio(() => buildServer(svc, version, feedbackOnly ? { only: ['phanos_feedback'] } : {})),
    startCheck: feedbackOnly ? async () => undefined : () => svc.startCheck(),
    log: (m) => console.error(`[phanos] ${m}`),
  });
}

// S5-2.02: the session runtime (started marker, set, beat, drain, close) never starts in `--feedback-only` mode.
if (!feedbackOnly && !installMode) {
  runtime = startSessionRuntime({
    paths,
    api: new HttpSessionApi(API_BASE),
    content: svc.contentDeps(),
    env: process.env,
    now: () => new Date(),
    timers: { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
    log: (m) => console.error(`[phanos] ${m}`),
    stdin: process.stdin,
    purgeCache: purgeContentCache,
  });
}
