# AGENTS.md

Instructions for coding agents working on this repository. What CooPrompt is and how it works is documented in [`docs/`](docs/README.md); read the page that owns an area before changing it, and update it when you change the behavior it describes. Each package adds its own rules in an `AGENTS.md` next to its code: [`packages/protocol`](packages/protocol/AGENTS.md), [`apps/server`](apps/server/AGENTS.md), [`apps/desktop`](apps/desktop/AGENTS.md).

## Commands

- Setup: `nvm use && npm install` (Node 24, see [`.nvmrc`](.nvmrc)).
- Type-check: `npm run typecheck`.
- Test: `npm test`. Target a workspace with `-w @cooprompt/server` or `-w @cooprompt/desktop`; pass a file after `--`.
- Run: `npm run dev` (desktop app), `npm run server:dev` (standalone server).
- Package: `npm run dist` (slow; see [docs/distribution.md](docs/distribution.md)).

Run the type-check and the tests before considering a change done. Details: [docs/development.md](docs/development.md).

## Internationalization

Every new user-facing string must be written in English and get a Spanish entry in `ES` in [`apps/desktop/src/shared/i18n-es.ts`](apps/desktop/src/shared/i18n-es.ts). English messages produced by the server, the engines or the runner need a template in `ES_MESSAGES` in the same file. Rules: [docs/development.md#internationalization](docs/development.md#internationalization).

## Code conventions

- TypeScript in strict mode, ES modules, local imports with explicit `.ts`/`.tsx` extensions. The protocol and the server run from source; there is no build step for them.
- The wire contract (HTTP payloads and WebSocket messages) lives in [`packages/protocol/src/index.ts`](packages/protocol/src/index.ts). Change it there and keep the server and the desktop app in step.
- The server validates every request and enforces who may do what; clients are not trusted.
- Credentials never go to the server. Store secrets through `Secrets` ([`apps/desktop/src/main/secrets.ts`](apps/desktop/src/main/secrets.ts)), never in `settings.json`, and give the renderer only names or flags (for example `hasKey`), never values.
- The renderer reaches the main process only through the `CooPromptApi` method table in [`apps/desktop/src/shared/types.ts`](apps/desktop/src/shared/types.ts), implemented by `AppCore` in [`apps/desktop/src/main/core.ts`](apps/desktop/src/main/core.ts).
- Text produced by the server, the engines and the runner is English; clients localize it.
- Match the surrounding style: 2-space indentation, single quotes, semicolons. No formatter or linter is configured. Comments explain constraints the code can't show.
- Tests use Vitest in each app's `test/` folder and exercise public interfaces with a real in-process server and temporary folders; internal modules are not mocked.
- Never commit build outputs (`out/`, `release/`, `apps/desktop/build/engines/`) or `.env` files, and never copy the release signing identity (`~/.cooprompt-signing`) into the repository.

## Documentation map

Start with [docs/codebase-map.md](docs/codebase-map.md) to find the file that owns a behavior and the "start here" path for common changes; [docs/glossary.md](docs/glossary.md) defines the domain terms and [docs/decisions.md](docs/decisions.md) explains the design choices you should not undo by accident. The full index is [docs/README.md](docs/README.md) (and [`llms.txt`](llms.txt) for AI tools).

- [docs/architecture.md](docs/architecture.md): components, turn flow, context handoff, session continuity, workspace sync, updates.
- [docs/multiplayer.md](docs/multiplayer.md): chat types, invitations, permissions, cancelling and interrupting, shared workspaces.
- [docs/security.md](docs/security.md): secrets, what the server stores, redaction, accounts, network exposure.
- [docs/automations.md](docs/automations.md): automations: schedules, unattended runs and their permissions, missed runs and catch-ups, the inbox, who sees what.
- [docs/connectors.md](docs/connectors.md): MCP connectors, import sources, engine planning, OAuth, catalog.
- [docs/server.md](docs/server.md): server reference: environment variables, endpoints, data directory.
- [docs/deployment.md](docs/deployment.md): hosting playbooks, backups, upgrades, security checklist.
- [deploy/AGENTS.md](deploy/AGENTS.md): placeholder for an organization-specific deployment playbook
- [docs/distribution.md](docs/distribution.md): packaging, signing and the signing identity, versions, installation, updates.
- [docs/development.md](docs/development.md): setup, scripts, tests, i18n, `COOPROMPT_PROFILE`.
- [docs/usage.md](docs/usage.md): what users see and do, troubleshooting.
