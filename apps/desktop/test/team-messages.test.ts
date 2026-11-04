import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AttachmentRef, AuthResponse, AutomationInfo, ChatSummary, Invitation, SendMessageResponse, SendTeamMessageResponse, ServerMessage, TurnInfo } from '@cooprompt/protocol';
import { api, register, startServer, TestSocket, type Harness } from '../../server/test/helpers.ts';
import { AttachmentStore } from '../src/main/attachments.ts';
import type { McpServerSpec } from '../src/main/engines/types.ts';
import { ApiClient } from '../src/main/net/api.ts';
import { Realtime } from '../src/main/net/realtime.ts';
import { Runner } from '../src/main/runner/runner.ts';
import { Settings } from '../src/main/settings.ts';
import { sendTeamMessage, TEAM_UNSUPPORTED } from '../src/main/team.ts';
import { composerMode } from '../src/renderer/src/lib/team.ts';
import { translate, translateMessage } from '../src/shared/i18n.ts';
import { engineLog, until, writeFakeEngines } from './fake-engines.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
const SECRET = 'ZORZAL-7731';
/** A sample connector passed to each engine. */
const SAMPLE: McpServerSpec = { type: 'stdio', command: process.execPath, args: ['out/main/sample.js', 'C0SAMPLE'], env: { ELECTRON_RUN_AS_NODE: '1' } };

