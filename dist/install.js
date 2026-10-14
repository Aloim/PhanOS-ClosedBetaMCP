// cyphor-role: IO
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PLUGIN_NAME, toWire } from './config.js';
import { classifyThreeWay, compareTree, parseFilesList } from './files-list.js';
import { writeFileAtomic } from './fsutil.js';
import { ReleaseVerificationError } from './release.js';
import { assertSafeEntryName, safeExtract } from './unzip.js';
export class FilesInUseError extends Error {
}
/** M7a (C1 section 2.2, P-6): the live tree holds files the user changed or added; nothing was written. */
export class LocalChangesError extends Error {
    changed;
    added;
    missing;
    constructor(diff) {
        const sample = [...diff.changed, ...diff.added].slice(0, 5).join(', ');
        super(`Local changes in the installed PhanOS files (${diff.changed.length} changed, ${diff.added.length} added: ${sample}). Nothing was changed. Use force to replace them.`);
        this.name = 'LocalChangesError';
        this.changed = diff.changed;
        this.added = diff.added;
        this.missing = diff.missing;
    }
}
/** M7a: a live tree exists but there is no usable stored files list to compare it with; `force` is needed once. */
export class UncheckableTreeError extends Error {
    constructor() {
        super('The installed PhanOS files cannot be checked for local changes (no stored file list). Nothing was changed. Use force once to replace them.');
        this.name = 'UncheckableTreeError';
    }
}
export const OVERWRITE_ALL_REFUSED = 'overwrite_all needs a person at the keyboard';
const exists = (p) => fs.stat(p).then(() => true, () => false);
const isLockError = (e) => ['EBUSY', 'EPERM', 'EACCES'].includes(e.code ?? '');
async function readPluginVersion(dir) {
    try {
        return JSON.parse(await fs.readFile(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
    }
    catch {
        return null;
    }
}
/** The version of the live tree's plugin.json, or null when there is no live tree (or no usable manifest). */
async function livePluginVersion(mp) {
    return (await exists(mp.pluginDir)) ? ((await readPluginVersion(mp.pluginDir))?.version ?? null) : null;
}
const IN_USE = 'PhanOS files are in use. Close all Claude Code sessions, then run phanos_update again.';
/**
 * Moves `staged` over `live`: live goes to `previous` first, then staged takes its place.
 * A failure of the second rename puts live back. A lock (EBUSY/EPERM/EACCES) on either rename is `FilesInUseError`.
 * `previous` is left behind on success for the caller to delete; it only survives a failure if the rollback itself failed.
 */
export async function swapIntoPlace(live, staged, previous, rename = fs.rename) {
    const hadLive = await exists(live);
    if (hadLive) {
        try {
            await rename(live, previous);
        }
        catch (e) {
            if (isLockError(e))
                throw new FilesInUseError(IN_USE);
            throw e;
        }
    }
    try {
        await rename(staged, live);
    }
    catch (e) {
        if (hadLive)
            await rename(previous, live).catch(() => undefined);
        if (isLockError(e))
            throw new FilesInUseError(IN_USE);
        throw e;
    }
}
/** A version becomes a directory name inside staging, so it may hold no separator and no dot-only segment. */
function safeTag(version) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version) || version.includes('..')) {
        throw new ReleaseVerificationError(`Unsafe release version ${JSON.stringify(version)}. Nothing was installed.`);
    }
    return version;
}
/** Writes `<marketplace>/.claude-plugin/marketplace.json` for one edition (the install). */
export async function writeMarketplaceManifest(mp, edition, version) {
    const label = edition === 'pro' ? 'Pro' : 'Basic';
    const body = {
        name: mp.name,
        owner: { name: 'PhanOS' },
        plugins: [{ name: PLUGIN_NAME, source: `./${PLUGIN_NAME}`, description: `PhanOS ${label} ${version}` }],
    };
    await writeFileAtomic(mp.marketplaceJson, `${JSON.stringify(body, null, 2)}\n`);
}
/**
 * F-9829 / M7a: the read-only local-changes pre-check of one edition's live tree; `installPluginTree` and M7b's update both use it.
 * `null` when there is no live tree. A live tree without a usable stored list throws `UncheckableTreeError` unless `force`
 * (then an empty comparison flagged `uncheckable`). Changed or added files throw `LocalChangesError` unless `force`; missing
 * files never block. Writes nothing.
 */
