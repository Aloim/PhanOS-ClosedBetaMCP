// cyphor-role: IO
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { PLUGIN_NAME, toWire } from './config.js';
import { compareTree, parseFilesList } from './files-list.js';
import { writeFileAtomic } from './fsutil.js';
import { ReleaseVerificationError } from './release.js';
import { safeExtract } from './unzip.js';
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
/**
 * C1 section 5: installs one edition's plugin tree at `marketplaces/phanos-<edition>/phanos` by staging swap.
 * The tree is extracted and checked under `<home>/staging` (same volume) and only then renamed into place, so a half-written
 * tree never goes live. `filesList` is the already-verified list bytes; `null` skips the per-file check (schema 1 beta releases).
 */
export async function installPluginTree(opts) {
    const { paths, edition, version, zip, filesList, force } = opts;
    const rename = opts.rename ?? fs.rename;
    const tag = safeTag(version);
    const mp = paths.marketplace[edition];
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
        if (filesList) {
            const list = parseFilesList(filesList, { archive: `phanos-${toWire(edition)}-${version}.zip` });
            const diff = await compareTree(stagedTree, list);
            if (diff.changed.length + diff.added.length + diff.missing.length > 0) {
                const sample = [...diff.changed, ...diff.added, ...diff.missing].slice(0, 5).join(', ');
                throw new ReleaseVerificationError(`Package contents differ from the signed file list (${diff.changed.length} changed, ${diff.added.length} added, ${diff.missing.length} missing: ${sample}). Nothing was installed.`);
            }
        }
        const local = await checkLiveTree({ paths, edition, force });
        const previousVersion = local ? ((await readPluginVersion(mp.pluginDir))?.version ?? null) : null;
        let replaced;
        if (local && force && !local.uncheckable)
            replaced = { changed: local.changed, added: local.added, missing: local.missing };
        await fs.mkdir(mp.dir, { recursive: true });
        await swapIntoPlace(mp.pluginDir, stagedTree, previous, rename);
        await writeMarketplaceManifest(mp, edition, version);
        if (filesList)
            await writeFileAtomic(mp.filesList, filesList);
        else
            await fs.rm(mp.filesList, { force: true });
        await fs.rm(previous, { recursive: true, force: true }).catch(() => undefined);
        return replaced ? { previousVersion, replaced } : { previousVersion };
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
