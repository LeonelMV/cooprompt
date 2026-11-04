import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AttachmentKind, AttachmentLimits, AttachmentRef } from '@cooprompt/protocol';
import { attachmentName, sniffMedia } from '@cooprompt/protocol';
import { HttpError } from './errors.ts';
import type { ChatRow, Store, UserRecord } from './store.ts';

/** 50 MB a file keeps uploads well under the 100 MB a Cloudflare tunnel accepts per request. */
export const ATTACHMENT_LIMITS: AttachmentLimits = { maxFileBytes: 50 * 1024 * 1024, maxFiles: 10, maxMessageBytes: 100 * 1024 * 1024 };
/** Uploads that no message or agent output points to (a send that failed afterwards, say) go after a day. */
const ORPHAN_MS = 24 * 60 * 60_000;
const SNIFF_BYTES = 4096;
const ID_PATTERN = /^[0-9a-f-]{36}$/;

interface AttachmentRow {
  id: string;
  chat_id: string;
  hash: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  created_by: string;
  created_at: number;
  linked_at: number | null;
}

const toRef = (row: AttachmentRow): AttachmentRef => ({ id: row.id, name: row.name, mime: row.mime, kind: row.kind, size: row.size, sha256: row.hash });

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

function findRow(store: Store, chatId: string, id: unknown): AttachmentRow | undefined {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return undefined;
  return store.db.get<AttachmentRow>('select * from attachments where id = ? and chat_id = ?', id, chatId);
}

function link(store: Store, ids: string[]): void {
  const now = Date.now();
  for (const id of ids) store.db.run('update attachments set linked_at = ? where id = ? and linked_at is null', now, id);
}

/** Media the client may show are `inline`, the rest `attachment`; an ASCII name for old clients and the UTF-8 one. */
function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Executors point their items at what they uploaded. Only this chat's attachments are kept, described by the
 * server's own record of them, so an item can't claim another chat's file or a different name or type.
 */
export function withServerAttachments(store: Store, chatId: string, data: unknown): unknown {
  if (!data || typeof data !== 'object' || !('attachments' in data)) return data;
  const claimed = (data as { attachments?: unknown }).attachments;
  const ids = Array.isArray(claimed) ? claimed.slice(0, 50).map((entry) => (entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : null)) : [];
  const rows = [...new Set(ids)].map((id) => findRow(store, chatId, id)).filter((row): row is AttachmentRow => row !== undefined);
  link(store, rows.map((row) => row.id));
  return { ...data, attachments: rows.map(toRef) };
}

/** Files shared in chats: content-addressed blobs on disk, one row per upload, visible to the chat's members only. */
export class Attachments {
  readonly limits = ATTACHMENT_LIMITS;
  private readonly store: Store;
  private readonly dir: string;
  private readonly tmpDir: string;
  private readonly log: (message: string) => void;
  private readonly sweeper: NodeJS.Timeout;
  /** Storing and removing blobs never interleave, so a removal can't take a blob an upload just reused. */
  private blobs: Promise<unknown> = Promise.resolve();

  constructor(store: Store, dataDir: string, log: (message: string) => void) {
    this.store = store;
    this.dir = join(dataDir, 'attachments');
    this.tmpDir = join(dataDir, 'tmp');
    this.log = log;
    this.sweeper = setInterval(() => void this.sweep(), 60 * 60_000);
    this.sweeper.unref();
    void this.sweep();
  }

  close(): void {
    clearInterval(this.sweeper);
  }

  private blobPath(hash: string): string {
    return join(this.dir, hash.slice(0, 2), hash);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.blobs.then(fn, fn);
    this.blobs = next.catch(() => {});
    return next;
  }

