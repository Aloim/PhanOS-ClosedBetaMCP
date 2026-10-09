// cyphor-role: CORE
import type { ClaudeRunner } from './claude-cli.js';

/** Builds a runner for one command; `createCommandRunner` is the production value. */
export type CommandRunnerFactory = (cmd: string, platform?: NodeJS.Platform) => ClaudeRunner;

export interface PrereqItem {
  name: string;
  /** Probe arguments. A version query only, never a command that changes the tool (F-9857: not `uv self update`). */
  probe: string[];
  /** `required` is needed for the full result; it still never blocks the file install (F-9529). */
  need: 'required' | 'optional';
  install: { win32: string; linux: string };
  why: string;
  /** Vendor page each install command was taken from (research digest 0008). */
  url: { win32: string; linux: string };
}

export const PREREQS: readonly PrereqItem[] = [
  {
    name: 'claude',
    probe: ['--version'],
    need: 'required',
    install: { win32: 'irm https://claude.ai/install.ps1 | iex', linux: 'curl -fsSL https://claude.ai/install.sh | bash' },
    why: 'registers and enables the plugins in Claude Code',
    url: { win32: 'https://code.claude.com/docs/en/overview', linux: 'https://code.claude.com/docs/en/overview' },
  },
  {
    name: 'uv',
    probe: ['--version'],
    need: 'optional',
    install: {
      win32: 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
      linux: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
    },
    why: 'the serena code-navigation server runs through uv',
    url: { win32: 'https://docs.astral.sh/uv/getting-started/installation/', linux: 'https://docs.astral.sh/uv/getting-started/installation/' },
  },
  {
    name: 'git',
    probe: ['--version'],
    need: 'optional',
    install: {
      win32: 'winget install --id Git.Git -e --source winget',
      linux: 'apt-get install git (Debian/Ubuntu), dnf install git (Fedora), pacman -S git (Arch)',
    },
    why: 'the plugins use git for project history and checkpoints',
    url: { win32: 'https://git-scm.com/install/windows', linux: 'https://git-scm.com/install/linux' },
  },
];

export interface PrereqResult {
  /** Items whose absence must stop the install. Empty by plan (F-9529): nothing blocks the file install. */
  blocking: PrereqItem[];
  notes: string[];
  /** `name` of every item whose probe failed or timed out, in `PREREQS` table order. Callers read this, never the notes. */
  missing: string[];
}

export interface PrereqParams {
  run: CommandRunnerFactory;
  /** Not probed here; M1a checks the manifest's `requires.node`. */
  nodeVersion?: string;
  platform: NodeJS.Platform;
  /** Per-probe bound, default 10 s; a probe that outlives it counts as missing. */
  timeoutMs?: number;
}

const BLOCK_ON_REQUIRED = false;

async function present(item: PrereqItem, p: PrereqParams, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const hang = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const probe = (async () => {
    try {
      return (await p.run(item.name, p.platform)(item.probe, { timeoutMs })).code === 0;
    } catch {
      return false;
    }
  })();
  try {
    return await Promise.race([probe, hang]);
  } finally {
    clearTimeout(timer);
  }
}

function noteFor(item: PrereqItem, platform: NodeJS.Platform): string {
  const key = platform === 'win32' ? 'win32' : 'linux';
  const how = `Install: ${item.install[key]} (${item.url[key]}).`;
  if (item.name === 'claude') {
    return `claude: not found (${item.why}). The plugin files are still written; the manual commands follow. ${how}`;
  }
  return `${item.name}: not found (optional; ${item.why}). ${how}`;
}

export async function checkPrerequisites(p: PrereqParams): Promise<PrereqResult> {
  const timeoutMs = p.timeoutMs ?? 10_000;
  const found = await Promise.all(PREREQS.map((item) => present(item, p, timeoutMs)));
  const missing = PREREQS.filter((_, i) => !found[i]);
  return {
    blocking: BLOCK_ON_REQUIRED ? missing.filter((m) => m.need === 'required') : [],
    notes: missing.map((m) => noteFor(m, p.platform)),
    missing: missing.map((m) => m.name),
  };
}
