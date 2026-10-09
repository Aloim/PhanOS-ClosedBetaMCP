// cyphor-role: IO
import { readFile, rm } from 'node:fs/promises';
import type { LocalEdition, Paths } from './config.js';
import { readJsonOr, writeFileAtomic } from './fsutil.js';

export type Edition = 'free' | 'pro';

/** What the MCP last did for one local edition (C1 §5.1). */
export interface EditionRecord {
  version?: string;
  registered?: boolean;
}

/** How this MCP was last launched; read by PhanOS-UI's daemon (C1 §18 item 7). Paths are stored verbatim. */
export interface McpLaunchRecord {
  entry: string;
  node: string;
  version: string;
  recordedAt: string;
}

/** State file schema 2 (C1 §5.1). `deviceId` and `email` keep their top-level keys (rule 1); unknown keys survive. */
export interface LocalStateV2 {
  schema: 2;
  email?: string;
  deviceId?: string;
  enabled?: LocalEdition;
  pro?: EditionRecord;
  basic?: EditionRecord;
  ui?: { version?: string; platform?: string };
  tokenExpiresAt?: string;
  lastConfirmed?: { state: string; at: string };
  /** Present only while a shortcut the MCP created exists (C1 §5.2). */
  shortcut?: { path: string };
  /** The launch record (C1 §18 item 7); rewritten only when entry, node or version changed. */
  mcp?: McpLaunchRecord;
  [key: string]: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const SCHEMA1_KEYS = new Set(['edition', 'installedVersion', 'registeredWithClaude']);

function upgradeSchema1(raw: Record<string, unknown>): LocalStateV2 {
  const out: Record<string, unknown> = { schema: 2 };
  for (const [k, v] of Object.entries(raw)) if (!SCHEMA1_KEYS.has(k) && k !== 'schema') out[k] = v;
  const local: LocalEdition | null = raw.edition === 'pro' ? 'pro' : raw.edition === 'free' ? 'basic' : null;
  if (local) {
    out.enabled = local;
    const record: EditionRecord = {};
    if (typeof raw.installedVersion === 'string') record.version = raw.installedVersion;
    if (typeof raw.registeredWithClaude === 'boolean') record.registered = raw.registeredWithClaude;
    out[local] = record;
  }
  return out as LocalStateV2;
}

/** Reads the state file as schema 2. A file with no `schema` is schema 1 and is upgraded in memory only. Corrupt or missing reads as empty. */
export async function readLocalState(p: Paths): Promise<LocalStateV2> {
  let raw: unknown;
  try {
    raw = await readJsonOr<unknown>(p.stateFile, {});
  } catch {
    return { schema: 2 };
  }
  if (!isRecord(raw)) return { schema: 2 };
  if (raw.schema === undefined || raw.schema === 1) return upgradeSchema1(raw);
  return raw as LocalStateV2;
}

export async function writeLocalState(p: Paths, s: LocalStateV2): Promise<void> {
  const clean = Object.fromEntries(Object.entries({ ...s, schema: 2 }).filter(([, v]) => v !== undefined));
  await writeFileAtomic(p.stateFile, `${JSON.stringify(clean, null, 2)}\n`, 0o600);
}

/**
 * Records how this MCP was launched. Returns false and writes nothing when the stored record already has the same
 * entry, node and version; otherwise writes the record (other keys preserved) and returns true.
 */
export async function recordLaunch(
  p: Paths,
  launch: { entry: string; node: string; version: string },
  now: Date,
): Promise<boolean> {
  const state = await readLocalState(p);
  const stored = state.mcp;
  if (
    isRecord(stored) &&
    stored.entry === launch.entry &&
    stored.node === launch.node &&
    stored.version === launch.version
  ) {
    return false;
  }
  await writeLocalState(p, {
    ...state,
    mcp: { entry: launch.entry, node: launch.node, version: launch.version, recordedAt: now.toISOString() },
  });
  return true;
}

export async function readToken(p: Paths): Promise<string | null> {
  try {
    return (await readFile(p.tokenFile, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

export async function writeToken(p: Paths, token: string): Promise<void> {
  await writeFileAtomic(p.tokenFile, token, 0o600);
}

export async function deleteToken(p: Paths): Promise<void> {
  await rm(p.tokenFile, { force: true });
}

export function tokenExpiry(token: string): Date | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}
