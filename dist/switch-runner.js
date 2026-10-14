// WE-3.02 switch runner (run 20261012-es-we, wave B): the start-time downgrade pass over the C-6 engine,
// gated by the C-10 kill switch. Implements WE-3.02-3.03 rulings 1-3, 5-10 (ruling 3 reenable, ruling 8 the held
// breaker, ruling 10 the state lock). The real-engine contract rows live in tests/switch-runner.test.ts.
import { execFile } from 'node:child_process';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readLocalState, StateLockBusyError, withStateLock, writeLocalState } from './state.js';
import { createShortcut, removeShortcut } from './shortcut.js';
const ENGINE_REL = join('Phanes', 'switch', 'edition-switch.js');
const ENGINE_PKG_REL = join('Phanes', 'switch', 'package.json');
const ENGINE_RESULT_FAIL = 'fail (engine output)';
// PROVISIONAL, F-16075: the shortcut change is not retried by a later pass, so it waits briefly for the lock.
const SHORTCUT_LOCK_WAIT_MS = 10_000;
/**
 * Runs the start-time downgrade pass (WE-3.02). Never throws: an error inside the pass comes back as a
 * `fail (...)` line. Logout returns at once with nothing recorded.
 * @param input the calling pass's facts (see {@link SwitchInput})
 * @param deps optional seams (see {@link SwitchDeps}); tests drive the real child process through `runEngine`
 * @returns the answer lines and the switched and reenabled roots, and `ran` true when the engine was spawned
 */
export async function runSwitch(input, deps = {}) {
    const outcome = { lines: [], switchedRoots: [], reenabledRoots: [], ran: false };
    if (input.trigger === 'logout')
        return outcome;
    const env = deps.env ?? process.env;
    const resolved = {
        runEngine: deps.runEngine ?? defaultRunEngine(env),
        now: deps.now ?? Date.now,
        env,
    };
    try {
        // ruling 10: the whole pass (engine run and state writes) holds state.json.lock; a busy lock writes nothing.
        return await withStateLock(input.paths, () => runPass(input, resolved, outcome), { waitMs: 0 });
    }
    catch (err) {
        if (err instanceof StateLockBusyError) {
            outcome.lines.push('skip (switch running in another session)');
            return outcome;
        }
        outcome.lines.push(`fail (${err instanceof Error ? err.message : String(err)})`);
        return outcome;
    }
}
/** The pass body: the reenable gate (rule 3), the kill switch, the trigger gate, the engine presence and work checks, the run, the record. */
async function runPass(input, deps, out) {
    const at = Math.floor(deps.now() / 1000);
    const { paths } = input;
    if (isReenableGate(input))
        return runReenable(input, deps, at, out);
    if (input.kill === 'unread')
        return out;
    if (!isGateOpen(input)) {
        await commitPass(paths, (s) => setKill(s, input.kill, at));
        return out;
    }
    if (input.kill === 'off')
        return recordKillOff(input, at, out);
    const enginePath = join(paths.marketplace.pro.pluginDir, ENGINE_REL);
    if (!(await exists(enginePath))) {
        const lastRun = { at, engineVersion: 'missing', result: 'skip (engine missing)' };
        await commitPass(paths, (s) => {
            setKill(s, input.kill, at);
            s.switch = { ...(s.switch ?? {}), lastRun };
        });
        out.lines.push('skip (engine missing)');
        return out;
    }
    const engineVersion = await readEngineVersion(paths);
    const current = await readLocalState(paths);
    if (!hasWork(current.switch, input, engineVersion)) {
        await commitPass(paths, (s) => setKill(s, 'on', at));
        return out;
    }
    if (engineHeld(current.switch, engineVersion)) {
        out.lines.push('skip (engine held)');
        return out;
    }
    const currentRoot = currentRootOf(input, deps.env);
    const args = [enginePath, 'downgrade-all', '--home', paths.home, '--json', '--current-root', currentRoot];
    const run = await deps.runEngine(args);
    out.ran = true;
    const report = parseReport(run.stdout);
    if (report === null) {
        const lastRun = { at, engineVersion, result: ENGINE_RESULT_FAIL };
        await commitPass(paths, (s) => {
            setKill(s, 'on', at);
            s.switch = { ...(s.switch ?? {}), lastRun };
        });
        out.lines.push(ENGINE_RESULT_FAIL);
        return out;
    }
    return recordReport(report, { at, engineVersion, currentRoot }, input, out);
}
/** The trigger gate (rule 5): answer ended or never, the flip settled to basic. The kill switch is checked by the caller. */
function isGateOpen(input) {
    return (input.answer === 'ended' || input.answer === 'never') && input.flip.settled && input.flip.target === 'basic';
}
/** The reenable gate (rule 3): answer entitled and a settled flip back to pro. Never gated by the kill switch. */
function isReenableGate(input) {
    return input.answer === 'entitled' && input.flip.settled && input.flip.target === 'pro';
}
/** Ruling 8: the recorded held version blocks that disk version and any older one; a newer disk version is not held. */
function engineHeld(sw, engineVersion) {
    const held = sw?.heldEngineVersion;
    return typeof held === 'string' && compareVersions(engineVersion, held) <= 0;
}
/**
 * Rule 3: one `reenable --root` spawn per pointer whose switch state is `switched`, under the breaker. A held
 * report stops the batch; the held version is recorded, and a run that completes without the breaker clears it.
 */
