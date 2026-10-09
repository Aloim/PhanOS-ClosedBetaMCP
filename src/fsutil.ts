// cyphor-role: IO
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeFileAtomic(path: string, data: string | Buffer, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, path);
}

export async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
  return JSON.parse(text) as T;
}
