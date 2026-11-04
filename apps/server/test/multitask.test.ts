import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatSummary, Invitation, SendMessageResponse, TurnConfig, TurnInfo } from '@cooprompt/protocol';
import { api, register, startServer, TestSocket, type Harness } from './helpers.ts';

const config: TurnConfig = { engine: 'claude', profileId: 'p1', model: null, permissionMode: 'default' };

describe('multitask turns', () => {
  let h: Harness;
  const sockets: TestSocket[] = [];

  beforeEach(async () => {
    h = await startServer();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await h.close();
  });

  /** Apps with multitask announce it; the socket can also simulate a client without it. */
  async function connect(token: string, deviceId: string, parallel = true) {
    const socket = await TestSocket.connect(h.base, token, deviceId, 'Test Mac', parallel ? ['parallel-turns'] : undefined);
    sockets.push(socket);
    return socket;
  }

  async function sharedChat(harness = h) {
    const leo = await register(harness.base, 'leo@acme.com', 'Leo');
    const ana = await register(harness.base, 'ana@acme.com', 'Ana');
    const chat = (await api<ChatSummary>(harness.base, '/api/chats', { token: leo.token, body: { title: 'Pairing', kind: 'multiplayer' } })).body;
    const invitation = (await api<Invitation>(harness.base, `/api/chats/${chat.id}/invitations`, { token: leo.token, body: { userId: ana.user.id } })).body;
    await api(harness.base, `/api/invitations/${invitation.id}/accept`, { token: ana.token, body: {} });
    const send = (token: string, body: Record<string, unknown>) => api<SendMessageResponse>(harness.base, `/api/chats/${chat.id}/messages`, { token, body: { config, ...body } });
    const turns = async () => (await api<TurnInfo[]>(harness.base, `/api/chats/${chat.id}/turns`, { token: leo.token })).body;
    return { leo, ana, chat, send, turns };
  }

  const ran = (socket: TestSocket, turnId: string) => socket.waitFor<'turn.run'>((m) => m.t === 'turn.run' && m.turn.id === turnId);
  const started = (socket: TestSocket) => socket.messages.filter((m) => m.t === 'turn.run').map((m) => (m as { turn: TurnInfo }).turn.id);

  it('starts multitask messages right away, up to the limit, and queues the rest', async () => {
    const { leo, chat, send, turns } = await sharedChat();
    const leoSocket = await connect(leo.token, 'leo-device-1');
    expect(leoSocket.messages.find((m) => m.t === 'ready')).toMatchObject({ maxParallelTurns: 3 });
    leoSocket.send({ t: 'subscribe', chatId: chat.id });

    const sent: TurnInfo[] = [];
    for (const text of ['migrá la base', 'revisá el CI', 'escribí los tests', '¿qué hora es?']) {
      sent.push((await send(leo.token, { text, deviceId: 'leo-device-1', parallel: true })).body.turn);
    }
    for (const turn of sent.slice(0, 3)) await ran(leoSocket, turn.id);
    expect(started(leoSocket)).toEqual(sent.slice(0, 3).map((turn) => turn.id));
    const fourth = (await turns()).find((turn) => turn.id === sent[3].id)!;
    expect(fourth).toMatchObject({ status: 'queued', parallel: true });

    const summary = (await api<ChatSummary>(h.base, `/api/chats/${chat.id}`, { token: leo.token })).body;
    expect(summary.activeTurn?.id).toBe(sent[0].id);
    expect(summary.activeTurns?.map((turn) => turn.id)).toEqual(sent.slice(0, 3).map((turn) => turn.id));
    expect(summary.queuedTurns).toBe(1);

    leoSocket.send({ t: 'turn.finish', turnId: sent[1].id, status: 'done' });
    await ran(leoSocket, sent[3].id);
    expect((await turns()).filter((turn) => turn.status === 'running').map((turn) => turn.id)).toEqual([sent[0].id, sent[2].id, sent[3].id]);
  });

  it('runs a message sent without multitask once nothing runs, and lets no multitask message skip it', async () => {
    const { leo, ana, send, turns } = await sharedChat();
    const leoSocket = await connect(leo.token, 'leo-device-1');
    const anaSocket = await connect(ana.token, 'ana-device-1', false);

    const first = (await send(leo.token, { text: 'refactorizá el login', deviceId: 'leo-device-1', parallel: true })).body.turn;
    await ran(leoSocket, first.id);
    const question = (await send(ana.token, { text: '¿qué cambió en la API?', deviceId: 'ana-device-1' })).body.turn;
    expect(question).toMatchObject({ status: 'queued', parallel: false });
    const later = (await send(leo.token, { text: 'y actualizá el README', deviceId: 'leo-device-1', parallel: true })).body.turn;
    expect(later.status).toBe('queued');
    expect(started(leoSocket)).toEqual([first.id]);

    leoSocket.send({ t: 'turn.finish', turnId: first.id, status: 'done' });
    await ran(anaSocket, question.id);
    await ran(leoSocket, later.id);
    const byId = new Map((await turns()).map((turn) => [turn.id, turn]));
    expect(byId.get(question.id)!.startedAt!).toBeLessThanOrEqual(byId.get(later.id)!.startedAt!);
    expect([...byId.values()].filter((turn) => turn.status === 'running').map((turn) => turn.id)).toEqual([question.id, later.id]);
  });

  it('lets the multitask messages behind a cancelled message start', async () => {
    const { leo, ana, send, turns } = await sharedChat();
    const leoSocket = await connect(leo.token, 'leo-device-1');
    await connect(ana.token, 'ana-device-1', false);
    const first = (await send(leo.token, { text: 'deployá', deviceId: 'leo-device-1', parallel: true })).body.turn;
    await ran(leoSocket, first.id);
    const waiting = (await send(ana.token, { text: 'corré los tests', deviceId: 'ana-device-1' })).body.turn;
    const behind = (await send(leo.token, { text: '¿y el changelog?', deviceId: 'leo-device-1', parallel: true })).body.turn;
    expect((await turns()).find((turn) => turn.id === behind.id)?.status).toBe('queued');

    await api(h.base, `/api/turns/${waiting.id}/cancel`, { token: ana.token, body: {} });
    await ran(leoSocket, behind.id);
  });

  it('interrupts the turn it names and starts the new message once that turn stops, leaving the others running', async () => {
    const { leo, ana, send, turns } = await sharedChat();
    const leoSocket = await connect(leo.token, 'leo-device-1');
    await connect(ana.token, 'ana-device-1');
    const a = (await send(leo.token, { text: 'reescribí el parser', deviceId: 'leo-device-1', parallel: true })).body.turn;
    const b = (await send(leo.token, { text: 'documentá la API', deviceId: 'leo-device-1', parallel: true })).body.turn;
    await ran(leoSocket, b.id);

    const denied = await send(ana.token, { text: 'pará', deviceId: 'ana-device-1', parallel: true, interrupt: true, interruptTurnId: a.id });
    expect(denied.status).toBe(403);

    const forced = (await send(leo.token, { text: 'mejor sólo el tokenizer', deviceId: 'leo-device-1', parallel: true, interrupt: true, interruptTurnId: a.id })).body;
    expect(forced.interrupted).toBe(a.id);
    expect(forced.turn).toMatchObject({ status: 'queued', interrupts: a.id, parallel: true });
    await leoSocket.waitFor((m) => m.t === 'turn.cancel' && m.turnId === a.id);
    expect(leoSocket.messages.some((m) => m.t === 'turn.cancel' && m.turnId === b.id)).toBe(false);
    expect(started(leoSocket)).not.toContain(forced.turn.id);

    leoSocket.send({ t: 'turn.finish', turnId: a.id, status: 'cancelled', error: 'Cancelled' });
    await ran(leoSocket, forced.turn.id);
    const byId = new Map((await turns()).map((turn) => [turn.id, turn]));
    expect(byId.get(a.id)).toMatchObject({ status: 'cancelled', error: 'Interrupted by Leo' });
    expect(byId.get(b.id)?.status).toBe('running');
  });

  it("keeps clients without multitask working: messages stay one at a time, interrupts stop the sender's latest turn and the device never runs two turns", async () => {
    const { leo, chat, send, turns } = await sharedChat();
    const current = await connect(leo.token, 'leo-device-new');
    const old = await connect(leo.token, 'leo-device-old', false);

    const a = (await send(leo.token, { text: 'tarea larga', deviceId: 'leo-device-new', parallel: true })).body.turn;
    const b = (await send(leo.token, { text: 'otra tarea', deviceId: 'leo-device-new', parallel: true })).body.turn;
    await ran(current, b.id);
    current.send({ t: 'turn.delta', turnId: a.id, kind: 'text', text: 'Leyendo el parser' });
    current.send({ t: 'turn.delta', turnId: b.id, kind: 'thinking', text: 'Qué documentar' });

    const onOld = (await send(leo.token, { text: 'en la otra Mac', deviceId: 'leo-device-old', parallel: true })).body.turn;
    expect(onOld).toMatchObject({ status: 'queued', parallel: false });
    expect(started(old)).toEqual([]);

    const viewer = await connect(leo.token, 'leo-device-viewer', false);
    viewer.send({ t: 'subscribe', chatId: chat.id });
    await viewer.waitFor((m) => m.t === 'turn.draft' && m.turnId === a.id && m.draft?.text === 'Leyendo el parser');
    await viewer.waitFor((m) => m.t === 'turn.draft' && m.turnId === b.id && m.draft?.kind === 'thinking');

    const interrupted = (await send(leo.token, { text: 'pará la última', deviceId: 'leo-device-old', interrupt: true })).body;
    expect(interrupted.interrupted).toBe(b.id);
    await current.waitFor((m) => m.t === 'turn.cancel' && m.turnId === b.id);
    current.send({ t: 'turn.finish', turnId: b.id, status: 'cancelled' });
    current.send({ t: 'turn.finish', turnId: a.id, status: 'done' });
    await ran(old, interrupted.turn.id);
    expect(started(old)).toEqual([interrupted.turn.id]);
    expect((await turns()).find((turn) => turn.id === onOld.id)?.status).toBe('queued');
    old.send({ t: 'turn.finish', turnId: interrupted.turn.id, status: 'done' });
    await ran(old, onOld.id);
  });

  it('ignores the flag when multitask is off, as a server that predates it does', async () => {
    const single = await startServer({ maxParallelTurns: 1 });
    try {
      const { leo, send, turns } = await sharedChat(single);
      const socket = await TestSocket.connect(single.base, leo.token, 'leo-device-1', 'Test Mac', ['parallel-turns']);
      sockets.push(socket);
      expect(socket.messages.find((m) => m.t === 'ready')).not.toHaveProperty('maxParallelTurns');
      const first = (await send(leo.token, { text: 'uno', deviceId: 'leo-device-1', parallel: true })).body.turn;
      await ran(socket, first.id);
      const second = (await send(leo.token, { text: 'dos', deviceId: 'leo-device-1', parallel: true })).body.turn;
      expect((await turns()).find((turn) => turn.id === second.id)).toMatchObject({ status: 'queued', parallel: false });
      socket.send({ t: 'turn.finish', turnId: first.id, status: 'done' });
      await ran(socket, second.id);
    } finally {
      await single.close();
    }
  });
});
