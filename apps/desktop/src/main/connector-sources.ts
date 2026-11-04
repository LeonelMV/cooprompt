import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { EngineId } from '@cooprompt/protocol';
import type { ConnectorTransport, DetectedSource } from '../shared/types.ts';
import type { McpServerSpec } from './engines/types.ts';

/** An MCP server defined by another app on this computer (Claude Code, Claude Desktop, Codex, Cursor) or the project. */
export interface ExternalServer {
  /** Stable across reads: `${source}:${scope}:${name}`. */
  key: string;
  source: DetectedSource;
  /** Where it was found, e.g. "Claude Code · Notion plugin". */
  origin: string;
  name: string;
  /** Name the engine itself gives it; passing a server under that name replaces the engine's copy. */
  nativeName: string;
  /** Engines that load this definition on their own. */
  nativeFor: EngineId[];
  enabled: boolean;
  transport: ConnectorTransport;
  command?: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  /** Variables passed through from the environment (Codex `env_vars`). */
  envVars: string[];
  url?: string;
  headers: Record<string, string>;
  /** Pre-registered OAuth client for servers without dynamic client registration. */
  oauth?: { clientId: string; callbackPort?: number };
  /** Variables the definition needs that are not defined on this computer. */
  missingEnv: string[];
}

export interface SourceContext {
  home: string;
  cwd: string | null;
  env: Record<string, string>;
}

type Raw = Record<string, unknown>;
type Vars = Record<string, string | string[] | undefined>;

const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
const record = (value: unknown): Record<string, string> => (isObject(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)])) : {});

async function readJson(path: string): Promise<Raw | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readToml(path: string): Promise<Raw | null> {
  try {
    return parseToml(await readFile(path, 'utf8')) as Raw;
  } catch {
    return null;
  }
}

async function subdirectories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

/** Plugin caches keep one folder per version; the newest one is the installed one. */
async function newestDirectory(path: string): Promise<string | null> {
  let best: { dir: string; time: number } | null = null;
  for (const dir of await subdirectories(path)) {
    const time = (await stat(dir).catch(() => null))?.mtimeMs ?? 0;
    if (!best || time > best.time) best = { dir, time };
  }
  return best?.dir ?? null;
}

const PLACEHOLDER = /\$\{([A-Za-z_][\w.]*)(?::-([^}]*))?\}/g;

/** Expands `${VAR}` and `${VAR:-default}` the way Claude Code, Cursor and MCP bundles do. */
function expand(value: string, vars: Vars, missing: Set<string>): string {
  return value.replace(PLACEHOLDER, (_match, name: string, fallback?: string) => {
    const found = vars[name];
    if (Array.isArray(found)) return found.join(' ');
    if (found) return found;
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return '';
  });
}

function expandArgs(args: string[], vars: Vars, missing: Set<string>): string[] {
  return args.flatMap((arg) => {
    const whole = /^\$\{([A-Za-z_][\w.]*)\}$/.exec(arg);
    const list = whole ? vars[whole[1]] : undefined;
    return Array.isArray(list) ? list : [expand(arg, vars, missing)];
  });
}

interface Definition {
  source: DetectedSource;
  scope: string;
  origin: string;
  name: string;
  nativeName?: string;
  nativeFor: EngineId[];
  raw: Raw;
  vars: Vars;
  /** Relative commands and working folders resolve against it. */
  baseDir?: string;
  env: Record<string, string>;
}