async function runReenable(input, deps, at, out) {
    const { paths } = input;
    const switched = (await readPointers(paths.home)).filter((p) => p.switchState === 'switched');
    if (switched.length === 0)
        return out;
    const enginePath = join(paths.marketplace.pro.pluginDir, ENGINE_REL);
    if (!(await exists(enginePath))) {
        out.lines.push('skip (engine missing)');
        return out;
    }
    const engineVersion = await readEngineVersion(paths);
    const current = await readLocalState(paths);
    if (engineHeld(current.switch, engineVersion)) {
        out.lines.push('skip (engine held)');
        return out;
    }
    const currentRoot = currentRootOf(input, deps.env);
    let held = false;
    for (const p of switched) {
        const run = await deps.runEngine([enginePath, 'reenable', '--root', p.root, '--home', paths.home, '--json', '--current-root', currentRoot]);
        out.ran = true;
        const report = parseReport(run.stdout);
        if (report === null) {
            out.lines.push(`${p.root}: ${ENGINE_RESULT_FAIL}`);
            continue;
        }
        foldLines(report, currentRoot, out);
        if (report.held) {
            held = true;
            break;
        }
    }
    await commitPass(paths, (s) => {
        setKill(s, input.kill, at);
        s.switch = { ...(s.switch ?? {}), heldEngineVersion: held ? engineVersion : null };
    });
    return out;
}
/** Work exists: this pass changed the flip, something is pending, no run was recorded, or the recorded engine is older. */
function hasWork(sw, input, engineVersion) {
    if (input.flip.changed)
        return true;
    if ((sw?.pending?.length ?? 0) > 0)
        return true;
    if (sw?.lastRun === undefined)
        return true;
    return compareVersions(sw.lastRun.engineVersion, engineVersion) < 0;
}
/** Kill switch off (rule 5, rule 6): no spawn; every pro pointer not switched goes to pending with reason `switch off`. */
async function recordKillOff(input, at, out) {
    const pointers = await readPointers(input.paths.home);
    const held = pointers.filter((p) => p.edition === 'pro' && p.switchState !== 'switched');
    await commitPass(input.paths, (s) => {
        setKill(s, 'off', at);
        const sw = { ...(s.switch ?? {}) };
        const reasons = { ...reasonsOf(sw), ...Object.fromEntries(held.map((p) => [p.installId, 'switch off'])) };
        sw.pending = dedupe([...(sw.pending ?? []), ...held.map((p) => p.installId)]);
        sw.pendingReasons = reasons;
        s.switch = sw;
    });
    out.lines = held.map((p) => `${normalizeRoot(p.root)}: pending (switch off)`);
    return out;
}
/** Folds the engine's report into the answer lines (rule 7) and records lastRun and the pending set. */
async function recordReport(report, run, input, out) {
    const { pending, reasons } = foldLines(report, run.currentRoot, out);
    const lastRun = { at: run.at, engineVersion: run.engineVersion, result: report.result ?? ENGINE_RESULT_FAIL };
    // ruling 8: a report that held the breaker records this version; a report without the breaker clears any hold.
    await commitPass(input.paths, (s) => {
        setKill(s, input.kill, run.at);
        s.switch = {
            ...(s.switch ?? {}),
            lastRun,
            pending: dedupe(pending),
            pendingReasons: reasons,
            heldEngineVersion: report.held ? run.engineVersion : null,
        };
    });
    return out;
}
/** Folds a report's projects into the answer lines (rule 7) and the reenabled or switched roots; returns the pending set. */
function foldLines(report, currentRoot, out) {
    const current = normalizeRoot(currentRoot);
    const pending = [];
    const reasons = {};
    for (const p of report.projects.map(readProject).filter((x) => x !== null)) {
        const shown = p.root;
        const root = normalizeRoot(p.root);
        const isCurrent = root === current;
        if (p.state === 'switched') {
            out.switchedRoots.push(root);
            out.lines.push(`${shown}: switched; ${isCurrent ? 'start a new session now' : 'start a new session in that project'}`);
        }
        else if (p.state === 'reenabled') {
            out.reenabledRoots.push(root);
            out.lines.push(`${shown}: reenabled`);
        }
        else {
            out.lines.push(`${shown}: ${p.state}${p.reason ? ` (${p.reason})` : ''}`);
        }
        if (p.state === 'pending') {
            pending.push(p.installId);
            reasons[p.installId] = p.reason ?? 'unknown';
        }
    }
    return { pending, reasons };
}
/** Reads one report project; a malformed entry is dropped rather than shown. */
function readProject(raw) {
    if (!isRecord(raw))
        return null;
    const { installId, root, state, reason } = raw;
    if (typeof installId !== 'string' || typeof root !== 'string' || typeof state !== 'string')
        return null;
    return { installId, root, state, reason: typeof reason === 'string' ? reason : null };
}
/**
 * Writes the state with one fresh read (other keys kept). Ruling 10's state lock wraps this call's caller in slice 4b.
 */
