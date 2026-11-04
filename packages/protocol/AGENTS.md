# AGENTS.md: @cooprompt/protocol

The wire contract between the team server and the desktop app: [`src/index.ts`](src/index.ts), which also re-exports the automation types and schedule logic of [`src/automations.ts`](src/automations.ts), imported as TypeScript source by both (no build step). Repository-wide rules are in the [root AGENTS.md](../../AGENTS.md).

## Commands

- Type-check: `npm run typecheck -w @cooprompt/protocol`.
- There are no tests in this package; the contract is exercised by `npm test -w @cooprompt/server` and `npm test -w @cooprompt/desktop`.

## Invariants

- **Stay compatible with older apps and servers.** Installed apps and servers are updated at different times. Add optional fields; don't rename or remove fields or message types, or change what they mean. Older apps ignore unknown server message types; older servers answer unknown client message types with an error.
- Keep the files free of dependencies and of Node-, Electron- or DOM-specific APIs: the server, the main process and the renderer all import them.
- Keep the helpers strict: `normalizeWorkspacePath` is what keeps workspace paths relative and inside the workspace root, `orgDomainFromEmail` decides organization membership, `sanitizeFileName` and `sniffMedia` decide an attachment's name and whether its bytes are media the app may show, and `nextRun` and `scheduleError` decide when automations run on the server and what the editor previews.
- Text meant for people (notices, errors) travels in English; clients localize it.
- `PROTOCOL_VERSION` is reported by `/api/health`; clients don't check it.

## When you change it

- A client-to-server message is handled in `Hub.onMessage` in `apps/server/src/hub.ts`.
- A server-to-client message is handled in `AppCore.onServerMessage` in `apps/desktop/src/main/core.ts` and in `handleServer` in `apps/desktop/src/renderer/src/lib/store.ts`.
- A new `ItemKind` also needs `EXECUTOR_ITEM_KINDS` in the hub and rendering in `Transcript.tsx`. Older apps get it too: they show an item without a turn as a line of its `text` and leave kinds they don't know out of their agent's context. Content older apps must not hand to an agent needs a stand-in, as team-only messages have (`teamStandIns` in the server).
- Cover the change in `apps/server/test/collaboration.test.ts`.

More: [Codebase map](../../docs/codebase-map.md#start-here-for-common-changes), [Architecture](../../docs/architecture.md).
