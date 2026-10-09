// cyphor-role: IO
// The opt-in desktop shortcut for the PhanOS UI (C1 §5.2). This is the only file the MCP ever writes outside
// ~/.phanos/. It is created only on an explicit call, never overwrites anything, and removal deletes exactly the
// recorded path. No native dependency: a Windows .lnk is written by the system PowerShell, with a .url fallback.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, win32 } from 'node:path';
import { LAUNCHER_LAYOUT } from './config.js';
/** `execFile` with `shell: false`; never `createClaudeRunner`, whose win32 fallback re-runs through a shell. */
export function createExecRunner() {
    return (cmd, args, opts) => new Promise((resolve) => {
        try {
            execFile(cmd, args, {
                shell: false,
                windowsHide: true,
                encoding: 'utf8',
                timeout: opts?.timeoutMs ?? 30_000,
                env: opts?.env ? { ...process.env, ...opts.env } : process.env,
            }, (err, stdout, stderr) => {
                const code = err?.code;
                resolve({ code: err ? (typeof code === 'number' ? code : -1) : 0, stdout: stdout ?? '', stderr: stderr || (err?.message ?? '') });
            });
        }
        catch (e) {
            resolve({ code: -1, stdout: '', stderr: e.message });
        }
    });
}
/** The only three file names this module ever creates or deletes. */
export const SHORTCUT_NAMES = ['PhanOS.lnk', 'PhanOS.url', 'PhanOS.desktop'];
/**
 * A CONSTANT: it reads the three paths from the child's environment and nothing is ever interpolated into it, so no
 * path (quotes, `$(...)`, backticks) can be parsed as PowerShell. Success is judged by exit 0 plus the file on disk.
 */
export const SHORTCUT_SCRIPT = "$ErrorActionPreference = 'Stop'; " +
    '$shell = New-Object -ComObject WScript.Shell; ' +
    '$link = $shell.CreateShortcut($env:PHANOS_LNK); ' +
    '$link.TargetPath = $env:PHANOS_TARGET; ' +
    '$link.WorkingDirectory = $env:PHANOS_CWD; ' +
    '$link.Save()';
const FOLDER_QUERY = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ' + "[Environment]::GetFolderPath('DesktopDirectory')";
const USER_SHELL_FOLDERS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';
/** `<marketplace.pro.pluginDir>/<launcher>`: a path the staging swap keeps stable, never under `ui/<version>/`. */
export function launcherPath(paths, platformKey) {
    const name = LAUNCHER_LAYOUT[platformKey];
    return name === undefined ? null : join(paths.marketplace.pro.pluginDir, name);
}
const FAILED = { code: -1, stdout: '', stderr: '' };
const safeRun = (run, cmd, args, opts) => run(cmd, args, opts).catch((e) => ({ ...FAILED, stderr: e.message }));
const answerOf = (r) => (r.code === 0 ? r.stdout.replace(/^\uFEFF/, '').trim() : '');
function envGet(env, name) {
    const direct = env[name];
    if (direct !== undefined)
        return direct;
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : env[key];
}
/** Expands `%NAME%` from `env`; null when any variable is unset, so an unresolved path is never used. */
function expandPercent(value, env) {
    let missing = false;
    const out = value.replace(/%([^%]+)%/g, (_m, name) => {
        const v = envGet(env, name);
        if (v === undefined || v === '')
            missing = true;
        return v ?? '';
    });
    return missing ? null : out;
}
const stripTrailing = (p) => (/^[\\/]*$/.test(p) ? p : p.replace(/[\\/]+$/, ''));
/** The user's Desktop folder, or null (then nothing is written). */
export async function resolveDesktop(d) {
    const exists = d.exists ?? existsSync;
    if (d.platform === 'win32') {
        const root = envGet(d.env, 'SystemRoot') ?? envGet(d.env, 'windir') ?? 'C:\\Windows';
        const usable = (p) => p !== '' && win32.isAbsolute(p) && exists(p);
        const ps = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const known = answerOf(await safeRun(d.run, ps, ['-NoProfile', '-NonInteractive', '-Command', FOLDER_QUERY]));
        if (usable(known))
            return known;
        const reg = win32.join(root, 'System32', 'reg.exe');
        const out = await safeRun(d.run, reg, ['query', USER_SHELL_FOLDERS, '/v', 'Desktop']);
        const m = out.code === 0 ? /^\s*Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/im.exec(out.stdout) : null;
        const fromReg = m?.[1] ? expandPercent(m[1], d.env) : null;
        if (fromReg !== null && usable(fromReg))
            return fromReg;
        const home = win32.join(d.homedir, 'Desktop');
        return exists(home) ? home : null;
    }
    if (d.platform === 'linux') {
        const answer = stripTrailing(answerOf(await safeRun(d.run, 'xdg-user-dir', ['DESKTOP'])));
        if (answer !== '' && isAbsolute(answer) && answer !== stripTrailing(d.homedir) && exists(answer))
            return answer;
        const home = join(d.homedir, 'Desktop');
        return exists(home) ? home : null;
    }
    return null;
}
/**
 * The Exec value for a .desktop file: one argument in double quotes, `"` `` ` `` `$` `\` escaped for the quoting
 * level, every `\` doubled again for the string level (so a literal backslash is four), `%` doubled so it is not a
 * field code (freedesktop Desktop Entry spec, "The Exec key"). A control character cannot be represented.
 */
