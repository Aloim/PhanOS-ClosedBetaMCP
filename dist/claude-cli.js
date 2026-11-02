// cyphor-role: IO
import { execFile } from 'node:child_process';
import { PLUGIN_IDS } from './config.js';
import { MCP_VERSION } from './version.js';
export function quoteForCmd(arg) {
    return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}
/** `exec` is a test seam for the child-process spawn; production uses node's execFile. */
export function createCommandRunner(cmd, platform = process.platform, exec = execFile) {
    return (args, opts) => new Promise((resolve) => {
        const timeout = opts?.timeoutMs ?? 120_000;
        const attempt = (useShell) => exec(cmd, useShell ? args.map(quoteForCmd) : args, { shell: useShell, timeout, windowsHide: true }, (err, stdout, stderr) => {
            const code = err?.code;
            // npm-installed claude.cmd: pre-CVE-2024-27980 Node reports ENOENT for a shell-less
            // execFile of a .cmd; Node 22+ instead refuses synchronously with EINVAL (F-3153).
            if ((code === 'ENOENT' || code === 'EINVAL') && platform === 'win32' && !useShell)
                return attempt(true);
            resolve({ code: err ? (typeof code === 'number' ? code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err?.message ?? '') });
        });
        attempt(false);
    });
}
export const createClaudeRunner = (platform = process.platform) => createCommandRunner('claude', platform);
const ALLOWED_IDS = new Set(Object.values(PLUGIN_IDS));
/** Throws unless `id` is one of PLUGIN_IDS (config.ts). */
export function assertFullId(id) {
    if (!ALLOWED_IDS.has(id)) {
        throw new Error(`refusing plugin id "${id}": a full id is required (${[...ALLOWED_IDS].join(' | ')}); a bare "phanos" resolves to the first match in Claude Code`);
    }
}
const call = (run, args) => run(args).catch((e) => ({ code: -1, stdout: '', stderr: e.message }));
const withAlready = (r) => ({ ...r, ok: r.code === 0 || /already/i.test(`${r.stdout}\n${r.stderr}`) });
/** The manual-fallback line for a `claude` invocation; every plugin id in it must be a full id. */
export function manualCommand(args) {
    for (const a of args)
        if (a === 'phanos' || a.startsWith('phanos@'))
            assertFullId(a);
    return `claude ${args.map(quoteForCmd).join(' ')}`;
}
/** The two manual commands for a missing CLI: add the marketplace folder, install the full id. */
export function manualInstallCommands(marketplaceDir, id) {
    assertFullId(id);
    return [manualCommand(['plugin', 'marketplace', 'add', marketplaceDir]), manualCommand(['plugin', 'install', id])];
}
/** Parses `plugin list --json` into `{id -> state}`; null when the shape is not understood. */
export function parsePluginList(stdout) {
    let data;
    try {
        data = JSON.parse(stdout);
    }
    catch {
        return null;
    }
    if (!Array.isArray(data))
        return null;
    const entries = [];
    for (const item of data) {
        if (typeof item !== 'object' || item === null)
            return null;
        const e = item;
        if (typeof e.id !== 'string' || e.id === '' || typeof e.enabled !== 'boolean')
            return null;
        if (e.projectEnabled !== undefined && typeof e.projectEnabled !== 'boolean')
            return null;
        const state = { installed: true, enabled: e.enabled, projectEnabled: e.projectEnabled === true };
        if (typeof e.version === 'string')
            state.version = e.version;
        if (Array.isArray(e.notes) && e.notes.every((n) => typeof n === 'string'))
            state.notes = e.notes;
        entries.push([e.id, state]);
    }
    return Object.fromEntries(entries);
}
/** Runs `plugin list --json`; null on a failing run, a throwing runner or an unknown shape. */
export async function listPlugins(run) {
    const r = await call(run, ['plugin', 'list', '--json']);
    return r.code === 0 ? parsePluginList(r.stdout) : null;
}
export async function addMarketplace(run, dir) {
    return withAlready(await call(run, ['plugin', 'marketplace', 'add', dir]));
}
export async function installPlugin(run, id) {
    assertFullId(id);
    return withAlready(await call(run, ['plugin', 'install', id]));
}
const scoped = (verb, id, opts) => ['plugin', verb, id, ...(opts?.scope ? ['--scope', opts.scope] : [])];
/** Exit 1 means "already enabled" as often as a failure: the code is returned as-is; read the listing. */
export async function enablePlugin(run, id, opts) {
    assertFullId(id);
    return call(run, scoped('enable', id, opts));
}
/** Project-scope off needs `{ scope: 'project' }` and a runner whose cwd is inside that project. */
export async function disablePlugin(run, id, opts) {
    assertFullId(id);
    return call(run, scoped('disable', id, opts));
}
export async function uninstallPlugin(run, id) {
    assertFullId(id);
    return call(run, ['plugin', 'uninstall', id]);
}
export async function removeMarketplace(run, name) {
    return call(run, ['plugin', 'marketplace', 'remove', name]);
}
// ---------------------------------------------------------------------------
// User-scope MCP registration (WB2.07, plan C-W1). The pinned command carries the package
// version as its tag, so a package upgrade re-registers the server.
// ---------------------------------------------------------------------------
export const MCP_TAG = `v${MCP_VERSION}`;
export const MCP_ADD_ARGS = (tag) => ['mcp', 'add', '--scope', 'user', 'phanos', '--', 'npx', '-y', `github:Aloim/PhanOS-ClosedBetaMCP#${tag}`];
export const MCP_ADD_COMMAND = 'claude ' + MCP_ADD_ARGS(MCP_TAG).join(' ');
/** `present` is exit 0; `raw` is stdout, or stderr when stdout is empty (a not-found reply lands on stderr). */
export async function getMcpServer(run, name) {
    const r = await call(run, ['mcp', 'get', name]);
    return { present: r.code === 0, raw: r.stdout !== '' ? r.stdout : r.stderr };
}
export async function addMcpServer(run, args) {
    return call(run, args);
}
export async function removeMcpServer(run, name) {
    return call(run, ['mcp', 'remove', name, '--scope', 'user']);
}
/** A failed `claude mcp add`; `code` is the stable machine tag the caller branches on. */
export class McpAddError extends Error {
    code = 'mcp_add_failed';
}
/** True when `raw` pins the package to `tag` with the tag ending at a boundary: `v0.3.1` does not match `v0.3.12`. */
const pinnedTo = (raw, tag) => new RegExp(`github:Aloim/PhanOS-ClosedBetaMCP#${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Za-z.\\-_])`).test(raw);
/**
 * Registers the `phanos` MCP server at user scope. 'already' when the registered command already
 * carries the pinned tag (no add); 'replaced' when another command is registered (remove, then add);
 * 'added' when absent. Throws McpAddError when the add exits non-zero or `claude` cannot run.
 */
export async function registerMcp(opts) {
    const run = opts.run ?? createClaudeRunner();
    const current = await getMcpServer(run, 'phanos');
    if (current.present && pinnedTo(current.raw, MCP_TAG))
        return 'already';
    if (current.present)
        await removeMcpServer(run, 'phanos');
    const add = await addMcpServer(run, MCP_ADD_ARGS(MCP_TAG));
    if (add.code !== 0) {
        const detail = add.stderr.trim() || `claude mcp add stopped with exit code ${add.code}`;
        throw new McpAddError(`Could not add the PhanOS MCP server to Claude Code (${detail}). To add it by hand, run: ${MCP_ADD_COMMAND}`);
    }
    return current.present ? 'replaced' : 'added';
}
