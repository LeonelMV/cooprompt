import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, watch, type FSWatcher } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ChangesResponse, FileEntry } from '@cooprompt/protocol';
import type { SyncStatus } from '../../shared/types.ts';
import type { ApiClient } from '../net/api.ts';
import { IgnoreRules } from './ignore-rules.ts';
import { tr } from '../i18n.ts';

const MAX_SYNC_BYTES = 200 * 1024 * 1024;
const DEBOUNCE_MS = 300;
const NETWORK_CONCURRENCY = 6;

interface FileState {
  hash: string;
  size: number;
  mtimeMs: number;
  exec: boolean;
}

interface PersistedState {
  lastSeq: number;
  files: Record<string, FileState>;
}

interface LocalStat {
  exists: boolean;
  isFile: boolean;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  exec: boolean;
}

export interface WorkspaceSyncOptions {
  api: ApiClient;
  chatId: string;
  root: string;
  statePath: string;
  deviceName: string;
  onStatus(status: SyncStatus): void;
  log(message: string): void;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), async function* (source) {
    for await (const chunk of source) hash.update(chunk as Buffer);
  });
  return hash.digest('hex');
}

const LINKED: LocalStat = { exists: true, isFile: false, isDir: false, size: 0, mtimeMs: 0, exec: false };

/** Symbolic links are neither files nor folders here: like the folder scan, sync leaves them alone. */
async function localStat(path: string): Promise<LocalStat> {
  try {
    const info = await lstat(path);
    return { exists: true, isFile: info.isFile(), isDir: info.isDirectory(), size: info.size, mtimeMs: info.mtimeMs, exec: (info.mode & 0o111) !== 0 };
  } catch {
    return { exists: false, isFile: false, isDir: false, size: 0, mtimeMs: 0, exec: false };
  }
}

function conflictName(path: string, device: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
  const ext = extname(path);
  const base = ext ? path.slice(0, -ext.length) : path;
  return `${base} (conflict ${device.replace(/[/\\]/g, '-')} ${stamp})${ext}`;
}

class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/**
 * Two-way mirror between a local folder and a chat's shared workspace on the server.
 * The server keeps the latest version of every path plus a monotonic change sequence; each
 * client remembers the last version it saw per path, which makes conflicts detectable on both
 * sides: concurrent edits keep the server copy and preserve the local one as a conflict copy.
 */
export class WorkspaceSync {
  readonly chatId: string;
  readonly root: string;
  private readonly options: WorkspaceSyncOptions;
  private readonly ignore: IgnoreRules;
  private state: PersistedState = { lastSeq: 0, files: {} };
  private watcher: FSWatcher | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly network = new Semaphore(NETWORK_CONCURRENCY);
  private activeOps = 0;
  private pulling: Promise<void> | null = null;
  private pullAgain = false;
  private idleWaiters: (() => void)[] = [];
  private conflicts: string[] = [];
  private lastError: string | undefined;
  private paused = false;
  private started = false;
  private stopped = false;
  private lastSyncAt: number | undefined;
  private persistTimer: NodeJS.Timeout | null = null;
  private persisting: Promise<void> = Promise.resolve();
  private statusTimer: NodeJS.Timeout | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly warnedLarge = new Set<string>();

  constructor(options: WorkspaceSyncOptions) {
    this.options = options;
    this.chatId = options.chatId;
    this.root = options.root;
    this.ignore = new IgnoreRules(options.root);
  }

