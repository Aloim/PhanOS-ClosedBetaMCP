// cyphor-role: CORE
// The C-9 content manifest seam (F-15661, run 20261013-es-p7, slice S0a): parse and verify a signed A2 content manifest.
// Pure: no file system, no network. Shared by the web server's release-pull and by this package's phanos_content.
// The shape is the release seam's (release.ts verifySignedManifest): the signature holds before untrusted text is parsed.
import { createPublicKey, verify } from 'node:crypto';
import type { SignedManifest } from './api.js';
import type { TrustedKey } from './trusted-keys.js';

/** Every refusal of this module carries its reason as `message`: `unknown key (...)`, `signature invalid`, `malformed`, `kid mismatch (...)`. */
export class ContentVerificationError extends Error {}

export const CONTENT_KINDS = ['skill', 'workflow', 'agent', 'corpus', 'template', 'session'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

/** The three loose release asset names (02_c9-wire-server.md section 8). */
export const CONTENT_MANIFEST_ASSET = 'content-manifest.json';
export const CONTENT_SIGNATURE_ASSET = 'content-manifest.json.sig';
export const CONTENT_PIN_ASSET = 'content-pin.json';

const VERSION_BODY = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?';
/** Same rule as the web server's release VERSION_RE (W/src/lib/releases.ts). */
export const PLUGIN_VERSION_RE = new RegExp(`^${VERSION_BODY}$`);
/** `<pluginVersion>+<n>`, n a positive integer without a leading zero, at most nine digits. */
export const CONTENT_VERSION_RE = new RegExp(`^(${VERSION_BODY})\\+([1-9]\\d{0,8})$`);

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_BYTES = 1_048_576;
const ASSET_PREFIX = 'content.';

const MALFORMED = 'malformed';

/** A problem with an item name, or null when it is valid (PhanOS content-bundle.js nameProblem). */
export function contentNameProblem(name: string): string | null {
  if (!NAME_RE.test(name)) return 'name must match ^[a-z0-9][a-z0-9._-]{0,63}$';
  if (name.endsWith('.')) return 'name must not end with a dot';
  if (RESERVED.test(name.split('.')[0]!)) return 'name is a reserved Windows name';
  return null;
}

export function isContentKind(kind: string): kind is ContentKind {
  return (CONTENT_KINDS as readonly string[]).includes(kind);
}

export interface ContentFile {
  sha256: string;
  bytes: number;
}

export interface ContentManifest {
  pluginVersion: string;
  contentVersion: string;
  /** The `n` of `contentVersion`. */
  counter: number;
  files: Record<string, ContentFile>;
  kid: string;
}

export interface ContentPin {
  schema: 1;
  pluginVersion: string;
  contentVersion: string;
  counter: number;
  manifestSha256: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ContentVerificationError(MALFORMED);
  }
}

/** Returns the counter when `contentVersion` is `<pluginVersion>+<n>`, else null. */
function counterOf(pluginVersion: unknown, contentVersion: unknown): number | null {
  if (typeof pluginVersion !== 'string' || typeof contentVersion !== 'string') return null;
  if (!PLUGIN_VERSION_RE.test(pluginVersion)) return null;
  const m = CONTENT_VERSION_RE.exec(contentVersion);
  if (!m || m[1] !== pluginVersion) return null;
  return Number(m[2]);
}