  register(app: FastifyInstance): void {
    const member = (request: FastifyRequest): { user: UserRecord; chat: ChatRow } => {
      const header = request.headers.authorization;
      const user = header?.startsWith('Bearer ') ? this.store.getUserByToken(header.slice(7)) : undefined;
      if (!user) throw new HttpError(401, 'Your session is invalid or expired');
      const chat = this.store.getChat((request.params as { id: string }).id);
      if (!chat || !this.store.canView(chat, user)) throw new HttpError(404, 'Chat not found or not accessible');
      if (!this.store.isMember(chat.id, user.id)) throw new HttpError(403, 'Join the chat to do this');
      return { user, chat };
    };

    // The body is the file itself (application/octet-stream, parsed as a stream in files.ts); `name` travels in the query.
    app.post('/api/chats/:id/attachments', async (request): Promise<AttachmentRef> => {
      const { user, chat } = member(request);
      const max = this.limits.maxFileBytes;
      const tooLarge = () => new HttpError(413, `Attachments can be up to ${megabytes(max)}`);
      if (Number(request.headers['content-length'] ?? 0) > max) throw tooLarge();
      const body = request.body as Readable | undefined;
      if (!body || typeof body.pipe !== 'function') throw new HttpError(400, 'The file is empty');
      const requested = String((request.query as { name?: string }).name ?? '');
      await mkdir(this.tmpDir, { recursive: true });
      const tmp = join(this.tmpDir, randomUUID());
      const hasher = createHash('sha256');
      const head: Buffer[] = [];
      let size = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (size < SNIFF_BYTES) head.push(chunk.subarray(0, SNIFF_BYTES - size));
          size += chunk.length;
          if (size > max) return callback(tooLarge());
          hasher.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(body, counter, createWriteStream(tmp));
        if (size === 0) throw new HttpError(400, 'The file is empty');
        const hash = hasher.digest('hex');
        const { mime, kind } = sniffMedia(Buffer.concat(head), requested);
        const row: AttachmentRow = {
          id: randomUUID(),
          chat_id: chat.id,
          hash,
          name: attachmentName(requested, mime),
          mime,
          kind,
          size,
          created_by: user.id,
          created_at: Date.now(),
          linked_at: null,
        };
        await this.exclusive(async () => {
          const target = this.blobPath(hash);
          await mkdir(join(this.dir, hash.slice(0, 2)), { recursive: true });
          if (!(await stat(target).then(() => true, () => false))) await rename(tmp, target);
          this.store.db.run(
            'insert into attachments (id, chat_id, hash, name, mime, kind, size, created_by, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            row.id,
            row.chat_id,
            row.hash,
            row.name,
            row.mime,
            row.kind,
            row.size,
            row.created_by,
            row.created_at,
          );
        });
        return toRef(row);
      } finally {
        await rm(tmp, { force: true });
      }
    });

    app.get('/api/chats/:id/attachments/:attachmentId', async (request, reply) => {
      const { chat } = member(request);
      const row = findRow(this.store, chat.id, (request.params as { attachmentId: string }).attachmentId);
      const info = row ? await stat(this.blobPath(row.hash)).catch(() => null) : null;
      if (!row || !info) throw new HttpError(404, 'File not found');
      // Never an active document: plain files are octet streams, and SVG (which can carry scripts) downloads.
      const shown = row.kind !== 'file' && row.mime !== 'image/svg+xml';
      reply.header('content-type', row.kind === 'file' ? 'application/octet-stream' : row.mime);
      reply.header('content-length', String(info.size));
      reply.header('content-disposition', contentDisposition(shown ? 'inline' : 'attachment', row.name));
      reply.header('x-content-type-options', 'nosniff');
      reply.header('content-security-policy', "default-src 'none'; sandbox");
      reply.header('cache-control', 'private, max-age=31536000, immutable');
      reply.header('etag', `"${row.hash}"`);
      return reply.send(createReadStream(this.blobPath(row.hash)));
    });
  }

  /** What a message carries, in the sender's order: their own uploads to this chat, within the limits. */
  forMessage(chatId: string, userId: string, ids: unknown): AttachmentRef[] {
    if (ids === undefined || ids === null) return [];
    if (!Array.isArray(ids)) throw new HttpError(400, 'Invalid attachments');
    const unique = [...new Set(ids)];
    if (unique.length > this.limits.maxFiles) throw new HttpError(400, `A message can carry up to ${this.limits.maxFiles} files`);
    const rows = unique.map((id) => findRow(this.store, chatId, id));
    if (rows.some((row) => !row || row.created_by !== userId)) throw new HttpError(400, 'An attachment is missing: attach the file again');
    const present = rows as AttachmentRow[];
    if (present.reduce((sum, row) => sum + row.size, 0) > this.limits.maxMessageBytes) {
      throw new HttpError(413, `The files of a message can add up to ${megabytes(this.limits.maxMessageBytes)}`);
    }
    link(this.store, present.map((row) => row.id));
    return present.map(toRef);
  }

  /** A deleted chat takes its attachments along, and the blobs no other chat uses. */
  purgeChat(chatId: string): Promise<void> {
    const hashes = this.store.db.all<{ hash: string }>('select distinct hash from attachments where chat_id = ?', chatId).map((row) => row.hash);
    this.store.db.run('delete from attachments where chat_id = ?', chatId);
    return this.removeUnused(hashes);
  }

  async sweep(): Promise<void> {
    try {
      const cutoff = Date.now() - ORPHAN_MS;
      const hashes = this.store.db.all<{ hash: string }>('select distinct hash from attachments where linked_at is null and created_at < ?', cutoff).map((row) => row.hash);
      if (hashes.length === 0) return;
      this.store.db.run('delete from attachments where linked_at is null and created_at < ?', cutoff);
      await this.removeUnused(hashes);
    } catch (error) {
      this.log(`attachments: sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private removeUnused(hashes: string[]): Promise<void> {
    return this.exclusive(async () => {
      for (const hash of hashes) {
        if (this.store.db.get('select 1 as ok from attachments where hash = ? limit 1', hash)) continue;
        await rm(this.blobPath(hash), { force: true });
      }
    });
  }
}
