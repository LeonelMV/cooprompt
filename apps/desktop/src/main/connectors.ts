import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { EngineId } from '@cooprompt/protocol';
import type { ConnectorConfig, ConnectorView, DetectedConnector } from '../shared/types.ts';
import { codexApprovalScopes, externalServers, identity, nativeServers, planServers, type CodexApprovalScope, type ExternalServer, type PlannedServer } from './connector-sources.ts';
import type { McpServerSpec } from './engines/types.ts';
import { startLoopback } from './loopback.ts';
import type { Secrets } from './secrets.ts';
import type { Settings } from './settings.ts';
import { tr } from './i18n.ts';

interface OAuthState {
  tokens?: { access_token: string; refresh_token?: string; expires_in?: number; token_type: string; scope?: string };
  obtainedAt?: number;
  client?: Record<string, unknown>;
  verifier?: string;
  redirectUri?: string;
}

export class Connectors {
  private readonly settings: Settings;
  private readonly secrets: Pick<Secrets, 'getJson' | 'setJson'>;
  private readonly shellEnv: () => Record<string, string>;
  private readonly appVersion: string;
  /** Opens the system browser. */
  private readonly openBrowser: (url: string) => Promise<void>;

  constructor(
    settings: Settings,
    secrets: Pick<Secrets, 'getJson' | 'setJson'>,
    shellEnv: () => Record<string, string>,
    appVersion: string,
    openBrowser: (url: string) => Promise<void>,
  ) {
    this.settings = settings;
    this.secrets = secrets;
    this.shellEnv = shellEnv;
    this.appVersion = appVersion;
    this.openBrowser = openBrowser;
  }

  private env(id: string): Record<string, string> {
    return this.secrets.getJson<Record<string, string>>(`connector-env:${id}`) ?? {};
  }

  private headers(id: string): Record<string, string> {
    return this.secrets.getJson<Record<string, string>>(`connector-headers:${id}`) ?? {};
  }

  private oauthState(id: string): OAuthState {
    return this.secrets.getJson<OAuthState>(`mcp-oauth:${id}`) ?? {};
  }

  private saveOAuthState(id: string, state: OAuthState): void {
    this.secrets.setJson(`mcp-oauth:${id}`, state);
  }

  private external(cwd: string | null): Promise<ExternalServer[]> {
    return externalServers({ home: homedir(), cwd, env: this.shellEnv() });
  }

  view(connector: ConnectorConfig): ConnectorView {
    return {
      ...connector,
      envKeys: Object.keys(this.env(connector.id)),
      headerKeys: Object.keys(this.headers(connector.id)),
      oauth: this.oauthState(connector.id).tokens ? 'connected' : 'none',
    };
  }

  list(): ConnectorView[] {
    return this.settings.data.connectors.map((connector) => this.view(connector));
  }

  /** Servers other apps define on this computer; values stay in the main process, the renderer only sees names. */
  async detected(cwd: string | null): Promise<DetectedConnector[]> {
    const servers = await this.external(cwd);
    const native = nativeServers(servers);
    const importKeys = new Set(this.settings.data.connectors.map((connector) => connector.importKey));
    const ours = new Set(this.settings.data.connectors.map((connector) => identity(connector)));
    const plan = new Set(this.importPlan(servers).map((server) => server.key));
    return servers.map((server) => ({
      key: server.key,
      source: server.source,
      origin: server.origin,
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      envKeys: Object.keys(server.env),
      nativeFor: [...new Set(native.filter((entry) => entry.identity === identity(server)).map((entry) => entry.engine))],
      enabled: server.enabled,
      missingEnv: server.missingEnv,
      imported: importKeys.has(server.key) || ours.has(identity(server)),
      importable: plan.has(server.key),
    }));
  }

  /** Where Codex keeps the tool approvals of the servers and apps it loads on its own. */
  codexApprovalScopes(): Promise<CodexApprovalScope[]> {
    return codexApprovalScopes({ home: homedir(), env: this.shellEnv() });
  }

  /** Names the engine gives the servers it loads on its own (for the session panel). */
  async nativeNames(engine: EngineId): Promise<string[]> {
    return nativeServers(await this.external(null))
      .filter((entry) => entry.engine === engine)
      .map((entry) => entry.name);
  }

