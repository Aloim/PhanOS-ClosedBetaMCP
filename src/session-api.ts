// cyphor-role: CORE
// S5-2.01: the session HTTP client (entitlement sessions, coordination batch and view). Mirrors api.ts: 30 s timeout, ApiError mapping.
import { ApiError } from './api.js';

/** `POST /api/entitlement/sessions/beat` body. `pluginVersion` is null when the caller does not know it. */
export interface BeatBody {
  deviceId: string;
  installId: string;
  sessionKey: string;
  pluginVersion: string | null;
}

/** `POST /api/entitlement/sessions/end` body. */
export interface EndBody {
  deviceId: string;
  installId: string;
  sessionKey: string;
}

/** `POST /api/coord/<installId>/batch` body. */
export interface CoordBatchBody {
  rootId: string;
  fromSeq: number;
  sessionKey: string;
  records: unknown[];
}

/** 200 of the beat route: the server's pacing, in seconds, and its clock. */
export interface BeatAnswer {
  intervalS: number;
  graceS: number;
  serverTime: number;
}

/**
 * Answer of the coordination batch route. A 409 is an answer, not a throw: `expectedSeq` is the sequence the server holds.
 * Any other refusal comes back as the third shape, its `error` and `message` taken from the server's JSON body.
 */
export type CoordBatchAnswer =
  | { status: 200; lastSeq: number; resync: boolean }
  | { status: 409; expectedSeq: number }
  | { status: number; error: string; message: string };

/** 200 of the coordination view route. */
export interface CoordViewAnswer {
  schema: 1;
  at: string;
  records: { kind: string; key: string; body: unknown; host: string }[];
  ids: { kind: string; from: number; to: number }[];
}

export interface SessionApi {
  /** Resolves with the pacing answer on 200; every refusal (400, 403, 409 `session_ended`, 429, ...) throws `ApiError`. */
  beat(token: string, body: BeatBody): Promise<BeatAnswer>;
  /** Resolves on 204; any other answer throws `ApiError`. */
  end(token: string, body: EndBody): Promise<void>;
  /** Never throws on an HTTP answer; only a network failure throws `ApiError(0, 'network')`. */
  coordBatch(token: string, installId: string, body: CoordBatchBody): Promise<CoordBatchAnswer>;
  /** Resolves with the view on 200; any failure throws `ApiError`. */
  coordView(token: string, installId: string, rootId: string): Promise<CoordViewAnswer>;
}

export class HttpSessionApi implements SessionApi {
  constructor(
    readonly base: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  /** The Pro bearer on every route; a JSON body when one is given. A network failure is `ApiError(0, 'network')`. */
  private async send(method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<Response> {
    const headers = new Headers({ authorization: `Bearer ${token}` });
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers.set('content-type', 'application/json');
    try {
      return await this.fetchImpl(`${this.base}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new ApiError(0, 'network', `Cannot reach ${this.base}. Check your internet connection and try again.`);
    }
  }

  /** The JSON object of an answer body; anything else reads as an empty object. */
  private async jsonBody(res: Response): Promise<Record<string, unknown>> {
    const parsed: unknown = await res.json().catch(() => null);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  }

  /** The `ApiError` of a refusal, from the server's `{error, message}` body (`error_description` as a fallback). */
  private async refusal(res: Response): Promise<ApiError> {
    const body = await this.jsonBody(res);
    const error = typeof body.error === 'string' && body.error !== '' ? body.error : `http_${res.status}`;
    const message =
      typeof body.message === 'string' ? body.message : typeof body.error_description === 'string' ? body.error_description : `The server answered ${res.status}.`;
    return new ApiError(res.status, error, message);
  }

  async beat(token: string, body: BeatBody): Promise<BeatAnswer> {
    const res = await this.send('POST', '/api/entitlement/sessions/beat', token, body);
    if (!res.ok) throw await this.refusal(res);
    return (await res.json()) as BeatAnswer;
  }

  async end(token: string, body: EndBody): Promise<void> {
    const res = await this.send('POST', '/api/entitlement/sessions/end', token, body);
    if (res.status === 204) return;
    if (!res.ok) throw await this.refusal(res);
    throw new ApiError(res.status, `http_${res.status}`, `The server answered ${res.status} to the session end; expected 204.`);
  }

  async coordBatch(token: string, installId: string, body: CoordBatchBody): Promise<CoordBatchAnswer> {
    const res = await this.send('POST', `/api/coord/${encodeURIComponent(installId)}/batch`, token, body);
    const payload = await this.jsonBody(res);
    if (res.status === 200) return { status: 200, lastSeq: payload.lastSeq as number, resync: payload.resync as boolean };
    if (res.status === 409 && typeof payload.expectedSeq === 'number') return { status: 409, expectedSeq: payload.expectedSeq };
    const error = typeof payload.error === 'string' && payload.error !== '' ? payload.error : `http_${res.status}`;
    const message = typeof payload.message === 'string' ? payload.message : `The server answered ${res.status}.`;
    return { status: res.status, error, message };
  }

  async coordView(token: string, installId: string, rootId: string): Promise<CoordViewAnswer> {
    const res = await this.send('GET', `/api/coord/${encodeURIComponent(installId)}/view?rootId=${encodeURIComponent(rootId)}`, token);
    if (!res.ok) throw await this.refusal(res);
    return (await res.json()) as CoordViewAnswer;
  }
}
