import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import type { GoogleConfig } from '../src/server.ts';

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

/** The Google account that signs in at an authorization. */
export interface FakeAccount {
  sub: string;
  email: string;
  email_verified?: boolean;
  hd?: string;
  name?: string;
  picture?: string;
}

interface Grant {
  redirectUri: string;
  challenge: string;
  account: FakeAccount;
  claims: JWTPayload;
  foreignKey: boolean;
}

const isLoopback = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
};

/**
 * Stand-in for Google's OAuth endpoints as installed apps use them: authorization with PKCE that
 * redirects to the app's loopback address, a token endpoint that checks the client secret, the
 * redirect URI, the code verifier and single-use codes, and the keys that sign the ID tokens.
 */
export class FakeGoogle {
  readonly clientId = 'cooprompt-test.apps.googleusercontent.com';
  readonly clientSecret = 'test-client-secret';
  /** Who signs in at the next authorization. */
  account: FakeAccount = { sub: '1001', email: 'ana@acme.com', email_verified: true, hd: 'acme.com', name: 'Ana' };
  /** Claims that override the real ones in the ID tokens of the next authorizations (aud, iss, exp…). */
  claims: JWTPayload = {};
  /** Signs the ID tokens of the next authorizations with a key Google does not publish. */
  foreignKey = false;
  /** Answers the next authorization with this OAuth error instead of a code (a user cancelling: access_denied). */
  deny: string | null = null;
  /** The query of every authorization request, to check what the app asked for. */
  readonly authorizations: URLSearchParams[] = [];
  readonly url: string;
  private readonly grants = new Map<string, Grant>();
  private readonly kid = randomBytes(8).toString('hex');

  private constructor(
    private readonly server: Server,
    private readonly keys: KeyPair,
    private readonly foreign: KeyPair,
  ) {
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  static async start(): Promise<FakeGoogle> {
    const [keys, foreign] = await Promise.all([generateKeyPair('RS256'), generateKeyPair('RS256')]);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const google = new FakeGoogle(server, keys, foreign);
    server.on('request', (request, response) => {
      google.handle(request, response).catch((error) => response.writeHead(500).end(String(error)));
    });
    return google;
  }

  get authorizationEndpoint(): string {
    return `${this.url}/o/oauth2/v2/auth`;
  }

  /** The server configuration for this client, pointed at these endpoints. */
  config(allowedDomains: string[] = []): GoogleConfig {
    return { clientId: this.clientId, clientSecret: this.clientSecret, allowedDomains, endpoints: { token: `${this.url}/token`, jwks: `${this.url}/oauth2/v3/certs` } };
  }

  /** What the system browser does with the authorization URL: Google redirects it back to the app's loopback. */
  readonly browser = async (url: string): Promise<void> => {
    await fetch(url);
  };

  /** Runs an authorization like a browser would and returns the code Google sends back to `redirectUri`. */
  async authorize(input: { redirectUri: string; challenge: string; state?: string }): Promise<string> {
    const url = new URL(this.authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      code_challenge: input.challenge,
      code_challenge_method: 'S256',
      state: input.state ?? 'state',
    }).toString();
    const response = await fetch(url, { redirect: 'manual' });
    const code = new URL(response.headers.get('location') ?? 'http://invalid/').searchParams.get('code');
    if (!code) throw new Error(`no authorization code (${response.status})`);
    return code;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.url);
    if (request.method === 'GET' && url.pathname === '/o/oauth2/v2/auth') return this.authorization(url.searchParams, response);
    if (request.method === 'POST' && url.pathname === '/token') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      return this.token(new URLSearchParams(raw), response);
    }
    if (request.method === 'GET' && url.pathname === '/oauth2/v3/certs') {
      const key = { ...(await exportJWK(this.keys.publicKey)), kid: this.kid, alg: 'RS256', use: 'sig' };
      return json(response, 200, { keys: [key] });
    }
    response.writeHead(404).end();
  }

  private authorization(query: URLSearchParams, response: ServerResponse): void {
    this.authorizations.push(query);
    const redirectUri = query.get('redirect_uri') ?? '';
    // Like Google, problems with the client or the redirect are shown in the browser, not sent to the app.
    if (query.get('client_id') !== this.clientId) return void response.writeHead(401).end('Error 401: invalid_client');
    if (!isLoopback(redirectUri)) return void response.writeHead(400).end('Error 400: redirect_uri_mismatch');
    if (query.get('response_type') !== 'code' || query.get('code_challenge_method') !== 'S256' || !query.get('code_challenge')) {
      return void response.writeHead(400).end('Error 400: invalid_request');
    }
    const back = new URL(redirectUri);
    const state = query.get('state');
    if (state !== null) back.searchParams.set('state', state);
    if (this.deny) {
      back.searchParams.set('error', this.deny);
      this.deny = null;
    } else {
      const code = `4/${randomBytes(24).toString('base64url')}`;
      this.grants.set(code, { redirectUri, challenge: query.get('code_challenge')!, account: { ...this.account }, claims: { ...this.claims }, foreignKey: this.foreignKey });
      back.searchParams.set('code', code);
      back.searchParams.set('scope', 'openid email profile');
    }
    response.writeHead(302, { location: back.toString() }).end();
  }

  private async token(form: URLSearchParams, response: ServerResponse): Promise<void> {
    if (form.get('client_id') !== this.clientId || form.get('client_secret') !== this.clientSecret) {
      return json(response, 401, { error: 'invalid_client', error_description: 'Unauthorized' });
    }
    if (form.get('grant_type') !== 'authorization_code') return json(response, 400, { error: 'unsupported_grant_type' });
    const code = form.get('code') ?? '';
    const grant = this.grants.get(code);
    // Codes work once, even when the exchange fails.
    this.grants.delete(code);
    if (!grant) return json(response, 400, { error: 'invalid_grant', error_description: 'Malformed auth code.' });
    if (form.get('redirect_uri') !== grant.redirectUri) return json(response, 400, { error: 'redirect_uri_mismatch', error_description: 'Bad Request' });
    const verifier = form.get('code_verifier') ?? '';
    if (createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) {
      return json(response, 400, { error: 'invalid_grant', error_description: 'Invalid code verifier.' });
    }
    const now = Math.floor(Date.now() / 1000);
    const { account } = grant;
    const claims: JWTPayload = {
      iss: 'https://accounts.google.com',
      azp: this.clientId,
      aud: this.clientId,
      sub: account.sub,
      email: account.email,
      email_verified: account.email_verified ?? true,
      ...(account.hd ? { hd: account.hd } : {}),
      name: account.name ?? account.email.split('@')[0],
      ...(account.picture ? { picture: account.picture } : {}),
      iat: now,
      exp: now + 3600,
      ...grant.claims,
    };
    const idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: this.kid, typ: 'JWT' })
      .sign(grant.foreignKey ? this.foreign.privateKey : this.keys.privateKey);
    json(response, 200, { access_token: randomBytes(16).toString('base64url'), expires_in: 3599, scope: 'openid email profile', token_type: 'Bearer', id_token: idToken });
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
