// cyphor-role: IO
import { CLIENT_ID, type LocalEdition } from './config.js';
import type { ContentKind } from './content-manifest.js';
import type { FeedbackReceipt, FeedbackWire } from './feedback.js';
import type { Edition } from './state.js';
import { MCP_VERSION } from './version.js';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export type Plan = 'free' | 'pro' | 'business';
export interface Me {
  email: string;
  plan: Plan;
  until: string | null;
  /** C1 §3.1: one of ACCOUNT_STATES. Optional: an older server omits it. Read it through `readAccount`, never directly. */
  state?: string;
  deviceLimit: number;
  devices: { id: string; label: string; platform: string; lastSeenAt: string }[];
}

/** The five account states of C1 §3.1. Only `ended` and `never` select Basic; `grace` keeps Pro. */
export const ACCOUNT_STATES = ['active', 'grace', 'trial', 'ended', 'never'] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];
export type UnknownReason = 'network' | 'server' | 'unauthenticated' | 'unparsable' | 'invalid_state' | 'error';
/** `message` is a human-readable companion to `reason`; callers branch on `reason`. */
export type AccountRead = { kind: 'known'; state: AccountState; me: Me } | { kind: 'unknown'; reason: UnknownReason; message: string };

/**
 * C1 §3.1 client rule (P-2): any failure to read a valid `state` is `unknown`, and unknown changes nothing.
 * Never throws.
 */
export async function readAccount(api: Pick<Api, 'me'>, session: string): Promise<AccountRead> {
  let me: Me;
  try {
    me = await api.me(session);
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 401) return { kind: 'unknown', reason: 'unauthenticated', message: 'Your sign-in has lapsed. Run phanos_login to sign in again.' };
      if (e.code === 'network' || e.status === 0) return { kind: 'unknown', reason: 'network', message: e.message };
      if (e.status >= 500) return { kind: 'unknown', reason: 'server', message: `The server answered ${e.status}. Try again in a minute.` };
      return { kind: 'unknown', reason: 'error', message: e.message };
    }
    return { kind: 'unknown', reason: 'unparsable', message: 'The account answer could not be read.' };
  }
  if (typeof me !== 'object' || me === null) return { kind: 'unknown', reason: 'unparsable', message: 'The account answer could not be read.' };
  const state = (me as Me).state;
  if (typeof state !== 'string' || !(ACCOUNT_STATES as readonly string[]).includes(state)) {
    return { kind: 'unknown', reason: 'invalid_state', message: 'The account answer carried no recognised state.' };
  }
  return { kind: 'known', state: state as AccountState, me };
}
export interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}
export type DevicePoll =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'ok'; accessToken: string };
export interface SignedManifest {
  manifest: string;
  signature: { kid: string; sig: string };
  /** C-10: beside the signed text, not covered by it. Read it through `readKillSwitch`, never directly. */
  switch?: { downgrade?: unknown };
}

/** C-10: `on` allows downgrades, `off` stops them, `unread` means the manifest could not be read (no downgrade at this start). */
export type KillSwitch = 'on' | 'off' | 'unread';

/**
 * C-10 reading rules: a null manifest is `unread`; an absent switch or downgrade, or `on`, is `on`;
 * any other value, a null switch included, is `off`. Pure; never throws.
 */
export function readKillSwitch(m: SignedManifest | null): KillSwitch {
  if (m === null || typeof m !== 'object') return 'unread';
  if (m.switch === undefined) return 'on';
  if (m.switch === null || typeof m.switch !== 'object') return 'off';
  const downgrade = m.switch.downgrade;
  return downgrade === undefined || downgrade === 'on' ? 'on' : 'off';
}

/** C-10: reads the free manifest with the session (the `pro` route answers an ended or never account 401). Any thrown error, 404 `no_release` included, is `unread`. */
export async function fetchKillSwitch(api: Pick<Api, 'getManifest'>, session: string): Promise<KillSwitch> {
  let manifest: SignedManifest;
  try {
    manifest = await api.getManifest('free', session);
  } catch {
    return 'unread';
  }
  return readKillSwitch(manifest);
}

/** C-9 `/manifest` body (03_c9-wire-client.md section 3). The client validates the shape; a 200 that does not parse arrives as `null`. */
export interface ContentEnvelope {
  pluginVersion: string;
  contentVersion: string;
  sha256: string;
  manifest: string;
  signature: { kid: string; sig: string };
}

/** C-9 answer: 200 and 304 carry the ETag (quotes and `W/` stripped) and `x-content-version`; every other status carries `error` (`body.error ?? http_<status>`). */
export type ContentAnswer<T> =
  | { status: 200; etag: string; contentVersion: string; body: T }
  | { status: 304; etag: string; contentVersion: string }
  | { status: number; error: string; message: string };

