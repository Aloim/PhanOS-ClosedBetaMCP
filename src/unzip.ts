// cyphor-role: IO
import { createWriteStream } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { ReleaseVerificationError } from './release.js';

export function assertSafeEntryName(name: string): void {
  const bad =
    name.length === 0 ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name) ||
    name.includes('//') ||
    name.split('/').some((seg) => seg === '..' || seg === '.');
  if (bad) throw new ReleaseVerificationError(`Unsafe path in archive: ${JSON.stringify(name)}. Nothing was installed.`);
}

export interface ExtractOptions {
  /** Total uncompressed byte budget for this call only; nothing is cached across calls. Default 200 MiB. */
  maxBytes?: number;
  maxEntries?: number;
  /** Write a regular file 0o755 when its zip unix mode has any execute bit; otherwise 0o644. setuid/setgid/sticky are never written. */
  keepExecBit?: boolean;
}

export async function safeExtract(zip: Buffer, destDir: string, limits: ExtractOptions = {}): Promise<void> {
  const maxBytes = limits.maxBytes ?? 200 * 1024 * 1024;
  const keepExecBit = limits.keepExecBit === true;
  const maxEntries = limits.maxEntries ?? 20_000;
  const root = resolve(destDir);
  await mkdir(root, { recursive: true });
  const zipfile = await new Promise<yauzl.ZipFile>((res, rej) =>
    yauzl.fromBuffer(zip, { lazyEntries: true, validateEntrySizes: true }, (err, z) => (err || !z ? rej(err) : res(z))),
  );
  let total = 0;
  let count = 0;
  await new Promise<void>((res, rej) => {
    const fail = (e: unknown) => {
      zipfile.close();
      rej(e);
    };
    zipfile.on('error', fail);
    zipfile.on('end', () => res());
    zipfile.on('entry', (entry: yauzl.Entry) => {
      (async () => {
        count += 1;
        if (count > maxEntries) throw new ReleaseVerificationError('Archive has too many entries. Nothing was installed.');
        assertSafeEntryName(entry.fileName);
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) throw new ReleaseVerificationError(`Archive contains a symbolic link (${entry.fileName}). Nothing was installed.`);
        const target = resolve(root, ...entry.fileName.split('/'));
        if (target !== root && !target.startsWith(root + sep)) throw new ReleaseVerificationError(`Unsafe path in archive: ${entry.fileName}`);
        if (entry.fileName.endsWith('/')) {
          await mkdir(target, { recursive: true });
          return;
        }
        total += entry.uncompressedSize;
        if (total > maxBytes) throw new ReleaseVerificationError('Archive is too large. Nothing was installed.');
        await mkdir(dirname(target), { recursive: true });
        const stream = await new Promise<NodeJS.ReadableStream>((ok, ko) => zipfile.openReadStream(entry, (e, s) => (e || !s ? ko(e) : ok(s))));
        const fileMode = keepExecBit && ((entry.externalFileAttributes >>> 16) & 0o111) !== 0 ? 0o755 : 0o644;
        await pipeline(stream, createWriteStream(target, { mode: fileMode }));
        // createWriteStream's mode is masked by the process umask; set the exact mode (never setuid/setgid/sticky).
        await chmod(target, fileMode);
      })().then(() => zipfile.readEntry(), fail);
    });
    zipfile.readEntry();
  });
}