export async function checkLiveTree(opts) {
    const mp = opts.paths.marketplace[opts.edition];
    if (!(await exists(mp.pluginDir)))
        return null;
    const stored = await readStoredList(mp.filesList);
    if (!stored) {
        if (!opts.force)
            throw new UncheckableTreeError();
        return { changed: [], added: [], missing: [], uncheckable: true };
    }
    const local = await compareTree(mp.pluginDir, stored);
    // Missing files never block: the update restores them.
    if (local.changed.length + local.added.length > 0 && !opts.force)
        throw new LocalChangesError(local);
    return local;
}
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
/**
 * C-8 / UC9: the name of a side copy under `user/update`: the release-relative path, lower-case, with no colon; a segment whose
 * base name (before its first dot) is a Windows reserved name gets a `_` after the base; `.<suffix>` ends the last segment.
 * Refuses an unsafe rel by the same rule as `safeExtract`.
 * provisional decision: lower-case the whole name, so names that differ only by case cannot collide on a case-folding volume;
 * alternative: keep the release's case and sanitise only reserved names and colons.
 */
export function sideCopyName(rel, suffix) {
    assertSafeEntryName(rel);
    const segments = rel
        .toLowerCase()
        .replace(/:/g, '_')
        .split('/')
        .map((seg) => {
        const dot = seg.indexOf('.');
        const base = dot < 0 ? seg : seg.slice(0, dot);
        return WINDOWS_RESERVED.test(base) ? `${base}_${seg.slice(base.length)}` : seg;
    });
    segments[segments.length - 1] += `.${suffix}`;
    return segments.join('/');
}
/** UTC `yyyymmdd-hhmmss`: the stamp of one update's side-copy folder. */
export function utcStamp(d) {
    const two = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}-${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`;
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
/** sha256 (hex) of every file under `dir`, keyed by its forward-slash path: the disk read of the three-way check. */
async function hashTree(dir, rel = '', out = new Map()) {
    const entries = await fs.readdir(rel === '' ? dir : join(dir, ...rel.split('/')), { withFileTypes: true });
    for (const entry of entries) {
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
            await hashTree(dir, childRel, out);
            continue;
        }
        out.set(childRel, await fs.readFile(join(dir, ...childRel.split('/'))).then(sha, () => ''));
    }
    return out;
}
/** WE-5.01: the three-way classes of one live tree (S stored list, N release list or the staged hashes, D disk). Reads only. */
async function classifyUpdate(mp, stagedTree, list) {
    const stored = await readStoredList(mp.filesList);
    const storedMap = stored ? new Map(stored.files.map((f) => [f.path, f.sha256])) : null;
    const next = list ? new Map(list.files.map((f) => [f.path, f.sha256])) : await hashTree(stagedTree);
    const disk = (await exists(mp.pluginDir)) ? await hashTree(mp.pluginDir) : new Map();
    return { classes: classifyThreeWay(storedMap, next, disk), next };
}
/** C-8 / UC9: one side copy, written atomically (folders 0700 and files 0600 on POSIX); recorded in no manifest. */
async function writeSideCopy(paths, edition, stamp, rel, suffix, bytes) {
    const target = join(paths.home, 'user', 'update', stamp, `plugin-${edition}`, ...sideCopyName(rel, suffix).split('/'));
    await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFileAtomic(target, bytes, 0o600);
    return target;
}
/**
 * WE-5.01: writes what the answers decided, into the staged tree and the side copies, before the swap. Returns the report
 * lines in byte order of the rels. A `carried` file is copied in; a `kept` file keeps the user's bytes (no copy); a conflict
 * is decided by `overwriteAll`, then `decisions`, then `unattended` (keep); an undecided one keeps the user's bytes.
 * provisional decision: an explicit decision wins over `unattended`; `overwriteAll` wins over both.
 */
async function applyUpdate(args) {
    const { paths, edition, version, mp, stagedTree, classes, next, update } = args;
    const report = [];
    const liveAbs = (rel) => join(mp.pluginDir, ...rel.split('/'));
    const stagedAbs = (rel) => join(stagedTree, ...rel.split('/'));
    const putStaged = async (rel, bytes) => {
        await fs.mkdir(dirname(stagedAbs(rel)), { recursive: true });
        await fs.writeFile(stagedAbs(rel), bytes);
    };
    for (const [rel, cls] of classes) {
        if (cls === 'carried') {
            await putStaged(rel, await fs.readFile(liveAbs(rel)));
            report.push(`carried over: ${rel} (added by hand)`);
        }
        else if (cls === 'kept') {
            await putStaged(rel, await fs.readFile(liveAbs(rel)));
            report.push(`kept: ${rel} (changed by hand; this release does not change it)`);
        }
        else if (cls === 'conflict') {
            const decision = update.overwriteAll ? 'overwrite' : (update.decisions?.[rel] ?? (update.unattended ? 'keep' : undefined));
            const userBytes = await fs.readFile(liveAbs(rel));
            const releaseHas = next.has(rel);
            if (decision === 'overwrite') {
                const copy = await writeSideCopy(paths, edition, update.stamp, rel, `user-${update.stamp}`, userBytes);
                report.push(`replaced ${rel}; your version is at ${copy}`);
            }
            else if (decision === 'keep' && releaseHas) {
                const copy = await writeSideCopy(paths, edition, update.stamp, rel, `new-${version}`, await fs.readFile(stagedAbs(rel)));
                await putStaged(rel, userBytes);
                report.push(`kept your version of ${rel}; the release's version is at ${copy}`);
            }
            else {
                // undecided, or kept where the release has no such file: the user's bytes stay
                await putStaged(rel, userBytes);
                report.push(`left as is: ${rel}`);
            }
        }
    }
    return report;
}
/**
 * C1 section 5: installs one edition's plugin tree at `marketplaces/phanos-<edition>/phanos` by staging swap.
 * The tree is extracted and checked under `<home>/staging` (same volume) and only then renamed into place, so a half-written
 * tree never goes live. `filesList` is the already-verified list bytes; `null` skips the per-file check (schema 1 beta releases).
 * WE-5.01: with `update`, the live tree is compared three-way (no `checkLiveTree`). On a first call that finds a conflict nothing
 * is swapped or written and the conflicts are returned; a second call applies the answers (see `InstallUpdate`).
 */
