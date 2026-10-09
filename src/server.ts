// cyphor-role: API
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { feedbackInputSchema, feedbackOutputSchema, FEEDBACK_TOOL_DESCRIPTION } from './feedback.js';
import type { PhanosService } from './service.js';

export const TOOL_NAMES = ['phanos_login', 'phanos_status', 'phanos_install', 'phanos_update', 'phanos_logout', 'phanos_ui', 'phanos_feedback'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export async function runTool(fn: () => Promise<string>) {
  try {
    return { content: [{ type: 'text' as const, text: await fn() }] };
  } catch (e) {
    return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}

/** `only` limits the registered tools (the `--feedback-only` mode registers `phanos_feedback` alone); absent, all seven. */
export function buildServer(svc: PhanosService, version: string, opts: { only?: readonly ToolName[] } = {}): McpServer {
  const server = new McpServer({ name: 'phanos', version });
  const wanted = (name: ToolName): boolean => opts.only === undefined || opts.only.includes(name);
  /** M7b: shared by phanos_install and phanos_update. */
  const forceArg = z.boolean().optional().describe('replace files you changed by hand');
  if (wanted('phanos_login')) {
    server.registerTool(
      'phanos_login',
      { description: 'Sign in to your PhanOS account from this computer. Shows a code to confirm in the browser; no password is typed here. Every install needs a signed-in account, PhanOS Basic included.', inputSchema: z.object({}) },
      () => runTool(() => svc.login()),
    );
  }
  if (wanted('phanos_status')) {
    server.registerTool(
      'phanos_status',
      { description: 'Show sign-in state, plan, Pro token validity and the installed PhanOS version. Renews the Pro token when it is close to expiry.', inputSchema: z.object({}) },
      () => runTool(() => svc.status()),
    );
  }
  if (wanted('phanos_install')) {
    server.registerTool(
      'phanos_install',
      {
        description: 'Install PhanOS. Verifies the package signature and checksum before writing any file. Installs PhanOS Pro when your plan includes it, otherwise PhanOS Basic. Every install needs a signed-in account (see phanos_login). Pass force to replace files you changed by hand.',
        inputSchema: z.object({ force: forceArg }),
      },
      ({ force }) => runTool(() => svc.install({ force: force ?? false })),
    );
  }
  if (wanted('phanos_update')) {
    server.registerTool(
      'phanos_update',
      { description: 'Update the installed PhanOS edition to the latest signed release.', inputSchema: z.object({ force: forceArg }) },
      ({ force }) => runTool(() => svc.update({ force: force ?? false })),
    );
  }
  if (wanted('phanos_logout')) {
    server.registerTool(
      'phanos_logout',
      {
        description: 'Sign out and remove this computer from your account, freeing a device slot. Enables PhanOS Basic and turns PhanOS Pro off; the Pro files stay on disk.',
        inputSchema: z.object({}),
      },
      () => runTool(() => svc.logout()),
    );
  }
  if (wanted('phanos_ui')) {
    server.registerTool(
      'phanos_ui',
      {
        description:
          'Start the PhanOS desktop UI (a PhanOS Pro feature). On request only, it can also create or remove the one PhanOS shortcut on the desktop: pass shortcut "create" or "remove". Without the argument nothing is written.',
        inputSchema: z.object({ shortcut: z.enum(['create', 'remove']).optional().describe('create or remove the desktop shortcut for the PhanOS UI') }),
      },
      ({ shortcut }) => runTool(() => svc.ui(shortcut ? { shortcut } : {})),
    );
  }
  if (wanted('phanos_feedback')) {
    server.registerTool(
      'phanos_feedback',
      { description: FEEDBACK_TOOL_DESCRIPTION, inputSchema: feedbackInputSchema, outputSchema: feedbackOutputSchema },
      async (input) => {
        const outcome = await svc.feedback(input);
        return { content: [{ type: 'text' as const, text: outcome.message }], structuredContent: outcome, isError: !outcome.ok };
      },
    );
  }
  return server;
}
