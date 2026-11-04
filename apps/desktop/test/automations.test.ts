import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthResponse, AutomationInfo, AutomationRun, ChatSummary, PermissionItemData, QuestionItemData, SendMessageResponse, TranscriptItem, TurnInfo } from '@cooprompt/protocol';
import { api, register, startServer, type Harness } from '../../server/test/helpers.ts';
import { AttachmentStore } from '../src/main/attachments.ts';
import { ApiClient } from '../src/main/net/api.ts';
import { Realtime } from '../src/main/net/realtime.ts';
import { Runner } from '../src/main/runner/runner.ts';
import { Settings } from '../src/main/settings.ts';
import { translateMessage } from '../src/shared/i18n.ts';
import { engineLog, until, writeFakeEngines } from './fake-engines.ts';

const BUENOS_AIRES = 'America/Argentina/Buenos_Aires';

describe('automation runs on the owner’s Mac', () => {
  let bin: string;
  let h: Harness;
  let dir: string;
  let leo: AuthResponse;
  let chat: ChatSummary;
  let settings: Settings;
  let notified: string[];
  const clock = { now: Date.parse('2026-10-26T11:00:00Z') };
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    bin = await mkdtemp(join(tmpdir(), 'cooprompt-engines-'));
    await writeFakeEngines(bin);
  });

  afterAll(async () => {
    await rm(bin, { recursive: true, force: true });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function setUp() {
    clock.now = Date.parse('2026-10-26T11:00:00Z');
    notified = [];
    h = await startServer({ automations: { now: () => clock.now, tickMs: 15 } });
    dir = await mkdtemp(join(tmpdir(), 'cooprompt-automation-runs-'));
    leo = await register(h.base, 'leo@acme.com', 'Leo');
    chat = (await api<ChatSummary>(h.base, '/api/chats', { token: leo.token, body: { title: 'Mantenimiento', kind: 'private' } })).body;
    settings = new Settings(join(dir, 'settings.json'), { syncRoot: join(dir, 'Compartidos'), privateRoot: join(dir, 'Privados') });
    settings.update((data) => {
      data.serverUrl = h.base;
      data.user = leo.user;
      data.profiles = [
        { id: 'codex-1', label: 'Codex', engine: 'codex', kind: 'codex-login', createdAt: 1 },
        { id: 'claude-1', label: 'Claude', engine: 'claude', kind: 'anthropic', createdAt: 1 },
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
      attachments: new AttachmentStore({ api: new ApiClient(() => h.base, () => leo.token), cacheDir: join(dir, 'attachments'), stagingDir: join(dir, 'attachments-staged'), log: () => {} }),
      appVersion: 'test',
      executables: { claude: () => join(bin, 'claude'), codex: () => ({ bin: join(bin, 'codex'), pathDirs: [] }), cursor: () => join(bin, 'cursor-agent') },
      shellEnv: () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, CODEX_HOME: join(dir, 'codex-home'), FAKE_ENGINE_DIR: dir }),
      user: () => settings.data.user,
      redact: (text) => text,
      engineInfo: () => {},
      notify: (title) => notified.push(title),
    });
    realtime.on('message', (message) => {
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
    const ready = new Promise<{ automations: unknown }>((resolve) => realtime.once('ready', resolve));
    realtime.connect({ serverUrl: h.base, token: leo.token, deviceId: settings.data.deviceId, deviceName: 'Leo Mac', appVersion: 'test' });
    return ready;
  }

  const send = async (text: string) => {
    const response = await api<SendMessageResponse>(h.base, `/api/chats/${chat.id}/messages`, {
      token: leo.token,
      body: { text, deviceId: settings.data.deviceId, config: { engine: 'codex', profileId: 'codex-1', model: null, permissionMode: 'default' } },
    });
    return response.body.turn;
  };
  const automate = async (body: Record<string, unknown>) => {
    const response = await api<AutomationInfo>(h.base, '/api/automations', {
      token: leo.token,
      body: { chatId: chat.id, deviceId: settings.data.deviceId, timeZone: BUENOS_AIRES, schedule: { kind: 'daily', time: '09:00' }, ...body },
    });
    expect(response.status).toBe(200);
    return response.body;
  };
  const turns = async () => (await api<TurnInfo[]>(h.base, `/api/chats/${chat.id}/turns`, { token: leo.token })).body;
  const ended = (turnId: string) => until(async () => ['done', 'failed', 'cancelled'].includes((await turns()).find((turn) => turn.id === turnId)?.status ?? ''));
  const runOf = async (request: string) => {
    await until(async () => (await engineLog(dir)).some((run) => run.request === request && !run.asked));
    return (await engineLog(dir)).find((run) => run.request === request && !run.asked)!;
  };
  const history = async (automationId: string) => (await api<AutomationRun[]>(h.base, `/api/automations/runs?automationId=${automationId}`, { token: leo.token })).body;
  const items = async () => (await api<TranscriptItem[]>(h.base, `/api/chats/${chat.id}/items`, { token: leo.token })).body;

  it('runs on schedule in the chat’s agent session, told it runs unattended, and records the result', async () => {
    expect((await setUp()).automations).toMatchObject({ minIntervalMinutes: 15 });
    const opening = await send('leé el README');
    const first = await runOf('leé el README');
    await ended(opening.id);

    const automation = await automate({ name: 'Issues', instructions: 'revisá los issues nuevos', config: { engine: 'codex', profileId: 'codex-1', model: null, permissionMode: 'plan' } });
    clock.now = Date.parse('2026-10-26T12:00:01Z');
    const run = await runOf('revisá los issues nuevos');
    expect(run.resumed).toBe(first.session);
    expect(run.prompt).toContain('This turn was started by the automation “Issues”, which Leo set up to run unattended');

    await until(async () => (await history(automation.id))[0]?.status === 'done');
    const [record] = await history(automation.id);
    expect(record).toMatchObject({ trigger: 'schedule', status: 'done', deviceId: settings.data.deviceId });
    const answer = (await items()).find((item) => item.turnId === record.turnId && item.kind === 'text');
    expect(answer?.data).toMatchObject({ text: `Answer from ${first.session} to revisá los issues nuevos` });
  });

  it('starts a fresh agent session when asked and leaves the chat’s own session to catch up on it', async () => {
    await setUp();
    const opening = await send('leé el README');
    const first = await runOf('leé el README');
    await ended(opening.id);

    const automation = await automate({ name: 'Resumen', instructions: 'resumí los commits de ayer', fresh: true, config: { engine: 'codex', profileId: 'codex-1', model: null, permissionMode: 'plan' } });
    await api(h.base, `/api/automations/${automation.id}/run`, { token: leo.token, body: {} });
    const run = await runOf('resumí los commits de ayer');
    expect(run.resumed).toBeNull();
    expect(run.session).not.toBe(first.session);
    expect(run.prompt).not.toContain('leé el README');
    await until(async () => (await history(automation.id))[0]?.status === 'done');

    await send('seguí');
    const next = await runOf('seguí');
    expect(next.resumed).toBe(first.session);
    expect(next.prompt.split(`Answer from ${run.session} to resumí los commits de ayer`)).toHaveLength(2);
  });

  it('declines approvals and questions instead of waiting for someone, and keeps read-only runs read-only', async () => {
    await setUp();
    settings.update((data) => {
      data.alwaysAllow[chat.id] = ['Bash:git push'];
    });
    const config = { engine: 'claude', profileId: 'claude-1', model: null, permissionMode: 'plan' };
    const automation = await automate({ name: 'Release', instructions: 'publicá el release ASK:Bash ASK:AskUserQuestion', config });
    await api(h.base, `/api/automations/${automation.id}/run`, { token: leo.token, body: {} });
    await until(async () => (await history(automation.id))[0]?.status === 'done');

    const answers = (await engineLog(dir)).filter((entry) => entry.asked);
    expect(answers.map((entry) => [entry.asked, entry.answer?.behavior])).toEqual([
      ['Bash', 'deny'],
      ['AskUserQuestion', 'deny'],
    ]);
    expect(answers[0].answer?.message).toContain('Nobody can approve actions during an unattended automation run');
    const [record] = await history(automation.id);
    const cards = (await items()).filter((item) => item.turnId === record.turnId);
    expect((cards.find((item) => item.kind === 'permission')?.data as PermissionItemData).status).toBe('expired');
    expect((cards.find((item) => item.kind === 'question')?.data as QuestionItemData).status).toBe('expired');
    expect(notified).toEqual([]);

    // With edits allowed, what the owner always allowed in the chat is allowed too.
    await api(h.base, `/api/automations/${automation.id}`, { method: 'PATCH', token: leo.token, body: { config: { ...config, permissionMode: 'acceptEdits' }, instructions: 'publicá el release ASK:Bash' } });
    await api(h.base, `/api/automations/${automation.id}/run`, { token: leo.token, body: {} });
    await until(async () => (await engineLog(dir)).filter((entry) => entry.asked === 'Bash').length === 2);
    expect((await engineLog(dir)).filter((entry) => entry.asked === 'Bash')[1].answer?.behavior).toBe('allow');
  });
});

describe('automation messages', () => {
  it('localizes what the server says about runs and schedules', () => {
    expect(translateMessage('es', 'Automation: CI diario')).toBe('Automatización: CI diario');
    expect(translateMessage('es', "The automation's Mac, MacBook de Ana, was not connected")).toBe('La Mac de la automatización, MacBook de Ana, no estaba conectada');
    expect(translateMessage('es', "Stopped after 20 minutes, the automation's time limit")).toBe('Detenida a los 20 minutos, el límite de tiempo de la automatización');
    expect(translateMessage('es', 'Runs must be at least 15 minutes apart')).toBe('Entre una ejecución y la siguiente tiene que haber al menos 15 minutos');
    expect(translateMessage('es', 'Invalid hour in the custom schedule: 25')).toBe('Hora inválida en el horario personalizado: 25');
  });
});
