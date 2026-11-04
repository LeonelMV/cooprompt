import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codexApprovalScopes, externalServers, identity, nativeServers, planServers, type ExternalServer } from '../src/main/connector-sources.ts';

let home: string;
let project: string;
let desktop: string;
let servers: ExternalServer[];

async function put(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
}

const find = (key: string) => {
  const server = servers.find((entry) => entry.key === key);
  if (!server) throw new Error(`missing ${key}; found ${servers.map((entry) => entry.key).join(', ')}`);
  return server;
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'cooprompt-sources-'));
  project = join(home, 'work/app');
  const claudePlugins = join(home, '.claude/plugins/cache/official');

  await put(join(home, '.claude.json'), {
    mcpServers: { rea: { type: 'stdio', command: '/opt/rea', args: ['mcp'] } },
    projects: { [project]: { mcpServers: { localdb: { command: 'pg-mcp' } } } },
  });
  await put(join(home, '.claude/settings.json'), { enabledPlugins: { 'notion@official': true, 'slack@official': true, 'off@official': false } });
  await put(join(home, '.claude/plugins/installed_plugins.json'), {
    plugins: {
      'notion@official': [{ scope: 'user', installPath: join(claudePlugins, 'notion/1.0') }],
      'slack@official': [{ scope: 'user', installPath: join(claudePlugins, 'slack/2.0') }],
      'off@official': [{ scope: 'user', installPath: join(claudePlugins, 'off/1.0') }],
    },
  });
  await put(join(claudePlugins, 'notion/1.0/.claude-plugin/plugin.json'), { name: 'Notion' });
  await put(join(claudePlugins, 'notion/1.0/.mcp.json'), {
    notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
    helper: { command: '${CLAUDE_PLUGIN_ROOT}/bin/helper', args: ['--token', '${HELPER_TOKEN}'] },
  });
  await put(join(claudePlugins, 'slack/2.0/.claude-plugin/plugin.json'), { name: 'slack', mcpServers: './servers.json' });
  await put(join(claudePlugins, 'slack/2.0/servers.json'), { mcpServers: { slack: { type: 'http', url: 'https://mcp.slack.com/mcp', oauth: { clientId: '123.456', callbackPort: 3118 } } } });
  await put(join(claudePlugins, 'off/1.0/.mcp.json'), { off: { command: 'off-server' } });

  await put(
    join(home, '.codex/config.toml'),
    `[mcp_servers.rea]
command = "/opt/rea"
args = ["mcp"]

[mcp_servers.rea.tools.set_comment]
approval_mode = "approve"

[mcp_servers.github]
url = "https://api.githubcopilot.com/mcp/"
bearer_token_env_var = "GITHUB_PAT"

[mcp_servers.app_internal]
command = "./bin/tool"
cwd = "tools"
env_vars = ["APP_PIPE"]
enabled = false

[plugins."reviewer@market"]
enabled = true

[plugins."reviewer@market".mcp_servers.review.tools.post_review]
approval_mode = "approve"

[plugins."reviewer@market".mcp_servers.indexer]
enabled = true

[plugins."off@market"]
enabled = false

[apps._default]
enabled = true

[apps.asdk_app_slack.tools.slack_send_message]
approval_mode = "approve"

[apps.asdk_app_slack.links.link_work]
default_tools_approval_mode = "prompt"
`,
  );
  const reviewer = join(home, '.codex/plugins/cache/market/reviewer/1.2.3');
  await put(join(reviewer, '.codex-plugin/plugin.json'), { name: 'reviewer', interface: { displayName: 'Reviewer' }, mcpServers: './.mcp.json' });
  await put(join(reviewer, '.mcp.json'), {
    mcpServers: {
      review: { command: '/bin/sh', args: ['-c', 'exec node ./server.mjs'], cwd: '.' },
      indexer: { command: './bin/indexer', enabled: false },
      tracer: { command: './bin/tracer', enabled: false },
    },
  });
  await put(join(home, '.codex/plugins/cache/market/off/1.0.0/.mcp.json'), { mcpServers: { off: { command: 'off-server' } } });

  await put(join(home, '.cursor/mcp.json'), { mcpServers: { atlassian: { url: 'https://mcp.atlassian.com/v1/mcp' } } });
  const datadog = join(home, '.cursor/plugins/cache/public/datadog/abc123');
  await put(join(datadog, '.cursor-plugin/plugin.json'), { name: 'datadog', mcpServers: './.dd.json' });
  await put(join(datadog, '.dd.json'), { mcpServers: { datadog: { url: 'https://${DD_DOMAIN:-not-setup}/v1/mcp', headers: { DD_API_KEY: '${DD_API_KEY}' } } } });

  desktop = process.platform === 'win32' ? join(home, 'AppData/Roaming/Claude') : join(home, 'Library/Application Support/Claude');
  await put(join(desktop, 'claude_desktop_config.json'), { mcpServers: {} });
  await put(join(desktop, 'Claude Extensions/ant.chrome/manifest.json'), {
    name: 'chrome-control',
    display_name: 'Control Chrome',
    server: { mcp_config: { command: 'node', args: ['${__dirname}/server/index.js', '${user_config.dirs}'] } },
    user_config: { dirs: { type: 'directory', multiple: true, default: [] } },
  });
  await put(join(desktop, 'Claude Extensions Settings/ant.chrome.json'), { isEnabled: true, userConfig: { dirs: ['/a', '/b'] } });

  await put(join(project, '.mcp.json'), { mcpServers: { docs: { type: 'http', url: 'https://docs.example.com/mcp' } } });

  servers = await externalServers({ home, cwd: project, env: { GITHUB_PAT: 'ghp_secret', ...(process.platform === 'win32' ? { APPDATA: join(home, 'AppData/Roaming') } : {}) } });
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('connectors defined by other apps', () => {
  it('reads Claude Code servers from every scope and its enabled plugins', () => {
    expect(find('claude-code:user:rea')).toMatchObject({ nativeFor: ['claude'], nativeName: 'rea', command: '/opt/rea', args: ['mcp'] });
    expect(find('claude-code:local:localdb')).toMatchObject({ transport: 'stdio', command: 'pg-mcp' });
    expect(find('claude-code:plugin:notion@official:notion')).toMatchObject({
      origin: 'Claude Code · Notion plugin',
      nativeName: 'plugin:Notion:notion',
      transport: 'http',
      url: 'https://mcp.notion.com/mcp',
    });
    const helper = find('claude-code:plugin:notion@official:helper');
    expect(helper.command).toBe(join(home, '.claude/plugins/cache/official/notion/1.0/bin/helper'));
    expect(helper.missingEnv).toEqual(['HELPER_TOKEN']);
    expect(find('claude-code:plugin:slack@official:slack').oauth).toEqual({ clientId: '123.456', callbackPort: 3118 });
    expect(servers.some((server) => server.name === 'off')).toBe(false);
  });

  it('reads Codex servers and plugins with their credentials, folders and state', () => {
    expect(find('codex:config:github')).toMatchObject({ transport: 'http', headers: { Authorization: 'Bearer ghp_secret' }, missingEnv: [] });
    expect(find('codex:config:app_internal')).toMatchObject({
      enabled: false,
      cwd: join(home, '.codex/tools'),
      command: join(home, '.codex/tools/bin/tool'),
      envVars: ['APP_PIPE'],
      missingEnv: ['APP_PIPE'],
    });
    expect(find('codex:plugin:reviewer@market:review')).toMatchObject({ origin: 'Codex · Reviewer plugin', nativeFor: ['codex'], cwd: join(home, '.codex/plugins/cache/market/reviewer/1.2.3') });
  });

  it("finds where Codex keeps the tool approvals of its own servers, its plugins' and its apps", async () => {
    expect(await codexApprovalScopes({ home, env: {} })).toEqual([
      { path: ['mcp_servers', 'rea'], tools: ['set_comment'] },
      { path: ['mcp_servers', 'github'], tools: [] },
      { path: ['plugins', 'reviewer@market', 'mcp_servers', 'review'], tools: ['post_review'] },
      { path: ['plugins', 'reviewer@market', 'mcp_servers', 'indexer'], tools: [] },
      { path: ['apps', '_default'], tools: [] },
      { path: ['apps', 'asdk_app_slack'], tools: ['slack_send_message'] },
      { path: ['apps', 'asdk_app_slack', 'links', 'link_work'], tools: [] },
    ]);
    expect(await codexApprovalScopes({ home, env: { CODEX_HOME: join(home, 'nowhere') } })).toEqual([{ path: ['apps', '_default'], tools: [] }]);
  });

  it('reads Cursor, Claude Desktop extensions and the project', () => {
    expect(find('cursor:config:atlassian')).toMatchObject({ nativeFor: ['cursor'], url: 'https://mcp.atlassian.com/v1/mcp' });
    expect(find('cursor:plugin:datadog:datadog')).toMatchObject({ nativeFor: [], url: 'https://not-setup/v1/mcp', missingEnv: ['DD_API_KEY'] });
    expect(find('claude-desktop:extension:ant.chrome:chrome-control')).toMatchObject({
      origin: 'Claude Desktop · Control Chrome',
      enabled: true,
      args: [join(desktop, 'Claude Extensions/ant.chrome/server/index.js'), '/a', '/b'],
    });
    expect(find('workspace:project:docs')).toMatchObject({ nativeFor: ['claude'] });
  });
});

