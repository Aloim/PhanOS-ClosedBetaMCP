// cyphor-role: CORE
import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod/v4';
export class ReleaseVerificationError extends Error {
}
/**
 * C1 section 2.4: schema 1 manifests are accepted until the first public (non-beta) release.
 * The cut-over is this one switch, flipped in the installer release that precedes the first public release.
 */
export const ACCEPT_SCHEMA_1 = true;
// Owner 2026-10-09: closed beta installs from the public GitHub mirror, not from npm.
const UPDATE_COMMAND = 'npx -y github:Aloim/PhanOS-ClosedBetaMCP';
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const Version = z.string().regex(VERSION_RE);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Size = z.number().int().positive();
const Platform = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const EditionSchema = z.enum(['free', 'pro']);
const Manifest1Schema = z.object({
    schema: z.literal(1),
    edition: EditionSchema,
    name: z.literal('phanos'),
    version: Version,
    file: z.string(),
    sha256: Sha256,
    size: Size,
    publishedAt: z.string(),
});
const FileRef = z.object({ file: z.string(), sha256: Sha256, size: Size });
const PluginArtifact = FileRef.extend({ kind: z.literal('plugin'), platform: z.literal('any'), files: FileRef });
const UiArtifact = FileRef.extend({ kind: z.literal('ui'), platform: Platform });
// Artifacts are validated one by one, per kind: an unknown kind must be skippable whatever its shape.
const Manifest2Schema = z.object({
    schema: z.literal(2),
    edition: EditionSchema,
    name: z.literal('phanos'),
    version: Version,
    publishedAt: z.string(),
    artifacts: z.array(z.looseObject({ kind: z.string() })),
    requires: z.object({ mcp: z.string().optional(), node: z.string().optional() }).optional(),
});
const MALFORMED = 'The release manifest is malformed. Nothing was installed.';
const BAD_NAME = 'The release file name does not match its manifest. Nothing was installed.';
/** Applies the C1 section 2.1 artifact rules (counts, names, the free no-UI rule). Pure. */
function interpretArtifacts(m) {
    const plugins = [];
    const uis = [];
    const notes = [];
    for (const a of m.artifacts) {
        if (a.kind === 'plugin') {
            const p = PluginArtifact.safeParse(a);
            if (!p.success)
                throw new ReleaseVerificationError(MALFORMED);
            plugins.push(p.data);
        }
        else if (a.kind === 'ui') {
            const u = UiArtifact.safeParse(a);
            if (!u.success)
                throw new ReleaseVerificationError(MALFORMED);
            uis.push(u.data);
        }
        else {
            notes.push(`Skipped an artifact of unknown kind ${JSON.stringify(a.kind.slice(0, 40))}.`);
        }
    }
    if (plugins.length !== 1)
        throw new ReleaseVerificationError('The release manifest must list exactly one plugin archive. Nothing was installed.');
    const plugin = plugins[0];
    if (plugin.file !== `phanos-${m.edition}-${m.version}.zip` || plugin.files.file !== `phanos-${m.edition}-${m.version}.files.json`)
        throw new ReleaseVerificationError(BAD_NAME);
    const platforms = new Set();
    for (const u of uis) {
        if (platforms.has(u.platform))
            throw new ReleaseVerificationError(`The release manifest lists more than one UI archive for ${u.platform}. Nothing was installed.`);
        platforms.add(u.platform);
        if (u.file !== `phanos-ui-${m.version}-${u.platform}.zip`)
            throw new ReleaseVerificationError(BAD_NAME);
    }
    if (m.edition === 'free' && uis.length > 0)
        throw new ReleaseVerificationError('A Free release must not carry a UI archive. Nothing was installed.');
    return { plugin, uis, notes };
}
/**
 * Steps 1 to 4 of C1 section 2.3 except `requires`: kid lookup, signature, parse (schema 1 or 2), edition, file names,
 * the free no-UI rule. Pure: no file-system or network effects. Seam 1 of the W/M plan: the web server imports this.
 * `requires` is checked only by the MCP, in `checkRequires`.
 */
