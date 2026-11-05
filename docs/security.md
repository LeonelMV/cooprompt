# Security

What CooPrompt keeps where, what the team server can see, and the limits of the current trust model.

## Summary

- Model credentials and connector secrets are stored on the device where they were entered. The team server never receives API keys.
- Every turn runs on the requester's own computer with that person's credentials, tools and permissions, including the runs of their automations.
- The team server stores accounts, the full chat history, the files sent in chats and the shared workspaces' files, unencrypted. Whoever operates it can read them.
- Agent output is filtered for secrets before it is posted to a chat (best effort, on by default).
- Email addresses are not verified for password accounts, and a server reachable from the internet accepts sign-ups from anyone who knows its address unless it requires an access code or accepts only Google accounts.

## Credentials stay on each device

Secrets are kept by [`src/main/secrets.ts`](../apps/desktop/src/main/secrets.ts): each value is encrypted with Electron `safeStorage` and written to `secrets.json` in CooPrompt's user data folder. On macOS the key is protected by Keychain (item "CooPrompt Safe Storage"; development builds use "CooPrompt Dev Safe Storage"). On Windows it is protected by DPAPI for the logged-in Windows user; this does not protect it from other applications running as that user. The installed app's data is under `~/Library/Application Support/CooPrompt` on macOS and `%APPDATA%\CooPrompt` on Windows. Stored there:

- the session token for the team server;
- model profile API keys;
- MCP connector environment variables, headers and OAuth state (tokens, client registration);
- for the embedded server, the Google OAuth client secret and the access code.

Non-secret settings (server URL, device id, profiles without keys, connectors without secrets, chat preferences) are in `settings.json`. API keys and connector secrets are never sent back to the UI process: it only learns whether one is stored or the names of a connector's variables. The Codex, Claude Code and Cursor sign-in profiles use the respective CLI's own sign-in. CooPrompt asks each CLI for account status and never reads those credentials itself; account details appear only in the local settings.

The repository's `.gitignore` excludes local environment files (except `.env.example`), common credential files, private-key and signing files, and the default CooPrompt data and attachment directories. These rules reduce accidental commits; they do not detect secrets written into other files or remove files already tracked by Git. Review staged changes and use secret-scanning push protection when hosting the repository.

Nothing secret is part of a turn request: the server receives only the engine, a profile id, a model name, the permission mode, the reasoning effort and a display label ([`TurnConfig`](../packages/protocol/src/index.ts)). The executing device resolves the actual credentials locally.

## What the team server stores

| Data | Notes |
| --- | --- |
| Accounts | Email, name, Google avatar URL, organization domain, scrypt password hash, Google account id |
| Sessions | SHA-256 hashes of session tokens, never the tokens |
| Chats | Titles, members, invitations (including invited email addresses) |
| Transcript | Prompts, team-only messages, agent messages and thinking, tool calls with their input and output (output clipped to 24,000 characters), permission and question cards, notices |
| Turns | Requester, device name, engine, profile id, model, permission mode, reasoning effort, display label, status, errors, token and context usage, cost |
| Shared workspaces | Every synced file, stored by content hash |
| Attachments | Files sent with messages and media agents shared, with their names and who uploaded them, stored by content hash |