export function desktopExecQuote(path) {
    if (/[\u0000-\u001f\u007f]/.test(path))
        throw new Error('the launcher path contains a control character');
    const escaped = path
        .replace(/\\/g, '\\\\\\\\')
        .replace(/(["`$])/g, '\\\\$1')
        .replace(/%/g, '%%');
    return `"${escaped}"`;
}
/** `file:///C:/a%20b/x.bat` or `file:///home/a%20b/x.sh`, built by hand so it is right for either platform's paths. */
function fileUrl(path) {
    const unc = /^\\\\[^\\]/.test(path);
    const parts = path.replace(/\\/g, '/').replace(/^\/+/, '').split('/');
    const encoded = parts.map((seg, i) => i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`));
    return `${unc ? 'file://' : 'file:///'}${encoded.join('/')}`;
}
const refuse = (reason, message) => ({ ok: false, reason, message });
async function writeNew(path, data, mode) {
    try {
        await writeFile(path, data, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
        return 'ok';
    }
    catch (e) {
        return e.code === 'EEXIST' ? 'exists' : e;
    }
}
const ALREADY = 'A PhanOS shortcut already exists on the Desktop; it was left as it is.';
export async function createShortcut(d) {
    const exists = d.exists ?? existsSync;
    if ((d.platform !== 'win32' && d.platform !== 'linux') || !d.platformKey.startsWith(`${d.platform}-`)) {
        return refuse('unsupported', `A desktop shortcut is not available for this platform (${d.platformKey}).`);
    }
    const launcher = launcherPath(d.paths, d.platformKey);
    if (launcher === null)
        return refuse('unsupported', `A desktop shortcut is not available for this platform (${d.platformKey}).`);
    if (!exists(launcher)) {
        return refuse('no-launcher', `The PhanOS launcher was not found at ${launcher}. Run phanos_install first, then ask for the shortcut again.`);
    }
    const desktop = await resolveDesktop({ platform: d.platform, run: d.run, env: d.env, homedir: d.homedir, exists });
    if (desktop === null)
        return refuse('no-desktop', 'No Desktop folder was found, so no shortcut was created.');
    if (SHORTCUT_NAMES.some((n) => exists(join(desktop, n))))
        return refuse('exists', ALREADY);
    if (d.platform === 'win32') {
        const lnk = join(desktop, 'PhanOS.lnk');
        const root = envGet(d.env, 'SystemRoot') ?? envGet(d.env, 'windir') ?? 'C:\\Windows';
        const ps = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const r = await safeRun(d.run, ps, ['-NoProfile', '-NonInteractive', '-Command', SHORTCUT_SCRIPT], {
            env: { PHANOS_LNK: lnk, PHANOS_TARGET: launcher, PHANOS_CWD: dirname(launcher) },
        });
        if (r.code === 0 && exists(lnk))
            return { ok: true, path: lnk, kind: 'lnk', notes: [] };
        if (exists(lnk))
            await unlink(lnk).catch(() => undefined); // our own half-written file; the name was free a moment ago
        const url = join(desktop, 'PhanOS.url');
        const w = await writeNew(url, `[InternetShortcut]\r\nURL=${fileUrl(launcher)}\r\n`);
        if (w === 'exists')
            return refuse('exists', ALREADY);
        if (w !== 'ok')
            return refuse('write-failed', `The shortcut could not be written: ${w.message}`);
        return { ok: true, path: url, kind: 'url', notes: ['Windows could not create a .lnk shortcut, so a PhanOS.url shortcut was created instead.'] };
    }
    let exec;
    try {
        exec = desktopExecQuote(launcher);
    }
    catch (e) {
        return refuse('write-failed', `The shortcut could not be written: ${e.message}`);
    }
    const file = join(desktop, 'PhanOS.desktop');
    const text = ['[Desktop Entry]', 'Type=Application', 'Name=PhanOS', `Exec=${exec}`, 'Terminal=false', ''].join('\n');
    const w = await writeNew(file, text, 0o755);
    if (w === 'exists')
        return refuse('exists', ALREADY);
    if (w !== 'ok')
        return refuse('write-failed', `The shortcut could not be written: ${w.message}`);
    await chmod(file, 0o755).catch(() => undefined); // the umask may have narrowed the creation mode
    const gio = await safeRun(d.run, 'gio', ['set', file, 'metadata::trusted', 'true']);
    const notes = gio.code === 0 ? [] : ['If your desktop asks, choose Allow Launching.'];
    return { ok: true, path: file, kind: 'desktop', notes };
}
/** Deletes exactly `recordedPath` when it bears one of the three shortcut names; no glob, no sibling sweep. */
export async function removeShortcut(recordedPath) {
    const path = recordedPath;
    if (!isAbsolute(path))
        return { removed: false, path, reason: 'not-absolute', message: 'The recorded shortcut path is not absolute; nothing was deleted.' };
    if (!SHORTCUT_NAMES.includes(basename(path))) {
        return { removed: false, path, reason: 'not-a-shortcut', message: 'The recorded path is not a PhanOS shortcut name; nothing was deleted.' };
    }
    try {
        const st = await lstat(path);
        if (!st.isFile() && !st.isSymbolicLink())
            return { removed: false, path, reason: 'not-a-shortcut', message: 'The recorded path is not a file; nothing was deleted.' };
        await unlink(path);
        return { removed: true, path };
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return { removed: false, path, reason: 'missing' };
        return { removed: false, path, reason: 'failed', message: e.message };
    }
}
