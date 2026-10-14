// cyphor-role: IO
import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonOr, writeFileAtomic } from './fsutil.js';

/**
 * F-16412: the reverse of `mergeClaudeEnv`. Deletes each `env` key of `settings.json` only while it still holds exactly the
 * value in `expected` (the value PhanOS wrote); a key with any other value is the user's and stays. An absent key, an absent
 * file and a file with nothing to remove are no-ops (no write, no backup). A file that is not valid JSON is left untouched;
 * the answer then names what to remove, but only when the text mentions one of the keys. Before a change the old file is
 * copied to `settings.json.phanos-backup`; every other key is kept, and an `env` object our removal empties is dropped.
 */
export async function removeClaudeEnv(configDir: string, expected: Record<string, string>): Promise<{ changed: boolean; error?: string }> {
  const file = join(configDir, 'settings.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { changed: false };
    throw e;
  }
  let loaded: unknown;
  try {
    loaded = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    const mentioned = Object.keys(expected).filter((k) => text.includes(k));
    if (mentioned.length === 0) return { changed: false };
    return { changed: false, error: `${file} is not valid JSON, so it was left untouched. Remove ${mentioned.map((k) => `"${k}"`).join(', ')} from its "env" yourself.` };
  }
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) return { changed: false };
  const current = loaded as Record<string, unknown>;
  const rawEnv = current.env;
  if (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv)) return { changed: false };
  const env = { ...(rawEnv as Record<string, unknown>) };
  const ours = Object.entries(expected).filter(([k, v]) => env[k] === v);
  if (ours.length === 0) return { changed: false };
  for (const [k] of ours) delete env[k];
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(current)) {
    if (k !== 'env') next[k] = v;
    else if (Object.keys(env).length > 0) next.env = env;
  }
  await copyFile(file, `${file}.phanos-backup`);
  await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return { changed: true };
}

export async function mergeClaudeEnv(configDir: string, vars: Record<string, string>): Promise<{ changed: boolean; error?: string }> {
  const file = join(configDir, 'settings.json');
  let loaded: Record<string, unknown> | null;
  try {
    loaded = await readJsonOr<Record<string, unknown> | null>(file, null);
  } catch {
    const wanted = Object.entries(vars).map(([k, v]) => `"${k}": "${v}"`).join(', ');
    return { changed: false, error: `${file} is not valid JSON, so it was left untouched. Add "env": {${wanted}} to it yourself.` };
  }
  const existed = loaded !== null;
  const current = loaded ?? {};
  const env = { ...((current.env as Record<string, string> | undefined) ?? {}) };
  if (Object.entries(vars).every(([k, v]) => env[k] === v)) return { changed: false };
  Object.assign(env, vars);
  if (existed) await copyFile(file, `${file}.phanos-backup`);
  await writeFileAtomic(file, `${JSON.stringify({ ...current, env }, null, 2)}\n`);
  return { changed: true };
}
