# PhanOS installer (closed beta)

Sign in to your PhanOS account ([phanos.eu](https://phanos.eu)), then install and update PhanOS, from inside
Claude Code.

> **Closed beta.** PhanOS is in a closed beta. This installer only installs PhanOS for accounts that have beta
> access; without it, the installer is of no use to you. To take part, ask for an invite at
> **[phanos.eu/beta](https://phanos.eu/beta)**.

## Install

You need Node.js 22.12 or newer and Git.

    claude mcp add phanos -- npx -y github:Aloim/PhanOS-ClosedBetaMCP

For a careful install, pin the version instead:

    claude mcp add phanos -- npx -y github:Aloim/PhanOS-ClosedBetaMCP#v0.2.0

Every install signs in with your PhanOS account. Then ask Claude to run:
- `phanos_login` — confirm the code in your browser
- `phanos_install` — installs PhanOS Pro when your plan includes it, otherwise PhanOS Basic (`force` replaces files you changed by hand)
- `phanos_status` — sign-in state, plan, token validity and the installed version
- `phanos_update` (`force`) — the latest signed release of the installed edition
- `phanos_logout` — signs out and frees this computer's device slot
- `phanos_ui` (`shortcut: create|remove`) — starts the PhanOS desktop UI; the shortcut is written only on request
- `phanos_feedback` - sends a feedback or bug report to the PhanOS team, linked to your account (see "Sending feedback")

An install, update or edition change ends with the line "Start a new Claude Code session to use
PhanOS <Pro|Basic>." Start that session to pick the change up.

Every package is checked against PhanOS's offline signing key before any file is written.
Files: the PhanOS home `~/.phanos/` (override with `PHANOS_HOME`). The only change outside it is
`env.PHANOS_CORPUS_URL` in `~/.claude/settings.json` (backup: `settings.json.phanos-backup`).
Your Claude credentials are never read.

The sign-in state lives in `state.json` inside the PhanOS home. Its `mcp` key records how this server
was started (entry path, Node path, version and time), so the PhanOS UI can launch the same server; it
is written only when one of those changed and is kept when you sign out.

## Sending feedback

Ask Claude to send a report with `phanos_feedback`. It sends exactly the fields it is given: the
category (`bug` or `feedback`), a title, the prose fields (`happened`, and optionally `expected` and
`steps`), optional versions, optional OS details and optional text files. It reads nothing from disk
itself, so a file is included only when its text is passed in. The report is linked to the PhanOS
account you are signed in with (run `phanos_login` first), and it goes to the PhanOS site with
`POST /api/feedback`. A successful call answers with a report id.

Limits: at most 12 files, 256 KiB each and 1 MiB together; file names are plain names without a path.
Any signed-in account may send, PhanOS Basic included. The site also limits how often reports can be sent.

`--feedback-only` is an optional start flag used by the PhanOS UI. In this mode the server serves the
`phanos_feedback` tool alone, runs no start check and writes nothing; it exits when its input closes.

## Licence and source

`@phanos/mcp` is licensed under the GNU Affero General Public License, version 3 only
(`AGPL-3.0-only`); the full text ships in `LICENSE`. The TypeScript source is in `src/` of this
repository; `dist/` holds the compiled JavaScript that `npx` runs.
