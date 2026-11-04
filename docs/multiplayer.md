# Multiplayer

How people work together in CooPrompt: chat types, invitations, presence, multitask, team-only messages, approvals, cancelling and interrupting, shared workspaces and running turns on your other computers.

## Chat types

| | Private | Multiplayer | Company |
| --- | --- | --- | --- |
| Who can see it | Only you | Members | Everyone in your organization |
| How people join | Nobody else can | By invitation | Anyone in the organization can join |
| Where the agent works | A folder on your computer (new or an existing one, such as a repo) | A shared folder synced to every member's computer | A shared folder synced to every member's computer |
| Requirements | — | — | An account with a company email |

Private chats keep their files on your computer, but their conversation is stored on the team server like any other chat.

Company chats can be read by anyone in the organization; joining is needed to send messages and to sync the workspace. People who haven't joined see the chat marked "view" in the sidebar and a **Join** button instead of the composer.

### Organizations

Your organization is the domain of your email address, unless it belongs to a public mail provider (Gmail, Outlook, iCloud, Yahoo and similar), in which case you have no organization. The rule and the list of public providers are in `orgDomainFromEmail` in [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts). Settings → Account & device shows your organization.

## Invitations

- In a multiplayer chat, click **Invite** in the header (or **Invite someone** in the People tab). Search people by name or email; people from your organization are listed first.
- You can invite an email address that has no account yet. The invitation waits until someone signs up with that address.
- The invitee sees it under **Invitations** in the sidebar (and gets a notification when CooPrompt is in the background) and can accept or decline. Accepting adds them to the chat and opens it.
- Pending invitations are listed in the chat's People tab, where any member can revoke them.
- The chat records invitations, joins, declines and departures as notices.

Creating a multiplayer chat opens the invite dialog right away.

## Membership

- Any member can rename the chat (double-click the title, or **Rename** in the header menu).
- Members other than the owner can leave a shared chat with **Leave chat**.
- The owner can **Delete chat** for everyone. Running and queued turns are cancelled; local folders and files are not deleted.

## Presence

The header shows the members' avatars with a dot for those who have the chat open, and "… is typing" while someone writes in a shared chat.

## Sending messages