async function commitPass(paths, change) {
    const state = await readLocalState(paths);
    change(state);
    await writeLocalState(paths, state);
}
/** Mirrors the kill switch as read (C-4 `killSwitch`); called only when the read gave `on` or `off`. */
function setKill(s, kill, at) {
    if (kill === 'unread')
        return;
    s.killSwitch = { downgrade: kill, fetchedAt: at };
}
/** The current session's project root (rule 2): the input override, else CLAUDE_PROJECT_DIR, else process.cwd(). Never PWD. */
function currentRootOf(input, env) {
    if (typeof input.currentRoot === 'string' && input.currentRoot !== '')
        return input.currentRoot;
    const dir = env.CLAUDE_PROJECT_DIR;
    return dir !== undefined && dir !== '' ? dir : process.cwd();
}
/** Forward slashes, drive letter upper-case; the form every root is compared in. */
export function normalizeRoot(root) {
    return root.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (_m, d) => `${d.toUpperCase()}:`);
}
/** Numeric dotted-version comparison (`0.2.10` above `0.2.9`); a value that is not dotted digits sorts lowest. */
export function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (pa === null || pb === null)
        return pa === null && pb === null ? 0 : pa === null ? -1 : 1;
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0)
            return d < 0 ? -1 : 1;
    }
    return 0;
}
function parseVersion(v) {
    return /^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null;
}
/** Exactly one JSON object with a `projects` array, or null (rule 7: unparsable stdout is a failure). */
export function parseReport(stdout) {
    let value;
    try {
        value = JSON.parse(stdout.trim());
    }
    catch {
        return null;
    }
    if (!isRecord(value) || !Array.isArray(value.projects))
        return null;
    const engineVersion = typeof value.engineVersion === 'string' ? value.engineVersion : null;
    const result = typeof value.result === 'string' ? value.result : null;
    return { engineVersion, result, held: value.held === true, projects: value.projects };
}
/** Reads the engine's version from the Pro tree's package.json, before any spawn (D-1491). */
async function readEngineVersion(paths) {
    const raw = JSON.parse(await readFile(join(paths.marketplace.pro.pluginDir, ENGINE_PKG_REL), 'utf8'));
    if (!isRecord(raw) || typeof raw.version !== 'string')
        throw new Error('engine package.json has no version');
    return raw.version;
}
/** Every `<home>/projects/*\/pointer.json` (C-3); an unreadable pointer is skipped. */
async function readPointers(home) {
    let dirs;
    try {
        dirs = await readdir(join(home, 'projects'));
    }
    catch {
        return [];
    }
    const out = [];
    for (const dir of dirs) {
        try {
            const raw = JSON.parse(await readFile(join(home, 'projects', dir, 'pointer.json'), 'utf8'));
            if (!isRecord(raw) || typeof raw.installId !== 'string')
                continue;
            const root = (await firstPresentRoot(raw.roots)) ?? raw.installId;
            const sw = raw.switch;
            const switchState = isRecord(sw) && typeof sw.state === 'string' ? sw.state : 'none';
            out.push({ installId: raw.installId, root, edition: String(raw.edition), switchState });
        }
        catch {
            // an unreadable pointer is not a project to record
        }
    }
    return out;
}
/**
 * F-16109: the first named root (in record order) whose folder exists; else the first named root; else null. A root is
 * a non-empty string `root` of a record entry; the value is passed to the engine verbatim.
 */