  save(input: { connector: ConnectorConfig; env?: Record<string, string>; headers?: Record<string, string> }): ConnectorView {
    const id = input.connector.id || randomUUID();
    const base = input.connector.name.trim().replace(/[^a-zA-Z0-9_-]/g, '-') || 'connector';
    const taken = new Set(this.settings.data.connectors.filter((connector) => connector.id !== id).map((connector) => connector.name));
    let name = base;
    for (let suffix = 2; taken.has(name); suffix++) name = `${base}-${suffix}`;
    const connector: ConnectorConfig = { ...input.connector, id, name, args: (input.connector.args ?? []).filter((arg) => arg !== '') };
    if (connector.transport === 'stdio' && !connector.command) throw new Error(tr('Local (stdio) connectors need a command'));
    if (connector.transport !== 'stdio' && !connector.url) throw new Error(tr('Remote connectors need a URL'));
    this.settings.update((data) => {
      const index = data.connectors.findIndex((existing) => existing.id === connector.id);
      if (index >= 0) data.connectors[index] = connector;
      else data.connectors.push(connector);
    });
    if (input.env) this.secrets.setJson(`connector-env:${connector.id}`, input.env);
    if (input.headers) this.secrets.setJson(`connector-headers:${connector.id}`, input.headers);
    return this.view(connector);
  }

  remove(id: string): void {
    this.settings.update((data) => {
      data.connectors = data.connectors.filter((connector) => connector.id !== id);
    });
    for (const key of [`connector-env:${id}`, `connector-headers:${id}`, `mcp-oauth:${id}`]) this.secrets.setJson(key, null);
  }

  private importServer(server: ExternalServer): ConnectorView {
    return this.save({
      connector: {
        id: '',
        name: server.name,
        enabled: server.enabled,
        transport: server.transport,
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        envVars: server.envVars.length ? server.envVars : undefined,
        url: server.url,
        oauthClientId: server.oauth?.clientId,
        oauthCallbackPort: server.oauth?.callbackPort,
        source: server.source,
        origin: server.origin,
        importKey: server.key,
      },
      env: server.env,
      headers: server.headers,
    });
  }

  async importFrom(key: string, cwd: string | null): Promise<ConnectorView> {
    const server = (await this.external(cwd)).find((entry) => entry.key === key);
    if (!server) throw new Error(tr('Connector not found'));
    return this.importServer(server);
  }

  /**
   * What "Import all" brings in: enabled where it came from, nothing missing, not in CooPrompt yet, and one per
   * server. Within an app a name is one server (its own config is read before the plugins that default it).
   */
  private importPlan(servers: ExternalServer[]): ExternalServer[] {
    const known = new Set(this.settings.data.connectors.map((connector) => identity(connector)));
    const named = new Set(this.settings.data.connectors.map((connector) => `${connector.source}:${connector.name}`));
    const importKeys = new Set(this.settings.data.connectors.map((connector) => connector.importKey));
    const plan: ExternalServer[] = [];
    for (const server of servers) {
      const key = identity(server);
      const name = `${server.source}:${server.name}`;
      if (!server.enabled || server.missingEnv.length > 0 || known.has(key) || named.has(name) || importKeys.has(server.key)) continue;
      known.add(key);
      named.add(name);
      plan.push(server);
    }
    return plan;
  }

  async importAll(cwd: string | null): Promise<number> {
    const plan = this.importPlan(await this.external(cwd));
    for (const server of plan) this.importServer(server);
    return plan.length;
  }

  async serversFor(engine: EngineId): Promise<Record<string, McpServerSpec>> {
    const planned: PlannedServer[] = [];
    for (const connector of this.settings.data.connectors) {
      if (!connector.enabled) continue;
      if (connector.transport === 'stdio') {
        planned.push({
          name: connector.name,
          identity: identity(connector),
          ownAuth: false,
          spec: { type: 'stdio', command: connector.command!, args: connector.args ?? [], env: this.env(connector.id), cwd: connector.cwd, envVars: connector.envVars },
        });
      } else {
        const headers = { ...this.headers(connector.id) };
        const token = await this.accessToken(connector).catch(() => null);
        if (token) headers.Authorization = `Bearer ${token}`;
        planned.push({ name: connector.name, identity: identity(connector), ownAuth: Boolean(token), spec: { type: connector.transport, url: connector.url!, headers } });
      }
    }
    return planServers(engine, planned, nativeServers(await this.external(null)));
  }

