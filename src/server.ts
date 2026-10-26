// cyphor-role: API
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { contentOutcomeText } from './content.js';
import { feedbackInputSchema, feedbackOutputSchema, FEEDBACK_TOOL_DESCRIPTION } from './feedback.js';
import type { PhanosService } from './service.js';

export const TOOL_NAMES = ['phanos_login', 'phanos_status', 'phanos_install', 'phanos_update', 'phanos_logout', 'phanos_ui', 'phanos_feedback', 'phanos_content'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export async function runTool(fn: () => Promise<string>) {
  try {
    return { content: [{ type: 'text' as const, text: await fn() }] };
  } catch (e) {
    return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}

/** C-9 (03_c9-wire-client.md section 1): the input and output of `phanos_content`. */
const contentInputSchema = z.object({
  kind: z.enum(['skill', 'workflow', 'agent', 'corpus', 'template', 'manifest']).describe('what to load: a skill, workflow, agent, corpus or template text, or the signed content manifest'),
  name: z.string().optional().describe('the text name; required unless kind is manifest, ignored for manifest'),
  pluginVersion: z.string().optional().describe('the PhanOS Pro plugin version; default: the installed Pro plugin version'),
});
const contentOutputSchema = z.object({
  ok: z.boolean(),
  version: z.string().optional(),
  contentVersion: z.string().optional(),
  sha256: z.string().optional(),
  body: z.string().optional(),
  result: z.string().optional(),
});
const CONTENT_TOOL_DESCRIPTION =
  'Load a PhanOS Pro text (skill, workflow, agent, corpus, template) or the signed content manifest from the PhanOS server, verified against the signed manifest. Used by PhanOS Pro\'s loaders; answers refused or unavailable when it cannot load.';

/** `only` limits the registered tools (the `--feedback-only` mode registers `phanos_feedback` alone); absent, all eight. */
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
    /** WE-5.01 ruling 12: per-file conflict answers, unattended and overwrite_all; overwrite_all with unattended is refused here. */
    const updateInputSchema = z
      .object({
        force: forceArg,
        decisions: z.record(z.string(), z.enum(['keep', 'overwrite'])).optional().describe('per-file answer to a conflict, keyed by file path: keep or overwrite'),
        unattended: z.boolean().optional().describe('answer every remaining conflict without asking'),
        overwrite_all: z.boolean().optional().describe('overwrite every file you changed by hand'),
        corpus: z.literal('refresh').optional().describe('refresh the served PhanOS content: fetch the content manifest again and clear the content cache'),
      })
      .refine((a) => !(a.overwrite_all === true && a.unattended === true), {
        message: 'overwrite_all and unattended cannot be used together',
        path: ['overwrite_all'],
      })
      .refine((a) => a.corpus === undefined || (a.force === undefined && a.decisions === undefined && a.unattended === undefined && a.overwrite_all === undefined), {
        message: 'corpus refresh runs alone',
        path: ['corpus'],
      });
    server.registerTool(
      'phanos_update',
      {
        description:
          'Update the installed PhanOS edition to the latest signed release. For files you changed by hand, pass decisions (keep or overwrite, per file path), unattended to answer the rest without asking, or overwrite_all to replace them; overwrite_all and unattended cannot be combined. Pass corpus "refresh" alone to fetch the signed PhanOS content manifest again and clear the content cache.',
        inputSchema: updateInputSchema,
      },
      ({ force, decisions, unattended, overwrite_all, corpus }) =>
        runTool(() =>
          corpus !== undefined
            ? svc.update({ corpus })
            : svc.update({
                force: force ?? false,
                ...(decisions !== undefined ? { decisions } : {}),
                ...(unattended !== undefined ? { unattended } : {}),
                ...(overwrite_all !== undefined ? { overwrite_all } : {}),
              }),
        ),
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
  if (wanted('phanos_content')) {
    server.registerTool(
      'phanos_content',
      { description: CONTENT_TOOL_DESCRIPTION, inputSchema: contentInputSchema, outputSchema: contentOutputSchema },
      async ({ kind, name, pluginVersion }) => {
        const outcome = await svc.content({ kind, ...(name !== undefined ? { name } : {}), ...(pluginVersion !== undefined ? { pluginVersion } : {}) });
        // F-17068: the raw bytes (a Uint8Array) stay in-process; they are not part of the MCP payload.
        const { bytes: _bytes, ...visible } = outcome;
        return { content: [{ type: 'text' as const, text: contentOutcomeText(outcome) }], structuredContent: visible, isError: !outcome.ok };
      },
    );
  }
  return server;
}
