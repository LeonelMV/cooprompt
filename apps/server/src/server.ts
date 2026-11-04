import { mkdir } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { Attachments } from './attachments.ts';
import type { GoogleConfig } from './auth.ts';
import { registerAutomationRoutes } from './automation-routes.ts';
import { Automations, type AutomationOptions } from './automations.ts';
import { Database } from './db.ts';
import { HttpError } from './errors.ts';
import { registerFileRoutes, MAX_FILE_BYTES } from './files.ts';
import { Hub } from './hub.ts';
import { registerInstallerRoutes, releaseDescriber, type InstallerFile, type InstallerSource } from './installer.ts';
import { registerRoutes } from './routes.ts';
import { Store } from './store.ts';
import { registerTeamRoutes } from './team-routes.ts';

export const SERVER_VERSION = '0.1.0';

export interface CooPromptServerOptions {
  dataDir: string;
  host?: string;
  port?: number;
  name?: string;
  google?: GoogleConfig | null;
  passwordAuth?: boolean;
  /** Required to self-register with a password; null disables the check. */
  accessCode?: string | null;
  /** Serves `/instalar` and `/descargar/CooPrompt.zip` so teammates install with one command, and announces its version in `/api/health`. */
  installer?: InstallerSource | null;
  /** Turns a chat runs at once when they are sent in multitask mode (default 3); 1 turns multitask off. */
  maxParallelTurns?: number;
  /** Limits and clock of the automation scheduler. */
  automations?: AutomationOptions;
  log?: (message: string) => void;
}

export const DEFAULT_MAX_PARALLEL_TURNS = 3;

export interface CooPromptServer {
  app: FastifyInstance;
  store: Store;
  port: number;
  host: string;
  /** URLs other machines can use to reach this server (LAN addresses first). */
  urls: string[];
  /** Applies to the next sign-ups without restarting; null lets anyone with the address register. */
  setAccessCode(code: string | null): void;
  /** Applies to the next sign-ins without restarting. */
  setAuth(auth: { google: GoogleConfig | null; passwordAuth: boolean }): void;
  /** Tells connected apps the server is going down to update, so they know why they are offline. */
  announceRestart(version: string | null): void;
  close(): Promise<void>;
}

export function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

export async function createCooPromptServer(options: CooPromptServerOptions): Promise<CooPromptServer> {
  const log = options.log ?? ((message: string) => console.log(message));
  await mkdir(options.dataDir, { recursive: true });
  const db = new Database(join(options.dataDir, 'cooprompt.db'));
  const store = new Store(db);
  const interrupted = store.failInterruptedTurns('The server restarted during the turn');
  if (interrupted > 0) log(`server: ${interrupted} interrupted turns marked as failed`);
  const hub = new Hub(store, log, options.maxParallelTurns ?? DEFAULT_MAX_PARALLEL_TURNS);
  const attachments = new Attachments(store, options.dataDir, log);
  const automations = new Automations(store, hub, options.automations, log);

  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
  await app.register(websocket, { options: { maxPayload: 8 * 1024 * 1024 } });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      reply.status(error.status).send({ error: error.message, ...(error.body ?? {}) });
      return;
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) log(`server error: ${error instanceof Error ? error.stack : String(error)}`);
    reply.status(status).send({ error: error instanceof Error ? error.message : 'Internal error' });
  });

  const release = releaseDescriber(options.installer ?? null);
  void release();
  const routes = {
    store,
    hub,
    name: options.name ?? 'CooPrompt',
    version: SERVER_VERSION,
    google: options.google ?? null,
    passwordAuth: options.passwordAuth ?? true,
    accessCode: options.accessCode ?? null,
    release,
    attachments,
  };
  registerRoutes(app, routes);
  registerFileRoutes(app, { store, hub, dataDir: options.dataDir });
  attachments.register(app);
  registerTeamRoutes(app, { store, hub, attachments });
  registerAutomationRoutes(app, { store, hub, automations });
  registerInstallerRoutes(app, { name: options.name ?? 'CooPrompt', installer: options.installer ?? null });

  app.get('/ws', { websocket: true }, (socket) => hub.attach(socket));

  const host = options.host ?? '0.0.0.0';
  await app.listen({ host, port: options.port ?? 4317 });
  automations.start();
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 4317);
  const urls =
    host === '0.0.0.0' || host === '::'
      ? [...lanAddresses().map((ip) => `http://${ip}:${port}`), `http://127.0.0.1:${port}`]
      : [`http://${host}:${port}`];

  return {
    app,
    store,
    port,
    host,
    urls,
    setAccessCode(code) {
      routes.accessCode = code;
    },
    setAuth(auth) {
      routes.google = auth.google;
      routes.passwordAuth = auth.passwordAuth;
    },
    announceRestart(version) {
      hub.announceRestart(version);
    },
    async close() {
      automations.close();
      hub.close();
      attachments.close();
      // Fastify closes idle connections once; one that finishes sending a file just after would keep `close` waiting for its keep-alive timeout.
      const idle = setInterval(() => app.server.closeIdleConnections(), 50);
      try {
        await app.close();
      } finally {
        clearInterval(idle);
      }
      db.close();
    },
  };
}

export { MAX_FILE_BYTES };
export { parseAllowedDomains } from './auth.ts';
export { DEFAULT_MIN_INTERVAL_MINUTES } from './automations.ts';
export { latestRelease } from './installer.ts';
export type { GoogleConfig, InstallerFile, InstallerSource };
