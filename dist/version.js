// cyphor-role: CORE
import { createRequire } from 'node:module';
/** The installed @phanos/mcp version, read from package.json (the same way index.ts reads it). */
export const MCP_VERSION = createRequire(import.meta.url)('../package.json').version;
