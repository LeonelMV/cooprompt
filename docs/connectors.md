# Connectors (MCP)

CooPrompt gives MCP servers ("connectors") to every engine: Claude Code, Codex and Cursor. You manage them in **Settings → MCP connectors**. Connectors are configured per computer: a turn uses the connectors of the computer that runs it, and teammates never share connectors or their credentials.

The behavior described here lives in [`src/main/connectors.ts`](../apps/desktop/src/main/connectors.ts) (storage, testing, OAuth, what each engine gets), [`src/main/connector-sources.ts`](../apps/desktop/src/main/connector-sources.ts) (reading other apps' definitions).

## Transports

| Type | Configuration |
| --- | --- |
| Local (stdio) | Command, arguments and environment variables. Imported definitions can also carry a working folder and a list of variables passed through from your environment. |
| Remote (streamable HTTP) | URL and optional headers. |
| Remote (SSE) | URL and optional headers. |

Environment variables, headers and OAuth tokens are stored in CooPrompt's encrypted secret store; the rest of the definition is a regular setting. After saving, the form only shows the names of stored variables and headers; typing new values replaces them. Connector names are limited to letters, digits, `-` and `_`, and made unique.

For each connector you can:

- turn it on or off;
- **Test** it: CooPrompt connects, lists its tools and reports the result (or suggests **Connect** when the server requires sign-in). A local server gets up to two minutes, so `npx` can download it the first time; when one fails to start, the result includes the error line it printed (such as the Node.js version it needs), or says that its command isn't installed;
- **Connect** (remote connectors): sign in with OAuth, see [below](#oauth);
- edit or delete it.

## Importing from other apps

The **Import from Claude, Codex and your other apps** list shows the MCP servers defined on your computer:

| Source | What CooPrompt reads |
| --- | --- |
| Claude Code | `mcpServers` in `~/.claude.json`, and the servers of the plugins enabled in `~/.claude/settings.json` |
| Codex | `[mcp_servers]` in `config.toml` (in `$CODEX_HOME`, by default `~/.codex`), and the servers of the plugins enabled under `[plugins]` |
| Cursor | `~/.cursor/mcp.json` (which the Cursor CLI loads on its own), and the plugins in Cursor's plugin cache (which only the Cursor editor loads) |
| Claude Desktop | `claude_desktop_config.json`, and the installed desktop extensions with the settings saved in Claude; the config is read from `~/Library/Application Support/Claude` on macOS and `%APPDATA%\Claude` on Windows |

The list shows user-level definitions. The reader also handles project-scoped ones (Claude Code's per-project servers and plugins, and a project's `.mcp.json`) when given a project folder.

Definitions are resolved the way their apps do it:

- `${VAR}` and `${VAR:-default}` placeholders expand from your login shell environment, plus `${CLAUDE_PLUGIN_ROOT}` and `${CURSOR_PLUGIN_ROOT}` for plugins, and the desktop extension variables (`${__dirname}`, `${user_config.*}` and the like) for Claude Desktop.
- Codex's `bearer_token_env_var`, `env_http_headers` and `env_vars` read their values from your environment.
- Relative commands and working folders resolve against the folder of the plugin or configuration file that defines them.

Each entry shows badges:

- **native in Claude / Codex / Cursor**: that engine already loads this definition on its own (Claude: Claude Code's servers and plugins, and project `.mcp.json` files; Codex: its `config.toml` and plugins; Cursor: `~/.cursor/mcp.json`). Nothing needs importing for that engine; importing makes the server available to the other engines too.
- **off in …**: disabled in the app it comes from.
- **missing …**: it references environment variables that aren't defined on this computer.
- **imported**: CooPrompt already has it.

**Import** copies a definition into CooPrompt, moving its variables and headers into the secret store. It is a copy: later edits in the other app are not picked up. **Import all** imports every definition that is enabled where it comes from, has no missing variables and isn't in CooPrompt yet, once per server: definitions with the same URL or the same command line count as one server.

## What each engine receives

When a turn starts, CooPrompt passes its enabled connectors to the engine that runs it, without duplicating what the engine loads by itself:

- A connector that matches a server the engine already loads natively (same URL, ignoring case and trailing slashes, or same command line) is left out, so the engine uses its own copy.
- Exception: when CooPrompt holds an OAuth token for that server, it passes its copy under the engine's own name for it, which replaces the engine's copy instead of adding a second one.
- A server that is turned off in the engine's own configuration but enabled in CooPrompt is passed.
- Remote connectors signed in with OAuth get an `Authorization: Bearer` header, refreshed shortly before the token expires.
- Claude has no working-folder setting for local servers, so CooPrompt starts those through a small shell wrapper that enters the folder first. Codex receives connectors as `mcp_servers` configuration overrides, with names reduced to the characters Codex accepts.
- Codex starts a turn without waiting for its MCP servers and silently leaves out any still starting, as `npx` servers often are. So CooPrompt gives them a startup grace (`mcp_optional_startup_grace_ms`, 20 seconds): Codex's first model call waits until they are ready. A server that fails to start or needs sign-in doesn't hold the turn up; Codex leaves it out and the turn goes on without its tools. One that hangs delays the turn by the grace. Codex doesn't report which servers it left out, so check a connector that doesn't seem to work with **Test**.

- Cursor receives connectors as the MCP servers of that turn's ACP session, in memory: CooPrompt writes nothing to the chat's folder (whose `.cursor/mcp.json` would sync to other people's computers) or to `~/.cursor`. A connector with Cursor's name for one of its own servers replaces it for the turn. Cursor still loads `~/.cursor/mcp.json` and the project `.cursor/mcp.json` servers you approved in its CLI. It asks before using connector tools, through the usual cards, except with "No restrictions".

The planning rule is `planServers` in [`connector-sources.ts`](../apps/desktop/src/main/connector-sources.ts); the Codex overrides are built in [`engines/codex.ts`](../apps/desktop/src/main/engines/codex.ts) and Cursor's session servers in [`engines/cursor.ts`](../apps/desktop/src/main/engines/cursor.ts). After a turn, the chat's Agent tab lists the MCP servers the engine loaded and their status.

## Codex and connector tool approvals

CooPrompt runs Codex with approval prompts off, because it can't answer them, and Codex refuses any MCP tool call that needs an approval when it can't ask ("MCP tool call requires approval, but approval policy is never"). So the permission mode decides for every MCP server and app Codex uses, wherever it comes from: the connectors CooPrompt passes, the servers in your own Codex `config.toml`, those of your enabled Codex plugins, and the apps of the ChatGPT account Codex signs in with, such as Slack or GitHub. CooPrompt adds its setting to their entries in Codex's configuration for that turn only; your files aren't changed.

- Except in "Plan only", their tools are approved up front. What you set in Codex for a single tool is kept, so a tool you set to always ask is still refused.
- In "Plan only", only the tools their server marks as read-only run, even ones you approved for good in Codex ("Allow and don't ask me again").

Rules your organization manages for Codex still apply. Approvals that come from Codex's own plugins, such as the sites Browser Use and Computer Use ask to open, can't be answered either, so they are declined ("The user declined…"): for browser work use the [browser connectors](usage.md#testing-in-the-browser). Claude and Cursor still ask before using connector tools according to the [permission mode](multiplayer.md#permission-modes). The consequences are in [Security](security.md#agents-act-as-the-person-who-runs-the-turn).

## OAuth

**Connect** runs the MCP authorization flow in your browser: server metadata discovery, PKCE, and dynamic client registration unless the definition brings a pre-registered client id (some plugins do, such as Slack's, for servers without dynamic registration). The browser returns to a temporary local listener: `http://127.0.0.1:33418/callback` (another free port if that one is busy), or `http://localhost:<port>/callback` with the definition's callback port for pre-registered clients, which only accept the address they were registered with. The client registration and tokens are stored in the secret store, per connector. Tokens are refreshed automatically; if a token can no longer be refreshed, use **Connect** again.

Every attempt creates a new random `state` (128 bits), which the MCP SDK adds to the authorization request, and the listener accepts only the callback that brings it back. Any other request to the callback address gets an error page and the sign-in keeps waiting, so a web page that hits the port can neither complete nor break it. CooPrompt waits up to five minutes for the browser, and declining there ends the attempt with "Sign-in was cancelled in the browser." When an attempt ends, the listener also drops the connections the browser keeps open, so trying again right away on the same port works. The flow is `connectOAuth` in [`connectors.ts`](../apps/desktop/src/main/connectors.ts), with the listener in [`loopback.ts`](../apps/desktop/src/main/loopback.ts).

## Catalog

The **Catalog** section offers connectors that work with one click, defined in [`src/shared/connector-directory.ts`](../apps/desktop/src/shared/connector-directory.ts).

**On this computer** lists local servers that run through `npx`, so they need Node.js: browsers the agent can drive to test an app, and Chrome DevTools for debugging (see [Testing in the browser](usage.md#testing-in-the-browser)). Adding one saves it and runs **Test**, which downloads it the first time. An entry can also link to something to install first, such as the Playwright Extension for **Playwright in your Chrome**, which CooPrompt opens after adding it.

**Remote** lists official remote MCP servers. Each entry declares how you sign in:

- **With your account**: OAuth with dynamic client registration. Adding it saves the connector and opens your browser to sign in.
- **No account needed**: added directly.
- **Personal token**: opens the form with the header to fill in and where to get the token.

Entries you already have (the same URL, or the same command and arguments) show as added. To offer another server, add an entry to `CONNECTOR_DIRECTORY`.
