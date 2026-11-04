import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatSummary } from '@cooprompt/protocol';
import { api, register, startServer, TestSocket, type Harness } from '../../server/test/helpers.ts';
import { ApiClient } from '../src/main/net/api.ts';
import { WorkspaceSync } from '../src/main/sync/workspace-sync.ts';

const until = async (check: () => Promise<boolean> | boolean, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condición no alcanzada a tiempo');
};

const read = (path: string) => readFile(path, 'utf8').catch(() => null);

describe('shared workspace sync', () => {
  let h: Harness;
  let dir: string;
  const cleanups: (() => Promise<void> | void)[] = [];

  beforeEach(async () => {
    h = await startServer();
    dir = await mkdtemp(join(tmpdir(), 'cooprompt-sync-'));
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function participants() {
    const leo = await register(h.base, 'leo@acme.com', 'Leo');
    const ana = await register(h.base, 'ana@acme.com', 'Ana');
    const chat = (await api<ChatSummary>(h.base, '/api/chats', { token: leo.token, body: { title: 'Repo', kind: 'multiplayer' } })).body;
    const invitation = (await api(h.base, `/api/chats/${chat.id}/invitations`, { token: leo.token, body: { userId: ana.user.id } })).body;
    await api(h.base, `/api/invitations/${invitation.id}/accept`, { token: ana.token, body: {} });
    const make = async (name: string, token: string) => {
      const sync = new WorkspaceSync({
        api: new ApiClient(() => h.base, () => token),
        chatId: chat.id,
        root: join(dir, name),
        statePath: join(dir, `${name}-state.json`),
        deviceName: name,
        onStatus: () => {},
        log: () => {},
      });
      const socket = await TestSocket.connect(h.base, token, `${name}-device-0001`);
      const poll = setInterval(() => {
        if (socket.messages.some((message) => message.t === 'fs.change')) {
          socket.clear();
          sync.onRemoteChange();
        }
      }, 25);
      cleanups.push(async () => {
        clearInterval(poll);
        socket.close();
        await sync.stop();
      });
      return sync;
    };
    return { chat, make, leoToken: leo.token, anaToken: ana.token };
  }

  it('mirrors creations, edits, exec bits and deletions while keeping ignored files local', async () => {
    const { make, leoToken, anaToken } = await participants();
    const a = await make('a', leoToken);
    await a.start();
    await mkdir(join(a.root, 'src/lib'), { recursive: true });
    await writeFile(join(a.root, 'src/lib/util.ts'), 'export const x = 1;\n');
    await writeFile(join(a.root, 'run.sh'), '#!/bin/sh\necho hola\n');
    await chmod(join(a.root, 'run.sh'), 0o755);
    await writeFile(join(a.root, '.gitignore'), '.env\ndist/\n');
    await writeFile(join(a.root, '.env'), 'API_KEY=secreta\n');
    await mkdir(join(a.root, 'node_modules/pkg'), { recursive: true });
    await writeFile(join(a.root, 'node_modules/pkg/index.js'), 'module.exports = 1');
    await a.flush();

    const b = await make('b', anaToken);
    await b.start();
    await b.ensureCaughtUp();
    expect(await read(join(b.root, 'src/lib/util.ts'))).toBe('export const x = 1;\n');
    if (process.platform !== 'win32') expect(((await stat(join(b.root, 'run.sh'))).mode & 0o111) !== 0).toBe(true);
    expect(existsSync(join(b.root, '.env'))).toBe(false);
    expect(existsSync(join(b.root, 'node_modules'))).toBe(false);

    await writeFile(join(b.root, 'src/lib/util.ts'), 'export const x = 2;\n');
    await until(async () => (await read(join(a.root, 'src/lib/util.ts'))) === 'export const x = 2;\n');

    await rm(join(a.root, 'run.sh'));
    await until(() => !existsSync(join(b.root, 'run.sh')));
    expect(b.status().conflicts).toEqual([]);
  });

  it.skipIf(process.platform !== 'win32')('preserves a remote executable flag when a Windows device receives and edits the file', async () => {
    const { chat, make, leoToken } = await participants();
    const path = `/api/chats/${chat.id}/fs/file?path=run.sh&base=&exec=1`;
    expect((await api(h.base, path, { method: 'PUT', token: leoToken, raw: '#!/bin/sh\necho first\n' })).status).toBe(200);
    const device = await make('windows', leoToken);
    await device.start();
    await device.ensureCaughtUp();
    await device.flush();
    const entries = async () => (await api<{ entries: { path: string; exec: boolean }[] }>(h.base, `/api/chats/${chat.id}/fs/changes?since=0`, { token: leoToken })).body.entries;
    expect((await entries()).find((entry) => entry.path === 'run.sh')?.exec).toBe(true);
    await writeFile(join(device.root, 'run.sh'), '#!/bin/sh\necho edited\n');
    await device.flush();
    expect((await entries()).find((entry) => entry.path === 'run.sh')?.exec).toBe(true);
  });

  it('shares a git repository created on one machine with the other', async () => {
    const { make, leoToken, anaToken } = await participants();
    const a = await make('a', leoToken);
    const b = await make('b', anaToken);
    await a.start();
    await b.start();
    const repo = join(a.root, 'proyecto');
    await mkdir(repo, { recursive: true });
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Leo', GIT_AUTHOR_EMAIL: 'leo@acme.com', GIT_COMMITTER_NAME: 'Leo', GIT_COMMITTER_EMAIL: 'leo@acme.com' } }).toString();
    git(repo, 'init', '-q', '-b', 'main');
    await writeFile(join(repo, 'README.md'), '# Proyecto compartido\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'primer commit');
    await a.flush();
    await b.ensureCaughtUp();
    const bRepo = join(b.root, 'proyecto');
    await until(() => existsSync(join(bRepo, '.git/HEAD')) && existsSync(join(bRepo, 'README.md')));
    await b.ensureCaughtUp();
    expect(git(bRepo, 'log', '--format=%s').trim()).toBe('primer commit');
    expect(git(bRepo, 'status', '--porcelain').trim()).toBe('');
  });

  it('keeps both versions when two people edit the same file while one is offline', async () => {
    const { make, leoToken, anaToken } = await participants();
    const a = await make('a', leoToken);
    await a.start();
    await writeFile(join(a.root, 'notas.md'), 'base\n');
    await a.flush();
    const b = await make('b', anaToken);
    await b.start();
    await b.ensureCaughtUp();
    await b.stop();

    await writeFile(join(a.root, 'notas.md'), 'versión de Leo\n');
    await a.flush();
    await writeFile(join(b.root, 'notas.md'), 'versión de Ana\n');

    const b2 = await make('b', anaToken);
    await b2.start();
    await b2.flush();
    expect(await read(join(b2.root, 'notas.md'))).toBe('versión de Leo\n');
    const copies = (await readdir(b2.root)).filter((name) => name.includes('(conflict '));
    expect(copies).toHaveLength(1);
    expect(await read(join(b2.root, copies[0]))).toBe('versión de Ana\n');
    await until(() => existsSync(join(a.root, copies[0])));
  });

  it('never syncs symbolic links, whether they were there at start or appear while it runs', async () => {
    const { make, leoToken } = await participants();
    const a = await make('a', leoToken);
    await writeFile(join(dir, 'outside.txt'), 'fuera del workspace\n');
    await mkdir(join(dir, 'outside-dir'));
    await writeFile(join(dir, 'outside-dir', 'inner.txt'), 'también fuera\n');
    await mkdir(a.root, { recursive: true });
    await symlink(join(dir, process.platform === 'win32' ? 'outside-dir' : 'outside.txt'), join(a.root, 'at-start'), process.platform === 'win32' ? 'junction' : 'file');
    await a.start();
    await symlink(join(dir, process.platform === 'win32' ? 'outside-dir' : 'outside.txt'), join(a.root, 'while-running'), process.platform === 'win32' ? 'junction' : 'file');
    await symlink(join(dir, 'outside-dir'), join(a.root, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(a.root, 'real.txt'), 'archivo normal\n');
    const synced = async () => (await api<{ entries: { path: string }[] }>(h.base, `/api/chats/${a.chatId}/fs/changes?since=0`, { token: leoToken })).body.entries.map((entry) => entry.path);
    await until(async () => (await synced()).includes('real.txt'));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await a.flush();
    expect(await synced()).toEqual(['real.txt']);
  });

  it('does not write files from others through a local symbolic link', async () => {
    const { make, leoToken, anaToken } = await participants();
    const a = await make('a', leoToken);
    const b = await make('b', anaToken);
    await a.start();
    await b.start();
    await mkdir(join(dir, 'outside-dir'));
    await symlink(join(dir, 'outside-dir'), join(a.root, 'shared'), process.platform === 'win32' ? 'junction' : 'dir');
    await mkdir(join(b.root, 'shared'));
    await writeFile(join(b.root, 'shared', 'new.txt'), 'de Ana\n');
    await writeFile(join(b.root, 'marker.txt'), 'listo\n');
    await b.flush();
    await until(() => existsSync(join(a.root, 'marker.txt')));
    await a.ensureCaughtUp();
    expect(existsSync(join(dir, 'outside-dir', 'new.txt'))).toBe(false);
  });

  it('restores instead of deleting remotely when most of the folder vanished while closed', async () => {
    const { make, leoToken } = await participants();
    const a = await make('a', leoToken);
    await a.start();
    for (let index = 0; index < 30; index++) await writeFile(join(a.root, `f${index}.txt`), `archivo ${index}\n`);
    await a.flush();
    await a.stop();
    for (let index = 0; index < 30; index++) await rm(join(a.root, `f${index}.txt`));

    const again = await make('a', leoToken);
    await again.start();
    await again.flush();
    expect(await read(join(again.root, 'f7.txt'))).toBe('archivo 7\n');
    const changes = (await api(h.base, `/api/chats/${again.chatId}/fs/changes?since=0`, { token: leoToken })).body;
    expect(changes.entries.filter((entry: { hash: string | null }) => entry.hash === null)).toHaveLength(0);
  });
});
