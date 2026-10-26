// cyphor-role: CORE
// S5-2.03: Scaffolded by the orchestrator, run 20261025-st5 (plan documentation/plans/implementation-plans/2026-10-25_st5-server-boundary).
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadContent } from './content.js';
import type { SessionRunContext } from './session-runtime.js';
import { projectDirOf, readInstallId, readSessionTree, sessionScriptsDir } from './session-context.js';
import { readToken } from './state.js';

/**
 * Writes the labelled session-set files into the Pro scripts folder, each through the verified content path (the signed
 * manifest and the item sha256). A file lands only when its bytes re-read from `<name>.tmp` match the verified sha256; a
 * mismatch or a refused item removes `<name>.tmp` and `<name>` and reports `mismatch (manifest): <name>`.
 * Only for a Pro tree with a session set, a token and an install id; otherwise `not enabled`.
 */
export async function materializeSessionSet(ctx: SessionRunContext): Promise<string> {
  const tree = readSessionTree(ctx.paths);
  if (!tree.sessionSet) return 'not enabled';
  if ((await readToken(ctx.paths)) === null) return 'not enabled';
  const projectDir = projectDirOf(ctx.env);
  const installId = projectDir === null ? null : readInstallId(projectDir);
  if (installId === null) return 'not enabled';

  const dir = sessionScriptsDir(ctx.paths);
  await mkdir(dir, { recursive: true });
  for (const name of tree.names) {
    const target = path.join(dir, name);
    const tmp = `${target}.tmp`;
    const outcome = await loadContent({ ...ctx.content, installId }, { kind: 'session', name });
    if (!outcome.ok || outcome.bytes === undefined || outcome.sha256 === undefined) {
      await removeQuietly(tmp, target);
      return `mismatch (manifest): ${name}`;
    }
    await writeFile(tmp, outcome.bytes);
    const onDisk = await readFile(tmp);
    if (createHash('sha256').update(onDisk).digest('hex') !== outcome.sha256) {
      await removeQuietly(tmp, target);
      return `mismatch (manifest): ${name}`;
    }
    await rename(tmp, target);
  }
  return `present (${tree.names.length} files)`;
}

async function removeQuietly(...files: string[]): Promise<void> {
  for (const file of files) await rm(file, { force: true });
}
