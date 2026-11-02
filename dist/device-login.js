// cyphor-role: CORE
import { ApiError } from './api.js';
import { pollDeviceFlow } from './device-flow.js';
import { readLocalState, withStateLock, writeLocalState, writeToken } from './state.js';
export class DeviceLoginError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** What happened, per code. The caller says how to start again (the terminal: run the command again; the UI: its own button). */
export const DEVICE_LOGIN_TEXT = {
    expired: 'The sign-in code expired before it was confirmed in the browser, so this computer was not connected to your account.',
    declined: 'Sign-in was refused in the browser, so this computer was not connected to your account.',
    offline: 'Could not reach the PhanOS server, so this computer was not connected to your account. Check the internet connection.',
};
const isNetwork = (e) => e instanceof ApiError && (e.code === 'network' || e.status === 0);
const PAID = new Set(['pro', 'pro_budget', 'business']);
export async function startDeviceLogin(deps, opts) {
    let flow;
    try {
        flow = await deps.api.startDeviceFlow();
    }
    catch (e) {
        if (isNetwork(e))
            throw new DeviceLoginError('offline', DEVICE_LOGIN_TEXT.offline);
        throw e;
    }
    return {
        verificationUrl: flow.verificationUriComplete,
        userCode: flow.userCode,
        wait: () => waitForApproval(deps, flow, opts?.signal),
    };
}
async function waitForApproval(deps, flow, signal) {
    let outcome;
    try {
        outcome = await pollDeviceFlow({ api: deps.api, sleep: deps.sleep, now: deps.now }, flow, { signal });
    }
    catch (e) {
        if (isNetwork(e))
            throw new DeviceLoginError('offline', DEVICE_LOGIN_TEXT.offline);
        throw e;
    }
    if (outcome.status === 'denied')
        throw new DeviceLoginError('declined', DEVICE_LOGIN_TEXT.declined);
    if (outcome.status === 'expired')
        throw new DeviceLoginError('expired', DEVICE_LOGIN_TEXT.expired);
    const accessToken = outcome.accessToken;
    await deps.secrets.set(accessToken);
    const me = await deps.api.me(accessToken);
    if (PAID.has(me.plan)) {
        // One short lock, released before this returns: the terminal installer's `install` never overlaps it.
        await withStateLock(deps.paths, async () => {
            const state = await readLocalState(deps.paths);
            let deviceId = state.deviceId;
            if (deviceId === undefined) {
                deviceId = (await deps.api.registerDevice(accessToken, deps.hostname, deps.platform)).id;
                // Persist the new id before the token fetch: if that fetch fails, a retry must not register a second device.
                await writeLocalState(deps.paths, { ...state, deviceId });
            }
            const t = await deps.api.getToken(accessToken, deviceId);
            await writeToken(deps.paths, t.token);
            await writeLocalState(deps.paths, { ...state, email: me.email, deviceId, tokenExpiresAt: t.expiresAt });
        });
    }
    return { plan: me.plan };
}
