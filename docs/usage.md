# Using CooPrompt

A guide for people who use CooPrompt day to day: signing in, setting up models, working in chats, approving the agent's actions, and fixing common problems. To install the app, see [Install CooPrompt](../README.md#install-cooprompt-teammates). To host a server for your team, see [Deployment](deployment.md).

## First run

A team shares one server: one person hosts it and everyone else joins it.

1. **Team server**: if you installed CooPrompt with the one-line installer, it opens on the sign-in screen with your team's server already filled in. Otherwise (for example, installed from a zip or a disk image), CooPrompt first asks how you want to start:
   - **Join my team's server**: paste the address your teammate sent you (for example `https://….trycloudflare.com` or `http://192.168.x.x:4317`) and click **Test**. When the server answers, the sign-in screen opens with it, and a green "Connected" badge shows the server's name and version.
   - **Create a new server on this PC**: only for the person who hosts the team. Your CooPrompt starts the server and your teammates connect to you; see [Deployment](deployment.md#playbook-a-host-on-a-teammates-computer).

On the sign-in screen you can change the address under **Team server** and click **Test**. If nothing answers at the address when you sign in, CooPrompt says "Nothing answered at …" and offers the same two choices; **No server yet? Host one on this computer** leads to them too. The sign-in screen only starts a server when you choose **Create a new server on this PC**.
2. **Sign in**:
   - When the server has Google sign-in, **Continue with Google** comes first. It opens your browser; choose your account there and CooPrompt signs you in. A line under the button says which accounts the server accepts, for example "Only @acme.com accounts": use your company Google account. While CooPrompt waits for the browser, **Cancel** stops waiting, and clicking **Continue with Google** again starts over.
   - With email, below "or with email" when Google is also offered: **Sign in** or **Create account**. Servers that accept only Google accounts don't show this part.
   - The screen starts on **Sign in**, except on a server with no accounts yet, where it starts on **Create account**.
   - Creating an account asks for your name, email and a password of at least 8 characters, plus the server's access code if it requires one (ask whoever runs the server).
   - Use a company email (not Gmail, Outlook and similar) to join your organization and see its company chats. See [Organizations](multiplayer.md#organizations).
   - If signing in fails, CooPrompt offers to create an account with that email instead.
   - If you have a password account and sign in with Google using the same email, you keep your account and chats, and from then on you always sign in with Google: the password stops working, and your other computers ask you to sign in again.
3. **Language**: the picker at the bottom of the screen switches between English and Español. You can change it later in Settings → Account & device.

You stay signed in until you choose **Sign out** in Settings → Account & device. If your server gets a new address (for example a new tunnel), enter it there under **Server** and click **Change**: you stay signed in.

## Set up a model

Open **Settings → Models & keys**. A **profile** pairs an engine (Claude Code, Codex or Cursor) with credentials from your computer. You need at least one before talking to the agent.

1. Pick a preset in the list at the bottom and click **Add**:
   - **Claude · Anthropic API key**: an API key from console.anthropic.com.
   - **Claude · Claude Code sign-in on this computer**: uses the account Claude Code is signed in with on your device. The box shows which one: a Claude subscription with its plan (Pro, Max, Team or Enterprise), or an Anthropic Console account, which is billed per use of the API. Click **Sign in to Claude** (or **Switch account**) to open the browser; to use an Anthropic Console account instead, run `claude auth login --console` in a terminal. Other participants only see the profile's name.
   - **Codex · ChatGPT sign-in on this computer**: uses your ChatGPT account through Codex. Click **Sign in to Codex** to open the browser (or **Switch account**); the box shows whether Codex is signed in.
   - **Codex · OpenAI API key**: an API key from platform.openai.com.
   - **Cursor · Cursor sign-in on this computer**: Cursor's agent on your Cursor plan, through the Cursor CLI. Follow the [Cursor installation guide](https://cursor.com/docs/cli/installation) for your operating system; native Windows integration still needs validation. The box shows the CLI's account and plan, and **Sign in to Cursor** (or **Switch account**) opens its own browser sign-in. CooPrompt never reads the CLI's credentials, and other participants only see the profile's name. **Load models** lists the models your Cursor account offers.
   - **OpenRouter**, **DeepSeek**, **Kimi**, **GLM**: their models on the Claude Code engine, with a key from each provider.
   - **Ollama · local models**: models running on your computer; no key needed.
   - **Custom · Anthropic-compatible** or **Custom · OpenAI-compatible**: any gateway with that API; enter its base URL (and, for OpenAI-compatible ones, whether it speaks the Responses or the Chat Completions API).
2. Paste the API key when the profile needs one. It is stored encrypted on this device (the profile shows "key saved") and never goes to the team server or to other participants.
3. Optionally set a **default model**: **Load models** lists what the provider offers. Empty means the engine's default.
4. **Save**. The first profile becomes the default; the star button makes another one the default.

In shared chats each person's messages run with their own profiles. Nobody uses anyone else's keys.

## Chats

Create one with the **New chat** button at the top of the sidebar:

- **Private**: just you. The agent works in a folder on your computer; pick an existing one (such as a repository) or let CooPrompt create one.
- **Multiplayer**: you invite specific people and share a synced folder. The invite dialog opens right after creating it.
- **Company**: visible to your whole organization; anyone in it can join. Only available with a company email.

The sidebar groups chats by type, can search them by title, shows a pulsing dot while the agent works in a chat, a blue dot on chats with [team-only messages](multiplayer.md#team-only-messages) you haven't opened, and marks company chats you haven't joined with "view". The header shows the chat type, the workspace sync state, who is typing and who has the chat open. Double-click the title to rename the chat; the **⋯** menu has **Rename**, **Leave chat** and, for the owner, **Delete chat**.

How each type behaves, membership rules and presence are described in [Multiplayer](multiplayer.md#chat-types).

### Invitations

Click **Invite** in a multiplayer chat's header, search by name or email, and invite. You can also invite an email that has no account yet. Invitations you receive appear at the top of the sidebar with buttons to accept or decline. Details: [Multiplayer → Invitations](multiplayer.md#invitations).

## The composer

Type at the bottom of the chat and press **Enter** to send (**Shift+Enter** for a new line). Below the text box:

- **Profile**: which model profile runs your message, from this computer's profiles.
- **Model**: an optional override; the field suggests the models the profile's provider offers.
- **Effort** (the gauge): how much the model reasons before answering. Pick a level (Low, Medium, High, Extra high and, for Claude, Max) or leave "Default effort". With the Claude Code, Codex and Cursor sign-ins, the levels come from the chosen model; with Codex, the default one (from your Codex configuration, or the model's own) is marked. Cursor models without levels, and Cursor's own default model, have no gauge.
- **Permissions**: how freely the agent may act. "Ask before acting" asks before actions that need approval; "Accept edits" lets it edit files without asking; "Automatic (classifier)" lets the engine decide; "Plan only" limits it to planning without changes; "No restrictions" turns off approvals and sandboxing, so use it with care. Chats where you haven't picked one start with the default mode from Settings → Folders & privacy. With Cursor only "Accept edits", "Plan only" and "No restrictions" are offered, because Cursor edits files in the working folder without asking; the chat keeps the mode you chose for the other engines. How each mode maps to Claude, Codex and Cursor: [Permission modes](multiplayer.md#permission-modes).
- **Multitask**: your messages start right away, beside the turns already running (up to 3 at once in a chat), instead of waiting in line. Off by default; CooPrompt remembers it per chat, and it doesn't change how anyone else's messages run. Disabled when the team server doesn't support it. See [Multitask](multiplayer.md#multitask).
- **Device**: shown when you are signed in on more than one computer; runs your message on another of your computers. See [Running on another of your own computers](multiplayer.md#running-on-another-of-your-own-computers).
- **Context**: once one of your turns has run on this computer with the selected profile, a ring shows how full that agent session's context is ("N% context"); hover it for the token counts. The number is updated at the end of each turn. When it gets close to full, send `/new`. The Cursor CLI doesn't report it, so Cursor profiles show no ring.
- **Stop**: cancels your running and queued turns in this chat. To stop just one, use the **Stop** in that turn's header.
- **Team only** (next to the send button, or **⇧⌘E**, in multiplayer and company chats): your messages go to the people in the chat and to no agent, so they cost no tokens and never enter an agent's context. The composer turns blue, says so above the text and hides the run options until you turn it off; CooPrompt remembers it per chat. Greyed out when the team server doesn't support it. See [Team-only messages](multiplayer.md#team-only-messages).

CooPrompt remembers the profile, model, effort and permission mode per chat.

### Attaching files

Click the paperclip, drop files anywhere on the chat, or paste them (screenshots and copied images included). They wait above the text box, where × removes one, until you send them, with or without text; each chat keeps its own, so switching chats never sends them to the wrong one. CooPrompt recognizes images (PNG, JPEG, GIF, WebP, AVIF, SVG), PDFs, audio (MP3, M4A, AAC, WAV, Ogg, FLAC) and video (MP4, MOV, WebM) by their content; anything else goes as a plain file. A message can carry up to 10 files, 50 MB each and 100 MB in total.

Everyone in the chat sees them, and the agent of whoever sends the message gets them: Claude sees images and PDFs directly, Codex and Cursor see images, and all of them (like any engine) get copies in the chat's folder, under `.cooprompt/attachments`, which isn't synced. Other participants' agents learn about the files from the conversation and get copies of the most recent ones. With profiles on compatible endpoints (OpenRouter, DeepSeek, Ollama and the like), the agent gets only the copies. Details: [Attachments](architecture.md#attachments).

When the team server predates attachments, the paperclip is greyed out: whoever hosts it needs to update CooPrompt.

### While the agent is working

If a turn is running, **Enter** puts your message in the queue: it runs when the turns ahead of it finish. With **Multitask** on, Enter starts it right away instead, beside the running turns, unless 3 are already running or someone's message is waiting ahead of yours; the line under the composer says which, and reminds you that turns running together share the chat's folder. To redirect the agent instead, click **Interrupt and send** (or press **⌘↩**): the running turn stops and your message runs right away, in the same agent session, with everything done so far as context. When several turns are running it asks which one to stop (⌘↩ stops your latest). Only whoever started the running turn and the chat owner can interrupt it. Details: [Interrupting](multiplayer.md#interrupting).

### Commands

Type `/` at the start of a message to list the commands of the selected profile's engine, with their descriptions and argument hints. Move with ↑↓, complete with Tab or Enter, close with Esc.

- **Claude Code**: the list comes from Claude Code itself: the built-in commands that work in CooPrompt, your custom and plugin commands, and your skills. When a command answers without the model, its output appears in the chat.
- **Codex**: `/review` (reviews the current changes, optionally with a focus), `/init` (writes an `AGENTS.md`), and your custom prompts from `~/.codex/prompts` as `/prompts:<name>`. Typing `$` lists your skills to mention one; skills that come from Codex plugins aren't listed, although Codex still uses them.
- **Cursor**: your custom commands (`.cursor/commands` and `.claude/commands`, personal or in the chat's folder) and skills, which Cursor runs when the message starts with `/name`. The commands of Cursor's terminal (`/model`, `/compress` and the like) don't exist outside it.
- **`/new`** (also `/clear` and `/reset`), for every engine: starts a fresh agent session on your computer without calling the model. The chat stays as it is; the agent only receives what happens from then on.

`/model` and `/effort` aren't listed because the composer sets the model and the effort, and neither are commands that only work in a terminal.

## Reading the transcript

Each turn shows who asked, which profile and model answered (and the effort, when one was chosen), on whose computer it ran, and its status: queued (with what it is waiting for), working, failed, cancelled or interrupted (with who did it), or done with its duration, cost and how full the agent's context ended up ("N% of context"). Turns sent in multitask mode carry a **Multitask** badge and can stream at the same time, each in its own block; running and queued turns have a **Stop** for whoever sent them and for the chat owner.

The agent's messages, thinking, plan, permission requests and questions appear in order. Consecutive tool calls collapse into one line that sums them up, for example "Ran 4 commands and used GitHub · 1 failed · 5 steps", with an icon for each kind of tool and the logo of the service behind MCP tools. Click it to see each call with a plain title and its key argument (the command, the file, the search); open a call to see its full command, the diff of an edit, or its input and result. Failed calls stay visible in red with their first error line, the call in progress stays visible while it runs, and calls left unfinished when a turn stops are marked "Interrupted".

Known non-fatal Codex configuration and model-metadata diagnostics appear as warnings, with repeated identical copies shown once. The turn's status still shows whether it completed or failed.

Team-only messages show who wrote them and "Team only · the AI doesn't see it", in a green box; when CooPrompt is in the background, a teammate's team-only message brings a notification. On your own, **Share with the AI** (on hover) lets the agents read it from their next turn on; it then shows "Shared with the AI".

Files appear under the message that carried them: images as thumbnails (click one to see it full size, with ← and → between the images of a message, Esc to close), audio and video with their players, and other files as chips. **Open** opens images, PDFs, audio and video in the system's default app; **Show in folder** and **Save…** work for every file. Images an agent's tools return, such as a browser screenshot, appear under the tool call, and stay in view when the calls are collapsed; media files the agent saved in the chat's folder and mentions in its answer appear under the answer. People who haven't joined a company chat see the files' names only.

## Folders

- **Multiplayer and company chats** use a shared folder, by default in `~/CooPrompt/Compartidos`, that syncs with every member's computer. Files ignored by `.gitignore` (such as `.env` or `node_modules`) stay on your computer. To work on a repository, ask the agent to clone it into the chat. The folder keeps the name the chat had when you first opened it, so start a new chat for a new subject instead of renaming an old one.
- **Private chats** use the folder you picked or a new one in `~/CooPrompt/Privados`.

The **Files** tab of the side panel (the panel button in the header) shows the folder and its files, the sync state and any conflicts, with buttons to open the folder or a terminal, **Resync** a shared folder, or **Choose folder…** for a private chat. The default parent folders can be changed in Settings → Folders & privacy. How syncing behaves, including conflicts and deletions: [Shared workspaces](multiplayer.md#shared-workspaces).

## Approving actions and answering questions

When the agent needs permission to use a tool, a card shows what it wants to do:

- On your own turns you get **Allow**, **Always allow in this chat** (when offered) and **Deny**.
- On someone else's turn the card says it is waiting for them to approve, because it runs on their computer. In the **People** tab, the person running the turn can turn on **Let others approve my agent's actions** to let any member decide.
- After the decision, the card shows who allowed or denied it.

When the agent asks a question, any member can pick the options (or write an **Other answer…**) and click **Answer**. CooPrompt sends a desktop notification when you need to approve or answer and the app isn't in front. Rules: [Permissions and questions](multiplayer.md#permissions-and-questions).

## Connectors

**Settings → MCP connectors** gives the agent access to other tools and services through MCP servers:

- **Catalog**: ready-made connectors. **On this computer** has browsers the agent can drive (see [Testing in the browser](#testing-in-the-browser)). **Remote** has official servers such as Notion, Linear or GitHub: **Add** opens your browser to sign in with your own account (or asks for a personal token).
- **Import from Claude, Codex and your other apps**: the servers you already configured in Claude Code, Codex, Cursor or Claude Desktop. **Import** one, or **Import all**.
- **Add connector**: define one by hand, local (a command) or remote (a URL).

Use **Test** to check a connector and **Connect** to sign in to a remote one. Connectors and their credentials stay on your computer and are used by your turns only; every engine receives them. Details: [Connectors](connectors.md).

## Testing in the browser

The agent can open web pages, click, type, fill forms, read the page and the console, and take screenshots, so you can ask it to try your app the way a person would. This comes from local connectors in the catalog, which run on your computer through `npx`: you need [Node.js](https://nodejs.org) installed.

1. Open **Settings → MCP connectors** and, in the catalog's **On this computer · needs Node.js** list, click **Add** next to **Playwright (test browser)**. The first time takes a moment while it downloads; then the connector shows "Connected" with its number of tools.
2. Ask for it in a chat, in your own words. For example:
   - "Open http://localhost:3000, sign in with the test user and check that the dashboard loads."
   - "Go through the sign-in flow on staging and tell me which step fails, with a screenshot."
   - "Open the home page in a phone-sized window and check that the menu opens."
   - "Load http://localhost:5173 and list the errors in the browser console."

Playwright drives its own Chrome window with a profile of its own for each working folder: what you sign in to there is remembered between turns, apart from your usual Chrome. It needs Google Chrome on your computer. To keep it from showing a window, edit the connector (pencil button) and add `--headless` to its arguments; `--isolated` starts every session from a clean profile instead.

Playwright saves page snapshots and screenshots in a `.playwright-mcp` folder inside the chat's working folder. Add `.playwright-mcp/` to `.gitignore` (or to `.coopromptignore` in a shared folder) to keep it out of git and of your teammates' copies.

With Claude and Cursor, each browser action asks for approval according to your [permission mode](multiplayer.md#permission-modes) (**Always allow in this chat** saves clicks). With Codex, connector tools are approved up front, except in "Plan only"; see [Connectors](connectors.md#codex-and-connector-tool-approvals).

### In your own Chrome

**Playwright in your Chrome** lets the agent work in your real Chrome, with the sessions you're signed in to, but only in the tabs you hand it.

1. Install the **Playwright Extension** from the Chrome Web Store (the **Install the Chrome extension** link next to the catalog entry; CooPrompt also opens it after adding the connector).
2. **Add** **Playwright in your Chrome** from the catalog.
3. The first time the agent uses the browser, Chrome opens a page from the extension: choose the tab the agent may control and approve the connection.

To skip that approval, click the extension's icon to open its status page and copy the `PLAYWRIGHT_MCP_EXTENSION_TOKEN` value it shows. Then edit the connector in CooPrompt and add `PLAYWRIGHT_MCP_EXTENSION_TOKEN=<the value>` under **Environment variables**; it is stored encrypted on this device. Everything the agent does in those tabs is done as you, with your accounts.

If you also have **Playwright (test browser)**, turn off the one you don't want the agent to use, so it doesn't have to guess which browser to drive.

### Debugging with Chrome DevTools

**Chrome DevTools** gives the agent the console, the network requests and performance traces of a Chrome page, for questions like "why is this page slow?" or "which request fails when I save?". It needs Node.js 20.19 or newer: if **Test** says it "does not support Node", update Node.js (with nvm, make a newer version the default, for example `nvm alias default 24`) and test again.

## Skills, subagents and memory

- **Settings → Skills & agents** lists your skills, subagents and custom command files, and creates new skills and subagents, either personal or in the open chat's folder.
- **Settings → Memory** creates and edits `AGENTS.md` and `CLAUDE.md`, the persistent instructions the agent reads, both personal and in the open chat's folder.
- The **Agent** tab of the side panel shows what the engine loaded on your last turn in the chat.

In a shared chat, skills, subagents and `AGENTS.md` placed in its folder are used by everyone's agents. See [Skills, subagents and memory](multiplayer.md#skills-subagents-and-memory).

## Automations

**Automations** in the sidebar runs saved instructions on a schedule (every few hours, every day, weekdays, chosen days or a cron expression) on your computer, without you: in a chat of its own or in one you already have, read-only unless you allow more. Finished runs wait in its inbox and notify you; **Run now** runs one at once. If your computer is asleep or CooPrompt is closed at a scheduled time, the run is missed and catches up once when you are back, if that is closer to it than to the next run. Everything about them is in [Automations](automations.md).

## Devices and settings

| Settings section | What it holds |
| --- | --- |
| Account & device | Your name, email and organization; language; the server address (**Change** it without signing out) and the connection; CooPrompt's version and **Check for updates**; this computer's name (others see it next to the turns it runs); your connected computers; **Sign out** |
| Models & keys | Model profiles and the default one |
| MCP connectors | Your connectors, imports and the catalog |
| Skills & agents | Skills, subagents and command files |
| Memory (AGENTS.md) | Personal and chat-folder instruction files |
| Team server | Hosting a server on this computer, with who can sign in to it (access code, **Sign in with Google**, Google accounts only), its public tunnel and keeping the computer awake while it is open; see [Deployment](deployment.md) |
| Folders & privacy | Parent folders for shared and private chats; the default permission mode for chats without their own; **Hide secrets in what gets posted to the chat** (on by default, see [Secret redaction](security.md#secret-redaction)) |

Closing CooPrompt's window keeps it running so your computer can still run your turns; the dot at the bottom of the sidebar shows the connection. Quitting CooPrompt cancels the turns running on this computer and, if you host the server, stops it. Signing out also stops this computer's running turns and syncing.

## Updating CooPrompt

Automatic updates currently apply to macOS builds only; Windows builds need to be installed separately. On macOS, CooPrompt updates itself from your team server: whenever the server offers a newer build, a banner appears at the top of the sidebar (and a notification, if CooPrompt is in the background). CooPrompt checks shortly after it starts, every 30 minutes and when it reconnects; **Check for updates** in Settings → Account & device checks right away and shows the version you have.

1. **CooPrompt X is available** shows the download size. Click **Update**: it downloads with a progress bar (close the banner to cancel), then shows "Checking the update…" while it verifies that the download is intact, is the announced version, and is signed by whoever signed your CooPrompt.
2. **CooPrompt X is ready**: click **Restart now**. CooPrompt quits, the new version takes its place and opens.
3. When it opens, macOS asks for your Mac password so CooPrompt can use "CooPrompt Safe Storage". Type it and choose **Always Allow**; this happens once after every update.
4. A banner confirms "CooPrompt was updated to X". If the new version doesn't start, the previous one comes back by itself and the banner says so.

If turns are running on your computer, or on the server you host, the restart waits for them ("CooPrompt will restart as soon as the running turns finish"); **Restart anyway** doesn't wait, and **Cancel** keeps the current version for now. When the host of your server updates, you see "The server is restarting to update…" and CooPrompt reconnects by itself.

Development builds and `COOPROMPT_PROFILE` instances don't update. How updates are published and verified: [Distribution](distribution.md#how-updates-reach-teammates).

## Troubleshooting

**macOS says CooPrompt can't be opened or can't be verified.** Copies downloaded with a browser are blocked the first time because CooPrompt isn't notarized. Open System Settings → Privacy & Security and click **Open Anyway**, or run `xattr -dr com.apple.quarantine /Applications/CooPrompt.app`. Installing with the one-line installer avoids this. See [Distribution](distribution.md#signing).

**macOS asks for your password so CooPrompt can use "CooPrompt Safe Storage".** This happens once after every update or new install, because macOS treats each build as a new app. Type your Mac password and choose **Always Allow**. If you clicked **Deny**, CooPrompt can't read the keys and session it had stored: quit and reopen it and allow access when macOS asks again.

**An update didn't install.** "CooPrompt X did not start, so the previous version was restored" means the new version didn't confirm it started within two minutes; you keep working on the previous one, and the next check offers the update again. "Could not install CooPrompt X: …" says what blocked it (for example, CooPrompt didn't quit). When the Applications folder isn't writable, the update goes to `~/Applications` and the old copy opens the new one. The details are in `~/Library/Application Support/CooPrompt/updates/helper.log`.

**"Could not update: …"** The download failed or didn't pass verification. "does not match what the server announced" usually means the build on the server changed meanwhile: click **Retry**. "is not signed by whoever signed this CooPrompt" means the server offers a build signed by someone else (for example, after the signing identity was replaced): ask whoever publishes the builds, or reinstall with the one-line installer.

**Can't connect to the server.**

- Check the address on the sign-in screen with **Test**: the scheme (`http` for local network addresses, `https` for tunnels) and the port (4317 by default).
- Local network addresses only work on the same network as the host. From elsewhere you need the host's tunnel address.
- On macOS 15 or later, if you declined to let CooPrompt find devices on your local network, allow it in System Settings → Privacy & Security → Local Network.
- On the host's computer, the operating system's firewall must allow incoming connections for CooPrompt.
- "Session expired: sign in again" means the server no longer accepts your session (for example, its data was reset): sign in again, or create the account again on a new server.
- If it still fails, the server is probably not running; see below.

**You created a server on your computer by mistake.** Your teammates can't see you there: every server has its own accounts and chats. In Settings → Team server click **Stop**, then **Sign out** in Settings → Account & device, enter your team's address under **Team server** on the sign-in screen and sign in there.

**The tunnel address stopped working.** Public tunnels are not yet available on Windows. On macOS a Cloudflare quick tunnel keeps its address while the host's CooPrompt quits, restarts or updates, but gets a new random one when the host closes it, when the host's computer restarts, or when the host's CooPrompt replaces a tunnel that stopped working (`cloudflared` stopped, or Cloudflare dropped the tunnel, for example after the computer slept for a while). The host's CooPrompt then shows "Your server has a new public address" with **Copy message for the team**, which gives the host a message with the new address to send. Enter the address in Settings → Account & device → **Server** and click **Change**: you stay signed in. If CooPrompt says your session is invalid or expired, or that the address belongs to another server, it isn't the same server: sign out and sign in there.

**The server isn't running on the host's computer.** The embedded server only runs while the host's CooPrompt is open and the computer is awake and online. While the tunnel is open, **Keep this computer awake while the tunnel is open** (on by default in Settings → Team server) keeps the computer from going to sleep on its own, but closing the lid still puts it to sleep. In Settings → Team server the host sees "Running · port …" or "Stopped" and can click **Host on this computer**; **Start the server when CooPrompt opens** brings it back automatically. If it fails to start because the port is taken, change the port there, save, start it again and share the new address. For a server that stays up, see [Deployment](deployment.md#playbook-b-an-always-on-server).

**The agent can't use GitHub: `gh` says the token is invalid, or git asks for a username.** On macOS with Codex, every permission mode except "No restrictions" runs commands in a sandbox that can't read the macOS Keychain, where `gh` keeps its sign-in, so `gh` and git over HTTPS fail as if you were signed out even when they work in your terminal, and the turn shows a notice saying so. Signing in again doesn't help. Use the repository's SSH address for git (`git@github.com:…`), and send messages that need `gh`, such as opening a pull request, with "No restrictions". Details: [Permission modes](multiplayer.md#permission-modes).

**The agent can't install private packages** ("401", "your authentication token seems to be invalid", or "Failed to replace env in config: ${…}"). The registry's token is missing or expired on the computer that ran the turn. Refresh it there (with `npm login` or your registry's own login command), and export the variables that `.npmrc` files use, such as `CI_GITHUB_TOKEN`, in your shell profile (`~/.zshrc` or `~/.zprofile`). CooPrompt reads the login shell's environment when it starts, so quit and reopen it afterwards.

**The paperclip is greyed out, or "This team server doesn't accept attachments yet".** The team server predates attachments. Whoever hosts it needs to update CooPrompt (or the standalone server); your message and its files stay in the composer meanwhile.

**Your message waits behind someone else's long turn.** Turns run one at a time per chat unless they are sent in multitask mode: turn on **Multitask** in the composer and your messages start right away beside the running turns. Whoever started the running turn and the chat owner can also **Interrupt and send**. Give long tasks, such as following a deploy or waiting for CI, a chat of their own.

**In a shared chat, the agent works on a copy of your repository that lacks its history or files for the others.** Ask it to clone the repository into the chat (with Codex, by its SSH address) instead of pointing it at your own copy. See [Shared workspaces](multiplayer.md#shared-workspaces).

**Codex's Browser Use or Computer Use says "The user declined…".** Nobody was asked: CooPrompt can't show those approvals, so Codex declines them. For browser work, use the connectors in [Testing in the browser](#testing-in-the-browser).

**A Codex tool, such as Slack's "Send message", fails with "MCP tool call requires approval, but approval policy is never".** The message was sent with "Plan only", where Codex runs only read-only tools: send it again with another permission mode. Otherwise that tool is set to always ask in Codex's own settings, and nobody can answer it during a CooPrompt turn; change it there. See [Codex and connector tool approvals](connectors.md#codex-and-connector-tool-approvals).

**Other messages.**

| Message | What to do |
| --- | --- |
| "Nothing answered at …" | No CooPrompt server answered at that address: check it with whoever sent it (see **Can't connect to the server** above). Choose **Create a new server on this PC** only if you host the team. |
| "Set up a model in Settings → Models & keys…" / "No Claude (or Codex, or Cursor) model is set up on this computer" | Add a profile for that engine on the computer that runs the turn. |
| "The API key for … is missing" | Edit the profile and paste its key. |
| "Claude Code is not signed in on this computer yet", or the Claude Code sign-in shows an Anthropic Console account where you expected your subscription | Click **Sign in to Claude** (or **Switch account**) in the profile, or run `claude` in Terminal and type `/login`. |
| "The Cursor CLI isn't installed on this computer…" | Follow the [Cursor installation guide](https://cursor.com/docs/cli/installation) for your operating system, then sign in from the Cursor profile. Windows integration is still being validated. |
| "Cursor is not signed in on this computer…" | Click **Sign in to Cursor** in the Cursor profile, or run `cursor-agent login` in Terminal. |
| A Cursor turn ends with "Upgrade your plan to continue", "Add a payment method to continue" or another error from Cursor | Your Cursor account can't run that request (plan, usage or the model chosen); check it at cursor.com or pick another model. |
| "Cursor tried to leave Plan mode, so CooPrompt stopped the turn…" | In "Plan only" Cursor may not change anything; to let it act on the plan, send your message with another permission mode. |
| "This team server can't run Cursor turns yet…" | The team server predates Cursor; whoever hosts it has to update CooPrompt (or the standalone server). |
| "The device chosen to run this is not connected" | The computer selected to run the turn is offline; check the connection dot or pick another device. |
| **Interrupt and send** is disabled | Only whoever started the running turn and the chat owner can interrupt it. Press Enter to queue your message instead. |
| **Multitask** is disabled | The team server doesn't offer multitask: whoever hosts it needs a newer CooPrompt, or a standalone server needs a newer version (and no `COOPROMPT_MAX_PARALLEL_TURNS=1`). |
| The context ring is close to 100% | Send `/new` to start a fresh agent session on your computer; the chat itself is kept. |
| "Wrong access code" | Ask the host for the current code (Settings → Team server shows it). |
| "This account signs in with Google: use Continue with Google." | Your account moved to Google sign-in; use **Continue with Google** with the same email. |
| "An account with this email already exists, and Google cannot confirm the address is yours…" | Google can't vouch for that address (a personal Google account with a non-Gmail address). Sign in with your password, or choose your company Google account. |
| "This server only accepts accounts from: …" or "…This is a personal Google account." | Choose your company (Google Workspace) account in the browser. |
| "Session expired: sign in again" right after you signed in with Google elsewhere | Signing in with Google for the first time ends the account's other sessions. Sign out in Settings → Account & device, then use **Continue with Google**. |
| "Sign-in was cancelled in the browser." | You declined in Google's page; click **Continue with Google** again. |
| "Google did not accept the client ID and secret of this server…" or "This server does not accept email accounts and has no Google sign-in set up…" | The server's Google settings are wrong or missing; tell whoever runs it. |
| Company option disabled when creating a chat | Company chats need an account with a company email. |
| "cloudflared is missing" (host) | Install it with `brew install cloudflared`. |
| "The tunnel stopped working. Opening a new one…" or "The tunnel closed unexpectedly. Opening a new one…" (host) | Nothing to do: CooPrompt opens a new tunnel on its own, usually within a minute. |
| "The tunnel could not connect. CooPrompt keeps trying on its own." (host) | This computer can't reach Cloudflare right now (no internet, a network that blocks it, or quick tunnels are down). CooPrompt retries, waiting longer each time; **Try now** retries at once. |
| "Your server has a new public address" (host) | Click **Copy message for the team** and send it to teammates outside your network: it has the new address and the steps to switch to it. |
| "The server is restarting to update…" | The host's CooPrompt is installing an update; CooPrompt reconnects by itself within moments. |
| "Updates are off in development builds and profiles." | Expected for `npm run dev` and `COOPROMPT_PROFILE` instances; install a packaged build to get updates. |
| "Sync paused" or "Sync error" | The shared folder was moved or deleted, or the server is unreachable. Check the Files tab and use **Resync**. |
| "Codex's sandbox can't read the macOS Keychain…" | `gh` or git over HTTPS failed inside Codex's sandbox; see **The agent can't use GitHub** above. |

CooPrompt's log is `~/Library/Application Support/CooPrompt/logs/main.log`; include it when reporting a problem (review it first, as it can contain email addresses and file paths).