export interface Api {
  startDeviceFlow(): Promise<DeviceFlowStart>;
  pollDeviceToken(deviceCode: string): Promise<DevicePoll>;
  me(session: string): Promise<Me>;
  registerDevice(session: string, label: string, platform: string): Promise<{ id: string }>;
  deleteDevice(session: string, id: string): Promise<void>;
  /** C1 §3.3: best-effort device report, `PUT /api/entitlement/devices/:id/state` with the session bearer. Resolves on 204, throws `ApiError` otherwise. */
  reportDeviceState(session: string, deviceId: string, state: { enabled: LocalEdition; version: string }): Promise<void>;
  getToken(session: string, deviceId: string): Promise<{ token: string; expiresAt: string; plan: 'pro' | 'business'; serverTime?: number }>;
  /** `bearer` is the session token for `free` (C1 §3.3, W3) and the entitlement token for `pro`. */
  getManifest(edition: Edition, bearer?: string): Promise<SignedManifest>;
  downloadArchive(edition: Edition, file: string, token?: string): Promise<Buffer>;
  /**
   * Safe download: `bearer` is the session for `free`, the token for `pro`; none is kept on the presigned redirect.
   * Streams, aborts once more than `expectedSize` bytes arrive, and times out only on a stall.
   */
  downloadArtifact(edition: Edition, file: string, bearer: string | undefined, expectedSize: number): Promise<Buffer>;
  /** C1 section 18: `POST /api/feedback` with the session bearer. Resolves with the 201 receipt, throws `ApiError` otherwise. */
  submitFeedback(session: string, body: FeedbackWire): Promise<FeedbackReceipt>;
  /** WE-3.04 ruling 2: the numeric `corpusVersion` of `GET /api/corpus/manifest.json` with the Pro token; `null` on any failure. Never throws. */
  getCorpusVersion(token: string): Promise<number | null>;
  /**
   * C-9 `GET /api/content/<pluginVersion>/manifest[?pin=]` with the Pro token. `etag` is the cached manifest sha256 (lowercase hex; sent quoted as
   * `if-none-match`). Every HTTP status returns; a network failure throws `ApiError(0, 'network')`. Optional: a fake without it reads as "server unreachable".
   */
  getContentManifest?(pluginVersion: string, pin: string | null, token: string, etag?: string): Promise<ContentAnswer<ContentEnvelope>>;
  /** C-9 `GET /api/content/<pluginVersion>/<kind>/<name>[?pin=]`; the body is cut off after `maxBytes + 1` bytes (default 1 MiB), so a longer body fails the caller's length check. Optional like `getContentManifest`. `installId`, when given, is sent as `X-PhanOS-Install-Id`. */
  getContentItem?(pluginVersion: string, kind: ContentKind, name: string, pin: string | null, token: string, etag?: string, maxBytes?: number, installId?: string): Promise<ContentAnswer<Uint8Array>>;
}

export class HttpApi implements Api {
  constructor(
    readonly base: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
    private readonly stallMs = 30_000,
  ) {}

  private async send(url: string, init: RequestInit & { bearer?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.bearer) headers.set('authorization', `Bearer ${init.bearer}`);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    try {
      return await this.fetchImpl(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new ApiError(0, 'network', `Cannot reach ${this.base}. Check your internet connection and try again.`);
    }
  }

  private async ok<T>(res: Response): Promise<T> {
    if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; error_description?: string };
    throw new ApiError(res.status, body.error ?? `http_${res.status}`, body.message ?? body.error_description ?? `The server answered ${res.status}.`);
  }

  async startDeviceFlow(): Promise<DeviceFlowStart> {
    const b = await this.ok<{ device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval?: number }>(
      await this.send(`${this.base}/api/auth/device/code`, { method: 'POST', body: JSON.stringify({ client_id: CLIENT_ID, scope: 'phanos' }) }),
    );
    return {
      deviceCode: b.device_code,
      userCode: b.user_code,
      verificationUri: b.verification_uri,
      verificationUriComplete: b.verification_uri_complete ?? `${b.verification_uri}?user_code=${encodeURIComponent(b.user_code)}`,
      expiresIn: b.expires_in,
      interval: b.interval ?? 5,
    };
  }