Every message you send is visible to all the chat's members, and so is the agent's work on it. Each message becomes a **turn**, except [team-only messages](#team-only-messages), which no agent sees:

- Turns run one at a time per chat, in the order they were sent, unless they are sent in [multitask](#multitask) mode; only an [interrupting](#interrupting) message skips ahead. While one runs, new messages wait in the queue, so a long task (following a deploy, waiting for CI) holds everyone's questions: give it a chat of its own, or send quick questions in multitask mode. The agent is told to report the status of slow outside work and finish instead of waiting for it, unless you ask it to wait.
- A turn runs on the computer of the person who sent it, with that person's model profile, credentials, MCP connectors and local tools. Everyone sees which profile, model and reasoning effort ran each turn, on whose computer, and how full that agent session's context was when it ended.
- The composer chooses the model profile, an optional model override, the reasoning effort and the permission mode. CooPrompt remembers them per chat on your computer; a chat where you haven't chosen a permission mode uses the default from Settings → Folders & privacy.
- Before a turn on your computer, the agent receives what other participants and their agents did since your last turn (see [context handoff](architecture.md#context-handoff-between-participants)).
- Files sent with a message are part of it for every member, who download them when they look at them; only the sender's agent receives them with the message. The others' agents read about them in that context, by name, with copies of the most recent ones in their own folder. Screenshots and media files an agent shares are visible to everyone too. Company chat files are for those who joined. See [Attaching files](usage.md#attaching-files).
- `/new` starts a fresh agent session for the chat on your computer only; other participants' sessions are not affected. See [Commands](usage.md#commands).
- An [automation](automations.md) can post in a chat you share: its runs are turns of its owner, labeled with its name, that run on the owner's computer. Everyone in the chat sees it in the Automations view; only its owner changes or runs it.

### Multitask

**Multitask** in the composer makes your messages start right away, beside the turns already running, instead of waiting for them: you keep sending while the agent works and each request is processed on its own, as in Cursor's multitask mode.

- It is off by default and only changes how your own messages run. CooPrompt remembers it per chat on your computer, like the model and the permission mode; other people's messages behave as before unless they turn it on too.
- Up to 3 turns run at once in a chat. Beyond that, multitask messages wait for one to finish.
- No message skips the line. A message sent without multitask, and every message from an older CooPrompt, still waits until no turn is running, and multitask messages sent after it wait behind it until it starts. Turning multitask on never makes anyone else wait longer.
- Turns sent in multitask mode show a **Multitask** badge, several turns stream at once, each in its own block, and each running turn has its own **Stop**.
- Turns running together share the chat's folder and can change the same files; the line under the composer says so while multitask is on. Each agent is told which other tasks are running in the folder, to re-read files right before editing them and to avoid commands that affect the whole folder. When turns on different computers change the same file, the usual [conflict copies](#shared-workspaces) keep both versions; when two turns on the same computer do, the last write wins.
- Each turn runs on the computer of whoever sent it. When two of your own turns run at once on your computer, the second one gets an agent session of its own: Claude forks the chat's session at the end of its last turn when that turn finished normally, and otherwise, as Codex and Cursor always do, starts a new session that receives the whole conversation. Your later turns continue the chat's main session and receive, once, what the parallel turns did. Details: [Session continuity](architecture.md#session-continuity).
- It needs a team server with multitask; with an older one the switch is disabled and messages queue as before. A turn sent to another of your computers runs in multitask mode only if that computer's CooPrompt supports it.

### Team-only messages

**Team only**, next to the send button (or **Ctrl+Shift+E** on Windows, **⇧⌘E** on macOS), sends your messages to the people in the chat and to no agent: they never become a turn, never enter any agent's context, and so cost no tokens. Use it to coordinate with the team without the agents reading along.

- While it is on, the composer turns green, reads "Team only · the AI won't see this message" and hides the model, effort, permission and multitask controls, and the send button changes. Whatever you press to send (Ctrl+Enter on Windows or ⌘↩ on macOS included), the message goes to the team. CooPrompt remembers it per chat on your computer, like multitask, and it is off by default. Private chats don't have it.
- In the chat, the message shows who wrote it and "Team only · the AI doesn't see it". Files can go with it: everyone in the chat sees them, and no agent gets a copy. The other members' CooPrompt notifies them when it is in the background and marks the chat in the sidebar until they open it.
- No agent gets it in any way: not the agent of whoever sends the next message, not a session that catches up later, not a session forked for multitask, not an automation run. The team server enforces it, not only the app; see [Architecture](architecture.md#team-only-messages).
- **Share with the AI**, on your own team-only messages (it appears on hover), lets every agent in the chat read that message from its next turn on, as if you had written it to them; it can't be undone. Only its author can share a message.
- With a team server that does not support team-only messages, the switch is greyed out and says the server needs updating; a chat left on team-only blocks sending until you turn it off, so a message meant for the team never reaches an agent. Clients that do not announce the feature receive a stand-in instead of the message.

### Permission modes

| Composer label | Claude engine | Codex engine | Cursor engine |
| --- | --- | --- | --- |
| Ask before acting | `default` permission mode | `workspace-write` sandbox | not offered |
| Accept edits | `acceptEdits` | `workspace-write` sandbox | `agent` mode, Cursor's allowlist |
| Automatic (classifier) | `auto` | `workspace-write` sandbox | not offered |
| Plan only | `plan` | `read-only` sandbox | `plan` mode, changes refused |
| No restrictions | `bypassPermissions` | `danger-full-access` sandbox | Run Everything (`--force`) |

Claude asks for approval according to its permission mode. Codex runs without approval prompts: the sandbox is what limits it, with network access enabled, and outside "Plan only" its MCP tools (your connectors, its own servers and plugins, and ChatGPT apps such as Slack) are approved up front, while in "Plan only" only read-only ones run ([why](connectors.md#codex-and-connector-tool-approvals)). The mapping is in [`src/main/engines/codex.ts`](../apps/desktop/src/main/engines/codex.ts).

Cursor edits files inside the working folder without asking and asks, through the usual cards, before running a command its allowlist (in your Cursor CLI settings) doesn't cover, using a connector tool, fetching a page or writing outside the folder. It has no mode that asks before every edit and no classifier mode, so with a Cursor profile the composer offers only "Accept edits", "Plan only" and "No restrictions", and a chat set to one of the others uses "Accept edits". In "Plan only" Cursor works in its read-only plan mode, CooPrompt refuses anything it asks to do that could change something, and the turn stops (and its CLI with it) if the agent switches out of plan mode or starts editing files. The plans it writes appear in the chat (the CLI also saves them in `~/.cursor/plans`). "No restrictions" runs everything without asking, unless your Cursor team disabled that. The mapping is in [`src/main/engines/cursor.ts`](../apps/desktop/src/main/engines/cursor.ts) and the modes each engine offers in [`src/shared/engines.ts`](../apps/desktop/src/shared/engines.ts).

On macOS, Codex's sandbox (every mode except "No restrictions") can't read the macOS Keychain, so `gh` and git over HTTPS fail as if you were signed out, even when they work in your terminal; git over SSH works. It also blocks servers that need shared memory, such as a local PostgreSQL, and listing or stopping processes. CooPrompt tells a new Codex session about these limits, and that nobody can answer it mid-turn, so it asks its questions in its reply; when `gh` or git fail this way, the turn shows a notice. For a message that needs `gh` (opening a pull request, for example), send it with "No restrictions".

## Permissions and questions

When the agent asks for permission to use a tool, or asks a question, a card appears in the transcript for everyone, and the person whose computer runs the turn gets a notification if CooPrompt is in the background.

- **Permissions**: only the person whose computer runs the turn can approve or deny, unless they turn on **Let others approve my agent's actions** in the chat's People tab. That switch is per chat and is read when each turn starts. The card shows who decided.
- **Always allow** (when the engine offers it) remembers the approval for that chat on the executor's computer: by tool name, or for shell commands by their first two words.
- **Questions** can be answered by any member of the chat.
- Requests that are still pending when the turn ends or is cancelled expire.

## Cancelling

**Stop** in the composer cancels your own turns in the chat, running and queued; the **Stop** in a turn's header cancels only that turn, and is shown to its requester and the chat owner. A queued turn is cancelled immediately. A running turn is aborted on the computer that runs it; if that computer doesn't confirm within 15 seconds, the server marks the turn cancelled anyway. The turn then shows "Cancelled by <name>". The server also lets the chat owner cancel other people's turns ([`POST /api/turns/:id/cancel`](server.md#endpoints)).

## Interrupting

While a turn is running, **Interrupt and send** (or Ctrl+Enter on Windows, ⌘↩ on macOS) in the composer stops it and runs your new message right away:

- It is allowed for whoever started the running turn and for the chat owner, the same people who can cancel it. The server enforces this.
- When several turns are running, **Interrupt and send** asks which one to stop, and the keyboard shortcut stops your latest running turn (for the chat owner without one, the latest of all). The new message starts as soon as that turn has stopped: beside the other running turns when multitask is on, otherwise once they finish, like any message sent without multitask.
- The running turn ends as "Interrupted by <name>". The new message goes ahead of anything else in the queue; the other queued messages keep their order.
- When the new message runs on the computer that ran the interrupted turn (for example, when you interrupt your own turn) with the same profile, it continues that agent session, so the work done so far stays in context. Claude Code records the interruption in its own session; for Codex and Cursor, CooPrompt tells the agent that its previous turn was interrupted. On another computer, the agent catches up through the usual [context handoff](architecture.md#context-handoff-between-participants).
- It doesn't add your message to the running turn: that turn stops and a new one starts.
- With a server that predates interrupts, CooPrompt queues the message and cancels the running turn instead, so messages already in the queue run first. Older versions of CooPrompt don't say which turn to stop: the server stops the sender's latest running turn.

## Running on another of your own computers

Sign in with the same account on several computers and they appear in Settings → Account & device. When more than one is connected, the composer shows a device picker: the turn then runs on the computer you choose, with that computer's model profiles, credentials, connectors and folders. If the requested profile doesn't exist there, that computer's default profile for the same engine is used. A computer whose CooPrompt predates the engine (Cursor, for versions before it) fails the turn saying it has no model for it.

The chosen computer must be online when you send. Closing CooPrompt's window keeps the app running and available for turns; quitting CooPrompt takes the computer offline. Each computer's name (shown to others next to the turns it runs) can be changed in Settings → Account & device.

## Shared workspaces

Multiplayer and company chats own a shared folder. Ask the agent to clone a repository and the clone, made with the requester's own git credentials, reaches every member. Clone it there even when you already have a copy elsewhere on your computer: the others' agents can't see your copy, Codex's sandbox only lets the agent write inside the chat's folder (outside "No restrictions"), and a copy made without `.git` leaves the others without its history. With Codex, use the repository's SSH address (see [Permission modes](#permission-modes)). Each computer installs its own dependencies before building or testing, because `node_modules` isn't synced.

- **Location**: `~/CooPrompt/Compartidos/<chat title>-<id>` by default, created when you open the chat. The parent folder can be changed in Settings → Folders & privacy (it applies to new chats); a chat keeps its folder when renamed.
- **What syncs**: every file, including the `.git` folder, except what `.gitignore` files ignore (at any level), what a `.coopromptignore` at the root ignores, `node_modules`, `.DS_Store`, git lock files, editor swap files, hidden temporary files, hidden attachment directories and the `.cooprompt` folder (each computer's copies of the chat's attachments). Files larger than 200 MB are not synced. Ignoring `.env` and build output keeps each person's secrets and dependencies on their own computer. Symbolic links aren't synced either, and CooPrompt never reads or writes through a symbolically linked folder, so a shared change can't reach files outside the workspace.
- **Consistency**: before a turn runs on a computer, CooPrompt applies the pending remote changes; when the turn ends, it uploads the local changes before the next turn starts. Turns sent in [multitask](#multitask) mode don't wait for each other, so their changes can meet mid-turn.
- **Executable files**: Windows preserves the last synchronized executable flag when it edits an existing file. New Windows files are shared without the Unix executable flag; set it from a Unix-based device when needed.
- **Conflicts**: when two people change the same file at the same time, both versions are kept. The version already on the server keeps the file name; the other one is saved next to it as `<name> (conflict <device> <date time>)<extension>` and synced too. The Files tab lists the conflicts.
- **Deletions**: a file you edited after someone else deleted it is kept and shared again; a file you delete while someone else changed it comes back with their version.
- **Safety**: if the folder disappears, sync pauses so nobody else loses files. If most of the folder vanished while CooPrompt was closed, the files are restored from the server instead of being deleted for everyone.
- The **Files** tab of the side panel shows the folder, the sync state and conflicts, and has **Open folder**, **Terminal** and **Resync** buttons.

The mechanics are described in [Architecture](architecture.md#shared-workspace-sync).

## Private chat folders

A private chat works in the folder you pick when creating it (for example an existing repository) or, by default, in a new folder under `~/CooPrompt/Privados` created with the first request. The Files tab can switch it to another folder later, which starts a fresh engine session. Nothing in a private chat's folder is synced.

## Skills, subagents and memory

Each engine loads its skills, subagents and memory files (`AGENTS.md`, `CLAUDE.md`) from your personal configuration and from the chat's working folder. In a shared workspace, what you put in its `.claude/skills`, `.claude/agents` or `AGENTS.md` is used by everyone's agents (Cursor also reads its own `.cursor/rules`, `.cursor/commands` and `.cursor/skills`). Settings → Skills & agents and Settings → Memory list, create and edit these files, both the personal ones (under `~/.claude`, `~/.agents` and `~/.codex`) and those in the open chat's folder ([`src/main/catalog.ts`](../apps/desktop/src/main/catalog.ts)). The Agent tab of the side panel shows what the engine loaded on the last turn on your computer.
