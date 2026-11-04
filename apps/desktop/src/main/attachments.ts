import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AttachmentLimits, AttachmentRef, HealthResponse } from '@cooprompt/protocol';
import { attachmentName, sanitizeFileName, sniffMedia } from '@cooprompt/protocol';
import { formatBytes, type StagedAttachment } from '../shared/attachments.ts';
import { translateMessage } from '../shared/i18n.ts';
import type { EngineAttachment, EngineMedia } from './engines/types.ts';
import { language, tr } from './i18n.ts';
import type { ApiClient } from './net/api.ts';

/** Where engines find a chat's files, inside its working folder. Neither the workspace sync nor git picks it up. */
export const ATTACHMENTS_DIR = '.cooprompt/attachments';
const SNIFF_BYTES = 4096;
/** Media an agent turn can share, besides the server's per-message byte limit. */
const MAX_SHARED_PER_TURN = 20;
const SEGMENT = /^[A-Za-z0-9_-]{1,100}$/;
const UNSUPPORTED = "This team server doesn't accept attachments yet: whoever hosts it needs to update CooPrompt.";

class AttachmentError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface StagedFile extends StagedAttachment {
  path: string;
  /** Uploads per chat, so a send that failed after uploading doesn't upload again. */
  uploads: Map<string, AttachmentRef>;
}

export interface AttachmentStoreDeps {
  api: ApiClient;
  /** Downloaded and sent files: `<chat>/<attachment>/<name>`. */
  cacheDir: string;
  /** Files chosen in the composer and not sent yet. */
  stagingDir: string;
  log(message: string): void;
}

async function readHead(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const isFile = (path: string) => lstat(path).then((info) => info.isFile(), () => false);

function segment(value: string): string {
  if (!SEGMENT.test(value)) throw new AttachmentError(404, tr('File not found'));
  return value;
}

/** `filename*=UTF-8''…` (or the ASCII `filename`) of a Content-Disposition header. */
function dispositionName(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // fall back to the plain name
    }
  }
  return /filename="([^"]*)"/i.exec(header)?.[1] ?? null;
}

