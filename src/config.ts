// cyphor-role: CORE
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import type { Edition } from './state.js';

export const API_BASE = (process.env.PHANOS_API_BASE ?? 'https://phanos.eu').replace(/\/+$/, '');
export const CLIENT_ID = 'phanos-mcp';
export const PLUGIN_NAME = 'phanos';

/** Local (state file) edition names; the wire form is `Edition` in state.ts ('free' | 'pro'). */
export type LocalEdition = 'basic' | 'pro';

/** Full plugin ids, the only form ever passed to `claude plugin` (C1 §1). */
export const PLUGIN_IDS = {
  pro: `${PLUGIN_NAME}@phanos-pro`,
  basic: `${PLUGIN_NAME}@phanos-basic`,
} as const;

export function toWire(local: LocalEdition): Edition {
  return local === 'basic' ? 'free' : 'pro';
}

export function toLocal(wire: Edition): LocalEdition {
  return wire === 'free' ? 'basic' : 'pro';
}

/**
 * Launcher names, one per platform key, at the Pro plugin root (C1 §5.2 item 3, A6 closed in v1.6). PhanOS-UI ships
 * them and PhanOS's build-pro.js copies them there; each reads `<home>/ui/current` and starts that version's entry.
 */
export const LAUNCHER_LAYOUT = {
  'win32-x64': 'phanos-ui.bat',
  'linux-x64': 'phanos-ui.sh',
} as const;

export interface MarketplacePaths {
  name: 'phanos-pro' | 'phanos-basic';
  dir: string;
  pluginDir: string;
  marketplaceJson: string;
  filesList: string;
}

export interface Paths {
  home: string;
  tokenFile: string;
  stateFile: string;
  sessionFile: string;
  claudeConfigDir: string;
  marketplacesDir: string;
  marketplace: Record<LocalEdition, MarketplacePaths>;
  stagingDir: string;
  uiDir: string;
  uiCurrentFile: string;
}

function marketplacePaths(marketplacesDir: string, name: MarketplacePaths['name']): MarketplacePaths {
  const dir = join(marketplacesDir, name);
  return {
    name,
    dir,
    pluginDir: join(dir, PLUGIN_NAME),
    marketplaceJson: join(dir, '.claude-plugin', 'marketplace.json'),
    filesList: join(dir, `${PLUGIN_NAME}.files.json`),
  };
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env, homedir: string = osHomedir()): Paths {
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
