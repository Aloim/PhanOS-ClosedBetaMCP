// cyphor-role: IO
import { CLIENT_ID } from './config.js';
import { MCP_VERSION } from './version.js';
export class ApiError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
/** The five account states of C1 §3.1. Only `ended` and `never` select Basic; `grace` keeps Pro. */
export const ACCOUNT_STATES = ['active', 'grace', 'trial', 'ended', 'never'];
/**
 * C1 §3.1 client rule (P-2): any failure to read a valid `state` is `unknown`, and unknown changes nothing.
 * Never throws.
 */
export async function readAccount(api, session) {
    let me;
    try {
        me = await api.me(session);
    }
    catch (e) {
        if (e instanceof ApiError) {
            if (e.status === 401)
                return { kind: 'unknown', reason: 'unauthenticated', message: 'Your sign-in has lapsed. Run phanos_login to sign in again.' };
            if (e.code === 'network' || e.status === 0)
                return { kind: 'unknown', reason: 'network', message: e.message };
            if (e.status >= 500)
                return { kind: 'unknown', reason: 'server', message: `The server answered ${e.status}. Try again in a minute.` };
            return { kind: 'unknown', reason: 'error', message: e.message };
        }
        return { kind: 'unknown', reason: 'unparsable', message: 'The account answer could not be read.' };
    }
    if (typeof me !== 'object' || me === null)
        return { kind: 'unknown', reason: 'unparsable', message: 'The account answer could not be read.' };
    const state = me.state;
    if (typeof state !== 'string' || !ACCOUNT_STATES.includes(state)) {
        return { kind: 'unknown', reason: 'invalid_state', message: 'The account answer carried no recognised state.' };
    }
    return { kind: 'known', state: state, me };
}
export class HttpApi {
    base;
    fetchImpl;
    timeoutMs;
    stallMs;
    constructor(base, fetchImpl = fetch, timeoutMs = 30_000, stallMs = 30_000) {
        this.base = base;
        this.fetchImpl = fetchImpl;
        this.timeoutMs = timeoutMs;
        this.stallMs = stallMs;
    }
    async send(url, init = {}) {
        const headers = new Headers(init.headers);
        if (init.bearer)
            headers.set('authorization', `Bearer ${init.bearer}`);
        if (init.body && !headers.has('content-type'))
            headers.set('content-type', 'application/json');
        try {
            return await this.fetchImpl(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(this.timeoutMs) });
        }
        catch {
            throw new ApiError(0, 'network', `Cannot reach ${this.base}. Check your internet connection and try again.`);
        }
    }
    async ok(res) {
        if (res.ok)
            return (res.status === 204 ? undefined : await res.json());
        const body = (await res.json().catch(() => ({})));
        throw new ApiError(res.status, body.error ?? `http_${res.status}`, body.message ?? body.error_description ?? `The server answered ${res.status}.`);
    }
    async startDeviceFlow() {
        const b = await this.ok(await this.send(`${this.base}/api/auth/device/code`, { method: 'POST', body: JSON.stringify({ client_id: CLIENT_ID, scope: 'phanos' }) }));
        return {
            deviceCode: b.device_code,
            userCode: b.user_code,
            verificationUri: b.verification_uri,
            verificationUriComplete: b.verification_uri_complete ?? `${b.verification_uri}?user_code=${encodeURIComponent(b.user_code)}`,
            expiresIn: b.expires_in,
            interval: b.interval ?? 5,
        };
    }
    async pollDeviceToken(deviceCode) {
        const res = await this.send(`${this.base}/api/auth/device/token`, {
            method: 'POST',
            body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode, client_id: CLIENT_ID }),
        });
        const body = (await res.json().catch(() => ({})));
        if (res.ok && body.access_token)
            return { status: 'ok', accessToken: body.access_token };
        if (body.error === 'authorization_pending')
            return { status: 'pending' };
        if (body.error === 'slow_down')
            return { status: 'slow_down' };
        if (body.error === 'access_denied')
            return { status: 'denied' };
        if (body.error === 'expired_token')
            return { status: 'expired' };
        throw new ApiError(res.status, body.error ?? 'device_flow_failed', body.error_description ?? 'Sign-in failed. Run phanos_login again.');
    }
    async me(session) {
        return this.ok(await this.send(`${this.base}/api/entitlement/me`, { bearer: session }));
    }
    async registerDevice(session, label, platform) {
        return this.ok(await this.send(`${this.base}/api/entitlement/devices`, { method: 'POST', bearer: session, body: JSON.stringify({ label, platform }) }));
    }
    async deleteDevice(session, id) {
        await this.ok(await this.send(`${this.base}/api/entitlement/devices/${encodeURIComponent(id)}`, { method: 'DELETE', bearer: session }));
    }
    /** C1 §3.3 device report (W8a.2): the server answers 204 and nothing else counts as success. */
    async reportDeviceState(session, deviceId, state) {
        const res = await this.send(`${this.base}/api/entitlement/devices/${encodeURIComponent(deviceId)}/state`, {
            method: 'PUT',
            bearer: session,
            body: JSON.stringify({ enabled: state.enabled, version: state.version }),
        });
        if (res.status === 204)
            return;
        if (res.ok)
            throw new ApiError(res.status, `http_${res.status}`, `The server answered ${res.status} to the device report; expected 204.`);
        await this.ok(res);
    }
    /** C1 section 18 item 3: bearer, JSON body, a `phanos-mcp/<version>` user agent; any non-2xx goes through `ok()`. */
    async submitFeedback(session, body) {
        return this.ok(await this.send(`${this.base}/api/feedback`, {
            method: 'POST',
            bearer: session,
            headers: { 'user-agent': `phanos-mcp/${MCP_VERSION}` },
            body: JSON.stringify(body),
        }));
    }
    async getToken(session, deviceId) {
        return this.ok(await this.send(`${this.base}/api/entitlement/token`, { method: 'POST', bearer: session, body: JSON.stringify({ deviceId }) }));
    }
    async getManifest(edition, bearer) {
        return this.ok(await this.send(`${this.base}/api/releases/${edition}/manifest`, { bearer }));
    }
    async downloadArchive(edition, file, token) {
        const first = await this.send(`${this.base}/api/releases/${edition}/archive/${encodeURIComponent(file)}`, { bearer: token, redirect: 'manual' });
        let res = first;
        if (first.status >= 300 && first.status < 400) {
            const location = first.headers.get('location');
            if (!location)
                throw new ApiError(502, 'bad_redirect', 'The download link was missing. Try again in a minute.');
            res = await this.send(location, { redirect: 'follow' }); // no bearer: the presigned URL carries its own auth
        }
        if (!res.ok)
            await this.ok(res);
        return Buffer.from(await res.arrayBuffer());
    }
    async downloadArtifact(edition, file, bearer, expectedSize) {
        const ctl = new AbortController();
        let timer;
        let onStall = () => { };
        const stalled = () => new ApiError(0, 'stalled', 'The download stopped receiving data. Check your internet connection and try again.');
        // The stall timer is re-armed on every sign of life (headers, each chunk); it is never a total timeout.
        const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => { ctl.abort(); onStall(stalled()); }, this.stallMs);
        };
        const tooLarge = () => new ApiError(502, 'too_large', `The download is larger than the ${expectedSize} bytes the manifest promised. It was stopped.`);
        const guard = async (p) => {
            try {
                return await p;
            }
            catch (e) {
                if (ctl.signal.aborted)
                    throw stalled();
                throw e;
            }
        };
        arm();
        try {
            const first = await guard(this.send(`${this.base}/api/releases/${edition}/archive/${encodeURIComponent(file)}`, { bearer, redirect: 'manual', signal: ctl.signal }));
            let res = first;
            if (first.status >= 300 && first.status < 400) {
                const location = first.headers.get('location');
                if (!location)
                    throw new ApiError(502, 'bad_redirect', 'The download link was missing. Try again in a minute.');
                arm();
                res = await guard(this.send(location, { redirect: 'follow', signal: ctl.signal })); // no bearer: the presigned URL carries its own auth
            }
            if (!res.ok)
                await this.ok(res);
            const declared = Number(res.headers.get('content-length'));
            if (Number.isFinite(declared) && declared > expectedSize) {
                await res.body?.cancel().catch(() => { });
                throw tooLarge();
            }
            if (!res.body) {
                const all = Buffer.from(await res.arrayBuffer());
                if (all.length > expectedSize)
                    throw tooLarge();
                return all;
            }
            const reader = res.body.getReader();
            const chunks = [];
            let total = 0;
            try {
                for (;;) {
                    arm();
                    const part = await guard(new Promise((resolve, reject) => {
                        onStall = reject;
                        reader.read().then(resolve, reject);
                    }));
                    if (part.done)
                        break;
                    total += part.value.length;
                    if (total > expectedSize)
                        throw tooLarge();
                    chunks.push(Buffer.from(part.value));
                }
            }
            catch (e) {
                await reader.cancel().catch(() => { });
                throw e;
            }
            return Buffer.concat(chunks);
        }
        finally {
            clearTimeout(timer);
        }
    }
}