/** Files that could run code get the quarantine flag, so macOS asks before opening them, as with a browser download. */
export function quarantine(path: string): void {
  if (process.platform !== 'darwin') return;
  execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0081;${Math.floor(Date.now() / 1000).toString(16)};CooPrompt;`, path], () => {});
}

/** Never an active document: the renderer only gets media, with the type its bytes show, and seeking needs ranges. */
async function mediaResponse(path: string, mime: string, range: string | null): Promise<Response> {
  const { size } = await stat(path);
  const headers: Record<string, string> = {
    'content-type': mime,
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'cache-control': 'no-cache',
  };
  const body = (start?: number, end?: number) => Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream<Uint8Array>;
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
    return new Response(body(start, end), { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } });
  }
  return new Response(body(), { status: 200, headers: { ...headers, 'content-length': String(size) } });
}

/** This computer's side of attachments: what the composer stages, what was sent or downloaded, and the copies engines get. */
export class AttachmentStore {
  private readonly deps: AttachmentStoreDeps;
  private readonly staged = new Map<string, StagedFile>();
  private readonly downloads = new Map<string, Promise<string>>();
  private limitsCache: { at: number; base: string; value: Promise<AttachmentLimits | null> } | null = null;
  /** Whatever a previous run staged and never sent goes first. */
  private readonly cleared: Promise<void>;

  constructor(deps: AttachmentStoreDeps) {
    this.deps = deps;
    this.cleared = rm(deps.stagingDir, { recursive: true, force: true }).catch(() => {});
  }

  /** What the server accepts, asked again after a minute; null when it predates attachments. */
  limits(): Promise<AttachmentLimits | null> {
    let base: string;
    try {
      base = this.deps.api.base();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.limitsCache && this.limitsCache.base === base && Date.now() - this.limitsCache.at < 60_000) return this.limitsCache.value;
    const value = this.deps.api.request<HealthResponse>('GET', '/api/health', undefined, { auth: false }).then((health) => health.attachments ?? null);
    const cache = { at: Date.now(), base, value };
    this.limitsCache = cache;
    value.catch(() => {
      if (this.limitsCache === cache) this.limitsCache = null;
    });
    return value;
  }

  private async requireLimits(): Promise<AttachmentLimits> {
    const limits = await this.limits();
    if (!limits) throw new Error(tr(UNSUPPORTED));
    return limits;
  }

  async stage(name: string, data: Uint8Array): Promise<StagedAttachment> {
    const limits = await this.requireLimits();
    const shown = sanitizeFileName(name);
    if (data.byteLength === 0) throw new Error(tr('{name} is empty', { name: shown }));
    if (data.byteLength > limits.maxFileBytes) throw new Error(tr('{name} is larger than {size}', { name: shown, size: formatBytes(limits.maxFileBytes) }));
    const { mime, kind } = sniffMedia(data.subarray(0, SNIFF_BYTES), name);
    const id = randomUUID();
    const path = join(this.deps.stagingDir, id);
    await this.cleared;
    await mkdir(this.deps.stagingDir, { recursive: true });
    await writeFile(path, data, { mode: 0o600 });
    const file: StagedFile = { id, name: attachmentName(name, mime), mime, kind, size: data.byteLength, path, uploads: new Map() };
    this.staged.set(id, file);
    return { id, name: file.name, mime, kind, size: file.size };
  }

  discard(id: string): void {
    const file = this.staged.get(id);
    if (!file) return;
    this.staged.delete(id);
    void rm(file.path, { force: true });
  }

  private request(method: string, path: string, body?: Uint8Array): Promise<Response> {
    return this.deps.api.raw(method, path, body).catch((error: unknown) => {
      throw new AttachmentError(502, tr('Could not connect to the server ({error})', { error: error instanceof Error ? error.message : String(error) }));
    });
  }

  /** Uploads the files of a message, in order, checking the server's limits first. */
  async uploadStaged(chatId: string, ids: string[]): Promise<AttachmentRef[]> {
    const limits = await this.requireLimits();
    const files = ids.map((id) => this.staged.get(id));
    if (files.some((file) => !file)) throw new Error(tr('An attachment is missing: attach the file again'));
    const present = files as StagedFile[];
    if (present.length > limits.maxFiles) throw new Error(tr('A message can carry up to {count} files', { count: limits.maxFiles }));
    if (present.reduce((sum, file) => sum + file.size, 0) > limits.maxMessageBytes) {
      throw new Error(tr('The files of a message can add up to {size}', { size: formatBytes(limits.maxMessageBytes) }));
    }
    const refs: AttachmentRef[] = [];
    for (const file of present) {
      let ref = file.uploads.get(chatId);
      if (!ref) {
        ref = await this.upload(chatId, file.name, await readFile(file.path));
        file.uploads.set(chatId, ref);
      }
      refs.push(ref);
    }
    return refs;
  }

  /** Once the message is sent, its files become this computer's copies, so they are never downloaded again. */
  async commit(chatId: string, ids: string[]): Promise<void> {
    for (const id of ids) {
      const file = this.staged.get(id);
      if (!file) continue;
      this.staged.delete(id);
      const ref = file.uploads.get(chatId);
      try {
        if (ref) {
          const target = this.cachePath(chatId, ref);
          await mkdir(dirname(target), { recursive: true });
          await rename(file.path, target);
        }
      } catch (error) {
        this.deps.log(`could not keep ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await rm(file.path, { force: true });
      }
    }
  }

  private async upload(chatId: string, name: string, data: Uint8Array): Promise<AttachmentRef> {
    const response = await this.request('POST', `/api/chats/${segment(chatId)}/attachments?name=${encodeURIComponent(name)}`, data);
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok) return payload as unknown as AttachmentRef;
    if (response.status === 404 && String(payload.message ?? '').startsWith('Route ')) {
      this.limitsCache = null;
      throw new Error(tr(UNSUPPORTED));
    }
    throw new Error(typeof payload.error === 'string' ? translateMessage(language(), payload.error) : tr('Could not upload {path} ({status})', { path: name, status: response.status }));
  }

  private cachePath(chatId: string, ref: Pick<AttachmentRef, 'id' | 'name'>): string {
    return join(this.deps.cacheDir, segment(chatId), segment(ref.id), sanitizeFileName(ref.name));
  }

  private async cached(chatId: string, id: string): Promise<string | null> {
    const dir = join(this.deps.cacheDir, segment(chatId), segment(id));
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) if (!name.startsWith('.') && (await isFile(join(dir, name)))) return join(dir, name);
    return null;
  }

  /**
   * This computer's copy of an attachment, downloaded the first time and checked against its hash. The name comes from
   * the transcript when the caller has it, otherwise from the server, and is sanitized either way.
   */
  file(chatId: string, id: string, known?: Pick<AttachmentRef, 'name' | 'sha256'>): Promise<string> {
    const key = `${segment(chatId)}/${segment(id)}`;
    const pending = this.downloads.get(key);
    if (pending) return pending;
    const task = (async () => {
      const existing = await this.cached(chatId, id);
      if (existing) return existing;
      const response = await this.request('GET', `/api/chats/${chatId}/attachments/${id}`);
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new AttachmentError(response.status, tr('Could not download {path} ({status})', { path: known?.name ?? id, status: response.status }));
      }
      const name = known?.name ?? dispositionName(response.headers.get('content-disposition')) ?? id;
      const expected = known?.sha256 ?? (response.headers.get('etag') ?? '').replace(/"/g, '');
      const target = this.cachePath(chatId, { id, name });
      await mkdir(dirname(target), { recursive: true });
      const tmp = join(dirname(target), `.download-${randomUUID()}`);
      const hash = createHash('sha256');
      try {
        const hasher = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(response.body as never), hasher, createWriteStream(tmp, { mode: 0o600 }));
        if (expected && hash.digest('hex') !== expected) throw new AttachmentError(502, tr('Corrupted download of {path}', { path: name }));
        await rename(tmp, target);
      } finally {
        await rm(tmp, { force: true });
      }
      if (sniffMedia(await readHead(target), target).kind === 'file') quarantine(target);
      return target;
    })().finally(() => this.downloads.delete(key));
    this.downloads.set(key, task);
    return task;
  }

  /** A copy safe to hand to the computer's default app: media whose bytes match its extension, never a possible program. */
  async openable(chatId: string, id: string): Promise<string> {
    const path = await this.file(chatId, id);
    const { mime, kind } = sniffMedia(await readHead(path), path);
    if (kind === 'file' || mime === 'image/svg+xml' || attachmentName(basename(path), mime) !== basename(path)) {
      throw new Error(tr('CooPrompt only opens images, PDFs, audio and video. Use Show in folder for other files.'));
    }
    return path;
  }

  /**
   * Copies of attachments inside a working folder, where every engine can open them with its own tools. The copies
   * are APFS clones when possible, and the folder is never followed through a symbolic link.
   */
  async materialize(chatId: string, cwd: string, refs: AttachmentRef[]): Promise<(EngineAttachment & { id: string })[]> {
    const copies: (EngineAttachment & { id: string })[] = [];
    for (const ref of refs) {
      try {
        const source = await this.file(chatId, ref.id, ref);
        const dir = join(cwd, ATTACHMENTS_DIR, segment(ref.id));
        await this.prepareFolder(cwd, dir);
        const target = join(dir, sanitizeFileName(ref.name));
        if (!(await isFile(target))) await copyFile(source, target, constants.COPYFILE_FICLONE);
        copies.push({ id: ref.id, name: ref.name, mime: ref.mime, kind: ref.kind, size: ref.size, path: target });
      } catch (error) {
        this.deps.log(`could not prepare ${ref.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return copies;
  }

  private async prepareFolder(cwd: string, dir: string): Promise<void> {
    let current = cwd;
    for (const part of [...ATTACHMENTS_DIR.split('/'), basename(dir)]) {
      current = join(current, part);
      const info = await lstat(current).catch(() => null);
      if (info?.isSymbolicLink()) throw new Error(`${current} is a symbolic link`);
      if (!info) await mkdir(current);
    }
    const ignore = join(cwd, '.cooprompt', '.gitignore');
    if (!(await isFile(ignore))) await writeFile(ignore, '*\n');
  }

  /**
   * Shares what an agent turn produced: media only, each file once (`skip` holds hashes the chat already has, such
   * as the prompt's), and at most 20 files and the server's per-message bytes per turn.
   */
  sharer(chatId: string, options: { skip?: string[]; rename?: (name: string) => string } = {}): (media: EngineMedia) => Promise<AttachmentRef | null> {
    const known = new Map<string, Promise<AttachmentRef | null>>((options.skip ?? []).map((hash) => [hash, Promise.resolve(null)]));
    let files = 0;
    let bytes = 0;
    return async (media) => {
      const limits = await this.limits().catch(() => null);
      if (!limits) return null;
      const file = await this.readMedia(media, limits.maxFileBytes);
      if (!file || sniffMedia(file.data.subarray(0, SNIFF_BYTES), file.name).kind === 'file') return null;
      const hash = createHash('sha256').update(file.data).digest('hex');
      const seen = known.get(hash);
      if (seen) return seen;
      if (files >= MAX_SHARED_PER_TURN || bytes + file.data.byteLength > limits.maxMessageBytes) return null;
      files++;
      bytes += file.data.byteLength;
      const task = (async () => {
        const ref = await this.upload(chatId, options.rename ? options.rename(file.name) : file.name, file.data);
        const target = this.cachePath(chatId, ref);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.data, { mode: 0o600 });
        return ref;
      })().catch((error) => {
        this.deps.log(`could not share ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      known.set(hash, task);
      return task;
    };
  }

  private async readMedia(media: EngineMedia, max: number): Promise<{ name: string; data: Uint8Array } | null> {
    if ('data' in media) return media.data.byteLength > 0 && media.data.byteLength <= max ? { name: media.name, data: media.data } : null;
    const info = await lstat(media.path).catch(() => null);
    if (!info?.isFile() || info.size === 0 || info.size > max) return null;
    return { name: basename(media.path), data: await readFile(media.path) };
  }

  /** A deleted chat takes along this computer's copies: the cache and the ones in its working folder. */
  async purgeChat(chatId: string, folder: string | null): Promise<void> {
    if (!SEGMENT.test(chatId)) return;
    await rm(join(this.deps.cacheDir, chatId), { recursive: true, force: true });
    if (!folder) return;
    const cooprompt = join(folder, '.cooprompt');
    const info = await lstat(cooprompt).catch(() => null);
    if (!info?.isDirectory()) return;
    await rm(join(folder, ATTACHMENTS_DIR), { recursive: true, force: true });
    const left = await readdir(cooprompt).catch(() => ['?']);
    if (left.every((name) => name === '.gitignore')) await rm(cooprompt, { recursive: true, force: true });
  }

  /** `cooprompt-media://staged/<id>` and `cooprompt-media://attachment/<chat>/<id>`, for the renderer's previews and players. */
  async serve(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      const staged = url.host === 'staged' && parts.length === 1 ? this.staged.get(parts[0]) : undefined;
      const path = staged ? staged.path : url.host === 'attachment' && parts.length === 2 ? await this.file(parts[0], parts[1]) : null;
      if (!path) return new Response(null, { status: 404 });
      const { mime, kind } = sniffMedia(await readHead(path), staged?.name ?? path);
      if (kind !== 'image' && kind !== 'audio' && kind !== 'video') return new Response(null, { status: 415 });
      return await mediaResponse(path, mime, request.headers.get('range'));
    } catch (error) {
      return new Response(null, { status: error instanceof AttachmentError ? error.status : 500 });
    }
  }
}
