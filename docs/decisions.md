# Design decisions

The key decisions behind CooPrompt, each with its context, the decision and its consequences, and the code that implements it. Read this before changing one of these areas; if you change a decision, update its entry.

## 1. Turns run on the requester's computer with their own credentials

**Context.** A coding agent needs the repository, the person's tools (git, gh, cloud CLIs) and a model account. Teammates use different providers and subscriptions, and running agents centrally would require a server holding everyone's keys and access.

**Decision.** The server only queues a turn and assigns it to one of the requester's online devices, chosen when sending. That device runs the engine with its local profile, credentials and connectors, and streams the output back for everyone.

**Consequences.** Nobody shares keys, and every agent acts with the identity and permissions of the person who asked. The executing computer must stay connected for the turn: the server tolerates 30 seconds of disconnection and the app buffers its output while offline, but a turn whose device is gone fails. Approvals default to the executor, since actions run on their computer. Files are the executor's, so shared chats depend on workspace sync to give every executor the same folder.

**Where.** [`routes.ts`](../apps/server/src/routes.ts) (`POST /api/chats/:id/messages`), [`hub.ts`](../apps/server/src/hub.ts) (`scheduleChat`), [`runner.ts`](../apps/desktop/src/main/runner/runner.ts).

## 2. The server never sees model credentials

**Context.** A server shared by a team, possibly exposed to the internet, should not become a credential vault.

**Decision.** A turn request carries only non-secret options (`TurnConfig`: engine, profile id, model, permission mode, reasoning effort). API keys, connector secrets and OAuth tokens live in each computer's encrypted secret store, protected by Keychain on macOS or DPAPI on Windows, and are resolved by the executor. The server stores password hashes and session token hashes, never the secrets themselves.

