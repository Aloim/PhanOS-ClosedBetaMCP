// cyphor-role: GLUE
// The installer library the PhanOS-UI bundles (dist/installer-lib.mjs, see scripts/bundle-installer-lib.mjs).
// It imports no MCP SDK. The keyring package (@napi-rs/keyring) loads lazily inside the secrets module and stays external to the bundle.
import { hostname as osHostname, homedir as osHomedir } from 'node:os';
import { createPhanosService, SHORTCUT_QUESTION, type ServiceDeps } from './service.js';
import { nextSessionLine } from './flip.js';
import { readLocalState } from './state.js';
import { HttpApi, type Api } from './api.js';
import { createClaudeRunner, createCommandRunner } from './claude-cli.js';
import { API_BASE, resolvePaths, type Paths } from './config.js';
import { createSecretStore, type KeyringEntry, type SecretStore } from './secrets.js';
import { TRUSTED_RELEASE_KEYS } from './trusted-keys.js';
import type { LoginDeps } from './device-login.js';

export { startDeviceLogin, DeviceLoginError, type LoginDeps } from './device-login.js';
export { registerMcp, McpAddError, MCP_ADD_COMMAND, MCP_ADD_ARGS, MCP_TAG, type ClaudeRunner } from './claude-cli.js';
export { adoptUi, isNewerVersion, UI_ENTRY_BY_PLATFORM } from './ui.js';
export { STATE_SCHEMA, StateSchemaNewerError } from './state.js';
export type { Paths } from './config.js';
export type { ServiceDeps } from './service.js';

/**
 * The install answer's lines written for Claude inside a session (the shortcut instruction and the next-session line);
 * a UI shows its own shortcut question, so these are not forwarded. Built from the same exports terminal.ts uses.
 */
const MODEL_ONLY_LINES = new Set<string>([SHORTCUT_QUESTION, nextSessionLine('pro'), nextSessionLine('basic')]);

/** Runs the first install pass, hands each answer line to `onProgress` in order, then reports the edition on disk. */
export async function installEditions(
  opts: ServiceDeps & { force?: boolean; service?: { install(o?: { force?: boolean }): Promise<string> } },
  onProgress: (line: string) => void,
): Promise<{ edition: 'pro' | 'basic' }> {
  const service = opts.service ?? createPhanosService(opts);
  const text = await service.install({ force: opts.force === true });
  for (const line of text.split(/\r?\n/)) {
    if (line !== '' && !MODEL_ONLY_LINES.has(line.trimEnd())) onProgress(line);
  }
  const state = await readLocalState(opts.paths);
  return { edition: state.enabled === 'pro' ? 'pro' : 'basic' };
}

export interface InstallerContextOptions {
  apiBase?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
  hostname?: string;
  keyringFactory?: (service: string, account: string) => KeyringEntry;
  log?: (msg: string) => void;
  // test seams
  api?: Api;
  secrets?: SecretStore;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface InstallerContext {
  loginDeps: LoginDeps;
  serviceDeps: ServiceDeps;
  paths: Paths;
  /** 'keyring' or 'file': where the sign-in session is stored. 'file' means @napi-rs/keyring did not load; the MCP server process may then read a different store. */
  secretsKind: SecretStore['kind'];
}

/**
 * Builds the login and service deps the way the terminal installer does (index.ts): one API client and one secret store,
 * shared by both deps.
 */
export async function createInstallerContext(opts: InstallerContextOptions = {}): Promise<InstallerContext> {
  const apiBase = opts.apiBase ?? API_BASE;
  const paths = resolvePaths(opts.env ?? process.env, opts.homedir ?? osHomedir());
  const raw = opts.platform ?? process.platform;
  const platform = (['win32', 'darwin', 'linux'].includes(raw) ? raw : 'linux') as 'win32' | 'darwin' | 'linux';
  const hostname = opts.hostname ?? osHostname();
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const api = opts.api ?? new HttpApi(apiBase);
  const secrets = opts.secrets ?? (await createSecretStore({ paths, apiBase, keyringFactory: opts.keyringFactory }));
  const serviceDeps: ServiceDeps = {
    api,
    secrets,
    paths,
    trustedKeys: TRUSTED_RELEASE_KEYS,
    runClaude: createClaudeRunner(platform),
    commandRunner: createCommandRunner,
    now,
    sleep,
    hostname,
    platform,
    apiBase,
    log: opts.log ?? (() => {}),
  };
  const loginDeps: LoginDeps = { api, secrets, paths, now, sleep, hostname, platform };
  return { loginDeps, serviceDeps, paths, secretsKind: secrets.kind };
}
