// cyphor-role: IO
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountRead } from './api.js';
import {
  addMarketplace,
  disablePlugin,
  enablePlugin,
  installPlugin,
  listPlugins,
  manualCommand,
  manualInstallCommands,
  type ClaudeRunner,
  type PluginState,
} from './claude-cli.js';
import { PLUGIN_IDS, type LocalEdition, type Paths } from './config.js';

/**
 * The edition flip (C1 §4). `decideFlip` is pure: it turns the account answer, the `claude plugin list --json`
 * listing and the on-disk trees into an ordered plan. `executeFlip` runs that plan and judges every install,
 * enable and disable from a re-read listing, never from the CLI's output (§4 rule 5). Every `claude plugin`
 * argument is a full id (rule 1), the target is enabled before the other edition is disabled (rule 3), the answer
 * ends with the next-session line and never mentions `/reload-plugins` (rule 4), and nothing here downloads or
 * deletes (rule 6).
 */

export type FlipTrigger = 'install' | 'start' | 'status' | 'update' | 'logout';
export type FlipAction =
  | { kind: 'register'; edition: LocalEdition }
  | { kind: 'renew-token' }
  | { kind: 'enable'; edition: LocalEdition }
  | { kind: 'disable'; edition: LocalEdition };
export type Listing = Record<string, PluginState>;

export interface FlipPlan {
  trigger: FlipTrigger;
  /** The edition the answer selects; null when nothing was decided (unknown answer, unreadable listing). */
  target: LocalEdition | null;
  /** Ordered: the target is installed or enabled before the other edition is disabled. */
  actions: FlipAction[];
  /** Report lines that belong to every answer of this plan (a no-op reason, a project-scope notice). */
  lines: string[];
  /** The success sentence, used once every action is confirmed; empty when there are no actions. */
  summary: string;
  /** The edition named in the next-session line when the actions apply; null for a plan without actions. */
  nextSession: LocalEdition | null;
  /** The listing already shows the target enabled and the other edition off or absent, so no action is needed. */
  holds: boolean;
}

export interface FlipResult {
  ok: boolean;
  /** At least one install, enable or disable was confirmed by the listing. */
  changed: boolean;
  /** The text for the user; ends with the next-session line when a flip applied in full. */
  answer: string;
  lines: string[];
  failed?: FlipAction;
  /** The last listing read, or null when none was read or it was unparsable. */
  listing: Listing | null;
  /**
   * After the plan ran, the listing read last confirms the target state of the trigger (the target edition enabled,
   * the other disabled or absent), whether by actions now (`changed`) or because it already held. False when nothing
   * could be confirmed: no or unparsable listing, target edition not on disk or not registered, an unknown account
   * answer, a failed action. `ok` alone cannot say this (a no-action plan is `ok` either way); callers read this
   * field and never the prose of `answer` or `lines`.
   */
  settled: boolean;
}

export interface FlipContext {
  paths: Paths;
  /** Renews and stores the entitlement token (row 4); a rejection stops the flip before any enable. */
  getToken?: () => Promise<unknown>;
}

const LABEL: Record<LocalEdition, string> = { pro: 'Pro', basic: 'Basic' };
const ENTITLED = new Set(['active', 'trial', 'grace']);
const other = (e: LocalEdition): LocalEdition => (e === 'pro' ? 'basic' : 'pro');
const name = (e: LocalEdition): string => `PhanOS ${LABEL[e]}`;
export const nextSessionLine = (e: LocalEdition): string => `Start a new Claude Code session to use ${name(e)}.`;

/**
 * Is the id on by its USER-scope setting? A project that enables the plugin overrides a user-scope disable: the
 * listing then still says `enabled` and carries the "Disabled in ... but still loads" note (M3a-0). That is a
 * finished user-scope disable the MCP cannot improve, so it reads as off here; the project notice covers the rest.
 */
function userOn(s: PluginState | undefined): boolean {
  if (!s || !s.enabled) return false;
  return !(s.projectEnabled && (s.notes ?? []).some((n) => /but still loads/i.test(n)));
}

/** A tree is on disk when its `plugin.json` exists. */
export async function treesOnDisk(paths: Paths): Promise<Record<LocalEdition, boolean>> {
  const has = async (e: LocalEdition): Promise<boolean> => {
    try {
      return (await stat(join(paths.marketplace[e].pluginDir, '.claude-plugin', 'plugin.json'))).isFile();
    } catch {
      return false;
    }
  };
  return { pro: await has('pro'), basic: await has('basic') };
}

export interface DecideInput {
  trigger: FlipTrigger;
  /** The account answer; `logout` ignores it. */
  answer: AccountRead | null;
  /** `claude plugin list --json`, or null when it could not be read. */
  listing: Listing | null;
  /** The tree's `plugin.json` exists. "On disk" additionally needs the listing to show the id installed. */
  onDisk: Record<LocalEdition, boolean>;
}

