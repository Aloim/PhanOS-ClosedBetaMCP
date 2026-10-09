// cyphor-role: IO
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export async function writeFileAtomic(path, data, mode = 0o644) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data, { mode });
    await rename(tmp, path);
}
export async function readJsonOr(path, fallback) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return fallback;
        throw e;
    }
    return JSON.parse(text);
}
