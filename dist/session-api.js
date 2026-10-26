// cyphor-role: CORE
// S5-2.01: the session HTTP client (entitlement sessions, coordination batch and view). Mirrors api.ts: 30 s timeout, ApiError mapping.
import { ApiError } from './api.js';
export class HttpSessionApi {
    base;
    fetchImpl;
    timeoutMs;
    constructor(base, fetchImpl = fetch, timeoutMs = 30_000) {
        this.base = base;
        this.fetchImpl = fetchImpl;
        this.timeoutMs = timeoutMs;
    }
    /** The Pro bearer on every route; a JSON body when one is given. A network failure is `ApiError(0, 'network')`. */
    async send(method, path, token, body) {
        const headers = new Headers({ authorization: `Bearer ${token}` });
        const payload = body === undefined ? undefined : JSON.stringify(body);
        if (payload !== undefined)
            headers.set('content-type', 'application/json');
        try {
            return await this.fetchImpl(`${this.base}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(this.timeoutMs) });
        }
        catch {
            throw new ApiError(0, 'network', `Cannot reach ${this.base}. Check your internet connection and try again.`);
        }
    }
    /** The JSON object of an answer body; anything else reads as an empty object. */
    async jsonBody(res) {
        const parsed = await res.json().catch(() => null);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    }
    /** The `ApiError` of a refusal, from the server's `{error, message}` body (`error_description` as a fallback). */
    async refusal(res) {
        const body = await this.jsonBody(res);
        const error = typeof body.error === 'string' && body.error !== '' ? body.error : `http_${res.status}`;
        const message = typeof body.message === 'string' ? body.message : typeof body.error_description === 'string' ? body.error_description : `The server answered ${res.status}.`;
        return new ApiError(res.status, error, message);
    }
    async beat(token, body) {
        const res = await this.send('POST', '/api/entitlement/sessions/beat', token, body);
        if (!res.ok)
            throw await this.refusal(res);
        return (await res.json());
    }
    async end(token, body) {
        const res = await this.send('POST', '/api/entitlement/sessions/end', token, body);
        if (res.status === 204)
            return;
        if (!res.ok)
            throw await this.refusal(res);
        throw new ApiError(res.status, `http_${res.status}`, `The server answered ${res.status} to the session end; expected 204.`);
    }
    async coordBatch(token, installId, body) {
        const res = await this.send('POST', `/api/coord/${encodeURIComponent(installId)}/batch`, token, body);
        const payload = await this.jsonBody(res);
        if (res.status === 200)
            return { status: 200, lastSeq: payload.lastSeq, resync: payload.resync };
        if (res.status === 409 && typeof payload.expectedSeq === 'number')
            return { status: 409, expectedSeq: payload.expectedSeq };
        const error = typeof payload.error === 'string' && payload.error !== '' ? payload.error : `http_${res.status}`;
        const message = typeof payload.message === 'string' ? payload.message : `The server answered ${res.status}.`;
        return { status: res.status, error, message };
    }
    async coordView(token, installId, rootId) {
        const res = await this.send('GET', `/api/coord/${encodeURIComponent(installId)}/view?rootId=${encodeURIComponent(rootId)}`, token);
        if (!res.ok)
            throw await this.refusal(res);
        return (await res.json());
    }
}
