import { MCP_ADD_COMMAND, MCP_TAG, registerMcp } from './claude-cli.js';
import { nextSessionLine } from './flip.js';
import { PREREQS } from './prereqs.js';
import { SHORTCUT_QUESTION } from './service.js';
const CLAUDE_DOCS = PREREQS.find((p) => p.name === 'claude')?.url.linux ?? 'https://code.claude.com/docs/en/overview';
/** Every line the terminal installer writes itself; the service's answers and the error messages are printed as they come. */
export const TERMINAL_TEXT = {
    claudeMissing: `Claude Code was not found on this computer, so nothing was installed. Install Claude Code (${CLAUDE_DOCS}), then run this installer again. For reference, these are the commands it runs in Claude Code:`,
    signIn: 'Sign in to connect this computer to your PhanOS account. Open this link, check that the page shows the code below, and choose Connect this device:',
    code: (userCode) => `Code: ${userCode}`,
    waiting: 'Waiting for you to confirm in the browser.',
    loginFailed: 'Nothing was installed. Run the same command again to start over.',
    registered: {
        added: 'Added the PhanOS MCP server to Claude Code, for all your projects.',
        already: 'The PhanOS MCP server is already added to Claude Code.',
        replaced: `Updated the PhanOS MCP server in Claude Code to ${MCP_TAG}.`,
    },
    shortcutQuestion: 'Put a shortcut to the PhanOS UI on your desktop? (y/N) ',
};
// PROVISIONAL: IN-1 fallback sentence (plan WB2.07 step 6)
const CLOSING_LINE = 'Start a new Claude Code session in your project folder, then run /phanos:install.';
const errorMessage = (err) => (err instanceof Error ? err.message : String(err));
/**
 * The install answer is written for Claude inside a session: its shortcut instruction is for the model and its
 * next-session line would repeat the closing line. The terminal asks the shortcut question itself and closes once.
 */
const MODEL_ONLY_LINES = new Set([SHORTCUT_QUESTION, nextSessionLine('pro'), nextSessionLine('basic')]);
const forTerminal = (answer) => answer
    .split('\n')
    .filter((line) => !MODEL_ONLY_LINES.has(line.trimEnd()))
    .join('\n');
/**
 * The foreground terminal install: prerequisites, device login, install, MCP registration,
 * optional desktop shortcut, then the closing line. Returns the process exit code.
 */
export async function runTerminalInstall(deps) {
    // 1. Prerequisites: every note prints; a blocking item or a missing claude stops before any login.
    const pre = await deps.checkPrerequisites();
    const claudeMissing = pre.missing.includes('claude');
    // F-9859 as in the service: the `claude` note promises that the files are still written; this path writes nothing.
    // `notes` and `missing` come from the same list in the same order.
    for (const [i, note] of pre.notes.entries()) {
        if (!(claudeMissing && pre.missing[i] === 'claude'))
            deps.print(note);
    }
    if (pre.blocking.length > 0) {
        for (const reason of pre.blocking)
            deps.print(reason);
        return 1;
    }
    if (claudeMissing) {
        deps.print(TERMINAL_TEXT.claudeMissing);
        deps.print(MCP_ADD_COMMAND);
        for (const command of deps.manualCommands())
            deps.print(command);
        return 1;
    }
    // 2. Device flow in the foreground. The login step ends only when wait() resolves.
    try {
        const login = await deps.login();
        deps.print(TERMINAL_TEXT.signIn);
        deps.print(login.verificationUrl);
        deps.print(TERMINAL_TEXT.code(login.userCode));
        deps.print(TERMINAL_TEXT.waiting);
        await login.wait();
    }
    catch (err) {
        deps.print(errorMessage(err));
        deps.print(TERMINAL_TEXT.loginFailed);
        return 1;
    }
    // 3. Install runs only after the login resolved.
    try {
        deps.print(forTerminal(await deps.install()));
    }
    catch (err) {
        deps.print(errorMessage(err));
        return 1;
    }
    // 4. Register the MCP server (get, then remove and add as needed). Any failure stops with exit 1.
    try {
        deps.print(TERMINAL_TEXT.registered[await registerMcp({ scope: 'user', run: deps.run })]);
    }
    catch (err) {
        deps.print(errorMessage(err));
        return 1;
    }
    // 5. Desktop shortcut. noShortcut wins when both flags are set; a non-TTY never asks.
    let wantShortcut = false;
    if (deps.flags.noShortcut) {
        wantShortcut = false; // --no-shortcut wins over --yes-shortcut when both are given
    }
    else if (deps.flags.yesShortcut) {
        wantShortcut = true;
    }
    else if (deps.isTTY) {
        wantShortcut = await deps.ask(TERMINAL_TEXT.shortcutQuestion); // default answer: no
    }
    if (wantShortcut) {
        try {
            deps.print(await deps.createShortcut());
        }
        catch (err) {
            deps.print(errorMessage(err)); // a shortcut failure does not undo the install
        }
    }
    // 6. The closing line is printed last.
    deps.print(CLOSING_LINE);
    return 0;
}