function toServer(definition: Definition): ExternalServer {
  const { raw, vars, env } = definition;
  const missing = new Set<string>();
  const url = typeof raw.url === 'string' ? expand(raw.url, vars, missing) : undefined;
  const type = String(raw.type ?? raw.transport ?? '').toLowerCase();
  const transport: ConnectorTransport = url ? (type === 'sse' ? 'sse' : 'http') : 'stdio';

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...record(raw.headers), ...record(raw.http_headers) })) headers[key] = expand(value, vars, missing);
  for (const [header, variable] of Object.entries(record(raw.env_http_headers))) {
    if (env[variable]) headers[header] = env[variable];
    else missing.add(variable);
  }
  if (typeof raw.bearer_token_env_var === 'string') {
    const token = env[raw.bearer_token_env_var];
    if (token) headers.Authorization = `Bearer ${token}`;
    else missing.add(raw.bearer_token_env_var);
  }

  const cwdRaw = typeof raw.cwd === 'string' ? expand(raw.cwd, vars, missing) : undefined;
  const cwd = cwdRaw ? (isAbsolute(cwdRaw) ? cwdRaw : resolve(definition.baseDir ?? '/', cwdRaw)) : undefined;
  let command = typeof raw.command === 'string' ? expand(raw.command, vars, missing) : undefined;
  if (command && /^\.\.?[\\/]/.test(command)) command = resolve(cwd ?? definition.baseDir ?? '/', command);
  else if (command && definition.baseDir && command.startsWith(definition.baseDir)) command = normalize(command);

  const envVars = strings(raw.env_vars);
  for (const variable of envVars) if (!(variable in env)) missing.add(variable);

  const oauth = isObject(raw.oauth) && typeof raw.oauth.clientId === 'string' ? { clientId: raw.oauth.clientId, callbackPort: typeof raw.oauth.callbackPort === 'number' ? raw.oauth.callbackPort : undefined } : undefined;

  return {
    key: `${definition.source}:${definition.scope}:${definition.name}`,
    source: definition.source,
    origin: definition.origin,
    name: definition.name,
    nativeName: definition.nativeName ?? definition.name,
    nativeFor: definition.nativeFor,
    enabled: raw.enabled !== false && raw.disabled !== true,
    transport,
    command,
    args: expandArgs(strings(raw.args), vars, missing).map((arg) => definition.baseDir && arg.startsWith(definition.baseDir) ? normalize(arg) : arg),
    cwd,
    env: Object.fromEntries(Object.entries(record(raw.env)).map(([key, value]) => [key, expand(value, vars, missing)])),
    envVars,
    url,
    headers,
    oauth,
    missingEnv: [...missing],
  };
}

/** `.mcp.json` files hold either `{ mcpServers: {...} }` or the server map itself. */
function serverMap(value: unknown): Record<string, Raw> {
  const map = isObject(value) && isObject(value.mcpServers) ? value.mcpServers : value;
  if (!isObject(map)) return {};
  return Object.fromEntries(Object.entries(map).filter((entry): entry is [string, Raw] => isObject(entry[1]) && (typeof entry[1].command === 'string' || typeof entry[1].url === 'string')));
}

/** A plugin manifest declares servers inline, as a file path, or a list of either; otherwise a root `.mcp.json` applies. */
async function pluginServers(root: string, declared: unknown, fallbacks: string[]): Promise<Record<string, Raw>> {
  const entries = declared === undefined ? fallbacks : Array.isArray(declared) ? declared : [declared];
  const result: Record<string, Raw> = {};
  for (const entry of entries) {
    const value = typeof entry === 'string' ? await readJson(resolve(root, entry)) : entry;
    Object.assign(result, serverMap(value));
  }
  return result;
}

async function claudeCode(ctx: SourceContext): Promise<ExternalServer[]> {
  const config = await readJson(join(ctx.home, '.claude.json'));
  const servers: ExternalServer[] = [];
  const add = (scope: string, map: Record<string, Raw>) => {
    for (const [name, raw] of Object.entries(map)) {
      servers.push(toServer({ source: 'claude-code', scope, origin: 'Claude Code', name, nativeFor: ['claude'], raw, vars: ctx.env, env: ctx.env, baseDir: ctx.home }));
    }
  };
  add('user', serverMap(config?.mcpServers));
  const projects = isObject(config?.projects) ? config.projects : {};
  if (ctx.cwd && isObject(projects[ctx.cwd])) add('local', serverMap((projects[ctx.cwd] as Raw).mcpServers));
  return servers;
}

