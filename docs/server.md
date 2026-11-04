# Team server

The team server holds accounts, chats, invitations, transcripts, the turn queue and the files of shared workspaces, relays live activity between computers, and serves the one-line installer. It never runs agents and never receives model credentials. A team shares one server.

The server is the `@cooprompt/server` package ([`apps/server`](../apps/server/src)): Fastify for HTTP, `@fastify/websocket` for the realtime hub, and Node's built-in `node:sqlite` for storage.

This page is the reference. Step-by-step setups (hosting on a teammate's computer, an always-on machine with a service manager, HTTPS, backups and upgrades) are in [Deployment](deployment.md).

## Hosting options

### Embedded in CooPrompt ("Host on this computer")

Any CooPrompt can run the server: **Settings → Team server → Host on this computer**, or **Create a new server on this PC** on the sign-in screen before signing in. [`src/main/host.ts`](../apps/desktop/src/main/host.ts) starts it inside the app.

- It listens on all network interfaces on the configured port (4317 by default) and lists the addresses teammates on the same network can use.
- It runs while CooPrompt runs (closing the window keeps the app running) and starts again when CooPrompt opens, unless you stop it or turn off **Start the server when CooPrompt opens**.
- Its data lives in `~/Library/Application Support/CooPrompt/host-server` on macOS and `%APPDATA%\CooPrompt\host-server` on Windows; development and profile instances use their separate data folders.
- **Require an access code to create an account** generates a 6-digit code, kept in CooPrompt's secret store, and applies immediately. It is off by default, and not needed with **Google accounts only**.
- **Sign in with Google** in the same section sets up [Google sign-in](#google-sign-in): a three-step guide with **Open Google Cloud**, the client ID, the client secret (kept in CooPrompt's secret store), the allowed domains and **Google accounts only**. Saving applies them to the running server at once, without closing the tunnel. Only the server name and port need a restart (Stop, then Host on this computer).
- **Google accounts only**, available once the client ID and secret are filled in, turns off email/password sign-up and sign-in, like `COOPROMPT_PASSWORD_AUTH=false` on a standalone server.
- On macOS, **Open tunnel** starts a Cloudflare quick tunnel and shows its public `https://….trycloudflare.com` address. It needs `cloudflared` on your `PATH`, in `/opt/homebrew/bin` or in `/usr/local/bin` (`brew install cloudflared`). `cloudflared` keeps running when CooPrompt quits or restarts to update, and the next launch takes it over with the same address if it connects to Cloudflare within 20 seconds (its record and log are `tunnel.json` and `tunnel.log` in the data folder). **Close tunnel** or **Stop** ends it. Public tunnels are not yet available on Windows.
- CooPrompt keeps the tunnel working. It checks it every 30 seconds and as soon as the computer wakes up: `cloudflared` must be running, its `/ready` metrics endpoint must report a connection to Cloudflare, and DNS must still know the hostname. It opens a new tunnel when `cloudflared` dies, when the tunnel stays disconnected for 2 minutes, or right away when it is disconnected and its hostname is gone (Cloudflare drops quick tunnels that stay away too long, for example while the computer sleeps). Meanwhile Settings → Team server says the tunnel is reconnecting and offers **Try now**; new tunnels that fail are retried after 10 seconds, then 30 seconds, 1, 2 and 5 minutes.
- A new tunnel has a new address. CooPrompt shows it in a notice at the top of the sidebar and in Settings → Team server, with a notification when CooPrompt is in the background, until the host clicks **Copy message for the team** (the new address and how to switch to it, plus the install command) or dismisses it. The installer commands always use the current address.
- **Keep this computer awake while the tunnel is open**, on by default, stops the computer from going to sleep on its own while the server runs with the tunnel open. Closing the lid still puts it to sleep.
- For macOS installation and updates, the server offers the newest macOS build in the folder set under **Builds to offer** (read through its `latest-mac.json`), or, on a packaged macOS host, a zip of the running app stored in `~/Library/Application Support/CooPrompt/installer`. A development build has no zip of its own to serve. A Windows host can offer a macOS installer only from an explicitly selected macOS release folder; Windows installers and updates are not served here.
- When the host's CooPrompt restarts to install an update, it first waits for the turns running on its server to finish (unless the host chooses **Restart anyway**), and tells connected apps that it is restarting.

### Standalone

Run the server as a Node process from a clone of this repository (Node 24, see [`.nvmrc`](../.nvmrc)):

```sh
nvm use
npm install
cp apps/server/.env.example apps/server/.env   # optional
npm run server        # or: npm run server:dev (restarts on code changes)
```

`npm run server` runs [`apps/server/src/cli.ts`](../apps/server/src/cli.ts) with `tsx`, loading `apps/server/.env` when it exists. On startup it prints the addresses it listens on, whether Google sign-in is enabled (with its allowed domains), and the access code, or that email sign-in is disabled. It stops cleanly on Ctrl+C or `SIGTERM`.

### Reaching the server from elsewhere

- **Same network**: teammates use `http://<host address>:<port>`.
- **Cloudflare quick tunnel**: the embedded server's **Open tunnel**, or `npm run share` for a standalone server ([`scripts/share.mjs`](../scripts/share.mjs) tunnels `http://127.0.0.1:$PORT`, 4317 by default, and prints the public URL). No Cloudflare account is needed. `npm run share` gets a new URL every time it starts; the embedded tunnel keeps its URL across restarts of CooPrompt until it is closed, the computer restarts, or CooPrompt replaces it because it stopped working.
- **Your own reverse proxy**: forward HTTP and the WebSocket endpoint `/ws`. The installer builds its URLs from `X-Forwarded-Proto` and `X-Forwarded-Host` (and Cloudflare's `CF-Visitor`), so the script points teammates at the public address they used.

Before exposing a server beyond your network, read [Network exposure](security.md#network-exposure).

## Environment variables (standalone)

[`apps/server/.env.example`](../apps/server/.env.example) documents each variable and [`cli.ts`](../apps/server/src/cli.ts) reads them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4317` | Port to listen on. |
| `HOST` | `0.0.0.0` | Address to bind; `0.0.0.0` makes the server reachable from the local network. |
| `COOPROMPT_DATA_DIR` | `~/.cooprompt-server` | Data directory. |
| `COOPROMPT_SERVER_NAME` | `CooPrompt` | Name clients show when they connect; also used in the installer script. |
| `COOPROMPT_ACCESS_CODE` | generated | Code required to create email/password accounts. When unset, a 6-digit code is generated once and stored in `access-code.txt` in the data directory, so it survives restarts. Set it empty to require no code. |
| `COOPROMPT_PASSWORD_AUTH` | `true` | `false` disables email/password sign-up and sign-in (Google only). People with a password account then sign in with a Google Workspace or Gmail account that has the same email (see [Google sign-in](#google-sign-in)). |
| `COOPROMPT_MAX_PARALLEL_TURNS` | `3` | Turns a chat runs at once when people send them in [multitask](multiplayer.md#multitask) mode. `1` turns multitask off, as on a server that predates it. The embedded server always allows 3. |
| `COOPROMPT_AUTOMATION_MIN_INTERVAL` | `15` | Shortest time, in minutes, between two runs of an [automation](automations.md). Lower it only to try automations out; the embedded server always uses 15. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | empty | Enable Google sign-in when both are set. |
| `GOOGLE_ALLOWED_DOMAINS` | empty | Comma-separated domains (a leading `@` is ignored). Only Google Workspace accounts of these domains may sign in with Google; Gmail accounts only if `gmail.com` is listed. Empty allows any Google account with a verified email. |
| `COOPROMPT_INSTALLER_ZIP` | the build `apps/desktop/release/latest-mac.json` names | Zip of `CooPrompt.app` served to teammates. Without it the server serves the build `npm run dist` described in that folder's `latest-mac.json` (read on every request), or else the newest `*-mac.zip` there, without announcing a version. |
| `COOPROMPT_INSTALLER_VERSION` | empty | Version of the `COOPROMPT_INSTALLER_ZIP` file. Installed apps are offered the zip as an update only when the server knows its version. |

### Google sign-in

1. In Google Cloud, open **Google Auth Platform → Clients** and create an OAuth client of type **Desktop app**. It needs no redirect URIs.
2. In **Google Auth Platform → Audience**, choose **Internal**, so that only accounts of your Google Workspace organization can sign in.
3. Give the client ID and secret to the server, with your domains as allowed domains: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_ALLOWED_DOMAINS` for the standalone server (then restart it), or Settings → Team server → **Sign in with Google** for the embedded one, where **Open Google Cloud** opens the clients page and saving applies at once.

People sign in through their browser, which returns to a loopback address on their own computer; the server exchanges the result with Google and verifies it. Allowed domains are matched against the Google Workspace an account belongs to (Google's `hd` claim, so any address of that Workspace counts), never against the address alone: a personal Google account is refused even with a company address. `GET /api/health` lists the allowed domains (`auth.google.allowedDomains`), so the sign-in screen can show which accounts the server accepts, and with exactly one domain Google's account chooser offers only that organization's accounts.

A Google sign-in lands in the account linked to that Google account. When there is none but an account with the same email exists, the Google account takes it over if Google vouches for the address (a Workspace account or a Gmail address): the account keeps its chats, its password stops working and its sessions end. Otherwise the server refuses the sign-in and asks for the password. The rules are in [Accounts and sessions](security.md#accounts-and-sessions).

## Data directory

| Path | Content |
| --- | --- |
| `cooprompt.db` (with `-wal` and `-shm` files) | SQLite database: users, sessions, chats, members, invitations, transcript items, turns, the workspace file index, the attachment records, automations and their runs (the last 200 of each). |
| `blobs/` | Shared workspace file contents, one file per SHA-256 hash. |
| `attachments/` | Files sent in chats and media agents shared, one file per SHA-256 hash. |
| `tmp/` | Uploads in progress. |
| `access-code.txt` | Generated access code (standalone server, when `COOPROMPT_ACCESS_CODE` is unset). |

The schema is created and upgraded automatically at startup. Deleting a chat only marks it deleted: its transcript and workspace files stay in the directory, and workspace blobs are never removed. Its attachments are deleted, with the blobs no other chat uses, and uploads no message or agent output points to are deleted after a day. Turns that were running when the server stopped are marked failed when it starts again; sessions survive restarts. Backup and restore procedures are in [Deployment](deployment.md#5-back-up).

## Endpoints

HTTP endpoints exchange JSON and authenticate with `Authorization: Bearer <session token>`, except where noted. Payload shapes are the types in [`packages/protocol`](../packages/protocol/src/index.ts); the handlers are in [`routes.ts`](../apps/server/src/routes.ts), [`team-routes.ts`](../apps/server/src/team-routes.ts), [`files.ts`](../apps/server/src/files.ts), [`attachments.ts`](../apps/server/src/attachments.ts), [`automation-routes.ts`](../apps/server/src/automation-routes.ts) and [`installer.ts`](../apps/server/src/installer.ts).

### Server and accounts

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Name, version, protocol version, whether it is the first run, the sign-in options (password, access code, Google with its client ID and allowed domains), the attachment limits (`attachments`) and, when known, the desktop build it distributes (`app`, see below). No auth. |
| `POST /api/auth/register` | Create an email/password account (with the access code when required). Refused when password sign-in is disabled. No auth. |
| `POST /api/auth/login` | Email/password sign-in. Refused when password sign-in is disabled; an account without a password is told to use Google. No auth. |
| `POST /api/auth/google` | Exchange a Google authorization code (with its PKCE verifier and loopback redirect URI) for a session, creating, linking or taking over the account with that email. No auth. |
| `POST /api/auth/logout` | Delete the current session. |
| `GET /api/me`, `PATCH /api/me` | Read the current user; change the display name. |
| `GET /api/devices` | The current user's connected devices. |
| `GET /api/users/search?q=` | Search accounts by name or email (your organization first). |

The optional `app` field (`AppRelease`) is how installed apps learn about updates: the `version` of the build `/download/CooPrompt.zip` serves, and the `sha256` and `size` of that exact file, which the server computes itself and recomputes when the file, its version, size or modification time changes. It is omitted when the server has no installer or doesn't know its version. A health check waits at most 1.5 seconds for the hash, so a build that was just replaced shows up on a later check.

### Chats, turns and invitations

| Endpoint | Purpose |
| --- | --- |
| `GET /api/chats`, `POST /api/chats` | List the chats you can see; create a chat. |
| `GET`, `PATCH`, `DELETE /api/chats/:id` | Read, rename (members) or delete (owner) a chat. |
| `POST /api/chats/:id/join`, `POST /api/chats/:id/leave` | Join a company chat; leave a chat. |
| `GET /api/chats/:id/items` | Transcript items, paged by `beforeSeq`/`limit` or incrementally by `afterRev`. Team-only messages come as stand-ins without their content unless `include=team` is given, which the app's transcript does and its runner never does ([why](architecture.md#team-only-messages)). |
| `GET /api/chats/:id/turns` | Recent turns. |
| `POST /api/chats/:id/messages` | Send a message: stores the prompt and queues a turn on one of the sender's online devices. `attachments` lists ids of the sender's uploads to this chat (the text may then be empty); the prompt carries them and a `📎 name` line per file. With `parallel: true` (multitask) the turn starts right away while fewer than the limit run, when the device announced `parallel-turns`. With `interrupt: true`, it also stops a running turn (the one in `interruptTurnId`, or else the sender's latest; requester or chat owner only) and runs the new one first, once that turn has stopped; the response's `interrupted` names the stopped turn. |
| `POST /api/chats/:id/team-messages` | Send a team-only message (members): `text` and optionally `attachments`, as for a message. It is stored as a `team` item without a turn, and no turn is ever queued for it. |
| `POST /api/chats/:id/team-messages/:itemId/share` | Share one of your own team-only messages with the agents: it becomes a `user` item without a turn, with `sharedAt`, which every agent gets at its next catch-up. Sharing it again returns it unchanged. |
| `POST /api/turns/:id/cancel` | Cancel a queued or running turn (requester or chat owner). The turn records who cancelled it. |
| `GET /api/chats/:id/invitations`, `POST /api/chats/:id/invitations` | Pending invitations of a chat; invite a user or an email address. |
| `GET /api/invitations` | Your pending invitations. |
| `POST /api/invitations/:id/accept`, `/decline`, `/revoke` | Answer or revoke an invitation. |

Some fields are optional because they were added later: `app` and `attachments` in `GET /api/health`, `interrupt`, `interruptTurnId`, `parallel` and `attachments` (request) and `interrupted` (response) on `POST /api/chats/:id/messages`, `attachments` in user, text and tool items, `effort` in `TurnConfig` (kept when it looks like a level name, dropped otherwise), `contextTokens`/`contextWindow` in `TurnUsage`, `parallel`, `interrupts` and `automation` in `TurnInfo`, `automations` and `teamMessages` in `ready`, `sharedAt` in user items, and `activeTurns` in `ChatSummary` (`activeTurn` keeps the running turn that started first). Servers that predate team-only messages answer their endpoints with 404, which apps report instead of sending a message for the agent. Software that doesn't know them ignores them: older apps keep working with a newer server, and a newer app talking to an older server queues the message (also when sent in multitask mode) and cancels the running turn instead of interrupting. The `priority`, `parallel`, `interrupts` and `automation` columns of `turns` are added to existing databases at startup.

### Shared workspace files

Members of multiplayer and company chats only.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/chats/:id/fs/changes?since=` | Change feed: entries after a sequence number, in pages. |
| `PUT /api/chats/:id/fs/file?path=&base=&exec=` | Upload a file (raw body). `base` is the hash of the version the client last saw; a stale base returns `409` with the current entry. |
| `DELETE /api/chats/:id/fs/file?path=&base=` | Delete a file, with the same conflict rule. |
| `GET /api/chats/:id/fs/blob/:hash` | Download file content by hash. |

### Attachments

Members of the chat only, private chats included.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/chats/:id/attachments?name=` | Upload a file (raw `application/octet-stream` body, up to 50 MB). Returns its `AttachmentRef`: id, sanitized name, the type its bytes show (`mime`, `kind`), size and SHA-256. |
| `GET /api/chats/:id/attachments/:attachmentId` | Download it, with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, its SHA-256 as `ETag` and a `Content-Disposition` that is `attachment` for plain files and SVG. |

A server that predates attachments answers these with 404 and omits `attachments` in `GET /api/health`, which is how apps know not to offer them.

### Automations

Everyone sees their own automations and those of the chats they are members of; only an automation's owner can change, run or delete it. What they do is in [Automations](automations.md).

| Endpoint | Purpose |
| --- | --- |
| `GET /api/automations` | The automations you see (`AutomationInfo`), each with its next run and last run. |
| `POST /api/automations` | Create one (`AutomationInput`): name, instructions, a chat you are a member of, one of your connected devices, schedule, time zone, a `TurnConfig` whose permission mode is `plan`, `acceptEdits` or `bypassPermissions`, and optionally `fresh`, `timeLimitMinutes` and `enabled`. Up to 50 per person. |
| `PATCH /api/automations/:id`, `DELETE /api/automations/:id` | Change any of those fields (owner); delete it (owner), which stops its run in progress. |
| `POST /api/automations/:id/run` | Run it now (owner). `409` when its computer isn't connected with a CooPrompt that runs automations, or when it is already running. |
| `GET /api/automations/runs` | Runs of your own automations, newest first (`limit`, up to 500); with `automationId`, the runs of one automation you see. |
| `POST /api/automations/runs/read` | Mark runs of your own automations as seen: `ids`, or `all: true`. |

Changes reach the owner and the chat's members as `automation.upsert` and `automation.remove` WebSocket messages, and the owner gets `automation.run` for each change of a run.

### Installer

No auth.

| Endpoint | Purpose |
| --- | --- |
| `GET /install` | One-line installer script in English (`?lang=es` for Spanish). Used as `curl -fsSL <server>/install \| bash`. |
| `GET /instalar` | The same script in Spanish (`?lang=en` for English). |
| `GET /download/CooPrompt.zip` (alias `/descargar/CooPrompt.zip`) | The zipped `CooPrompt.app`, or `404` when the server has none. |

### WebSocket

`GET /ws` upgrades to the realtime channel. The client's first message is `hello` with its session token, its device id and what it can do (`features`: `parallel-turns` for an app that runs parallel turns in separate engine sessions, `automations` for one that runs automation turns unattended, `team-messages` for one that keeps team-only messages from its agents, the only connections that get their content); the server answers `ready`, with `maxParallelTurns` when it offers multitask, `automations` (the shortest interval and the longest time limit) when it runs automations, and `teamMessages` when it takes team-only messages. Members' apps that announced `team-messages` get `team.message` for each one the others send, whether or not they have the chat open. Afterwards the client subscribes to chats and, as an executor, publishes turn output. Right before an embedded server restarts to update, it sends `server.restarting` so apps know why the connection drops and reconnect quickly. The message types are `ClientMessage` and `ServerMessage` in [`packages/protocol`](../packages/protocol/src/index.ts); the hub is [`hub.ts`](../apps/server/src/hub.ts).

### Limits

Messages can be up to 200,000 characters and JSON bodies up to 4 MB. Workspace uploads can be up to 512 MB, although CooPrompt does not sync files larger than 200 MB. Attachments can be up to 50 MB each, so they pass through a Cloudflare tunnel (100 MB a request), and a message can carry 10 of them adding up to 100 MB. WebSocket messages can be up to 8 MB.
