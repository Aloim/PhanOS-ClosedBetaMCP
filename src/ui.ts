// cyphor-role: IO
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename as fsRename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Paths } from './config.js';
import { writeFileAtomic } from './fsutil.js';
import type { LocalStateV2 } from './state.js';
import { ReleaseVerificationError } from './release.js';
import { safeExtract } from './unzip.js';

/**
 * The UI archive layout agreed with PhanOS-UI (C1 §2.5, A6 closed in v1.6): the entry executable sits at the archive
 * root, so `<home>/ui/<version>/<entry>`. On Linux `phanos-ui` is a wrapper beside the Electron binary `phanos-ui-bin`.
 * A platform with no key here has no UI build (macOS, D-850).
 */
export const UI_ENTRY_BY_PLATFORM: Readonly<Record<string, string>> = {
  'win32-x64': 'PhanOS.exe',
  'linux-x64': 'phanos-ui',
};

/** The ruled S-4 cap per UI archive (C1 §2.5), the same one PhanOS-UI's release script enforces. */
export const UI_CAP = { zipBytes: 256 * 1024 * 1024, unpackedBytes: 768 * 1024 * 1024, entries: 2_000 } as const;

export interface InstallUiOptions {
  paths: Paths;
  /** The release version tag; it becomes the folder name under `<home>/ui/`. */
  version: string;
  platformKey: string;
  /** The verified UI archive, or null when this platform has no UI artifact. */
  zip: Buffer | null;
  /** Injectable for the failure tests; defaults to `fs.rename`. */
  rename?: (from: string, to: string) => Promise<void>;
  /** Injectable for the failure tests; defaults to an atomic write of `current`. */
  writePointer?: (path: string, content: string) => Promise<void>;
  /** Injectable for the failure tests; defaults to a recursive remove. */
  remove?: (path: string) => Promise<void>;
}

export interface UiInstallResult {
  /** The version now current, or null when nothing was installed. */
  version: string | null;
  platform: string;
  /** Version folders removed by the best-effort prune. */
  pruned: string[];
  notes: string[];
}

export function uiNotAvailableNote(platformKey: string): string {
  return `The PhanOS UI is not available for this platform (${platformKey}); the plugin installs without it.`;
}

/** A version tag is one path segment: no separators, no traversal, and never the pointer file's own name. */
export function assertSafeVersionTag(version: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version) || version === 'current') {
    throw new Error(`Unsafe UI version tag: ${JSON.stringify(version)}. Nothing was installed.`);
  }
}

