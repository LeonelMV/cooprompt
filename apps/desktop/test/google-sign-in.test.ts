import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublicUser } from '@cooprompt/protocol';
import { FakeGoogle } from '../../server/test/fake-google.ts';
import { api, register, startServer, type Harness } from '../../server/test/helpers.ts';
import { googleSignIn, type GoogleSignInOptions } from '../src/main/google.ts';
import { setLanguage } from '../src/main/i18n.ts';
import { ApiClient } from '../src/main/net/api.ts';
import { translateMessage } from '../src/shared/i18n.ts';

describe('Google sign-in from the app', () => {
  let google: FakeGoogle;
  let h: Harness;

  beforeEach(async () => {
    google = await FakeGoogle.start();
    h = await startServer({ google: google.config(['acme.com']) });
  });

  afterEach(async () => {
    setLanguage('en');
    await h.close();
    await google.close();
  });

  const signIn = (options: Partial<GoogleSignInOptions> = {}) =>
    googleSignIn({
      api: new ApiClient(() => null, () => null),
      serverUrl: h.base,
      clientId: google.clientId,
      allowedDomains: ['acme.com'],
      openBrowser: google.browser,
      authorizationEndpoint: google.authorizationEndpoint,
      ...options,
    });

  it('signs in through the browser and the loopback with PKCE, and gets a working session', async () => {
    const auth = await signIn();
    expect(auth.user).toMatchObject({ email: 'ana@acme.com', orgDomain: 'acme.com' });
    expect((await api<PublicUser>(h.base, '/api/me', { token: auth.token })).body.id).toBe(auth.user.id);

    const [request] = google.authorizations;
    expect(Object.fromEntries(request)).toMatchObject({
      client_id: google.clientId,
      response_type: 'code',
      scope: 'openid email profile',
      code_challenge_method: 'S256',
      prompt: 'select_account',
      hd: 'acme.com',
    });
    expect(request.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(request.get('state')!.length).toBeGreaterThanOrEqual(20);
  });

  it('lands in the password account that has the same email', async () => {
    const password = await register(h.base, 'ana@acme.com', 'Ana');
    expect((await signIn()).user.id).toBe(password.user.id);
  });

  it('ignores a callback forged with another state and completes with the one Google sends', async () => {
    let forged = 0;
    const auth = await signIn({
      openBrowser: async (url) => {
        const redirectUri = new URL(url).searchParams.get('redirect_uri')!;
        forged = (await fetch(`${redirectUri}?code=forged&state=guessed`)).status;
        await google.browser(url);
      },
    });
    expect(forged).toBe(400);
    expect(auth.user.email).toBe('ana@acme.com');
  });

  it('explains a cancelled consent, a cancelled wait and the server rejecting the account, in the app language', async () => {
    setLanguage('es');
    google.deny = 'access_denied';
    await expect(signIn()).rejects.toThrow('Se canceló el inicio de sesión en el navegador.');

    const controller = new AbortController();
    controller.abort();
    await expect(signIn({ openBrowser: async () => {}, signal: controller.signal })).rejects.toThrow('Inicio de sesión cancelado');

    google.account = { sub: '7', email: 'eve@other.com', hd: 'other.com' };
    await expect(signIn()).rejects.toThrow('Este servidor sólo acepta cuentas de: acme.com');
  });

  it('has a Spanish template for every message the server sends about Google sign-in', () => {
    const messages = [
      'This server does not have Google sign-in configured',
      'Google did not accept the client ID and secret of this server. Whoever runs the server must check them.',
      'The Google sign-in expired or was already used. Try again.',
      'Google rejected the sign-in (400): redirect_uri_mismatch',
      'Could not reach Google. Try again.',
      'Google did not return an id_token',
      'The Google sign-in expired. Try again.',
      'Could not verify the Google sign-in (unexpected "aud" claim value)',
      'The Google account has no verified email',
      'This server only accepts accounts from: acme.com',
      'This server only accepts Google Workspace accounts from: acme.com. This is a personal Google account.',
      'An account with this email already exists, and Google cannot confirm the address is yours. Sign in with your password.',
      'This account signs in with Google: use Continue with Google.',
      'Password sign-up is disabled on this server',
      'Password sign-in is disabled on this server',
    ];
    for (const message of messages) expect(translateMessage('es', message), message).not.toBe(message);
    expect(translateMessage('es', 'This server only accepts Google Workspace accounts from: acme.com. This is a personal Google account.')).toBe(
      'Este servidor sólo acepta cuentas de Google Workspace de: acme.com. Esta es una cuenta personal de Google.',
    );
  });
});
