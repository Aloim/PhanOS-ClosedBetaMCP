// cyphor-role: IO
import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rename as fsRename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil.js';
import { readLocalState, withStateLock, writeLocalState } from './state.js';
import { ReleaseVerificationError } from './release.js';
import { safeExtract } from './unzip.js';
/**
 * The UI archive layout agreed with PhanOS-UI (C1 §2.5, A6 closed in v1.6): the entry executable sits at the archive
 * root, so `<home>/ui/<version>/<entry>`. On Linux `phanos-ui` is a wrapper beside the Electron binary `phanos-ui-bin`.
 * A platform with no key here has no UI build (macOS, D-850).
 */
export const UI_ENTRY_BY_PLATFORM = {
    'win32-x64': 'PhanOS.exe',
    'linux-x64': 'phanos-ui',
};
/** The ruled S-4 cap per UI archive (C1 §2.5), the same one PhanOS-UI's release script enforces. */
export const UI_CAP = { zipBytes: 256 * 1024 * 1024, unpackedBytes: 768 * 1024 * 1024, entries: 2_000 };
/** C-UI1: the answer when the installed UI is older than the minimum the last installed release declared. */
export const UI_OLDER_TEXT = 'This PhanOS UI is older than your PhanOS installation needs. Run phanos_update in Claude Code, or download and replace the current UI with the one on phanos.eu.';
export function uiNotAvailableNote(platformKey) {
    return `The PhanOS UI is not available for this platform (${platformKey}); the plugin installs without it.`;
}
/** A version tag is one path segment: no separators, no traversal, and never the pointer file's own name. */
export function assertSafeVersionTag(version) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version) || version === 'current') {
        throw new Error(`Unsafe UI version tag: ${JSON.stringify(version)}. Nothing was installed.`);
    }
}
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/**
 * True when version `a` is strictly newer than `b`: numeric per core segment, a prerelease ranks below its own
 * core, two prereleases of one core compare by their tag text. Returns false when either side does not parse.
 */