async function readPointer(file: string): Promise<string | null> {
  try {
    const text = (await readFile(file, 'utf8')).trim();
    return text.length > 0 ? text : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Installs the desktop UI: extract to staging, rename the finished folder into `<home>/ui/<version>/`,
 * and only then move the `current` pointer. Keeps the new and the previously-current version, prunes
 * older ones best-effort. Never creates a shortcut and never deletes the current or previous version
 * on its own (an ended account keeps its UI).
 */
export async function installUi(opts: InstallUiOptions): Promise<UiInstallResult> {
  const { paths, version, platformKey, zip } = opts;
  const doRename = opts.rename ?? fsRename;
  const writePointer = opts.writePointer ?? ((path: string, content: string) => writeFileAtomic(path, content));
  const remove = opts.remove ?? ((path: string) => rm(path, { recursive: true, force: true }));

  if (zip === null) return { version: null, platform: platformKey, pruned: [], notes: [uiNotAvailableNote(platformKey)] };
  assertSafeVersionTag(version);
  if (zip.length > UI_CAP.zipBytes) throw new ReleaseVerificationError('The UI archive is too large. Nothing was installed.');

  const notes: string[] = [];
  const target = join(paths.uiDir, version);
  const previous = await readPointer(paths.uiCurrentFile);

  if (await exists(target)) {
    // A folder under ui/ only ever appears by a completed rename, so it is complete: reuse it.
    notes.push(`The PhanOS UI ${version} was already installed.`);
  } else {
    const staging = join(paths.stagingDir, `ui-${version}-${process.pid}-${Date.now()}`);
    try {
      await safeExtract(zip, staging, { maxBytes: UI_CAP.unpackedBytes, maxEntries: UI_CAP.entries, keepExecBit: true });
      await mkdir(paths.uiDir, { recursive: true });
      await doRename(staging, target);
    } catch (e) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
  }

  // The version folder is complete; only now does the pointer move.
  await writePointer(paths.uiCurrentFile, version);

  const pruned: string[] = [];
  if (previous !== version) {
    const keep = new Set<string>([version]);
    if (previous) keep.add(previous);
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await readdir(paths.uiDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || keep.has(entry.name)) continue;
      try {
        await remove(join(paths.uiDir, entry.name));
        pruned.push(entry.name);
      } catch {
        notes.push(`Could not remove the old PhanOS UI ${entry.name} (in use?); it will be removed on a later update.`);
      }
    }
  }

  return { version, platform: platformKey, pruned, notes };
}

/** Starts the UI detached from the MCP process; resolves once the process exists, rejects if it could not start. */
export function launchDetached(entry: string, cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(entry, [], { detached: true, stdio: 'ignore', cwd });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export interface UiToolOptions {
  paths: Paths;
  state: LocalStateV2;
  platformKey: string;
  /** Injectable so tests never start a process; defaults to a detached spawn. */
  launch?: (entry: string, cwd: string) => Promise<void> | void;
  /** The site base URL, e.g. `https://phanos.eu`; the Basic answer points at `<apiBase>/pricing`. */
  apiBase: string;
}

export interface UiToolAnswer {
  launched: boolean;
  /** The version that was started, or null. */
  version: string | null;
  text: string;
}

const RUN_INSTALL = 'Run phanos_install to install it.';

/** The Basic answer of the UI tool (F-9996): the single source, so the service never duplicates the text. */
export function uiComesWithProText(apiBase: string): string {
  return `The PhanOS UI comes with Pro: ${apiBase.replace(/\/+$/, '')}/pricing`;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The `phanos_ui` answer (M9a): an installed UI is started detached whatever the account state (an ended
 * account sees the renew screen inside the UI). Without one: Basic gets the pricing address, a platform
 * with no build is told so, anyone else is sent to `phanos_install`. A pointer that names a missing folder
 * is reported and never launched; the pointer's version is checked as a path segment before it is joined.
 */
export async function uiToolAnswer(opts: UiToolOptions): Promise<UiToolAnswer> {
  const { paths, state, platformKey, apiBase } = opts;
  const launch = opts.launch ?? launchDetached;
  const entryName = UI_ENTRY_BY_PLATFORM[platformKey];
  const notLaunched = (text: string): UiToolAnswer => ({ launched: false, version: null, text });

  const pointer = await readPointer(paths.uiCurrentFile);
  if (pointer !== null) {
    try {
      assertSafeVersionTag(pointer);
    } catch {
      return notLaunched(`The PhanOS UI pointer holds an unusable version (${JSON.stringify(pointer)}); it was not started. ${RUN_INSTALL}`);
    }
    const folder = join(paths.uiDir, pointer);
    if (entryName !== undefined) {
      const entry = join(folder, entryName);
      if (await isFile(entry)) {
        try {
          await launch(entry, folder);
        } catch (e) {
          return notLaunched(`The PhanOS UI ${pointer} could not be started: ${(e as Error).message}`);
        }
        return { launched: true, version: pointer, text: `Started the PhanOS UI ${pointer}.` };
      }
    }
    return notLaunched(`The PhanOS UI ${pointer} is recorded as current but is missing on disk; it was not started. ${RUN_INSTALL}`);
  }

  const basic = state.enabled === 'basic' || state.lastConfirmed?.state === 'never';
  if (basic) return notLaunched(uiComesWithProText(apiBase));
  if (entryName === undefined) return notLaunched(`The PhanOS UI is not available for this platform yet (${platformKey}).`);
  return notLaunched(`The PhanOS UI is not installed. ${RUN_INSTALL}`);
}