The SQLite database and the file blobs are not encrypted at rest. The server operator, and anyone with access to its data directory, can read every chat, including private ones, and every shared file. Deleting a chat hides it but keeps its data, except its attachments, which are deleted. See [Team server](server.md#data-directory).

Any signed-in user can search all accounts on the server by name or email to invite them.

## Agents act as the person who runs the turn

- CooPrompt reads the login shell environment so agents see the same tools as your terminal (git, gh, cloud CLIs and their credentials). Model credentials and endpoints present in that environment (such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `CURSOR_API_KEY`) are removed, so the selected profile alone decides which model account is used ([`src/main/engines/providers.ts`](../apps/desktop/src/main/engines/providers.ts), [`src/main/shell-env.ts`](../apps/desktop/src/main/shell-env.ts)).
- Whatever the agent does (pushing to git, calling cloud APIs, reading files) happens with the executor's identity on the executor's computer. A teammate's message never runs on your computer, but your agent does see what others wrote in the chat as context, so review what it asks to run.
- Permission requests are decided by the executor unless they turn on "Let others approve my agent's actions" for that chat. Questions can be answered by any member. See [Multiplayer](multiplayer.md#permissions-and-questions).
- "No restrictions" turns off Claude's permission prompts (`bypassPermissions`), gives Codex full disk and network access (`danger-full-access`) and runs Cursor in Run Everything (`--force`). Codex never asks for approval in any mode; its sandbox is the only limit.
- Cursor edits files inside the working folder without asking in every mode except "Plan only", where CooPrompt refuses whatever Cursor asks to do that could change something and stops the turn, ending its CLI, if the agent leaves plan mode or starts editing. Commands your own Cursor CLI allowlist covers run without asking. CooPrompt never answers Cursor's "Allow always", so approvals are remembered by CooPrompt for the chat and never added to your Cursor CLI settings ([Multiplayer](multiplayer.md#permission-modes)).
- Codex's sandbox doesn't cover MCP servers, and CooPrompt can't answer Codex's approval prompts, so in every mode except "Plan only" CooPrompt approves MCP tools up front for Codex: your connectors, the servers of your own Codex `config.toml` and plugins, and the apps of the ChatGPT account Codex signs in with, such as Slack ([why](connectors.md#codex-and-connector-tool-approvals)). A Codex agent can then use every tool of those servers and apps without asking, including ones that change things: posting messages as you in Slack, editing issues, or acting in your own Chrome through **Playwright in your Chrome**. Turn off the connectors, and in Codex the apps and plugins, you don't want a Codex agent to use freely, or use "Plan only", where only read-only tools run. Claude and Cursor still ask according to the permission mode.
- **Playwright in your Chrome** acts in the tabs you hand it with your signed-in accounts. With `PLAYWRIGHT_MCP_EXTENSION_TOKEN` set, connections no longer need your approval in Chrome.
- The context of a shared chat (other people's messages and their agents' output) is sent to the model provider of whoever runs each turn, which can be a third-party gateway or a local model. [Team-only messages](multiplayer.md#team-only-messages) are the exception: no agent gets them unless their author shares them. They are not private, though: everyone who can read the chat reads them, and the server stores them like the rest of the transcript.
- [Automations](automations.md) run unattended on their owner's computer, with that person's identity, like their messages. Nobody can approve anything during a run, so CooPrompt declines every approval request and question at once instead of waiting; what a run may do is its permission level, read-only by default, which everyone who sees the automation sees. A read-only automation ignores the actions you always allowed in its chat; with **Edit files** or **No restrictions** a Codex agent uses connector tools without asking, as in any Codex turn outside "Plan only".

## Secret redaction

With **Hide secrets in what gets posted to the chat** (Settings → Folders & privacy, on by default), the executing computer filters everything the agent publishes before it leaves the computer: transcript items (tool input and output, messages, thinking, notices, errors), streamed text and the error a turn ends with ([`publisher.ts`](../apps/desktop/src/main/runner/publisher.ts), [`redact.ts`](../apps/desktop/src/main/runner/redact.ts)). It replaces with `«redacted»`:

- every value stored in CooPrompt's secret store that is at least 8 characters long, also URL-encoded;
- credential formats recognizable on their own: private key blocks (also when the output was clipped in the middle), JWTs, Anthropic, OpenAI and OpenRouter keys, GitHub, GitLab, Slack, npm, PyPI, Stripe, Atlassian, Linear, Notion, Hugging Face, Vault and other vendor tokens, AWS access key ids, Google API keys and OAuth tokens, Slack webhooks;
- values given to secret-like names in code, diffs, configuration, logs and commands: `API_KEY = '…'`, `clientSecret: "…"`, `SERVICE_TOKEN=…`, `password: …`, `Authorization: Bearer …` or `Basic …`, `--token …`, `curl -u user:…`, passwords in URLs (`postgres://user:…@host`), name/value pairs such as Kubernetes `env` entries, and generated-looking strings right after words like "token" or "API key". References (`process.env.API_KEY`, `getToken()`, `${TOKEN}`), placeholders, types, versions, hashes, UUIDs and plain words are left alone;
- in structured data such as a tool's input, string fields whose key is secret-like (`{ "password": "…" }`).

Streamed text is redacted as a whole, not chunk by chunk, so a secret split between two chunks is still caught: a word that is still arriving, or a private key block that hasn't ended, is held back until it is complete.

Redaction is best effort. It does not apply to messages people type, nor to files in shared workspaces. Those are protected by the sync ignore rules: anything ignored by `.gitignore` (such as `.env`) never leaves the computer. The engine's system prompt also instructs the agent never to show, copy or publish secrets.

## Accounts and sessions

The rules live in [`apps/server/src/auth.ts`](../apps/server/src/auth.ts) and [`apps/server/src/routes.ts`](../apps/server/src/routes.ts).

- **Passwords**: at least 8 characters, stored as scrypt hashes with a random salt.
- **Sessions**: signing in returns a random 256-bit bearer token. The server stores only its SHA-256 hash. Sessions do not expire; signing out deletes the session.
- **Google sign-in**: uses an OAuth client of type "Desktop app" ([`src/main/google.ts`](../apps/desktop/src/main/google.ts)). The app opens the browser with a PKCE challenge (S256) and a random `state`, and waits on a loopback address on the user's computer. The loopback answers any callback whose `state` doesn't match with an error page and keeps waiting, so a request forged by another page can neither complete nor break the sign-in ([`src/main/loopback.ts`](../apps/desktop/src/main/loopback.ts)); the person can also cancel the wait. The server accepts only loopback redirect URIs, exchanges the code with the client secret and the PKCE verifier, and verifies the ID token against Google's published keys: an RS256 signature, issuer `accounts.google.com`, audience equal to the client ID, an `exp` that hasn't passed, a `sub`, and `email_verified`.
- **Allowed domains** accept only Google Workspace accounts of those domains, identified by the token's `hd` claim (any address of that Workspace counts). A personal Google account is refused even with a company address, because Google only confirmed that address once, and Gmail accounts are accepted only when `gmail.com` is listed. Without allowed domains, any Google account with a verified email can sign in. Setting the OAuth client's audience to **Internal** makes Google itself refuse accounts outside your Workspace.
- **Linking Google to an account**: a Google sign-in lands in the account linked to that Google account. Otherwise, if an account with the same email exists, Google must vouch for the address: a Google Workspace account (`hd`) or a Gmail address. Then the Google account takes the account over: the account is linked to it, its password is removed, and all its sessions are deleted and its open connections closed, on every device; its chats and memberships stay. When Google can't vouch, the server answers 409 and asks the person to sign in with their password. An account without a password answers password sign-ins with "This account signs in with Google".
- **Access code**: when the server has one, creating an email/password account requires it; Google sign-ins don't. The standalone server generates a 6-digit code by default (or uses `COOPROMPT_ACCESS_CODE`). The embedded server generates one only when the host turns the option on, and the change applies without restarting. See [Team server](server.md).
- **Password sign-in can be disabled** to accept Google accounts only: `COOPROMPT_PASSWORD_AUTH=false` on the standalone server, or **Google accounts only** on the embedded one (applied without restarting, and only possible while Google sign-in is configured). The server then refuses password sign-up and sign-in, and people with a password account sign in with a Google account Google vouches for (as above) that has the same email; someone without such a Google account can no longer reach theirs.

The server does not rate-limit sign-in attempts and does not verify email addresses of password accounts.

### Consequences of unverified emails

Organizations come from email domains, and invitations can target email addresses without an account. With password sign-up open, someone can register with an address that isn't theirs, for example with your company's domain, and then read that domain's company chats or receive invitations sent to that address. They keep that access until the real owner signs in with Google using a Workspace or Gmail account for that address: the account then becomes the owner's, with whatever the other person did in it, the password stops working and every session of the other person ends. On a server without Google sign-in, nothing ends it.

Without allowed domains, a personal Google account created with a company address that has no CooPrompt account yet can also create one and join that domain's organization. It can't take over an existing account.

To prevent both:

- require the access code and share it only with teammates; or
- enable Google sign-in with your domains as allowed domains and the OAuth client's audience set to **Internal**, and accept Google accounts only (`COOPROMPT_PASSWORD_AUTH=false`, or **Google accounts only** on an embedded server).

### Authorization

The server enforces who can do what:

- Only members can send messages, rename a chat, invite people and access its shared workspace and its attachments. Company chats can be read and joined by everyone in the organization.
- Only the owner can delete a chat. Only the requester or the chat owner can cancel or interrupt a turn.
- Only the device running a turn can publish its output, and prompts and team-only messages can only be created by their author through the HTTP API. A team-only message never becomes a turn, its content goes only to apps that announce they keep it from their agents, and only its author can share it with the agents ([Architecture](architecture.md#team-only-messages)).
- Permission decisions from anyone other than the executor are rejected unless the executor allowed them; the executor's computer checks again before applying a decision.
- Only an automation's owner can change, run or delete it, and it can only post in a chat its owner is a member of. Its runs are turns of the owner, sent only to the device the owner chose, and only when that device announced it runs automations unattended. Members of the chat can see it. See [Automations](automations.md#who-sees-and-does-what).

## Network exposure

- The embedded server, and the standalone server with its default `HOST=0.0.0.0`, listen on every network interface: anyone on the same network can reach them.
- Connections on the local network use plain HTTP and WebSocket. Session tokens, chats and files travel unencrypted, so avoid hosting on untrusted networks.
- A Cloudflare quick tunnel publishes the server at a random `https://….trycloudflare.com` address. Traffic is encrypted between clients and Cloudflare, but anyone who learns the address can reach the API, create an account (unless the access code is on or only Google accounts are accepted) and download the installer. Turn on the access code, or **Google accounts only** with allowed domains, before sharing a tunnel, and close the tunnel when it isn't needed. The address survives restarts and updates of the host's CooPrompt (quitting CooPrompt leaves `cloudflared` running); **Close tunnel** or **Stop** in Settings → Team server ends it. When the tunnel stops working, CooPrompt opens a new one at a new address and shows it to the host. While a tunnel is open, the server is still reachable on the local network.
- The `/install` and `/download/CooPrompt.zip` endpoints don't require an account.

## Desktop app hardening

- The UI runs in a sandboxed renderer with context isolation and no Node.js access. It reaches the main process through a single IPC channel whose methods are the fixed `CooPromptApi` table in [`src/shared/types.ts`](../apps/desktop/src/shared/types.ts).
- The UI page sets a Content-Security-Policy ([`index.html`](../apps/desktop/src/renderer/index.html)) that only runs the app's own scripts and only allows network connections to the app itself and the local development server. Images may load from any HTTPS address (avatars use this), so images embedded in Markdown messages are fetched from wherever they point; Markdown images with a local path are not loaded. Attachments load only through `cooprompt-media:` (see [Attachments](#attachments)).
- The window cannot navigate away from the app, nor to a local file (a file dropped outside the composer is ignored); links open in the default browser, and only `http(s)` URLs can be opened.
- Sign-ins that run in the browser, Google's and MCP connectors' OAuth, come back to a local listener ([`src/main/loopback.ts`](../apps/desktop/src/main/loopback.ts)) that accepts only the callback carrying the random `state` of that attempt (128 bits, new each time). Other requests get an error page and are ignored, so a web page that calls the callback port can't complete the sign-in with a code of its own or cut it short. Both flows also use PKCE. See [Connectors](connectors.md#oauth).
- The built-in editor for agent configuration only writes `.md` files under `.claude`, `.agents` or `.codex` folders and `AGENTS.md`/`CLAUDE.md` files, in your home folder or a chat's working folder ([`src/main/catalog.ts`](../apps/desktop/src/main/catalog.ts)).

## Attachments

Files sent in chats, and the media agents share, follow these rules ([`apps/server/src/attachments.ts`](../apps/server/src/attachments.ts), [`src/main/attachments.ts`](../apps/desktop/src/main/attachments.ts)):

- **Members only.** Only members of a chat can upload or download its attachments; people who can read a company chat without having joined it see the files' names only. A download names both the chat and the attachment, so an id from another chat gets 404, and the server describes what an executor's item attaches with its own records, keeping only that chat's files.
- **Names and types.** Names keep only their last segment, without control or direction-changing characters (which can disguise an extension), and get the extension of the format their bytes show. Types come from the bytes, never from the name: HTML and anything else unrecognized is a plain file.
- **Never an active document.** Downloads carry `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`; plain files are served as `application/octet-stream`, and plain files and SVG as `Content-Disposition: attachment`. The renderer gets media only through `cooprompt-media:`, which serves images, audio and video with the type their bytes show and the same headers, and shows SVG only as an image.
- **Limits.** 50 MB a file, 10 files and 100 MB a message, checked by the app before uploading and enforced by the server; an agent turn shares at most 20 files.
- **Opening.** **Open** hands to the system's default app only images, PDFs, audio and video whose bytes match their extension, never SVG; other files can only be shown in their folder or saved. On macOS downloaded plain files and saved copies get the quarantine flag. Windows download-origin marking is not yet implemented.
- **Copies for agents.** Engines read attachments from copies in `.cooprompt/attachments` inside the working folder, which is never written through a symbolic link and is ignored by the workspace sync and by git.
- **Credentials and redaction.** No token appears in a `cooprompt-media:` URL or in a transcript item: the main process adds this computer's session to the requests it makes. What a turn shares goes through the publisher, which redacts the item that references the files and, when redaction is on, the names of the files it uploads. Redaction can't reach inside an image: a screenshot of a terminal or a page shows whatever was on it.

## Signing and updates

- Builds are signed with the CooPrompt signing identity, a self-signed certificate kept by whoever publishes releases, or ad hoc when it is absent. There is no Apple Developer ID, no notarization and no hardened runtime: macOS cannot vouch for who built a given copy, and Gatekeeper doesn't check copies installed by the one-line installer or by an update. See [Distribution](distribution.md#signing).
- The one-line installer runs a script served by the team server and installs the app that server provides, with no further verification. Use it only with servers you trust, and prefer the tunnel's HTTPS address to plain HTTP outside a trusted network.
- Updates trust the server only to say what to download ([`src/main/updater.ts`](../apps/desktop/src/main/updater.ts)). The zip must have exactly the size and SHA-256 the server announced, and the app inside must have CooPrompt's bundle identifier, the announced version, an intact signature (`codesign --verify --deep --strict`) and a signature that satisfies the running app's designated requirement, which for an identity-signed CooPrompt means a build signed with the same identity. A server, or someone between it and the app, can withhold updates but can't make such an installation run a build signed by anyone else. An installation signed ad hoc can only require the bundle identifier, so it accepts any build its server offers under that identifier.
- The signing identity is what that check rests on: anyone who has `~/.cooprompt-signing` can publish builds every teammate's CooPrompt installs. Keep it private and backed up.
- The update helper runs as the user, only replaces the CooPrompt app (in place or in `~/Applications`), and puts the previous version back if the new one doesn't confirm it started.
- After each update or new build, macOS asks once for the Mac password so CooPrompt can use its "CooPrompt Safe Storage" Keychain item. If access is denied, CooPrompt treats the stored secrets, including the session, as missing.
