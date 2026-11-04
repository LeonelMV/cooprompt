# Development

Windows support is in progress. The application can resolve Windows engine executables and use the inherited Windows environment, but packaging, updates, shell-based connector launches and the test suite still require platform work. Do not treat a Windows build as supported until those paths have been verified.

On Windows, the inherited `Path` is normalized to `PATH` before starting agents; bundled tool directories use the Windows path separator. The public tunnel is disabled until its process ownership and lifecycle can be verified on Windows. A Windows host can offer a macOS installer only from an explicitly configured macOS release folder; it does not create one from its own executable.

Setting up the repository, running the app and the server, testing, translating, and running isolated instances.

## Prerequisites

- macOS on Apple silicon for the supported release workflow, or Windows x64 for experimental development and packaging.
- Node.js 24: the exact version is in [`.nvmrc`](../.nvmrc) (`nvm use`). The server relies on the built-in `node:sqlite` module.
- Optional: `cloudflared` (`brew install cloudflared`) to test tunnels.

```sh
nvm use
npm install
```

`npm install` installs every workspace, including the Electron package and the Claude Code and Codex engine binaries for your platform. If `npm run dev` reports that Electron is not installed, run `npx install-electron --no` once to download the Electron executable. The Cursor engine uses the separately installed Cursor CLI, signed in with `cursor-agent login`; follow the [Cursor CLI installation guide](https://cursor.com/docs/cli/installation) for your operating system.

## Workspaces

| Package | Path | Notes |
| --- | --- | --- |
| `@cooprompt/protocol` | [`packages/protocol`](../packages/protocol) | Types shared by the server and the app. Exports its TypeScript source directly. |
| `@cooprompt/server` | [`apps/server`](../apps/server) | Team server. Runs from TypeScript source with `tsx`; the desktop app imports it to host the server. |
| `@cooprompt/desktop` | [`apps/desktop`](../apps/desktop) | Electron app, bundled with `electron-vite`. |

Neither the protocol nor the server has a build step. All packages are ES modules and import local TypeScript files with explicit `.ts`/`.tsx` extensions. The [Codebase map](codebase-map.md) lists the file that owns each responsibility, and each package has an `AGENTS.md` with its own rules ([protocol](../packages/protocol/AGENTS.md), [server](../apps/server/AGENTS.md), [desktop](../apps/desktop/AGENTS.md)).

## Scripts

Run from the repository root:

| Script | What it does |
| --- | --- |
| `npm run dev` | Starts the desktop app in development mode (`electron-vite dev`). |
| `npm run server` | Starts a standalone team server (loads `apps/server/.env` if present). |
| `npm run server:dev` | Same, restarting on code changes. |
| `npm run share` | Opens a Cloudflare quick tunnel to a local standalone server. |
| `npm run typecheck` | Type-checks every workspace (`tsc --noEmit`). |
| `npm test` | Runs every workspace's tests (Vitest). |
| `npm run dist` | Builds the macOS app, see [Distribution](distribution.md). |
| `npm run dist:win -w @cooprompt/desktop` | Attempts to build the experimental unsigned Windows x64 installer; application-control policies may block it. |

Target one workspace with `-w`, for example `npm run typecheck -w @cooprompt/server` or `npm test -w @cooprompt/desktop`. Arguments after `--` reach Vitest: `npm test -w @cooprompt/desktop -- test/i18n.test.ts`.

## Running the app

`npm run dev` opens CooPrompt with the renderer served by Vite, which reloads UI changes in place. Restart the command after changing the main process or the preload script.

- Development builds run under the name "CooPrompt Dev" and keep their own data folder (`~/Library/Application Support/CooPrompt Dev` on macOS or `%APPDATA%\CooPrompt Dev` on Windows) and default folders (`~/CooPrompt-Dev/Compartidos` and `~/CooPrompt-Dev/Privados`). They do not share settings, a device id or synced folders with an installed CooPrompt. On macOS they also use their own Keychain item.
- The main process logs to the terminal and to `logs/main.log` in the app's data folder.
- A development build can host the team server, but it can't zip itself as an installer: `/download/CooPrompt.zip` returns 404 unless **Builds to offer** in Settings → Team server points to a folder with packaged builds.
- To try [automations](automations.md) without waiting, run a standalone server with `COOPROMPT_AUTOMATION_MIN_INTERVAL=1`, which allows runs a minute apart, and sign a `COOPROMPT_PROFILE` instance in to it.
- Automatic updates are available only on macOS and are off in development builds and `COOPROMPT_PROFILE` instances. On macOS, `COOPROMPT_UPDATES=1` turns them on, `COOPROMPT_UPDATES=0` turns them off, and `COOPROMPT_UPDATES=auto` also downloads and installs them without asking (for end-to-end tests). An update replaces the running app bundle, so test it with packaged builds (see [Distribution](distribution.md#how-updates-reach-teammates)).
- CooPrompt finds the Cursor CLI on `PATH` or in `~/.local/bin` (`cursor-agent.exe` is also checked on Windows). `COOPROMPT_CURSOR_AGENT=<path>` points it at another one, such as the stand-in the tests use ([`test/fake-cursor-agent.mjs`](../apps/desktop/test/fake-cursor-agent.mjs), started through a small shell script), to try Cursor turns without a Cursor account.

For a server outside the app, run `npm run server:dev` and sign in to `http://127.0.0.1:4317`. Configuration is in [Team server](server.md).

## Isolated instances (`COOPROMPT_PROFILE`)

`COOPROMPT_PROFILE=<name>` runs a fully separate instance ([`src/main/paths.ts`](../apps/desktop/src/main/paths.ts)):

- its own data folder (`~/Library/Application Support/CooPrompt-<name>` on macOS or `%APPDATA%\CooPrompt-<name>` on Windows): settings, secrets, device id, sync state, embedded server data;
- its own default folders (`~/CooPrompt-<name>/Compartidos` and `~/CooPrompt-<name>/Privados`);
- no single-instance lock, so it runs alongside other instances; the window title shows the profile.

To try multiplayer on one computer, start a server, then run two profiles in separate terminals and sign in with two accounts. On macOS:

```sh
COOPROMPT_PROFILE=ana npm run dev
COOPROMPT_PROFILE=leo npm run dev
```

In Windows PowerShell, set `$env:COOPROMPT_PROFILE = 'ana'` in one terminal and `$env:COOPROMPT_PROFILE = 'leo'` in another, then run `npm run dev` in each.

The same variable works with a packaged app: `COOPROMPT_PROFILE=ana /Applications/CooPrompt.app/Contents/MacOS/CooPrompt`. Profile names keep only letters, digits, `-` and `_`. A profile is also the way to keep a development instance's data apart from an installed CooPrompt.

## Tests

Tests live in each app's `test/` folder and run with Vitest:

Both workspaces disable persistent Vitest result and transformed-module caches so generated test files do not retain copies of source code or absolute local paths.

The server installer test needs `bash` to check the generated macOS installer script. On Windows, Git for Windows can provide it by adding its `bin` folder to `PATH` for the test run. The desktop suite also contains macOS-specific updater and tunnel checks and Unix-style fake executables; it is not yet fully portable to Windows.

| Suite | What it covers |
| --- | --- |
| [`apps/server/test/collaboration.test.ts`](../apps/server/test/collaboration.test.ts) | Accounts, chats, invitations, organizations, turn queueing and streaming, the engines a turn may name, permission forwarding, cancelling and interrupting, the workspace file API and the access code, against a real server with real HTTP and WebSocket clients. |
| [`apps/server/test/multitask.test.ts`](../apps/server/test/multitask.test.ts) | Multitask scheduling: starting parallel turns up to the limit and queueing the rest, letting no message skip the line, interrupting the turn a message names, apps that predate multitask (one turn at a time on their computers, interrupts of the sender's latest turn, drafts of every running turn) and a server with multitask off. |
| [`apps/server/test/automations.test.ts`](../apps/server/test/automations.test.ts) | Schedules (presets, intervals, cron, time zones and daylight saving, the minimum interval) and automations on a real server with a test clock: runs as the owner's turns on the owner's chosen computer only, labeled, with their history; who sees and changes them; validation; missed runs and the single catch-up; no overlap; time limits; **Run now**; pausing when the owner leaves; clients without the automation feature; a server restart. |
| [`apps/server/test/team-messages.test.ts`](../apps/server/test/team-messages.test.ts) | Team-only messages against a real server: never a turn (nor publishable by an executor), their content only for apps that announce `team-messages` and requests with `include=team`, stand-ins for clients without the feature, `team.message` to the other members' apps, members only with their own uploads, and sharing with the agents (its author only, without a turn, for every app). |
| [`apps/server/test/attachments.test.ts`](../apps/server/test/attachments.test.ts) | Attachments against a real server: the limits in `/api/health`, uploads and downloads for members only (company chats once joined), the size limits, cleaned names, types from the bytes and the headers that keep files from being active documents, messages with files and their text for older apps, what executors attach, and deletion with the chat. |
| [`apps/server/test/google-auth.test.ts`](../apps/server/test/google-auth.test.ts) | Google sign-in against a stand-in Google: creating accounts, linking a password account (its password removed and its sessions and connections closed), refusing accounts Google can't vouch for and unverified emails, allowed domains (Workspace `hd` only), ID token checks (audience, issuer, expiry, signature), PKCE, single-use codes, the loopback redirect, the client secret, and Google accounts only. |
| [`apps/server/test/installer.test.ts`](../apps/server/test/installer.test.ts) | The installer script (checked with `bash -n`, including tunnel addresses), the zip download, the `app` announcement (checksum and size of the exact bytes served, recomputed when the zip changes) and the build named in `latest-mac.json`. |
| [`apps/desktop/test/updater.test.ts`](../apps/desktop/test/updater.test.ts) | Version comparison, bundle and signature verification, and full updates from an in-process server: offering, downloading, rejecting a changed zip, installing, confirming, rolling back and relocating to `~/Applications`. |
| [`apps/desktop/test/update-helper.test.ts`](../apps/desktop/test/update-helper.test.ts) | The update helper on its own: swapping, the `~/Applications` fallbacks, giving up, rollbacks, and leaving everything alone when the app doesn't quit. |
| [`apps/desktop/test/google-sign-in.test.ts`](../apps/desktop/test/google-sign-in.test.ts) | The app's Google sign-in through the browser and the loopback, against the stand-in Google and a real server: PKCE and a working session, landing in the password account with the same email, ignoring a callback forged with another `state`, a cancelled consent, a cancelled wait, a rejected account, and Spanish templates for the server's Google messages. |
| [`apps/desktop/test/connector-sources.test.ts`](../apps/desktop/test/connector-sources.test.ts) | Reading Claude Code, Codex, Cursor and Claude Desktop definitions from a fake home folder, and what each engine receives. |
| [`apps/desktop/test/connector-oauth.test.ts`](../apps/desktop/test/connector-oauth.test.ts) | Connecting a remote connector with OAuth against a fake authorization server: dynamic registration, taking only the callback that brings back the attempt's `state` (a forged one gets 400) with a new `state` each attempt, a pre-registered client on its `localhost` callback without registering, and a sign-in cancelled in the browser, reported in the app language. |
| [`apps/desktop/test/codex-config.test.ts`](../apps/desktop/test/codex-config.test.ts) | The MCP configuration Codex receives: startup grace, tool approvals outside Plan mode, and Plan mode staying read-only. |
| [`apps/desktop/test/claude-sign-in.test.ts`](../apps/desktop/test/claude-sign-in.test.ts) | The Claude Code sign-in through a fake `claude`: telling a Claude subscription and its plan from an Anthropic Console account or no sign-in, signing in with Claude Code's own browser flow, and keeping the shell's model credentials out. |
| [`apps/desktop/test/multitask.test.ts`](../apps/desktop/test/multitask.test.ts) | Parallel turns of one person through the runner, with stand-in `codex`, `claude` and `cursor-agent` binaries against a real server: separate sessions (a new Codex thread, a Claude fork at the end of the last turn), what each session is told and caught up on afterwards, exactly once, interrupting one of two running turns, a server without multitask, and Cursor turns from the runner to the transcript. |
| [`apps/desktop/test/automations.test.ts`](../apps/desktop/test/automations.test.ts) | Automation runs through the runner, scheduled by a real server with a test clock, with the stand-in engines of [`fake-engines.ts`](../apps/desktop/test/fake-engines.ts): what the agent is told, continuing the chat's session or starting a new one, declining approvals and questions (and keeping read-only runs read-only), and the Spanish templates of the server's automation messages. |
| [`apps/desktop/test/cursor-engine.test.ts`](../apps/desktop/test/cursor-engine.test.ts) | Cursor turns through a fake `cursor-agent` that speaks ACP ([`fake-cursor-agent.mjs`](../apps/desktop/test/fake-cursor-agent.mjs)): streamed text, reasoning and tools as items, connectors handed over in memory, approvals without Cursor's "Allow always", Plan mode staying read-only, questions, attached images, the CLI's failure replies, cancelling (also before the prompt goes out) and ending the CLIs when CooPrompt quits, resuming (and starting over when it can't), the sign-in message, model and effort, slash commands; the account's models, sign-in and plan, and finding the CLI. |
| [`apps/desktop/test/team-messages.test.ts`](../apps/desktop/test/team-messages.test.ts) | Team-only messages and the agents, with stand-in engines against a real server: nothing any engine process receives (arguments, stdin, ACP traffic) mentions them, through catch-ups for Codex, Claude and Cursor, a forked Claude session, an automation run, the connectors handed over and file copies; a shared one reaching the next turn once; sending through their own endpoint; a server that predates them (refused, or failing on the missing endpoint, never sent as a message for the agent); the composer's mode; Spanish messages. |
| [`apps/desktop/test/attachments.test.ts`](../apps/desktop/test/attachments.test.ts) | Attachments on each computer through a real server: sending from one computer and copying for another's agent, copies kept out of the synced workspace and of symbolically linked folders, `cooprompt-media:` responses (media only, ranges, members only), what may open in the computer's apps, sharing agent media once, the limits, purging a chat, and a server that predates attachments. |
| [`apps/desktop/test/engine-media.test.ts`](../apps/desktop/test/engine-media.test.ts) | What each engine receives, through stand-in `claude` and `codex` binaries: images and PDFs in Claude's message, Codex's `--image`, paths only for providers that may not take media, and the images in tool results that each engine shares. |
| [`apps/desktop/test/runner-attachments.test.ts`](../apps/desktop/test/runner-attachments.test.ts) | Attachments through the runner against a real server: each turn running at once gets its own files, another participant's files in the catch-up with this computer's copy, and a media file the answer points to shared with the chat. |
| [`apps/desktop/test/attachment-context.test.ts`](../apps/desktop/test/attachment-context.test.ts) | What agents are told about files (the note after the prompt, catch-up mentions without the lines for older apps), finding the media files an answer points to inside the working folder only, and the publisher adding shared files to items, redacted, before the turn ends. |
| [`apps/desktop/test/workspace-sync.test.ts`](../apps/desktop/test/workspace-sync.test.ts) | Two workspace mirrors syncing through an in-process server: edits, deletions, executable bits, git repositories, conflicts, symbolic links and the mass-deletion guard. |
| [`apps/desktop/test/commands.test.ts`](../apps/desktop/test/commands.test.ts) | Parsing slash commands, ranking them for the palette, filling Codex custom prompts, turning Codex commands into prompts, and which commands each engine is offered. |
| [`apps/desktop/test/tools.test.ts`](../apps/desktop/test/tools.test.ts) | Describing tool calls by what they did (Cursor's own tools included), grouping consecutive calls and summarizing a group. |
| [`apps/desktop/test/tunnel.test.ts`](../apps/desktop/test/tunnel.test.ts) | The host's public tunnel through a stand-in `cloudflared`: keeping a connected tunnel, replacing one that dies, keeping the address through a short disconnection after waking up and replacing a tunnel that stays disconnected, replacing at once one whose hostname Cloudflare dropped (without trusting resolvers that know no trycloudflare.com names), retrying with growing waits, one replacement at a time, taking over a tunnel left running only while it connects, and never adopting or signalling another process, such as another instance's tunnel. |
| [`apps/desktop/test/i18n.test.ts`](../apps/desktop/test/i18n.test.ts) | English fallback and localization of server messages. |

Tests exercise public interfaces the way callers use them. Servers start in-process on a random port with a temporary data folder ([`apps/server/test/helpers.ts`](../apps/server/test/helpers.ts): `startServer({ accessCode, google, passwordAuth, maxParallelTurns })`, `TestSocket.connect(…, features)` for an app that announces multitask, and `TestSocket.closed` for the close code of a connection), and file-system inputs are built in temporary folders; internal modules are not mocked. Google is replaced by `FakeGoogle` ([`apps/server/test/fake-google.ts`](../apps/server/test/fake-google.ts)), which serves the authorization, token and signing-key endpoints, so the sign-in tests run the real server and the app's flow without reaching Google; MCP authorization servers are replaced the same way by a fake defined in `connector-oauth.test.ts`. In both, a stand-in for the browser follows the authorization URL back to the app's loopback. The update tests build small app bundles signed with `codesign` ([`apps/desktop/test/bundles.ts`](../apps/desktop/test/bundles.ts)) and replace `open` with a fake that plays the app. The runner tests receive stand-in engine binaries that record how they were started and what they were asked, and the tunnel tests a stand-in `cloudflared` whose metrics endpoints say what each test needs. No test launches Electron or calls a model provider.

## Internationalization

The interface is in English and Spanish ([`src/shared/i18n.ts`](../apps/desktop/src/shared/i18n.ts)). English is the source language: strings are written in English in the code and the English text is the translation key.

- In the renderer, translate with `const t = useT()` and `t('Text')`; in the main process, with `tr('Text')`.
- Put variable parts in placeholders instead of concatenating: `t('{name} invited you to "{title}"', { name, title })`.
- **Every new user-facing string needs a Spanish entry** in `ES` in [`src/shared/i18n-es.ts`](../apps/desktop/src/shared/i18n-es.ts), in the section of the area it belongs to. A missing entry silently falls back to English.
- The server, the engines and the runner produce English text (errors, notices such as "Ana joined the chat"). Clients localize it when displaying it by matching templates in `ES_MESSAGES` (`t.message(text)` in the renderer; the API client does it for server errors). When you add such a message, add its template, with `{placeholders}` for the variable parts, to `ES_MESSAGES`.
- Spanish strings use the voseo of Argentine Spanish ("Configurá", "Elegí"), and dates use the `es-AR` locale.

Users choose the language on the sign-in screen or in Settings → Account & device; the one-line installer presets the language of the person who sent it.

## Conventions

Code conventions for every contributor are listed in [AGENTS.md](../AGENTS.md#code-conventions).