async function claudePlugins(ctx: SourceContext): Promise<ExternalServer[]> {
  const settingsFiles = [join(ctx.home, '.claude/settings.json'), ...(ctx.cwd ? [join(ctx.cwd, '.claude/settings.json'), join(ctx.cwd, '.claude/settings.local.json')] : [])];
  const enabled = new Map<string, boolean>();
  for (const file of settingsFiles) {
    const plugins = (await readJson(file))?.enabledPlugins;
    if (isObject(plugins)) for (const [id, on] of Object.entries(plugins)) enabled.set(id, on === true);
  }
  const installed = (await readJson(join(ctx.home, '.claude/plugins/installed_plugins.json')))?.plugins;
  const servers: ExternalServer[] = [];
  for (const [id, on] of enabled) {
    if (!on || !isObject(installed)) continue;
    const installs = Array.isArray(installed[id]) ? (installed[id] as Raw[]) : [];
    const install = installs.find((entry) => (entry.scope !== 'project' && entry.scope !== 'local') || entry.projectPath === ctx.cwd);
    if (typeof install?.installPath !== 'string') continue;
    const root = install.installPath;
    const manifest = await readJson(join(root, '.claude-plugin/plugin.json'));
    const plugin = typeof manifest?.name === 'string' ? manifest.name : id.split('@')[0];
    for (const [name, raw] of Object.entries(await pluginServers(root, manifest?.mcpServers, ['.mcp.json']))) {
      servers.push(
        toServer({
          source: 'claude-code',
          scope: `plugin:${id}`,
          origin: `Claude Code · ${plugin} plugin`,
          name,
          nativeName: `plugin:${plugin}:${name}`,
          nativeFor: ['claude'],
          raw,
          vars: { ...ctx.env, CLAUDE_PLUGIN_ROOT: root },
          env: ctx.env,
          baseDir: root,
        }),
      );
    }
  }
  return servers;
}

async function claudeDesktop(ctx: SourceContext): Promise<ExternalServer[]> {
  const base = process.platform === 'win32'
    ? join(ctx.env.APPDATA || join(ctx.home, 'AppData', 'Roaming'), 'Claude')
    : join(ctx.home, 'Library/Application Support/Claude');
  const servers: ExternalServer[] = [];
  const config = await readJson(join(base, 'claude_desktop_config.json'));
  for (const [name, raw] of Object.entries(serverMap(config?.mcpServers))) {
    servers.push(toServer({ source: 'claude-desktop', scope: 'config', origin: 'Claude Desktop', name, nativeFor: [], raw, vars: ctx.env, env: ctx.env, baseDir: ctx.home }));
  }
  // Desktop extensions (MCP bundles) describe their server in manifest.json, filled with the values saved in Claude.
  for (const dir of await subdirectories(join(base, 'Claude Extensions'))) {
    const manifest = await readJson(join(dir, 'manifest.json'));
    const server = isObject(manifest?.server) ? manifest.server : null;
    if (!manifest || !server || !isObject(server.mcp_config)) continue;
    const id = basename(dir);
    const settings = await readJson(join(base, 'Claude Extensions Settings', `${id}.json`));
    const vars: Vars = { ...ctx.env, __dirname: dir, HOME: ctx.home, DESKTOP: join(ctx.home, 'Desktop'), DOCUMENTS: join(ctx.home, 'Documents'), DOWNLOADS: join(ctx.home, 'Downloads'), '/': sep, pathSeparator: sep };
    const declared = isObject(manifest.user_config) ? manifest.user_config : {};
    const saved = isObject(settings?.userConfig) ? settings.userConfig : {};
    for (const [key, spec] of Object.entries(declared)) {
      const value = saved[key] ?? (isObject(spec) ? spec.default : undefined);
      if (value !== undefined) vars[`user_config.${key}`] = Array.isArray(value) ? value.map(String) : String(value);
    }
    const name = typeof manifest.name === 'string' ? manifest.name : id;
    const label = typeof manifest.display_name === 'string' ? manifest.display_name : name;
    servers.push(
      toServer({
        source: 'claude-desktop',
        scope: `extension:${id}`,
        origin: `Claude Desktop · ${label}`,
        name,
        nativeFor: [],
        raw: { ...server.mcp_config, enabled: settings?.isEnabled !== false },
        vars,
        env: ctx.env,
        baseDir: dir,
      }),
    );
  }
  return servers;
}

const codexHome = (ctx: Pick<SourceContext, 'home' | 'env'>) => ctx.env.CODEX_HOME || join(ctx.home, '.codex');

