import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AttachmentRef,
  ChatSummary,
  ClientFeature,
  Invitation,
  SendMessageResponse,
  SendTeamMessageResponse,
  ServerMessage,
  ShareTeamMessageResponse,
  TranscriptItem,
  TurnConfig,
  TurnInfo,
} from '@cooprompt/protocol';
import { api, register, startServer, TestSocket, type Harness } from './helpers.ts';

const config: TurnConfig = { engine: 'codex', profileId: 'p1', model: null, permissionMode: 'default' };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
/** Features announced by a client that supports team-only messages. */
const CURRENT: ClientFeature[] = ['parallel-turns', 'automations', 'team-messages'];
const SECRET = 'la clave es ZORZAL-7731';

describe('team-only messages', () => {
  let h: Harness;
  const sockets: TestSocket[] = [];

  beforeEach(async () => {
    h = await startServer();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await h.close();
  });

  async function connect(token: string, deviceId: string, features?: ClientFeature[]) {
    const socket = await TestSocket.connect(h.base, token, deviceId, 'Test Mac', features);
    sockets.push(socket);
    return socket;
  }

  async function sharedChat() {
    const leo = await register(h.base, 'leo@acme.com', 'Leo');
    const ana = await register(h.base, 'ana@acme.com', 'Ana');
    const chat = (await api<ChatSummary>(h.base, '/api/chats', { token: leo.token, body: { title: 'Pagos', kind: 'multiplayer' } })).body;
    const invitation = (await api<Invitation>(h.base, `/api/chats/${chat.id}/invitations`, { token: leo.token, body: { userId: ana.user.id } })).body;
    await api(h.base, `/api/invitations/${invitation.id}/accept`, { token: ana.token, body: {} });
    const team = (token: string, body: Record<string, unknown>) => api<SendTeamMessageResponse>(h.base, `/api/chats/${chat.id}/team-messages`, { token, body });
    const items = async (token: string, query = '') => (await api<TranscriptItem[]>(h.base, `/api/chats/${chat.id}/items${query}`, { token })).body;
    const turns = async () => (await api<TurnInfo[]>(h.base, `/api/chats/${chat.id}/turns`, { token: leo.token })).body;
    return { leo, ana, chat, team, items, turns };
  }

  const upload = async (chatId: string, token: string, name: string) =>
    (await api<AttachmentRef>(h.base, `/api/chats/${chatId}/attachments?name=${encodeURIComponent(name)}`, { token, raw: PNG })).body;
  const itemsOf = (socket: TestSocket, id: string) =>
    socket.messages.flatMap((message) => (message.t === 'items' ? message.items : [])).filter((item) => item.id === id);

  it('never turns one into a turn, so no executor ever gets it', async () => {
    const { leo, ana, chat, team, turns } = await sharedChat();
    const leoMac = await connect(leo.token, 'leo-device-1', CURRENT);
    const anaMac = await connect(ana.token, 'ana-device-1', CURRENT);
    leoMac.send({ t: 'subscribe', chatId: chat.id });
    await leoMac.waitFor((message) => message.t === 'presence');

    const sent = await team(ana.token, { text: SECRET });
    expect(sent.status).toBe(200);
    expect(sent.body.item).toMatchObject({ kind: 'team', turnId: null, authorId: ana.user.id, data: { text: SECRET } });
    await leoMac.waitFor((message) => message.t === 'items' && message.items.some((item) => item.id === sent.body.item.id));
    expect(await turns()).toEqual([]);
    const summary = (await api<ChatSummary>(h.base, `/api/chats/${chat.id}`, { token: leo.token })).body;
    expect(summary).toMatchObject({ activeTurn: null, activeTurns: [], queuedTurns: 0 });

    // The next turn's prompt is the message that started it, never the team-only one before it.
    const normal = (await api<SendMessageResponse>(h.base, `/api/chats/${chat.id}/messages`, { token: ana.token, body: { text: '¿qué cambió en la API?', deviceId: 'ana-device-1', config } })).body;
    const run = await anaMac.waitFor<'turn.run'>((message) => message.t === 'turn.run');
    expect(run.turn.id).toBe(normal.turn.id);
    expect(run.prompt.data.text).toBe('¿qué cambió en la API?');
    expect([...leoMac.messages, ...anaMac.messages].filter((message) => message.t === 'turn.run')).toHaveLength(1);

    // An executor can't publish one either: only the HTTP API creates them.
    anaMac.send({ t: 'turn.items', turnId: run.turn.id, items: [{ id: `${run.turn.id}.leak`, kind: 'team', data: { text: 'hola equipo' } }] });
    anaMac.send({ t: 'turn.finish', turnId: run.turn.id, status: 'done' });
    await leoMac.waitFor((message) => message.t === 'turn.upsert' && message.turn.id === run.turn.id && message.turn.status === 'done');
    expect((await api<TranscriptItem[]>(h.base, `/api/chats/${chat.id}/items?include=team`, { token: leo.token })).body.map((item) => item.kind)).toEqual(['notice', 'notice', 'team', 'user']);
  });

  it('gives the content only to apps that take it: older apps and agent context get who wrote, without what', async () => {
    const { leo, ana, chat, team, items } = await sharedChat();
    const current = await connect(leo.token, 'leo-device-1', CURRENT);
    const old = await connect(leo.token, 'leo-device-old');
    expect(current.messages.find((message) => message.t === 'ready')).toMatchObject({ teamMessages: true });
    current.send({ t: 'subscribe', chatId: chat.id });
    old.send({ t: 'subscribe', chatId: chat.id });
    await current.waitFor((message) => message.t === 'presence');
    await old.waitFor((message) => message.t === 'presence');

    const file = await upload(chat.id, ana.token, 'zorzal-7731.png');
    const { item } = (await team(ana.token, { text: SECRET, attachments: [file.id] })).body;
    expect(item.data).toEqual({ text: SECRET, attachments: [file] });
    await current.waitFor((message) => message.t === 'items' && message.items.some((entry) => entry.id === item.id));
    await old.waitFor((message) => message.t === 'items' && message.items.some((entry) => entry.id === item.id));

    const standIn = { ...item, data: { text: 'Ana sent a team-only message: update CooPrompt to read it.' } };
    expect(itemsOf(current, item.id)).toEqual([item]);
    expect(itemsOf(old, item.id)).toEqual([standIn]);
    expect(JSON.stringify(old.messages)).not.toContain('ZORZAL');

    // What the runner asks for (and older apps load) carries the stand-in; the app's transcript asks for the message.
    expect((await items(leo.token)).find((entry) => entry.id === item.id)).toEqual(standIn);
    expect((await items(leo.token, `?afterRev=${item.rev - 1}`)).find((entry) => entry.id === item.id)).toEqual(standIn);
    expect((await items(leo.token, '?include=team')).find((entry) => entry.id === item.id)).toEqual(item);
  });

  it('tells the other members’ current apps, open or not, so they can notify', async () => {
    const { leo, ana, chat, team } = await sharedChat();
    const leoCurrent = await connect(leo.token, 'leo-device-1', CURRENT);
    const leoOld = await connect(leo.token, 'leo-device-old');
    const anaCurrent = await connect(ana.token, 'ana-device-1', CURRENT);
    const outsider = await register(h.base, 'mal@acme.com', 'Mal');
    const outsiderMac = await connect(outsider.token, 'mal-device-1', CURRENT);

    const { item } = (await team(ana.token, { text: 'che, ¿vieron el deploy?' })).body;
    const told = await leoCurrent.waitFor<'team.message'>((message) => message.t === 'team.message');
    expect(told).toEqual({ t: 'team.message', chatId: chat.id, chatTitle: 'Pagos', authorName: 'Ana', item });
    const anyTold = (socket: TestSocket) => socket.messages.some((message: ServerMessage) => message.t === 'team.message');
    expect([anyTold(leoOld), anyTold(anaCurrent), anyTold(outsiderMac)]).toEqual([false, false, false]);
    // Like any message, it moves the chat up everyone's list.
    expect((await api<ChatSummary>(h.base, `/api/chats/${chat.id}`, { token: leo.token })).body.lastActivityAt).toBe(item.createdAt);
  });

  it('lets only members write them, with their own uploads', async () => {
    const { leo, ana, chat, team } = await sharedChat();
    const outsider = await register(h.base, 'mal@acme.com', 'Mal');
    expect((await team(outsider.token, { text: 'hola' })).status).toBe(404);
    expect((await team('not-a-token', { text: 'hola' })).status).toBe(401);
    expect((await team(ana.token, { text: '   ' })).status).toBe(400);
    const leoFile = await upload(chat.id, leo.token, 'leo.png');
    expect((await team(ana.token, { text: '', attachments: [leoFile.id] })).body).toMatchObject({ error: 'An attachment is missing: attach the file again' });
    const anaFile = await upload(chat.id, ana.token, 'ana.png');
    expect((await team(ana.token, { text: '', attachments: [anaFile.id] })).body.item.data).toEqual({ text: '', attachments: [anaFile] });

    const company = (await api<ChatSummary>(h.base, '/api/chats', { token: leo.token, body: { title: 'Acme', kind: 'corporate' } })).body;
    const viewer = await api(h.base, `/api/chats/${company.id}/team-messages`, { token: outsider.token, body: { text: 'hola' } });
    expect(viewer.status).toBe(403);
  });

  it('shares one with the agents only when its author asks, as a message without a turn that every app gets', async () => {
    const { leo, ana, chat, team, items, turns } = await sharedChat();
    const old = await connect(leo.token, 'leo-device-old');
    old.send({ t: 'subscribe', chatId: chat.id });
    await old.waitFor((message) => message.t === 'presence');
    const file = await upload(chat.id, ana.token, 'diagrama.png');
    const { item } = (await team(ana.token, { text: 'el corte es el jueves', attachments: [file.id] })).body;
    const share = (token: string, id = item.id) => api<ShareTeamMessageResponse>(h.base, `/api/chats/${chat.id}/team-messages/${id}/share`, { token, body: {} });

    expect((await share(leo.token)).status).toBe(403);
    expect((await share(ana.token, 'team.nope')).status).toBe(404);
    const shared = (await share(ana.token)).body.item;
    expect(shared).toMatchObject({ id: item.id, seq: item.seq, kind: 'user', turnId: null, authorId: ana.user.id, data: { text: 'el corte es el jueves\n\n📎 diagrama.png', attachments: [file] } });
    expect(shared.data.sharedAt).toEqual(expect.any(Number));
    expect(shared.rev).toBeGreaterThan(item.rev);
    expect((await share(ana.token)).body.item).toEqual(shared);

    await old.waitFor((message) => message.t === 'items' && message.items.some((entry) => entry.id === item.id && entry.kind === 'user'));
    expect((await items(leo.token)).find((entry) => entry.id === item.id)).toEqual(shared);
    expect(await turns()).toEqual([]);
  });
});