describe('team-only messages and the agents', () => {
  let bin: string;
  let h: Harness;
  let dir: string;
  let shared: string;
  let leo: AuthResponse;
  let ana: AuthResponse;
  let chat: ChatSummary;
  let deviceId: string;
  let received: ServerMessage[];
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    bin = await mkdtemp(join(tmpdir(), 'cooprompt-engines-'));
    await writeFakeEngines(bin);
    await writeFile(join(bin, 'cursor-agent'), `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL('./fake-cursor-agent.mjs', import.meta.url))}" "$@"\n`);
    await chmod(join(bin, 'cursor-agent'), 0o755);
    await writeFile(join(bin, 'cursor-scenario.json'), JSON.stringify({ sessions: ['s-new'], turn: [{ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hola desde Cursor' } } }] }));
  });

  afterAll(async () => {
    await rm(bin, { recursive: true, force: true });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /** Leo's Mac runs his turns in a multiplayer chat with Ana; the shared folder is a plain one. */
  async function setUp() {
    h = await startServer();
    dir = await mkdtemp(join(tmpdir(), 'cooprompt-team-'));
    shared = join(dir, 'Compartidos', 'pagos');
    await mkdir(shared, { recursive: true });
    leo = await register(h.base, 'leo@acme.com', 'Leo');
    ana = await register(h.base, 'ana@acme.com', 'Ana');
    chat = (await api<ChatSummary>(h.base, '/api/chats', { token: leo.token, body: { title: 'Pagos', kind: 'multiplayer' } })).body;
    const invitation = (await api<Invitation>(h.base, `/api/chats/${chat.id}/invitations`, { token: leo.token, body: { userId: ana.user.id } })).body;
    await api(h.base, `/api/invitations/${invitation.id}/accept`, { token: ana.token, body: {} });
    const settings = new Settings(join(dir, 'settings.json'), { syncRoot: join(dir, 'Compartidos'), privateRoot: join(dir, 'Privados') });
    settings.update((data) => {
      data.serverUrl = h.base;
      data.user = leo.user;
      data.profiles = [
        { id: 'codex-1', label: 'Codex', engine: 'codex', kind: 'codex-login', createdAt: 1 },
        { id: 'claude-1', label: 'Claude', engine: 'claude', kind: 'anthropic', createdAt: 1 },
        { id: 'cursor-1', label: 'Cursor', engine: 'cursor', kind: 'cursor-login', createdAt: 1 },
      ];
      data.defaultProfileId = 'codex-1';
    });
    deviceId = settings.data.deviceId;
    const leoApi = new ApiClient(() => h.base, () => leo.token);
    const realtime = new Realtime();
    const runner = new Runner({
      api: leoApi,
      realtime,
      settings,
      secrets: { get: (key) => (key === 'provider:claude-1' ? 'not-a-real-key' : null) },
      connectors: { serversFor: async () => ({ sample: SAMPLE }), nativeNames: async () => [], codexApprovalScopes: async () => [] },
      sync: { activate: async () => ({ root: shared, ensureCaughtUp: async () => {}, flush: async () => {} }) as never, get: () => undefined },
      attachments: new AttachmentStore({ api: leoApi, cacheDir: join(dir, 'cache'), stagingDir: join(dir, 'staged'), log: () => {} }),
      appVersion: 'test',
      executables: { claude: () => join(bin, 'claude'), codex: () => ({ bin: join(bin, 'codex'), pathDirs: [] }), cursor: () => join(bin, 'cursor-agent') },
      shellEnv: () => ({
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: dir,
        CODEX_HOME: join(dir, 'codex-home'),
        FAKE_ENGINE_DIR: dir,
        FAKE_CURSOR_SCENARIO: join(bin, 'cursor-scenario.json'),
        FAKE_CURSOR_LOG: join(dir, 'cursor.jsonl'),
      }),
      user: () => settings.data.user,
      redact: (text) => text,
      engineInfo: () => {},
      notify: () => {},
    });
    received = [];
    realtime.on('message', (message) => {
      received.push(message);
      if (message.t === 'turn.run') void runner.run(message.turn, message.chat, message.prompt);
      if (message.t === 'turn.cancel') runner.cancel(message.turnId);
    });
    const server = h;
    const folder = dir;
    cleanups.push(async () => {
      runner.cancelAll();
      await until(() => !runner.busy(), 5000).catch(() => {});
      realtime.disconnect();
      await server.close();
      await rm(folder, { recursive: true, force: true });
    });
    const ready = new Promise<{ teamMessages: boolean }>((resolve) => realtime.once('ready', resolve));
    realtime.connect({ serverUrl: h.base, token: leo.token, deviceId, deviceName: 'Leo Mac', appVersion: 'test' });
    return ready;
  }

  const team = async (token: string, text: string, attachments: AttachmentRef[] = []) => {
    const response = await api<SendTeamMessageResponse>(h.base, `/api/chats/${chat.id}/team-messages`, { token, body: { text, attachments: attachments.map((file) => file.id) } });
    expect(response.status).toBe(200);
    return response.body.item;
  };
  const upload = async (token: string, name: string) => (await api<AttachmentRef>(h.base, `/api/chats/${chat.id}/attachments?name=${encodeURIComponent(name)}`, { token, raw: PNG })).body;
  const send = async (text: string, profileId = 'codex-1', parallel = false) => {
    const engine = profileId.split('-')[0];
    const response = await api<SendMessageResponse>(h.base, `/api/chats/${chat.id}/messages`, {
      token: leo.token,
      body: { text, deviceId, config: { engine, profileId, model: null, permissionMode: 'default' }, ...(parallel ? { parallel: true } : {}) },
    });
    expect(response.status).toBe(200);
    return response.body.turn;
  };
  const turns = async () => (await api<TurnInfo[]>(h.base, `/api/chats/${chat.id}/turns`, { token: leo.token })).body;
  const ended = (...list: TurnInfo[]) => until(async () => (await turns()).filter((turn) => list.some((entry) => entry.id === turn.id) && turn.status !== 'queued' && turn.status !== 'running').length === list.length);
  /** Prompts in shared chats start with their author's name. */
  const runOf = async (request: string) => {
    const matches = (run: { request: string; asked?: string }) => run.request.endsWith(request) && !run.asked;
    await until(async () => (await engineLog(dir)).some(matches));
    return (await engineLog(dir)).find(matches)!;
  };
  /** Everything every engine process got (arguments, stdin, ACP traffic) that mentions the secret. */
  const leaks = async () => {
    const cursor = existsSync(join(dir, 'cursor.jsonl')) ? await readFile(join(dir, 'cursor.jsonl'), 'utf8') : '';
    return [...(await engineLog(dir)).map((run) => JSON.stringify(run)), cursor].filter((text) => /zorzal/i.test(text));
  };

  it('keeps them out of every engine’s context: catch-ups, forks, Cursor, automation runs, connectors and file copies', async () => {
    expect((await setUp()).teamMessages).toBe(true);
    const anaMac = await TestSocket.connect(h.base, ana.token, 'ana-device-0001');
    cleanups.unshift(async () => anaMac.close());

    const file = await upload(ana.token, 'zorzal-7731.png');
    await team(ana.token, `Equipo: la clave de staging es ${SECRET}, no se la pasen a la IA`, [file]);
    await team(leo.token, `Dale, ${SECRET} queda entre nosotros`);
    await until(() => received.some((message) => message.t === 'team.message' && message.authorName === 'Ana'));
    // Ana's own turn, on her Mac, which Leo's agents do hear about.
    await api(h.base, `/api/chats/${chat.id}/messages`, { token: ana.token, body: { text: 'revisá el endpoint de pagos', deviceId: 'ana-device-0001', config: { engine: 'codex', profileId: 'x', model: null, permissionMode: 'default' } } });
    const anaTurn = await anaMac.waitFor<'turn.run'>((message) => message.t === 'turn.run');
    anaMac.send({ t: 'turn.items', turnId: anaTurn.turn.id, items: [{ id: `${anaTurn.turn.id}.text`, kind: 'text', data: { text: 'El endpoint responde 200' } }] });
    anaMac.send({ t: 'turn.finish', turnId: anaTurn.turn.id, status: 'done' });
    await ended(anaTurn.turn);

    const codex = await send('¿qué dijo el equipo?');
    const first = await runOf('¿qué dijo el equipo?');
    expect(first.prompt).toContain('Chat history so far:');
    expect(first.prompt).toContain('[Ana]: revisá el endpoint de pagos');
    expect(first.prompt).toContain("[Ana's agent]: El endpoint responde 200");
    expect(first.prompt).not.toContain('team-only message');
    await ended(codex);

    const opening = await send('leé el README', 'claude-1');
    await runOf('leé el README');
    await ended(opening);
    await team(ana.token, `${SECRET} también abre el panel de admin`);
    const long = await send('migrá la base WAIT:migration', 'claude-1', true);
    const main = await runOf('migrá la base WAIT:migration');
    const quick = await send('¿qué dijo Ana?', 'claude-1', true);
    const fork = await runOf('¿qué dijo Ana?');
    expect(main).toMatchObject({ forked: false });
    expect(fork).toMatchObject({ forked: true });
    await ended(quick);
    await writeFile(join(dir, 'migration'), '');
    await ended(long);

    await ended(await send('hola Cursor', 'cursor-1'));
    expect(await readFile(join(dir, 'cursor.jsonl'), 'utf8')).toContain('hola Cursor');

    await team(leo.token, `recuerden: ${SECRET}`);
    const automation = (
      await api<AutomationInfo>(h.base, '/api/automations', {
        token: leo.token,
        body: { name: 'Pendientes', instructions: 'revisá los pendientes', chatId: chat.id, deviceId, timeZone: 'America/Argentina/Buenos_Aires', schedule: { kind: 'daily', time: '09:00' }, config: { engine: 'claude', profileId: 'claude-1', model: null, permissionMode: 'plan' } },
      })
    ).body;
    await api(h.base, `/api/automations/${automation.id}/run`, { token: leo.token, body: {} });
    const run = await runOf('revisá los pendientes');
    expect(run.prompt).toContain('This turn was started by the automation “Pendientes”');
    await until(async () => (await turns()).every((turn) => turn.status !== 'queued' && turn.status !== 'running'));

    expect(await leaks()).toEqual([]);
    expect(JSON.stringify((await engineLog(dir)).map((entry) => entry.args))).toContain('C0SAMPLE');
    const copies = existsSync(join(shared, '.cooprompt', 'attachments')) ? await readdir(join(shared, '.cooprompt', 'attachments')) : [];
    expect(copies).not.toContain(file.id);
    expect(existsSync(join(dir, 'cache', chat.id, file.id))).toBe(false);
    // Ana's, Codex's, three of Claude, Cursor's and the automation's: none from a team-only message.
    expect((await turns()).length).toBe(7);
  });

  it('lets its author share one with the agents: the next turn gets it once, as anyone’s message', async () => {
    await setUp();
    const deadline = await team(ana.token, 'el corte de la release es el jueves');
    await team(ana.token, `${SECRET} sigue siendo solo nuestro`);
    await ended(await send('hola'));
    expect((await runOf('hola')).prompt).not.toContain('el corte de la release');

    const sharing = await api(h.base, `/api/chats/${chat.id}/team-messages/${deadline.id}/share`, { token: ana.token, body: {} });
    expect(sharing.body.item).toMatchObject({ kind: 'user', turnId: null });
    await ended(await send('¿cuándo es el corte?'));
    const next = await runOf('¿cuándo es el corte?');
    expect(next.prompt.split('[Ana]: el corte de la release es el jueves')).toHaveLength(2);
    await ended(await send('seguí'));
    expect((await runOf('seguí')).prompt).not.toContain('el corte de la release');
    expect(await leaks()).toEqual([]);
  });

  it('sends them through their own endpoint, so they never become a turn', async () => {
    await setUp();
    const store = new AttachmentStore({ api: new ApiClient(() => h.base, () => leo.token), cacheDir: join(dir, 'leo-cache'), stagingDir: join(dir, 'leo-staged'), log: () => {} });
    const staged = await store.stage('captura.png', PNG);
    const sent = await sendTeamMessage({ api: new ApiClient(() => h.base, () => leo.token), attachments: store, supported: true }, { chatId: chat.id, text: 'miren esto', attachments: [staged.id] });
    expect(sent.item).toMatchObject({ kind: 'team', turnId: null, data: { text: 'miren esto', attachments: [expect.objectContaining({ name: 'captura.png', kind: 'image' })] } });
    expect(await turns()).toEqual([]);
  });
});

describe('a team server that predates team-only messages', () => {
  let old: Server;
  let base: string;
  let requests: string[];

  beforeAll(async () => {
    old = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader('content-type', 'application/json');
      if (request.url?.endsWith('/messages')) return response.end(JSON.stringify({}));
      response.statusCode = 404;
      response.end(JSON.stringify({ message: `Route ${request.method}:${request.url} not found`, error: 'Not Found', statusCode: 404 }));
    });
    await new Promise<void>((resolve) => old.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(old.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => old.close(resolve));
  });

  const deps = (supported: boolean | null) => ({
    api: new ApiClient(() => base, () => 'token'),
    attachments: { uploadStaged: async () => [], commit: async () => {} },
    supported,
  });

  it('never gets one as a message for the agent: refused before sending once it said it can’t, and failing when it has no endpoint', async () => {
    requests = [];
    await expect(sendTeamMessage(deps(false), { chatId: 'c1', text: 'solo para ustedes' })).rejects.toThrow(TEAM_UNSUPPORTED);
    expect(requests).toEqual([]);
    await expect(sendTeamMessage(deps(null), { chatId: 'c1', text: 'solo para ustedes' })).rejects.toThrow(TEAM_UNSUPPORTED);
    expect(requests).toEqual(['POST /api/chats/c1/team-messages']);
  });

  it('keeps the composer from sending to the agent while team-only is on', () => {
    expect(composerMode({ teamOnly: true, supported: false, kind: 'multiplayer' })).toBe('blocked');
    expect(composerMode({ teamOnly: true, supported: null, kind: 'multiplayer' })).toBe('team');
    expect(composerMode({ teamOnly: true, supported: true, kind: 'corporate' })).toBe('team');
    expect(composerMode({ teamOnly: false, supported: false, kind: 'multiplayer' })).toBe('agent');
    expect(composerMode({ teamOnly: true, supported: true, kind: 'private' })).toBe('agent');
  });
});

describe('team-only messages in Spanish', () => {
  it('localizes what the server and the app say about them', () => {
    expect(translateMessage('es', 'Ana Pérez sent a team-only message: update CooPrompt to read it.')).toBe('Ana Pérez mandó un mensaje solo para el equipo: actualizá CooPrompt para leerlo.');
    expect(translateMessage('es', 'Only its author can share a team-only message with the AI')).toBe('Solo quien lo escribió puede compartir un mensaje solo para el equipo con la IA');
    expect(translate('es', TEAM_UNSUPPORTED)).toBe('Este servidor del equipo todavía no acepta mensajes solo para el equipo: quien lo aloja tiene que actualizar CooPrompt.');
    expect(translate('es', 'Team only · the AI doesn’t see it')).toBe('Solo equipo · la IA no lo ve');
  });
});
