// cyphor-role: CORE
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNT_STATES, ApiError, fetchKillSwitch, readAccount } from './api.js';
import { listPlugins, manualCommand, manualInstallCommands } from './claude-cli.js';
import { PLUGIN_IDS, toWire } from './config.js';
import { contentStatusLines, loadContent, reconcileContentCache, refreshContent } from './content.js';
import { sendFeedback } from './feedback.js';
import { parseFilesList } from './files-list.js';
import { executeInstallRegistration, nextSessionLine, reconcileEditions, treesOnDisk } from './flip.js';
import { checkLiveTree, FilesInUseError, installPluginTree, LocalChangesError, OVERWRITE_ALL_REFUSED, UncheckableTreeError, utcStamp } from './install.js';
import { pruneProjectPointers } from './pointer-prune.js';
import { checkPrerequisites } from './prereqs.js';
import { ACCEPT_SCHEMA_1, checkArchive, ReleaseVerificationError, verifyRelease } from './release.js';
import { sessionStatusLines } from './session-status.js';
import { mergeClaudeEnv, removeClaudeEnv } from './settings.js';
import { createExecRunner, createShortcut, removeShortcut } from './shortcut.js';
import { deleteToken, maxServerTime, readLocalState, readToken, recordLaunch, StateLockBusyError, tokenExpiry, withStateLock, writeLocalState, writeToken } from './state.js';
import { applyShortcutAfterSwitch, runSwitch } from './switch-runner.js';
import { installUi, uiComesWithProText, uiToolAnswer } from './ui.js';
import { MCP_VERSION } from './version.js';
export class UserError extends Error {
}
/** F-16076, PROVISIONAL (wave C ruling 14); update 0 is wave C ruling 11. `content` (P-3): the token renewal a `phanos_content` call asks for. */
const LOCK_WAIT_MS = { start: 5_000, status: 5_000, install: 10_000, update: 0, logout: 10_000, ui: 5_000, login: 60_000, content: 5_000 };
/** F-16076 busy answers (F-16078: one shared lead, no holder named). Tests quote these texts literally. */
const BUSY_LEAD = 'PhanOS is busy with another task (for example an update or an edition switch, in this or another Claude Code session)';
const BUSY_STATUS = `${BUSY_LEAD}, so this answer shows the saved state and nothing was checked or changed; run phanos_status again in a minute.`;
const BUSY_INSTALL = `${BUSY_LEAD}; nothing was installed or changed, so run phanos_install again when it has finished.`;
const BUSY_UPDATE = `${BUSY_LEAD}; nothing was changed, so run phanos_update again when it has finished.`;
const BUSY_LOGOUT = `${BUSY_LEAD}; you are still signed in and nothing was changed, so run phanos_logout again when it has finished.`;
const BUSY_UI = `${BUSY_LEAD}; the desktop shortcut was not changed, so run phanos_ui again when it has finished.`;
const BUSY_LOGIN = `${BUSY_LEAD}, so the Pro token was not fetched yet; run phanos_status when it has finished.`;
const REFRESH_BEFORE_MS = 3 * 86_400_000;
const NEEDS_LOGIN = 'Every PhanOS install needs a signed-in account; run phanos_login';
const LABEL = { pro: 'Pro', basic: 'Basic' };
const ENTITLED = new Set(['active', 'trial', 'grace']);
const planName = (p) => ({ free: 'Free', pro: 'Pro', business: 'Business' })[p];
const day = (iso) => new Date(iso).toISOString().slice(0, 10);
const planLabel = (me) => `${planName(me.plan)}${me.until && me.plan !== 'free' ? ` until ${day(me.until)}` : ''}`;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
/** M7b: at most this many changed or added paths are named in an answer; the rest are counted ("and N more"). */
const MAX_LISTED = 20;
/** M7b: the closing sentence of every local-changes refusal. phanos_install only (F-16192). */
const FORCE_SENTENCE = 'Nothing was changed. Run phanos_install with force: true to install anyway; a file this release also changes is replaced, and a copy of yours is kept aside.';
/** WE-5.01 ruling 9: the first line of a `force` update's answer. */
const FORCE_NOTE = 'note: force is deprecated; use overwrite_all';
/** WE-5.01 ruling 7: the first-call answer about conflicts, verbatim. `rels` are sorted, deduplicated and not capped. */
function conflictAnswer(rels) {
    const first = rels[0] ?? '';
    return [
        `result: conflicts (${rels.length})`,
        ...rels.map((rel) => `${rel}  (keep | overwrite)`),
        `To decide per file, call phanos_update again with decisions, for example {"${first}": "keep"}; a file without a decision is left as it is.`,
        'Or call phanos_update with unattended: true to keep every changed file, or with overwrite_all: true to replace them all (a copy of each is kept aside).',
    ].join('\n');
}
/** M5e (C1 section 5.2 item 1): the one line a phanos_install answer carries to ask about the desktop shortcut. */
export const SHORTCUT_QUESTION = 'Ask the user whether they want a desktop shortcut for the PhanOS UI. Only if they say yes, call phanos_ui with shortcut: "create".';
/** Puts `line` on its own line immediately before a final next-session line (which stays last), or at the end when the answer has none. */
function insertBeforeNextSession(answer, line) {
    const lines = answer.split('\n');
    const last = lines.at(-1)?.trimEnd();
    if (last === nextSessionLine('pro') || last === nextSessionLine('basic'))
        lines.splice(lines.length - 1, 0, line);
    else
        lines.push(line);
    return lines.join('\n');
}
/** C1 section 4: `active`, `trial` and `grace` keep Pro; `ended` and `never` are Basic. An older server without `state` falls back to the plan. */
function isEntitled(me) {
    if (typeof me.state === 'string' && ACCOUNT_STATES.includes(me.state))
        return ENTITLED.has(me.state);
    return me.plan !== 'free';
}
/** Failures the user can act on become `UserError` (an error result with the message as its text). */
function asUserError(e) {
    if (e instanceof ApiError || e instanceof ReleaseVerificationError || e instanceof FilesInUseError || e instanceof LocalChangesError || e instanceof UncheckableTreeError) {
        return new UserError(e.message);
    }
    return e;
}
export function createPhanosService(d) {
    let login = { status: 'idle' };
    let task = Promise.resolve();
    /** The tail of the serial queue; it never rejects (each job's own result is returned to its caller). */
    let queue = Promise.resolve();
    /** WE-3.04 ruling 1: the enabled edition in the first plugin listing this process read; 'none' when that listing enables neither. */
    let loaded = null;
    /** WE-3.04 ruling 2: when this process last had a successful server answer (an account read or a token). */
    let lastOk = null;
    /** What the start check did, printed at the top of the next `phanos_status` answer and then cleared. */
    let startReport = null;
    /**
     * One in-process queue: install, status, update, logout and the start check run one at a time, so a tool call made
     * while the start check runs waits for it. Only the public wrappers below enter the queue; the functions they call do
     * not, so nothing waits on itself. `startLogin` and its polling task stay outside it: the device flow waits for a
     * human in a browser for minutes and would otherwise block every other tool for that long. Each writing public pass
     * runs its job through `locked` inside this queue (F-16076).
     */
    function serial(job) {
        const run = queue.then(job);
        queue = run.then(() => undefined, () => undefined);
        return run;
    }
    /** F-16076 (WE-3.01: every read-modify-write of state.json goes through withStateLock): a launch record not yet written. */
    let launchPending = d.launchRecord !== undefined;
    const lockWait = (pass) => d.stateLock?.waitMs?.[pass] ?? LOCK_WAIT_MS[pass];
    /**
     * F-16076 (WE-3.01 rule): each writing pass holds state.json.lock for its whole run, so every nested write (ensureToken,
     * recordOutcome, installTrees, the flip mark, the switch runner, the shortcut change, the launch record) runs
     * re-entrantly under it. The first pass that gets the lock also writes a pending launch record (C5). Only a busy error
     * at acquire time becomes the pass's busy answer; a StateLockBusyError from inside the job is rethrown. A job must
     * never await work of another chain that needs the lock (loginTask, a serial job); it would wait out that chain's bound.
     */
    async function locked(pass, job, busy) {
        let entered = false;
        try {
            return await withStateLock(d.paths, async () => {
                entered = true;
                if (launchPending && d.launchRecord) {
                    launchPending = false;
                    await recordLaunch(d.paths, d.launchRecord, d.now()).catch((e) => d.log(`launch record not written: ${e.message}`));
                }
                return await job();
            }, { waitMs: lockWait(pass), ...(d.stateLock?.pollMs !== undefined ? { pollMs: d.stateLock.pollMs } : {}) });
        }
        catch (e) {
            if (!entered && e instanceof StateLockBusyError)
                return await busy();
            throw e;
        }
    }
    const pendingText = (l) => `Open ${l.url} in your browser and confirm the code ${l.userCode}. Sign-in finishes by itself; then run phanos_status.`;
    /** Ensures a valid Pro token on disk for an entitled account; removes it otherwise. */
    async function ensureToken(session, me) {
        if (!isEntitled(me)) {
            await deleteToken(d.paths);
            await writeLocalState(d.paths, { ...(await readLocalState(d.paths)), lastVerdict: { status: 'refused', at: Math.floor(d.now().getTime() / 1000) } });
            return null;
        }
        const state = await readLocalState(d.paths);
        const existing = await readToken(d.paths);
        const exp = existing ? tokenExpiry(existing) : null;
        if (existing && state.deviceId && exp && exp.getTime() - d.now().getTime() > REFRESH_BEFORE_MS) {
            await writeLocalState(d.paths, { ...(await readLocalState(d.paths)), lastVerdict: { status: 'valid', at: Math.floor(d.now().getTime() / 1000) } });
            return existing;
        }
        let deviceId = state.deviceId;
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!deviceId) {
                deviceId = (await d.api.registerDevice(session, d.hostname, d.platform)).id;
                await writeLocalState(d.paths, { ...(await readLocalState(d.paths)), deviceId });
            }
            try {
                const t = await d.api.getToken(session, deviceId);
                await writeToken(d.paths, t.token);
                const prior = await readLocalState(d.paths);
                await writeLocalState(d.paths, {
                    ...prior,
                    deviceId,
                    tokenExpiresAt: t.expiresAt,
                    serverTime: maxServerTime(prior.serverTime, t.serverTime),
                    lastVerdict: { status: 'valid', at: Math.floor(d.now().getTime() / 1000) },
                });
                return t.token;
            }
            catch (e) {
                if (e instanceof ApiError && e.code === 'device_not_found' && attempt === 0) {
                    deviceId = undefined;
                    continue;
                }
                throw e;
            }
        }
        return null;
    }
    async function startLogin() {
        if (login.status === 'pending')
            return pendingText(login);
        const flow = await d.api.startDeviceFlow();
        login = { status: 'pending', userCode: flow.userCode, url: flow.verificationUriComplete };
        task = (async () => {
            let interval = flow.interval;
            const deadline = d.now().getTime() + flow.expiresIn * 1000;
            for (;;) {
                await d.sleep(interval * 1000);
                if (d.now().getTime() > deadline)
                    break;
                const r = await d.api.pollDeviceToken(flow.deviceCode);
                if (r.status === 'pending')
                    continue;
                if (r.status === 'slow_down') {
                    interval += 5;
                    continue;
                }
                if (r.status === 'denied') {
                    login = { status: 'failed', message: 'Sign-in was refused in the browser. Run phanos_login to try again.' };
                    return;
                }
                if (r.status === 'expired')
                    break;
                await d.secrets.set(r.accessToken);
                const me = await d.api.me(r.accessToken);
                // F-16076 C3: the email write and the token fetch hold state.json.lock; a busy lock leaves the token for a later status.
                let note = '';
                await locked('login', async () => {
                    await writeLocalState(d.paths, { ...(await readLocalState(d.paths)), email: me.email });
                    try {
                        await ensureToken(r.accessToken, me);
                    }
                    catch (e) {
                        note = ` ${e.message}`;
                    }
                }, () => {
                    note = ` ${BUSY_LOGIN}`;
                });
                login = { status: 'done', message: `Signed in as ${me.email} (plan ${planLabel(me)}).${note}` };
                return;
            }
            login = { status: 'failed', message: 'The sign-in code expired. Run phanos_login again.' };
        })().catch((e) => {
            login = { status: 'failed', message: `Sign-in failed: ${e.message}` };
        });
        return pendingText(login);
    }
    const installedLine = (state) => {
        const parts = ['pro', 'basic'].filter((e) => state[e]?.version).map((e) => `${LABEL[e]} ${state[e].version}`);
        if (parts.length === 0)
            return 'PhanOS is not installed yet. Run phanos_install.';
        return `Installed: PhanOS ${parts.join(' and ')}${state.enabled ? `; ${LABEL[state.enabled]} is the enabled edition` : ''}.`;
    };
    /** WE-3.04 ruling 1: the first listing this process reads fixes the loaded edition (the enabled test is flip.ts's userOn). */
    function noteListing(listing) {
        if (loaded !== null || listing === null)
            return;
        const on = (e) => {
            const s = listing[PLUGIN_IDS[e]];
            return !!s?.enabled && !(s.projectEnabled && (s.notes ?? []).some((n) => /but still loads/i.test(n)));
        };
        loaded = on('pro') ? 'pro' : on('basic') ? 'basic' : 'none';
    }
    /** WE-3.04 ruling 2: the corpus version the server reports; any failure, a missing method included, reads as null. */
    async function corpusOf(token) {
        try {
            return await d.api.getCorpusVersion(token);
        }
        catch {
            return null;
        }
    }
    /**
     * P-3 (03_c9-wire-client.md section 3): asked by `loadContent` and the refresh when the disk token is missing or inside the
     * refresh window. Renews it through `ensureToken` under the state lock; no session, an unknown account answer or a busy lock keeps
     * the disk token as it is (a null or a throw both do).
     */
    async function refreshContentToken() {
        const session = await d.secrets.get();
        if (!session)
            return null;
        const answer = await readAccount(d.api, session);
        if (answer.kind !== 'known')
            return null;
        return await locked('content', () => ensureToken(session, answer.me), () => {
            throw new Error(BUSY_LEAD);
        });
    }
    function contentDeps() {
        return { api: d.api, paths: d.paths, now: d.now, refreshToken: refreshContentToken };
    }
    /** P-3 (section 5): past grace deletes the content cache; a busy cache lock is logged and leaves it for the next pass. Never throws. */
    async function reconcileContent() {
        try {
            await reconcileContentCache(d.paths, d.now());
        }
        catch (e) {
            d.log(`content cache reconcile skipped: ${e.message}`);
        }
    }
    /** WE-3.04 rulings 1-4: the lines that follow the installed line, before the flip text. `reachable` is this pass's account read. */
    function statusBlocks(state, reachable, corpusVersion, content, session) {
        const iso = (sec) => new Date(sec * 1000).toISOString();
        const lines = [];
        if (loaded === null)
            lines.push('Loaded in this session: unknown (no plugin listing read yet)');
        else if (loaded === 'none')
            lines.push('Loaded in this session: none (the first plugin listing enables no PhanOS edition)');
        else
            lines.push(`Loaded in this session: PhanOS ${LABEL[loaded]}`);
        if (loaded !== null && state.enabled && state.enabled !== loaded)
            lines.push(`Enabled for the next session: PhanOS ${LABEL[state.enabled]}`);
        lines.push(`server: reachable ${reachable ? 'yes' : 'no'}, corpusVersion ${corpusVersion ?? 'null'}, lastOk ${lastOk ?? 'never'}`);
        lines.push(...content);
        lines.push(...session);
        const sw = state.switch;
        if (!sw?.lastRun)
            lines.push('switch: no switch run yet');
        else {
            const pending = sw.pending ?? [];
            const reasons = (sw.pendingReasons ?? {});
            const named = pending.length > 0 ? ` (${pending.map((id) => `${id}: ${reasons[id] ?? 'unknown'}`).join(', ')})` : '';
            lines.push(`switch: last run ${iso(sw.lastRun.at)} engine ${sw.lastRun.engineVersion} result ${sw.lastRun.result}; pending ${pending.length}${named}`);
        }
        const kill = state.killSwitch;
        lines.push(kill ? `downgrade switch: ${kill.downgrade} (read ${iso(kill.fetchedAt)})` : 'downgrade switch: unread');
        return lines;
    }
    /**
     * Records what a flip did in the state file (a cache of what the MCP did, C1 section 5.1): the edition left enabled
     * once the whole plan applied, the last known account state, and (after an install) whether each edition is registered.
     */
    async function recordOutcome(answer, flip, edit) {
        noteListing(flip.listing);
        const prior = await readLocalState(d.paths);
        const next = { ...prior };
        edit?.(next, prior);
        if (answer.kind === 'known') {
            if (flip.ok && flip.changed)
                next.enabled = isEntitled(answer.me) ? 'pro' : 'basic';
            next.lastConfirmed = { state: answer.state, at: d.now().toISOString() };
        }
        if (JSON.stringify(next) !== JSON.stringify(prior))
            await writeLocalState(d.paths, next);
    }
    /**
     * M3e (C1 section 3.3, F-9531): tells the account which edition this device left enabled and at which version, from the state
     * as recorded after the step. Best-effort: a failure or rejection is logged and never reaches the caller, so it can neither
     * block nor change an answer. Nothing is sent without a device (Basic-only accounts have none), or without an enabled edition
     * whose version is known. One call per step.
     */
    async function reportDevice(session) {
        try {
            const state = await readLocalState(d.paths);
            const enabled = state.enabled;
            const version = enabled ? state[enabled]?.version : undefined;
            if (!state.deviceId || !enabled || !version)
                return;
            await d.api.reportDeviceState(session, state.deviceId, { enabled, version });
        }
        catch (e) {
            d.log(`device report failed: ${e.message}`);
        }
    }
    /** F-16412: the value of `PHANOS_CORPUS_URL` this MCP writes into the Claude settings (a Pro install), and the only value it removes. */
    const corpusUrlEnv = () => ({ PHANOS_CORPUS_URL: `${d.apiBase}/api/corpus/` });
    /**
     * F-16412: removes our `PHANOS_CORPUS_URL` from the Claude settings (a Basic-only install, a settled downgrade). It never
     * throws, so no pass fails because of it; the lines it returns (an unreadable settings file) belong in that pass's answer.
     */
    async function dropCorpusUrl() {
        try {
            const r = await removeClaudeEnv(d.paths.claudeConfigDir, corpusUrlEnv());
            return r.error ? [r.error] : [];
        }
        catch (e) {
            d.log(`corpus url not removed: ${e.message}`);
            return [];
        }
    }
    /**
     * WE-3.02 (rulings 5, 11, 12): after a pass's flip, runs the switch runner and applies the desktop-shortcut change its
     * report implies (M5). Returns the lines for that pass's answer. Never called by logout. A failure is logged and returns
     * no lines: the pass itself never fails because of the switch. F-16412: a settled downgrade also removes our
     * `PHANOS_CORPUS_URL` from the Claude settings, whatever the runner does.
     */
    async function runSwitchPass(trigger, session, answer, flip) {
        let envLines = [];
        try {
            const state = answer.kind === 'known' ? answer.state : null;
            const switchAnswer = state === 'ended' || state === 'never' ? state : state !== null && ENTITLED.has(state) ? 'entitled' : 'unknown';
            const target = switchAnswer === 'entitled' ? 'pro' : switchAnswer === 'unknown' ? null : 'basic';
            // The kill switch is read only where a downgrade can happen (the runner's trigger gate, rule 5), so an ordinary entitled
            // pass makes no extra manifest request; a failed read is `unread` (C-10).
            const downgrade = (switchAnswer === 'ended' || switchAnswer === 'never') && flip.settled && target === 'basic';
            if (downgrade)
                envLines = await dropCorpusUrl();
            const kill = downgrade ? await fetchKillSwitch(d.api, session).catch(() => 'unread') : 'unread';
            // F-16360: the runner stamps lastRun and killSwitch with the service's own clock, not the wall clock.
            const outcome = await (d.runSwitch ?? runSwitch)({ paths: d.paths, trigger, answer: switchAnswer, flip: { settled: flip.settled, target, changed: flip.changed }, kill }, { now: () => d.now().getTime() });
            const dk = d.desktop ?? { run: createExecRunner(), env: process.env, homedir: homedir() };
            const shortcut = { platform: d.platform, platformKey: d.platformKey ?? `${d.platform}-${process.arch}`, paths: d.paths, run: dk.run, env: dk.env, homedir: dk.homedir, ...(dk.exists ? { exists: dk.exists } : {}) };
            const lines = [...outcome.lines];
            if (outcome.switchedRoots.length > 0)
                lines.push(...(await applyShortcutAfterSwitch({ paths: d.paths, outcome, shortcut, kind: 'switch' })));
            if (outcome.reenabledRoots.length > 0)
                lines.push(...(await applyShortcutAfterSwitch({ paths: d.paths, outcome, shortcut, kind: 'reenable' })));
            return [...lines, ...envLines];
        }
        catch (e) {
            d.log(`switch runner failed: ${e.message}`);
            return envLines;
        }
    }
    /**
     * `full` is today's pass. `full: false` is the degraded answer (F-16076 C4): it reads only, so it writes nothing (no
     * token renewal, no session clear, no reconcileEditions, recordOutcome, reportDevice or switch pass), and it ends with
     * BUSY_STATUS. Its switch and edition lines come from the saved state, as the full pass's do.
     */
    async function status(full) {
        const lines = [];
        if (startReport !== null) {
            lines.push(startReport);
            startReport = null;
        }
        if (login.status === 'pending')
            lines.push(pendingText(login));
        if (login.status === 'done' || login.status === 'failed') {
            lines.push(login.message);
            login = { status: 'idle' };
        }
        let flipText = null;
        let reachable = false;
        let corpusVersion = null;
        const session = await d.secrets.get();
        if (!session) {
            lines.push(`Not signed in. ${NEEDS_LOGIN}.`);
        }
        else {
            const answer = await readAccount(d.api, session);
            reachable = answer.kind === 'known';
            if (answer.kind === 'known')
                lastOk = d.now().toISOString();
            if (answer.kind === 'known') {
                lines.push(`Account ${answer.me.email}, plan ${planLabel(answer.me)}. Credential stored in ${d.secrets.where}.`);
                if (full) {
                    const token = await ensureToken(session, answer.me).catch((e) => {
                        lines.push(e.message);
                        return null;
                    });
                    const exp = token ? tokenExpiry(token) : null;
                    if (token)
                        lastOk = d.now().toISOString();
                    if (token && isEntitled(answer.me))
                        corpusVersion = await corpusOf(token);
                    if (exp)
                        lines.push(`Pro token valid until ${day(exp)}; it renews automatically.`);
                }
                else {
                    // F-16076 C4: the degraded answer reads the saved token and renews nothing; the line shows only an unexpired token.
                    const token = await readToken(d.paths);
                    const exp = token ? tokenExpiry(token) : null;
                    if (token && exp && exp.getTime() > d.now().getTime()) {
                        if (isEntitled(answer.me))
                            corpusVersion = await corpusOf(token);
                        lines.push(`Pro token valid until ${day(exp)}; it renews automatically.`);
                    }
                }
            }
            else if (answer.reason === 'unauthenticated' && full) {
                await d.secrets.clear();
            }
            if (full) {
                const flip = await reconcileEditions({
                    trigger: 'status',
                    answer,
                    run: d.runClaude,
                    paths: d.paths,
                    getToken: answer.kind === 'known' ? () => ensureToken(session, answer.me) : undefined,
                });
                await recordOutcome(answer, flip);
                if (flip.changed)
                    await reportDevice(session);
                flipText = flip.answer;
                const switchLines = await runSwitchPass('status', session, answer, flip);
                if (switchLines.length > 0)
                    flipText = insertBeforeNextSession(flipText, switchLines.join('\n'));
                if (answer.kind === 'unknown' && answer.reason === 'network')
                    flipText += '\nPhanOS keeps working offline until the saved token expires.';
            }
        }
        const state = await readLocalState(d.paths);
        // P-3 (section 5, section 9): the full pass runs the grace reconcile and the one manifest request; the degraded pass only reads.
        if (full)
            await reconcileContent();
        const contentLines = await contentStatusLines(contentDeps(), { probe: full });
        const sessionLines = await sessionStatusLines({ paths: d.paths, env: d.env ?? process.env, coordRole: d.coordRole });
        lines.push(installedLine(state), ...statusBlocks(state, reachable, corpusVersion, contentLines, sessionLines));
        if (flipText)
            lines.push(flipText);
        if (!full)
            lines.push(BUSY_STATUS);
        return lines.join('\n');
    }
    /**
     * F-16076 C6 / F-16138: phanos_status never hangs. The full pass waits at most lockWait('status') ms in this process's
     * queue; past that bound, while the pass has not started, it is abandoned and the read-only answer is given at once.
     * A pass that has started is awaited: its own lock wait (in `locked`) is bounded by the same figure.
     */
    async function boundedStatus() {
        let started = false;
        let abandoned = false;
        const full = serial(async () => {
            if (abandoned)
                return null;
            started = true;
            return await locked('status', () => status(true), () => status(false));
        });
        let timer;
        const timedOut = new Promise((resolve) => {
            timer = setTimeout(() => resolve(undefined), lockWait('status'));
        });
        try {
            const first = await Promise.race([full, timedOut]);
            if (first === undefined && !started) {
                abandoned = true;
                return await status(false);
            }
            return (await full) ?? (await status(false));
        }
        finally {
            clearTimeout(timer);
        }
    }
    const releaseEnv = () => ({
        mcpVersion: d.mcpVersion ?? MCP_VERSION,
        nodeVersion: process.version,
        platformKey: d.platformKey ?? `${d.platform}-${process.arch}`,
        acceptSchema1: ACCEPT_SCHEMA_1,
    });
    /** Is this edition already at the release's version, with a tree on disk and (schema 2) the signed list it was installed from? */
    async function isCurrent(edition, release, state, onDisk) {
        if (state[edition]?.version !== release.version || !onDisk[edition])
            return false;
        if (!release.plugin.files)
            return true;
        try {
            return sha256(await readFile(d.paths.marketplace[edition].filesList)) === release.plugin.files.sha256;
        }
        catch {
            return false;
        }
    }
    /** Is the Pro UI of this release missing or at another version (the state record, the `ui/current` pointer and its folder all agree)? */
    async function uiBehind(release, state) {
        if (!release.ui)
            return false;
        if (state.ui?.version !== release.version || state.ui.platform !== release.ui.platform)
            return true;
        try {
            if ((await readFile(d.paths.uiCurrentFile, 'utf8')).trim() !== release.version)
                return true;
            await readdir(join(d.paths.uiDir, release.version));
            return false;
        }
        catch {
            return true;
        }
    }
    /**
     * C1 section 2.3 for every wanted edition, and no file written. Phase 1 fetches and verifies each manifest (Pro with the
     * token, Basic with the session); phase 2 downloads every artifact the install needs (the plugin, its files list, and
     * the Pro UI for this platform when it is not current) and checks size, then sha256. The UI archive is verified here and
     * kept in `Prepared`; `installUiAfterFlip` writes it after the flip (M5c).
     */
    async function verifyEditions(editions, session, token) {
        const bearerOf = (e) => {
            const bearer = e === 'pro' ? token : session;
            if (!bearer)
                throw new UserError('PhanOS Pro needs a valid entitlement token. Run phanos_status to renew it, or phanos_login to sign in again.');
            return bearer;
        };
        try {
            const state = await readLocalState(d.paths);
            const onDisk = await treesOnDisk(d.paths);
            const env = releaseEnv();
            const prepared = [];
            for (const edition of editions) {
                const signed = await d.api.getManifest(toWire(edition), bearerOf(edition));
                lastOk = d.now().toISOString(); // WE-3.04 ruling 2: a manifest answer is a successful server call too
                const release = verifyRelease(signed, d.trustedKeys, toWire(edition), env);
                prepared.push({ edition, release, current: await isCurrent(edition, release, state, onDisk) });
            }
            for (const p of prepared) {
                const { plugin, ui } = p.release;
                // The UI follows its own currency (F-9830): a current Pro whose UI is behind or missing still gets it.
                const wantUi = ui !== null && (!p.current || (await uiBehind(p.release, state)));
                if (p.current && !wantUi)
                    continue;
                const wire = toWire(p.edition);
                const bearer = bearerOf(p.edition);
                if (!p.current) {
                    p.zip = await d.api.downloadArtifact(wire, plugin.file, bearer, plugin.size);
                    checkArchive(p.zip, plugin);
                    if (plugin.files) {
                        p.filesList = await d.api.downloadArtifact(wire, plugin.files.file, bearer, plugin.files.size);
                        checkArchive(p.filesList, plugin.files);
                        parseFilesList(p.filesList, { archive: plugin.file });
                    }
                    else {
                        p.filesList = null;
                    }
                }
                if (wantUi && ui) {
                    p.uiZip = await d.api.downloadArtifact(wire, ui.file, bearer, ui.size);
                    checkArchive(p.uiZip, ui);
                }
            }
            return prepared;
        }
        catch (e) {
            throw asUserError(e);
        }
    }
    /**
     * F-9829 / M7b: the read-only local-changes check of EVERY non-current edition, before the first swap. If any edition
     * refuses, the answer (merged across editions) is thrown as a `UserError` and nothing has been written for any of them.
     */
    async function refuseLocalChanges(prepared) {
        const changes = [];
        const unchecked = [];
        for (const p of prepared) {
            if (p.current)
                continue;
            try {
                await checkLiveTree({ paths: d.paths, edition: p.edition, force: false });
            }
            catch (e) {
                if (e instanceof LocalChangesError)
                    changes.push({ edition: p.edition, changed: e.changed, added: e.added });
                else if (e instanceof UncheckableTreeError)
                    unchecked.push({ edition: p.edition, message: e.message });
                else
                    throw asUserError(e);
            }
        }
        if (changes.length === 0 && unchecked.length === 0)
            return;
        const lines = [];
        if (changes.length > 0) {
            const names = changes.flatMap((c) => [...c.changed, ...c.added].map((path) => `${LABEL[c.edition]}: ${path}`));
            lines.push('These installed PhanOS files were changed or added by hand:', ...names.slice(0, MAX_LISTED));
            if (names.length > MAX_LISTED)
                lines.push(`and ${names.length - MAX_LISTED} more`);
        }
        // The error's own message, without its closing "Nothing was changed. Use force once ..." (the force sentence follows).
        for (const u of unchecked)
            lines.push(`PhanOS ${LABEL[u.edition]}: ${u.message.replace(/ Nothing was changed\..*$/s, '')}`);
        lines.push(FORCE_SENTENCE);
        throw new UserError(lines.join('\n'));
    }
    /**
     * Writes each non-current tree (the first write of an install) and records its version as it lands. With `force` (WE-5.01 ruling 9,
     * F-16192) the trees go through installUpdateTrees as overwrite_all: each conflict is replaced and the user's bytes are kept aside
     * as .user-<stamp>; files only the user changed, and files the user added, stay. Without it, every non-current edition is checked
     * for local changes first (`refuseLocalChanges`), so one refusal writes nothing at all.
     */
    async function installTrees(prepared, force) {
        if (force)
            return (await installUpdateTrees(prepared, { decisions: {}, unattended: false, overwriteAll: true, stamp: utcStamp(d.now()) })).lines;
        await refuseLocalChanges(prepared);
        const lines = [];
        for (const p of prepared) {
            const label = `PhanOS ${LABEL[p.edition]} ${p.release.version}`;
            if (p.current) {
                lines.push(`${label} is already up to date.`);
                continue;
            }
            try {
                await installPluginTree({ paths: d.paths, edition: p.edition, version: p.release.version, zip: p.zip, filesList: p.filesList ?? null });
            }
            catch (e) {
                throw asUserError(e);
            }
            const state = await readLocalState(d.paths);
            const next = { ...state };
            next[p.edition] = { ...state[p.edition], version: p.release.version };
            await writeLocalState(d.paths, next);
            lines.push(`${label} installed (signature and checksums verified).`);
        }
        return lines;
    }
    /**
     * WE-5.01: writes each non-current tree on the update path with the user's answers. There is no `refuseLocalChanges`: the
     * three-way check of `installPluginTree` answers the conflicts. The version is recorded only after a swap, never on a refusal.
     */
    async function installUpdateTrees(prepared, answers) {
        const lines = [];
        for (const p of prepared) {
            const label = `PhanOS ${LABEL[p.edition]} ${p.release.version}`;
            if (p.current) {
                lines.push(`${label} is already up to date.`);
                continue;
            }
            let result;
            try {
                result = await installPluginTree({ paths: d.paths, edition: p.edition, version: p.release.version, zip: p.zip, filesList: p.filesList ?? null, update: answers });
            }
            catch (e) {
                throw asUserError(e);
            }
            if (result.refused)
                return { lines: [...lines, `result: refused (${result.refused})`], refused: true };
            const state = await readLocalState(d.paths);
            const next = { ...state };
            next[p.edition] = { ...state[p.edition], version: p.release.version };
            await writeLocalState(d.paths, next);
            // WE-5.01 ruling 8: the replaced files are listed under one `replaced:` line, after the other report lines.
            const report = result.report ?? [];
            const replaced = report.filter((l) => l.startsWith('replaced '));
            const shown = replaced.length > 0 ? [...report.filter((l) => !l.startsWith('replaced ')), 'replaced:', ...replaced] : report;
            lines.push(`${label} installed (signature and checksums verified).`, ...shown);
        }
        return { lines };
    }
    /**
     * M5c: runs after the flip, for a Pro whose verified UI archive was kept. The archive was verified before any write, so a
     * failure here (a locked folder, a full disk) becomes a line in the answer and leaves the plugin as it landed; the state
     * record stays unchanged, so the next update tries the UI again. An account that is not entitled never gets a Pro
     * `Prepared`, so its existing UI is left alone.
     */
    async function installUiAfterFlip(prepared) {
        const p = prepared.find((x) => x.edition === 'pro' && x.uiZip && x.release.ui);
        if (!p?.uiZip || !p.release.ui)
            return { lines: [] };
        const version = p.release.version;
        const platform = p.release.ui.platform;
        try {
            const r = await installUi({ paths: d.paths, version, platformKey: platform, zip: p.uiZip });
            const already = r.notes.find((n) => n.includes('was already installed'));
            const lines = already ? [already] : [`PhanOS UI ${version} installed (signature and checksums verified).`];
            lines.push(...r.notes.filter((n) => n !== already));
            return { lines, ui: { version, platform } };
        }
        catch (e) {
            return { lines: [`PhanOS UI ${version} could not be installed (${e.message}). The plugin is installed; run phanos_update to try the UI again.`] };
        }
    }
    /**
     * M8b: what to run by hand when the `claude` command is missing: add each marketplace folder and install its full id, Pro
     * first; with both editions Pro is the enabled one, so Basic is turned off at user scope, as the flip does. Ends with a command.
     */
    function manualRegistration(editions) {
        const cmds = editions.flatMap((e) => manualInstallCommands(d.paths.marketplace[e].dir, PLUGIN_IDS[e]));
        if (editions.length > 1)
            cmds.push(manualCommand(['plugin', 'disable', PLUGIN_IDS.basic, '--scope', 'user']));
        return ['PhanOS was not registered in Claude Code because the claude command was not found. Install it, then run these commands and start a new Claude Code session:', ...cmds.map((c) => `  ${c}`)].join('\n');
    }
    async function install(force) {
        // M8b (part 03 section 2.1, F-9529): the prerequisites come first, before the session. Their notes lead the answer, also the
        // sign-in refusal. A service built without a command runner (a test seam) skips the check.
        const pre = d.commandRunner ? await checkPrerequisites({ run: d.commandRunner, platform: d.platform }) : { blocking: [], notes: [], missing: [] };
        const lead = pre.notes;
        // F-9858: a missing `claude` is read from the structured list, never from the note's prose.
        const claudeMissing = pre.missing.includes('claude');
        // F-9859: the `claude` note promises that the plugin files are still written; a refusal writes nothing, so it leaves that note out.
        // `notes` and `missing` come from the same list in the same order.
        const refusalLead = lead.filter((_, i) => pre.missing[i] !== 'claude');
        if (pre.blocking.length > 0)
            throw new UserError([...refusalLead, 'Nothing was installed.'].join('\n'));
        const session = await d.secrets.get();
        if (!session)
            throw new UserError([...refusalLead, NEEDS_LOGIN].join('\n'));
        const answer = await readAccount(d.api, session);
        if (answer.kind === 'unknown')
            throw new UserError([...refusalLead, `${answer.message} Nothing was installed.`].join('\n'));
        const editions = isEntitled(answer.me) ? ['pro', 'basic'] : ['basic'];
        let token;
        try {
            token = await ensureToken(session, answer.me);
        }
        catch (e) {
            throw asUserError(e);
        }
        const prepared = await verifyEditions(editions, session, token);
        // Everything verified: from here on files are written.
        const lines = [...lead, ...(await installTrees(prepared, force))];
        for (const p of prepared)
            if (!p.current)
                lines.push(...p.release.notes);
        // F-16412: the corpus URL is a Pro artefact; a Basic-only install writes none and removes the one an older MCP wrote.
        if (editions.includes('pro')) {
            const env = await mergeClaudeEnv(d.paths.claudeConfigDir, corpusUrlEnv());
            if (env.error)
                lines.push(env.error);
        }
        else {
            lines.push(...(await dropCorpusUrl()));
        }
        // A missing `claude` cannot register or flip anything: the trees stay written and the answer ends with the manual commands.
        const flip = claudeMissing
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
            for (const e of editions)
                next[e] = { ...prior[e], registered: flip.listing?.[PLUGIN_IDS[e]] !== undefined };
            if (uiOut.ui)
                next.ui = uiOut.ui;
        });
        await reportDevice(session);
        const switchLines = await runSwitchPass('install', session, answer, flip);
        // The UI line comes before the flip answer: the next-session line stays the last line.
        let flipAnswer = flip.answer;
        if (switchLines.length > 0)
            flipAnswer = insertBeforeNextSession(flipAnswer, switchLines.join('\n'));
        // M5e: only phanos_install asks (never update), once the UI of this platform is current and no shortcut is recorded.
        // The question writes and calls nothing; a decline is not recorded, so a later install asks again.
        const proWithUi = prepared.find((x) => x.edition === 'pro' && x.release.ui);
        const uiCurrent = proWithUi !== undefined && (uiOut.ui !== undefined || !proWithUi.uiZip);
        if (flip.ok && uiCurrent && !(await readLocalState(d.paths)).shortcut)
            flipAnswer = insertBeforeNextSession(flipAnswer, SHORTCUT_QUESTION);
        lines.push(...uiOut.lines, flipAnswer);
        return lines.join('\n');
    }
    /** WE-5.01 ruling 9: `force` is the deprecated alias of `overwrite_all`; its note leads the answer, unless the refusal answers. */
    async function updateAnswer(opts) {
        const out = await update(opts);
        return opts.force === true && opts.unattended !== true ? `${FORCE_NOTE}\n${out}` : out;
    }
    async function update(opts) {
        // WE-5.01 ruling 9: refused before any download, read or write.
        if (opts.unattended === true && (opts.overwrite_all === true || opts.force === true))
            return `result: refused (${OVERWRITE_ALL_REFUSED})`;
        const onDisk = await treesOnDisk(d.paths);
        if (!onDisk.pro && !onDisk.basic)
            return 'PhanOS is not installed yet. Run phanos_install.';
        const session = await d.secrets.get();
        if (!session)
            throw new UserError(NEEDS_LOGIN);
        const answer = await readAccount(d.api, session);
        if (answer.kind === 'unknown') {
            // §4 "any / unknown": no manifest, no download, no flip; a both-enabled state is reported, never repaired.
            return (await reconcileEditions({ trigger: 'update', answer, run: d.runClaude, paths: d.paths })).answer;
        }
        const entitled = isEntitled(answer.me);
        let token = null;
        if (entitled && onDisk.pro) {
            try {
                token = await ensureToken(session, answer.me);
            }
            catch (e) {
                throw asUserError(e);
            }
        }
        // Only editions already on disk are updated; an account that is not entitled never requests the Pro manifest.
        const editions = ['pro', 'basic'].filter((e) => onDisk[e] && (e === 'basic' || entitled));
        const prepared = await verifyEditions(editions, session, token);
        const decisions = opts.decisions ?? {};
        const unattended = opts.unattended === true;
        const overwriteAll = opts.overwrite_all === true || opts.force === true;
        const answers = { decisions, unattended, overwriteAll, stamp: utcStamp(d.now()) };
        // WE-5.01 ruling 7: a first call (no decisions, unattended, overwrite_all or force) dry-runs every non-current edition
        // before the first swap, and answers with the conflicts of all of them once; nothing is swapped or written.
        if (Object.keys(decisions).length === 0 && !unattended && !overwriteAll) {
            const rels = new Set();
            for (const p of prepared) {
                if (p.current)
                    continue;
                try {
                    const check = await installPluginTree({ paths: d.paths, edition: p.edition, version: p.release.version, zip: p.zip, filesList: p.filesList ?? null, update: answers, dryRun: true });
                    for (const rel of check.conflicts ?? [])
                        rels.add(rel);
                }
                catch (e) {
                    throw asUserError(e);
                }
            }
            if (rels.size > 0)
                return conflictAnswer([...rels].sort());
        }
        const changed = prepared.some((p) => !p.current);
        const written = await installUpdateTrees(prepared, answers);
        if (written.refused)
            return written.lines.join('\n');
        const lines = written.lines;
        if (changed) {
            for (const p of prepared)
                if (!p.current)
                    lines.push(...p.release.notes);
        }
        else {
            lines.length = 0;
            if (prepared.length > 0)
                lines.push(`PhanOS is up to date (${prepared.map((p) => `${LABEL[p.edition]} ${p.release.version}`).join(', ')}).`);
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
        const switchLines = await runSwitchPass('update', session, answer, flip);
        lines.push(...uiOut.lines, switchLines.length > 0 ? insertBeforeNextSession(flip.answer, switchLines.join('\n')) : flip.answer);
        if (changed) {
            // An update that wrote a tree ends with the next-session line even when the flip had nothing to do.
            const enabled = (await readLocalState(d.paths)).enabled ?? (entitled && onDisk.pro ? 'pro' : 'basic');
            if (lines.at(-1)?.trimEnd().split('\n').at(-1) !== nextSessionLine(enabled))
                lines.push(nextSessionLine(enabled));
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
    async function logout() {
        const session = await d.secrets.get();
        const onDisk = await treesOnDisk(d.paths);
        let basicError = null;
        let flip = null;
        if (onDisk.pro || onDisk.basic) {
            try {
                // (1) Basic first, while the session still exists.
                if (onDisk.pro && !onDisk.basic) {
                    if (!session)
                        throw new UserError('there is no signed-in session to download it with.');
                    await installTrees(await verifyEditions(['basic'], session, null), false);
                    // A new tree is not yet known to Claude Code: register it so the flip finds it installed.
                    if ((await listPlugins(d.runClaude))?.[PLUGIN_IDS.basic] === undefined) {
                        const registered = await executeInstallRegistration(['basic'], d.runClaude, d.paths);
                        if (!registered.ok)
                            throw new UserError('the Claude Code plugin list does not show it after the install.');
                    }
                }
            }
            catch (e) {
                basicError = e.message;
            }
            // (2) Enable Basic, then disable Pro; skipped when Basic could not be put on disk.
            if (basicError === null) {
                try {
                    flip = await reconcileEditions({ trigger: 'logout', answer: null, run: d.runClaude, paths: d.paths });
                    noteListing(flip.listing); // WE-3.04 ruling 1: the logout flip's listing fixes the loaded edition too
                }
                catch (e) {
                    basicError = e.message;
                }
            }
        }
        // F-9990: the structured result says whether the listing confirms Basic on and Pro off; the prose is never read.
        const flipped = flip !== null && flip.ok && flip.settled;
        // (3) The device slot is freed and the account fields are cleared.
        const state = await readLocalState(d.paths);
        if (session && state.deviceId)
            await d.api.deleteDevice(session, state.deviceId).catch(() => undefined);
        await d.secrets.clear();
        await deleteToken(d.paths);
        const next = { ...state, email: undefined, deviceId: undefined, tokenExpiresAt: undefined };
        if (flipped)
            next.enabled = 'basic';
        // (3b) Only the shortcut the MCP recorded, by its recorded path.
        let shortcutNote = null;
        if (state.shortcut) {
            const removed = await removeShortcut(state.shortcut.path);
            if (!removed.removed && removed.reason !== 'missing')
                shortcutNote = `The desktop shortcut at ${state.shortcut.path} was not removed: ${removed.message ?? 'it could not be deleted'}`;
            next.shortcut = undefined;
        }
        await writeLocalState(d.paths, next);
        // (4) The answer; the next-session line is last.
        const lines = ['Signed out. This computer was removed from your account.'];
        if (basicError !== null) {
            lines.push(`PhanOS Basic could not be installed: ${basicError}`, 'PhanOS Pro stays enabled, but it will not run without a valid token. PhanOS Basic arrives after phanos_login and phanos_install.');
        }
        else if (flipped && flip) {
            lines[0] += onDisk.pro ? ' PhanOS Basic is enabled; PhanOS Pro stays on disk.' : ' PhanOS Basic is enabled.';
            lines.push(...flip.lines.filter((l) => /also enabled at project scope/.test(l)));
        }
        else if (flip) {
            lines.push(flip.answer);
        }
        if (shortcutNote)
            lines.push(shortcutNote);
        // F-16412: Basic is the enabled edition once the flip settled, so our corpus URL goes (a value that is not ours stays).
        if (flipped)
            lines.push(...(await dropCorpusUrl()));
        if (flipped)
            lines.push(nextSessionLine('basic'));
        return lines.join('\n');
    }
    /**
     * C1 section 4 rule 6: runs after the server is listening, never downloads and never deletes. Reads the account, renews
     * the entitlement token, then runs the flip with trigger `start` (row 4's renewal included). It never throws: a failure
     * is logged. Its report is kept in memory for the next `phanos_status`; a start that found nothing to do keeps none.
     * F-16076: the launch record is not written here; `locked` writes it first, in the first pass that gets the lock (C1 section
     * 18 item 7), so a start check skipped for lack of the lock leaves it pending for the next pass.
     */
    async function runStartCheck() {
        try {
            const session = await d.secrets.get();
            if (!session) {
                await reconcileContent(); // P-3 (section 5): no session means no token to renew, so the grace may have lapsed
                return;
            }
            const answer = await readAccount(d.api, session);
            if (answer.kind === 'known') {
                try {
                    await ensureToken(session, answer.me);
                }
                catch (e) {
                    d.log(`start check: token renewal skipped: ${e.message}`);
                }
            }
            await reconcileContent(); // P-3 (section 5): after the renewal, so a token that just renewed keeps its cache
            const flip = await reconcileEditions({
                trigger: 'start',
                answer,
                run: d.runClaude,
                paths: d.paths,
                getToken: answer.kind === 'known' ? () => ensureToken(session, answer.me) : undefined,
            });
            await recordOutcome(answer, flip);
            if (flip.changed)
                await reportDevice(session);
            if (flip.changed || !flip.ok)
                startReport = flip.answer;
            // WE-3.02 ruling 14: the best-effort pointer prune runs once here, before the switch runner; a failure is logged only.
            try {
                await (d.pruneProjectPointers ?? pruneProjectPointers)(d.paths.home);
            }
            catch (e) {
                d.log(`pointer prune failed: ${e.message}`);
            }
            const switchLines = await runSwitchPass('start', session, answer, flip);
            if (switchLines.length > 0)
                startReport = [startReport ?? '', ...switchLines].filter((l) => l !== '').join('\n');
        }
        catch (e) {
            d.log(`start check failed: ${e.message}`);
        }
    }
    /**
     * M9b (C1 section 5.2 items 2 to 6): `phanos_ui` starts the UI (M9a, writes nothing); `shortcut: "create"` writes the one
     * desktop shortcut and records its path only after `createShortcut` succeeded (a refused create claims nothing, so a file
     * PhanOS did not make is never recorded and never removed); `shortcut: "remove"` deletes exactly the recorded path.
     */
    async function ui(shortcut) {
        const state = await readLocalState(d.paths);
        const platformKey = d.platformKey ?? `${d.platform}-${process.arch}`;
        if (shortcut === 'remove') {
            if (!state.shortcut)
                return 'PhanOS created no desktop shortcut, so there is nothing to remove.';
            const recorded = state.shortcut.path;
            const removed = await removeShortcut(recorded);
            // Only a failed delete keeps the record, so a later call can retry; a vanished or unusable record is dropped.
            if (!removed.removed && removed.reason === 'failed')
                return `The desktop shortcut at ${recorded} was not removed: ${removed.message ?? 'it could not be deleted'}`;
            await writeLocalState(d.paths, { ...state, shortcut: undefined });
            if (removed.removed)
                return `Removed the PhanOS desktop shortcut at ${recorded}.`;
            return removed.reason === 'missing'
                ? `The PhanOS desktop shortcut at ${recorded} was already gone; the record of it was cleared.`
                : `${removed.message ?? 'The recorded shortcut path was unusable.'} The record of it was cleared.`;
        }
        if (shortcut === 'create') {
            if (state.enabled === 'basic' || state.lastConfirmed?.state === 'never')
                return uiComesWithProText(d.apiBase);
            if (state.shortcut && existsSync(state.shortcut.path))
                return `The PhanOS desktop shortcut already exists at ${state.shortcut.path}; nothing was changed.`;
            let pointer = '';
            try {
                pointer = (await readFile(d.paths.uiCurrentFile, 'utf8')).trim();
            }
            catch {
                pointer = '';
            }
            if (pointer === '')
                return 'The PhanOS UI is not installed, so no shortcut was created. Run phanos_install, then ask for the shortcut again.';
            const dk = d.desktop ?? { run: createExecRunner(), env: process.env, homedir: homedir() };
            const made = await createShortcut({ platform: d.platform, platformKey, paths: d.paths, run: dk.run, env: dk.env, homedir: dk.homedir, ...(dk.exists ? { exists: dk.exists } : {}) });
            if (!made.ok)
                return made.message;
            await writeLocalState(d.paths, { ...(await readLocalState(d.paths)), shortcut: { path: made.path } });
            return [`Created the PhanOS desktop shortcut at ${made.path}.`, ...made.notes].join('\n');
        }
        return (await uiToolAnswer({ paths: d.paths, state, platformKey, apiBase: d.apiBase, ...(d.launchUi ? { launch: d.launchUi } : {}) })).text;
    }
    const startCheck = () => serial(() => locked('start', runStartCheck, () => d.log('start check skipped: state.json is locked by another PhanOS process')));
    return {
        login: startLogin,
        loginTask: () => task,
        /** F-16076 C6: bounded in its queue and its lock wait; the degraded answer ends with BUSY_STATUS. */
        status: boundedStatus,
        /** `force` (M7b, WE-5.01 ruling 9): overwrite_all for the install, a copy of each replaced file kept aside; no argument means `force: false`. */
        install: (opts) => serial(() => locked('install', () => install(opts?.force === true), () => BUSY_INSTALL)),
        /** P-3 (section 8): `corpus: "refresh"` runs the content refresh alone; like `content` it is outside `serial` and the state lock, the cache having its own lock. */
        update: (opts) => opts?.corpus === 'refresh' ? refreshContent(contentDeps(), d.trustedKeys) : serial(() => locked('update', () => updateAnswer(opts ?? {}), () => BUSY_UPDATE)),
        logout: () => serial(() => locked('logout', logout, () => BUSY_LOGOUT)),
        /** M9b: start the desktop UI, or create/remove the one desktop shortcut. */
        /** F-16076 C7: only a shortcut change takes the lock; starting the UI writes nothing and is never blocked. */
        ui: (opts) => serial(() => (opts?.shortcut ? locked('ui', () => ui(opts.shortcut), () => BUSY_UI) : ui(undefined))),
        startCheck,
        /** P-3: one `phanos_content` call (C-9); the trusted keys are the release-signing keys the service is built with. Outside `serial`: a skill load never waits behind an install. */
        content: (input) => loadContent(contentDeps(), input, d.trustedKeys),
        /** F-17067: the same deps the content calls use (with the token refresh), for the session runtime's `content` deps. */
        contentDeps,
        /** C1 section 18: outside `serial` on purpose; it touches no local state, so it must not wait behind an install or a slow start check. */
        feedback: (input) => sendFeedback({ getSession: () => d.secrets.get(), submit: (s, b) => d.api.submitFeedback(s, b) }, input),
    };
}
