// cyphor-role: IO
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonOr, writeFileAtomic } from './fsutil.js';

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
