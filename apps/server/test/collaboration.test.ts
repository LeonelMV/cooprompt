import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { ChatSummary, FileEntry, Invitation, SendMessageResponse, TranscriptItem, TurnConfig, TurnInfo } from '@cooprompt/protocol';
import { api, register, startServer, TestSocket, type Harness } from './helpers.ts';

const config: TurnConfig = { engine: 'claude', profileId: 'p1', model: null, permissionMode: 'default' };

describe('collaboration server', () => {
  let h: Harness;
  const sockets: TestSocket[] = [];

  beforeEach(async () => {
    h = await startServer();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await h.close();
  });

  async function connect(token: string, deviceId: string) {
    const socket = await TestSocket.connect(h.base, token, deviceId);
    sockets.push(socket);
    return socket;
  }

  async function sharedChat() {
    const leo = await register(h.base, 'leo@acme.com', 'Leo');
    const ana = await register(h.base, 'ana@acme.com', 'Ana');
    const chat = (await api<ChatSummary>(h.base, '/api/chats', { token: leo.token, body: { title: 'Pairing', kind: 'multiplayer' } })).body;
    const found = (await api<{ id: string }[]>(h.base, '/api/users/search?q=an', { token: leo.token })).body;
    expect(found.map((user) => user.id)).toContain(ana.user.id);
    const invitation = (await api<Invitation>(h.base, `/api/chats/${chat.id}/invitations`, { token: leo.token, body: { userId: ana.user.id } })).body;
    const pending = (await api<Invitation[]>(h.base, '/api/invitations', { token: ana.token })).body;
    expect(pending.map((inv) => inv.id)).toEqual([invitation.id]);
    const accepted = await api(h.base, `/api/invitations/${invitation.id}/accept`, { token: ana.token, body: {} });
    expect(accepted.status).toBe(200);
    return { leo, ana, chat };
  }

  it('runs turns on the requester device, streams to every participant and queues concurrent requests', async () => {
    const { leo, ana, chat } = await sharedChat();
    const leoSocket = await connect(leo.token, 'leo-device-1');
    const anaSocket = await connect(ana.token, 'ana-device-1');
    leoSocket.send({ t: 'subscribe', chatId: chat.id });
    anaSocket.send({ t: 'subscribe', chatId: chat.id });
    await anaSocket.waitFor((m) => m.t === 'presence' && m.online.length === 2);

    const first = (await api<SendMessageResponse>(h.base, `/api/chats/${chat.id}/messages`, { token: ana.token, body: { text: 'cloná el repo', deviceId: 'ana-device-1', config } })).body;
    const run = await anaSocket.waitFor<'turn.run'>((m) => m.t === 'turn.run');
    expect(run.turn.id).toBe(first.turn.id);
    expect(run.prompt.data.text).toBe('cloná el repo');
    expect(leoSocket.messages.some((m) => m.t === 'turn.run')).toBe(false);

    const second = (await api<SendMessageResponse>(h.base, `/api/chats/${chat.id}/messages`, { token: leo.token, body: { text: 'y corré los tests', deviceId: 'leo-device-1', config } })).body;
    expect(second.turn.status).toBe('queued');

    anaSocket.send({ t: 'turn.delta', turnId: first.turn.id, kind: 'text', text: 'Clonando' });
    await leoSocket.waitFor((m) => m.t === 'turn.delta' && m.text === 'Clonando');
    anaSocket.send({ t: 'turn.items', turnId: first.turn.id, items: [{ id: `${first.turn.id}.t1`, kind: 'text', data: { text: 'Listo, clonado.' } }] });
    anaSocket.send({ t: 'turn.items', turnId: first.turn.id, items: [{ id: `${second.turn.id}.hijack`, kind: 'text', data: { text: 'no' } }] });
    const items = await leoSocket.waitFor<'items'>((m) => m.t === 'items' && m.items.some((item) => item.id === `${first.turn.id}.t1`));
    expect(items.items[0].authorId).toBe(ana.user.id);

    anaSocket.send({ t: 'turn.finish', turnId: first.turn.id, status: 'done', usage: { costUsd: 0.01 } });
    const secondRun = await leoSocket.waitFor<'turn.run'>((m) => m.t === 'turn.run');
    expect(secondRun.turn.id).toBe(second.turn.id);

    const transcript = (await api<TranscriptItem[]>(h.base, `/api/chats/${chat.id}/items`, { token: leo.token })).body;
    expect(transcript.map((item) => item.id)).not.toContain(`${second.turn.id}.hijack`);
    expect(transcript.filter((item) => item.kind === 'user').map((item) => (item.data as { text: string }).text)).toEqual(['cloná el repo', 'y corré los tests']);
  });

  it('forwards permission decisions to the executor only when it allows others to decide', async () => {
    const { leo, ana, chat } = await sharedChat();
    const leoSocket = await connect(leo.token, 'leo-device-1');
    const anaSocket = await connect(ana.token, 'ana-device-1');
    const turn = (await api<SendMessageResponse>(h.base, `/api/chats/${chat.id}/messages`, { token: leo.token, body: { text: 'borrá build/', deviceId: 'leo-device-1', config } })).body.turn;
    await leoSocket.waitFor((m) => m.t === 'turn.run');

    const permission = (othersCanDecide: boolean, id: string) => ({
      id: `${turn.id}.${id}`,
      kind: 'permission' as const,
      data: { toolName: 'Bash', input: { command: 'rm -rf build' }, status: 'pending' as const, othersCanDecide, allowAlways: true },
    });
    leoSocket.send({ t: 'turn.items', turnId: turn.id, items: [permission(false, 'perm1'), permission(true, 'perm2')] });
    await anaSocket.waitFor((m) => m.t === 'chat.upsert');

    anaSocket.send({ t: 'decision', chatId: chat.id, turnId: turn.id, itemId: `${turn.id}.perm1`, decision: { type: 'permission', allow: true } });
    const rejected = await anaSocket.waitFor<'error'>((m) => m.t === 'error');
    expect(rejected.message).toMatch(/Only the person running/);

    anaSocket.send({ t: 'decision', chatId: chat.id, turnId: turn.id, itemId: `${turn.id}.perm2`, decision: { type: 'permission', allow: false } });
    const forwarded = await leoSocket.waitFor<'decision'>((m) => m.t === 'decision');
    expect(forwarded).toMatchObject({ itemId: `${turn.id}.perm2`, byUserId: ana.user.id, decision: { allow: false } });
  });

  it('runs an interrupting message next, only for the requester or the chat owner', async () => {
    const { leo, ana, chat } = await sharedChat();
    const leoSocket = await connect(leo.token, 'leo-device-1');
    await connect(ana.token, 'ana-device-1');
    const send = (token: string, body: Record<string, unknown>) => api<SendMessageResponse>(h.base, `/api/chats/${chat.id}/messages`, { token, body });

    const running = (await send(leo.token, { text: 'refactorizá todo', deviceId: 'leo-device-1', config })).body.turn;
    await leoSocket.waitFor((m) => m.t === 'turn.run' && m.turn.id === running.id);
    const queued = (await send(ana.token, { text: 'después corré los tests', deviceId: 'ana-device-1', config })).body.turn;
    expect(queued.status).toBe('queued');

    const denied = await send(ana.token, { text: 'pará', deviceId: 'ana-device-1', config, interrupt: true });
    expect(denied.status).toBe(403);
    expect(leoSocket.messages.some((m) => m.t === 'turn.cancel')).toBe(false);

    const forced = (await send(leo.token, { text: 'mejor sólo el login', deviceId: 'leo-device-1', config: { ...config, effort: 'high' }, interrupt: true })).body;
    expect(forced.interrupted).toBe(running.id);
    await leoSocket.waitFor((m) => m.t === 'turn.cancel' && m.turnId === running.id);
    leoSocket.send({ t: 'turn.finish', turnId: running.id, status: 'cancelled', error: 'Cancelled' });

    const next = await leoSocket.waitFor<'turn.run'>((m) => m.t === 'turn.run' && m.turn.id !== running.id);
    expect(next.turn.id).toBe(forced.turn.id);
    expect(next.turn.config.effort).toBe('high');
    const turns = (await api<TurnInfo[]>(h.base, `/api/chats/${chat.id}/turns`, { token: ana.token })).body;
    expect(turns.find((turn) => turn.id === running.id)).toMatchObject({ status: 'cancelled', error: 'Interrupted by Leo' });
    expect(turns.find((turn) => turn.id === queued.id)?.status).toBe('queued');
    const transcript = (await api<TranscriptItem[]>(h.base, `/api/chats/${chat.id}/items`, { token: leo.token })).body;
    expect(transcript.filter((item) => item.kind === 'user').map((item) => (item.data as { text: string }).text)).toEqual(['refactorizá todo', 'después corré los tests', 'mejor sólo el login']);
  });

  it('runs Cursor turns like any other and refuses engines it does not know', async () => {
    const { leo, ana, chat } = await sharedChat();
    const leoSocket = await connect(leo.token, 'leo-device-1');
    const anaSocket = await connect(ana.token, 'ana-device-1');
    anaSocket.send({ t: 'subscribe', chatId: chat.id });
    await anaSocket.waitFor((m) => m.t === 'presence' && m.online.length >= 1);
    const send = (engine: string) =>
      api<SendMessageResponse>(h.base, `/api/chats/${chat.id}/messages`, { token: leo.token, body: { text: 'revisá el login', deviceId: 'leo-device-1', config: { ...config, engine, permissionMode: 'plan' }, providerLabel: 'Cursor · sign-in' } });

    const unknown = await send('gemini');
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ error: 'Invalid engine' });

    const sent = (await send('cursor')).body;
    const run = await leoSocket.waitFor<'turn.run'>((m) => m.t === 'turn.run' && m.turn.id === sent.turn.id);
    expect(run.turn.config).toMatchObject({ engine: 'cursor', permissionMode: 'plan' });
    const seen = await anaSocket.waitFor<'turn.upsert'>((m) => m.t === 'turn.upsert' && m.turn.id === sent.turn.id);
    expect(seen.turn).toMatchObject({ config: { engine: 'cursor' }, providerLabel: 'Cursor · sign-in' });
  });

  it('fails turns whose executor device is offline and cancels running turns', async () => {
    const { leo, chat } = await sharedChat();
    const offline = await api(h.base, `/api/chats/${chat.id}/messages`, { token: leo.token, body: { text: 'hola', deviceId: 'leo-device-1', config } });
    expect(offline.status).toBe(409);

    const leoSocket = await connect(leo.token, 'leo-device-1');
    const turn = (await api<SendMessageResponse>(h.base, `/api/chats/${chat.id}/messages`, { token: leo.token, body: { text: 'hola', deviceId: 'leo-device-1', config } })).body.turn;
    await leoSocket.waitFor((m) => m.t === 'turn.run');
    await api(h.base, `/api/turns/${turn.id}/cancel`, { token: leo.token, body: {} });
    await leoSocket.waitFor((m) => m.t === 'turn.cancel' && m.turnId === turn.id);
  });

  it('shows corporate chats to the whole organization and lets members join', async () => {
    const leo = await register(h.base, 'leo@acme.com', 'Leo');
    const ana = await register(h.base, 'ana@acme.com', 'Ana');
    const outsider = await register(h.base, 'zoe@gmail.com', 'Zoe');
    const created = await api<ChatSummary>(h.base, '/api/chats', { token: leo.token, body: { title: 'Incidentes', kind: 'corporate' } });
    expect(created.status).toBe(200);
    const denied = await api(h.base, '/api/chats', { token: outsider.token, body: { title: 'x', kind: 'corporate' } });
    expect(denied.status).toBe(403);

    const anaChats = (await api<ChatSummary[]>(h.base, '/api/chats', { token: ana.token })).body;
    expect(anaChats.map((chat) => [chat.id, chat.isMember])).toEqual([[created.body.id, false]]);
    expect((await api<ChatSummary[]>(h.base, '/api/chats', { token: outsider.token })).body).toEqual([]);
    expect((await api(h.base, `/api/chats/${created.body.id}/items`, { token: ana.token })).status).toBe(200);
    expect((await api(h.base, `/api/chats/${created.body.id}/messages`, { token: ana.token, body: { text: 'x', deviceId: 'ana-device-1', config } })).status).toBe(403);

    const joined = await api<ChatSummary>(h.base, `/api/chats/${created.body.id}/join`, { token: ana.token, body: {} });
    expect(joined.body.isMember).toBe(true);
    expect((await api(h.base, `/api/chats/${created.body.id}/join`, { token: outsider.token, body: {} })).status).toBe(404);
  });

  it('keeps email invitations for people who register later', async () => {
    const leo = await register(h.base, 'leo@acme.com', 'Leo');
    const chat = (await api<ChatSummary>(h.base, '/api/chats', { token: leo.token, body: { title: 'Pairing', kind: 'multiplayer' } })).body;
    await api(h.base, `/api/chats/${chat.id}/invitations`, { token: leo.token, body: { email: 'Nuevo@Acme.com' } });
    const nuevo = await register(h.base, 'nuevo@acme.com', 'Nuevo');
    const pending = (await api<Invitation[]>(h.base, '/api/invitations', { token: nuevo.token })).body;
    expect(pending).toHaveLength(1);
    expect(pending[0].chatTitle).toBe('Pairing');
  });

  it('stores shared workspace files with optimistic concurrency and a change feed', async () => {
    const { leo, ana, chat } = await sharedChat();
    const anaSocket = await connect(ana.token, 'ana-device-1');
    const content = new TextEncoder().encode('console.log("hola")\n');
    const hash = createHash('sha256').update(content).digest('hex');

    const put = await api<FileEntry>(h.base, `/api/chats/${chat.id}/fs/file?path=${encodeURIComponent('src/index.js')}&base=&exec=0`, { method: 'PUT', token: leo.token, raw: content });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ path: 'src/index.js', hash, size: content.length, seq: 1 });
    await anaSocket.waitFor((m) => m.t === 'fs.change' && m.entries[0].path === 'src/index.js');

    const stale = await api(h.base, `/api/chats/${chat.id}/fs/file?path=src/index.js&base=&exec=0`, { method: 'PUT', token: ana.token, raw: new TextEncoder().encode('otro') });
    expect(stale.status).toBe(409);
    expect((await api(h.base, `/api/chats/${chat.id}/fs/file?path=../x&base=`, { method: 'PUT', token: ana.token, raw: content })).status).toBe(400);

    const blob = await api<ArrayBuffer>(h.base, `/api/chats/${chat.id}/fs/blob/${hash}`, { token: ana.token });
    expect(new TextDecoder().decode(blob.body)).toBe('console.log("hola")\n');

    const removed = await api<FileEntry>(h.base, `/api/chats/${chat.id}/fs/file?path=src/index.js&base=${hash}`, { method: 'DELETE', token: ana.token });
    expect(removed.body).toMatchObject({ hash: null, seq: 2 });
    const changes = (await api<{ seq: number; entries: FileEntry[] }>(h.base, `/api/chats/${chat.id}/fs/changes?since=0`, { token: leo.token })).body;
    expect(changes.seq).toBe(2);
    expect(changes.entries).toHaveLength(1);
    expect(changes.entries[0]).toMatchObject({ path: 'src/index.js', hash: null });

    const outsider = await register(h.base, 'mal@acme.com', 'Mal');
    expect((await api(h.base, `/api/chats/${chat.id}/fs/blob/${hash}`, { token: outsider.token })).status).toBe(404);
  });

  it('requires the access code to self-register when configured', async () => {
    const guarded = await startServer({ accessCode: '424242' });
    try {
      const health = (await api(guarded.base, '/api/health')).body;
      expect(health.auth.accessCodeRequired).toBe(true);
      const without = await api(guarded.base, '/api/auth/register', { body: { email: 'a@acme.com', password: 'contraseña-segura' } });
      expect(without.status).toBe(403);
      await register(guarded.base, 'a@acme.com', 'A', '424242');
      const login = await api(guarded.base, '/api/auth/login', { body: { email: 'A@acme.com', password: 'contraseña-segura' } });
      expect(login.status).toBe(200);
    } finally {
      await guarded.close();
    }
  });

  it('turns the access code on and off without restarting', async () => {
    const guarded = await startServer({ accessCode: '424242' });
    try {
      guarded.server.setAccessCode(null);
      expect((await api(guarded.base, '/api/health')).body.auth.accessCodeRequired).toBe(false);
      await register(guarded.base, 'open@acme.com', 'Open');

      guarded.server.setAccessCode('515151');
      expect((await api(guarded.base, '/api/health')).body.auth.accessCodeRequired).toBe(true);
      expect((await api(guarded.base, '/api/auth/register', { body: { email: 'late@acme.com', name: 'Late', password: 'contraseña-segura' } })).status).toBe(403);
      await register(guarded.base, 'late@acme.com', 'Late', '515151');
    } finally {
      await guarded.close();
    }
  });
});
