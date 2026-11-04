import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangesResponse, ChatSummary, SendMessageResponse, TurnConfig } from '@cooprompt/protocol';
import { api, register, startServer, TestSocket, type Harness } from '../../server/test/helpers.ts';
import { AttachmentStore } from '../src/main/attachments.ts';
import { ApiClient } from '../src/main/net/api.ts';
import { WorkspaceSync } from '../src/main/sync/workspace-sync.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
const config: TurnConfig = { engine: 'claude', profileId: 'p1', model: null, permissionMode: 'default' };

describe('attachments on each Mac', () => {
  let h: Harness;
  let dir: string;
  const sockets: TestSocket[] = [];

  beforeEach(async () => {
    h = await startServer();
    dir = await mkdtemp(join(tmpdir(), 'cooprompt-attachments-'));
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  const storeFor = (name: string, token: string, base = h.base) =>
    new AttachmentStore({ api: new ApiClient(() => base, () => token), cacheDir: join(dir, name, 'cache'), stagingDir: join(dir, name, 'staged'), log: () => {} });

  async function sharedChat() {
    const leo = await register(h.base, 'leo@acme.com', 'Leo');
    const ana = await register(h.base, 'ana@acme.com', 'Ana');
    const chat = (await api<ChatSummary>(h.base, '/api/chats', { token: leo.token, body: { title: 'Diseño', kind: 'multiplayer' } })).body;
    const invitation = (await api(h.base, `/api/chats/${chat.id}/invitations`, { token: leo.token, body: { userId: ana.user.id } })).body;
    await api(h.base, `/api/invitations/${invitation.id}/accept`, { token: ana.token, body: {} });
    const socket = await TestSocket.connect(h.base, ana.token, 'ana-device-0001');
    sockets.push(socket);
    return { leo, ana, chat, ana_: storeFor('ana', ana.token), leo_: storeFor('leo', leo.token) };
  }

  /** What `chats.send` does: upload the staged files, send the message with them, keep the sent copies. */
  async function send(store: AttachmentStore, chatId: string, token: string, ids: string[]) {
    const refs = await store.uploadStaged(chatId, ids);
    const sent = await api<SendMessageResponse>(h.base, `/api/chats/${chatId}/messages`, { token, body: { text: 'mirá esto', deviceId: 'ana-device-0001', config, attachments: refs.map((ref) => ref.id) } });
    await store.commit(chatId, ids);
    return sent.body.item.data.attachments!;
  }

  it('sends a file from one Mac and gives the other Mac, and its agent, the same bytes', async () => {
    const { ana, chat, ana_, leo_ } = await sharedChat();
    const staged = await ana_.stage('../Captura de pantalla.png', PNG);
    expect(staged).toMatchObject({ name: 'Captura de pantalla.png', mime: 'image/png', kind: 'image', size: PNG.length });
    const [ref] = await send(ana_, chat.id, ana.token, [staged.id]);

    const kept = await ana_.file(chat.id, ref.id);
    expect(kept).toBe(join(dir, 'ana', 'cache', chat.id, ref.id, 'Captura de pantalla.png'));
    expect((await readFile(kept)).equals(PNG)).toBe(true);

    const cwd = join(dir, 'leo-workspace');
    await mkdir(cwd);
    const [copy] = await leo_.materialize(chat.id, cwd, [ref]);
    expect(copy).toMatchObject({ id: ref.id, name: 'Captura de pantalla.png', kind: 'image', path: join(cwd, '.cooprompt', 'attachments', ref.id, 'Captura de pantalla.png') });
    expect((await readFile(copy.path)).equals(PNG)).toBe(true);
    expect(await readFile(join(cwd, '.cooprompt', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('keeps the copies out of the shared workspace and out of symbolically linked folders', async () => {
    const { ana, chat, ana_, leo_ } = await sharedChat();
    const [ref] = await send(ana_, chat.id, ana.token, [(await ana_.stage('a.png', PNG)).id]);
    const root = join(dir, 'mirror');
    const sync = new WorkspaceSync({ api: new ApiClient(() => h.base, () => ana.token), chatId: chat.id, root, statePath: join(dir, 'state.json'), deviceName: 'Ana', onStatus: () => {}, log: () => {} });
    await sync.start();
    await writeFile(join(root, 'README.md'), 'hola\n');
    await leo_.materialize(chat.id, root, [ref]);
    await sync.flush();
    await sync.stop();
    const changes = (await api<ChangesResponse>(h.base, `/api/chats/${chat.id}/fs/changes?since=0`, { token: ana.token })).body;
    expect(changes.entries.map((entry) => entry.path)).toEqual(['README.md']);

    const repo = join(dir, 'repo');
    await mkdir(join(dir, 'elsewhere'), { recursive: true });
    await mkdir(repo);
    await symlink(join(dir, 'elsewhere'), join(repo, '.cooprompt'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await leo_.materialize(chat.id, repo, [ref])).toEqual([]);
    expect(existsSync(join(dir, 'elsewhere', 'attachments'))).toBe(false);
  });

  it('serves the renderer media only, with ranges for seeking, and only what the chat member may fetch', async () => {
    const { ana, chat, ana_ } = await sharedChat();
    const image = await ana_.stage('a.png', PNG);
    const page = await ana_.stage('notas.html', Buffer.from('<!doctype html><script>alert(1)</script>'));
    expect(page).toMatchObject({ kind: 'file', mime: 'application/octet-stream' });

    const full = await ana_.serve(new Request(`cooprompt-media://staged/${image.id}`));
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('image/png');
    expect(full.headers.get('x-content-type-options')).toBe('nosniff');
    expect(full.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await full.arrayBuffer()).equals(PNG)).toBe(true);

    const part = await ana_.serve(new Request(`cooprompt-media://staged/${image.id}`, { headers: { range: 'bytes=1-3' } }));
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 1-3/${PNG.length}`);
    expect(Buffer.from(await part.arrayBuffer()).toString('latin1')).toBe('PNG');

    expect((await ana_.serve(new Request(`cooprompt-media://staged/${page.id}`))).status).toBe(415);
    expect((await ana_.serve(new Request('cooprompt-media://attachment/..%2F..%2Fetc/passwd'))).status).toBe(404);

    const [ref] = await send(ana_, chat.id, ana.token, [image.id]);
    const mal = await register(h.base, 'mal@acme.com', 'Mal');
    const outsider = storeFor('mal', mal.token);
    expect((await outsider.serve(new Request(`cooprompt-media://attachment/${chat.id}/${ref.id}`))).status).toBe(404);
    expect(existsSync(join(dir, 'mal', 'cache', chat.id, ref.id))).toBe(false);
  });

  it('opens with the default app only media whose bytes match their name', async () => {
    const { ana, chat, ana_, leo_ } = await sharedChat();
    const [image, script] = await send(ana_, chat.id, ana.token, [(await ana_.stage('a.png', PNG)).id, (await ana_.stage('run.command', Buffer.from('#!/bin/sh\nrm -rf ~\n'))).id]);
    expect(await leo_.openable(chat.id, image.id)).toMatch(/a\.png$/);
    await expect(leo_.openable(chat.id, script.id)).rejects.toThrow(/only opens images, PDFs, audio and video/);
  });

  it('shares what an agent produced once, media only, without the prompt files again', async () => {
    const { leo, chat, leo_ } = await sharedChat();
    const screenshot = Buffer.concat([PNG, Buffer.from('shot')]);
    const share = leo_.sharer(chat.id, { skip: [], rename: (name) => name.replace('secret', '«redacted»') });
    const first = await share({ name: 'secret-shot.png', mime: 'image/png', data: screenshot });
    expect(first).toMatchObject({ name: '«redacted»-shot.png', kind: 'image' });
    expect(await share({ name: 'again.png', mime: 'image/png', data: screenshot })).toEqual(first);
    expect(await share({ name: 'notes.txt', mime: 'text/plain', data: Buffer.from('hola') })).toBeNull();

    const cwd = join(dir, 'work');
    await mkdir(cwd);
    await writeFile(join(cwd, 'home.png'), PNG);
    const fromDisk = await leo_.sharer(chat.id, { skip: [] })({ path: join(cwd, 'home.png') });
    expect(fromDisk).toMatchObject({ name: 'home.png', size: PNG.length });
    const skipped = leo_.sharer(chat.id, { skip: [fromDisk!.sha256] });
    expect(await skipped({ path: join(cwd, 'home.png') })).toBeNull();
    const fetched = await api<ArrayBuffer>(h.base, `/api/chats/${chat.id}/attachments/${first!.id}`, { token: leo.token });
    expect(Buffer.from(fetched.body).equals(screenshot)).toBe(true);
  });

  it("removes this Mac's copies of a deleted chat", async () => {
    const { ana, chat, ana_ } = await sharedChat();
    const [ref] = await send(ana_, chat.id, ana.token, [(await ana_.stage('a.png', PNG)).id]);
    const cwd = join(dir, 'folder');
    await mkdir(cwd);
    await writeFile(join(cwd, 'keep.txt'), 'mine');
    await ana_.materialize(chat.id, cwd, [ref]);
    await ana_.purgeChat(chat.id, cwd);
    expect(existsSync(join(dir, 'ana', 'cache', chat.id))).toBe(false);
    expect(existsSync(join(cwd, '.cooprompt'))).toBe(false);
    expect(await readFile(join(cwd, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('enforces the limits before uploading', async () => {
    const { chat, ana_ } = await sharedChat();
    await expect(ana_.stage('vacio.png', Buffer.alloc(0))).rejects.toThrow('vacio.png is empty');
    await expect(ana_.stage('video.mov', Buffer.alloc(50 * 1024 * 1024 + 1))).rejects.toThrow('video.mov is larger than 50 MB');
    const eleven = await Promise.all(Array.from({ length: 11 }, (_, index) => ana_.stage(`${index}.png`, PNG)));
    await expect(ana_.uploadStaged(chat.id, eleven.map((file) => file.id))).rejects.toThrow('A message can carry up to 10 files');
  });
});

describe('a server that predates attachments', () => {
  let old: Server;
  let base: string;

  beforeEach(async () => {
    old = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/health') return response.end(JSON.stringify({ ok: true, name: 'CooPrompt', version: '0.1.0', protocol: 1, firstRun: false, auth: {} }));
      response.statusCode = 404;
      response.end(JSON.stringify({ message: `Route ${request.method}:${request.url} not found`, error: 'Not Found', statusCode: 404 }));
    });
    await new Promise<void>((resolve) => old.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(old.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => old.close(resolve));
  });

  it('is told apart before anything is staged, so no message goes out without its files', async () => {
    const store = new AttachmentStore({ api: new ApiClient(() => base, () => 'token'), cacheDir: join(tmpdir(), 'unused-cache'), stagingDir: join(tmpdir(), `unused-staged-${Date.now()}`), log: () => {} });
    expect(await store.limits()).toBeNull();
    await expect(store.stage('a.png', PNG)).rejects.toThrow("This team server doesn't accept attachments yet: whoever hosts it needs to update CooPrompt.");
    expect(await store.sharer('chat-1')({ name: 'shot.png', mime: 'image/png', data: PNG })).toBeNull();
  });
});