/** Parses the schema of 02_c9-wire-server.md section 7.1. Unknown keys are ignored. Throws `malformed`. */
export function parseContentManifest(text: string): ContentManifest {
  const raw = parseJson(text);
  if (!isRecord(raw)) throw new ContentVerificationError(MALFORMED);
  const counter = counterOf(raw.pluginVersion, raw.contentVersion);
  if (counter === null) throw new ContentVerificationError(MALFORMED);
  if (typeof raw.kid !== 'string' || raw.kid === '') throw new ContentVerificationError(MALFORMED);
  if (!isRecord(raw.files)) throw new ContentVerificationError(MALFORMED);
  const files: Record<string, ContentFile> = {};
  for (const [key, entry] of Object.entries(raw.files)) {
    const parts = key.split('/');
    if (parts.length !== 2 || !isContentKind(parts[0]!) || contentNameProblem(parts[1]!) !== null) throw new ContentVerificationError(MALFORMED);
    if (!isRecord(entry)) throw new ContentVerificationError(MALFORMED);
    const { sha256, bytes } = entry;
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) throw new ContentVerificationError(MALFORMED);
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1 || bytes > MAX_BYTES) throw new ContentVerificationError(MALFORMED);
    files[key] = { sha256, bytes };
  }
  if (Object.keys(files).length === 0) throw new ContentVerificationError(MALFORMED);
  return { pluginVersion: raw.pluginVersion as string, contentVersion: raw.contentVersion as string, counter, files, kid: raw.kid };
}

/**
 * F-15661 section 2. Order (the signature holds before untrusted text is parsed):
 * (1) the signature kid names a trusted key; (2) Ed25519 over the UTF-8 bytes verifies; (3) the text parses;
 * (4) the in-text kid equals the signature kid. Each failure is final.
 */
export function verifyContentManifest(signed: SignedManifest, keys: TrustedKey[]): ContentManifest {
  const sigKid = signed.signature?.kid;
  const key = keys.find((k) => k.kid === sigKid);
  if (!key) throw new ContentVerificationError(`unknown key ("${sigKid}")`);
  let valid = false;
  try {
    valid = verify(null, Buffer.from(signed.manifest, 'utf8'), createPublicKey(key.publicPem), Buffer.from(signed.signature.sig, 'base64'));
  } catch {
    valid = false;
  }
  if (!valid) throw new ContentVerificationError('signature invalid');
  const manifest = parseContentManifest(signed.manifest);
  if (manifest.kid !== sigKid) throw new ContentVerificationError(`kid mismatch ("${manifest.kid}" vs "${sigKid}")`);
  return manifest;
}

/** Parses the A1 pin (`Phanes/content-pin.json`, 02_c9-wire-server.md section 7.3). Throws `malformed`. */
export function parseContentPin(text: string): ContentPin {
  const raw = parseJson(text);
  if (!isRecord(raw) || raw.schema !== 1) throw new ContentVerificationError(MALFORMED);
  const counter = counterOf(raw.pluginVersion, raw.contentVersion);
  if (counter === null) throw new ContentVerificationError(MALFORMED);
  if (typeof raw.manifestSha256 !== 'string' || !SHA256_RE.test(raw.manifestSha256)) throw new ContentVerificationError(MALFORMED);
  return { schema: 1, pluginVersion: raw.pluginVersion as string, contentVersion: raw.contentVersion as string, counter, manifestSha256: raw.manifestSha256 };
}

/** The flat GitHub release asset name of an item: `content.<kind>.<name>`. Throws on an invalid kind or name. */
export function contentAssetName(kind: ContentKind, name: string): string {
  if (!isContentKind(kind)) throw new ContentVerificationError(`invalid kind ("${kind}")`);
  const problem = contentNameProblem(name);
  if (problem) throw new ContentVerificationError(`invalid name ("${name}"): ${problem}`);
  return `${ASSET_PREFIX}${kind}.${name}`;
}

/** Inverse of `contentAssetName`; null for anything else (the three loose names, A1's `phanos-...` names). */
export function parseContentAssetName(asset: string): { kind: ContentKind; name: string } | null {
  if (!asset.startsWith(ASSET_PREFIX)) return null;
  const rest = asset.slice(ASSET_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot < 1) return null;
  const kind = rest.slice(0, dot);
  const name = rest.slice(dot + 1);
  if (!isContentKind(kind) || contentNameProblem(name) !== null) return null;
  return { kind, name };
}
