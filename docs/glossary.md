# Glossary

Domain terms used in CooPrompt's code, interface and documentation. Code identifiers are in `monospace`.

## People, chats and servers

| Term | Meaning |
| --- | --- |
| **Team server** | The coordination server (`@cooprompt/server`). It holds accounts, chats, transcripts, the turn queue and shared workspace files, and relays live activity. It never runs agents. See [Team server](server.md). |
| **Host**, **embedded server** | A CooPrompt that runs the team server inside the app ("Host on this computer", [`host.ts`](../apps/desktop/src/main/host.ts)). |
| **Standalone server** | The team server run as a Node process with `npm run server` ([`cli.ts`](../apps/server/src/cli.ts)). |
| **Quick tunnel** | A Cloudflare tunnel started with `cloudflared` without an account. It publishes the server at a random `https://….trycloudflare.com` address. A host's tunnel keeps its address while CooPrompt quits, restarts or updates, and gets a new one when it is closed, when the computer restarts, or when CooPrompt replaces it because it stopped working. |
| **Access code** | A server-wide code required to create an email/password account, when configured. |
| **Google accounts only**, `passwordAuth` | A server that turns off email/password sign-up and sign-in (`passwordAuth: false`): **Google accounts only** in Settings → Team server, or `COOPROMPT_PASSWORD_AUTH=false` on a standalone server. |
| **Allowed domains** | The domains whose Google Workspace accounts may sign in with Google (`GOOGLE_ALLOWED_DOMAINS`, or **Allowed domains** in Settings → Team server). Matched against the account's Workspace (`hd`), not its address. |
| **Vouched email**, `ownsEmail` | An address Google confirms the person owns today: an account of a Google Workspace (`hd`) or a Gmail address. Only a Google sign-in with a vouched email can take over an existing account with that email. |
| **Organization**, `orgDomain` | The domain of a user's email address, unless it belongs to a public mail provider. Company chats are shared within it. |
| **Chat kind**, `ChatKind` | `private` (only the owner), `multiplayer` (members by invitation) or `corporate`, shown as **Company** (the whole organization can read and join). |
| **Owner**, **member** | The chat's creator (who can delete it) and its participants. Company chats can also be viewed by people who aren't members. |
| **Invitation** | A pending offer to join a chat, addressed to a user or to an email address that may not have an account yet. |
| **Presence** | Who has a chat open (subscribed) and who is typing. |
| **Notice** | A system line in the transcript, written in English by the server or the runner ("Ana joined the chat") and translated when displayed. |

## Turns and transcripts