**Consequences.** A compromised server doesn't leak model keys. Each person sets up their own profiles; since profile ids differ between computers, an executor that doesn't have the requested profile uses its default profile for the same engine. The server still stores chats and shared files in plain form (see [Security](security.md#what-the-team-server-stores)).

**Where.** [`TurnConfig`](../packages/protocol/src/index.ts), [`secrets.ts`](../apps/desktop/src/main/secrets.ts), [`runner.ts`](../apps/desktop/src/main/runner/runner.ts) (`profileFor`), [`auth.ts`](../apps/server/src/auth.ts).

## 3. One running turn per chat, queued on the server

**Context.** A chat shares one conversation and, for multiplayer and company chats, one folder. Several agents editing the same workspace at once would conflict and confuse each other's context.

**Decision.** The server keeps a queue per chat and starts the next queued turn when the chat is idle: by priority (interrupting messages, see decision 15), then oldest first. Before running, the executor applies pending workspace changes; after running, it uploads its changes before reporting the turn finished. A sender can opt out for their own messages with multitask (decision 24).

**Consequences.** Turns see a consistent conversation and folder, and the queue is visible to everyone. People wait for each other, and a long turn occupies the chat until it ends, is cancelled or is interrupted, unless messages are sent in multitask mode.

**Where.** [`store.ts`](../apps/server/src/store.ts) (`queuedTurns`), [`hub.ts`](../apps/server/src/hub.ts) (`scheduleChat`, `cancelTurn`), [`runner.ts`](../apps/desktop/src/main/runner/runner.ts).

## 4. Context handoff from the transcript, not shared engine sessions

**Context.** Engines keep their sessions on the local disk in their own formats, and participants may use different engines and providers. A session cannot follow the conversation from one computer to another.

**Decision.** Each computer resumes its own engine session per chat when the engine, profile and folder are unchanged. Before each turn it gives the engine a plain-text summary of what others did since its previous turn, built from the transcript and capped at 60,000 characters; a computer without a session receives the whole (trimmed) history.

**Consequences.** Conversations continue across computers, engines and providers without any model state on the server. The summary is lossy: tool calls are summarized and their output truncated, and very long histories are trimmed. Switching engine, profile or folder starts a new session.

**Where.** [`runner.ts`](../apps/desktop/src/main/runner/runner.ts) (`execute`), [`context.ts`](../apps/desktop/src/main/runner/context.ts). Details: [Architecture](architecture.md#context-handoff-between-participants).

## 5. Content-addressed workspace sync with conflict copies

**Context.** Members need the same files on every computer, including repositories one person cloned and edits made by agents, often concurrently and sometimes while offline. Secrets and dependencies must stay on each computer.

**Decision.** The server keeps the latest version of each path with a per-chat change sequence and stores contents as blobs named by their SHA-256 hash. Uploads and deletions carry the hash of the version the client last saw and are rejected when it is stale. On a conflict both versions are kept, the local one under a conflict name. Ignore rules follow `.gitignore`, plus `.coopromptignore` and a fixed list. The client pauses when its folder disappears and restores, instead of deleting for everyone, when most of it vanished while closed.

**Consequences.** There is no merge logic and no edit is lost silently. `.env` files and `node_modules` stay local, while git repositories sync including `.git`. Conflict copies must be resolved by hand. Files over 200 MB are not synced. Server storage only grows, since replaced versions and deleted chats are kept.

**Where.** [`files.ts`](../apps/server/src/files.ts), [`workspace-sync.ts`](../apps/desktop/src/main/sync/workspace-sync.ts), [`ignore-rules.ts`](../apps/desktop/src/main/sync/ignore-rules.ts).

## 6. Connectors for every engine, without duplicates

**Context.** People already configure MCP servers in Claude Code, Codex, Cursor and Claude Desktop, and each engine loads its own configuration natively. Passing everything to every engine would duplicate tools; passing nothing would leave each engine without the others' servers.

**Decision.** CooPrompt keeps its own connector list; importing copies a definition and moves its secrets into the secret store. When a turn starts, the engine receives the enabled connectors it doesn't already load natively, matched by identity (the same URL or command line). When CooPrompt holds OAuth credentials for a server the engine also loads, CooPrompt's copy replaces the engine's under the engine's name.

**Consequences.** Every engine gets the same tools without duplicates, and OAuth sign-in happens once in CooPrompt. Imports don't follow later changes in the source app, and connectors are per computer.

**Where.** [`connector-sources.ts`](../apps/desktop/src/main/connector-sources.ts) (`planServers`), [`connectors.ts`](../apps/desktop/src/main/connectors.ts). Details: [Connectors](connectors.md#what-each-engine-receives).

## 7. English source strings, translated on the client

**Context.** People in the same chat may use different interface languages. Server errors and chat notices are produced once for everyone, and engines report errors in English.

**Decision.** English is the source language everywhere. The server, the engines and the runner emit English. Clients translate interface strings by key (`ES`) and translate filled messages at display time by matching `{placeholder}` templates (`ES_MESSAGES`).

**Consequences.** The server stays language-agnostic and each person sees their own language. Every new string needs a Spanish entry, and generated messages must match their templates exactly, or they appear in English. Agent replies aren't translated; the system prompt asks the agent to answer each person in the language they write in.

**Where.** [`shared/i18n.ts`](../apps/desktop/src/shared/i18n.ts), [`shared/i18n-es.ts`](../apps/desktop/src/shared/i18n-es.ts), [`runner/context.ts`](../apps/desktop/src/main/runner/context.ts). Rules: [Internationalization](development.md#internationalization).

## 8. Ad-hoc signing and a curl installer instead of notarization

**Context.** Without an Apple Developer ID, the app can't be notarized, and macOS blocks unnotarized apps downloaded with a browser. CooPrompt's users are teammates of whoever hosts the server.

**Decision.** Builds are signed ad hoc for Apple silicon. The team server serves a bash installer that downloads the app with `curl` (which doesn't set the quarantine flag), installs it, and points it at the server in the inviter's language. Packaging happens in a temporary folder with extended attributes stripped, because `codesign` rejects bundles carrying Finder metadata.

**Consequences.** Teammates on supported macOS computers can install with one command, already connected to the right server. Trust rests on the server and on the connection used to reach it. Manual downloads need **Open Anyway** and every build triggers one Keychain access prompt. The Windows installer is separate and experimental.

**Where.** [`electron-builder.yml`](../apps/desktop/electron-builder.yml), [`installer.ts`](../apps/server/src/installer.ts), [`dist.mjs`](../apps/desktop/scripts/dist.mjs), [`after-pack.cjs`](../apps/desktop/scripts/after-pack.cjs). Details: [Distribution](distribution.md).

## 9. The server embeds in the app, with quick tunnels for remote teammates

**Context.** Small teams need a way to try CooPrompt without setting up separate infrastructure.

**Decision.** The server is a library (`createCooPromptServer`) that the app embeds. "Host on this computer" listens on the local network and starts again with the app. On macOS it can serve a zip of the running app and open a Cloudflare quick tunnel that needs no account. A Windows host can serve a separately configured macOS build, but public tunnels and automatic Windows updates are not yet available. The same server code runs standalone through `cli.ts`.

**Consequences.** A team can start with one click, and moving to a standalone server keeps the data. The embedded server is only available while the host's CooPrompt is open and the computer is awake. Tunnel addresses can change when a tunnel is closed or replaced, and local network traffic is plain HTTP.

**Where.** [`host.ts`](../apps/desktop/src/main/host.ts), [`server.ts`](../apps/server/src/server.ts), [`cli.ts`](../apps/server/src/cli.ts). Playbooks: [Deployment](deployment.md).

## 10. A single-process server on `node:sqlite`

**Context.** Small teams need simple operations, and the server must also run inside the desktop app.

**Decision.** The server uses Node's built-in SQLite (WAL mode, synchronous queries) in one process. Live state (connections, presence, streaming drafts, timers) lives in memory in the hub. The schema is created and migrated additively at startup.

**Consequences.** There is no external database or service, backups are files, and the server embeds easily. One server is one process: it can't be scaled horizontally, and restarting it fails the turns in progress. Running it standalone requires Node 24.

**Where.** [`db.ts`](../apps/server/src/db.ts), [`store.ts`](../apps/server/src/store.ts), [`hub.ts`](../apps/server/src/hub.ts).

## 11. Organizations from email domains, with an optional access code

**Context.** Company-wide chats should work without administration, and a server may be reachable by anyone who knows its address.

**Decision.** A user's organization is their email domain, unless it belongs to a public mail provider. A single server-wide access code can be required for email/password sign-up: the standalone server generates and keeps one by default; the embedded server makes it optional and applies changes without restarting. Google sign-in can be restricted to domains, and the standalone server can disable password sign-up.

**Consequences.** Organizations need no setup, and the code is a lightweight gate. Email addresses of password accounts aren't verified, so organization membership is only as strong as the access code or the Google domain restriction. The code is shared, not personal.

**Where.** [`orgDomainFromEmail`](../packages/protocol/src/index.ts), [`routes.ts`](../apps/server/src/routes.ts) (`/api/auth/register`), [`cli.ts`](../apps/server/src/cli.ts), [`host.ts`](../apps/desktop/src/main/host.ts). Details: [Security](security.md#consequences-of-unverified-emails).

## 12. Redact before publishing

**Context.** Agents read files and environment variables and may print secrets into a chat that other people read and the server stores.

**Decision.** The executor replaces the values in its secret store and common credential formats with `«redacted»` in everything it publishes (items, streamed text and the error a turn ends with). It is on by default and can be turned off in Settings → Folders & privacy.

**Consequences.** Accidental leaks are less likely, at the cost of occasionally masking harmless strings that look like tokens. It is best effort and doesn't cover typed messages or synced files, which rely on the ignore rules.

**Where.** [`redact.ts`](../apps/desktop/src/main/runner/redact.ts), [`publisher.ts`](../apps/desktop/src/main/runner/publisher.ts).

## 13. A sandboxed renderer behind one typed IPC channel

**Context.** The UI renders content written by agents and other people (Markdown, tool output). A compromised renderer must not reach Node or the user's files.

**Decision.** The renderer runs sandboxed with context isolation, no Node integration and a Content-Security-Policy. It calls the main process through a single IPC channel that dispatches a fixed, typed method table (`CooPromptApi`). Navigation away from the app is blocked and links open in the browser.

**Consequences.** The privileged surface is small and easy to review. Every UI capability needs a main-process method.

**Where.** [`index.ts`](../apps/desktop/src/main/index.ts), [`preload/index.ts`](../apps/desktop/src/preload/index.ts), [`shared/types.ts`](../apps/desktop/src/shared/types.ts), [`renderer/index.html`](../apps/desktop/src/renderer/index.html).

## 14. Agents get the login shell environment, minus model credentials

**Context.** Apps launched from the Finder start with a minimal `PATH` and none of the user's shell configuration, but agents need the user's toolchain and credentials. Ambient model keys could silently override the chosen profile.

**Decision.** CooPrompt reads the login shell environment once at startup and gives it to the engines, after removing model credential and endpoint variables.

**Consequences.** Agents behave as they would in the user's terminal, and the selected profile alone determines the model account. Changes to the shell configuration need a CooPrompt restart; if the shell takes too long or fails, CooPrompt falls back to the default `PATH`.

**Where.** [`shell-env.ts`](../apps/desktop/src/main/shell-env.ts), `baseEngineEnv` in [`providers.ts`](../apps/desktop/src/main/engines/providers.ts).

## 15. Interrupting is a cancel plus a priority turn

**Context.** People need to redirect an agent in the middle of a turn. Driven headless, the engines can't reliably take new input into a turn that is already running, and waiting in the queue would delay the correction.

**Decision.** An interrupting message is a normal turn with a higher priority; creating it cancels a running turn under the same rule as cancelling (the turn's requester or the chat owner): the one it names or, from apps that don't name one, the sender's latest. The new turn starts once that turn has ended. The executor stops the engine gracefully (Claude through the SDK's interrupt, so Claude Code records the stop; Codex, and Cursor through ACP's `session/cancel`, with a note at the start of the next turn) and keeps the engine session, so the new turn resumes it. The request and response fields are optional, and a newer app falls back to queueing and cancelling when the server predates them.

**Consequences.** The correction runs next with the work done so far in context, and older apps and servers keep working. The message can't be added to the running turn: that turn stops, and whatever it was doing (a running command, for example) is cut. Other queued messages keep their order behind the new one.

**Where.** [`routes.ts`](../apps/server/src/routes.ts) (`POST /api/chats/:id/messages`), [`hub.ts`](../apps/server/src/hub.ts) (`cancelTurn`), [`store.ts`](../apps/server/src/store.ts) (`priority`), [`engines/claude.ts`](../apps/desktop/src/main/engines/claude.ts), [`runner.ts`](../apps/desktop/src/main/runner/runner.ts), [`core.ts`](../apps/desktop/src/main/core.ts) (`chats.send`). Details: [Architecture](architecture.md#interrupting-a-turn).

## 16. Commands come from the engines; CooPrompt owns sessions, model and effort

**Context.** Each engine has its own slash commands, but some don't work when the engine is driven headless (Codex's commands belong to its terminal interface, and neither engine reliably starts a new session), while the model and the effort are already chosen in CooPrompt's composer for every turn.

**Decision.** For Claude, CooPrompt lists the commands Claude Code itself reports, asked without a model call, and hides `/model`, `/effort`, terminal-only commands and session resets. For Codex, CooPrompt offers its own equivalents: `/review` and `/init` sent as prompts, custom prompts from `$CODEX_HOME/prompts`, and `$` skill mentions. For Cursor, whose terminal commands don't exist headless, CooPrompt lists the custom commands and skills Cursor runs when a prompt starts with `/name`. `/new` (with `/clear` and `/reset`) belongs to CooPrompt in every engine and resets the session on the sender's computer without calling the model.

**Consequences.** The palette only offers commands that work, with the engine's own descriptions, and stays current with Claude Code. In Codex chats there is no `/compact` or `/model`, and skills that come from Codex plugins aren't listed, although Codex still uses them. Cursor chats have none of the Cursor terminal's built-in commands. Resetting a session affects only the sender's computer.

**Where.** [`src/main/commands.ts`](../apps/desktop/src/main/commands.ts) (`cursorCommands` among them), [`src/shared/commands.ts`](../apps/desktop/src/shared/commands.ts), `probeClaude` in [`engines/claude.ts`](../apps/desktop/src/main/engines/claude.ts), [`runner.ts`](../apps/desktop/src/main/runner/runner.ts). Details: [Architecture](architecture.md#slash-commands).

## 17. Codex waits briefly for MCP servers and gets connector tools pre-approved

**Context.** Codex starts a turn without waiting for its MCP servers and silently leaves out any that are slow to start, which a server started with `npx` often is. Marking servers `required` makes Codex wait, but then any one that can't start (an expired sign-in, a server that is down, a Node.js that is too old) fails every Codex turn. CooPrompt also runs Codex with approval prompts off: it drives Codex through `codex exec`, which gives it no way to answer them, and Codex then refuses every MCP tool call that needs an approval. Codex keeps those approvals in a different place for each origin of its tools: its `config.toml` servers, its plugins' servers and the apps of its ChatGPT account.

**Decision.** CooPrompt sets Codex's optional startup grace to 20 seconds and marks no server `required`: the first model call waits for servers that are still starting, while those that fail or need sign-in are left out at once. The permission mode sets the tool approvals of every origin, through configuration overrides merged into the user's own settings for that turn: CooPrompt's connectors, the servers of the user's `config.toml` and enabled plugins, and every ChatGPT app (`apps._default`). Outside Plan mode tools are approved up front, keeping what the user set for single tools; in Plan mode only tools marked read-only run, including where the user approved more for good.

**Consequences.** Codex agents get the connectors that can start, including slow ones, and a broken connector never blocks a turn. A server that hangs delays the start of every Codex turn by up to 20 seconds. Codex doesn't say which servers it left out, so **Test** is where a connector's problem shows. Outside Plan mode, a Codex agent uses MCP tools of any origin without asking, including ones that change things such as posting in Slack (see [Security](security.md#agents-act-as-the-person-who-runs-the-turn)), while Claude and Cursor still ask according to the permission mode. A new place where Codex keeps approvals needs a matching override, or its write tools fail again with "approval policy is never".

**Where.** `mcpOverrides` in [`engines/codex.ts`](../apps/desktop/src/main/engines/codex.ts) and `codexApprovalScopes` in [`connector-sources.ts`](../apps/desktop/src/main/connector-sources.ts), covered by [`codex-config.test.ts`](../apps/desktop/test/codex-config.test.ts) and [`connector-sources.test.ts`](../apps/desktop/test/connector-sources.test.ts). Details: [Connectors](connectors.md#codex-and-connector-tool-approvals).

## 18. A custom updater served by the team server

**Context.** Teammates already install CooPrompt from the team server, and re-running the installer for every build doesn't scale. Electron's updater on macOS (Squirrel.Mac, which electron-updater also relies on) expects a code-signed app and an update feed in its own format, typically published by a release service, while CooPrompt had no stable signature and its builds come from whichever team server each person uses.

**Decision.** The server announces the build it serves in `GET /api/health` (version, plus the SHA-256 and size it computes on that exact file). Installed apps check it, download the zip from the same server, verify it, and hand it to a small shell helper shipped inside the app, which swaps the bundle after the app quits and puts the previous one back if the new version doesn't confirm its launch within two minutes. A host defers its restart while turns are running and tells connected apps it is restarting.

**Consequences.** Updates need no infrastructure beyond the team server, and each app follows the server it uses. CooPrompt owns this code, covered by `updater.test.ts`, `update-helper.test.ts` and the installer tests. Version 0.1.0 predates the updater, so its users reinstall once. Development builds and profiles don't update, so they never replace an installed app.

**Where.** [`installer.ts`](../apps/server/src/installer.ts) (`releaseDescriber`, `latestRelease`), [`updater.ts`](../apps/desktop/src/main/updater.ts), [`update-helper.sh`](../apps/desktop/resources/update-helper.sh), `installUpdate` in [`core.ts`](../apps/desktop/src/main/core.ts). Details: [Architecture](architecture.md#updates).

## 19. A self-signed signing identity for releases

**Context.** Decision 8 signs builds ad hoc. An ad-hoc signature is different for every build, so an update can only be checked against the bundle identifier, which any build can claim. Without an Apple Developer ID there is no publisher certificate to require.

**Decision.** Whoever publishes releases creates, once, a self-signed code-signing certificate in `~/.cooprompt-signing`; `npm run dist` signs every build with it through a throwaway keychain, and falls back to ad hoc without it. The updater accepts a build only if it satisfies the running app's designated requirement, which names that certificate.

**Consequences.** Installed copies accept updates only from the identity's holder, even through a compromised server or connection. The identity is a secret to back up and protect: losing it means every teammate reinstalls once, and leaking it lets someone else publish accepted updates. Gatekeeper still doesn't trust the certificate, so nothing changes for first installs, and copies signed ad hoc keep accepting any build with CooPrompt's identifier until they update to a signed one.

**Where.** [`scripts/sign.cjs`](../apps/desktop/scripts/sign.cjs), [`scripts/signing-identity.mjs`](../apps/desktop/scripts/signing-identity.mjs), `verifyBundle` in [`updater.ts`](../apps/desktop/src/main/updater.ts). Details: [Distribution](distribution.md#the-signing-identity).

## 20. A Keychain prompt after each update is accepted

**Context.** CooPrompt's secrets are encrypted with a key in the "CooPrompt Safe Storage" Keychain item. Without an Apple-issued certificate, macOS treats every new build as a different app and asks before letting it read that item.

**Decision.** Accept one password prompt after each update instead of moving secrets out of the Keychain. The update banner warns about it before the restart and asks people to choose **Always Allow**, and the new version confirms its launch before the prompt appears, so a slow answer never triggers a rollback.

**Consequences.** People type their Mac password once per update. Denying it leaves the stored session and keys unreadable until CooPrompt is reopened and access is allowed. Secrets stay protected by the Keychain.

**Where.** `UpdateBanner.tsx` ([`src/renderer/src/components/UpdateBanner.tsx`](../apps/desktop/src/renderer/src/components/UpdateBanner.tsx)), `confirmLaunch` in [`updater.ts`](../apps/desktop/src/main/updater.ts), called first thing in [`index.ts`](../apps/desktop/src/main/index.ts).

## 21. The quick tunnel outlives the app

**Context.** Decision 9's quick tunnel got a new address every time the host's CooPrompt restarted, which disconnected every remote teammate, and automatic updates make such restarts routine.

**Decision.** The host starts `cloudflared` detached, with a local metrics endpoint, and records it. Quitting CooPrompt leaves it running; the next launch takes it over if it still serves the same port and is connected (decision 28), and **Close tunnel** or **Stop** ends it for good. Apps can also switch to a new address of the same server without signing out.

**Consequences.** The tunnel's address survives restarts and updates of the host's CooPrompt. It still changes after the computer restarts or when the tunnel has to be replaced (decision 28), and then teammates enter the new address in Settings → Account & device. A `cloudflared` process can keep running after CooPrompt quits; the next launch reuses it, or closes it when the server doesn't start.

**Where.** `adopt` in [`tunnel.ts`](../apps/desktop/src/main/tunnel.ts), `auth.changeServer` in [`core.ts`](../apps/desktop/src/main/core.ts).

## 22. The embedded server can turn off passwords

**Context.** Decision 11 let only the standalone server disable password accounts, whose email addresses are never verified, so a team hosted in someone's CooPrompt always accepted them. Changing the embedded server's Google settings also needed a restart (**Stop**, then **Host on this computer**), and stopping closes the quick tunnel.

**Decision.** Settings → Team server offers **Google accounts only**, which turns off email/password sign-up and sign-in. It takes effect only while Google sign-in is configured, so a host can't leave a server nobody can sign in to. The Google settings and this option apply to the running server (`setAuth`, next to `setAccessCode`); only the server name and port still need a restart.

**Consequences.** A team hosted on a computer can accept only Google accounts of its own domain, as a standalone server can with `COOPROMPT_PASSWORD_AUTH=false`, and setting up Google no longer disconnects anyone. The access code becomes irrelevant. People with a password account move to Google by signing in with the same email, which works when Google vouches for the address (decision 23).

**Where.** `auth()` and `applyAuth()` in [`host.ts`](../apps/desktop/src/main/host.ts), `setAuth` in [`server.ts`](../apps/server/src/server.ts), [`ServerSection.tsx`](../apps/desktop/src/renderer/src/components/settings/ServerSection.tsx). Details: [Team server](server.md#embedded-in-cooprompt-host-on-this-computer).

## 23. The owner Google confirms wins the account

**Context.** Password accounts never prove their email address. Linking a Google sign-in to the existing account with the same email used to keep that account's password and sessions, so whoever had registered someone else's address kept access after the real owner arrived. And Google confirms the address of a personal Google account created with a non-Gmail address only once, when the account is created, so such an account proves little about the address today.

**Decision.** A Google sign-in may take over the account with the same email only when Google vouches for the address now: the account belongs to a Google Workspace (`hd`), or the address is a Gmail one. Then the Google account is linked, the password removed, every session deleted and every open connection closed. When Google can't vouch, the server refuses with 409 and the person signs in with their password. Allowed domains trust only `hd`, never the address alone.

**Consequences.** The real owner of an address can always reclaim the account with Google, and anyone who registered it with a password loses access at that moment; the owner inherits what that person did in it. Someone who legitimately had a password account and signs in with Google once moves to Google for good, and their other computers sign in again. A personal Google account can't take over an existing account. Workspace administrators, who control the `hd` accounts, are trusted for their domains.

**Where.** `/api/auth/google` in [`routes.ts`](../apps/server/src/routes.ts), `exchangeGoogleCode` (`ownsEmail`) in [`auth.ts`](../apps/server/src/auth.ts), `deleteSessionsOf` in [`store.ts`](../apps/server/src/store.ts), `disconnectUser` in [`hub.ts`](../apps/server/src/hub.ts); covered by [`google-auth.test.ts`](../apps/server/test/google-auth.test.ts). Details: [Security](security.md#accounts-and-sessions).

## 24. Multitask: parallel turns, chosen by each sender

**Context.** One running turn per chat (decision 3) makes people wait for each other. People want to keep sending while the agent works and have each request handled. A chat shares one conversation and one folder, and an engine session takes one turn at a time.

**Decision.** A message can be sent in multitask mode (`parallel`), switched on in the composer and remembered per chat on the sender's computer, off by default. Such a turn starts right away while fewer than three run in the chat. It is the sender's choice, not the chat's: messages sent without it, including every message from an older app, still wait until nothing runs, and no message skips the line, so a multitask message sent after one that is waiting waits behind it. The server only keeps the flag for devices that announce `parallel-turns`. On a computer, a turn that starts while the chat's main engine session is busy forks it at a checkpoint the engine returned at the end of its last turn, or starts a new session with the whole history when the engine can't fork; catch-up records what each session has seen and defers turns still running, so their work reaches later turns once and whole. Agents are told which turns run beside them, and the composer warns that turns running together share the folder.

**Consequences.** Someone who turns multitask on no longer waits behind long turns, and never makes others wait longer than they would have. Turns running together can change the same files: across computers the sync keeps both versions as conflict copies, but on one computer the last write wins, and an agent can see files change under it. A side session is set aside when its turn ends, so later turns get its work as transcript context, which loses detail compared to a session of their own. A teammate on an older app keeps waiting until they update and turn multitask on. The limit is a server setting (`COOPROMPT_MAX_PARALLEL_TURNS`, 3 by default and in the embedded server).

**Where.** `scheduleChat` and `runsParallelTurns` in [`hub.ts`](../apps/server/src/hub.ts), `POST /api/chats/:id/messages` in [`routes.ts`](../apps/server/src/routes.ts), `planSession` and `catchUp` in [`runner.ts`](../apps/desktop/src/main/runner/runner.ts), `forkAt` and `checkpoint` in [`engines/types.ts`](../apps/desktop/src/main/engines/types.ts) and [`engines/claude.ts`](../apps/desktop/src/main/engines/claude.ts), [`Composer.tsx`](../apps/desktop/src/renderer/src/components/Composer.tsx); covered by `multitask.test.ts` in the server and desktop tests. Details: [Multiplayer](multiplayer.md#multitask), [Architecture](architecture.md#session-continuity).

## 26. Attachments live in their own store, and engines get copies in the working folder

**Context.** People need to send screenshots, PDFs, recordings and other files with a message, and agents produce screenshots and media that everyone should see. Private chats have no workspace on the server; putting files in a shared workspace would push every one of them to every member's computer, and into a repository cloned there; inlining their bytes in transcript items would bloat the transcript and every catch-up, and items are limited to 512 KB. Each turn runs with the engine of whoever sends it, and not every engine or provider takes images or PDFs.

**Decision.** The team server keeps a members-only attachment store: one content-addressed blob per file and one record per upload, with the type taken from the file's bytes. Transcript items carry references (`AttachmentRef`); prompts also keep a text line per file for older apps. A computer downloads a file when it shows it or its agent needs it, and the renderer only gets media through a custom scheme the main process serves. Engines receive copies inside the working folder (`.cooprompt/attachments`, which neither the sync nor git picks up) with their paths in the prompt, and, through the adapter contract, the images and PDFs their provider takes natively. Agents share media through the same store, by path or from tool results, and the server keeps only references to that chat's own attachments.

**Consequences.** Attachments work the same in private and shared chats, reach a computer only when needed, keep the transcript small, and older apps see the files' names. Every engine can open every file, including ones it can't take natively, and compatible providers, which may run text-only models, get paths only. Files are limited to 50 MB (a Cloudflare tunnel accepts 100 MB a request), are stored unencrypted on the server like the transcript, and are deleted with their chat. Other participants' agents get copies of the 20 most recent files only. Redaction can't reach inside an image, so a screenshot shows whatever it shows.

**Where.** [`attachments.ts`](../apps/server/src/attachments.ts) (server), `sniffMedia`, `attachmentFallback` and `promptText` in [`protocol`](../packages/protocol/src/index.ts), [`attachments.ts`](../apps/desktop/src/main/attachments.ts) (desktop), [`runner/attachments.ts`](../apps/desktop/src/main/runner/attachments.ts), `EngineAttachment`, `nativeMedia` and `EngineSink.attach` in [`engines/types.ts`](../apps/desktop/src/main/engines/types.ts), [`Attachments.tsx`](../apps/desktop/src/renderer/src/components/Attachments.tsx), [`ComposerAttachments.tsx`](../apps/desktop/src/renderer/src/components/ComposerAttachments.tsx); covered by `attachments.test.ts` in the server and desktop tests, `engine-media.test.ts`, `runner-attachments.test.ts` and `attachment-context.test.ts`. Details: [Architecture](architecture.md#attachments), [Security](security.md#attachments).

## 27. Cursor runs through its CLI's ACP server, on the computer's own Cursor sign-in

**Context.** People wanted Cursor's agent next to Claude Code and Codex, on the Cursor plan they already have. Cursor offers an SDK (`@cursor/sdk`) that authenticates with an API key, or with one it mints at sign-in and keeps in a file in `~/.cursor`, and a CLI (`cursor-agent`) that manages its own sign-in through `cursor-agent login`. The CLI runs headless in two ways: printing a JSON event stream (`-p --output-format stream-json`), which can't ask for approvals or take a cancel, or as an Agent Client Protocol server (`cursor-agent acp`). Each computer must use only its own credentials, and CooPrompt must not handle Cursor's.

**Decision.** For each Cursor turn CooPrompt starts the user's own `cursor-agent acp` in the chat's folder and speaks ACP to it (JSON-RPC over stdio): `session/new`, or `session/load` to resume (ignoring the history it replays), with CooPrompt's connectors as session MCP servers; the composer's model and reasoning level as session options; Cursor's `agent` or `plan` mode; then `session/prompt`, whose updates become transcript items, whose permission requests and questions become cards, and which `session/cancel` interrupts. The CLI isn't bundled and keeps its own sign-in: CooPrompt never calls ACP's `authenticate`, which would open a browser in the middle of a turn, never reads Cursor's credentials or configuration files, and never picks Cursor's "Allow always", which would write the rule into `~/.cursor/cli-config.json` (CooPrompt's own "Always allow" applies instead). The account box asks the CLI who is signed in and on which plan (`cursor-agent status` and `about`), and its button runs `cursor-agent login`.

**Consequences.** Cursor turns run on each person's Cursor plan with no key in CooPrompt, with streamed text and reasoning, tools, approvals, questions, plans and to-do lists, clean interrupts, resumed sessions and per-turn connectors that are never written to disk. Because Cursor applies edits inside the working folder without asking and its ACP server has no classifier mode, the composer offers Cursor only "Accept edits", "Plan only" and "No restrictions" (Run Everything, `--force`). Cursor's ACP server would approve the agent's own request to leave plan mode, so in "Plan only" CooPrompt refuses whatever Cursor asks to do that could change something and stops the turn, ending the CLI, if the agent switches modes or starts editing. ACP reports no token usage or context, so Cursor turns show no context ring, and Cursor's ACP server can't fork a session, so a multitask turn that starts while another Cursor turn holds the chat's session gets a new one (decision 24). Choosing a model or a reasoning level also makes it the CLI's default, as `/model` does in its terminal. A team server older than this refuses Cursor turns ("Invalid engine"), which the app explains; apps older than this show Cursor turns with Claude's avatar and the profile's name. The protocol is ACP with Cursor's extensions as its CLI implements them, so a CLI update can change details; the stand-in CLI in the tests pins what CooPrompt relies on.

**Where.** [`engines/cursor.ts`](../apps/desktop/src/main/engines/cursor.ts), `cursorEnv` in [`providers.ts`](../apps/desktop/src/main/engines/providers.ts), [`runner.ts`](../apps/desktop/src/main/runner/runner.ts), `cursorCommands` in [`commands.ts`](../apps/desktop/src/main/commands.ts), the modes each engine offers in [`shared/engines.ts`](../apps/desktop/src/shared/engines.ts), `CursorLogin` in [`ModelsSection.tsx`](../apps/desktop/src/renderer/src/components/settings/ModelsSection.tsx); covered by [`cursor-engine.test.ts`](../apps/desktop/test/cursor-engine.test.ts) through [`fake-cursor-agent.mjs`](../apps/desktop/test/fake-cursor-agent.mjs), and through the runner by `multitask.test.ts`. Details: [Architecture](architecture.md#how-a-turn-flows), [Multiplayer](multiplayer.md#permission-modes), [Connectors](connectors.md#what-each-engine-receives).

## 28. The host replaces a quick tunnel that stops working

**Context.** A `cloudflared` process can stay alive and keep retrying after its quick tunnel has stopped resolving, for example when the host computer sleeps. A process check alone cannot establish that teammates can still reach the server.

**Decision.** CooPrompt checks the tunnel every 30 seconds, every 10 while it is unhealthy, and as soon as the computer wakes up: the process must be its own and alive, `cloudflared`'s `/ready` metrics endpoint must report a connection to Cloudflare, and DNS must still know the hostname (asked directly, past the system cache, and only believed once the name has resolved, since some resolvers block trycloudflare.com names). It opens a new tunnel when `cloudflared` dies, when the tunnel stays disconnected for 2 minutes (a wake-up starts that period again, so a tunnel that reconnects keeps its address), or at once when it is disconnected and its hostname is gone. A launch takes over a tunnel left running only if it connects within 20 seconds. One replacement runs at a time, and new tunnels that keep failing wait longer each time, from 10 seconds up to 5 minutes, until one has worked for 10 minutes. A process counts as CooPrompt's, and is signalled, only if its command line has this data folder's log file and the recorded metrics address. Since a new tunnel has a new address, the host gets a notice with a message for the team until they copy or dismiss it, and while the tunnel is open the app holds a power assertion so the computer doesn't sleep on its own.

**Consequences.** Remote access comes back on its own within seconds of `cloudflared` dying and within about two and a half minutes of a silent disconnection, instead of staying broken. The address still changes whenever a tunnel is replaced, so teammates still switch addresses by hand, now prompted by the host's message; a fixed address needs an always-on server with its own hostname (Playbook B in [Deployment](deployment.md)). Waiting out a disconnection costs up to two minutes without access, a deliberate trade against throwing away an address that could come back. Closing a laptop's lid still sleeps the computer, and nothing keeps the tunnel up while it sleeps. Checking costs one `ps`, one local HTTP request and one DNS query every 30 seconds. Other instances' tunnels, and any process CooPrompt didn't start, are never signalled.

**Where.** `QuickTunnel` in [`tunnel.ts`](../apps/desktop/src/main/tunnel.ts), `tunnelChanged`, `keepAwake` and the `powerMonitor` `resume` handler in [`host.ts`](../apps/desktop/src/main/host.ts), [`TunnelNotice.tsx`](../apps/desktop/src/renderer/src/components/TunnelNotice.tsx); covered by [`tunnel.test.ts`](../apps/desktop/test/tunnel.test.ts) with a fake `cloudflared`. Details: [Team server](server.md#embedded-in-cooprompt-host-on-this-computer).

## 29. Automations are scheduled by the team server and run as their owner's turns

**Context.** People wanted recurring agent work that runs on its own (checking CI every morning, summarizing yesterday's commits, keeping an eye on a deploy), as the Codex app's automations do. Every turn runs on the requester's computer with that person's credentials (decision 1), computers sleep and apps quit, teammates' apps update at different times, and nobody can answer an approval prompt during an unattended run.

**Decision.** The team server stores automations and is their only scheduler. At each scheduled time it creates a turn of the owner in the automation's chat, with the instructions as the owner's prompt and a label line, and sends it through the chat's queue (as a multitask turn when the computer can run one) to the one computer the owner chose, only if that computer is connected and announced `automations` in its `hello`. Otherwise the time is recorded as missed, and when the computer connects again the latest missed time runs once if less than half the time to the next run has passed. Runs never overlap, stop at a time limit, and use one of three permission modes, read-only by default; the runner declines approval requests and questions instead of waiting. Only the owner changes, runs or deletes an automation; members of its chat see it. The turn's link to its automation is an optional field, so older apps show runs as messages.

**Consequences.** Credentials never move: a run uses the owner's computer's profile, connectors and tools, like the owner's messages. Missed runs are known even when every app was closed, and the history and the inbox are the same on all of the owner's computers, while members can see what posts in their chat. An automation only runs while its computer is awake and online (with an embedded server, also while the host's computer is), and a long absence produces at most one late run. "Ask before acting" and the classifier mode aren't offered, since nobody would answer. A run in an existing chat makes messages sent without multitask wait, as any turn does, up to its time limit. Scheduling in the app would have worked with older servers, but would have lost missed runs while the app was closed, what members can see and the history across computers.

**Where.** [`automations.ts`](../apps/server/src/automations.ts), [`automation-routes.ts`](../apps/server/src/automation-routes.ts), `onDeviceReady` and `onTurn` in [`hub.ts`](../apps/server/src/hub.ts), [`packages/protocol/src/automations.ts`](../packages/protocol/src/automations.ts), `requestPermission`, `askQuestion` and `execute` in [`runner.ts`](../apps/desktop/src/main/runner/runner.ts), [`main/automations.ts`](../apps/desktop/src/main/automations.ts), [`components/automations/`](../apps/desktop/src/renderer/src/components/automations); covered by `automations.test.ts` in the server and desktop tests. Details: [Automations](automations.md).

## 30. Team-only messages are kept from agents by the server

**Context.** People in a chat need to talk to each other without agents reading the conversation: who takes what, a quick decision, or a detail that should not reach a model provider. Clients can have different capabilities, so relying only on the receiving client to enforce that boundary would expose team messages to agents that do not understand it.

**Decision.** A team-only message is its own kind of transcript item (`team`), created only by its own endpoint, which queues no turn. The server sends its content only to connections that announce `team-messages` and to item requests with `include=team`, which the app's transcript makes and its runner never does; everyone else gets a stand-in that says who wrote and nothing else. Older apps show it as a line of text and leave it out of their agent's context, as they do with every kind they don't know, but nothing depends on that: they never have the content. The composer's switch is remembered per chat, unmistakable (another color, a label, the run controls hidden) and fails closed: with a server that predates team-only messages it can't be turned on, and a chat left on it blocks sending instead of writing to the agent. Its author can share a message with the agents later, which turns it into an ordinary message without a turn.

**Consequences.** Team talk costs no tokens and stays out of every agent's context, whichever engine, session, fork or automation run catches up, and the guarantee doesn't depend on everyone's app being up to date, since older apps never receive the content; their users see that someone wrote, not what, until they update. Team-only messages are not private: everyone who can read the chat reads them, and the server stores them like the rest of the transcript. An agent can't answer about one unless its author shares it. A flag on the ordinary message endpoint was rejected because an older server would ignore it and run the message as a turn, and leaving older apps without anything because they would miss that someone wrote.

**Where.** [`team.ts`](../apps/server/src/team.ts) (`teamStandIns`) and [`team-routes.ts`](../apps/server/src/team-routes.ts), `publishItems` and `sendToMembers` in [`hub.ts`](../apps/server/src/hub.ts), `GET /api/chats/:id/items` in [`routes.ts`](../apps/server/src/routes.ts), `TeamItemData`, `team.message` and `teamMessages` in the [protocol](../packages/protocol/src/index.ts), `sendTeamMessage` in [`main/team.ts`](../apps/desktop/src/main/team.ts), the catch-up request in [`runner.ts`](../apps/desktop/src/main/runner/runner.ts) and `renderCatchUp` in [`context.ts`](../apps/desktop/src/main/runner/context.ts), `composerMode` in [`lib/team.ts`](../apps/desktop/src/renderer/src/lib/team.ts), [`Composer.tsx`](../apps/desktop/src/renderer/src/components/Composer.tsx) and [`Transcript.tsx`](../apps/desktop/src/renderer/src/components/Transcript.tsx); covered by `team-messages.test.ts` in the server and desktop tests. Details: [Multiplayer](multiplayer.md#team-only-messages), [Architecture](architecture.md#team-only-messages).