  async start(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    try {
      this.state = JSON.parse(await readFile(this.options.statePath, 'utf8')) as PersistedState;
    } catch {
      this.state = { lastSeq: 0, files: {} };
    }
    this.emitStatus();
    await this.guardMassDeletion();
    await this.pull();
    await this.scan();
    this.watch();
    this.scanTimer = setInterval(() => void this.scan().catch((error) => this.fail(error)), 60_000);
    this.started = true;
    this.emitStatus();
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const timer of [this.scanTimer, this.retryTimer, this.statusTimer, this.persistTimer]) if (timer) clearTimeout(timer);
    this.persistTimer = null;
    return this.persist();
  }

  /** Server announced changes; fetch them. */
  onRemoteChange(): void {
    void this.pull().catch((error) => this.fail(error));
  }

  /** Waits until every remote change is applied locally (before running a turn here). */
  async ensureCaughtUp(): Promise<void> {
    await this.pull();
    await this.idle();
  }

  /** Pushes every local change and waits for the uploads (after a turn finishes). */
  async flush(): Promise<void> {
    await this.scan();
    await this.idle();
  }

  async resync(): Promise<void> {
    this.paused = false;
    this.lastError = undefined;
    this.conflicts = [];
    this.state.lastSeq = 0;
    await this.pull();
    await this.scan();
    await this.idle();
  }

  status(): SyncStatus {
    const pending = this.activeOps + this.timers.size;
    return {
      chatId: this.chatId,
      root: this.root,
      state: this.paused ? 'paused' : this.lastError ? 'error' : !this.started ? 'starting' : pending > 0 || this.pulling ? 'syncing' : 'idle',
      pending,
      files: Object.keys(this.state.files).length,
      conflicts: [...this.conflicts],
      lastError: this.lastError,
      lastSyncAt: this.lastSyncAt,
    };
  }

  idle(timeoutMs = 120_000): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.idleWaiters.push(done);
    });
  }

  private isIdle(): boolean {
    return this.activeOps === 0 && this.timers.size === 0 && !this.pulling;
  }

  private checkIdle(): void {
    this.emitStatus();
    if (!this.isIdle()) return;
    this.lastSyncAt = Date.now();
    for (const waiter of this.idleWaiters.splice(0)) waiter();
  }

  private abs(rel: string): string {
    return join(this.root, ...rel.split('/'));
  }

  /** A path under a symbolically linked folder is left alone too: writing it would land outside the workspace. */
  private async statPath(rel: string): Promise<LocalStat> {
    const parts = rel.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const info = await lstat(join(this.root, ...parts.slice(0, depth))).catch(() => null);
      if (!info) break;
      if (info.isSymbolicLink()) return LINKED;
    }
    return localStat(this.abs(rel));
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.activeOps++;
    this.emitStatus();
    return promise.finally(() => {
      this.activeOps--;
      this.checkIdle();
    });
  }

  /** Operations on the same path never overlap. */
  private withPath(path: string, fn: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(path) ?? Promise.resolve();
    const next = this.track(previous.catch(() => {}).then(fn));
    this.chains.set(path, next);
    void next.finally(() => {
      if (this.chains.get(path) === next) this.chains.delete(path);
    }).catch(() => {});
    return next;
  }

  private schedule(path: string): void {
    if (this.stopped || this.paused) return;
    const existing = this.timers.get(path);
    if (existing) clearTimeout(existing);
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path);
        this.withPath(path, () => this.checkLocal(path))
          .catch((error) => this.fail(error))
          .finally(() => this.checkIdle());
      }, DEBOUNCE_MS),
    );
    this.emitStatus();
  }

  private pull(): Promise<void> {
    if (this.pulling) {
      this.pullAgain = true;
      return this.pulling;
    }
    const run = async () => {
      do {
        this.pullAgain = false;
        let hasMore = true;
        while (hasMore && !this.stopped) {
          const response = await this.options.api.get<ChangesResponse>(`/api/chats/${this.chatId}/fs/changes?since=${this.state.lastSeq}&limit=1000`);
          const queue = [...response.entries];
          const workers = Array.from({ length: NETWORK_CONCURRENCY }, async () => {
            for (let entry = queue.shift(); entry; entry = queue.shift()) {
              const current = entry;
              await this.withPath(current.path, () => this.applyRemote(current));
            }
          });
          await Promise.all(workers);
          if (response.entries.length > 0) this.state.lastSeq = response.entries[response.entries.length - 1].seq;
          hasMore = response.hasMore;
          this.persistSoon();
        }
      } while (this.pullAgain && !this.stopped);
      this.lastError = undefined;
    };
    this.pulling = run()
      .catch((error) => {
        this.fail(error);
        throw error;
      })
      .finally(() => {
        this.pulling = null;
        this.checkIdle();
      });
    return this.pulling;
  }

  private async knownHash(path: string, local: LocalStat): Promise<string> {
    const known = this.state.files[path];
    if (known && known.size === local.size && known.mtimeMs === local.mtimeMs) return known.hash;
    return hashFile(this.abs(path));
  }

  private async applyRemote(entry: FileEntry): Promise<void> {
    if (this.ignore.isIgnored(entry.path, false)) return;
    const abs = this.abs(entry.path);
    const local = await this.statPath(entry.path);
    const known = this.state.files[entry.path];
    if (local.exists && !local.isFile) return;
    const localHash = local.exists ? await this.knownHash(entry.path, local) : null;

    if (entry.hash === null) {
      if (!local.exists) {
        delete this.state.files[entry.path];
      } else if (known && localHash === known.hash) {
        await rm(abs, { force: true });
        delete this.state.files[entry.path];
        await this.pruneEmptyDirs(dirname(abs));
      } else {
        // Edited (or created) here after someone deleted it: keep it and publish it again.
        delete this.state.files[entry.path];
        this.schedule(entry.path);
      }
      return;
    }
    if (localHash === entry.hash) {
      if (process.platform !== 'win32' && local.exec !== entry.exec) await chmod(abs, entry.exec ? 0o755 : 0o644);
      const after = await localStat(abs);
      this.state.files[entry.path] = { hash: entry.hash, size: after.size, mtimeMs: after.mtimeMs, exec: entry.exec };
      return;
    }
    if (known && entry.hash === known.hash) {
      // Nothing new from others (typically the echo of our own upload): local edits go up.
      this.schedule(entry.path);
      return;
    }
    if (!local.exists || (known && localHash === known.hash)) {
      await this.download(entry);
      return;
    }
    const copy = conflictName(entry.path, this.options.deviceName);
    await rename(abs, this.abs(copy));
    await this.download(entry);
    this.conflicts.push(copy);
    this.options.log(`conflict on ${entry.path}: the local version was kept as ${copy}`);
    this.schedule(copy);
  }

  private async download(entry: FileEntry): Promise<void> {
    if (!entry.hash) return;
    const abs = this.abs(entry.path);
    await mkdir(dirname(abs), { recursive: true });
    const tmp = join(dirname(abs), `.cooprompt-tmp-${randomUUID()}`);
    try {
      await this.network.run(async () => {
        const response = await this.options.api.raw('GET', `/api/chats/${this.chatId}/fs/blob/${entry.hash}`);
        if (!response.ok || !response.body) throw new Error(tr('Could not download {path} ({status})', { path: entry.path, status: response.status }));
        const hash = createHash('sha256');
        const hasher = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(response.body as never), hasher, createWriteStream(tmp, { mode: entry.exec ? 0o755 : 0o644 }));
        if (hash.digest('hex') !== entry.hash) throw new Error(tr('Corrupted download of {path}', { path: entry.path }));
      });
      await rename(tmp, abs);
    } finally {
      await rm(tmp, { force: true });
    }
    const after = await localStat(abs);
    this.state.files[entry.path] = { hash: entry.hash, size: after.size, mtimeMs: after.mtimeMs, exec: entry.exec };
    this.persistSoon();
  }

  private async checkLocal(path: string): Promise<void> {
    if (this.stopped || this.paused) return;
    const abs = this.abs(path);
    const local = await this.statPath(path);
    const prefix = `${path}/`;
    if (local.isDir) {
      if (!this.ignore.isIgnored(path, true)) await this.walk(path, (rel) => this.schedule(rel));
      return;
    }
    if (!local.exists) {
      for (const tracked of Object.keys(this.state.files)) if (tracked.startsWith(prefix)) this.schedule(tracked);
    }
    if (this.ignore.isIgnored(path, false)) return;
    const known = this.state.files[path];
    if (!local.exists) {
      if (known) await this.remoteDelete(path, known);
      return;
    }
    if (!local.isFile) return;
    if (local.size > MAX_SYNC_BYTES) {
      if (!this.warnedLarge.has(path)) this.options.log(`not syncing ${path}: larger than 200 MB`);
      this.warnedLarge.add(path);
      return;
    }
    // Windows does not expose Unix executable bits. Preserve the last synced value for existing files.
    const exec = process.platform === 'win32' && known ? known.exec : local.exec;
    if (known && known.size === local.size && known.mtimeMs === local.mtimeMs && known.exec === exec) return;
    const hash = await hashFile(abs);
    if (known && known.hash === hash && known.exec === exec) {
      this.state.files[path] = { ...known, size: local.size, mtimeMs: local.mtimeMs };
      this.persistSoon();
      return;
    }
    await this.upload(path, { ...local, exec }, known?.hash ?? '');
  }

  private async upload(path: string, local: LocalStat, base: string): Promise<void> {
    const abs = this.abs(path);
    const response = await this.network.run(() =>
      this.options.api.raw(
        'PUT',
        `/api/chats/${this.chatId}/fs/file?path=${encodeURIComponent(path)}&base=${base}&exec=${local.exec ? 1 : 0}`,
        Readable.toWeb(createReadStream(abs)) as ReadableStream<Uint8Array>,
      ),
    );
    if (response.status === 409) {
      const body = (await response.json()) as { current: FileEntry | null };
      const copy = conflictName(path, this.options.deviceName);
      await rename(abs, this.abs(copy));
      if (body.current?.hash) await this.download(body.current);
      else delete this.state.files[path];
      this.conflicts.push(copy);
      this.options.log(`conflict uploading ${path}: the local version was kept as ${copy}`);
      this.schedule(copy);
      return;
    }
    if (!response.ok) throw new Error(tr('Could not upload {path} ({status})', { path, status: response.status }));
    const entry = (await response.json()) as FileEntry;
    this.state.files[path] = { hash: entry.hash ?? '', size: local.size, mtimeMs: local.mtimeMs, exec: local.exec };
    this.persistSoon();
    const after = await localStat(abs);
    if (after.exists && (after.size !== local.size || after.mtimeMs !== local.mtimeMs)) this.schedule(path);
  }

  private async remoteDelete(path: string, known: FileState): Promise<void> {
    const response = await this.network.run(() => this.options.api.raw('DELETE', `/api/chats/${this.chatId}/fs/file?path=${encodeURIComponent(path)}&base=${known.hash}`));
    if (response.status === 409) {
      // Someone changed it remotely meanwhile: their version wins and comes back.
      const body = (await response.json()) as { current: FileEntry | null };
      if (body.current?.hash) await this.download(body.current);
      return;
    }
    if (!response.ok) throw new Error(tr('Could not delete {path} ({status})', { path, status: response.status }));
    delete this.state.files[path];
    this.persistSoon();
  }

  private async walk(dir: string, visit: (rel: string) => void): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir ? this.abs(dir) : this.root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.cooprompt-tmp-') || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!this.ignore.isIgnored(rel, true)) await this.walk(rel, visit);
      } else if (entry.isFile() && !this.ignore.isIgnored(rel, false)) visit(rel);
    }
  }

  /**
   * If most of the folder vanished while the app was closed (deleted or replaced folder), the
   * files are restored from the server instead of being deleted for everyone.
   */
  private async guardMassDeletion(): Promise<void> {
    const tracked = Object.keys(this.state.files);
    if (tracked.length <= 20) return;
    const missing: string[] = [];
    for (const path of tracked) if (!(await localStat(this.abs(path))).exists) missing.push(path);
    if (missing.length <= 20 || missing.length <= tracked.length / 2) return;
    this.options.log(`${missing.length} files are missing in ${this.root}; restoring them from the server`);
    for (const path of missing) delete this.state.files[path];
    this.state.lastSeq = 0;
  }

  /** Full comparison of the folder against the last synced state. */
  private async scan(): Promise<void> {
    if (this.stopped || this.paused) return;
    const rootInfo = await stat(this.root).catch(() => null);
    if (!rootInfo?.isDirectory()) {
      this.paused = true;
      this.lastError = tr('The folder {root} does not exist: sync is paused so nobody else loses files', { root: this.root });
      this.emitStatus();
      return;
    }
    const seen = new Set<string>();
    await this.walk('', (rel) => seen.add(rel));
    for (const path of Object.keys(this.state.files)) {
      if (!seen.has(path) && !this.ignore.isIgnored(path, false)) this.schedule(path);
    }
    await Promise.all(
      [...seen].map(async (path) => {
        const known = this.state.files[path];
        if (!known) return this.schedule(path);
        const local = await localStat(this.abs(path));
        if (local.size !== known.size || local.mtimeMs !== known.mtimeMs || local.exec !== known.exec) this.schedule(path);
      }),
    );
    this.checkIdle();
  }

  private watch(): void {
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (this.stopped) return;
        if (!filename) {
          void this.scan().catch((error) => this.fail(error));
          return;
        }
        const rel = filename.toString().split(sep).join('/');
        if (basename(rel).startsWith('.cooprompt-tmp-')) return;
        if (rel.endsWith('.gitignore') || rel === '.coopromptignore') this.ignore.invalidate();
        this.schedule(rel);
      });
      this.watcher.on('error', (error) => this.fail(error));
    } catch (error) {
      this.fail(error);
    }
  }

  private async pruneEmptyDirs(dir: string): Promise<void> {
    let current = dir;
    while (current.startsWith(this.root + sep)) {
      try {
        await rmdir(current);
      } catch {
        return;
      }
      current = dirname(current);
    }
  }

  private fail(error: unknown): void {
    if (this.stopped) return;
    this.lastError = error instanceof Error ? error.message : String(error);
    this.options.log(`sync error: ${this.lastError}`);
    this.emitStatus();
    if (!this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.lastError = undefined;
        void this.pull()
          .then(() => this.scan())
          .catch(() => {});
      }, 5_000);
    }
  }

  private persistSoon(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, 1_000);
  }

  /** Writes are serialized so a later snapshot never lands before an earlier one. */
  private persist(): Promise<void> {
    this.persisting = this.persisting
      .then(async () => {
        await mkdir(dirname(this.options.statePath), { recursive: true });
        const tmp = `${this.options.statePath}.${randomUUID()}.tmp`;
        await writeFile(tmp, JSON.stringify(this.state));
        await rename(tmp, this.options.statePath);
      })
      .catch((error) => this.options.log(`could not save the sync state: ${error instanceof Error ? error.message : String(error)}`));
    return this.persisting;
  }

  private emitStatus(): void {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.options.onStatus(this.status());
    }, 150);
  }
}
