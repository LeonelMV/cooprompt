import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AttachmentRef, ChatSummary, HealthResponse, Invitation, SendMessageResponse, TurnConfig } from '@cooprompt/protocol';
import { promptText } from '@cooprompt/protocol';
import { api, register, startServer, TestSocket, type Harness } from './helpers.ts';

const config: TurnConfig = { engine: 'claude', profileId: 'p1', model: null, permissionMode: 'default' };

/** The smallest valid PNG: 1×1 transparent pixel. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><html><script>alert(1)</script></html>');

describe('attachments', () => {
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
    const chat = (await api<ChatSummary>(h.base, '/api/chats', { token: leo.token, body: { title: 'Diseño', kind: 'multiplayer' } })).body;
    const invitation = (await api<Invitation>(h.base, `/api/chats/${chat.id}/invitations`, { token: leo.token, body: { userId: ana.user.id } })).body;
    await api(h.base, `/api/invitations/${invitation.id}/accept`, { token: ana.token, body: {} });
    return { leo, ana, chat };
  }

  const upload = (chatId: string, token: string, name: string, content: Uint8Array) =>
    api<AttachmentRef>(h.base, `/api/chats/${chatId}/attachments?name=${encodeURIComponent(name)}`, { token, raw: content });

  /** Reads the body too, so no connection is left open. */
  const download = async (chatId: string, token: string, id: string) => {
    const response = await fetch(`${h.base}/api/chats/${chatId}/attachments/${id}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
  };

  it('announces its limits, so apps can tell a server that takes attachments from one that predates them', async () => {
    const health = (await api<HealthResponse>(h.base, '/api/health')).body;
    expect(health.attachments).toEqual({ maxFileBytes: 50 * 1024 * 1024, maxFiles: 10, maxMessageBytes: 100 * 1024 * 1024 });
  });

  it('lets only the chat members upload and download, and only through that chat', async () => {
    const { leo, ana, chat } = await sharedChat();
    const outsider = await register(h.base, 'mal@acme.com', 'Mal');
    const other = (await api<ChatSummary>(h.base, '/api/chats', { token: outsider.token, body: { title: 'Otro', kind: 'private' } })).body;

    const uploaded = await upload(chat.id, leo.token, 'pantalla.png', PNG);
    expect(uploaded.status).toBe(200);
    expect(uploaded.body).toMatchObject({ name: 'pantalla.png', mime: 'image/png', kind: 'image', size: PNG.length, sha256: createHash('sha256').update(PNG).digest('hex') });

    const fetched = await download(chat.id, ana.token, uploaded.body.id);
    expect(fetched.status).toBe(200);
    expect(fetched.body.equals(PNG)).toBe(true);

    expect((await download(chat.id, outsider.token, uploaded.body.id)).status).toBe(404);
    expect((await download(other.id, outsider.token, uploaded.body.id)).status).toBe(404);
    expect((await api(h.base, `/api/chats/${chat.id}/attachments/${uploaded.body.id}`)).status).toBe(401);
    expect((await upload(chat.id, outsider.token, 'x.png', PNG)).status).toBe(404);
    expect((await upload(chat.id, 'not-a-token', 'x.png', PNG)).status).toBe(401);
  });

  it('keeps company chat files to those who joined', async () => {
    const leo = await register(h.base, 'leo@acme.com', 'Leo');
    const ana = await register(h.base, 'ana@acme.com', 'Ana');
    const chat = (await api<ChatSummary>(h.base, '/api/chats', { token: leo.token, body: { title: 'Incidentes', kind: 'corporate' } })).body;
    const uploaded = (await upload(chat.id, leo.token, 'grafico.png', PNG)).body;
    expect((await api(h.base, `/api/chats/${chat.id}/items`, { token: ana.token })).status).toBe(200);
    expect((await download(chat.id, ana.token, uploaded.id)).status).toBe(403);
    await api(h.base, `/api/chats/${chat.id}/join`, { token: ana.token, body: {} });
    expect((await download(chat.id, ana.token, uploaded.id)).status).toBe(200);
  });

  it('refuses files over the limit and empty ones', async () => {
    const { leo, chat } = await sharedChat();
    const tooLarge = await api<{ error: string }>(h.base, `/api/chats/${chat.id}/attachments?name=video.mp4`, { token: leo.token, raw: Buffer.alloc(50 * 1024 * 1024 + 1) });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.error).toBe('Attachments can be up to 50 MB');
    expect((await upload(chat.id, leo.token, 'vacio.txt', Buffer.alloc(0))).status).toBe(400);
  });

  it('cleans file names: no folders, hidden direction tricks, control characters or misleading extensions', async () => {
    const { leo, chat } = await sharedChat();
    const named = async (name: string, content: Uint8Array = PNG) => (await upload(chat.id, leo.token, name, content)).body.name;
    expect(await named('../../etc/passwd.png')).toBe('passwd.png');
    expect(await named('..\\..\\Windows\\win.png')).toBe('win.png');
    expect(await named('factura\u202Egnp.exe')).toBe('facturagnp.exe.png');
    expect(await named('a\u0000b\nc.png')).toBe('abc.png');
    expect(await named('..')).toBe('file.png');
    expect(await named('notas.txt')).toBe('notas.txt.png');
    expect(await named('informe', PDF)).toBe('informe.pdf');
    expect(await named('script.sh', Buffer.from('#!/bin/sh\necho hola\n'))).toBe('script.sh');
    expect((await named(`${'x'.repeat(300)}.png`)).length).toBe(120);
  });

  it('trusts the bytes over the name and serves nothing as an active document', async () => {
    const { leo, chat } = await sharedChat();
    const disguised = (await upload(chat.id, leo.token, 'foto.png', HTML)).body;
    expect(disguised).toMatchObject({ kind: 'file', mime: 'application/octet-stream' });
    const page = await download(chat.id, leo.token, disguised.id);
    expect(page.headers.get('content-type')).toBe('application/octet-stream');
    expect(page.headers.get('content-disposition')).toMatch(/^attachment; filename="foto.png"/);
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('content-security-policy')).toContain('sandbox');

    const drawing = (await upload(chat.id, leo.token, 'logo.svg', SVG)).body;
    expect(drawing).toMatchObject({ kind: 'image', mime: 'image/svg+xml' });
    const svg = await download(chat.id, leo.token, drawing.id);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(svg.headers.get('content-security-policy')).toContain('sandbox');

    const image = await download(chat.id, leo.token, (await upload(chat.id, leo.token, 'año.png', PNG)).body.id);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('content-disposition')).toBe(`inline; filename="a_o.png"; filename*=UTF-8''a%C3%B1o.png`);
    expect(image.headers.get('etag')).toBe(`"${createHash('sha256').update(PNG).digest('hex')}"`);
  });

  it('sends files with a message, with a text fallback for apps that predate attachments', async () => {
    const { leo, ana, chat } = await sharedChat();
    const anaSocket = await connect(ana.token, 'ana-device-1');
    const image = (await upload(chat.id, ana.token, 'pantalla.png', PNG)).body;
    const pdf = (await upload(chat.id, ana.token, 'informe.pdf', PDF)).body;

    const sent = await api<SendMessageResponse>(h.base, `/api/chats/${chat.id}/messages`, {
      token: ana.token,
      body: { text: '¿qué ves?', deviceId: 'ana-device-1', config, attachments: [image.id, pdf.id] },
    });
    expect(sent.status).toBe(200);
    expect(sent.body.item.data.attachments?.map((file) => file.name)).toEqual(['pantalla.png', 'informe.pdf']);
    expect(sent.body.item.data.text).toBe('¿qué ves?\n\n📎 pantalla.png\n📎 informe.pdf');
    expect(promptText(sent.body.item.data)).toBe('¿qué ves?');

    const run = await anaSocket.waitFor<'turn.run'>((m) => m.t === 'turn.run');
    expect(run.prompt.data.attachments?.map((file) => file.id)).toEqual([image.id, pdf.id]);
    anaSocket.send({ t: 'turn.finish', turnId: run.turn.id, status: 'done' });

    const onlyFiles = await api<SendMessageResponse>(h.base, `/api/chats/${chat.id}/messages`, {
      token: ana.token,
      body: { text: '', deviceId: 'ana-device-1', config, attachments: [image.id] },
    });
    expect(onlyFiles.body.item.data.text).toBe('📎 pantalla.png');
    expect(promptText(onlyFiles.body.item.data)).toBe('');
    expect((await api(h.base, `/api/chats/${chat.id}/messages`, { token: ana.token, body: { text: '', deviceId: 'ana-device-1', config } })).status).toBe(400);

    const leoSocket = await connect(leo.token, 'leo-device-1');
    const notHis = await api(h.base, `/api/chats/${chat.id}/messages`, { token: leo.token, body: { text: 'mirá', deviceId: 'leo-device-1', config, attachments: [image.id] } });
    expect(notHis.status).toBe(400);
    expect(leoSocket.messages.some((m) => m.t === 'turn.run')).toBe(false);
    const elsewhere = (await api<ChatSummary>(h.base, '/api/chats', { token: ana.token, body: { title: 'Mío', kind: 'private' } })).body;
    expect((await api(h.base, `/api/chats/${elsewhere.id}/messages`, { token: ana.token, body: { text: 'x', deviceId: 'ana-device-1', config, attachments: [image.id] } })).status).toBe(400);
  });

  it('caps how many files and bytes a message carries', async () => {
    const { ana, chat } = await sharedChat();
    await connect(ana.token, 'ana-device-1');
    const send = (attachments: string[]) => api(h.base, `/api/chats/${chat.id}/messages`, { token: ana.token, body: { text: 'x', deviceId: 'ana-device-1', config, attachments } });
    const eleven = await Promise.all(Array.from({ length: 11 }, (_, index) => upload(chat.id, ana.token, `${index}.png`, Buffer.concat([PNG, Buffer.from([index])]))));
    const tooMany = await send(eleven.map((result) => result.body.id));
    expect(tooMany.status).toBe(400);
    expect((tooMany.body as { error: string }).error).toBe('A message can carry up to 10 files');

    const big = await Promise.all([1, 2, 3].map((index) => upload(chat.id, ana.token, `${index}.mov`, Buffer.alloc(34 * 1024 * 1024, index))));
    const tooHeavy = await send(big.map((result) => result.body.id));
    expect(tooHeavy.status).toBe(413);
    expect((tooHeavy.body as { error: string }).error).toBe('The files of a message can add up to 100 MB');
  });

  it("describes an executor's attachments with the server's record and drops other chats' files", async () => {
    const { leo, ana, chat } = await sharedChat();
    const leoSocket = await connect(leo.token, 'leo-device-1');
    const anaSocket = await connect(ana.token, 'ana-device-1');
    anaSocket.send({ t: 'subscribe', chatId: chat.id });
    const turn = (await api<SendMessageResponse>(h.base, `/api/chats/${chat.id}/messages`, { token: leo.token, body: { text: 'sacá una captura', deviceId: 'leo-device-1', config } })).body.turn;
    await leoSocket.waitFor((m) => m.t === 'turn.run');

    const shot = (await upload(chat.id, leo.token, 'browser_take_screenshot-1.png', PNG)).body;
    const privateChat = (await api<ChatSummary>(h.base, '/api/chats', { token: leo.token, body: { title: 'Privado', kind: 'private' } })).body;
    const foreign = (await upload(privateChat.id, leo.token, 'secreto.png', PNG)).body;
    const claimed = [{ ...shot, name: 'otro.exe', mime: 'text/html' }, foreign, { id: 'nope' }] as AttachmentRef[];
    leoSocket.send({
      t: 'turn.items',
      turnId: turn.id,
      items: [{ id: `${turn.id}.tool.t1`, kind: 'tool', data: { toolUseId: 't1', name: 'mcp__playwright__browser_take_screenshot', input: {}, status: 'done', attachments: claimed } }],
    });
    const items = await anaSocket.waitFor<'items'>((m) => m.t === 'items' && m.items.some((item) => item.id === `${turn.id}.tool.t1`));
    expect((items.items[0].data as { attachments: AttachmentRef[] }).attachments).toEqual([shot]);
  });

  it('deletes the files of a deleted chat, keeping blobs other chats still use', async () => {
    const { leo, chat } = await sharedChat();
    const kept = (await api<ChatSummary>(h.base, '/api/chats', { token: leo.token, body: { title: 'Sigue', kind: 'private' } })).body;
    const shared = (await upload(chat.id, leo.token, 'a.png', PNG)).body;
    const own = (await upload(chat.id, leo.token, 'b.pdf', PDF)).body;
    const elsewhere = (await upload(kept.id, leo.token, 'a.png', PNG)).body;
    const blob = (hash: string) => join(h.dataDir, 'attachments', hash.slice(0, 2), hash);
    expect(existsSync(blob(own.sha256))).toBe(true);

    expect((await api(h.base, `/api/chats/${chat.id}`, { method: 'DELETE', token: leo.token })).status).toBe(200);
    expect(existsSync(blob(own.sha256))).toBe(false);
    expect(existsSync(blob(shared.sha256))).toBe(true);
    expect((await download(kept.id, leo.token, elsewhere.id)).status).toBe(200);
    expect(h.server.store.db.get('select 1 as ok from attachments where chat_id = ?', chat.id)).toBeUndefined();
  });
});