| Term | Meaning |
| --- | --- |
| **Turn** | The agent's work on one message. It has a status: `queued`, `running`, `done`, `failed` or `cancelled`. Each chat runs one turn at a time, except turns sent in multitask mode. |
| **Multitask**, **parallel turn** | Sending a message with `parallel: true` (the **Multitask** switch in the composer, per chat and per sender): the turn starts right away, beside the running turns, instead of waiting, while fewer than `maxParallelTurns` (3 by default) run. See [Multitask](multiplayer.md#multitask). |
| **Interrupt**, **Interrupt and send** | Sending a message with `interrupt: true`: a running turn (the one named in `interruptTurnId`, or the sender's latest) is cancelled ("Interrupted by <name>") and the new one runs as soon as it has stopped. Allowed for that turn's requester and the chat owner. |
| **Priority** | The order of queued turns: interrupting turns have a higher priority and run first; otherwise turns run in arrival order. Stored in the `priority` column of `turns`. |
| **Requester** | The person who sent the message that started a turn. |
| **Automation** | Saved instructions the team server starts on a schedule as turns of their owner, on the owner's chosen computer, in a chat (`AutomationInfo`). See [Automations](automations.md). |
| **Run**, `AutomationRun` | One scheduled time of an automation, or a run started with **Run now**: `queued`, `running`, `done`, `failed` or `cancelled` (shown as cut short) when it posted a turn, `missed` when its computer wasn't connected, `skipped` when the previous run hadn't finished. |
| **Catch-up** | The one late run of an automation's latest missed time, when its computer connects again before half the time to the next run has passed. |
| **Unattended run** | A turn with `automation` set: the runner declines approval requests and questions instead of waiting, and tells the agent nobody can answer. |
| **Executor** | The device that runs a turn: always one of the requester's own devices. |
| **Device**, `deviceId` | One CooPrompt installation signed in to the server. Each has a random id and a name (the computer's name by default). |
| **Transcript** | The ordered list of items in a chat. |
| **Item**, `TranscriptItem` | One entry of the transcript: `user` (a prompt), `text`, `thinking`, `tool`, `permission`, `question`, `todo` (the agent's plan), `notice`, `error` or `team` (a team-only message). The server creates prompts, team-only messages and chat notices (joins, invitations); the executor creates and updates the other items of its turn as it progresses, with ids that start with the turn id. |
| **Team-only message**, `team` item | A message for the chat's people only, sent with **Team only** in the composer: it never becomes a turn and no agent gets it, unless its author shares it with the agents, which turns it into a `user` item without a turn (`sharedAt`). See [Team-only messages](multiplayer.md#team-only-messages). |
| **Stand-in**, `teamStandIns` | What apps that don't announce `team-messages`, and item requests without `include=team` (the runner's), get in place of a team-only message: the same item, with a text that only says who wrote. |
| `seq` | An item's position in its chat, assigned when it is created. Used for ordering and paging. |
| `rev` | A per-chat change counter, bumped every time an item is created or updated. Used to fetch what changed since a point (catch-up). |
| **Draft**, **delta** | The text or thinking that is streaming before it becomes an item. A delta appends to the draft. |
| **Attachment**, `AttachmentRef` | A file sent with a message, or media an agent shared (a tool's screenshot, a file its answer points to), kept by the team server for the chat's members and referenced from `user`, `text` and `tool` items. Its `kind` (`image`, `pdf`, `audio`, `video` or `file`) comes from its bytes. See [Attachments](architecture.md#attachments). |
| **Staged attachment** | A file chosen, dropped or pasted in the composer, kept on the computer until the message is sent. |
| `cooprompt-media:` | The scheme through which the renderer loads attachments, served by the main process from its cache. |
| **Decision** | An answer to a `permission` item (allow or deny, optionally always) or a `question` item. |
| **Permission mode**, `PermissionModeId` | How freely the agent may act in a turn: `default`, `acceptEdits`, `auto`, `plan`, `bypassPermissions`. See [Permission modes](multiplayer.md#permission-modes). |
| **Reasoning effort**, `effort` | How much the model reasons before answering, chosen per chat in the composer and sent in `TurnConfig`. Levels are engine-specific ([`src/shared/effort.ts`](../apps/desktop/src/shared/effort.ts)); an engine ignores a level it doesn't accept. |
| **Others can decide**, `othersCanDecide` | Whether members other than the executor may approve a permission request ("Let others approve my agent's actions"). |
| **Always allow rule** | A per-chat approval remembered on the executor's computer: a tool name, or for shell commands their first two words. |
| **Context handoff**, **catch-up** | The plain-text summary of what an engine session hasn't seen (other participants' activity and turns that ran beside its own) that an executor gives its engine before a turn, wrapped in `<cooprompt_context>`, with the turns running beside it listed apart. See [Architecture](architecture.md#context-handoff-between-participants). |
| **Context usage**, `contextTokens`/`contextWindow` | How many tokens the executor's engine session holds after a turn, out of the model's window, as reported by the engine. Published with the turn's usage and shown as "N% of context". |
| **Tool activity group** | Two or more consecutive tool calls (with the thinking between them) shown collapsed behind a one-line summary in the transcript ([`lib/tools.ts`](../apps/desktop/src/renderer/src/lib/tools.ts)). |

## Engines and models

| Term | Meaning |
| --- | --- |
| **Engine**, `EngineId` | The agent runtime: `claude` (Claude Code through the Claude Agent SDK), `codex` (Codex through the Codex SDK) or `cursor` (Cursor's agent through the Cursor CLI's ACP server). The Claude Code and Codex binaries ship inside the app; the Cursor CLI is installed by each person. |
| **ACP** | The Agent Client Protocol: JSON-RPC over stdio between a client and an agent. CooPrompt speaks it to `cursor-agent acp`, including Cursor's extensions (questions, plans, to-dos). |
| **Engine adapter** | The module that translates between CooPrompt and one engine ([`engines/claude.ts`](../apps/desktop/src/main/engines/claude.ts), [`engines/codex.ts`](../apps/desktop/src/main/engines/codex.ts), [`engines/cursor.ts`](../apps/desktop/src/main/engines/cursor.ts)). |
| **Engine session** | The engine's own conversation state for a chat on one computer (a Claude session, a Codex thread or a Cursor ACP session), resumed on the next turn when possible. |
| **Main session**, **side session**, **checkpoint** | With multitask, the chat's stored engine session on a computer is its main session; a turn that starts while it is busy runs in a side session: a fork of the main session at the checkpoint its engine returned at the end of its last turn (Claude), or a new session (engines that can't fork, such as Codex and Cursor). See [Session continuity](architecture.md#session-continuity). |
| **Profile**, `ProviderProfile` | A model setup on one computer: an engine plus credentials (API key, the Claude Code, Codex or Cursor sign-in, or none), an optional base URL and default model. |
| **Preset** | A template for creating a profile (Anthropic, Claude Code sign-in, Codex sign-in, OpenAI, Cursor sign-in, OpenRouter, Ollama…), in [`providers.ts`](../apps/desktop/src/main/engines/providers.ts). |
| **Turn config**, `TurnConfig` | The non-secret run options sent with a message: engine, profile id, model, permission mode and, optionally, reasoning effort. |
| **Slash command** | A message starting with `/` that runs an engine command, a custom command or prompt, or a skill. The composer lists what the selected engine offers ([`src/main/commands.ts`](../apps/desktop/src/main/commands.ts)). |
| `/new` | CooPrompt's own command (aliases `/clear`, `/reset`): starts a fresh engine session for the chat on the sender's computer without calling the model. |
| **Custom prompt (Codex)** | A Markdown template in `$CODEX_HOME/prompts`, run as `/prompts:<name>`; CooPrompt fills its placeholders like the Codex CLI. |
| **Skill mention** (`$`) | In Codex chats, `$name` refers to a skill; typing `$` lists them. |
| **Provider label** | The display text of the profile and model that ran a turn. |
| **Runner** | The desktop component that executes the turns assigned to its device ([`runner.ts`](../apps/desktop/src/main/runner/runner.ts)). |
| **Redaction** | Replacing secrets with `«redacted»` in what an executor publishes. See [Secret redaction](security.md#secret-redaction). |
| **Shell environment** | The variables of the user's login shell, which CooPrompt reads at startup and gives to engines (without model credentials). |

## Workspaces and files

| Term | Meaning |
| --- | --- |
| **Shared workspace** | The synced folder of a multiplayer or company chat. |
| **Workspace mirror** | A computer's local copy of a shared workspace, kept in sync by `WorkspaceSync`. |
| **Sync root**, **private root** | The parent folders for workspace mirrors and private chat folders (`~/CooPrompt/Compartidos` and `~/CooPrompt/Privados` by default). |
| **Working folder** | Where the agent runs for a chat: the workspace mirror, or the private chat's folder. |
| **File entry**, `FileEntry` | The server's record of the latest version of one path: content hash (`null` for a deletion), size, executable bit and sequence number. |
| **Blob** | File content stored on the server under its SHA-256 hash. |
| **Change feed** | The workspace's entries in sequence order, fetched with `since=<sequence>`. |
| **Base** | The hash of the version a client last saw, sent with uploads and deletions. A stale base means a conflict. |
| **Conflict copy** | The second version kept when two people change a file concurrently: `<name> (conflict <device> <date time>)<extension>`. |
| `.coopromptignore` | Optional root file with sync-only ignore rules, in `.gitignore` syntax. |

## Connectors

| Term | Meaning |
| --- | --- |
| **Connector** | An MCP server configured in CooPrompt, given to every engine. See [Connectors](connectors.md). |
| **Transport** | How CooPrompt reaches a connector: `stdio` (a local command), `http` (streamable HTTP) or `sse`. |
| **Detected connector**, **source** | An MCP server defined by another app (Claude Code, Codex, Cursor, Claude Desktop) or a project, which can be imported. |
| **Native connector** | A server that an engine already loads from its own configuration; CooPrompt doesn't pass a duplicate of it. |
| **Identity** | What makes two definitions the same server: the same URL (ignoring case and trailing slashes) or the same command line. |
| **Catalog (connectors)** | The list of official remote MCP servers in [`connector-directory.ts`](../apps/desktop/src/shared/connector-directory.ts). Not to be confused with the agent catalog below. |

## Desktop app internals

| Term | Meaning |
| --- | --- |
| **Main process**, **renderer** | Electron's Node side (the app core) and the sandboxed UI. |
| `AppCore` | The main-process object that owns every service and implements the IPC methods ([`core.ts`](../apps/desktop/src/main/core.ts)). |
| `CooPromptApi` | The table of IPC methods the renderer can call, in [`src/shared/types.ts`](../apps/desktop/src/shared/types.ts). |
| `MainEvent` | A push from the main process to the renderer: app state, a forwarded server message, sync status, engine information or a toast. |
| **Secret store**, `Secrets` | The encrypted key-value store protected by Keychain on macOS and DPAPI on Windows ([`secrets.ts`](../apps/desktop/src/main/secrets.ts)). |
| **Agent catalog** | The skills, subagents, command files and memory files (`AGENTS.md`, `CLAUDE.md`) CooPrompt lists and edits ([`catalog.ts`](../apps/desktop/src/main/catalog.ts)). |
| **Brand icon** | The logo shown for an MCP tool whose server or name points to a known service (GitHub, Notion, Slack, Jira…), from Simple Icons ([`lib/brand-icons.ts`](../apps/desktop/src/renderer/src/lib/brand-icons.ts)). Unknown services get a plug icon. |
| **Profile instance**, `COOPROMPT_PROFILE` | An isolated CooPrompt instance with its own data, device id and folders, for development and testing. |

## Distribution

| Term | Meaning |
| --- | --- |
| **One-line installer** | `curl -fsSL <server>/install \| bash`: a script served by the team server that installs CooPrompt already pointed at it. |
| **Ad-hoc signing** | Code signing without any certificate (identity `-`). The app runs on Apple silicon, but the signature identifies only that exact build. `npm run dist` falls back to it when there is no signing identity. |
| **Signing identity** | The self-signed code-signing certificate and key, kept in `~/.cooprompt-signing`, that `npm run dist` signs releases with. Installed copies accept updates only from it. See [Distribution](distribution.md#the-signing-identity). |
| **Designated requirement** | The rule a signed app carries that says which future builds count as the same app (for CooPrompt: its bundle identifier and the signing identity's certificate). The updater checks downloads against the running app's. |
| **Quarantine** | The flag macOS adds to files downloaded by browsers, which makes Gatekeeper check (and block) unnotarized apps. `curl` doesn't add it. |
| **Release folder**, `latest-mac.json` | `apps/desktop/release`, where `npm run dist` publishes builds; `latest-mac.json` names the newest one and its version. |
| **App release**, `app`, `AppRelease` | The optional field of `GET /api/health` that announces the build a server offers: version, SHA-256 and size. |
| **Builds to offer**, `releaseDir` | The host setting that points to a release folder, so an embedded server offers its newest build instead of a zip of the running app. |
| **Update helper** | `update-helper.sh`, shipped inside the app: it swaps in the new app after CooPrompt quits, and puts the previous one back if the new version doesn't confirm its launch within two minutes (a **rollback**). |
| `server.restarting` | The WebSocket message a host sends before restarting to update, so connected apps show why they are offline and reconnect quickly. |
| `COOPROMPT_UPDATES` | Overrides whether updates run: `1` turns them on (they are off in development builds and profiles), `0` turns them off, `auto` installs them unattended. |