interface CodexPlugin {
  id: string;
  /** Its entry under `[plugins]`, which also holds the user's settings for its servers (`mcp_servers`). */
  entry: Raw;
  root: string;
  display: string;
  servers: Record<string, Raw>;
}

async function codexPlugins(home: string, config: Raw | null): Promise<CodexPlugin[]> {
  const plugins: CodexPlugin[] = [];
  for (const [id, entry] of Object.entries(isObject(config?.plugins) ? config.plugins : {})) {
    if (!isObject(entry) || entry.enabled === false) continue;
    const [plugin, marketplace] = id.split('@');
    if (!plugin || !marketplace) continue;
    const root = await newestDirectory(join(home, 'plugins/cache', marketplace, plugin));
    if (!root) continue;
    const manifest = (await readJson(join(root, '.codex-plugin/plugin.json'))) ?? (await readJson(join(root, 'plugin.json')));
    const display = isObject(manifest?.interface) && typeof manifest.interface.displayName === 'string' ? manifest.interface.displayName : plugin;
    plugins.push({ id, entry, root, display, servers: await pluginServers(root, manifest?.mcpServers, ['.mcp.json']) });
  }
  return plugins;
}

async function codex(ctx: SourceContext): Promise<ExternalServer[]> {
  const home = codexHome(ctx);
  const config = await readToml(join(home, 'config.toml'));
  const servers: ExternalServer[] = [];
  for (const [name, raw] of Object.entries(isObject(config?.mcp_servers) ? config.mcp_servers : {})) {
    if (isObject(raw)) servers.push(toServer({ source: 'codex', scope: 'config', origin: 'Codex', name, nativeFor: ['codex'], raw, vars: ctx.env, env: ctx.env, baseDir: home }));
  }
  for (const plugin of await codexPlugins(home, config)) {
    for (const [name, raw] of Object.entries(plugin.servers)) {
      servers.push(toServer({ source: 'codex', scope: `plugin:${plugin.id}`, origin: `Codex · ${plugin.display} plugin`, name, nativeFor: ['codex'], raw, vars: ctx.env, env: ctx.env, baseDir: plugin.root }));
    }
  }
  return servers;
}

/** A table in Codex's configuration that holds tool approvals: `default_tools_approval_mode`, and `tools.<name>.approval_mode`. */
export interface CodexApprovalScope {
  path: string[];
  /** Tools with an approval of their own there. */
  tools: string[];
}

/**
 * Where Codex keeps the tool approvals of what it loads on its own: the servers in its config.toml, those of its
 * enabled plugins, and the apps of the ChatGPT account it signs in with (`apps._default` covers every app).
 */
export async function codexApprovalScopes(ctx: Pick<SourceContext, 'home' | 'env'>): Promise<CodexApprovalScope[]> {
  const home = codexHome(ctx);
  const config = await readToml(join(home, 'config.toml'));
  const tools = (entry: unknown) => (isObject(entry) && isObject(entry.tools) ? Object.keys(entry.tools) : []);
  const scopes: CodexApprovalScope[] = [];
  for (const [name, raw] of Object.entries(isObject(config?.mcp_servers) ? config.mcp_servers : {})) {
    if (isObject(raw) && raw.enabled !== false) scopes.push({ path: ['mcp_servers', name], tools: tools(raw) });
  }
  for (const plugin of await codexPlugins(home, config)) {
    const settings = isObject(plugin.entry.mcp_servers) ? plugin.entry.mcp_servers : {};
    for (const [name, raw] of Object.entries(plugin.servers)) {
      const own = isObject(settings[name]) ? settings[name] : {};
      // Any entry Codex gets for a plugin's server turns that server on unless it says otherwise, so a server the plugin ships turned off gets none.
      const enabled = typeof own.enabled === 'boolean' ? own.enabled : raw.enabled !== false && raw.disabled !== true;
      if (enabled) scopes.push({ path: ['plugins', plugin.id, 'mcp_servers', name], tools: [...new Set([...tools(raw), ...tools(own)])] });
    }
  }
  scopes.push({ path: ['apps', '_default'], tools: [] });
  for (const [id, app] of Object.entries(isObject(config?.apps) ? config.apps : {})) {
    if (id === '_default' || !isObject(app)) continue;
    scopes.push({ path: ['apps', id], tools: tools(app) });
    for (const link of Object.keys(isObject(app.links) ? app.links : {})) scopes.push({ path: ['apps', id, 'links', link], tools: [] });
  }
  return scopes;
}

