import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthResponse, ClientFeature, ClientMessage, ServerMessage } from '@cooprompt/protocol';
import type { AutomationOptions } from '../src/automations.ts';
import { createCooPromptServer, type GoogleConfig, type CooPromptServer } from '../src/server.ts';

export interface Harness {
  server: CooPromptServer;
  base: string;
  dataDir: string;
  close(): Promise<void>;
}

export async function startServer(
  options: { accessCode?: string | null; google?: GoogleConfig | null; passwordAuth?: boolean; maxParallelTurns?: number; automations?: AutomationOptions; dataDir?: string } = {},
): Promise<Harness> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'cooprompt-test-')));
  const server = await createCooPromptServer({
    dataDir,
    host: '127.0.0.1',
    port: 0,
    accessCode: options.accessCode ?? null,
    google: options.google ?? null,
    passwordAuth: options.passwordAuth,
    maxParallelTurns: options.maxParallelTurns,
    automations: options.automations,
    log: () => {},
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    server,
    base,
    dataDir,
    async close() {
      await server.close();
      // A data folder passed in belongs to the caller, who may start another server on it.
      if (!options.dataDir) await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export async function api<T = any>(base: string, path: string, init: { method?: string; token?: string; body?: unknown; raw?: NonNullable<RequestInit["body"]>; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let body: RequestInit["body"] | undefined;
  if (init.raw !== undefined) {
    body = init.raw;
    headers['content-type'] = 'application/octet-stream';
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${base}${path}`, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body });
  const type = response.headers.get('content-type') ?? '';
  const payload = type.includes('application/json') ? await response.json() : await response.arrayBuffer();
  return { status: response.status, body: payload as T };
}

export async function register(base: string, email: string, name: string, accessCode?: string): Promise<AuthResponse> {
  const result = await api<AuthResponse>(base, '/api/auth/register', { body: { email, name, password: 'contraseña-segura', accessCode } });
  if (result.status !== 200) throw new Error(`register failed: ${JSON.stringify(result.body)}`);
  return result.body;
}

export class TestSocket {
  readonly messages: ServerMessage[] = [];
  /** Resolves with the close code once the connection ends. */
  readonly closed: Promise<number>;
  private readonly ws: WebSocket;
  private waiters: { predicate: (message: ServerMessage) => boolean; resolve: (message: ServerMessage) => void }[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => ws.addEventListener('close', (event) => resolve(event.code), { once: true }));
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      this.messages.push(message);
      this.waiters = this.waiters.filter((waiter) => {
        if (!waiter.predicate(message)) return true;
        waiter.resolve(message);
        return false;
      });
    });
  }

  /** Without `features` it introduces itself like an app that predates them. */
  static async connect(base: string, token: string, deviceId: string, deviceName = 'Test Mac', features?: ClientFeature[]): Promise<TestSocket> {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
    });
    const socket = new TestSocket(ws);
    socket.send({ t: 'hello', token, deviceId, deviceName, appVersion: 'test', ...(features ? { features } : {}) });
    await socket.waitFor((message) => message.t === 'ready');
    return socket;
  }

  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  waitFor<T extends ServerMessage['t']>(predicate: (message: ServerMessage) => boolean, timeoutMs = 3000): Promise<Extract<ServerMessage, { t: T }>> {
    const found = this.messages.find(predicate);
    if (found) return Promise.resolve(found as Extract<ServerMessage, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message as Extract<ServerMessage, { t: T }>);
        },
      });
    });
  }

  clear(): void {
    this.messages.length = 0;
  }

  close(): void {
    this.ws.close();
  }
}
