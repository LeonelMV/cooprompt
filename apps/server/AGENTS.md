# AGENTS.md: @cooprompt/server

The team server: Fastify HTTP API, WebSocket hub and SQLite storage on `node:sqlite`, run from TypeScript source with `tsx`. The desktop app embeds it through `createCooPromptServer` in [`src/server.ts`](src/server.ts). Repository-wide rules are in the [root AGENTS.md](../../AGENTS.md).

## Commands

- Run: `npm run server:dev` from the root (reloads on changes; configured by `apps/server/.env`, see [`.env.example`](.env.example)).
- Test: `npm test -w @cooprompt/server`. Type-check: `npm run typecheck -w @cooprompt/server`.
- Node 24 is required (`nvm use`) for the built-in `node:sqlite`.

## Invariants

- Validate every input and check access with the helpers in [`src/routes.ts`](src/routes.ts) (`text()`, `currentUser`, `viewableChat`, `memberChat`), failing with `HttpError`.
- Messages for people (errors, notices) are English. Each new one needs a template in `ES_MESSAGES` in `apps/desktop/src/shared/i18n-es.ts`.
- The server never handles model credentials and stores only hashes of passwords and session tokens.
- A Google sign-in gets an existing account by email only when Google vouches for the address (`ownsEmail` in [`src/auth.ts`](src/auth.ts): a Workspace `hd` or Gmail), and then the account's password and sessions go. Allowed domains match `hd`, never the address alone. Don't relax either; see [Decisions](../../docs/decisions.md#23-the-owner-google-confirms-wins-the-account).
- Only the device running a turn may publish its items, and prompts are created only through the HTTP API.
- No queued turn skips the line (`scheduleChat` in [`src/hub.ts`](src/hub.ts)), and a multitask turn is only kept as such for a device that announced `parallel-turns` (`runsParallelTurns`): older apps resume one engine session per chat and must never run two turns at once.
- Team-only messages (`team` items) never become turns: only `POST /api/chats/:id/team-messages` creates them and executors can't publish them. Their content goes only to connections that announced `team-messages` and to item requests with `include=team`; everyone else, the app's runner included, gets `teamStandIns` ([`src/team.ts`](src/team.ts)), so no app's agent can get the content whatever that app does with items. See [Decisions](../../docs/decisions.md#30-team-only-messages-are-kept-from-agents-by-the-server).
- Attachments are for the chat's members only, typed from their bytes and never served as active documents (`nosniff`, a sandboxing CSP, plain files as octet streams), and an executor's items may only reference that chat's attachments ([`src/attachments.ts`](src/attachments.ts)).
- Automation runs are turns of their owner, sent only to the device the owner chose and only when it announced `automations` (`hasFeature`): an app that predates them would wait for approvals nobody can give. Only the owner changes, runs or deletes an automation ([`src/automation-routes.ts`](src/automation-routes.ts)); the scheduler in [`src/automations.ts`](src/automations.ts) never runs one twice at once. See [Automations](../../docs/automations.md).
- Schema changes are additive and applied at startup in [`src/db.ts`](src/db.ts): existing data directories, including embedded hosts', must keep working.
- Keep [`src/server.ts`](src/server.ts) free of process-level concerns (reading the environment, handling signals); they belong in [`src/cli.ts`](src/cli.ts), because the desktop app embeds the server.
- Protocol changes follow [`packages/protocol/AGENTS.md`](../../packages/protocol/AGENTS.md).

## Testing

Tests start a real server in-process with a temporary data folder and a random port. Use `startServer()`, `api()`, `register()` and `TestSocket` from [`test/helpers.ts`](test/helpers.ts) and assert on HTTP responses and WebSocket messages; `TestSocket.closed` resolves with the close code (4401 when the user's sessions were revoked). Desktop tests (`workspace-sync.test.ts`, `google-sign-in.test.ts`) import these helpers too, so keep their API stable.

Google sign-in is tested against `FakeGoogle` from [`test/fake-google.ts`](test/fake-google.ts), a stand-in for Google's authorization (with PKCE), token and signing-key endpoints. `startServer({ google: fake.config(['acme.com']), passwordAuth })` points the server at it. `fake.authorize()` gets a code the way a browser would, while the app's flow uses `fake.browser` and `fake.authorizationEndpoint`. Set `fake.account` for who signs in, `fake.claims` or `fake.foreignKey` for bad ID tokens and `fake.deny` for a refused consent, and change the sign-in options mid-test with `server.setAuth()`. No test reaches Google.

## Pitfalls

- An embedded host on the same Mac also defaults to port 4317; set `PORT` for a second server.
- Live state (connections, presence, streaming drafts) is in memory: restarting the server fails running turns.

Reference: [Team server](../../docs/server.md), [Codebase map](../../docs/codebase-map.md#appsserver).