async function firstPresentRoot(roots) {
    if (!Array.isArray(roots))
        return null;
    const named = roots.filter(isRecord).map((r) => r.root).filter((r) => typeof r === 'string' && r !== '');
    for (const r of named) {
        if ((await stat(r).catch(() => null))?.isDirectory() === true)
            return r;
    }
    return named[0] ?? null;
}
/** The default engine run: execFile of process.execPath with the argument array, no shell. */
function defaultRunEngine(env) {
    return (args) => new Promise((resolve, reject) => {
        execFile(process.execPath, args, { env, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
            if (error) {
                const code = error.code;
                if (typeof code === 'string') {
                    reject(error);
                    return;
                }
                resolve({ stdout: String(stdout), exitCode: typeof code === 'number' ? code : null });
                return;
            }
            resolve({ stdout: String(stdout), exitCode: 0 });
        });
    });
}
function reasonsOf(sw) {
    const r = sw.pendingReasons;
    return isRecord(r) ? r : {};
}
function dedupe(values) {
    return [...new Set(values)];
}
async function exists(path) {
    return access(path).then(() => true, () => false);
}
function isRecord(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/**
 * M5 (WE-3.03, ruling 12): after an edition switch, removes the desktop shortcut the MCP recorded (`state.shortcut`, only at
 * that path) and records it as `switch.shortcutRemoved`; after a reenable that restored a root, recreates the shortcut and
 * clears that key. Never throws.
 * @param args.paths the state location; `outcome` the runner's result; `kind` which half ran; `shortcut` the createShortcut deps
 * @returns the short answer lines to append; empty when nothing changed
 */
export async function applyShortcutAfterSwitch(args) {
    const { paths, outcome, shortcut, kind } = args;
    const lockOpts = { waitMs: SHORTCUT_LOCK_WAIT_MS, ...args.lock };
    try {
        if (kind === 'switch') {
            if (outcome.switchedRoots.length === 0)
                return [];
            return await withStateLock(paths, () => switchShortcut(paths), lockOpts);
        }
        if (outcome.reenabledRoots.length === 0)
            return [];
        return await withStateLock(paths, () => reenableShortcut(paths, shortcut), lockOpts);
    }
    catch (err) {
        return [`The desktop shortcut could not be updated: ${err instanceof Error ? err.message : String(err)}`];
    }
}
/** The switch half's body, run under the state lock: removes the recorded shortcut and records switch.shortcutRemoved. */
async function switchShortcut(paths) {
    const state = await readLocalState(paths);
    if (!state.shortcut)
        return [];
    const recorded = state.shortcut.path;
    const removed = await removeShortcut(recorded);
    if (!removed.removed && removed.reason !== 'missing') {
        return [`The desktop shortcut at ${recorded} was not removed: ${removed.message ?? 'it could not be deleted'}`];
    }
    const fresh = await readLocalState(paths);
    const next = removed.removed ? { ...fresh.switch, shortcutRemoved: recorded } : fresh.switch;
    await writeLocalState(paths, { ...fresh, shortcut: undefined, ...(next ? { switch: next } : {}) });
    return removed.removed
        ? ['Removed the PhanOS desktop shortcut (editions switched).']
        : [`The PhanOS desktop shortcut at ${recorded} was already gone; the record of it was cleared.`];
}
/** The reenable half's body, run under the state lock: recreates the shortcut and clears switch.shortcutRemoved. */
async function reenableShortcut(paths, shortcut) {
    const state = await readLocalState(paths);
    const removedPath = state.switch?.shortcutRemoved;
    if (typeof removedPath !== 'string' || removedPath === '')
        return [];
    const made = await createShortcut(shortcut);
    if (!made.ok)
        return [made.message];
    const fresh = await readLocalState(paths);
    await writeLocalState(paths, { ...fresh, shortcut: { path: made.path }, switch: { ...fresh.switch, shortcutRemoved: undefined } });
    return ['Restored the PhanOS desktop shortcut.', ...made.notes];
}
