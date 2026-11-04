import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { language, tr } from './i18n.ts';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const PAGE = (title: string, body: string) => `<!doctype html><html lang="${language()}"><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<body style="font-family:-apple-system,system-ui;background:#1a1a18;color:#ece9e4;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2 style="font-weight:600">${escapeHtml(title)}</h2><p style="color:#a8a29e">${escapeHtml(body)}</p></div></body></html>`;

/** OAuth error codes the browser brings back (RFC 6749 §4.1.2.1), worded for people. */
const failure = (error: string) => (error === 'access_denied' ? tr('Sign-in was cancelled in the browser.') : tr('The sign-in failed: {error}', { error }));

export interface Loopback {
  redirectUri: string;
  waitForCode(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<{ code: string; state: string | null }>;
  close(): void;
}

const listen = (server: Server, port: number, host: string) =>
  new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

/**
 * Local redirect target for OAuth flows run in the system browser (RFC 8252 loopback). With
 * `hostname: 'localhost'` the redirect matches clients registered as http://localhost:<port>/callback.
 * With `state`, callbacks without it get an error page and are ignored, so a request forged by some
 * other page can neither complete nor break the sign-in.
 */
export async function startLoopback(options: { port?: number; path?: string; hostname?: 'localhost'; state?: string } = {}): Promise<Loopback> {
  const path = options.path ?? '/callback';
  let settle: ((value: { code: string; state: string | null } | Error) => void) | null = null;
  const pending = new Promise<{ code: string; state: string | null } | Error>((resolve) => {
    settle = resolve;
  });
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== path) {
      response.writeHead(404).end();
      return;
    }
    const state = url.searchParams.get('state');
    if (options.state !== undefined && state !== options.state) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE(tr('Could not sign in'), tr('This answer does not belong to the sign-in CooPrompt started. Go back to CooPrompt and try again.')));
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (error || !code) {
      response.end(PAGE(tr('Could not sign in'), error ? failure(error) : tr('The authorization code is missing.')));
      settle?.(new Error(error ? failure(error) : tr('No authorization code')));
    } else {
      response.end(PAGE(tr('Done ✓'), tr('You can close this tab and go back to CooPrompt.')));
      settle?.({ code, state });
    }
  };
  const server = createServer(handler);
  await listen(server, options.port ?? 0, '127.0.0.1');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
  const servers = [server];
  if (options.hostname === 'localhost') {
    // Browsers may try ::1 first for "localhost".
    const ipv6 = createServer(handler);
    if (await listen(ipv6, port, '::1').then(() => true, () => false)) servers.push(ipv6);
  }
  return {
    redirectUri: `http://${options.hostname ?? '127.0.0.1'}:${port}${path}`,
    async waitForCode({ timeoutMs = 5 * 60_000, signal } = {}) {
      const timer = setTimeout(() => settle?.(new Error(tr('Sign-in timed out'))), timeoutMs);
      const cancel = () => settle?.(new Error(tr('Sign-in cancelled')));
      if (signal?.aborted) cancel();
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        const result = await pending;
        if (result instanceof Error) throw result;
        return result;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
    },
    close() {
      // Also drops kept-alive browser connections, which would otherwise keep reaching this
      // handler (and its state) when the next attempt listens on the same port.
      for (const entry of servers) {
        entry.close();
        entry.closeAllConnections();
      }
    },
  };
}