const projectNotice = (e: LocalEdition): string =>
  `${name(e)} is also enabled at project scope in the project this session runs in, and the MCP never edits project settings. ` +
  `To turn it off there, run this inside that project: ${manualCommand(['plugin', 'disable', PLUGIN_IDS[e], '--scope', 'project'])}`;

export function decideFlip(input: DecideInput): FlipPlan {
  const { trigger, answer, listing, onDisk } = input;
  const make = (target: LocalEdition | null, actions: FlipAction[], lines: string[], summary = '', holds = false): FlipPlan => ({
    trigger,
    target,
    actions,
    lines,
    summary,
    nextSession: actions.length > 0 ? target : null,
    holds,
  });

  if (listing === null) {
    return make(null, [], ['The Claude Code plugin list could not be read, so no edition was changed. Check that the `claude` command works, then try again.']);
  }
  const on = { pro: userOn(listing[PLUGIN_IDS.pro]), basic: userOn(listing[PLUGIN_IDS.basic]) };
  const present = (e: LocalEdition): boolean => onDisk[e] && listing[PLUGIN_IDS[e]] !== undefined;

  // §4 "any / unknown": do nothing; report a both-enabled state, never repair it.
  if (trigger !== 'logout' && (answer === null || answer.kind === 'unknown')) {
    const message = answer?.kind === 'unknown' ? answer.message : 'The account answer could not be read.';
    const reason = answer?.kind === 'unknown' ? answer.reason : 'error';
    const lines = [`${message} No edition was changed.`];
    if (reason === 'unauthenticated' && !message.includes('phanos_login')) lines.push('Run phanos_login to sign in again.');
    if (on.pro && on.basic) {
      lines.push(
        'Both PhanOS editions are enabled, which is a fault: only one of them loads. ' +
          'It is repaired the next time the account state can be read (run phanos_status), or disable one now with ' +
          `${manualCommand(['plugin', 'disable', PLUGIN_IDS.basic])} or ${manualCommand(['plugin', 'disable', PLUGIN_IDS.pro])}.`,
      );
    }
    return make(null, [], lines);
  }

  const target: LocalEdition = trigger === 'logout' ? 'basic' : answer !== null && answer.kind === 'known' && ENTITLED.has(answer.state) ? 'pro' : 'basic';
  const o = other(target);
  const notices = listing[PLUGIN_IDS[o]]?.projectEnabled ? [projectNotice(o)] : [];

  if (trigger === 'install') {
    const actions: FlipAction[] = [];
    const sim = { pro: { installed: listing[PLUGIN_IDS.pro] !== undefined, on: on.pro }, basic: { installed: listing[PLUGIN_IDS.basic] !== undefined, on: on.basic } };
    // Target first (rule 1): Pro is installed before Basic, so a failed disable still leaves Pro first in enabledPlugins.
    for (const e of target === 'pro' ? (['pro', 'basic'] as const) : (['basic'] as const)) {
      actions.push({ kind: 'register', edition: e });
      if (!sim[e].installed) sim[e] = { installed: true, on: true };
    }
    if (!sim[target].on) actions.push({ kind: 'enable', edition: target });
    if (sim[o].on) actions.push({ kind: 'disable', edition: o });
    const summary = target === 'pro' ? `Installed ${name('pro')} and ${name('basic')}; ${name('pro')} is the enabled edition.` : `Installed ${name('basic')}; it is the enabled edition.`;
    return make(target, actions, notices, summary);
  }

  const needInstall = (): FlipPlan => make(target, [], [`${name(target)} is not on disk, so nothing was flipped. Run phanos_install.`, ...notices]);

  if (on[target] && !on[o]) return make(target, [], [`${name(target)} is the enabled edition; nothing to change.`, ...notices], '', true);
  if (!present(target)) return needInstall();
  if (on[target] && on[o]) {
    return make(target, [{ kind: 'disable', edition: o }], notices, `Both editions were enabled; kept ${name(target)} and disabled ${name(o)}.`);
  }
  const actions: FlipAction[] = [];
  if (target === 'pro') actions.push({ kind: 'renew-token' });
  actions.push({ kind: 'enable', edition: target });
  if (on[o]) actions.push({ kind: 'disable', edition: o });
  return make(target, actions, notices, on[o] ? `Switched from ${name(o)} to ${name(target)}.` : `Enabled ${name(target)}.`);
}

export interface RegistrationResult {
  ok: boolean;
  listing: Listing | null;
  /** The edition whose marketplace add or install the listing did not confirm. */
  failed?: LocalEdition;
  /** The commands to run by hand when `ok` is false. */
  manual?: string[];
}

/**
 * The install rows: for each edition, `marketplace add <home>/marketplaces/phanos-<e>` then `install` of the full
 * id, then a re-read. Success is the listing showing the id installed, never the CLI's output.
 */