  async test(id: string): Promise<{ ok: boolean; message: string; tools: string[] }> {
    const connector = this.settings.data.connectors.find((entry) => entry.id === id);
    if (!connector) throw new Error(tr('Connector not found'));
    const client = new Client({ name: 'cooprompt', version: this.appVersion });
    let transport: Transport;
    let stderr = '';
    if (connector.transport === 'stdio') {
      const stdio = new StdioClientTransport({ command: connector.command!, args: connector.args ?? [], cwd: connector.cwd, env: { ...this.shellEnv(), ...this.env(id) }, stderr: 'pipe' });
      stdio.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8000);
      });
      transport = stdio;
    } else {
      const headers = { ...this.headers(id) };
      const token = await this.accessToken(connector).catch(() => null);
      if (token) headers.Authorization = `Bearer ${token}`;
      const url = new URL(connector.url!);
      transport = connector.transport === 'sse' ? new SSEClientTransport(url, { requestInit: { headers } }) : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    }
    // npx downloads a local server the first time, which can take a while.
    const timeout = connector.transport === 'stdio' ? 120_000 : 25_000;
    try {
      await Promise.race([client.connect(transport), new Promise((_, reject) => setTimeout(() => reject(new Error(tr('Timed out'))), timeout))]);
      const { tools } = await client.listTools();
      return { ok: true, message: tr('Connected · {count} tools', { count: tools.length }), tools: tools.map((tool) => tool.name) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = (error as { code?: unknown }).code;
      if (status === 'ENOENT' && connector.command) {
        const command = basename(connector.command);
        const comesWithNode = ['npx', 'node', 'npm'].includes(command);
        return {
          ok: false,
          message: comesWithNode ? tr('"{command}" is not installed on this computer. It comes with Node.js: install it from nodejs.org.', { command }) : tr('"{command}" is not installed on this computer.', { command }),
          tools: [],
        };
      }
      const needsAuth = status === 401 || /401|unauthorized|invalid_token/i.test(message);
      // A local server that quits on start usually says why, e.g. the Node.js version it needs.
      const said = stderr
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /error/i.test(line) && !/^npm (warn|notice)\b/i.test(line))
        .pop();
      return { ok: false, message: needsAuth ? tr('The server requires you to sign in: use "Connect".') : said ? `${message}: ${said}` : message, tools: [] };
    } finally {
      await client.close().catch(() => {});
    }
  }

  private provider(connector: ConnectorConfig, redirectUri: string, onRedirect: (url: URL) => void | Promise<void>, state?: string): OAuthClientProvider {
    const id = connector.id;
    const read = () => this.oauthState(id);
    const write = (patch: Partial<OAuthState>) => this.saveOAuthState(id, { ...read(), ...patch });
    return {
      get redirectUrl() {
        return redirectUri;
      },
      state: state ? () => state : undefined,
      get clientMetadata() {
        return {
          client_name: 'CooPrompt',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        };
      },
      clientInformation: () => {
        if (connector.oauthClientId) return { client_id: connector.oauthClientId };
        const state = read();
        return state.redirectUri === redirectUri ? (state.client as never) : undefined;
      },
      saveClientInformation: (client) => write({ client: client as Record<string, unknown>, redirectUri }),
      tokens: () => read().tokens as never,
      saveTokens: (tokens) => write({ tokens: tokens as OAuthState['tokens'], obtainedAt: Date.now(), redirectUri }),
      redirectToAuthorization: (url) => onRedirect(url),
      saveCodeVerifier: (verifier) => write({ verifier }),
      codeVerifier: () => read().verifier ?? '',
      invalidateCredentials: (scope) => {
        if (scope === 'all') this.saveOAuthState(id, {});
        else if (scope === 'tokens') write({ tokens: undefined });
        else if (scope === 'client') write({ client: undefined });
      },
    };
  }

  /**
   * Runs the MCP OAuth flow (discovery, PKCE, dynamic registration unless the server has a
   * pre-registered client) in the system browser.
   */
  async connectOAuth(id: string): Promise<ConnectorView> {
    const connector = this.settings.data.connectors.find((entry) => entry.id === id);
    if (!connector || connector.transport === 'stdio' || !connector.url) throw new Error(tr('OAuth only applies to remote connectors'));
    // New for every attempt: the loopback only accepts the callback that carries it back.
    const state = randomBytes(16).toString('base64url');
    const loopback = connector.oauthClientId
      ? await startLoopback({ port: connector.oauthCallbackPort ?? 33418, hostname: 'localhost', state })
      : await startLoopback({ port: 33418, state }).catch(() => startLoopback({ state }));
    try {
      const provider = this.provider(connector, loopback.redirectUri, (url) => this.openBrowser(url.toString()), state);
      const first = await auth(provider, { serverUrl: connector.url });
      if (first !== 'AUTHORIZED') {
        const { code } = await loopback.waitForCode();
        await auth(provider, { serverUrl: connector.url, authorizationCode: code });
      }
      return this.view(connector);
    } finally {
      loopback.close();
    }
  }

  /** Refreshes expired OAuth tokens before handing them to an engine. */
  private async accessToken(connector: ConnectorConfig): Promise<string | null> {
    const state = this.oauthState(connector.id);
    if (!state.tokens || !connector.url) return null;
    const expiresAt = state.obtainedAt && state.tokens.expires_in ? state.obtainedAt + state.tokens.expires_in * 1000 : null;
    if (expiresAt && expiresAt - Date.now() < 60_000 && state.tokens.refresh_token && state.redirectUri) {
      const provider = this.provider(connector, state.redirectUri, () => {
        throw new Error(tr('The token expired: connect again'));
      });
      await auth(provider, { serverUrl: connector.url });
    }
    return this.oauthState(connector.id).tokens?.access_token ?? null;
  }
}
