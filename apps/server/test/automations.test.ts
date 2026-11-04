import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthResponse, AutomationInfo, AutomationRun, ChatSummary, Invitation, SendMessageResponse, ServerMessage, TranscriptItem, TurnInfo } from '@cooprompt/protocol';
import { nextRun, scheduleError, upcomingRuns } from '@cooprompt/protocol';
import { api, register, startServer, TestSocket, type Harness } from './helpers.ts';

const BUENOS_AIRES = 'America/Argentina/Buenos_Aires';
const MINUTE = 60_000;
const at = (iso: string) => Date.parse(iso);

describe('automation schedules', () => {
  const after = at('2026-10-23T15:00:00Z'); // Friday, 12:00 in Buenos Aires

  it('runs daily, on weekdays and on chosen days at a time of day in the owner’s time zone', () => {
    expect(nextRun({ kind: 'daily', time: '09:00' }, BUENOS_AIRES, after)).toBe(at('2026-10-24T12:00:00Z'));
    expect(nextRun({ kind: 'daily', time: '13:30' }, BUENOS_AIRES, after)).toBe(at('2026-10-23T16:30:00Z'));
    expect(upcomingRuns({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, BUENOS_AIRES, after, 2)).toEqual([at('2026-10-26T12:00:00Z'), at('2026-10-27T12:00:00Z')]);
    expect(nextRun({ kind: 'weekly', days: [0, 3], time: '18:00' }, 'Europe/Madrid', after)).toBe(at('2026-10-25T17:00:00Z'));
  });

  it('counts intervals from when they were chosen', () => {
    const anchor = at('2026-10-23T14:17:00Z');
    expect(nextRun({ kind: 'interval', minutes: 120, anchor }, BUENOS_AIRES, after)).toBe(at('2026-10-23T16:17:00Z'));
    expect(nextRun({ kind: 'interval', minutes: 120, anchor }, BUENOS_AIRES, at('2026-10-23T16:17:00Z'))).toBe(at('2026-10-23T18:17:00Z'));
    expect(nextRun({ kind: 'interval', minutes: 30 }, BUENOS_AIRES, after)).toBe(after + 30 * MINUTE);
  });

  it('understands cron expressions: ranges, steps, lists, names, macros and either day field', () => {
    expect(nextRun({ kind: 'cron', expression: '0 9 * * 1-5' }, BUENOS_AIRES, after)).toBe(at('2026-10-26T12:00:00Z'));
    expect(upcomingRuns({ kind: 'cron', expression: '*/20 9-10 * * *' }, BUENOS_AIRES, after, 3)).toEqual([at('2026-10-24T12:00:00Z'), at('2026-10-24T12:20:00Z'), at('2026-10-24T12:40:00Z')]);
    expect(nextRun({ kind: 'cron', expression: '30 8 1 JAN,jul *' }, BUENOS_AIRES, after)).toBe(at('2027-01-01T11:30:00Z'));
    expect(nextRun({ kind: 'cron', expression: '@daily' }, BUENOS_AIRES, after)).toBe(at('2026-10-24T03:00:00Z'));
    expect(nextRun({ kind: 'cron', expression: '0 12 * * SUN' }, BUENOS_AIRES, after)).toBe(at('2026-10-25T15:00:00Z'));
    // Day of the month and day of the week both set: either one matches, as in cron.
    expect(nextRun({ kind: 'cron', expression: '0 0 13 * 5' }, 'UTC', at('2026-10-24T00:00:00Z'))).toBe(at('2026-10-30T00:00:00Z'));
    expect(nextRun({ kind: 'cron', expression: '0 0 29 2 *' }, 'UTC', after)).toBe(at('2028-02-29T00:00:00Z'));
  });

  it('keeps the wall-clock time across daylight saving changes', () => {
    // Madrid moves its clocks forward on 2027-03-28 at 02:00 and back on 2026-10-25 at 03:00.
    expect(upcomingRuns({ kind: 'daily', time: '09:00' }, 'Europe/Madrid', at('2027-03-27T00:00:00Z'), 2)).toEqual([at('2027-03-27T08:00:00Z'), at('2027-03-28T07:00:00Z')]);
    expect(nextRun({ kind: 'daily', time: '02:30' }, 'Europe/Madrid', at('2027-03-28T00:00:00Z'))).toBe(at('2027-03-28T01:30:00Z'));
    expect(nextRun({ kind: 'daily', time: '02:30' }, 'Europe/Madrid', at('2026-10-25T00:00:00Z'))).toBe(at('2026-10-25T00:30:00Z'));
  });

  it('refuses schedules that run more often than allowed, never run or are malformed', () => {
    expect(scheduleError({ kind: 'interval', minutes: 10 }, BUENOS_AIRES, 15, after)).toBe('Runs must be at least 15 minutes apart');
    expect(scheduleError({ kind: 'cron', expression: '*/5 * * * *' }, BUENOS_AIRES, 15, after)).toBe('Runs must be at least 15 minutes apart');
    expect(scheduleError({ kind: 'cron', expression: '0,10 9 * * *' }, BUENOS_AIRES, 15, after)).toBe('Runs must be at least 15 minutes apart');
    expect(scheduleError({ kind: 'cron', expression: '0 0 31 2 *' }, BUENOS_AIRES, 15, after)).toBe('This schedule never runs');
    expect(scheduleError({ kind: 'cron', expression: '0 9 * *' }, BUENOS_AIRES, 15, after)).toMatch(/needs five fields/);
    expect(scheduleError({ kind: 'cron', expression: '0 25 * * *' }, BUENOS_AIRES, 15, after)).toBe('Invalid hour in the custom schedule: 25');
    expect(scheduleError({ kind: 'daily', time: '9:00' }, BUENOS_AIRES, 15, after)).toBe('Choose a time of day as HH:MM');
    expect(scheduleError({ kind: 'weekly', days: [], time: '09:00' }, BUENOS_AIRES, 15, after)).toBe('Choose the days of the week it runs');
    expect(scheduleError({ kind: 'cron', expression: '*/20 * * * *' }, BUENOS_AIRES, 15, after)).toBeNull();
    expect(scheduleError({ kind: 'interval', minutes: 1 }, BUENOS_AIRES, 1, after)).toBeNull();
  });
});

describe('automations on the team server', () => {
  let h: Harness;
  const clock = { now: at('2026-10-26T11:00:00Z') }; // Monday, 08:00 in Buenos Aires
  const sockets: TestSocket[] = [];
  const ownedDirs: string[] = [];
  const config = { engine: 'claude', profileId: 'p1', model: null, permissionMode: 'plan' };

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    try {
      await h?.close();
    } finally {
      for (const dir of ownedDirs.splice(0)) await rm(dir, { recursive: true, force: true });
    }
  });

  async function setUp(options: { dataDir?: string } = {}) {
    clock.now = at('2026-10-26T11:00:00Z');
    h = await startServer({ automations: { now: () => clock.now, tickMs: 15 }, dataDir: options.dataDir });
    const leo = await register(h.base, 'leo@acme.com', 'Leo');
    const ana = await register(h.base, 'ana@acme.com', 'Ana');
    const chat = (await api<ChatSummary>(h.base, '/api/chats', { token: leo.token, body: { title: 'Release', kind: 'multiplayer' } })).body;
    const invitation = (await api<Invitation>(h.base, `/api/chats/${chat.id}/invitations`, { token: leo.token, body: { userId: ana.user.id } })).body;
    await api(h.base, `/api/invitations/${invitation.id}/accept`, { token: ana.token, body: {} });
    return { leo, ana, chat };
  }

  /** Without `features` the socket simulates a client without automation support. */
  async function connect(user: AuthResponse, deviceId: string, features?: ('parallel-turns' | 'automations')[]) {
    const socket = await TestSocket.connect(h.base, user.token, deviceId, `${user.user.name}'s Mac`, features);
    sockets.push(socket);
    return socket;
  }
  const current = (user: AuthResponse, deviceId: string) => connect(user, deviceId, ['parallel-turns', 'automations']);

  const create = (user: AuthResponse, body: Record<string, unknown>) =>
    api<AutomationInfo>(h.base, '/api/automations', { token: user.token, body: { instructions: 'Revisá el CI y contame si algo falló', timeZone: BUENOS_AIRES, config, ...body } });
  const runs = async (user: AuthResponse, automationId?: string) =>
    (await api<AutomationRun[]>(h.base, `/api/automations/runs${automationId ? `?automationId=${automationId}` : ''}`, { token: user.token })).body;
  const ran = (socket: TestSocket) => socket.waitFor<'turn.run'>((m) => m.t === 'turn.run');
  const runsOn = (socket: TestSocket) => socket.messages.filter((m): m is Extract<ServerMessage, { t: 'turn.run' }> => m.t === 'turn.run');
  const quiet = () => new Promise((resolve) => setTimeout(resolve, 200));
  const until = async (check: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('condition not reached in time');
  };

  it('posts each scheduled run as a turn of its owner on the owner’s chosen Mac, labeled, and keeps its history', async () => {
    const { leo, ana, chat } = await setUp();
    const mac = await current(leo, 'leo-mac-0001');
    const laptop = await current(leo, 'leo-mac-0002');
    const anaApp = await connect(ana, 'ana-mac-0001');
    anaApp.send({ t: 'subscribe', chatId: chat.id });
    expect(mac.messages.find((m) => m.t === 'ready')).toMatchObject({ automations: { minIntervalMinutes: 15, maxRunMinutes: 240 } });

    const created = await create(leo, { name: 'CI diario', chatId: chat.id, deviceId: 'leo-mac-0001', schedule: { kind: 'daily', time: '09:00' }, providerLabel: 'Claude · haiku' });
    expect(created.status).toBe(200);
    const automation = created.body;
    expect(automation).toMatchObject({ owner: { id: leo.user.id }, deviceName: "Leo's Mac", enabled: true, fresh: false, timeLimitMinutes: 20, nextRunAt: at('2026-10-26T12:00:00Z'), lastRun: null });
    await anaApp.waitFor((m) => m.t === 'automation.upsert' && m.automation.id === automation.id);

    clock.now = at('2026-10-26T12:00:01Z');
    const run = await ran(mac);
    expect(run.turn).toMatchObject({ requesterId: leo.user.id, deviceId: 'leo-mac-0001', parallel: true, config, automation: { id: automation.id, name: 'CI diario', fresh: false } });
    expect(run.prompt.data.text).toBe('Revisá el CI y contame si algo falló');
    expect(run.prompt.authorId).toBe(leo.user.id);
    await quiet();
    expect(runsOn(laptop)).toEqual([]);
    expect(runsOn(anaApp)).toEqual([]);
    const shown = anaApp.messages.filter((m): m is Extract<ServerMessage, { t: 'items' }> => m.t === 'items').flatMap((m) => m.items);
    expect(shown.find((item) => item.id === `${run.turn.id}.automation`)).toMatchObject({ kind: 'notice', turnId: run.turn.id, data: { text: 'Automation: CI diario' } });

    mac.send({ t: 'turn.items', turnId: run.turn.id, items: [{ id: `${run.turn.id}.answer`, kind: 'text', data: { text: 'Todo verde.' } }] });
    clock.now = at('2026-10-26T12:01:30Z');
    mac.send({ t: 'turn.finish', turnId: run.turn.id, status: 'done' });
    await mac.waitFor((m) => m.t === 'automation.run' && m.run.status === 'done');
    const [record] = await runs(leo, automation.id);
    expect(record).toMatchObject({ trigger: 'schedule', status: 'done', turnId: run.turn.id, chatId: chat.id, scheduledFor: at('2026-10-26T12:00:00Z'), startedAt: at('2026-10-26T12:00:01Z'), finishedAt: at('2026-10-26T12:01:30Z'), read: false });
    expect((await runs(ana, automation.id))[0].read).toBe(true);
    expect(await runs(ana)).toEqual([]);

    await api(h.base, '/api/automations/runs/read', { token: leo.token, body: { ids: [record.id] } });
    expect((await runs(leo))[0].read).toBe(true);
    const listed = (await api<AutomationInfo[]>(h.base, '/api/automations', { token: leo.token })).body;
    expect(listed[0]).toMatchObject({ nextRunAt: at('2026-10-27T12:00:00Z'), lastRun: { id: record.id, status: 'done' } });
  });

  it('lets members see a chat’s automations, and only the owner change, run or delete them', async () => {
    const { leo, ana, chat } = await setUp();
    const bob = await register(h.base, 'bob@acme.com', 'Bob');
    await current(leo, 'leo-mac-0001');
    const automation = (await create(leo, { name: 'Resumen', chatId: chat.id, deviceId: 'leo-mac-0001', schedule: { kind: 'interval', minutes: 60 } })).body;

    expect((await api<AutomationInfo[]>(h.base, '/api/automations', { token: ana.token })).body.map((entry) => entry.id)).toEqual([automation.id]);
    expect((await api<AutomationInfo[]>(h.base, '/api/automations', { token: bob.token })).body).toEqual([]);
    expect((await api(h.base, `/api/automations/${automation.id}`, { method: 'PATCH', token: ana.token, body: { enabled: false } })).status).toBe(403);
    expect((await api(h.base, `/api/automations/${automation.id}/run`, { token: ana.token, body: {} })).status).toBe(403);
    expect((await api(h.base, `/api/automations/${automation.id}`, { method: 'DELETE', token: ana.token })).status).toBe(403);
    expect((await api(h.base, `/api/automations/${automation.id}/run`, { token: bob.token, body: {} })).status).toBe(404);
    expect((await api(h.base, `/api/automations/runs?automationId=${automation.id}`, { token: bob.token })).status).toBe(404);

    const paused = await api<AutomationInfo>(h.base, `/api/automations/${automation.id}`, { method: 'PATCH', token: leo.token, body: { enabled: false, name: 'Resumen semanal' } });
    expect(paused.body).toMatchObject({ enabled: false, nextRunAt: null, name: 'Resumen semanal', schedule: { kind: 'interval', minutes: 60 } });
    expect((await api(h.base, `/api/automations/${automation.id}`, { method: 'DELETE', token: leo.token })).status).toBe(200);
    expect((await api<AutomationInfo[]>(h.base, '/api/automations', { token: ana.token })).body).toEqual([]);
  });

  it('validates what an automation may do and where it may post', async () => {
    const { leo, ana, chat } = await setUp();
    const bob = await register(h.base, 'bob@acme.com', 'Bob');
    await current(leo, 'leo-mac-0001');
    await current(bob, 'bob-mac-0001');
    const base = { name: 'Algo', chatId: chat.id, deviceId: 'leo-mac-0001', schedule: { kind: 'daily', time: '09:00' } };
    expect((await create(leo, { ...base, schedule: { kind: 'interval', minutes: 5 } })).body).toMatchObject({ error: 'Runs must be at least 15 minutes apart' });
    expect((await create(leo, { ...base, config: { ...config, permissionMode: 'default' } })).body).toMatchObject({ error: 'Automations run unattended: choose read-only, edit files or no restrictions' });
    expect((await create(leo, { ...base, timeZone: 'Mars/Olympus' })).status).toBe(400);
    expect((await create(leo, { ...base, deviceId: 'leo-mac-9999' })).status).toBe(409);
    expect((await create(bob, { ...base, deviceId: 'bob-mac-0001' })).status).toBe(403);
    expect((await create(ana, { ...base, deviceId: 'leo-mac-0001' })).status).toBe(409);
    expect((await create(leo, { ...base, timeLimitMinutes: 500 })).status).toBe(400);
  });

  it('records a run as missed while the Mac is offline and catches up once when it returns, if still worth it', async () => {
    const { leo, chat } = await setUp();
    const first = await current(leo, 'leo-mac-0001');
    const automation = (await create(leo, { name: 'Cada hora', chatId: chat.id, deviceId: 'leo-mac-0001', schedule: { kind: 'interval', minutes: 60 } })).body;
    const start = clock.now;
    first.close();
    await until(async () => (await api<{ deviceId: string }[]>(h.base, '/api/devices', { token: leo.token })).body.length === 0);

    clock.now = start + 60 * MINUTE;
    await until(async () => (await runs(leo, automation.id)).length === 1);
    clock.now = start + 120 * MINUTE;
    await until(async () => (await runs(leo, automation.id)).length === 2);
    expect(await runs(leo, automation.id)).toMatchObject([
      { status: 'missed', trigger: 'schedule', scheduledFor: start + 120 * MINUTE, error: "The automation's computer, Leo's Mac, was not connected", turnId: null },
      { status: 'missed', scheduledFor: start + 60 * MINUTE },
    ]);

    // Back 5 minutes after the last missed time: less than half the way to the next one.
    clock.now = start + 125 * MINUTE;
    const back = await current(leo, 'leo-mac-0001');
    const caughtUp = await ran(back);
    await quiet();
    expect(runsOn(back)).toHaveLength(1);
    expect(await runs(leo, automation.id)).toMatchObject([
      { status: 'running', trigger: 'catch-up', scheduledFor: start + 120 * MINUTE, turnId: caughtUp.turn.id, error: null },
      { status: 'missed', scheduledFor: start + 60 * MINUTE },
    ]);
    back.send({ t: 'turn.finish', turnId: caughtUp.turn.id, status: 'done' });
    await back.waitFor((m) => m.t === 'automation.run' && m.run.status === 'done');
    back.close();
    await until(async () => (await api<{ deviceId: string }[]>(h.base, '/api/devices', { token: leo.token })).body.length === 0);

    // Back 35 minutes after a missed time: the next run is closer, so it just waits for it.
    clock.now = start + 180 * MINUTE;
    await until(async () => (await runs(leo, automation.id)).length === 3);
    clock.now = start + 215 * MINUTE;
    const late = await current(leo, 'leo-mac-0001');
    await quiet();
    expect(runsOn(late)).toEqual([]);
    expect((await runs(leo, automation.id))[0]).toMatchObject({ status: 'missed', scheduledFor: start + 180 * MINUTE });
  });

  it('never runs an automation twice at once and stops a run at its time limit', async () => {
    const { leo, chat } = await setUp();
    const mac = await current(leo, 'leo-mac-0001');
    const automation = (await create(leo, { name: 'Tests', chatId: chat.id, deviceId: 'leo-mac-0001', schedule: { kind: 'interval', minutes: 15 }, timeLimitMinutes: 20 })).body;
    const start = clock.now;

    clock.now = start + 15 * MINUTE;
    const run = await ran(mac);
    clock.now = start + 30 * MINUTE;
    await until(async () => (await runs(leo, automation.id)).length === 2);
    expect((await runs(leo, automation.id))[0]).toMatchObject({ status: 'skipped', scheduledFor: start + 30 * MINUTE, error: 'The previous run had not finished' });
    expect(runsOn(mac)).toHaveLength(1);

    clock.now = start + 36 * MINUTE;
    await mac.waitFor((m) => m.t === 'turn.cancel' && m.turnId === run.turn.id);
    mac.send({ t: 'turn.finish', turnId: run.turn.id, status: 'cancelled', error: 'Cancelled' });
    await mac.waitFor((m) => m.t === 'automation.run' && m.run.turnId === run.turn.id && m.run.status === 'cancelled');
    const turns = (await api<TurnInfo[]>(h.base, `/api/chats/${chat.id}/turns`, { token: leo.token })).body;
    expect(turns.find((turn) => turn.id === run.turn.id)).toMatchObject({ status: 'cancelled', error: "Stopped after 20 minutes, the automation's time limit" });
    expect((await runs(leo, automation.id))[1]).toMatchObject({ status: 'cancelled', error: "Stopped after 20 minutes, the automation's time limit" });
  });

  it('runs now only on the owner’s connected Mac with automations, and never twice at once', async () => {
    const { leo, chat } = await setUp();
    const mac = await current(leo, 'leo-mac-0001');
    const automation = (await create(leo, { name: 'A mano', chatId: chat.id, deviceId: 'leo-mac-0001', schedule: { kind: 'daily', time: '09:00' }, enabled: false, fresh: true })).body;
    mac.close();
    await until(async () => (await api<{ deviceId: string }[]>(h.base, '/api/devices', { token: leo.token })).body.length === 0);
    expect((await api(h.base, `/api/automations/${automation.id}/run`, { token: leo.token, body: {} })).body).toMatchObject({ error: "The automation's computer, Leo's Mac, is not connected" });

    const old = await connect(leo, 'leo-mac-0001', ['parallel-turns']);
    expect((await api(h.base, `/api/automations/${automation.id}/run`, { token: leo.token, body: {} })).body).toMatchObject({ error: "The automation's computer, Leo's Mac, has a CooPrompt that can't run automations: update it" });
    old.close();

    const updated = await current(leo, 'leo-mac-0001');
    const started = await api<AutomationRun>(h.base, `/api/automations/${automation.id}/run`, { token: leo.token, body: {} });
    expect(started.body).toMatchObject({ trigger: 'manual', scheduledFor: null });
    const run = await ran(updated);
    expect(run.turn.automation).toMatchObject({ id: automation.id, runId: started.body.id, fresh: true });
    expect((await api(h.base, `/api/automations/${automation.id}/run`, { token: leo.token, body: {} })).body).toMatchObject({ error: 'This automation is already running' });

    // Deleting it stops the run in progress.
    await api(h.base, `/api/automations/${automation.id}`, { method: 'DELETE', token: leo.token });
    await updated.waitFor((m) => m.t === 'turn.cancel' && m.turnId === run.turn.id);
  });

  it('pauses an automation whose owner left its chat', async () => {
    const { leo, ana, chat } = await setUp();
    await current(ana, 'ana-mac-0001');
    const automation = (await create(ana, { name: 'De Ana', chatId: chat.id, deviceId: 'ana-mac-0001', schedule: { kind: 'daily', time: '09:00' } })).body;
    await api(h.base, `/api/chats/${chat.id}/leave`, { token: ana.token, body: {} });

    clock.now = at('2026-10-26T12:00:01Z');
    await until(async () => (await runs(ana, automation.id)).length === 1);
    expect((await runs(ana, automation.id))[0]).toMatchObject({ status: 'skipped', error: 'Its owner is no longer in its chat' });
    const [mine] = (await api<AutomationInfo[]>(h.base, '/api/automations', { token: ana.token })).body;
    expect(mine).toMatchObject({ enabled: false, pausedReason: 'Its owner is no longer in its chat', nextRunAt: null });
    expect((await api<AutomationInfo[]>(h.base, '/api/automations', { token: leo.token })).body).toMatchObject([{ id: automation.id, enabled: false }]);
  });

  it('keeps clients without automation support working: their device never runs automation turns', async () => {
    const { leo, ana, chat } = await setUp();
    const oldMac = await connect(leo, 'leo-mac-0001');
    const anaApp = await connect(ana, 'ana-mac-0001');
    anaApp.send({ t: 'subscribe', chatId: chat.id });
    expect((await create(leo, { name: 'Vieja', chatId: chat.id, deviceId: 'leo-mac-0001', schedule: { kind: 'daily', time: '09:00' } })).status).toBe(200);
    clock.now = at('2026-10-26T12:00:01Z');
    await until(async () => (await runs(leo)).length === 1);
    expect((await runs(leo))[0]).toMatchObject({ status: 'missed', error: "The automation's computer, Leo's Mac, has a CooPrompt that can't run automations: update it" });
    expect(runsOn(oldMac)).toEqual([]);

    // A capable device runs it; the other client sees an ordinary turn and keeps queueing its own messages.
    const newMac = await current(leo, 'leo-mac-0002');
    const automation = (await create(leo, { name: 'Nueva', chatId: chat.id, deviceId: 'leo-mac-0002', schedule: { kind: 'daily', time: '10:00' } })).body;
    await api(h.base, `/api/automations/${automation.id}/run`, { token: leo.token, body: {} });
    const run = await ran(newMac);
    const turn = await anaApp.waitFor<'turn.upsert'>((m) => m.t === 'turn.upsert' && m.turn.id === run.turn.id && m.turn.status === 'running');
    expect(turn.turn).toMatchObject({ requesterId: leo.user.id, deviceName: "Leo's Mac", status: 'running' });
    const items = anaApp.messages.filter((m): m is Extract<ServerMessage, { t: 'items' }> => m.t === 'items').flatMap((m) => m.items).filter((item) => item.turnId === run.turn.id);
    expect(items.map((item: TranscriptItem) => [item.kind, item.authorId])).toEqual([
      ['user', leo.user.id],
      ['notice', null],
    ]);
    const message = await api<SendMessageResponse>(h.base, `/api/chats/${chat.id}/messages`, { token: ana.token, body: { text: '¿qué pasó?', deviceId: 'ana-mac-0001', config: { ...config, permissionMode: 'default' } } });
    expect(message.body.turn.status).toBe('queued');
    newMac.send({ t: 'turn.finish', turnId: run.turn.id, status: 'done' });
    await ran(anaApp);
  });

  it('marks scheduled times the server slept through as missed and catches up the latest when the Mac connects', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cooprompt-automations-restart-'));
    ownedDirs.push(dataDir);
    const { leo, chat } = await setUp({ dataDir });
    await current(leo, 'leo-mac-0001');
    const automation = (await create(leo, { name: 'Diaria', chatId: chat.id, deviceId: 'leo-mac-0001', schedule: { kind: 'daily', time: '09:00' } })).body;
    for (const socket of sockets.splice(0)) socket.close();
    await h.close();

    clock.now = at('2026-10-26T13:00:00Z');
    h = await startServer({ automations: { now: () => clock.now, tickMs: 15 }, dataDir });
    expect((await runs(leo, automation.id))[0]).toMatchObject({ status: 'missed', scheduledFor: at('2026-10-26T12:00:00Z') });
    const mac = await current(leo, 'leo-mac-0001');
    const run = await ran(mac);
    expect(run.turn.chatId).toBe(chat.id);
    expect((await runs(leo, automation.id))[0]).toMatchObject({ trigger: 'catch-up', status: 'running', scheduledFor: at('2026-10-26T12:00:00Z') });
    expect((await api<AutomationInfo[]>(h.base, '/api/automations', { token: leo.token })).body[0].nextRunAt).toBe(at('2026-10-27T12:00:00Z'));
  });
});
