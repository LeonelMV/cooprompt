# Distribution

How the macOS app is built, versioned and signed, and how it reaches teammates: installed once, then updated from the team server.

## Building

On Windows x64, `npm run dist:win -w @cooprompt/desktop` attempts to build an unsigned CooPrompt NSIS installer under `apps/desktop/release/`, including the Windows Claude and Codex binaries. This Windows build is experimental: the macOS update and server-hosted installer flows are not available for it, and some engine and connector paths still need platform validation. Windows application-control policies can block an unsigned installer or executable.

On a Mac with Apple silicon, after `npm install`:

```sh
npm run dist
```

[`apps/desktop/scripts/dist.mjs`](../apps/desktop/scripts/dist.mjs) then:

1. picks the version: the next patch version after the one in [`apps/desktop/package.json`](../apps/desktop/package.json) (`COOPROMPT_VERSION=x.y.z npm run dist` chooses another);
2. builds the main process, preload and renderer with `electron-vite build`;
3. copies the native engine binaries (Claude Code and Codex, taken from the platform packages of their SDKs in `node_modules`) into `apps/desktop/build/engines` with [`stage-engines.mjs`](../apps/desktop/scripts/stage-engines.mjs);
4. runs `electron-builder` for macOS arm64 with [`electron-builder.yml`](../apps/desktop/electron-builder.yml), writing into a temporary folder and signing as described in [Signing](#signing);
5. copies the resulting `.dmg` and `.zip` into `apps/desktop/release/` (under temporary names first, so a server never sees half a file) and writes `release/latest-mac.json` with the new version and the zip's file name;
6. once everything succeeded, writes the new version into `apps/desktop/package.json`.

Extra arguments after `--` go to electron-builder. The artifacts are `CooPrompt-<version>-arm64.dmg` and `CooPrompt-<version>-arm64-mac.zip`. The engine binaries ship in `CooPrompt.app/Contents/Resources/engines`, outside the asar archive, where [`src/main/paths.ts`](../apps/desktop/src/main/paths.ts) finds them; [`resources/update-helper.sh`](../apps/desktop/resources/update-helper.sh) ships next to them. Build outputs (`out/`, `release/`, `build/engines/`) are not committed.

### Versions

The version is what installed copies compare (numerically, `major.minor.patch`) to decide whether a build is an update, so every build you distribute needs a higher one. `npm run dist` takes care of it; commit the updated `apps/desktop/package.json` afterwards, so the next build continues from there. Use `COOPROMPT_VERSION` to jump ahead, for example to `0.2.0`.

A CooPrompt that hosts the team server zips its own app once per version (into `~/Library/Application Support/CooPrompt/installer`), another reason each build needs its own version.

### Why the build runs in a temporary folder

`codesign` refuses app bundles that carry Finder metadata ("resource fork, Finder information, or similar detritus"), which folders such as `~/Desktop` add to files. The script therefore runs electron-builder in a folder under the system temporary directory and copies the artifacts back, and [`after-pack.cjs`](../apps/desktop/scripts/after-pack.cjs) strips extended attributes from the bundle before it is signed.

## Signing

The macOS build has no Apple Developer ID: it is not notarized, runs without the hardened runtime, and targets Apple silicon and macOS 13 or later.

[`scripts/sign.cjs`](../apps/desktop/scripts/sign.cjs), electron-builder's signing hook, signs every build with the **CooPrompt signing identity** when `~/.cooprompt-signing` (or `$COOPROMPT_SIGNING_DIR`) holds one, and ad hoc otherwise. It imports the identity into a throwaway keychain under a temporary home folder, so your own keychains are never touched. Installed copies only accept updates signed like they are (see [How updates reach teammates](#how-updates-reach-teammates)), so build every release with the same identity.

### The signing identity

Create it once, on the Mac that builds releases:

```sh
npm run signing-identity -w @cooprompt/desktop
```

[`scripts/signing-identity.mjs`](../apps/desktop/scripts/signing-identity.mjs) uses only tools that ship with macOS to create a self-signed code-signing certificate ("CooPrompt Signing", valid for 20 years) and its key, saved as `identity.p12` (with its password in `p12.pass`) in `~/.cooprompt-signing`, readable only by you. It never overwrites an existing identity, and it prints the certificate's SHA-1 fingerprint.

- **Back up that folder**, for example in a password manager or on an encrypted disk.
- **Keep it private.** Whoever has it can sign builds that every teammate's CooPrompt accepts as updates. It belongs to whoever publishes releases, not to the repository or CI.
- **If it is lost**, builds signed with a new identity are rejected as updates. Every teammate reinstalls once with the one-line installer, and updates work again from then on.

### What macOS does with these signatures

- A copy downloaded with a browser carries the quarantine flag, and macOS refuses to open it the first time. The user allows it in System Settings → Privacy & Security → **Open Anyway**, or removes the flag with `xattr -dr com.apple.quarantine /Applications/CooPrompt.app`.
- A copy installed by the one-line installer or by an update is not quarantined, so it opens directly.
- After each update or new install, macOS asks once for the Mac password so CooPrompt can use its "CooPrompt Safe Storage" Keychain item: without an Apple-issued certificate, every build is a new app to the Keychain. Choose **Always Allow**. If access is denied, CooPrompt treats the stored secrets, including the session, as missing.

See [Security](security.md#signing-and-updates) for what this means for trust.

## How teammates install

1. **From a team server hosted in CooPrompt.** The host's CooPrompt serves a zip of itself, or the newest build in the folder set under **Builds to offer** in Settings → Team server. Teammates run `curl -fsSL <server>/install | bash` (or `/instalar` in Spanish); Settings → Team server shows the command and a ready-to-send message.
2. **From a standalone server.** The server serves the build that `apps/desktop/release/latest-mac.json` names, so running `npm run dist` on the server's machine is enough to publish a new build; `COOPROMPT_INSTALLER_ZIP` serves another zip instead. Teammates use the same command.
3. **Manually.** Share the `.zip` or `.dmg` from `apps/desktop/release/` (or `<server>/download/CooPrompt.zip`); recipients move `CooPrompt.app` to `/Applications` and use **Open Anyway** the first time.

The installer script ([`apps/server/src/installer.ts`](../apps/server/src/installer.ts)) requires an Apple silicon Mac, quits a running CooPrompt, replaces `CooPrompt.app` in `/Applications` (or `~/Applications`, or `$COOPROMPT_INSTALL_DIR`), clears its extended attributes, and on the first install writes the server address and the inviter's language into CooPrompt's settings. Re-running it installs the build the server currently serves and keeps the existing settings. To point an existing installation at another address of the same server, use Settings → Account & device → **Change**; for a different server, sign out and enter its address on the sign-in screen. When a host's tunnel gets a new address, CooPrompt offers **Copy message for the team** with reconnection steps and the installation command.

CooPrompt uses its own application identifier, data directories, environment variables and workspace ignore file. Installing it does not automatically import another application's settings, credentials, server database or workspace preferences; configure those explicitly before using an existing workspace.

## How updates reach teammates

1. **The server announces its build.** `GET /api/health` includes `app`: the version, SHA-256 and size of the exact zip `/download/CooPrompt.zip` serves, computed by the server. A zip whose version the server doesn't know is served but not announced. Which build that is depends on the server; see [Team server](server.md).
2. **CooPrompt checks** 10 seconds after it starts, every 30 minutes, after reconnecting to the server, after signing in or changing the server address, and on demand with **Check for updates** in Settings → Account & device. A newer version appears as a banner at the top of the sidebar, with a notification when CooPrompt is in the background.
3. **Update** downloads the zip with a progress bar and verifies it: the exact size and SHA-256 the server announced, then the app inside, which must have the same bundle identifier, the announced version, a valid signature, and a signature from the same identity as the running app. An installation signed ad hoc can only require the bundle identifier.
4. **Restart now** hands the verified app to [`update-helper.sh`](../apps/desktop/resources/update-helper.sh) and quits. The helper waits for CooPrompt to exit, puts the new app in place (or in `~/Applications` when the original folder isn't writable; the old copy then opens the new one), and opens it. If the new version doesn't confirm it started within two minutes, the helper puts the previous version back and reopens it. The next launch shows how the update went.
5. **Hosts and running turns.** When this CooPrompt runs turns, or hosts a server where someone's turn is running, the restart waits until they finish (**Restart anyway** skips the wait). Before a host's server goes down, it tells connected apps it is restarting to update; they reconnect within seconds and are offered the new build if the host serves it.

Development builds and `COOPROMPT_PROFILE` instances don't update ([Development](development.md#running-the-app)).

The procedure for publishing a build through each kind of server is in [Deployment](deployment.md#shipping-a-new-desktop-build); the internals are in [Architecture](architecture.md#updates).