export async function installPluginTree(opts) {
    const { paths, edition, version, zip, filesList, force, update, dryRun } = opts;
    const rename = opts.rename ?? fs.rename;
    const tag = safeTag(version);
    const mp = paths.marketplace[edition];
    if (update && !/^\d{8}-\d{6}$/.test(update.stamp)) {
        throw new ReleaseVerificationError(`Unsafe update stamp ${JSON.stringify(update.stamp)}. Nothing was installed.`);
    }
    if (update?.unattended && update.overwriteAll)
        return { previousVersion: await livePluginVersion(mp), refused: OVERWRITE_ALL_REFUSED };
    const stagingRoot = join(paths.stagingDir, `${edition}-${tag}`);
    const stagedTree = join(stagingRoot, PLUGIN_NAME);
    const previous = join(paths.stagingDir, `${edition}-${tag}-previous`);
    await fs.mkdir(paths.stagingDir, { recursive: true });
    await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.rm(previous, { recursive: true, force: true });
    try {
        await safeExtract(zip, stagedTree, { keepExecBit: true });
        const plugin = await readPluginVersion(stagedTree);
        if (plugin?.name !== PLUGIN_NAME || plugin.version !== version) {
            throw new ReleaseVerificationError(`Package contents (${plugin?.name} ${plugin?.version}) do not match the signed manifest (phanos ${version}). Nothing was installed.`);
        }
        let list = null;
        if (filesList) {
            list = parseFilesList(filesList, { archive: `phanos-${toWire(edition)}-${version}.zip` });
            const diff = await compareTree(stagedTree, list);
            if (diff.changed.length + diff.added.length + diff.missing.length > 0) {
                const sample = [...diff.changed, ...diff.added, ...diff.missing].slice(0, 5).join(', ');
                throw new ReleaseVerificationError(`Package contents differ from the signed file list (${diff.changed.length} changed, ${diff.added.length} added, ${diff.missing.length} missing: ${sample}). Nothing was installed.`);
            }
        }
        let previousVersion;
        let replaced;
        let conflicts = [];
        let report = [];
        if (update) {
            const { classes, next } = await classifyUpdate(mp, stagedTree, list);
            previousVersion = await livePluginVersion(mp);
            conflicts = [...classes].filter(([, c]) => c === 'conflict').map(([rel]) => rel);
            if (dryRun)
                return { previousVersion, conflicts };
            const firstCall = !update.unattended && !update.overwriteAll && Object.keys(update.decisions ?? {}).length === 0;
            if (firstCall && conflicts.length > 0)
                return { previousVersion, conflicts };
            report = await applyUpdate({ paths, edition, version, mp, stagedTree, classes, next, update });
        }
        else {
            const local = await checkLiveTree({ paths, edition, force });
            previousVersion = local ? ((await readPluginVersion(mp.pluginDir))?.version ?? null) : null;
            if (local && force && !local.uncheckable)
                replaced = { changed: local.changed, added: local.added, missing: local.missing };
        }
        await fs.mkdir(mp.dir, { recursive: true });
        await swapIntoPlace(mp.pluginDir, stagedTree, previous, rename);
        await writeMarketplaceManifest(mp, edition, version);
        if (filesList)
            await writeFileAtomic(mp.filesList, filesList);
        else
            await fs.rm(mp.filesList, { force: true });
        await fs.rm(previous, { recursive: true, force: true }).catch(() => undefined);
        const result = { previousVersion };
        if (replaced)
            result.replaced = replaced;
        if (conflicts.length > 0)
            result.conflicts = conflicts;
        if (report.length > 0)
            result.report = report;
        return result;
    }
    finally {
        await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}
/** The stored list of the installed tree, or null when absent or unusable (then the tree cannot be checked). */
async function readStoredList(file) {
    try {
        const bytes = await fs.readFile(file);
        const archive = JSON.parse(bytes.toString('utf8')).archive;
        return parseFilesList(bytes, { archive: typeof archive === 'string' ? archive : '' });
    }
    catch {
        return null;
    }
}