export async function executeInstallRegistration(editions: readonly LocalEdition[], run: ClaudeRunner, paths: Paths): Promise<RegistrationResult> {
  let listing: Listing | null = null;
  for (const e of editions) {
    const dir = paths.marketplace[e].dir;
    const manual = manualInstallCommands(dir, PLUGIN_IDS[e]);
    const added = await addMarketplace(run, dir);
    if (!added.ok) return { ok: false, listing, failed: e, manual };
    await installPlugin(run, PLUGIN_IDS[e]);
    listing = await listPlugins(run);
    if (listing === null || listing[PLUGIN_IDS[e]] === undefined) return { ok: false, listing, failed: e, manual };
  }
  return { ok: true, listing };
}

interface StepOutcome {
  ok: boolean;
  listing: Listing | null;
  lines?: string[];
}

async function step(action: FlipAction, plan: FlipPlan, run: ClaudeRunner, ctx: FlipContext, last: Listing | null): Promise<StepOutcome> {
  const target = plan.target;
  switch (action.kind) {
    case 'renew-token': {
      try {
        if (!ctx.getToken) throw new Error('no token renewal is available');
        await ctx.getToken();
        return { ok: true, listing: last };
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        const message = e instanceof Error ? e.message : String(e);
        const why = code === 'device_limit' ? `your device limit is reached. ${message}` : `the entitlement token could not be renewed (${message}).`;
        const stays = target === null ? '' : ` ${name(other(target))} stays enabled.`;
        return { ok: false, listing: last, lines: [`${name(target ?? 'pro')} was not enabled: ${why}${stays}`] };
      }
    }
    case 'register': {
      const r = await executeInstallRegistration([action.edition], run, ctx.paths);
      if (r.ok) return { ok: true, listing: r.listing };
      return {
        ok: false,
        listing: r.listing,
        lines: [`Installing ${name(action.edition)} did not complete: the Claude Code plugin list does not show it. Nothing further was changed. Run these commands yourself:`, ...(r.manual ?? []).map((c) => `  ${c}`)],
      };
    }
    case 'enable': {
      const id = PLUGIN_IDS[action.edition];
      await enablePlugin(run, id, { scope: 'user' });
      const listing = await listPlugins(run);
      if (listing !== null && userOn(listing[id])) return { ok: true, listing };
      return { ok: false, listing, lines: [`${name(action.edition)} could not be enabled: the plugin list does not show it enabled. Nothing was disabled, so ${name(other(action.edition))} keeps its state.`] };
    }
    case 'disable': {
      const id = PLUGIN_IDS[action.edition];
      await disablePlugin(run, id, { scope: 'user' });
      const listing = await listPlugins(run);
      if (listing !== null && listing[id] !== undefined && !userOn(listing[id])) return { ok: true, listing };
      const keeps = target !== null && listing !== null && userOn(listing[PLUGIN_IDS[target]]) ? `${name(target)} is enabled, but ` : '';
      return {
        ok: false,
        listing,
        lines: [
          `${keeps}${name(action.edition)} could not be disabled, so both editions are enabled. The next start of the MCP repairs this, or run ${manualCommand(['plugin', 'disable', id])} yourself.`,
        ],
      };
    }
  }
}

/** Runs the plan's actions in order, re-reading the listing after every install, enable and disable. */
export async function executeFlip(plan: FlipPlan, run: ClaudeRunner, ctx: FlipContext): Promise<FlipResult> {
  let listing: Listing | null = null;
  let changed = false;
  for (const action of plan.actions) {
    const out = await step(action, plan, run, ctx, listing);
    listing = out.listing;
    if (!out.ok) {
      const lines = [...(out.lines ?? []), ...plan.lines];
      return { ok: false, changed, answer: lines.join('\n'), lines, failed: action, listing, settled: false };
    }
    if (action.kind !== 'renew-token') changed = true;
  }
  const lines = plan.actions.length === 0 ? [...plan.lines] : [plan.summary, ...plan.lines];
  if (plan.actions.length > 0 && plan.nextSession !== null) lines.push(nextSessionLine(plan.nextSession));
  // With actions, the listing read after the last one must show the target on and the other edition off or absent.
  const settled =
    plan.actions.length === 0
      ? plan.holds
      : plan.target !== null && listing !== null && userOn(listing[PLUGIN_IDS[plan.target]]) && !userOn(listing[PLUGIN_IDS[other(plan.target)]]);
  return { ok: true, changed, answer: lines.join('\n'), lines, listing, settled };
}

export interface ReconcileInput {
  trigger: FlipTrigger;
  answer: AccountRead | null;
  run: ClaudeRunner;
  paths: Paths;
  getToken?: () => Promise<unknown>;
  /** Defaults to `treesOnDisk(paths)`. */
  onDisk?: Record<LocalEdition, boolean>;
}

/** Reads the listing, decides, executes: the one call a trigger (install, start, status, update, logout) makes. */
export async function reconcileEditions(input: ReconcileInput): Promise<FlipResult> {
  const listing = await listPlugins(input.run);
  const onDisk = input.onDisk ?? (await treesOnDisk(input.paths));
  const plan = decideFlip({ trigger: input.trigger, answer: input.answer, listing, onDisk });
  return executeFlip(plan, input.run, { paths: input.paths, getToken: input.getToken });
}