export function isNewerVersion(a, b) {
    const pa = VERSION_RE.exec(a);
    const pb = VERSION_RE.exec(b);
    if (!pa || !pb)
        return false;
    for (let i = 1; i <= 3; i++) {
        const d = Number(pa[i]) - Number(pb[i]);
        if (d !== 0)
            return d > 0;
    }
    const preA = pa[4];
    const preB = pb[4];
    if (preA === undefined)
        return preB !== undefined;
    if (preB === undefined)
        return false;
    return preA.slice(1) > preB.slice(1);
}
async function readPointer(file) {
    try {
        const text = (await readFile(file, 'utf8')).trim();
        return text.length > 0 ? text : null;
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return null;
        throw e;
    }
}
async function exists(path) {
    try {
        await readdir(path);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Installs the desktop UI: extract to staging, rename the finished folder into `<home>/ui/<version>/`,
 * and only then move the `current` pointer. Keeps the new and the previously-current version, prunes
 * older ones best-effort. Never creates a shortcut and never deletes the current or previous version
 * on its own (an ended account keeps its UI).
 */
export async function installUi(opts) {
    const { paths, version, platformKey, zip } = opts;
    const doRename = opts.rename ?? fsRename;
    const writePointer = opts.writePointer ?? ((path, content) => writeFileAtomic(path, content));
    const remove = opts.remove ?? ((path) => rm(path, { recursive: true, force: true }));
    if (zip === null)
        return { version: null, platform: platformKey, pruned: [], notes: [uiNotAvailableNote(platformKey)] };
    assertSafeVersionTag(version);
    // The MCP never overwrites a newer UI the zip placed: a recorded newer version is kept, nothing is extracted or moved.
    const recordedUi = (await readLocalState(paths)).ui?.version;
    if (recordedUi && isNewerVersion(recordedUi, version)) {
        return {
            version: recordedUi,
            platform: platformKey,
            pruned: [],
            notes: [`PhanOS UI ${recordedUi} is already installed and is newer than ${version} in this release, so it stays in place.`],
        };
    }
    if (zip.length > UI_CAP.zipBytes)
        throw new ReleaseVerificationError('The UI archive is too large. Nothing was installed.');
    const notes = [];
    const target = join(paths.uiDir, version);
    const previous = await readPointer(paths.uiCurrentFile);
    if (await exists(target)) {
        // A folder under ui/ only ever appears by a completed rename, so it is complete: reuse it.
        notes.push(`The PhanOS UI ${version} was already installed.`);
    }
    else {
        const staging = join(paths.stagingDir, `ui-${version}-${process.pid}-${Date.now()}`);
        try {
            await safeExtract(zip, staging, { maxBytes: UI_CAP.unpackedBytes, maxEntries: UI_CAP.entries, keepExecBit: true });
            await mkdir(paths.uiDir, { recursive: true });
            await doRename(staging, target);
        }
        catch (e) {
            await rm(staging, { recursive: true, force: true }).catch(() => undefined);
            throw e;
        }
    }
    // The version folder is complete; only now does the pointer move.
    await writePointer(paths.uiCurrentFile, version);
    const pruned = [];
    if (previous !== version) {
        const keep = new Set([version]);
        if (previous)
            keep.add(previous);
        let entries = [];
        try {
            entries = await readdir(paths.uiDir, { withFileTypes: true });
        }
        catch {
            entries = [];
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || keep.has(entry.name))
                continue;
            try {
                await remove(join(paths.uiDir, entry.name));
                pruned.push(entry.name);
            }
            catch {
                notes.push(`Could not remove the old PhanOS UI ${entry.name} (in use?); it will be removed on a later update.`);
            }
        }
    }
    return { version, platform: platformKey, pruned, notes };
}
/** The answer the recorded version alone decides, or null when the bundle has to be installed. */
function adoptAnswer(recorded, version) {
    if (recorded === version)
        return { current: version, action: 'already-current' };
    if (recorded && isNewerVersion(recorded, version))
        return { current: recorded, action: 'kept-newer' };
    return null;
}
/**
 * Adopts a UI bundle already on disk into `<home>/ui/<version>/` by version compare only: a recorded version equal
 * to `version` is already current, a recorded newer one is kept (nothing copied or written). Otherwise the bundle is
 * copied through staging, the `current` pointer moves, and state.json `ui` records it. Prunes nothing. The commit
 * re-reads the recorded version under the state lock, so a newer record written since the early check is kept.
 */
export async function adoptUi(opts) {
    const { paths, sourceDir, version, platformKey } = opts;
    assertSafeVersionTag(version);
    // Fast path: a recorded version that already decides the answer returns before any copy.
    const early = adoptAnswer((await readLocalState(paths)).ui?.version, version);
    if (early)
        return early;
    const target = join(paths.uiDir, version);
    let staging = null;
    const discard = async () => {
        if (staging !== null)
            await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        staging = null;
    };
    try {
        if (!(await exists(target))) {
            const stage = join(paths.stagingDir, `ui-${version}-${process.pid}-${Date.now()}`);
            staging = stage;
            await mkdir(paths.stagingDir, { recursive: true });
            await cp(sourceDir, stage, { recursive: true });
        }
        await opts.beforeCommit?.();
        // The commit re-reads the recorded version under the state lock, so a newer record written since the check is kept.
        const result = await withStateLock(paths, async () => {
            const answer = adoptAnswer((await readLocalState(paths)).ui?.version, version);
            if (answer)
                return answer;
            if (staging !== null) {
                await mkdir(paths.uiDir, { recursive: true });
                await fsRename(staging, target);
                staging = null;
            }
            // The version folder is complete; only now does the pointer move, then state.json records it.
            await writeFileAtomic(paths.uiCurrentFile, version);
            const s = await readLocalState(paths);
            await writeLocalState(paths, { ...s, ui: { version, platform: platformKey } });
            return { current: version, action: 'installed' };
        });
        await discard();
        return result;
    }
    catch (e) {
        await discard();
        throw e;
    }
}
/** Starts the UI detached from the MCP process; resolves once the process exists, rejects if it could not start. */
export function launchDetached(entry, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(entry, [], { detached: true, stdio: 'ignore', cwd });
        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
}
const RUN_INSTALL = 'Run phanos_install to install it.';
/** The Basic answer of the UI tool (F-9996): the single source, so the service never duplicates the text. */
export function uiComesWithProText(apiBase) {
    return `The PhanOS UI is on your account page: ${apiBase.replace(/\/+$/, '')}/account. Without a paid plan it opens in PhanOS Basic.`;
}
/** The Pro answer when no UI is installed: phanos_update, or the download on the account page. */
function notInstalledText(apiBase) {
    return `The PhanOS UI is not installed. Run phanos_update to install it, or download it from your account page: ${apiBase.replace(/\/+$/, '')}/account`;
}
async function isFile(path) {
    try {
        return (await stat(path)).isFile();
    }
    catch {
        return false;
    }
}
/**
 * The `phanos_ui` answer (M9a): an installed UI is started detached whatever the account state (an ended
 * account sees the renew screen inside the UI). Without one: Basic gets the account-page address, a platform
 * with no build is told so, anyone else is sent to phanos_update or the account page. A pointer that names a missing folder
 * is reported and never launched; the pointer's version is checked as a path segment before it is joined.
 */
export async function uiToolAnswer(opts) {
    const { paths, state, platformKey, apiBase } = opts;
    const launch = opts.launch ?? launchDetached;
    const entryName = UI_ENTRY_BY_PLATFORM[platformKey];
    const notLaunched = (text) => ({ launched: false, version: null, text });
    const pointer = await readPointer(paths.uiCurrentFile);
    if (pointer !== null) {
        try {
            assertSafeVersionTag(pointer);
        }
        catch {
            return notLaunched(`The PhanOS UI pointer holds an unusable version (${JSON.stringify(pointer)}); it was not started. ${RUN_INSTALL}`);
        }
        // A UI below the minimum the last installed release declared is refused, never launched.
        const minimum = state.ui?.requires;
        if (typeof minimum === 'string' && isNewerVersion(minimum, pointer))
            return notLaunched(UI_OLDER_TEXT);
        const folder = join(paths.uiDir, pointer);
        if (entryName !== undefined) {
            const entry = join(folder, entryName);
            if (await isFile(entry)) {
                try {
                    await launch(entry, folder);
                }
                catch (e) {
                    return notLaunched(`The PhanOS UI ${pointer} could not be started: ${e.message}`);
                }
                return { launched: true, version: pointer, text: `Started the PhanOS UI ${pointer}.` };
            }
        }
        return notLaunched(`The PhanOS UI ${pointer} is recorded as current but is missing on disk; it was not started. ${RUN_INSTALL}`);
    }
    const basic = state.enabled === 'basic' || state.lastConfirmed?.state === 'never';
    if (basic)
        return notLaunched(uiComesWithProText(apiBase));
    if (entryName === undefined)
        return notLaunched(`The PhanOS UI is not available for this platform yet (${platformKey}).`);
    return notLaunched(notInstalledText(apiBase));
}
