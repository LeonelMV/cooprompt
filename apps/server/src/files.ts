import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ChangesResponse } from '@cooprompt/protocol';
import { normalizeWorkspacePath } from '@cooprompt/protocol';
import { HttpError } from './errors.ts';
import type { Hub } from './hub.ts';
import type { Store } from './store.ts';

export const MAX_FILE_BYTES = 512 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

type Query = Record<string, string | undefined>;

export function registerFileRoutes(app: FastifyInstance, input: { store: Store; hub: Hub; dataDir: string }): void {
  const { store, hub } = input;
  const blobDir = join(input.dataDir, 'blobs');
  const tmpDir = join(input.dataDir, 'tmp');
  const blobPath = (hash: string) => join(blobDir, hash.slice(0, 2), hash);

  app.addContentTypeParser('application/octet-stream', { bodyLimit: MAX_FILE_BYTES }, (_request, payload, done) => done(null, payload));

  const memberChat = (request: FastifyRequest) => {
    const header = request.headers.authorization;
    const user = header?.startsWith('Bearer ') ? store.getUserByToken(header.slice(7)) : undefined;
    if (!user) throw new HttpError(401, 'Your session is invalid or expired');
    const chatId = (request.params as { id: string }).id;
    const chat = store.getChat(chatId);
    if (!chat || !store.isMember(chatId, user.id)) throw new HttpError(404, 'Workspace not found or not accessible');
    if (chat.kind === 'private') throw new HttpError(400, 'Private chats have no shared workspace');
    return { user, chat };
  };

  const pathParam = (query: Query): string => {
    const path = normalizeWorkspacePath(query.path ?? '');
    if (!path) throw new HttpError(400, 'Invalid path');
    return path;
  };

  app.get('/api/chats/:id/fs/changes', async (request): Promise<ChangesResponse> => {
    const { chat } = memberChat(request);
    const query = request.query as Query;
    const since = Math.max(0, Number(query.since ?? 0) || 0);
    const limit = Math.min(Math.max(Number(query.limit ?? 2000) || 2000, 1), 5000);
    const entries = store.fileChanges(chat.id, since, limit + 1);
    return { seq: store.workspaceSeq(chat.id), entries: entries.slice(0, limit), hasMore: entries.length > limit };
  });

  app.put('/api/chats/:id/fs/file', async (request, reply) => {
    const { user, chat } = memberChat(request);
    const query = request.query as Query;
    const path = pathParam(query);
    const base = query.base ?? '';
    const exec = query.exec === '1';
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, randomUUID());
    const hasher = createHash('sha256');
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        hasher.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(request.body as Readable, counter, createWriteStream(tmp));
      const hash = hasher.digest('hex');
      const current = store.getFile(chat.id, path);
      const currentHash = current?.hash ?? '';
      if (currentHash === hash && current?.exec === exec) return current;
      if (currentHash !== base && currentHash !== hash) {
        reply.code(409);
        return { error: 'conflict', current: current ?? null };
      }
      const target = blobPath(hash);
      await mkdir(join(blobDir, hash.slice(0, 2)), { recursive: true });
      const exists = await stat(target).then(
        () => true,
        () => false,
      );
      if (!exists) await rename(tmp, target);
      const entry = store.writeFileEntry(chat.id, path, { hash, size, exec }, user.id);
      hub.notifyFiles(chat.id, [entry]);
      return entry;
    } finally {
      await rm(tmp, { force: true });
    }
  });

  app.delete('/api/chats/:id/fs/file', async (request, reply) => {
    const { user, chat } = memberChat(request);
    const query = request.query as Query;
    const path = pathParam(query);
    const current = store.getFile(chat.id, path);
    if (!current || current.hash === null) return current ?? { ok: true };
    if (current.hash !== (query.base ?? '')) {
      reply.code(409);
      return { error: 'conflict', current };
    }
    const entry = store.writeFileEntry(chat.id, path, { hash: null, size: 0, exec: false }, user.id);
    hub.notifyFiles(chat.id, [entry]);
    return entry;
  });

  app.get('/api/chats/:id/fs/blob/:hash', async (request, reply) => {
    const { chat } = memberChat(request);
    const hash = (request.params as { hash: string }).hash;
    if (!HASH_PATTERN.test(hash) || !store.chatReferencesBlob(chat.id, hash)) throw new HttpError(404, 'File not found');
    const info = await stat(blobPath(hash)).catch(() => null);
    if (!info) throw new HttpError(404, 'File not found');
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', String(info.size));
    return reply.send(createReadStream(blobPath(hash)));
  });
}
