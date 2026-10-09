// cyphor-role: CORE
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNT_STATES, ApiError, readAccount, type AccountRead, type Api, type Me } from './api.js';
import { listPlugins, manualCommand, manualInstallCommands, type ClaudeRunner } from './claude-cli.js';
import { PLUGIN_IDS, toWire, type LocalEdition, type Paths } from './config.js';
import { sendFeedback } from './feedback.js';
import { parseFilesList } from './files-list.js';
import { executeInstallRegistration, nextSessionLine, reconcileEditions, treesOnDisk, type FlipResult } from './flip.js';
import { checkLiveTree, FilesInUseError, installPluginTree, LocalChangesError, UncheckableTreeError } from './install.js';
import { checkPrerequisites, type CommandRunnerFactory } from './prereqs.js';
import { ACCEPT_SCHEMA_1, checkArchive, ReleaseVerificationError, verifyRelease, type ReleaseEnv, type VerifiedRelease } from './release.js';
import type { SecretStore } from './secrets.js';
import { mergeClaudeEnv } from './settings.js';
import { createExecRunner, createShortcut, removeShortcut, type CommandRunner } from './shortcut.js';
import { deleteToken, readLocalState, readToken, recordLaunch, tokenExpiry, writeLocalState, writeToken, type LocalStateV2 } from './state.js';
import type { TrustedKey } from './trusted-keys.js';
import { installUi, uiComesWithProText, uiToolAnswer } from './ui.js';
import { MCP_VERSION } from './version.js';

export class UserError extends Error {}

export interface ServiceDeps {
  api: Api;
  secrets: SecretStore;
  paths: Paths;
  trustedKeys: TrustedKey[];
  runClaude: ClaudeRunner;
  /** M8b: builds a runner per command for the prerequisite probes of `phanos_install`; absent, the check is skipped. */
  commandRunner?: CommandRunnerFactory;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  hostname: string;
  platform: 'win32' | 'darwin' | 'linux';
  apiBase: string;
  log: (msg: string) => void;
  /** `${process.platform}-${process.arch}` by default; the UI archive of this platform is verified with a Pro install. */
  platformKey?: string;
  /** The installer's own version, checked against a release's `requires.mcp`; the package version by default. */
  mcpVersion?: string;
  /** M9b: starts the UI entry detached; a test seam, a real detached spawn by default. */
  launchUi?: (entry: string, cwd: string) => Promise<void> | void;
  /** M9b: how the Desktop folder is found for the shortcut; a test seam, the shell-free runner, the process environment and the home folder by default. */
  desktop?: { run: CommandRunner; env: NodeJS.ProcessEnv; homedir: string; exists?: (path: string) => boolean };
  /** M-F3b: how this MCP was launched; normal mode sets it, and the start check records it before the session check. */
  launchRecord?: { entry: string; node: string; version: string };
}

type LoginState =
  | { status: 'idle' }
  | { status: 'pending'; userCode: string; url: string }
  | { status: 'done'; message: string }
  | { status: 'failed'; message: string };

const REFRESH_BEFORE_MS = 3 * 86_400_000;
const NEEDS_LOGIN = 'Every PhanOS install needs a signed-in account; run phanos_login';
const LABEL: Record<LocalEdition, string> = { pro: 'Pro', basic: 'Basic' };
const ENTITLED = new Set<string>(['active', 'trial', 'grace']);
const planName = (p: Me['plan']) => ({ free: 'Free', pro: 'Pro', business: 'Business' })[p];
const day = (iso: string | Date) => new Date(iso).toISOString().slice(0, 10);
const planLabel = (me: Me) => `${planName(me.plan)}${me.until && me.plan !== 'free' ? ` until ${day(me.until)}` : ''}`;
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** M7b: at most this many changed or added paths are named in an answer; the rest are counted ("and N more"). */
const MAX_LISTED = 20;
/** M7b: the closing sentence of every local-changes refusal. */
const FORCE_SENTENCE = 'Nothing was changed. Run phanos_update with force: true to replace them.';

/** M5e (C1 section 5.2 item 1): the one line a phanos_install answer carries to ask about the desktop shortcut. */
export const SHORTCUT_QUESTION =
  'Ask the user whether they want a desktop shortcut for the PhanOS UI. Only if they say yes, call phanos_ui with shortcut: "create".';

/** Puts `line` on its own line immediately before a final next-session line (which stays last), or at the end when the answer has none. */
function insertBeforeNextSession(answer: string, line: string): string {
  const lines = answer.split('\n');
  const last = lines.at(-1)?.trimEnd();
  if (last === nextSessionLine('pro') || last === nextSessionLine('basic')) lines.splice(lines.length - 1, 0, line);
  else lines.push(line);
  return lines.join('\n');
}

