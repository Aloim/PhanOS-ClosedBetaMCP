// cyphor-role: CORE
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
export const API_BASE = (process.env.PHANOS_API_BASE ?? 'https://phanos.eu').replace(/\/+$/, '');
export const CLIENT_ID = 'phanos-mcp';
export const PLUGIN_NAME = 'phanos';
/** Full plugin ids, the only form ever passed to `claude plugin` (C1 §1). */
export const PLUGIN_IDS = {
    pro: `${PLUGIN_NAME}@phanos-pro`,
    basic: `${PLUGIN_NAME}@phanos-basic`,
};
export function toWire(local) {
    return local === 'basic' ? 'free' : 'pro';
}
export function toLocal(wire) {
    return wire === 'free' ? 'basic' : 'pro';
}
/**
 * Launcher names, one per platform key, at the Pro plugin root (C1 §5.2 item 3, A6 closed in v1.6). PhanOS-UI ships
 * them and PhanOS's build-pro.js copies them there; each reads `<home>/ui/current` and starts that version's entry.
 */
export const LAUNCHER_LAYOUT = {
    'win32-x64': 'phanos-ui.bat',
    'linux-x64': 'phanos-ui.sh',
};
function marketplacePaths(marketplacesDir, name) {
    const dir = join(marketplacesDir, name);
    return {
        name,
        dir,
        pluginDir: join(dir, PLUGIN_NAME),
        marketplaceJson: join(dir, '.claude-plugin', 'marketplace.json'),
        filesList: join(dir, `${PLUGIN_NAME}.files.json`),
    };
}
export function resolvePaths(env = process.env, homedir = osHomedir()) {
    const home = env.PHANOS_HOME ?? join(homedir, '.phanos');
    const marketplacesDir = join(home, 'marketplaces');
    const uiDir = join(home, 'ui');
    return {
        home,
        tokenFile: join(home, 'phanos-entitlement.jwt'),
        stateFile: join(home, 'state.json'),
        sessionFile: join(home, 'session.json'),
        claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? join(homedir, '.claude'),
        marketplacesDir,
        marketplace: {
            pro: marketplacePaths(marketplacesDir, 'phanos-pro'),
            basic: marketplacePaths(marketplacesDir, 'phanos-basic'),
        },
        stagingDir: join(home, 'staging'),
        uiDir,
        uiCurrentFile: join(uiDir, 'current'),
    };
}
