import { createHash, randomBytes } from 'node:crypto';
import type { AuthResponse } from '@cooprompt/protocol';
import { startLoopback } from './loopback.ts';
import type { ApiClient } from './net/api.ts';

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface GoogleSignInOptions {
  api: ApiClient;
  serverUrl: string;
  clientId: string;
  /** With a single domain, Google's account chooser offers only that organization's accounts. */
  allowedDomains?: string[];
  /** Opens the system browser. */
  openBrowser(url: string): Promise<void>;
  /** Gives up waiting for the browser. */
  signal?: AbortSignal;
  /** Google's own unless set; tests point it at a stand-in. */
  authorizationEndpoint?: string;
}

/**
 * Google sign-in for installed apps: the browser redirects to a loopback port on this computer with
 * an authorization code (PKCE). The server exchanges it and verifies the ID token signature.
 */
export async function googleSignIn(options: GoogleSignInOptions): Promise<AuthResponse> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  const loopback = await startLoopback({ state });
  try {
    const url = new URL(options.authorizationEndpoint ?? GOOGLE_AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: options.clientId,
      redirect_uri: loopback.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      prompt: 'select_account',
      ...(options.allowedDomains?.length === 1 ? { hd: options.allowedDomains[0] } : {}),
    }).toString();
    await options.openBrowser(url.toString());
    const { code } = await loopback.waitForCode({ signal: options.signal });
    return await options.api.request<AuthResponse>('POST', '/api/auth/google', { code, codeVerifier: verifier, redirectUri: loopback.redirectUri }, { base: options.serverUrl, auth: false });
  } finally {
    loopback.close();
  }
}
