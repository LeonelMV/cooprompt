import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AttachmentRef, AuthResponse, ChatSummary, SendMessageResponse, TextItemData, TranscriptItem, TurnInfo } from '@cooprompt/protocol';
import { api, register, startServer, TestSocket, type Harness } from '../../server/test/helpers.ts';
import { AttachmentStore } from '../src/main/attachments.ts';
import { ApiClient } from '../src/main/net/api.ts';
import { Realtime } from '../src/main/net/realtime.ts';
import { Runner } from '../src/main/runner/runner.ts';
import { Settings } from '../src/main/settings.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

/**
 * Stand-in for Codex: logs its `--image` arguments and prompt, waits for a file named after `WAIT:<name>` in the
 * request, and for `SCREENSHOT` saves an image in its working folder and says where.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_ENGINE_DIR;
const args = process.argv.slice(2);
const cwd = args[args.indexOf('--cd') + 1];
let prompt = '';
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', async () => {
  const request = prompt.includes('</cooprompt_context>') ? prompt.slice(prompt.lastIndexOf('</cooprompt_context>')) : prompt;
  const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ images: args.filter((_, index) => args[index - 1] === '--image'), prompt, request, cwd }) + '\\n');
  out({ type: 'thread.started', thread_id: 'thread-' + process.pid });
  const name = /WAIT:(\\w+)/.exec(request)?.[1];
  while (name && !fs.existsSync(path.join(dir, name))) await new Promise((resolve) => setTimeout(resolve, 25));
  let text = 'Listo.';
  if (request.includes('SCREENSHOT')) {
    fs.mkdirSync(path.join(cwd, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'shots', 'out.png'), Buffer.from(process.env.FAKE_PNG, 'base64'));
    text = 'Guardé la captura en \`shots/out.png\`.';
    out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Voy a guardar la captura en shots/out.png.' } });
  }
  out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } });
  out({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
});
`;

interface Run {
  images: string[];
  prompt: string;
  request: string;
  cwd: string;
}

const until = async (check: () => Promise<boolean> | boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not reached in time');
};

describe('attachments in the turns this Mac runs', () => {
  let bin: string;
  let h: Harness;
  let dir: string;
  let leo: AuthResponse;
  let store: AttachmentStore;
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    bin = await mkdtemp(join(tmpdir(), 'cooprompt-engines-'));
    await writeFile(join(bin, 'codex'), FAKE_CODEX);
    await chmod(join(bin, 'codex'), 0o755);
  });

  afterAll(async () => {
    await rm(bin, { recursive: true, force: true });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /** A Runner on Leo's Mac with a real server; shared chats get a plain folder instead of a synced one. */
  async function setUp(chat: (leo: AuthResponse) => Promise<ChatSummary>) {
    h = await startServer();
    dir = await mkdtemp(join(tmpdir(), 'cooprompt-runner-files-'));
    leo = await register(h.base, 'leo@acme.com', 'Leo');
    const created = await chat(leo);
    const settings = new Settings(join(dir, 'settings.json'), { syncRoot: join(dir, 'Compartidos'), privateRoot: join(dir, 'Privados') });
    settings.update((data) => {
      data.serverUrl = h.base;
      data.user = leo.user;
      data.profiles = [{ id: 'codex-1', label: 'Codex', engine: 'codex', kind: 'codex-login', createdAt: 1 }];
      data.defaultProfileId = 'codex-1';
    });
    const api_ = new ApiClient(() => h.base, () => leo.token);
    store = new AttachmentStore({ api: api_, cacheDir: join(dir, 'attachments'), stagingDir: join(dir, 'attachments-staged'), log: () => {} });
    const shared = join(dir, 'Compartidos', 'chat');
    await mkdir(shared, { recursive: true });
    const realtime = new Realtime();
    const runner = new Runner({
      api: api_,
      realtime,
      settings,
      secrets: { get: () => null },
      connectors: { serversFor: async () => ({}), nativeNames: async () => [], codexApprovalScopes: async () => [] },
      sync: { activate: async () => ({ root: shared, ensureCaughtUp: async () => {}, flush: async () => {} }) as never, get: () => undefined },
      attachments: store,
      appVersion: 'test',
      executables: { claude: () => 'claude', codex: () => ({ bin: join(bin, 'codex'), pathDirs: [] }), cursor: () => 'cursor-agent' },
      shellEnv: () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, CODEX_HOME: join(dir, 'codex-home'), FAKE_ENGINE_DIR: dir, FAKE_PNG: Buffer.concat([PNG, Buffer.from('shot')]).toString('base64') }),
      user: () => settings.data.user,
      redact: (text) => text,
      engineInfo: () => {},
      notify: () => {},
    });
    realtime.on('message', (message) => {
      if (message.t === 'turn.run') void runner.run(message.turn, message.chat, message.prompt);
    });
    cleanups.push(async () => {
      runner.cancelAll();
      await until(() => !runner.busy(), 5000).catch(() => {});
      realtime.disconnect();
      await h.close();
      await rm(dir, { recursive: true, force: true });
    });
    const ready = new Promise((resolve) => realtime.once('ready', resolve));
    realtime.connect({ serverUrl: h.base, token: leo.token, deviceId: settings.data.deviceId, deviceName: 'Leo Mac', appVersion: 'test' });
    await ready;
    return { chat: created, deviceId: settings.data.deviceId };
  }

  const upload = async (chatId: string, files: [string, Buffer][]) => store.uploadStaged(chatId, await Promise.all(files.map(([name, data]) => store.stage(name, data).then((file) => file.id))));
  const send = async (chatId: string, deviceId: string, text: string, attachments: AttachmentRef[], parallel = false) =>
    (await api<SendMessageResponse>(h.base, `/api/chats/${chatId}/messages`, { token: leo.token, body: { text, deviceId, config: { engine: 'codex', profileId: 'codex-1', model: null, permissionMode: 'default' }, attachments: attachments.map((file) => file.id), ...(parallel ? { parallel: true } : {}) } })).body.turn;
  const runs = async (): Promise<Run[]> => (existsSync(join(dir, 'log.jsonl')) ? (await readFile(join(dir, 'log.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Run) : []);
  const runOf = async (part: string) => {
    await until(async () => (await runs()).some((run) => run.request.includes(part)));
    return (await runs()).find((run) => run.request.includes(part))!;
  };
  const ended = (chatId: string, turn: TurnInfo) => until(async () => ['done', 'failed', 'cancelled'].includes((await api<TurnInfo[]>(h.base, `/api/chats/${chatId}/turns`, { token: leo.token })).body.find((entry) => entry.id === turn.id)?.status ?? ''));

  it('gives every turn running at once its own files: images natively, everything by path', async () => {
    const { chat, deviceId } = await setUp(async (user) => (await api<ChatSummary>(h.base, '/api/chats', { token: user.token, body: { title: 'Solo', kind: 'private' } })).body);
    const [image, pdf] = await upload(chat.id, [['pantalla.png', PNG], ['informe.pdf', PDF]]);
    const first = await send(chat.id, deviceId, 'revisá el diseño WAIT:one', [image, pdf], true);
    const one = await runOf('revisá el diseño');
    const copy = join(one.cwd, '.cooprompt', 'attachments', image.id, 'pantalla.png');
    expect(one.images).toEqual([copy]);
    expect((await readFile(copy)).equals(PNG)).toBe(true);
    expect(one.request).toContain(`Attached files, saved in the working folder:\n- .cooprompt/attachments/${image.id}/pantalla.png (image/png, 73 B)\n- .cooprompt/attachments/${pdf.id}/informe.pdf (application/pdf, ${PDF.length} B)`);
    expect(one.request).not.toContain('📎');

    const [other] = await upload(chat.id, [['otra.png', Buffer.concat([PNG, Buffer.from([1])])]]);
    const second = await send(chat.id, deviceId, '¿y esta?', [other], true);
    const two = await runOf('¿y esta?');
    expect(two.images).toEqual([join(two.cwd, '.cooprompt', 'attachments', other.id, 'otra.png')]);
    expect(two.prompt).toContain('[Leo]: revisá el diseño WAIT:one (files: pantalla.png, informe.pdf)');
    await ended(chat.id, second);
    await writeFile(join(dir, 'one'), '');
    await ended(chat.id, first);
  });

  it("tells the agent about another participant's files, with this Mac's copy", async () => {
    let ana!: AuthResponse;
    const { chat, deviceId } = await setUp(async (user) => {
      ana = await register(h.base, 'ana@acme.com', 'Ana');
      const created = (await api<ChatSummary>(h.base, '/api/chats', { token: user.token, body: { title: 'Diseño', kind: 'multiplayer' } })).body;
      const invitation = (await api(h.base, `/api/chats/${created.id}/invitations`, { token: user.token, body: { userId: ana.user.id } })).body;
      await api(h.base, `/api/invitations/${invitation.id}/accept`, { token: ana.token, body: {} });
      return created;
    });
    const anaSocket = await TestSocket.connect(h.base, ana.token, 'ana-device-0001');
    cleanups.unshift(async () => anaSocket.close());
    const anaFiles = new AttachmentStore({ api: new ApiClient(() => h.base, () => ana.token), cacheDir: join(dir, 'ana-cache'), stagingDir: join(dir, 'ana-staged'), log: () => {} });
    const [mock] = await anaFiles.uploadStaged(chat.id, [(await anaFiles.stage('maqueta.png', PNG)).id]);
    await api(h.base, `/api/chats/${chat.id}/messages`, { token: ana.token, body: { text: 'así lo quiero', deviceId: 'ana-device-0001', config: { engine: 'codex', profileId: 'x', model: null, permissionMode: 'default' }, attachments: [mock.id] } });
    const anaTurn = await anaSocket.waitFor<'turn.run'>((message) => message.t === 'turn.run');
    anaSocket.send({ t: 'turn.finish', turnId: anaTurn.turn.id, status: 'done' });

    await ended(chat.id, await send(chat.id, deviceId, 'hacelo', []));
    const run = await runOf('hacelo');
    expect(run.prompt).toContain(`[Ana]: así lo quiero (files: maqueta.png at .cooprompt/attachments/${mock.id}/maqueta.png)`);
    expect((await readFile(join(run.cwd, '.cooprompt', 'attachments', mock.id, 'maqueta.png'))).equals(PNG)).toBe(true);
    expect(run.prompt).not.toContain(PNG.toString('base64'));
  });

  it('shares a media file the answer points to, for everyone in the chat', async () => {
    const { chat, deviceId } = await setUp(async (user) => (await api<ChatSummary>(h.base, '/api/chats', { token: user.token, body: { title: 'Solo', kind: 'private' } })).body);
    await ended(chat.id, await send(chat.id, deviceId, 'sacá una captura SCREENSHOT', []));
    const items = (await api<TranscriptItem[]>(h.base, `/api/chats/${chat.id}/items`, { token: leo.token })).body;
    const [announced, answer] = items.filter((entry) => entry.kind === 'text').map((entry) => entry.data as TextItemData);
    expect(announced.attachments).toBeUndefined();
    expect(answer.text).toBe('Guardé la captura en `shots/out.png`.');
    expect(answer.attachments).toEqual([expect.objectContaining({ name: 'out.png', kind: 'image', mime: 'image/png' })]);
    const fetched = await api<ArrayBuffer>(h.base, `/api/chats/${chat.id}/attachments/${answer.attachments![0].id}`, { token: leo.token });
    expect(Buffer.from(fetched.body).equals(Buffer.concat([PNG, Buffer.from('shot')]))).toBe(true);
  });
});