describe('what each engine receives', () => {
  const spec = (url: string) => ({ type: 'http' as const, url, headers: {} });

  it('leaves out what the engine already loads and replaces its copy when CooPrompt signed in', () => {
    const native = nativeServers(servers);
    const rea = { name: 'rea', identity: identity(find('claude-code:user:rea')), ownAuth: false, spec: { type: 'stdio' as const, command: '/opt/rea', args: ['mcp'], env: {} } };
    const notion = { name: 'notion', identity: identity(find('claude-code:plugin:notion@official:notion')), spec: spec('https://mcp.notion.com/mcp') };

    expect(planServers('claude', [rea, { ...notion, ownAuth: false }], native)).toEqual({});
    expect(Object.keys(planServers('codex', [rea, { ...notion, ownAuth: false }], native))).toEqual(['notion']);
    expect(Object.keys(planServers('claude', [{ ...notion, ownAuth: true }], native))).toEqual(['plugin:Notion:notion']);
  });

  it('gives Cursor what its CLI does not load from ~/.cursor/mcp.json', () => {
    const native = nativeServers(servers);
    const atlassian = { name: 'jira', identity: identity(find('cursor:config:atlassian')), spec: spec('https://mcp.atlassian.com/v1/mcp/') };
    const notion = { name: 'notion', identity: identity(find('claude-code:plugin:notion@official:notion')), ownAuth: false, spec: spec('https://mcp.notion.com/mcp') };
    expect(Object.keys(planServers('cursor', [{ ...atlassian, ownAuth: false }, notion], native))).toEqual(['notion']);
    expect(Object.keys(planServers('cursor', [{ ...atlassian, ownAuth: true }], native))).toEqual(['atlassian']);
    expect(Object.keys(planServers('claude', [{ ...atlassian, ownAuth: false }], native))).toEqual(['jira']);
  });

  it('still passes a server the engine has turned off in its own config', () => {
    const internal = find('codex:config:app_internal');
    const planned = { name: 'app_internal', identity: identity(internal), ownAuth: false, spec: { type: 'stdio' as const, command: internal.command!, args: [], env: {} } };
    expect(Object.keys(planServers('codex', [planned], nativeServers(servers)))).toEqual(['app_internal']);
  });
});