  async pollDeviceToken(deviceCode: string): Promise<DevicePoll> {
    const res = await this.send(`${this.base}/api/auth/device/token`, {
      method: 'POST',
      body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode, client_id: CLIENT_ID }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
    if (res.ok && body.access_token) return { status: 'ok', accessToken: body.access_token };
    if (body.error === 'authorization_pending') return { status: 'pending' };
    if (body.error === 'slow_down') return { status: 'slow_down' };
    if (body.error === 'access_denied') return { status: 'denied' };
    if (body.error === 'expired_token') return { status: 'expired' };
    throw new ApiError(res.status, body.error ?? 'device_flow_failed', body.error_description ?? 'Sign-in failed. Run phanos_login again.');
  }

  async me(session: string): Promise<Me> {
    return this.ok(await this.send(`${this.base}/api/entitlement/me`, { bearer: session }));
  }

  async registerDevice(session: string, label: string, platform: string): Promise<{ id: string }> {
    return this.ok(await this.send(`${this.base}/api/entitlement/devices`, { method: 'POST', bearer: session, body: JSON.stringify({ label, platform }) }));
  }

  async deleteDevice(session: string, id: string): Promise<void> {
    await this.ok(await this.send(`${this.base}/api/entitlement/devices/${encodeURIComponent(id)}`, { method: 'DELETE', bearer: session }));
  }

  /** C1 §3.3 device report (W8a.2): the server answers 204 and nothing else counts as success. */
  async reportDeviceState(session: string, deviceId: string, state: { enabled: LocalEdition; version: string }): Promise<void> {
    const res = await this.send(`${this.base}/api/entitlement/devices/${encodeURIComponent(deviceId)}/state`, {
      method: 'PUT',
      bearer: session,
      body: JSON.stringify({ enabled: state.enabled, version: state.version }),
    });
    if (res.status === 204) return;
    if (res.ok) throw new ApiError(res.status, `http_${res.status}`, `The server answered ${res.status} to the device report; expected 204.`);
    await this.ok(res);
  }

  /** C1 section 18 item 3: bearer, JSON body, a `phanos-mcp/<version>` user agent; any non-2xx goes through `ok()`. */
  async submitFeedback(session: string, body: FeedbackWire): Promise<FeedbackReceipt> {
    return this.ok<FeedbackReceipt>(
      await this.send(`${this.base}/api/feedback`, {
        method: 'POST',
        bearer: session,
        headers: { 'user-agent': `phanos-mcp/${MCP_VERSION}` },
        body: JSON.stringify(body),
      }),
    );
  }

  /** WE-3.04 ruling 2: any thrown error, non-2xx answer, missing key or non-number value is `null`; the method never throws. */
  async getCorpusVersion(token: string): Promise<number | null> {
    try {
      const body = await this.ok<{ corpusVersion?: unknown } | null>(await this.send(`${this.base}/api/corpus/manifest.json`, { bearer: token }));
      const version = body?.corpusVersion;
      return typeof version === 'number' ? version : null;
    } catch {
      return null;
    }
  }

  /** C-9 request headers: the Pro bearer and, when the caller holds the object, its sha256 as a strong quoted `if-none-match`; the install id, when given. */
  private contentInit(token: string, etag: string | undefined, installId?: string): RequestInit & { bearer: string } {
    const headers: Record<string, string> = {};
    if (etag !== undefined) headers['if-none-match'] = `"${etag}"`;
    if (installId) headers['X-PhanOS-Install-Id'] = installId;
    return { bearer: token, headers };
  }

  private contentUrl(pluginVersion: string, rest: string, pin: string | null): string {
    const query = pin === null ? '' : `?pin=${encodeURIComponent(pin)}`;
    return `${this.base}/api/content/${encodeURIComponent(pluginVersion)}/${rest}${query}`;
  }

  /** The ETag without `W/` and quotes, and `x-content-version`, of a 200 or 304 answer. */
  private contentMeta(res: Response): { etag: string; contentVersion: string } {
    const etag = (res.headers.get('etag') ?? '').replace(/^W\//, '').replace(/^"|"$/g, '');
    return { etag, contentVersion: res.headers.get('x-content-version') ?? '' };
  }

  private async contentFailure(res: Response): Promise<{ status: number; error: string; message: string }> {
    const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
    const error = typeof body?.error === 'string' && body.error !== '' ? body.error : `http_${res.status}`;
    const message = typeof body?.message === 'string' ? body.message : `The server answered ${res.status}.`;
    return { status: res.status, error, message };
  }

  async getContentManifest(pluginVersion: string, pin: string | null, token: string, etag?: string): Promise<ContentAnswer<ContentEnvelope>> {
    const res = await this.send(this.contentUrl(pluginVersion, 'manifest', pin), this.contentInit(token, etag));
    if (res.status === 304) return { status: 304, ...this.contentMeta(res) };
    if (res.status !== 200) return await this.contentFailure(res);
    const body = (await res.json().catch(() => null)) as ContentEnvelope;
    return { status: 200, ...this.contentMeta(res), body };
  }

  async getContentItem(
    pluginVersion: string,
    kind: ContentKind,
    name: string,
    pin: string | null,
    token: string,
    etag?: string,
    maxBytes = 1_048_576,
    installId?: string,
  ): Promise<ContentAnswer<Uint8Array>> {
    const res = await this.send(this.contentUrl(pluginVersion, `${encodeURIComponent(kind)}/${encodeURIComponent(name)}`, pin), this.contentInit(token, etag, installId));
    if (res.status === 304) return { status: 304, ...this.contentMeta(res) };
    if (res.status !== 200) return await this.contentFailure(res);
    return { status: 200, ...this.contentMeta(res), body: await this.readCapped(res, maxBytes + 1) };
  }

  /** Reads at most `limit` bytes of the body and stops; a stream that dies mid-body is a network failure. */
  private async readCapped(res: Response, limit: number): Promise<Uint8Array> {
    if (!res.body) return new Uint8Array(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < limit) {
        const part = await reader.read();
        if (part.done) break;
        chunks.push(part.value);
        total += part.value.length;
      }
    } catch {
      throw new ApiError(0, 'network', `The connection to ${this.base} dropped. Check your internet connection and try again.`);
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks).subarray(0, limit);
  }

  /** `serverTime` is whole epoch seconds from the answer's `Date` header; absent when the header is missing or unparsable. */
  async getToken(session: string, deviceId: string): Promise<{ token: string; expiresAt: string; plan: 'pro' | 'business'; serverTime?: number }> {
    const res = await this.send(`${this.base}/api/entitlement/token`, { method: 'POST', bearer: session, body: JSON.stringify({ deviceId }) });
    const body = await this.ok<{ token: string; expiresAt: string; plan: 'pro' | 'business' }>(res);
    const ms = Date.parse(res.headers.get('date') ?? '');
    return Number.isFinite(ms) ? { ...body, serverTime: Math.floor(ms / 1000) } : body;
  }

  async getManifest(edition: Edition, bearer?: string): Promise<SignedManifest> {
    return this.ok(await this.send(`${this.base}/api/releases/${edition}/manifest`, { bearer }));
  }

  async downloadArchive(edition: Edition, file: string, token?: string): Promise<Buffer> {
    const first = await this.send(`${this.base}/api/releases/${edition}/archive/${encodeURIComponent(file)}`, { bearer: token, redirect: 'manual' });
    let res = first;
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get('location');
      if (!location) throw new ApiError(502, 'bad_redirect', 'The download link was missing. Try again in a minute.');
      res = await this.send(location, { redirect: 'follow' }); // no bearer: the presigned URL carries its own auth
    }
    if (!res.ok) await this.ok(res);
    return Buffer.from(await res.arrayBuffer());
  }

