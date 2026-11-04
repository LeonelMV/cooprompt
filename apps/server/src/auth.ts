import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose';
import { normalizeEmail } from '@cooprompt/protocol';
import { HttpError } from './errors.ts';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Restricts sign-in to Google Workspace accounts of these domains when non-empty. */
  allowedDomains: string[];
  /** Google's own unless set; tests point them at a stand-in. */
  endpoints?: { token: string; jwks: string };
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
  /** Google vouches that the person owns the address today (Gmail and Google Workspace accounts). */
  ownsEmail: boolean;
}

const GOOGLE_ENDPOINTS = { token: 'https://oauth2.googleapis.com/token', jwks: 'https://www.googleapis.com/oauth2/v3/certs' };
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksByUrl.get(url);
  if (!set) jwksByUrl.set(url, (set = createRemoteJWKSet(new URL(url))));
  return set;
}

/** "acme.com, @Example.org" → ["acme.com", "example.org"]. */
export function parseAllowedDomains(value: string): string[] {
  return value
    .split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

function isLoopback(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function tokenError(status: number, error: string): HttpError {
  if (status === 401 || error === 'invalid_client' || error === 'unauthorized_client') {
    return new HttpError(502, 'Google did not accept the client ID and secret of this server. Whoever runs the server must check them.');
  }
  if (error === 'invalid_grant') return new HttpError(401, 'The Google sign-in expired or was already used. Try again.');
  return new HttpError(401, `Google rejected the sign-in (${status}): ${error || 'no details'}`);
}

/** Exchanges a desktop loopback authorization code (PKCE) and verifies the returned ID token. */
export async function exchangeGoogleCode(
  config: GoogleConfig,
  input: { code: string; codeVerifier: string; redirectUri: string },
): Promise<GoogleIdentity> {
  if (!isLoopback(input.redirectUri)) throw new HttpError(400, 'redirectUri must be a loopback address');
  const endpoints = config.endpoints ?? GOOGLE_ENDPOINTS;
  let response: Response;
  try {
    response = await fetch(endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: input.codeVerifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, 'Could not reach Google. Try again.');
  }
  const body = (await response.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown };
  if (!response.ok) throw tokenError(response.status, typeof body.error === 'string' ? body.error.slice(0, 100) : '');
  if (typeof body.id_token !== 'string') throw new HttpError(401, 'Google did not return an id_token');
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(body.id_token, jwks(endpoints.jwks), {
      issuer: GOOGLE_ISSUERS,
      audience: config.clientId,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp'],
    }));
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw new HttpError(401, 'The Google sign-in expired. Try again.');
    // Anything else that isn't a verdict on the token means Google's signing keys could not be fetched.
    if (!(error instanceof errors.JOSEError) || error instanceof errors.JWKSTimeout || error.code === errors.JOSEError.code) {
      throw new HttpError(502, 'Could not reach Google. Try again.');
    }
    throw new HttpError(401, `Could not verify the Google sign-in (${error.message})`);
  }
  const email = typeof payload.email === 'string' ? normalizeEmail(payload.email) : null;
  if (!email || payload.email_verified !== true) throw new HttpError(401, 'The Google account has no verified email');
  const emailDomain = email.split('@')[1];
  const hostedDomain = typeof payload.hd === 'string' ? payload.hd.toLowerCase() : null;
  // Google is authoritative for Gmail addresses and for accounts of a Google Workspace (`hd`), which
  // owns every domain its addresses use. Other Google accounts only proved the address once.
  const vouchedDomains = hostedDomain ? [hostedDomain, emailDomain] : emailDomain === 'gmail.com' ? [emailDomain] : [];
  if (config.allowedDomains.length > 0 && !vouchedDomains.some((domain) => config.allowedDomains.includes(domain))) {
    const domains = config.allowedDomains.join(', ');
    throw new HttpError(
      403,
      vouchedDomains.length === 0 && config.allowedDomains.includes(emailDomain)
        ? `This server only accepts Google Workspace accounts from: ${domains}. This is a personal Google account.`
        : `This server only accepts accounts from: ${domains}`,
    );
  }
  return {
    sub: String(payload.sub),
    email,
    name: typeof payload.name === 'string' && payload.name.trim() ? payload.name : email.split('@')[0],
    picture: typeof payload.picture === 'string' ? payload.picture : null,
    ownsEmail: vouchedDomains.length > 0,
  };
}
