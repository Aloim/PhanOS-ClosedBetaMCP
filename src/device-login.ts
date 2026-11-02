// cyphor-role: CORE
import { ApiError, type Api, type DeviceFlowStart, type Plan } from './api.js';
import type { Paths } from './config.js';
import { pollDeviceFlow, type DeviceFlowOutcome } from './device-flow.js';
import type { SecretStore } from './secrets.js';
import { readLocalState, withStateLock, writeLocalState, writeToken } from './state.js';

export interface LoginDeps {
  api: Api;
  secrets: SecretStore;
  paths: Paths;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  hostname: string;
  platform: string;
}

export class DeviceLoginError extends Error {
  constructor(readonly code: 'expired' | 'declined' | 'offline', message: string) {
    super(message);
  }
}

/** What happened, per code. The caller says how to start again (the terminal: run the command again; the UI: its own button). */
export const DEVICE_LOGIN_TEXT: Record<DeviceLoginError['code'], string> = {
  expired: 'The sign-in code expired before it was confirmed in the browser, so this computer was not connected to your account.',
  declined: 'Sign-in was refused in the browser, so this computer was not connected to your account.',
  offline: 'Could not reach the PhanOS server, so this computer was not connected to your account. Check the internet connection.',
};

const isNetwork = (e: unknown): boolean => e instanceof ApiError && (e.code === 'network' || e.status === 0);

const PAID: ReadonlySet<Plan> = new Set<Plan>(['pro', 'pro_budget', 'business']);

export async function startDeviceLogin(
  deps: LoginDeps,
  opts?: { signal?: AbortSignal },
): Promise<{ verificationUrl: string; userCode: string; wait(): Promise<{ plan: Plan }> }> {
  let flow: DeviceFlowStart;
  try {
    flow = await deps.api.startDeviceFlow();
  } catch (e) {
    if (isNetwork(e)) throw new DeviceLoginError('offline', DEVICE_LOGIN_TEXT.offline);
    throw e;
  }
  return {
    verificationUrl: flow.verificationUriComplete,
    userCode: flow.userCode,
    wait: () => waitForApproval(deps, flow, opts?.signal),
  };
}

async function waitForApproval(deps: LoginDeps, flow: DeviceFlowStart, signal?: AbortSignal): Promise<{ plan: Plan }> {
  let outcome: DeviceFlowOutcome;
  try {
    outcome = await pollDeviceFlow({ api: deps.api, sleep: deps.sleep, now: deps.now }, flow, { signal });
  } catch (e) {
    if (isNetwork(e)) throw new DeviceLoginError('offline', DEVICE_LOGIN_TEXT.offline);
    throw e;
  }
  if (outcome.status === 'denied') throw new DeviceLoginError('declined', DEVICE_LOGIN_TEXT.declined);
  if (outcome.status === 'expired') throw new DeviceLoginError('expired', DEVICE_LOGIN_TEXT.expired);
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
