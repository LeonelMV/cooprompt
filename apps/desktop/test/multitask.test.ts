import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthResponse, ChatSummary, SendMessageResponse, TurnInfo } from '@cooprompt/protocol';
import { api, register, startServer, type Harness } from '../../server/test/helpers.ts';
import { AttachmentStore } from '../src/main/attachments.ts';
import { ApiClient } from '../src/main/net/api.ts';
import { Realtime } from '../src/main/net/realtime.ts';
import { Runner } from '../src/main/runner/runner.ts';
import { Settings } from '../src/main/settings.ts';
import { engineLog, until, writeFakeEngines, type EngineRun } from './fake-engines.ts';

describe('multitask turns on one Mac', () => {
  let bin: string;
  let h: Harness;
  let dir: string;
  let leo: AuthResponse;
  let chat: ChatSummary;
  let settings: Settings;
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    bin = await mkdtemp(join(tmpdir(), 'cooprompt-engines-'));
    await writeFakeEngines(bin);
    await writeFile(join(bin, 'cursor-agent'), `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL('./fake-cursor-agent.mjs', import.meta.url))}" "$@"\n`);
    await writeFile(
      join(bin, 'cursor-scenario.json'),
      JSON.stringify({
        sessions: ['s-new'],
        turn: [
          { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hola desde Cursor' } } },
          { update: { sessionUpdate: 'tool_call', toolCallId: 'ls', title: '`ls`', kind: 'execute', status: 'completed', rawInput: { command: 'ls' }, rawOutput: { exitCode: 0, stdout: 'README.md\n' } } },
        ],
      }),
    );
    await chmod(join(bin, 'cursor-agent'), 0o755);
  });

  afterAll(async () => {
    await rm(bin, { recursive: true, force: true });
  });

  async function setUp(options: { maxParallelTurns?: number } = {}) {
    const server = await startServer(options);
    const folder = await mkdtemp(join(tmpdir(), 'cooprompt-multitask-'));
    h = server;
    dir = folder;
    leo = await register(h.base, 'leo@acme.com', 'Leo');
    chat = (await api<ChatSummary>(h.base, '/api/chats', { token: leo.token, body: { title: 'Solo', kind: 'private' } })).body;
    settings = new Settings(join(dir, 'settings.json'), { syncRoot: join(dir, 'Compartidos'), privateRoot: join(dir, 'Privados') });
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
    const realtime = new Realtime();
    const runner = new Runner({
      api: new ApiClient(() => h.base, () => leo.token),
      realtime,
      settings,
      secrets: { get: (key) => (key === 'provider:claude-1' ? 'not-a-real-key' : null) },
      connectors: { serversFor: async () => ({}), nativeNames: async () => [], codexApprovalScopes: async () => [] },
      sync: { activate: async () => null, get: () => undefined },
      attachments: new AttachmentStore({ api: new ApiClient(() => h.base, () => leo.token), cacheDir: join(folder, 'attachments'), stagingDir: join(folder, 'attachments-staged'), log: () => {} }),
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
    // What AppCore does with the executor's messages.
    realtime.on('message', (message) => {
      if (message.t === 'turn.run') void runner.run(message.turn, message.chat, message.prompt);
      if (message.t === 'turn.cancel') runner.cancel(message.turnId);
    });
    cleanups.push(async () => {
      runner.cancelAll();
      await until(() => !runner.busy(), 5000).catch(() => {});
      realtime.disconnect();
      await server.close();
      await rm(folder, { recursive: true, force: true });
    });
    const ready = new Promise<{ maxParallelTurns: number | null }>((resolve) => realtime.once('ready', resolve));
    realtime.connect({ serverUrl: h.base, token: leo.token, deviceId: settings.data.deviceId, deviceName: 'Leo Mac', appVersion: 'test' });
    return ready;
  }

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  const send = async (text: string, options: { profileId?: string; parallel?: boolean; interruptTurnId?: string } = {}) => {
    const profile = options.profileId ?? 'codex-1';
    const engine = profile.startsWith('claude') ? 'claude' : profile.startsWith('cursor') ? 'cursor' : 'codex';
    const response = await api<SendMessageResponse>(h.base, `/api/chats/${chat.id}/messages`, {
      token: leo.token,
      body: {
        text,
        deviceId: settings.data.deviceId,
        config: { engine, profileId: profile, model: null, permissionMode: 'default' },
        ...(options.parallel ? { parallel: true } : {}),
        ...(options.interruptTurnId ? { interrupt: true, interruptTurnId: options.interruptTurnId } : {}),
      },
    });
    expect(response.status).toBe(200);
    return response.body.turn;
  };
  const turns = async () => (await api<TurnInfo[]>(h.base, `/api/chats/${chat.id}/turns`, { token: leo.token })).body;
  const status = async (turn: TurnInfo) => (await turns()).find((entry) => entry.id === turn.id)?.status;
  const ended = (...list: TurnInfo[]) => until(async () => (await turns()).filter((entry) => list.some((turn) => turn.id === entry.id) && entry.status !== 'queued' && entry.status !== 'running').length === list.length);
  const runs = (): Promise<EngineRun[]> => engineLog(dir);
  const runOf = async (request: string) => {
    await until(async () => (await runs()).some((run) => run.request === request));
    return (await runs()).find((run) => run.request === request)!;
  };
  const release = (name: string) => writeFile(join(dir, name), '');
  const count = (text: string, part: string) => text.split(part).length - 1;

  it("runs the same person's messages at once in separate Codex sessions and catches the next turn up on both, once", async () => {
    expect((await setUp()).maxParallelTurns).toBe(3);
    const one = await send('refactorizá el parser WAIT:one', { parallel: true });
    const first = await runOf('refactorizá el parser WAIT:one');
    expect(first.resumed).toBeNull();

    const two = await send('¿qué hora es?', { parallel: true });
    const second = await runOf('¿qué hora es?');
    expect(second.resumed).toBeNull();
    expect(second.session).not.toBe(first.session);
    expect(second.prompt).toContain('Running right now, beside this turn');
    expect(second.prompt).toContain('[Leo]: refactorizá el parser WAIT:one');
    expect(second.prompt).toContain('Other tasks can run at the same time as this one, in this same folder');
    await ended(two);
    expect(await status(one)).toBe('running');

    await release('one');
    await ended(one);
    const three = await send('¿qué hiciste hasta ahora?');
    const third = await runOf('¿qué hiciste hasta ahora?');
    expect(third.resumed).toBe(first.session);
    expect(count(third.prompt, '[Leo]: ¿qué hora es?')).toBe(1);
    expect(count(third.prompt, `Answer from ${second.session} to ¿qué hora es?`)).toBe(1);
    expect(third.prompt).not.toContain('refactorizá el parser');
    expect(third.prompt).not.toContain('Running right now');
    await ended(three);

    await send('seguí');
    const fourth = await runOf('seguí');
    expect(fourth.resumed).toBe(first.session);
    expect(fourth.prompt).not.toContain('¿qué hora es?');
  });

  it('forks the busy Claude session where its last turn ended and catches the main session up afterwards', async () => {
    await setUp();
    const start = await send('leé el README', { profileId: 'claude-1' });
    const opening = await runOf('leé el README');
    await ended(start);

    const long = await send('migrá la base WAIT:migration', { profileId: 'claude-1', parallel: true });
    const migration = await runOf('migrá la base WAIT:migration');
    expect(migration).toMatchObject({ resumed: opening.session, forked: false });

    const quick = await send('¿qué versión de Node usamos?', { profileId: 'claude-1', parallel: true });
    const fork = await runOf('¿qué versión de Node usamos?');
    expect(fork).toMatchObject({ resumed: opening.session, forked: true, resumeAt: opening.answered });
    expect(fork.session).not.toBe(opening.session);
    expect(fork.prompt).toContain('[Leo]: migrá la base WAIT:migration');
    await ended(quick);

    await release('migration');
    await ended(long);
    await send('resumí lo que pasó', { profileId: 'claude-1' });
    const next = await runOf('resumí lo que pasó');
    expect(next).toMatchObject({ resumed: opening.session, forked: false });
    expect(count(next.prompt, `Answer from ${fork.session} to ¿qué versión de Node usamos?`)).toBe(1);
    expect(next.prompt).not.toContain('migrá la base');
  });

  it('stops only the turn an interruption names, and the new message continues that turn’s session', async () => {
    await setUp();
    const five = await send('escribí los tests WAIT:five', { parallel: true });
    await runOf('escribí los tests WAIT:five');
    const six = await send('actualizá el changelog WAIT:six', { parallel: true });
    const side = await runOf('actualizá el changelog WAIT:six');

    const redirect = await send('mejor sólo la sección de 0.2', { parallel: true, interruptTurnId: six.id });
    expect(redirect.interrupts).toBe(six.id);
    await ended(six);
    expect((await turns()).find((turn) => turn.id === six.id)).toMatchObject({ status: 'cancelled', error: 'Interrupted by Leo' });
    expect(await status(five)).toBe('running');

    const continued = await runOf('mejor sólo la sección de 0.2');
    expect(continued.resumed).toBe(side.session);
    expect(continued.prompt).toContain('Your previous turn was interrupted before it finished');
    expect(continued.prompt).toContain('[Leo]: escribí los tests WAIT:five');
    await ended(redirect);
    await release('five');
    await ended(five);
  });

  it('runs Cursor turns through the same runner and resumes their session next time', async () => {
    await setUp();
    const first = await send('hola', { profileId: 'cursor-1' });
    await ended(first);
    const items = (await api<{ kind: string; turnId: string; data: Record<string, unknown> }[]>(h.base, `/api/chats/${chat.id}/items`, { token: leo.token })).body.filter((item) => item.turnId === first.id);
    expect(items.map((item) => [item.kind, item.data.text ?? item.data.name])).toEqual([
      ['user', 'hola'],
      ['text', 'Hola desde Cursor'],
      ['tool', 'Bash'],
    ]);
    expect((await turns()).find((turn) => turn.id === first.id)).toMatchObject({ status: 'done', config: { engine: 'cursor' } });

    await ended(await send('seguí', { profileId: 'cursor-1' }));
    const calls = (await readFile(join(dir, 'cursor.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method?: string; params?: { sessionId?: string } });
    expect(calls.filter((call) => call.method === 'session/new')).toHaveLength(1);
    expect(calls.find((call) => call.method === 'session/load')?.params?.sessionId).toBe('s-new');
  });

  it('runs messages one after another in the same session when the server has no multitask, like one that predates it', async () => {
    expect((await setUp({ maxParallelTurns: 1 })).maxParallelTurns).toBeNull();
    const one = await send('primero WAIT:first', { parallel: true });
    const first = await runOf('primero WAIT:first');
    const two = await send('segundo', { parallel: true });
    expect(await status(two)).toBe('queued');
    await release('first');
    await ended(one, two);
    const second = await runOf('segundo');
    expect(second.resumed).toBe(first.session);
    expect(second.prompt).not.toContain('Running right now');
    expect(second.prompt).not.toContain('Other tasks can run at the same time');
  });
});
