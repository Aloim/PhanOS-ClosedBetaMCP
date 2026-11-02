function throwIfAborted(signal) {
    if (signal?.aborted)
        throw signal.reason;
}
// Waits `ms`, but rejects at once with the signal's own reason if the signal aborts first.
function sleepOrAbort(deps, ms, signal) {
    if (!signal)
        return deps.sleep(ms);
    if (signal.aborted)
        return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        deps.sleep(ms).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}
export async function pollDeviceFlow(deps, flow, opts) {
    const signal = opts?.signal;
    let interval = flow.interval;
    const deadline = deps.now().getTime() + flow.expiresIn * 1000;
    for (;;) {
        throwIfAborted(signal);
        await sleepOrAbort(deps, interval * 1000, signal);
        throwIfAborted(signal);
        if (deps.now().getTime() > deadline)
            return { status: 'expired' };
        throwIfAborted(signal);
        const r = await deps.api.pollDeviceToken(flow.deviceCode);
        if (r.status === 'pending')
            continue;
        if (r.status === 'slow_down') {
            interval += 5;
            continue;
        }
        if (r.status === 'denied')
            return { status: 'denied' };
        if (r.status === 'expired')
            return { status: 'expired' };
        return { status: 'ok', accessToken: r.accessToken };
    }
}