export function verifySignedManifest(signed, keys, edition) {
    const key = keys.find((k) => k.kid === signed.signature?.kid);
    if (!key)
        throw new ReleaseVerificationError(`The release is signed with an unknown key ("${signed.signature?.kid}"). Update @phanos/mcp (${UPDATE_COMMAND}) and try again.`);
    let valid = false;
    try {
        valid = verify(null, Buffer.from(signed.manifest, 'utf8'), createPublicKey(key.publicPem), Buffer.from(signed.signature.sig, 'base64'));
    }
    catch {
        valid = false;
    }
    if (!valid)
        throw new ReleaseVerificationError('The release signature is invalid. Nothing was installed. Please report this to support@phanos.eu.');
    let raw;
    try {
        raw = JSON.parse(signed.manifest);
    }
    catch {
        throw new ReleaseVerificationError(MALFORMED);
    }
    const v1 = Manifest1Schema.safeParse(raw);
    if (v1.success) {
        const m = v1.data;
        if (m.edition !== edition)
            throw new ReleaseVerificationError(`Expected the ${edition} edition but the release is ${m.edition}. Nothing was installed.`);
        if (m.file !== `phanos-${m.edition}-${m.version}.zip`)
            throw new ReleaseVerificationError(BAD_NAME);
        return m;
    }
    const v2 = Manifest2Schema.safeParse(raw);
    if (!v2.success)
        throw new ReleaseVerificationError(MALFORMED);
    const m = v2.data;
    if (m.edition !== edition)
        throw new ReleaseVerificationError(`Expected the ${edition} edition but the release is ${m.edition}. Nothing was installed.`);
    const { plugin } = interpretArtifacts(m);
    return { ...m, file: plugin.file, sha256: plugin.sha256, size: plugin.size };
}
function parseMinimum(field, requirement) {
    const hit = /^>=(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(requirement);
    if (!hit) {
        throw new ReleaseVerificationError(`This release declares a "requires.${field}" this installer cannot read (only ">=X.Y.Z" is understood). Nothing was installed. Update it: ${UPDATE_COMMAND}`);
    }
    return [Number(hit[1]), Number(hit[2]), Number(hit[3])];
}
/** True when `have` (core triple, prerelease flag) is older than the minimum. A prerelease is older than its own core. */
function isOlder(have, min) {
    for (let i = 0; i < 3; i += 1) {
        if (have.core[i] !== min[i])
            return have.core[i] < min[i];
    }
    return have.pre;
}
function parseHave(what, text) {
    const hit = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
    if (!hit)
        throw new ReleaseVerificationError(`Cannot read ${what} version "${text}". Nothing was installed.`);
    return { core: [Number(hit[1]), Number(hit[2]), Number(hit[3])], pre: hit[4] !== undefined };
}
/**
 * C1 section 2.1 `requires`. MCP-only: the server's verifier does not call it. Schema 1 carries no `requires`.
 */
export function checkRequires(manifest, env) {
    if (manifest.schema === 1)
        return;
    const req = manifest.requires;
    if (req?.mcp !== undefined) {
        const min = parseMinimum('mcp', req.mcp);
        if (isOlder(parseHave('this installer\'s', env.mcpVersion), min)) {
            throw new ReleaseVerificationError(`This release needs @phanos/mcp ${min.join('.')} or newer. Update it: ${UPDATE_COMMAND}`);
        }
    }
    if (req?.node !== undefined) {
        const min = parseMinimum('node', req.node);
        if (isOlder(parseHave('Node.js', env.nodeVersion), min)) {
            throw new ReleaseVerificationError(`This release needs Node.js ${min.join('.')} or newer, and this is Node.js ${env.nodeVersion.replace(/^v/, '')}. Nothing was installed.`);
        }
    }
}
/**
 * Steps 1 to 4 of C1 section 2.3 in full: `verifySignedManifest`, the schema 1 switch, `requires`, and the artifact
 * the install needs. Schema 1 normalises to one plugin artifact with `files: null`.
 */
export function verifyRelease(signed, keys, wireEdition, env) {
    const m = verifySignedManifest(signed, keys, wireEdition);
    if (m.schema === 1) {
        if (!env.acceptSchema1) {
            throw new ReleaseVerificationError(`This release uses the older manifest format (schema 1), which this installer no longer accepts. Nothing was installed. Update it: ${UPDATE_COMMAND}`);
        }
        return {
            schema: 1,
            edition: m.edition,
            version: m.version,
            publishedAt: m.publishedAt,
            plugin: { file: m.file, sha256: m.sha256, size: m.size, files: null },
            ui: null,
            notes: [],
        };
    }
    checkRequires(m, env);
    const { plugin, uis, notes } = interpretArtifacts(m);
    let ui = null;
    if (m.edition !== 'free') {
        const hit = uis.find((u) => u.platform === env.platformKey);
        if (hit)
            ui = { platform: hit.platform, file: hit.file, sha256: hit.sha256, size: hit.size };
        else
            notes.push(`The PhanOS UI is not available for this platform (${env.platformKey}); the plugin installs without it.`);
    }
    return {
        schema: 2,
        edition: m.edition,
        version: m.version,
        publishedAt: m.publishedAt,
        plugin: { file: plugin.file, sha256: plugin.sha256, size: plugin.size, files: { file: plugin.files.file, sha256: plugin.files.sha256, size: plugin.files.size } },
        ui,
        notes,
    };
}
export function checkArchive(zip, m) {
    if (zip.length !== m.size)
        throw new ReleaseVerificationError(`Download size mismatch (${zip.length} ≠ ${m.size}). Nothing was installed; try again.`);
    const sha = createHash('sha256').update(zip).digest('hex');
    if (sha !== m.sha256)
        throw new ReleaseVerificationError('Download sha256 does not match the signed manifest. Nothing was installed.');
}
