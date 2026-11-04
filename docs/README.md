# CooPrompt documentation

Which page to read for what. The project overview and installation steps are in the [root README](../README.md).

## By role

| You want to… | Read, in order |
| --- | --- |
| Use CooPrompt with your team | [Install](../README.md#install-cooprompt-teammates) → [Usage](usage.md) → [Multiplayer](multiplayer.md) |
| Host a team server | [Deployment](deployment.md) → [Team server](server.md) → [Security](security.md) |
| Deploy the team server on your own infrastructure | [`deploy/AGENTS.md`](../deploy/AGENTS.md) → [Team server](server.md) → [Deployment](deployment.md) |
| Ship a new build to teammates | [Distribution](distribution.md) → [Deployment: shipping a new build](deployment.md#shipping-a-new-desktop-build) → [Updating CooPrompt](usage.md#updating-cooprompt) |
| Contribute code | [Development](development.md) → [Codebase map](codebase-map.md) → [Architecture](architecture.md) → [Decisions](decisions.md) → [AGENTS.md](../AGENTS.md) |
| Review security | [Security](security.md) → [Decisions](decisions.md) → [Team server endpoints](server.md#endpoints) |
| Point an AI assistant at the project | [`llms.txt`](../llms.txt) → [AGENTS.md](../AGENTS.md) and the package `AGENTS.md` files → [Codebase map](codebase-map.md) → [Glossary](glossary.md) |

## All pages

| Page | Covers |
| --- | --- |
| [Usage](usage.md) | End-user guide: first run, models and keys, chats, the composer, folders, approvals, connectors, settings, troubleshooting. |
| [Multiplayer](multiplayer.md) | Chat types, organizations, invitations, presence, turns and multitask, team-only messages, permission modes, approvals and questions, cancelling and interrupting, shared workspaces, running on your other computers. |
| [Automations](automations.md) | Saved instructions that run on a schedule, unattended, on the owner's computer: the editor, schedules, permissions, missed runs and catch-ups, the inbox, who sees what. |
| [Connectors](connectors.md) | MCP transports, importing from other apps, what each engine receives, OAuth, the catalog. |
| [Security](security.md) | Where credentials live, what the server stores, redaction, accounts and sessions, authorization, network exposure, signing and update verification. |
| [Team server](server.md) | Reference: hosting options, environment variables, data directory, endpoints, limits. |
| [Deployment](deployment.md) | Playbooks: hosting on a teammate's computer, an always-on server (service, HTTPS, backups, upgrades), security checklist, shipping builds. |
| [Distribution](distribution.md) | Building and signing the macOS app, versions, the signing identity, how teammates install and get updates. |
| [Architecture](architecture.md) | Components, state, how a turn flows, failure handling, context handoff, session continuity, workspace sync. |
| [Decisions](decisions.md) | The key design decisions with their context and consequences. |
| [Codebase map](codebase-map.md) | Which file owns each responsibility, the main flows, and where to start for common changes. |
| [Glossary](glossary.md) | Domain terms and the code identifiers behind them. |
| [Development](development.md) | Setup, scripts, running the app, isolated instances, tests, internationalization. |

Instructions for coding agents live next to the code: [`AGENTS.md`](../AGENTS.md) at the root and in [`packages/protocol`](../packages/protocol/AGENTS.md), [`apps/server`](../apps/server/AGENTS.md), [`apps/desktop`](../apps/desktop/AGENTS.md) and [`deploy`](../deploy/AGENTS.md), each with a `CLAUDE.md` that imports it.

## Conventions for these docs

- Each topic has one owning page; other pages link to it instead of repeating it.
- Pages describe behavior and interfaces, and point to the source file that owns each behavior.
- Everything is in English and must match the code. When you change a documented behavior, update its page in the same change.