/** C1 section 4: `active`, `trial` and `grace` keep Pro; `ended` and `never` are Basic. An older server without `state` falls back to the plan. */
function isEntitled(me: Me): boolean {
  if (typeof me.state === 'string' && (ACCOUNT_STATES as readonly string[]).includes(me.state)) return ENTITLED.has(me.state);
  return me.plan !== 'free';
}

/** Failures the user can act on become `UserError` (an error result with the message as its text). */
function asUserError(e: unknown): unknown {
  if (e instanceof ApiError || e instanceof ReleaseVerificationError || e instanceof FilesInUseError || e instanceof LocalChangesError || e instanceof UncheckableTreeError) {
    return new UserError(e.message);
  }
  return e;
}

/** One edition after verification: its release and, unless it is already current, every verified artifact body. */
interface Prepared {
  edition: LocalEdition;
  release: VerifiedRelease;
  current: boolean;
  zip?: Buffer;
  filesList?: Buffer | null;
  /** The verified UI archive of this platform (Pro only), set when the UI is to be installed after the flip. */
  uiZip?: Buffer;
}

export function createPhanosService(d: ServiceDeps) {
  let login: LoginState = { status: 'idle' };
  let task: Promise<void> = Promise.resolve();
  /** The tail of the serial queue; it never rejects (each job's own result is returned to its caller). */
  let queue: Promise<unknown> = Promise.resolve();
  /** What the start check did, printed at the top of the next `phanos_status` answer and then cleared. */
  let startReport: string | null = null;

  /**
   * One in-process queue: install, status, update, logout and the start check run one at a time, so a tool call made
   * while the start check runs waits for it. Only the public wrappers below enter the queue; the functions they call do
   * not, so nothing waits on itself. `startLogin` and its polling task stay outside it: the device flow waits for a
   * human in a browser for minutes and would otherwise block every other tool for that long.
   */
  function serial<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const pendingText = (l: { userCode: string; url: string }) =>
    `Open ${l.url} in your browser and confirm the code ${l.userCode}. Sign-in finishes by itself; then run phanos_status.`;

  /** Ensures a valid Pro token on disk for an entitled account; removes it otherwise. */
  async function ensureToken(session: string, me: Me): Promise<string | null> {
    if (!isEntitled(me)) {
      await deleteToken(d.paths);
      return null;
    }
    const state = await readLocalState(d.paths);
    const existing = await readToken(d.paths);
    const exp = existing ? tokenExpiry(existing) : null;
    if (existing && state.deviceId && exp && exp.getTime() - d.now().getTime() > REFRESH_BEFORE_MS) return existing;

    let deviceId = state.deviceId;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!deviceId) {
        deviceId = (await d.api.registerDevice(session, d.hostname, d.platform)).id;
        await writeLocalState(d.paths, { ...(await readLocalState(d.paths)), deviceId });
      }
      try {
        const t = await d.api.getToken(session, deviceId);
        await writeToken(d.paths, t.token);
        await writeLocalState(d.paths, { ...(await readLocalState(d.paths)), deviceId, tokenExpiresAt: t.expiresAt });
        return t.token;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'device_not_found' && attempt === 0) {
          deviceId = undefined;
          continue;
        }
        throw e;
      }
    }
    return null;
  }

  async function startLogin(): Promise<string> {
    if (login.status === 'pending') return pendingText(login);
    const flow = await d.api.startDeviceFlow();
    login = { status: 'pending', userCode: flow.userCode, url: flow.verificationUriComplete };
    task = (async () => {
      let interval = flow.interval;
      const deadline = d.now().getTime() + flow.expiresIn * 1000;
      for (;;) {
        await d.sleep(interval * 1000);
        if (d.now().getTime() > deadline) break;
        const r = await d.api.pollDeviceToken(flow.deviceCode);
        if (r.status === 'pending') continue;
        if (r.status === 'slow_down') {
          interval += 5;
          continue;
        }
        if (r.status === 'denied') {
          login = { status: 'failed', message: 'Sign-in was refused in the browser. Run phanos_login to try again.' };
          return;
        }
        if (r.status === 'expired') break;
        await d.secrets.set(r.accessToken);
        const me = await d.api.me(r.accessToken);
        await writeLocalState(d.paths, { ...(await readLocalState(d.paths)), email: me.email });
        let note = '';
        try {
          await ensureToken(r.accessToken, me);
        } catch (e) {
          note = ` ${(e as Error).message}`;
        }
        login = { status: 'done', message: `Signed in as ${me.email} (plan ${planLabel(me)}).${note}` };
        return;
      }
      login = { status: 'failed', message: 'The sign-in code expired. Run phanos_login again.' };
    })().catch((e: Error) => {
      login = { status: 'failed', message: `Sign-in failed: ${e.message}` };
    });
    return pendingText(login);
  }

  const installedLine = (state: LocalStateV2): string => {
    const parts = (['pro', 'basic'] as const).filter((e) => state[e]?.version).map((e) => `${LABEL[e]} ${state[e]!.version}`);
    if (parts.length === 0) return 'PhanOS is not installed yet. Run phanos_install.';
    return `Installed: PhanOS ${parts.join(' and ')}${state.enabled ? `; ${LABEL[state.enabled]} is the enabled edition` : ''}.`;
  };

  /**
   * Records what a flip did in the state file (a cache of what the MCP did, C1 section 5.1): the edition left enabled
   * once the whole plan applied, the last known account state, and (after an install) whether each edition is registered.
   */
  async function recordOutcome(answer: AccountRead, flip: FlipResult, edit?: (next: LocalStateV2, prior: LocalStateV2) => void): Promise<void> {
    const prior = await readLocalState(d.paths);
    const next: LocalStateV2 = { ...prior };
    edit?.(next, prior);
    if (answer.kind === 'known') {
      if (flip.ok && flip.changed) next.enabled = isEntitled(answer.me) ? 'pro' : 'basic';
      next.lastConfirmed = { state: answer.state, at: d.now().toISOString() };
    }
    if (JSON.stringify(next) !== JSON.stringify(prior)) await writeLocalState(d.paths, next);
  }

  /**
   * M3e (C1 section 3.3, F-9531): tells the account which edition this device left enabled and at which version, from the state
   * as recorded after the step. Best-effort: a failure or rejection is logged and never reaches the caller, so it can neither
   * block nor change an answer. Nothing is sent without a device (Basic-only accounts have none), or without an enabled edition
   * whose version is known. One call per step.
   */
  async function reportDevice(session: string): Promise<void> {
    try {
      const state = await readLocalState(d.paths);
      const enabled = state.enabled;
      const version = enabled ? state[enabled]?.version : undefined;
      if (!state.deviceId || !enabled || !version) return;
      await d.api.reportDeviceState(session, state.deviceId, { enabled, version });
    } catch (e) {
      d.log(`device report failed: ${(e as Error).message}`);
    }
  }

  async function status(): Promise<string> {
    const lines: string[] = [];
    if (startReport !== null) {
      lines.push(startReport);
      startReport = null;
    }
    if (login.status === 'pending') lines.push(pendingText(login));
    if (login.status === 'done' || login.status === 'failed') {
      lines.push(login.message);
      login = { status: 'idle' };
    }
    let flipText: string | null = null;
    const session = await d.secrets.get();
    if (!session) {
      lines.push(`Not signed in. ${NEEDS_LOGIN}.`);
    } else {
      const answer = await readAccount(d.api, session);
      if (answer.kind === 'known') {
        lines.push(`Account ${answer.me.email}, plan ${planLabel(answer.me)}. Credential stored in ${d.secrets.where}.`);
        const token = await ensureToken(session, answer.me).catch((e: Error) => {
          lines.push(e.message);
          return null;
        });
        const exp = token ? tokenExpiry(token) : null;
        if (exp) lines.push(`Pro token valid until ${day(exp)}; it renews automatically.`);
      } else if (answer.reason === 'unauthenticated') {
        await d.secrets.clear();
      }
      const flip = await reconcileEditions({
        trigger: 'status',
        answer,
        run: d.runClaude,
        paths: d.paths,
        getToken: answer.kind === 'known' ? () => ensureToken(session, answer.me) : undefined,
      });
      await recordOutcome(answer, flip);
      if (flip.changed) await reportDevice(session);
      flipText = flip.answer;
      if (answer.kind === 'unknown' && answer.reason === 'network') flipText += '\nPhanOS keeps working offline until the saved token expires.';
    }
    lines.push(installedLine(await readLocalState(d.paths)));
    if (flipText) lines.push(flipText);
    return lines.join('\n');
  }

  const releaseEnv = (): ReleaseEnv => ({
    mcpVersion: d.mcpVersion ?? MCP_VERSION,
    nodeVersion: process.version,
    platformKey: d.platformKey ?? `${d.platform}-${process.arch}`,
    acceptSchema1: ACCEPT_SCHEMA_1,
  });

  /** Is this edition already at the release's version, with a tree on disk and (schema 2) the signed list it was installed from? */
  async function isCurrent(edition: LocalEdition, release: VerifiedRelease, state: LocalStateV2, onDisk: Record<LocalEdition, boolean>): Promise<boolean> {
    if (state[edition]?.version !== release.version || !onDisk[edition]) return false;
    if (!release.plugin.files) return true;
    try {
      return sha256(await readFile(d.paths.marketplace[edition].filesList)) === release.plugin.files.sha256;
    } catch {
      return false;
    }
  }

  /** Is the Pro UI of this release missing or at another version (the state record, the `ui/current` pointer and its folder all agree)? */
  async function uiBehind(release: VerifiedRelease, state: LocalStateV2): Promise<boolean> {
    if (!release.ui) return false;
    if (state.ui?.version !== release.version || state.ui.platform !== release.ui.platform) return true;
    try {
      if ((await readFile(d.paths.uiCurrentFile, 'utf8')).trim() !== release.version) return true;
      await readdir(join(d.paths.uiDir, release.version));
      return false;
    } catch {
      return true;
    }
  }

  /**
   * C1 section 2.3 for every wanted edition, and no file written. Phase 1 fetches and verifies each manifest (Pro with the
   * token, Basic with the session); phase 2 downloads every artifact the install needs (the plugin, its files list, and
   * the Pro UI for this platform when it is not current) and checks size, then sha256. The UI archive is verified here and
   * kept in `Prepared`; `installUiAfterFlip` writes it after the flip (M5c).
   */
  async function verifyEditions(editions: readonly LocalEdition[], session: string, token: string | null): Promise<Prepared[]> {
    const bearerOf = (e: LocalEdition): string => {
      const bearer = e === 'pro' ? token : session;
      if (!bearer) throw new UserError('PhanOS Pro needs a valid entitlement token. Run phanos_status to renew it, or phanos_login to sign in again.');
      return bearer;
    };
    try {
      const state = await readLocalState(d.paths);
      const onDisk = await treesOnDisk(d.paths);
      const env = releaseEnv();
      const prepared: Prepared[] = [];
      for (const edition of editions) {
        const signed = await d.api.getManifest(toWire(edition), bearerOf(edition));
        const release = verifyRelease(signed, d.trustedKeys, toWire(edition), env);
        prepared.push({ edition, release, current: await isCurrent(edition, release, state, onDisk) });
      }
      for (const p of prepared) {
        const { plugin, ui } = p.release;
        // The UI follows its own currency (F-9830): a current Pro whose UI is behind or missing still gets it.
        const wantUi = ui !== null && (!p.current || (await uiBehind(p.release, state)));
        if (p.current && !wantUi) continue;
        const wire = toWire(p.edition);
        const bearer = bearerOf(p.edition);
        if (!p.current) {
          p.zip = await d.api.downloadArtifact(wire, plugin.file, bearer, plugin.size);
          checkArchive(p.zip, plugin);
          if (plugin.files) {
            p.filesList = await d.api.downloadArtifact(wire, plugin.files.file, bearer, plugin.files.size);
            checkArchive(p.filesList, plugin.files);
            parseFilesList(p.filesList, { archive: plugin.file });
          } else {
            p.filesList = null;
          }
        }
        if (wantUi && ui) {
          p.uiZip = await d.api.downloadArtifact(wire, ui.file, bearer, ui.size);
          checkArchive(p.uiZip, ui);        }
      }
      return prepared;
    } catch (e) {
      throw asUserError(e);
    }
  }

  /**
   * F-9829 / M7b: the read-only local-changes check of EVERY non-current edition, before the first swap. If any edition
   * refuses, the answer (merged across editions) is thrown as a `UserError` and nothing has been written for any of them.
   */
  async function refuseLocalChanges(prepared: readonly Prepared[]): Promise<void> {
    const changes: { edition: LocalEdition; changed: string[]; added: string[] }[] = [];
    const unchecked: { edition: LocalEdition; message: string }[] = [];
    for (const p of prepared) {
      if (p.current) continue;
      try {
        await checkLiveTree({ paths: d.paths, edition: p.edition, force: false });
      } catch (e) {
        if (e instanceof LocalChangesError) changes.push({ edition: p.edition, changed: e.changed, added: e.added });
        else if (e instanceof UncheckableTreeError) unchecked.push({ edition: p.edition, message: e.message });
        else throw asUserError(e);
      }
    }
    if (changes.length === 0 && unchecked.length === 0) return;
    const lines: string[] = [];
    if (changes.length > 0) {
      const names = changes.flatMap((c) => [...c.changed, ...c.added].map((path) => `${LABEL[c.edition]}: ${path}`));
      lines.push('These installed PhanOS files were changed or added by hand:', ...names.slice(0, MAX_LISTED));
      if (names.length > MAX_LISTED) lines.push(`and ${names.length - MAX_LISTED} more`);
    }
    // The error's own message, without its closing "Nothing was changed. Use force once ..." (the force sentence follows).
    for (const u of unchecked) lines.push(`PhanOS ${LABEL[u.edition]}: ${u.message.replace(/ Nothing was changed\..*$/s, '')}`);
    lines.push(FORCE_SENTENCE);
    throw new UserError(lines.join('\n'));
  }

  /**
   * Writes each non-current tree (the first write of an install) and records its version as it lands. Without `force`, every
   * non-current edition is checked for local changes first (`refuseLocalChanges`), so one refusal writes nothing at all.
   */
  async function installTrees(prepared: readonly Prepared[], force: boolean): Promise<string[]> {
    if (!force) await refuseLocalChanges(prepared);
    const lines: string[] = [];
    for (const p of prepared) {
      const label = `PhanOS ${LABEL[p.edition]} ${p.release.version}`;
      if (p.current) {
        lines.push(`${label} is already up to date.`);
        continue;
      }
      let replaced: { changed: string[]; added: string[] } | undefined;
      try {
        replaced = (await installPluginTree({ paths: d.paths, edition: p.edition, version: p.release.version, zip: p.zip!, filesList: p.filesList ?? null, force })).replaced;
      } catch (e) {
        throw asUserError(e);
      }
      const state = await readLocalState(d.paths);
      const next: LocalStateV2 = { ...state };
      next[p.edition] = { ...state[p.edition], version: p.release.version };
      await writeLocalState(d.paths, next);
      lines.push(`${label} installed (signature and checksums verified).`);
      const names = replaced ? [...replaced.changed, ...replaced.added] : [];
      if (names.length > 0) {
        const more = names.length > MAX_LISTED ? `, and ${names.length - MAX_LISTED} more` : '';
        lines.push(`Replaced files you changed by hand in PhanOS ${LABEL[p.edition]}: ${names.slice(0, MAX_LISTED).join(', ')}${more}.`);
      }
    }
    return lines;
  }

  /**
   * M5c: runs after the flip, for a Pro whose verified UI archive was kept. The archive was verified before any write, so a
   * failure here (a locked folder, a full disk) becomes a line in the answer and leaves the plugin as it landed; the state
   * record stays unchanged, so the next update tries the UI again. An account that is not entitled never gets a Pro
   * `Prepared`, so its existing UI is left alone.
   */
  async function installUiAfterFlip(prepared: readonly Prepared[]): Promise<{ lines: string[]; ui?: { version: string; platform: string } }> {
    const p = prepared.find((x) => x.edition === 'pro' && x.uiZip && x.release.ui);
    if (!p?.uiZip || !p.release.ui) return { lines: [] };
    const version = p.release.version;
    const platform = p.release.ui.platform;
    try {
      const r = await installUi({ paths: d.paths, version, platformKey: platform, zip: p.uiZip });
      const already = r.notes.find((n) => n.includes('was already installed'));
      const lines = already ? [already] : [`PhanOS UI ${version} installed (signature and checksums verified).`];
      lines.push(...r.notes.filter((n) => n !== already));
      return { lines, ui: { version, platform } };
    } catch (e) {
      return { lines: [`PhanOS UI ${version} could not be installed (${(e as Error).message}). The plugin is installed; run phanos_update to try the UI again.`] };
    }
  }

  /**
   * M8b: what to run by hand when the `claude` command is missing: add each marketplace folder and install its full id, Pro
   * first; with both editions Pro is the enabled one, so Basic is turned off at user scope, as the flip does. Ends with a command.
   */
  function manualRegistration(editions: readonly LocalEdition[]): string {
    const cmds = editions.flatMap((e) => manualInstallCommands(d.paths.marketplace[e].dir, PLUGIN_IDS[e]));
    if (editions.length > 1) cmds.push(manualCommand(['plugin', 'disable', PLUGIN_IDS.basic, '--scope', 'user']));
    return ['PhanOS was not registered in Claude Code because the claude command was not found. Install it, then run these commands and start a new Claude Code session:', ...cmds.map((c) => `  ${c}`)].join('\n');
  }

  async function install(force: boolean): Promise<string> {
    // M8b (part 03 section 2.1, F-9529): the prerequisites come first, before the session. Their notes lead the answer, also the
    // sign-in refusal. A service built without a command runner (a test seam) skips the check.
    const pre = d.commandRunner ? await checkPrerequisites({ run: d.commandRunner, platform: d.platform }) : { blocking: [], notes: [], missing: [] as string[] };
    const lead = pre.notes;
    // F-9858: a missing `claude` is read from the structured list, never from the note's prose.
    const claudeMissing = pre.missing.includes('claude');
    // F-9859: the `claude` note promises that the plugin files are still written; a refusal writes nothing, so it leaves that note out.
    // `notes` and `missing` come from the same list in the same order.
    const refusalLead = lead.filter((_, i) => pre.missing[i] !== 'claude');
    if (pre.blocking.length > 0) throw new UserError([...refusalLead, 'Nothing was installed.'].join('\n'));
    const session = await d.secrets.get();
    if (!session) throw new UserError([...refusalLead, NEEDS_LOGIN].join('\n'));
    const answer = await readAccount(d.api, session);
    if (answer.kind === 'unknown') throw new UserError([...refusalLead, `${answer.message} Nothing was installed.`].join('\n'));
    const editions: LocalEdition[] = isEntitled(answer.me) ? ['pro', 'basic'] : ['basic'];
    let token: string | null;
    try {
      token = await ensureToken(session, answer.me);
    } catch (e) {
      throw asUserError(e);
    }
    const prepared = await verifyEditions(editions, session, token);

    // Everything verified: from here on files are written.
    const lines = [...lead, ...(await installTrees(prepared, force))];
    for (const p of prepared) if (!p.current) lines.push(...p.release.notes);
    const env = await mergeClaudeEnv(d.paths.claudeConfigDir, { PHANOS_CORPUS_URL: `${d.apiBase}/api/corpus/` });
    if (env.error) lines.push(env.error);
    // A missing `claude` cannot register or flip anything: the trees stay written and the answer ends with the manual commands.
    const flip: FlipResult = claudeMissing
      ? { ok: false, changed: false, answer: manualRegistration(editions), lines: [], listing: null, settled: false }
      : await reconcileEditions({
          trigger: 'install',
          answer,
          run: d.runClaude,
          paths: d.paths,
          getToken: () => ensureToken(session, answer.me),
        });
    const uiOut = await installUiAfterFlip(prepared);
    await recordOutcome(answer, flip, (next, prior) => {
      for (const e of editions) next[e] = { ...prior[e], registered: flip.listing?.[PLUGIN_IDS[e]] !== undefined };
      if (uiOut.ui) next.ui = uiOut.ui;
    });
    await reportDevice(session);
    // The UI line comes before the flip answer: the next-session line stays the last line.
    let flipAnswer = flip.answer;
    // M5e: only phanos_install asks (never update), once the UI of this platform is current and no shortcut is recorded.
    // The question writes and calls nothing; a decline is not recorded, so a later install asks again.
    const proWithUi = prepared.find((x) => x.edition === 'pro' && x.release.ui);
    const uiCurrent = proWithUi !== undefined && (uiOut.ui !== undefined || !proWithUi.uiZip);
    if (flip.ok && uiCurrent && !(await readLocalState(d.paths)).shortcut) flipAnswer = insertBeforeNextSession(flipAnswer, SHORTCUT_QUESTION);
    lines.push(...uiOut.lines, flipAnswer);
    return lines.join('\n');
  }

  async function update(force: boolean): Promise<string> {
    const onDisk = await treesOnDisk(d.paths);
    if (!onDisk.pro && !onDisk.basic) return 'PhanOS is not installed yet. Run phanos_install.';
    const session = await d.secrets.get();
    if (!session) throw new UserError(NEEDS_LOGIN);
    const answer = await readAccount(d.api, session);
    if (answer.kind === 'unknown') {
      // §4 "any / unknown": no manifest, no download, no flip; a both-enabled state is reported, never repaired.
      return (await reconcileEditions({ trigger: 'update', answer, run: d.runClaude, paths: d.paths })).answer;
    }
    const entitled = isEntitled(answer.me);
    let token: string | null = null;
    if (entitled && onDisk.pro) {
      try {
        token = await ensureToken(session, answer.me);
      } catch (e) {
        throw asUserError(e);
      }
    }
    // Only editions already on disk are updated; an account that is not entitled never requests the Pro manifest.
    const editions = (['pro', 'basic'] as const).filter((e) => onDisk[e] && (e === 'basic' || entitled));
    const prepared = await verifyEditions(editions, session, token);
    const changed = prepared.some((p) => !p.current);
    const lines = await installTrees(prepared, force);
    if (changed) {
      for (const p of prepared) if (!p.current) lines.push(...p.release.notes);
    } else {
      lines.length = 0;
      if (prepared.length > 0) lines.push(`PhanOS is up to date (${prepared.map((p) => `${LABEL[p.edition]} ${p.release.version}`).join(', ')}).`);
    }
    const flip = await reconcileEditions({
      trigger: 'update',
      answer,
      run: d.runClaude,
      paths: d.paths,
      getToken: () => ensureToken(session, answer.me),
    });
    const uiOut = await installUiAfterFlip(prepared);
    await recordOutcome(answer, flip, uiOut.ui ? (next) => void (next.ui = uiOut.ui) : undefined);
    await reportDevice(session);
    lines.push(...uiOut.lines, flip.answer);
    if (changed) {
      // An update that wrote a tree ends with the next-session line even when the flip had nothing to do.
      const enabled = (await readLocalState(d.paths)).enabled ?? (entitled && onDisk.pro ? 'pro' : 'basic');
      if (lines.at(-1)?.trimEnd().split('\n').at(-1) !== nextSessionLine(enabled)) lines.push(nextSessionLine(enabled));
    }
    return lines.join('\n');
  }

  /**
   * M11 (C1 section 4 row 8, F-9525): signing out leaves the computer on PhanOS Basic, in this order. (1) While the session
   * still exists, a Pro install without a Basic tree gets one, verified as in M3c (the Basic edition needs a session, so it
   * could not be fetched after sign-out). (2) The flip: enable Basic, re-read, disable Pro, re-read. (3) The device is removed
   * from the account and the session, token and account fields are cleared. (3b) The desktop shortcut the MCP created is
   * removed. (4) The answer ends with the next-session line when the flip applied. If (1) or (2) fails the sign-out still
   * completes and Pro stays enabled.
   */
  async function logout(): Promise<string> {
    const session = await d.secrets.get();
    const onDisk = await treesOnDisk(d.paths);
    let basicError: string | null = null;
    let flip: FlipResult | null = null;
    if (onDisk.pro || onDisk.basic) {
      try {
        // (1) Basic first, while the session still exists.
        if (onDisk.pro && !onDisk.basic) {
          if (!session) throw new UserError('there is no signed-in session to download it with.');
          await installTrees(await verifyEditions(['basic'], session, null), false);
          // A new tree is not yet known to Claude Code: register it so the flip finds it installed.
          if ((await listPlugins(d.runClaude))?.[PLUGIN_IDS.basic] === undefined) {
            const registered = await executeInstallRegistration(['basic'], d.runClaude, d.paths);
            if (!registered.ok) throw new UserError('the Claude Code plugin list does not show it after the install.');
          }
        }
      } catch (e) {
        basicError = (e as Error).message;
      }
      // (2) Enable Basic, then disable Pro; skipped when Basic could not be put on disk.
      if (basicError === null) {
        try {
          flip = await reconcileEditions({ trigger: 'logout', answer: null, run: d.runClaude, paths: d.paths });
        } catch (e) {
          basicError = (e as Error).message;
        }
      }
    }
    // F-9990: the structured result says whether the listing confirms Basic on and Pro off; the prose is never read.
    const flipped = flip !== null && flip.ok && flip.settled;

    // (3) The device slot is freed and the account fields are cleared.
    const state = await readLocalState(d.paths);
    if (session && state.deviceId) await d.api.deleteDevice(session, state.deviceId).catch(() => undefined);
    await d.secrets.clear();
    await deleteToken(d.paths);
    const next: LocalStateV2 = { ...state, email: undefined, deviceId: undefined, tokenExpiresAt: undefined };
    if (flipped) next.enabled = 'basic';
    // (3b) Only the shortcut the MCP recorded, by its recorded path.
    let shortcutNote: string | null = null;
    if (state.shortcut) {
      const removed = await removeShortcut(state.shortcut.path);
      if (!removed.removed && removed.reason !== 'missing') shortcutNote = `The desktop shortcut at ${state.shortcut.path} was not removed: ${removed.message ?? 'it could not be deleted'}`;
      next.shortcut = undefined;
    }
    await writeLocalState(d.paths, next);

    // (4) The answer; the next-session line is last.
    const lines = ['Signed out. This computer was removed from your account.'];
    if (basicError !== null) {
      lines.push(
        `PhanOS Basic could not be installed: ${basicError}`,
        'PhanOS Pro stays enabled, but it will not run without a valid token. PhanOS Basic arrives after phanos_login and phanos_install.',
      );
    } else if (flipped && flip) {
      lines[0] += onDisk.pro ? ' PhanOS Basic is enabled; PhanOS Pro stays on disk.' : ' PhanOS Basic is enabled.';
      lines.push(...flip.lines.filter((l) => /also enabled at project scope/.test(l)));
    } else if (flip) {
      lines.push(flip.answer);
    }
    if (shortcutNote) lines.push(shortcutNote);
    if (flipped) lines.push(nextSessionLine('basic'));
    return lines.join('\n');
  }

  /**
   * C1 section 4 rule 6: runs after the server is listening, never downloads and never deletes. Reads the account, renews
   * the entitlement token, then runs the flip with trigger `start` (row 4's renewal included). It never throws: a failure
   * is logged. Its report is kept in memory for the next `phanos_status`; a start that found nothing to do keeps none.
   */
  async function runStartCheck(): Promise<void> {
    try {
      // C1 section 18 item 7: signed-out users need the record too, so it comes before the session check. A failed
      // write is logged and never fails the start check.
      if (d.launchRecord) {
        await recordLaunch(d.paths, d.launchRecord, d.now()).catch((e: Error) => d.log(`launch record not written: ${e.message}`));
      }
      const session = await d.secrets.get();
      if (!session) return;
      const answer = await readAccount(d.api, session);
      if (answer.kind === 'known') {
        try {
          await ensureToken(session, answer.me);
        } catch (e) {
          d.log(`start check: token renewal skipped: ${(e as Error).message}`);
        }
      }
      const flip = await reconcileEditions({
        trigger: 'start',
        answer,
        run: d.runClaude,
        paths: d.paths,
        getToken: answer.kind === 'known' ? () => ensureToken(session, answer.me) : undefined,
      });
      await recordOutcome(answer, flip);
      if (flip.changed) await reportDevice(session);
      if (flip.changed || !flip.ok) startReport = flip.answer;
    } catch (e) {
      d.log(`start check failed: ${(e as Error).message}`);
    }
  }

  /**
   * M9b (C1 section 5.2 items 2 to 6): `phanos_ui` starts the UI (M9a, writes nothing); `shortcut: "create"` writes the one
   * desktop shortcut and records its path only after `createShortcut` succeeded (a refused create claims nothing, so a file
   * PhanOS did not make is never recorded and never removed); `shortcut: "remove"` deletes exactly the recorded path.
   */
  async function ui(shortcut: 'create' | 'remove' | undefined): Promise<string> {
    const state = await readLocalState(d.paths);
    const platformKey = d.platformKey ?? `${d.platform}-${process.arch}`;

    if (shortcut === 'remove') {
      if (!state.shortcut) return 'PhanOS created no desktop shortcut, so there is nothing to remove.';
      const recorded = state.shortcut.path;
      const removed = await removeShortcut(recorded);
      // Only a failed delete keeps the record, so a later call can retry; a vanished or unusable record is dropped.
      if (!removed.removed && removed.reason === 'failed') return `The desktop shortcut at ${recorded} was not removed: ${removed.message ?? 'it could not be deleted'}`;
      await writeLocalState(d.paths, { ...state, shortcut: undefined });
      if (removed.removed) return `Removed the PhanOS desktop shortcut at ${recorded}.`;
      return removed.reason === 'missing'
        ? `The PhanOS desktop shortcut at ${recorded} was already gone; the record of it was cleared.`
        : `${removed.message ?? 'The recorded shortcut path was unusable.'} The record of it was cleared.`;
    }

    if (shortcut === 'create') {
      if (state.enabled === 'basic' || state.lastConfirmed?.state === 'never') return uiComesWithProText(d.apiBase);
      if (state.shortcut && existsSync(state.shortcut.path)) return `The PhanOS desktop shortcut already exists at ${state.shortcut.path}; nothing was changed.`;
      let pointer = '';
      try {
        pointer = (await readFile(d.paths.uiCurrentFile, 'utf8')).trim();
      } catch {
        pointer = '';
      }
      if (pointer === '') return 'The PhanOS UI is not installed, so no shortcut was created. Run phanos_install, then ask for the shortcut again.';
      const dk = d.desktop ?? { run: createExecRunner(), env: process.env, homedir: homedir() };
      const made = await createShortcut({ platform: d.platform, platformKey, paths: d.paths, run: dk.run, env: dk.env, homedir: dk.homedir, ...(dk.exists ? { exists: dk.exists } : {}) });
      if (!made.ok) return made.message;
      await writeLocalState(d.paths, { ...(await readLocalState(d.paths)), shortcut: { path: made.path } });
      return [`Created the PhanOS desktop shortcut at ${made.path}.`, ...made.notes].join('\n');
    }

    return (await uiToolAnswer({ paths: d.paths, state, platformKey, apiBase: d.apiBase, ...(d.launchUi ? { launch: d.launchUi } : {}) })).text;
  }

  const startCheck = (): Promise<void> => serial(runStartCheck);

  return {
    login: startLogin,
    loginTask: () => task,
    status: () => serial(status),
    /** `force` (M7b): replace files the user changed by hand; no argument means `force: false`. */
    install: (opts?: { force?: boolean }) => serial(() => install(opts?.force === true)),
    update: (opts?: { force?: boolean }) => serial(() => update(opts?.force === true)),
    logout: () => serial(logout),
    /** M9b: start the desktop UI, or create/remove the one desktop shortcut. */
    ui: (opts?: { shortcut?: 'create' | 'remove' }) => serial(() => ui(opts?.shortcut)),
    startCheck,
    /** C1 section 18: outside `serial` on purpose; it touches no local state, so it must not wait behind an install or a slow start check. */
    feedback: (input: unknown) => sendFeedback({ getSession: () => d.secrets.get(), submit: (s, b) => d.api.submitFeedback(s, b) }, input),
  };
}

export type PhanosService = ReturnType<typeof createPhanosService>;
