# Deployment

Step-by-step playbooks for running a team server and getting new builds to teammates. [Team server](server.md) is the reference for environment variables, endpoints and the data directory; [Security](security.md) explains the trust model behind the checklist.

## Choosing a setup

| | Playbook A: host on a teammate's computer | Playbook B: an always-on server |
| --- | --- | --- |
| Runs in | The host's CooPrompt ("Host on this computer") | `npm run server` on a suitable machine or VM |
| Available while | The host's CooPrompt is open and the computer is awake | The machine is up |
| Reachable from | The local network, plus a Cloudflare quick tunnel on macOS | Whatever you set up: local network, VPN or HTTPS behind a reverse proxy |
| Setup effort | One click | A service, a proxy and backups |
| Good for | Trying CooPrompt, small teams working at the same time | Teams that rely on it every day |

Both run the same server code and use the same data format, so you can start with A and move to B later.

To run the server on your own infrastructure (for example a container behind your VPN), see [Team server](server.md). Organization-specific playbooks can live in [`deploy/AGENTS.md`](../deploy/AGENTS.md).

## Playbook A: Host on a teammate's computer

The embedded host can serve a local network from either platform. Windows support remains experimental; public tunnels, the shared one-line installer and automatic updates are currently macOS-only.

### Set it up

1. Install CooPrompt on the host computer (see [Distribution](distribution.md)). A development build can host too, but it can't serve its own installer to teammates.
2. Start the server:
   - before signing in: **Create a new server on this PC** on CooPrompt's first screen (**No server yet? Host one on this computer** on the sign-in screen leads there too), then **Create account** (the address, and the access code if one is required, are filled in for you);
   - when already signed in: **Settings → Team server → Host on this computer**.
