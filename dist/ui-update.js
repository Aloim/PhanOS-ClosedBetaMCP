import { isNewerVersion } from './ui.js';
/**
 * Does the state record need this release's Pro UI installed? A release without UI never does; a state with no recorded UI does;
 * so does a recorded UI for another platform, or one older than the release. An equal or newer recorded UI is kept.
 */
export function uiUpdateNeeded(state, release) {
    if (!release.ui)
        return false;
    if (state.ui?.version === undefined)
        return true;
    if (state.ui.platform !== release.ui.platform)
        return true;
    return isNewerVersion(release.version, state.ui.version);
}