  async downloadArtifact(edition: Edition, file: string, bearer: string | undefined, expectedSize: number): Promise<Buffer> {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onStall: (e: ApiError) => void = () => {};
    const stalled = () => new ApiError(0, 'stalled', 'The download stopped receiving data. Check your internet connection and try again.');
    // The stall timer is re-armed on every sign of life (headers, each chunk); it is never a total timeout.
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { ctl.abort(); onStall(stalled()); }, this.stallMs);
    };
    const tooLarge = () => new ApiError(502, 'too_large', `The download is larger than the ${expectedSize} bytes the manifest promised. It was stopped.`);
    const guard = async <T>(p: Promise<T>): Promise<T> => {
      try {
        return await p;
      } catch (e) {
        if (ctl.signal.aborted) throw stalled();
        throw e;
      }
    };
    arm();
    try {
      const first = await guard(this.send(`${this.base}/api/releases/${edition}/archive/${encodeURIComponent(file)}`, { bearer, redirect: 'manual', signal: ctl.signal }));
      let res = first;
      if (first.status >= 300 && first.status < 400) {
        const location = first.headers.get('location');
        if (!location) throw new ApiError(502, 'bad_redirect', 'The download link was missing. Try again in a minute.');
        arm();
        res = await guard(this.send(location, { redirect: 'follow', signal: ctl.signal })); // no bearer: the presigned URL carries its own auth
      }
      if (!res.ok) await this.ok(res);
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > expectedSize) {
        await res.body?.cancel().catch(() => {});
        throw tooLarge();
      }
      if (!res.body) {
        const all = Buffer.from(await res.arrayBuffer());
        if (all.length > expectedSize) throw tooLarge();
        return all;
      }
      const reader = res.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for (;;) {
          arm();
          const part = await guard(new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
            onStall = reject;
            reader.read().then(resolve, reject);
          }));
          if (part.done) break;
          total += part.value.length;
          if (total > expectedSize) throw tooLarge();
          chunks.push(Buffer.from(part.value));
        }
      } catch (e) {
        await reader.cancel().catch(() => {});
        throw e;
      }
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(timer);
    }
  }
}
