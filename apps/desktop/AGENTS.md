# AGENTS.md: @cooprompt/desktop

The Electron app: main process in `src/main`, preload bridge in `src/preload`, React UI in `src/renderer`, and code shared by both in `src/shared`. Repository-wide rules are in the [root AGENTS.md](../../AGENTS.md).

## Commands

- Run: `npm run dev` from the root. Restart it after changing `src/main` or `src/preload`; renderer changes reload in place.
- Test: `npm test -w @cooprompt/desktop`. Type-check: `npm run typecheck -w @cooprompt/desktop`.
- Package: `npm run dist` (macOS on Apple silicon only, slow). See [Distribution](../../docs/distribution.md).

## Invariants

- Every new UI string is written in English with `t()` (renderer) or `tr()` (main) and gets a Spanish entry in `ES` in [`src/shared/i18n-es.ts`](src/shared/i18n-es.ts). See [Internationalization](../../docs/development.md#internationalization).
- Secrets go only through `Secrets` ([`src/main/secrets.ts`](src/main/secrets.ts)): never into `settings.json`, never to the server, never back to the renderer (expose names or flags instead).
- The renderer has no Node access and calls the main process only through `CooPromptApi` ([`src/shared/types.ts`](src/shared/types.ts)), implemented in [`src/main/core.ts`](src/main/core.ts).
- Engines are adapters: engine-specific code stays in [`src/main/engines/`](src/main/engines) behind `EngineRunInput` and `EngineSink`; the runner and the rest of the app stay engine-neutral.
- An engine session never runs two turns at once: a turn that starts while the chat's main session is busy forks it at a `checkpoint` its engine returned, or starts a new session (`planSession` in [`src/main/runner/runner.ts`](src/main/runner/runner.ts)). An engine that can fork says so by returning checkpoints and honoring `forkAt`, never through the queue.
- A turn with `automation` set runs unattended: approval requests and questions are declined at once instead of waiting, a read-only (`plan`) automation ignores the chat's "always allow" rules, and the agent is told it runs unattended (`requestPermission`, `askQuestion` and `execute` in [`src/main/runner/runner.ts`](src/main/runner/runner.ts)). The app announces `automations` in its `hello` only because of this.
- Team-only messages reach the UI and never an agent: the runner asks for items without `include=team` (so the server sends stand-ins), `renderCatchUp` leaves `team` items out, attachments are copied for engines only from prompts and catch-up items, and `chats.sendTeam` never falls back to a message for the agent ([`src/main/team.ts`](src/main/team.ts)). The composer fails closed: with team-only on and a server that can't take it, it doesn't send (`composerMode`).
- Transcript items, streamed text and turn errors leave the computer only through the publisher ([`src/main/runner/publisher.ts`](src/main/runner/publisher.ts)), which applies redaction.
- Workspace sync must never delete other people's files because a local folder vanished: keep the pause and mass-deletion guards in [`src/main/sync/workspace-sync.ts`](src/main/sync/workspace-sync.ts). It also never follows symbolic links (it uses `lstat`), so a remote change can't be written outside the workspace.
- An update is accepted only when the download matches the announced size and SHA-256 and passes `verifyBundle` ([`src/main/updater.ts`](src/main/updater.ts)): bundle identifier, version, a valid signature and the running app's designated requirement. Don't loosen these checks, and keep `confirmLaunch` as the first thing [`src/main/index.ts`](src/main/index.ts) does, or slow startups roll back. See [Updates](../../docs/architecture.md#updates).
- The renderer loads attachments only through `cooprompt-media:` (`AttachmentStore.serve` in [`src/main/attachments.ts`](src/main/attachments.ts)), which serves media typed by their bytes: never hand it `file://` URLs or paths to load, and keep `cooprompt-media:` out of the CSP's script, frame and connect sources. Engines get attachments through `EngineRunInput.attachments`, and share media only through `EngineSink.attach`.
- Connectors reach engines only through `planServers` ([`src/main/connector-sources.ts`](src/main/connector-sources.ts)), so an engine never gets a duplicate of a server it loads natively.
- Engines that keep their own sign-in (Claude Code, Codex, the Cursor CLI) are asked through their CLIs which account they use; CooPrompt never reads their credentials. Cursor gets connectors in memory through ACP: never write them into `~/.cursor` or a chat's folder, which syncs to other people's Macs. See [Decisions](../../docs/decisions.md#27-cursor-runs-through-its-clis-acp-server-on-the-computers-own-cursor-sign-in).

## Testing

Vitest tests live in [`test/`](test) and exercise public interfaces with temporary folders and in-process servers. Coverage includes engines, connectors, workspace synchronization, attachments, automations, updates, redaction and internationalization. See [Development](../../docs/development.md#tests) for the test map and platform requirements.


## Pitfalls

- `codesign` fails on bundles assembled under `~/Desktop` (Finder metadata). `scripts/dist.mjs` builds in a temporary folder and `scripts/after-pack.cjs` strips extended attributes; keep it that way.
- Use `COOPROMPT_PROFILE=<name> npm run dev` on macOS for isolated instances with their own data, device and folders, for example to sign in with two accounts on one computer. On Windows, set `$env:COOPROMPT_PROFILE` in PowerShell before `npm run dev`. Development builds already use their own data folder (`CooPrompt Dev`) and default folders (`~/CooPrompt-Dev`). On macOS they also use a separate Keychain item and don't update unless `COOPROMPT_UPDATES=1`.
- The login shell environment is read once at startup; restart the app after changing it.
- Engine binaries come from the SDKs' platform packages, copied by `scripts/stage-engines.mjs`; [`src/main/paths.ts`](src/main/paths.ts) finds them differently in development and in packaged builds.
- `npm run dist` raises the patch `version` and writes it to [`package.json`](package.json) only after a successful build: commit that change. Updates and the embedded host's installer cache are keyed by version, so never ship two builds with the same one.
- `npm run dist` signs with the identity in `~/.cooprompt-signing`; never commit it or copy it into the repository. Without it builds are signed ad hoc and installed copies signed with the identity reject them. See [The signing identity](../../docs/distribution.md#the-signing-identity).

More: [Codebase map](../../docs/codebase-map.md#appsdesktop), [Architecture](../../docs/architecture.md), [Security](../../docs/security.md).
