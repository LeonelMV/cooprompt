import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Connectors } from '../src/main/connectors.ts';
import { setLanguage } from '../src/main/i18n.ts';
import { Settings } from '../src/main/settings.ts';

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  return raw;
}

/**
 * The authorization server of a remote MCP server as the MCP SDK finds and uses it: protected
 * resource and authorization server metadata, dynamic client registration, authorization with PKCE
 * that redirects back with the request's `state`, and single-use codes at the token endpoint.
 */
class FakeAuthorizationServer {
  readonly authorizations: URLSearchParams[] = [];
  registrations = 0;
  /** Answers the next authorization with this OAuth error, like a user who cancels. */
  deny: string | null = null;
  readonly url: string;
  private readonly clients = new Map<string, string[]>();
  private readonly grants = new Map<string, { clientId: string; redirectUri: string; challenge: string }>();

  private constructor(private readonly server: Server) {
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    server.on('request', (request, response) => void this.handle(request, response).catch((error) => response.writeHead(500).end(String(error))));
  }

  static async start(): Promise<FakeAuthorizationServer> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return new FakeAuthorizationServer(server);
  }

  get mcpUrl(): string {
    return `${this.url}/mcp`;
  }

  /** A client registered by hand, like Slack's, that only accepts this redirect URI. */
  preRegister(clientId: string, redirectUri: string): void {
    this.clients.set(clientId, [redirectUri]);
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.url);
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(response, 200, { resource: this.mcpUrl, authorization_servers: [this.url] });
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(response, 200, {
        issuer: this.url,
        authorization_endpoint: `${this.url}/authorize`,
        token_endpoint: `${this.url}/token`,
        registration_endpoint: `${this.url}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (request.method === 'POST' && url.pathname === '/register') {
      const metadata = JSON.parse(await readBody(request)) as { redirect_uris?: string[] };
      const clientId = `dynamic-${++this.registrations}`;
      this.clients.set(clientId, metadata.redirect_uris ?? []);
      return json(response, 201, { ...metadata, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (request.method === 'GET' && url.pathname === '/authorize') return this.authorize(url.searchParams, response);
    if (request.method === 'POST' && url.pathname === '/token') return this.token(new URLSearchParams(await readBody(request)), response);
    response.writeHead(404).end();
  }

  private authorize(query: URLSearchParams, response: ServerResponse): void {
    this.authorizations.push(query);
    const clientId = query.get('client_id') ?? '';
    const redirectUri = query.get('redirect_uri') ?? '';
    // Like real servers, a wrong client or redirect is shown in the browser instead of redirecting.
    if (!this.clients.get(clientId)?.includes(redirectUri)) return void response.writeHead(400).end('invalid client or redirect_uri');
    if (query.get('response_type') !== 'code' || query.get('code_challenge_method') !== 'S256' || !query.get('code_challenge')) {
      return void response.writeHead(400).end('invalid_request');
    }
    const back = new URL(redirectUri);
    const state = query.get('state');
    if (state !== null) back.searchParams.set('state', state);
    if (this.deny) {
      back.searchParams.set('error', this.deny);
      this.deny = null;
    } else {
      const code = randomBytes(18).toString('base64url');
      this.grants.set(code, { clientId, redirectUri, challenge: query.get('code_challenge')! });
      back.searchParams.set('code', code);
    }
    response.writeHead(302, { location: back.toString() }).end();
  }

  private token(form: URLSearchParams, response: ServerResponse): void {
    const code = form.get('code') ?? '';
    const grant = this.grants.get(code);
    this.grants.delete(code);
    const verifier = form.get('code_verifier') ?? '';
    if (
      form.get('grant_type') !== 'authorization_code' ||
      !grant ||
      form.get('client_id') !== grant.clientId ||
      form.get('redirect_uri') !== grant.redirectUri ||
      createHash('sha256').update(verifier).digest('base64url') !== grant.challenge
    ) {
      return json(response, 400, { error: 'invalid_grant' });
    }
    // No refresh token, so connecting again goes through the browser again.
    json(response, 200, { access_token: randomBytes(18).toString('base64url'), token_type: 'Bearer', expires_in: 3600 });
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createTcpServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Stands in for the Keychain-backed secret store. */
function memorySecrets() {
  const values = new Map<string, string>();
  return {
    getJson: <T>(key: string): T | null => (values.has(key) ? (JSON.parse(values.get(key)!) as T) : null),
    setJson: (key: string, value: unknown) => {
      if (value === null || value === undefined) values.delete(key);
      else values.set(key, JSON.stringify(value));
    },
  };
}

describe('MCP connector OAuth', () => {
  let dir: string;
  let server: FakeAuthorizationServer;
  let settings: Settings;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cooprompt-oauth-'));
    server = await FakeAuthorizationServer.start();
    settings = new Settings(join(dir, 'settings.json'), { syncRoot: dir, privateRoot: dir });
  });

  afterEach(async () => {
    setLanguage('en');
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** What the system browser does: the authorization server sends it back to the loopback. */
  const browser = async (url: string) => {
    await fetch(url);
  };

  const connectors = (openBrowser = browser) => new Connectors(settings, memorySecrets(), () => ({}), 'test', openBrowser);

  it('registers dynamically and takes only the callback that brings back the state of this attempt', async () => {
    let forged = 0;
    const subject = connectors(async (url) => {
      const redirectUri = new URL(url).searchParams.get('redirect_uri')!;
      forged = (await fetch(`${redirectUri}?code=forged&state=guessed`)).status;
      await browser(url);
    });
    const { id } = subject.save({ connector: { id: '', name: 'Linear', enabled: true, transport: 'http', url: server.mcpUrl } });
    expect((await subject.connectOAuth(id)).oauth).toBe('connected');
    expect(forged).toBe(400);
    expect(server.authorizations[0].get('client_id')).toMatch(/^dynamic-/);

    await subject.connectOAuth(id);
    const [first, second] = server.authorizations.map((query) => query.get('state'));
    expect(first).toMatch(/^[\w-]{22,}$/);
    expect(second).toMatch(/^[\w-]{22,}$/);
    expect(second).not.toBe(first);
  });

  it('uses a pre-registered client and its localhost callback without registering', async () => {
    const port = await freePort();
    server.preRegister('slack-client', `http://localhost:${port}/callback`);
    const subject = connectors();
    const { id } = subject.save({
      connector: { id: '', name: 'Slack', enabled: true, transport: 'http', url: server.mcpUrl, oauthClientId: 'slack-client', oauthCallbackPort: port },
    });
    expect((await subject.connectOAuth(id)).oauth).toBe('connected');
    expect(server.registrations).toBe(0);
    expect(Object.fromEntries(server.authorizations[0])).toMatchObject({ client_id: 'slack-client', redirect_uri: `http://localhost:${port}/callback` });
    expect(server.authorizations[0].get('state')).toMatch(/^[\w-]{22,}$/);
  });

  it('reports a sign-in cancelled in the browser in the app language', async () => {
    setLanguage('es');
    server.deny = 'access_denied';
    const subject = connectors();
    const { id } = subject.save({ connector: { id: '', name: 'Notion', enabled: true, transport: 'http', url: server.mcpUrl } });
    await expect(subject.connectOAuth(id)).rejects.toThrow('Se canceló el inicio de sesión en el navegador.');
    expect(subject.list()[0].oauth).toBe('none');
  });
});
