import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthResponse, ChatSummary, HealthResponse, PublicUser } from '@cooprompt/protocol';
import { FakeGoogle, type FakeAccount } from './fake-google.ts';
import { api, register, startServer, TestSocket, type Harness } from './helpers.ts';

const REDIRECT = 'http://127.0.0.1:53682/callback';
const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

describe('Google sign-in', () => {
  let google: FakeGoogle;
  let h: Harness;

  beforeEach(async () => {
    google = await FakeGoogle.start();
  });

  afterEach(async () => {
    await h?.close();
    await google.close();
  });

  const users = () => h.server.store.db.get<{ n: number }>('select count(*) as n from users')!.n;

  /** What a desktop app does once the browser is back: hands the code and its PKCE verifier to the server. */
  async function signIn(account: Partial<FakeAccount> = {}, options: { verifier?: string; redirectUri?: string; code?: string } = {}) {
    google.account = { ...google.account, ...account };
    const verifier = randomBytes(32).toString('base64url');
    const code = options.code ?? (await google.authorize({ redirectUri: REDIRECT, challenge: challengeOf(verifier) }));
    return api<AuthResponse & { error?: string }>(h.base, '/api/auth/google', {
      body: { code, codeVerifier: options.verifier ?? verifier, redirectUri: options.redirectUri ?? REDIRECT },
    });
  }

  it('creates the account and a working session, and signs the same Google account back in', async () => {
    h = await startServer({ google: google.config(['acme.com']) });
    const health = (await api<HealthResponse>(h.base, '/api/health')).body;
    expect(health.auth.google).toEqual({ enabled: true, clientId: google.clientId, allowedDomains: ['acme.com'] });

    const first = await signIn({ sub: '1001', email: 'Ana@Acme.com', name: 'Ana Pérez', picture: 'https://lh3.example/ana.png' });
    expect(first.status).toBe(200);
    expect(first.body.user).toMatchObject({ email: 'ana@acme.com', name: 'Ana Pérez', avatarUrl: 'https://lh3.example/ana.png', orgDomain: 'acme.com' });
    const me = await api<PublicUser>(h.base, '/api/me', { token: first.body.token });
    expect(me.body.id).toBe(first.body.user.id);

    const again = await signIn({ sub: '1001' });
    expect(again.body.user.id).toBe(first.body.user.id);
    expect(again.body.token).not.toBe(first.body.token);
    expect(users()).toBe(1);
  });

  it('links Google to the password account with the same email, which keeps its chats and stops taking the password', async () => {
    h = await startServer({ google: google.config(['acme.com']) });
    const password = await register(h.base, 'Ana@acme.com', 'Ana');
    const chat = (await api<ChatSummary>(h.base, '/api/chats', { token: password.token, body: { title: 'Plan', kind: 'private' } })).body;
    const socket = await TestSocket.connect(h.base, password.token, 'ana-device-0001');
    // The host switches the server to Google accounts only.
    h.server.setAuth({ google: google.config(['acme.com']), passwordAuth: false });

    const linked = await signIn({ sub: '2002', email: 'ana@acme.com', hd: 'acme.com' });
    expect(linked.status).toBe(200);
    expect(linked.body.user.id).toBe(password.user.id);
    expect(users()).toBe(1);
    expect(h.server.store.getUser(password.user.id)).toMatchObject({ googleSub: '2002', passwordHash: null });
    const chats = (await api<ChatSummary[]>(h.base, '/api/chats', { token: linked.body.token })).body;
    expect(chats.map((entry) => entry.id)).toEqual([chat.id]);

    // Whoever set that password may not have owned the address: their sessions end.
    expect((await api(h.base, '/api/me', { token: password.token })).status).toBe(401);
    expect(await socket.closed).toBe(4401);
    h.server.setAuth({ google: google.config(['acme.com']), passwordAuth: true });
    const login = await api(h.base, '/api/auth/login', { body: { email: 'ana@acme.com', password: 'contraseña-segura' } });
    expect(login).toMatchObject({ status: 401, body: { error: 'This account signs in with Google: use Continue with Google.' } });
  });

  it('does not hand an existing account to a Google account that cannot vouch for the address', async () => {
    h = await startServer({ google: google.config() });
    await register(h.base, 'bob@smallco.com', 'Bob');
    const personal = await signIn({ sub: '3003', email: 'bob@smallco.com', hd: undefined });
    expect(personal).toMatchObject({
      status: 409,
      body: { error: 'An account with this email already exists, and Google cannot confirm the address is yours. Sign in with your password.' },
    });
    expect((await api(h.base, '/api/auth/login', { body: { email: 'bob@smallco.com', password: 'contraseña-segura' } })).status).toBe(200);

    const gmail = await signIn({ sub: '3004', email: 'bob@gmail.com', hd: undefined });
    expect(gmail.status).toBe(200);
    expect(gmail.body.user.orgDomain).toBeNull();
  });

  it('rejects Google accounts without a verified email', async () => {
    h = await startServer({ google: google.config() });
    const result = await signIn({ email_verified: false });
    expect(result).toMatchObject({ status: 401, body: { error: 'The Google account has no verified email' } });
    expect(users()).toBe(0);
  });

  it('only accepts Google Workspace accounts of the allowed domains', async () => {
    h = await startServer({ google: google.config(['acme.com']) });
    expect((await signIn({ sub: '4001', email: 'ana@acme.com', hd: 'acme.com' })).status).toBe(200);
    // A secondary domain of the same Workspace.
    expect((await signIn({ sub: '4002', email: 'leo@acme.io', hd: 'acme.com' })).status).toBe(200);
    expect(await signIn({ sub: '4003', email: 'eve@other.com', hd: 'other.com' })).toMatchObject({
      status: 403,
      body: { error: 'This server only accepts accounts from: acme.com' },
    });
    // A personal Google account created with a company address is not managed by the company.
    expect(await signIn({ sub: '4004', email: 'mallory@acme.com', hd: undefined })).toMatchObject({
      status: 403,
      body: { error: 'This server only accepts Google Workspace accounts from: acme.com. This is a personal Google account.' },
    });
    expect((await signIn({ sub: '4005', email: 'eve@gmail.com', hd: undefined })).status).toBe(403);
    expect(users()).toBe(2);

    h.server.setAuth({ google: google.config(['gmail.com']), passwordAuth: true });
    expect((await api<HealthResponse>(h.base, '/api/health')).body.auth.google.allowedDomains).toEqual(['gmail.com']);
    expect((await signIn({ sub: '4005', email: 'eve@gmail.com', hd: undefined })).status).toBe(200);
  });

  it('rejects ID tokens for another client or issuer, expired ones and forged signatures', async () => {
    h = await startServer({ google: google.config() });
    const now = Math.floor(Date.now() / 1000);
    google.claims = { aud: 'someone-else.apps.googleusercontent.com' };
    expect(await signIn()).toMatchObject({ status: 401, body: { error: 'Could not verify the Google sign-in (unexpected "aud" claim value)' } });
    google.claims = { iss: 'https://accounts.example.com' };
    expect(await signIn()).toMatchObject({ status: 401, body: { error: 'Could not verify the Google sign-in (unexpected "iss" claim value)' } });
    google.claims = { iat: now - 7200, exp: now - 3600 };
    expect(await signIn()).toMatchObject({ status: 401, body: { error: 'The Google sign-in expired. Try again.' } });
    google.claims = {};
    google.foreignKey = true;
    expect(await signIn()).toMatchObject({ status: 401, body: { error: 'Could not verify the Google sign-in (signature verification failed)' } });
    expect(users()).toBe(0);
  });

  it('checks the PKCE verifier, single-use codes, the loopback redirect and the client secret', async () => {
    h = await startServer({ google: google.config() });
    const used = 'The Google sign-in expired or was already used. Try again.';
    expect(await signIn({}, { verifier: randomBytes(32).toString('base64url') })).toMatchObject({ status: 401, body: { error: used } });

    const verifier = randomBytes(32).toString('base64url');
    const code = await google.authorize({ redirectUri: REDIRECT, challenge: challengeOf(verifier) });
    expect((await signIn({}, { code, verifier })).status).toBe(200);
    expect(await signIn({}, { code, verifier })).toMatchObject({ status: 401, body: { error: used } });

    for (const redirectUri of ['https://cooprompt.example.com/callback', 'not a url']) {
      expect(await signIn({}, { redirectUri })).toMatchObject({ status: 400, body: { error: 'redirectUri must be a loopback address' } });
    }

    h.server.setAuth({ google: { ...google.config(), clientSecret: 'wrong-secret' }, passwordAuth: true });
    expect(await signIn()).toMatchObject({
      status: 502,
      body: { error: 'Google did not accept the client ID and secret of this server. Whoever runs the server must check them.' },
    });
    h.server.setAuth({ google: { ...google.config(), endpoints: { token: 'http://127.0.0.1:9/token', jwks: `${google.url}/oauth2/v3/certs` } }, passwordAuth: true });
    expect(await signIn()).toMatchObject({ status: 502, body: { error: 'Could not reach Google. Try again.' } });
  });

  it('with Google accounts only, refuses password sign-up and sign-in and tells clients', async () => {
    h = await startServer({ google: google.config(['acme.com']), passwordAuth: false, accessCode: '123456' });
    const health = (await api<HealthResponse>(h.base, '/api/health')).body;
    expect(health.auth).toMatchObject({ password: false, accessCodeRequired: false, google: { enabled: true } });
    const signUp = await api(h.base, '/api/auth/register', { body: { email: 'eve@acme.com', password: 'contraseña-segura', accessCode: '123456' } });
    expect(signUp).toMatchObject({ status: 403, body: { error: 'Password sign-up is disabled on this server' } });
    expect((await api(h.base, '/api/auth/login', { body: { email: 'eve@acme.com', password: 'contraseña-segura' } })).status).toBe(403);
    expect((await signIn()).status).toBe(200);

    h.server.setAuth({ google: null, passwordAuth: true });
    expect((await api<HealthResponse>(h.base, '/api/health')).body.auth).toMatchObject({ password: true, accessCodeRequired: true, google: { enabled: false, clientId: null } });
    expect(await signIn()).toMatchObject({ status: 403, body: { error: 'This server does not have Google sign-in configured' } });
  });
});
