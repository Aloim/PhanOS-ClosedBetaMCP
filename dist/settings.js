// cyphor-role: IO
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonOr, writeFileAtomic } from './fsutil.js';
export async function mergeClaudeEnv(configDir, vars) {
    const file = join(configDir, 'settings.json');
    let loaded;
    try {
        loaded = await readJsonOr(file, null);
    }
    catch {
        const wanted = Object.entries(vars).map(([k, v]) => `"${k}": "${v}"`).join(', ');
        return { changed: false, error: `${file} is not valid JSON, so it was left untouched. Add "env": {${wanted}} to it yourself.` };
    }
    const existed = loaded !== null;
    const current = loaded ?? {};
    const env = { ...(current.env ?? {}) };
    if (Object.entries(vars).every(([k, v]) => env[k] === v))
        return { changed: false };
    Object.assign(env, vars);
    if (existed)
        await copyFile(file, `${file}.phanos-backup`);
    await writeFileAtomic(file, `${JSON.stringify({ ...current, env }, null, 2)}\n`);
    return { changed: true };
}