/** The Cursor CLI loads ~/.cursor/mcp.json on its own; the servers of Cursor's plugins are the editor's. */
async function cursor(ctx: SourceContext): Promise<ExternalServer[]> {
  const servers: ExternalServer[] = [];
  const config = await readJson(join(ctx.home, '.cursor/mcp.json'));
  for (const [name, raw] of Object.entries(serverMap(config?.mcpServers))) {
    servers.push(toServer({ source: 'cursor', scope: 'config', origin: 'Cursor', name, nativeFor: ['cursor'], raw, vars: ctx.env, env: ctx.env, baseDir: ctx.home }));
  }
  for (const marketplace of await subdirectories(join(ctx.home, '.cursor/plugins/cache'))) {
    for (const pluginDir of await subdirectories(marketplace)) {
      const root = await newestDirectory(pluginDir);
      if (!root) continue;
      const manifest = await readJson(join(root, '.cursor-plugin/plugin.json'));
      const id = basename(pluginDir);
      const display = typeof manifest?.displayName === 'string' ? manifest.displayName : typeof manifest?.name === 'string' ? manifest.name : id;
      for (const [name, raw] of Object.entries(await pluginServers(root, manifest?.mcpServers, ['.mcp.json', 'mcp.json']))) {
        servers.push(toServer({ source: 'cursor', scope: `plugin:${id}`, origin: `Cursor · ${display} plugin`, name, nativeFor: [], raw, vars: { ...ctx.env, CURSOR_PLUGIN_ROOT: root }, env: ctx.env, baseDir: root }));
      }
    }
  }
  return servers;
}

async function workspace(ctx: SourceContext): Promise<ExternalServer[]> {
  if (!ctx.cwd) return [];
  const config = await readJson(join(ctx.cwd, '.mcp.json'));
  return Object.entries(serverMap(config)).map(([name, raw]) =>
    toServer({ source: 'workspace', scope: 'project', origin: 'Project (.mcp.json)', name, nativeFor: ['claude'], raw, vars: ctx.env, env: ctx.env, baseDir: ctx.cwd ?? undefined }),
  );
}

export async function externalServers(ctx: SourceContext): Promise<ExternalServer[]> {
  const groups = await Promise.all([claudeCode(ctx), claudePlugins(ctx), codex(ctx), cursor(ctx), claudeDesktop(ctx), workspace(ctx)]);
  return groups.flat();
}

/** Two definitions with the same endpoint or command line are the same server. */
export function identity(server: { transport: ConnectorTransport; url?: string; command?: string; args?: string[] }): string {
  if (server.transport !== 'stdio') return `url:${(server.url ?? '').trim().replace(/\/+$/, '').toLowerCase()}`;
  return `cmd:${[server.command ?? '', ...(server.args ?? [])].join(' ')}`;
}

export interface NativeServer {
  engine: EngineId;
  identity: string;
  name: string;
}

export function nativeServers(servers: ExternalServer[]): NativeServer[] {
  return servers.filter((server) => server.enabled).flatMap((server) => server.nativeFor.map((engine) => ({ engine, identity: identity(server), name: server.nativeName })));
}

export interface PlannedServer {
  name: string;
  identity: string;
  spec: McpServerSpec;
  /** CooPrompt holds credentials (OAuth) the engine's own copy lacks. */
  ownAuth: boolean;
}

/**
 * What an engine receives: servers it already loads on its own are left alone, unless CooPrompt signed in
 * to them; then they go under the engine's name so they replace its copy instead of duplicating it.
 */
export function planServers(engine: EngineId, planned: PlannedServer[], native: NativeServer[]): Record<string, McpServerSpec> {
  const result: Record<string, McpServerSpec> = {};
  for (const server of planned) {
    const twin = native.find((entry) => entry.engine === engine && entry.identity === server.identity);
    if (twin && !server.ownAuth) continue;
    result[twin?.name ?? server.name] = server.spec;
  }
  return result;
}