3. In Settings → Team server, turn on **Require an access code to create an account** unless everyone who can reach the server should be able to sign up (or use Google accounts only, step 6).
4. Give teammates the local server address and sign-in instructions: **Continue with Google** with their company account when Google sign-in is set up, otherwise the access code when one is required. The shared one-line install command is for macOS teammates; Windows installers must be distributed separately.
5. On macOS, for teammates outside your network: install `cloudflared` (`brew install cloudflared`), click **Open tunnel**, and share the `https://….trycloudflare.com` address. Public tunnels are not yet available on Windows.
6. Optional, recommended for a company: Google sign-in. Follow the three steps under **Sign in with Google** in Settings → Team server (**Open Google Cloud** opens the page): create an OAuth client of type "Desktop app", set its audience to **Internal**, then paste the client ID and secret, add your domain under **Allowed domains** and **Save**. It applies to the running server at once, without closing the tunnel. To stop accepting email accounts, also turn on **Google accounts only**: people who already have a password account sign in with Google using the same email and keep their chats. See [Google sign-in](server.md#google-sign-in).

### Keep it available

- CooPrompt must stay open. Closing the window is fine; quitting stops the server.
- The computer must stay awake and online. While a macOS tunnel is open, **Keep this computer awake while the tunnel is open** (on by default in Settings → Team server) keeps it from going to sleep on its own; closing a laptop's lid still puts it to sleep. Otherwise, adjust the operating system's sleep settings.
- **Start the server when CooPrompt opens** is turned on when you first start hosting, so the server comes back when CooPrompt reopens, and an open tunnel is kept or reopened with it.
- When CooPrompt updates itself, it waits for the turns running on your server to finish before restarting (you can choose **Restart anyway**). Connected teammates see "The server is restarting to update…" and reconnect on their own.
- The data lives in `~/Library/Application Support/CooPrompt/host-server` on macOS and `%APPDATA%\CooPrompt\host-server` on Windows. Development and profile instances use separate data folders. To back it up, quit CooPrompt and copy that folder.

### Quick tunnel limits

These limits apply to the macOS tunnel; the Windows app does not open one yet.

- The address is random. It stays the same while `cloudflared` keeps running and connected, which includes CooPrompt quitting, restarting or updating, but a new one is assigned when the tunnel is closed (**Close tunnel** or **Stop**), when the computer restarts, or when CooPrompt replaces a tunnel that stopped working (see [Team server](server.md#embedded-in-cooprompt-host-on-this-computer)). CooPrompt then shows the new address with **Copy message for the team**: send that message to teammates outside your network, who enter the address in Settings → Account & device → **Change** and stay signed in. For an address that never changes, use an always-on server with its own hostname (Playbook B).
- Quick tunnels are Cloudflare's account-free testing mode: there is no uptime guarantee, traffic passes through Cloudflare, and Cloudflare drops a tunnel that stays disconnected for a while, for example while the computer sleeps.
- Anyone who learns the address can reach the server, its sign-up and its installer. Keep the access code on while a tunnel is open and close the tunnel when it isn't needed.

### Moving to an always-on server

The embedded server stores everything in the host data folder described above, in the same format as a standalone server. To move: stop hosting (Settings → Team server → **Stop**, which also closes any tunnel), copy that folder to the new machine (`tunnel.json` and `tunnel.log` can be left out), and use it as `COOPROMPT_DATA_DIR` in Playbook B. Accounts, chats and shared files carry over, and so do sessions: teammates enter the new address in Settings → Account & device → **Change** and stay signed in. The access code and the Google configuration don't carry over: set them in the new server's environment.

## Playbook B: An always-on server

### 1. Prepare the machine

You need Node 24 (the version in [`.nvmrc`](../.nvmrc)), git, and network access from teammates to the machine. Google sign-in also needs outbound HTTPS to Google.

```sh
git clone <repository URL> cooprompt
cd cooprompt
npm ci
npm run server
```

`npm ci` installs every workspace, including the desktop app's toolchain; on a headless server, `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci` skips downloading Electron. Check that the server answers with `curl http://127.0.0.1:4317/api/health`, then stop it and continue.

### 2. Configure

Set the variables described in [Environment variables](server.md#environment-variables-standalone), either in `apps/server/.env` (read by `npm run server`) or in the service manager's environment, which takes precedence over `.env`. A server behind a reverse proxy typically uses:

```sh
# Only the proxy on this machine reaches the server.
HOST=127.0.0.1
PORT=4317
COOPROMPT_DATA_DIR=/var/lib/cooprompt
COOPROMPT_SERVER_NAME=Acme CooPrompt

# Desktop builds: leave these unset and copy each build into apps/desktop/release
# of this checkout (see below), or set both:
# COOPROMPT_INSTALLER_ZIP=/var/lib/cooprompt/CooPrompt.zip
# COOPROMPT_INSTALLER_VERSION=0.1.2

# Choose who can sign up. Either keep the generated access code
# (printed at startup and stored in access-code.txt in the data directory),
# or accept only Google accounts from your domain (create the OAuth client
# as in docs/server.md, "Google sign-in", with the audience set to Internal):
COOPROMPT_PASSWORD_AUTH=false
GOOGLE_CLIENT_ID=<client id>
GOOGLE_CLIENT_SECRET=<client secret>
GOOGLE_ALLOWED_DOMAINS=acme.com
```

For macOS desktop updates, builds are made on a Mac with Apple silicon (`npm run dist`, see [Distribution](distribution.md)). The server must know a build's version to offer it as an update, so publish each build in one of two ways:

- **Release folder (no restart).** Copy the zip and the `latest-mac.json` that `npm run dist` wrote into `apps/desktop/release/` of the server's checkout, and leave `COOPROMPT_INSTALLER_ZIP` unset. The server reads `latest-mac.json` on every request. A Mac that builds CooPrompt itself already has them there.
- **Explicit file.** Point `COOPROMPT_INSTALLER_ZIP` at the zip and set `COOPROMPT_INSTALLER_VERSION` to its version, then restart the server so it reads the new value.

### 3. Keep it running

The server stops cleanly on `SIGTERM` and logs to standard output.

**Linux (systemd)**, for example `/etc/systemd/system/cooprompt-server.service`:

```ini
[Unit]
Description=CooPrompt team server
After=network-online.target
Wants=network-online.target

[Service]
User=cooprompt
WorkingDirectory=/opt/cooprompt
# Variables from step 2; they take precedence over apps/server/.env.
EnvironmentFile=/etc/cooprompt/server.env
# The bin folder of your Node 24 installation.
Environment=PATH=/opt/node-24/bin:/usr/bin:/bin
ExecStart=/opt/node-24/bin/npm run server
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now cooprompt-server
journalctl -u cooprompt-server -f
```

**macOS (launchd)**, for example `/Library/LaunchDaemons/dev.cooprompt.server.plist`, running as the local user that owns the checkout and the data folder:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.cooprompt.server</string>
  <key>UserName</key>
  <string>cooprompt</string>
  <key>WorkingDirectory</key>
  <string>/Users/Shared/cooprompt</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/opt/node@24/bin/npm</string>
    <string>run</string>
    <string>server</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/opt/node@24/bin:/usr/bin:/bin</string>
    <key>COOPROMPT_DATA_DIR</key>
    <string>/Users/Shared/cooprompt-data</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/Shared/cooprompt/server.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/Shared/cooprompt/server.log</string>
</dict>
</plist>
```

```sh
sudo launchctl bootstrap system /Library/LaunchDaemons/dev.cooprompt.server.plist
sudo launchctl kickstart -k system/dev.cooprompt.server   # restart
```

Other variables from step 2 go in `EnvironmentVariables` or in `apps/server/.env`.

### 4. Put HTTPS in front

A reverse proxy terminates TLS and forwards to the server on `127.0.0.1`. It must:

- upgrade WebSocket connections on `/ws`;
- accept request bodies as large as the files you sync (CooPrompt syncs files up to 200 MB; the server accepts uploads up to 512 MB);
- pass the original `Host`, plus `X-Forwarded-Proto` and `X-Forwarded-Host`, so the install script points teammates at the public address.

Both clients and server send WebSocket pings every 20 to 25 seconds, so default idle timeouts of a minute or more are enough.

**Caddy** obtains certificates automatically and handles WebSocket upgrades and forwarded headers without extra configuration:

```caddyfile
cooprompt.example.com {
	reverse_proxy 127.0.0.1:4317
}
```

**nginx**:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name cooprompt.example.com;
    ssl_certificate     /etc/letsencrypt/live/cooprompt.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cooprompt.example.com/privkey.pem;

    client_max_body_size 512m;

    location / {
        proxy_pass http://127.0.0.1:4317;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

Teammates then use `https://cooprompt.example.com` as the server address and install with `curl -fsSL https://cooprompt.example.com/install | bash`. `GET /api/health` (no authentication) works as an uptime check.

### 5. Back up

The data directory holds everything: `cooprompt.db` (with its `-wal` and `-shm` files), `blobs/` and, when generated, `access-code.txt`; `tmp/` only holds uploads in progress. See [Data directory](server.md#data-directory).

While the server runs, back up the database first and the file blobs second:

```sh
sqlite3 /var/lib/cooprompt/cooprompt.db ".backup '/var/backups/cooprompt/cooprompt.db'"
rsync -a /var/lib/cooprompt/blobs/ /var/backups/cooprompt/blobs/
cp /var/lib/cooprompt/access-code.txt /var/backups/cooprompt/ 2>/dev/null || true
```

The order matters: a blob is stored before the database refers to it, and blobs are never modified or deleted, so a `blobs/` copy taken after the database snapshot contains every file the snapshot needs. Alternatively, stop the server and copy the whole directory.

To restore, stop the server, put back `cooprompt.db`, `blobs/` and `access-code.txt`, delete any `cooprompt.db-wal` and `cooprompt.db-shm` left from the replaced database, and start it again.

The directory only grows: deleted chats and replaced file versions are kept. Watch the disk space.

### 6. Upgrade

```sh
cd /opt/cooprompt
git pull
npm ci
sudo systemctl restart cooprompt-server
```

- The database schema is created and upgraded automatically at startup.
- Turns running during the restart are marked failed, and clients reconnect on their own. Upgrade when nobody's agent is working.
- CooPrompt doesn't negotiate protocol versions between apps and server. When an upgrade changes [`packages/protocol`](../packages/protocol/src/index.ts), upgrade the server and ship the matching desktop build together.

## Security checklist

- [ ] **Decide who can create accounts.** Keep an access code (on by default for the standalone server; turn it on for an embedded one) and share it privately, or accept Google accounts only: **Google accounts only** in Settings → Team server on an embedded server, `COOPROMPT_PASSWORD_AUTH=false` on a standalone one.
- [ ] **Restrict Google sign-in** to your organization: set the OAuth client's audience to **Internal** in Google Auth Platform, and list your domains (`GOOGLE_ALLOWED_DOMAINS`, or **Allowed domains** in Settings → Team server), which then accept only Google Workspace accounts of those domains.
- [ ] **Limit exposure.** On the internet, serve HTTPS through a reverse proxy and bind the server to `127.0.0.1`. Plain HTTP is only for trusted local networks. Close quick tunnels when they aren't needed.
- [ ] **Rate-limit sign-in** at the proxy (`/api/auth/`): the server has no rate limiting.
- [ ] **Protect the data directory and its backups.** Chats and shared files are stored unencrypted: restrict file permissions and use encrypted disks and backups.
- [ ] **Treat server logs as sensitive.** They include the access code at startup and the email addresses of people connecting.
- [ ] **Protect the signing identity.** Whoever has `~/.cooprompt-signing` can publish builds every teammate's CooPrompt installs as updates: keep it with the release owner, backed up, and out of servers, repositories and CI. See [Distribution](distribution.md#the-signing-identity).
- [ ] **Know the limits.** The installer endpoints are public, email addresses of password accounts are not verified, sessions don't expire, and there is no admin interface: managing accounts and sessions means editing the SQLite database (tables `users` and `sessions`) while the server is stopped.

## Shipping a new desktop build

1. **Build.** On the Mac that holds the [signing identity](distribution.md#the-signing-identity), run `npm run dist`. It gives the build the next patch version, signs it, and writes the zip and `latest-mac.json` into `apps/desktop/release/`. Commit the updated [`apps/desktop/package.json`](../apps/desktop/package.json).
2. **Publish.**
   - **Embedded host**: set **Builds to offer** in Settings → Team server to that `apps/desktop/release` folder (once; it applies without a restart). The server then offers the newest build there, and the host's own CooPrompt offers to update too. Without that folder, the host installs the new build and its server offers itself.
   - **Standalone server**: copy the zip and `latest-mac.json` into the server's `apps/desktop/release/`, or update `COOPROMPT_INSTALLER_ZIP` and `COOPROMPT_INSTALLER_VERSION` and restart it (see [Configure](#2-configure)).
3. **Check.** `curl -fsS <server>/api/health` shows the new version under `app` (hashing a new build takes a few seconds).
4. **Teammates.** Supported macOS copies show "CooPrompt <version> is available" within half an hour, or right away with **Check for updates** in Settings → Account & device. After **Update** and **Restart now**, macOS asks once for the Mac password for "CooPrompt Safe Storage" (choose **Always Allow**).

How updates are verified and installed: [Distribution](distribution.md#how-updates-reach-teammates).
