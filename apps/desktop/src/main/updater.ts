import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, createWriteStream, existsSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { AppRelease, HealthResponse } from '@cooprompt/protocol';
import type { UpdateResult, UpdateState, UpdateStatus } from '../shared/types.ts';
import { tr } from './i18n.ts';

const run = promisify(execFile);
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 30 * 60_000;
/** A download that receives nothing for this long is given up. */
const STALL_MS = 60_000;
/** A pending update without an outcome this old means the helper died. */
const HELPER_PATIENCE_MS = 10 * 60_000;
/** States a background check must not disturb. */
const BUSY = new Set<UpdateStatus>(['downloading', 'verifying', 'ready', 'waiting', 'installing']);
const CANCELLED = Symbol('cancelled');

/** What the work folder holds; the helper and the next launch read these too. */
const FILES = {
  pending: 'pending.json',
  confirm: 'confirm',
  status: 'status',
  relocated: 'relocated.json',
  helper: 'update-helper.sh',
  log: 'helper.log',
  staged: 'staged',
};

interface Pending {
  /** Version being installed. */
  version: string;
  /** App that started the update. */
  bundle: string;
  at: number;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readText(path)) as T;
  } catch {
    return null;
  }
}

/** Numeric major.minor.patch comparison; anything unparsable is never newer. */
export function isNewer(candidate: string | null | undefined, current: string): boolean {
  const parse = (value: string | null | undefined) => VERSION.exec(value ?? '')?.slice(1).map(Number) ?? null;
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}

async function plistValue(app: string, key: string): Promise<string | null> {
  try {
    return (await run('plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')])).stdout.trim();
  } catch {
    return null;
  }
}

/** `CFBundleShortVersionString` of the bundle as it is on disk now. */
export const bundleVersion = (app: string): Promise<string | null> => plistValue(app, 'CFBundleShortVersionString');

async function designatedRequirement(app: string): Promise<string | null> {
  const { stdout, stderr } = await run('codesign', ['-d', '-r-', app]).catch(() => ({ stdout: '', stderr: '' }));
  const line = `${stdout}\n${stderr}`.split('\n').find((entry) => entry.includes('designated => '));
  return line ? line.slice(line.indexOf('designated => ') + 'designated => '.length).trim() : null;
}

/**
 * Accepts `candidate` as an update of the `running` app only if it is the same app, the announced
 * version, intact, and signed by whoever signed the running one (its designated requirement). An
 * ad-hoc signature only names its own build, so then the identifier is all that can be required.
 * Resolves with the requirement checked.
 */
export async function verifyBundle(candidate: string, running: string, expectedVersion: string): Promise<string> {
  const id = await plistValue(running, 'CFBundleIdentifier');
  if (!id || (await plistValue(candidate, 'CFBundleIdentifier')) !== id) throw new Error(tr('The download is a different app'));
  if ((await plistValue(candidate, 'CFBundleShortVersionString')) !== expectedVersion) throw new Error(tr('The download is not version {version}', { version: expectedVersion }));
  await run('codesign', ['--verify', '--deep', '--strict', candidate]).catch((error: { stderr?: string }) => {
    throw new Error(tr('The download is damaged: {detail}', { detail: String(error.stderr ?? '').trim().split('\n').pop() || '?' }));
  });
  const designated = await designatedRequirement(running);
  const requirement = !designated || designated.startsWith('cdhash') ? `identifier "${id}"` : designated;
  await run('codesign', ['--verify', '--deep', '--strict', '-R', `=${requirement}`, candidate]).catch(() => {
    throw new Error(tr('The download is not signed by whoever signed this CooPrompt'));
  });
  return requirement;
}

/** In place when the folder and the bundle are writable, otherwise in ~/Applications. */
export function installTarget(current: string, home: string): string {
  try {
    accessSync(dirname(current), constants.W_OK);
    accessSync(current, constants.W_OK);
    return current;
  } catch {
    return join(home, 'Applications', basename(current));
  }
}

/**
 * Run first thing on startup: tells a helper waiting on an update to this version that it started,
 * before anything slow (like the Keychain prompt) can exhaust its patience.
 */
export function confirmLaunch(workDir: string, version: string): void {
  if (readJson<Pending>(join(workDir, FILES.pending))?.version !== version) return;
  try {
    writeFileSync(join(workDir, FILES.confirm), `${process.pid}\n`);
  } catch {
    // The helper puts the previous version back.
  }
}

/**
 * When an update had to be installed elsewhere (the original folder was not writable), the copy
 * left behind opens the updated one instead of running an old version.
 */
export function relocatedCopy(workDir: string, bundle: string, version: string): string | null {
  const file = join(workDir, FILES.relocated);
  const record = readJson<{ from?: string; to?: string; version?: string }>(file);
  if (!record?.to || record.from !== bundle) return null;
  if (record.to !== bundle && existsSync(join(record.to, 'Contents', 'Info.plist')) && isNewer(record.version, version)) return record.to;
  rmSync(file, { force: true });
  return null;
}

/** Streams the zip to `file`, hashing on the way; it must be exactly what the server announced. */
async function downloadRelease(url: string, file: string, release: AppRelease, signal: AbortSignal, onData: (received: number) => void): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(tr('The download failed ({status})', { status: response.status }));
  const hash = createHash('sha256');
  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      if (received > release.size) return done(new Error(tr('The download does not match what the server announced')));
      hash.update(chunk);
      onData(received);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(file), { signal });
  if (received !== release.size || hash.digest('hex') !== release.sha256) throw new Error(tr('The download does not match what the server announced'));
}

async function extract(zip: string, dir: string): Promise<string> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await run('ditto', ['-x', '-k', zip, dir]);
  const apps = (await readdir(dir)).filter((name) => !name.startsWith('.') && name !== '__MACOSX');
  if (apps.length !== 1 || !apps[0].endsWith('.app')) throw new Error(tr('The download does not contain an app'));
  return join(dir, apps[0]);
}

export interface UpdaterOptions {
  /** False in development builds and isolated profiles: nothing is checked or installed. */
  enabled: boolean;
  /** Version of the running app. */
  version: string;
  /** The running .app bundle. */
  bundle: string;
  /** Downloads, plus the files the helper and the next launch read. */
  workDir: string;
  /** update-helper.sh shipped with the app. */
  helper: string;
  home: string;
  server(): string | null;
  onChange(state: UpdateState): void;
  log(message: string): void;
  /** Environment for the helper; tests put a fake `open` on its PATH. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Updates from the team server: it announces its build in /api/health, this downloads and verifies
 * it, and update-helper.sh swaps the app once it has quit, putting the old one back if the new one
 * does not start.
 */
export class Updater {
  state: UpdateState;
  private readonly options: UpdaterOptions;
  private staged: { app: string; version: string } | null = null;
  private checking: Promise<UpdateState> | null = null;
  private transfer: { controller: AbortController; done: Promise<UpdateState> } | null = null;
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(options: UpdaterOptions) {
    this.options = options;
    this.state = { enabled: options.enabled, status: 'idle', available: null, progress: null, error: null, checkedAt: null, lastResult: null };
    const result = options.enabled ? this.collectResult() : null;
    if (result) options.log(`last update: ${result.version} ${result.outcome}${result.detail ? ` (${result.detail})` : ''}`);
    this.state.lastResult = result;
  }

  /** Checks shortly after startup and then every half hour. */
  start(): void {
    if (!this.options.enabled) return;
    this.timers.push(
      setTimeout(() => void this.check(), FIRST_CHECK_MS),
      setInterval(() => void this.check(), CHECK_EVERY_MS),
    );
  }

  stop(): void {
    for (const timer of this.timers.splice(0)) clearTimeout(timer);
    this.transfer?.controller.abort(CANCELLED);
  }

  /** Asks the server which build it offers; only a manual check reports failures. */
  check(manual = false): Promise<UpdateState> {
    if (!this.options.enabled || BUSY.has(this.state.status)) return Promise.resolve(this.state);
    this.checking ??= this.runCheck(manual).finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  /** Downloads the available build, then unpacks and verifies it; resolves once it is ready or failed. */
  download(): Promise<UpdateState> {
    if (this.transfer) return this.transfer.done;
    const release = this.state.available;
    const server = this.options.server();
    if (!this.options.enabled || !release || !server || BUSY.has(this.state.status)) return Promise.resolve(this.state);
    const controller = new AbortController();
    const done = this.fetchRelease(`${server}/download/CooPrompt.zip`, release, controller).finally(() => {
      this.transfer = null;
    });
    this.transfer = { controller, done };
    return done;
  }

  /** The restart waits for running turns to finish; `install` can still be called meanwhile. */
  wait(): UpdateState {
    return this.state.status === 'ready' ? this.set({ status: 'waiting' }) : this.state;
  }

  cancel(): UpdateState {
    if (this.transfer) this.transfer.controller.abort(CANCELLED);
    else if (this.state.status === 'waiting') this.set({ status: 'ready' });
    return this.state;
  }

  /**
   * Hands the verified build to the helper, which swaps it in once process `pid` (this app) has
   * exited and opens it; the caller quits right after.
   */
  async install(pid = process.pid): Promise<void> {
    const staged = this.staged;
    if (!staged || (this.state.status !== 'ready' && this.state.status !== 'waiting') || !existsSync(staged.app)) {
      throw new Error(tr('There is no update ready to install'));
    }
    const dir = this.options.workDir;
    const helper = join(dir, FILES.helper);
    await copyFile(this.options.helper, helper);
    await rm(join(dir, FILES.confirm), { force: true });
    await rm(join(dir, FILES.status), { force: true });
    const pending: Pending = { version: staged.version, bundle: this.options.bundle, at: Date.now() };
    await writeFile(join(dir, FILES.pending), JSON.stringify(pending));
    const target = installTarget(this.options.bundle, this.options.home);
    const out = openSync(join(dir, FILES.log), 'w');
    try {
      const args = [helper, String(pid), staged.app, target, this.options.bundle, join(dir, FILES.confirm), join(dir, FILES.status)];
      spawn('/bin/bash', args, { detached: true, stdio: ['ignore', out, out], env: this.options.env ?? process.env }).unref();
    } finally {
      closeSync(out);
    }
    this.options.log(`installing ${staged.version} into ${target}`);
    this.set({ status: 'installing' });
  }

  private set(patch: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...patch };
    this.options.onChange(this.state);
    return this.state;
  }

  private async runCheck(manual: boolean): Promise<UpdateState> {
    const previous = this.state.status;
    if (manual) this.set({ status: 'checking', error: null });
    try {
      const server = this.options.server();
      if (!server) throw new Error(tr('No server is configured'));
      const response = await fetch(`${server}/api/health`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const health = (await response.json()) as HealthResponse;
      const offer = health.app && isNewer(health.app.version, this.options.version) ? health.app : null;
      if (BUSY.has(this.state.status)) return this.state;
      return this.set({ status: offer ? 'available' : 'idle', available: offer, error: null, checkedAt: Date.now() });
    } catch (error) {
      this.options.log(`update check failed: ${message(error)}`);
      if (manual) return this.set({ status: 'error', available: null, error: tr('Could not check for updates: {error}', { error: message(error) }) });
      return this.state.status === 'checking' ? this.set({ status: previous }) : this.state;
    }
  }

  private async fetchRelease(url: string, release: AppRelease, controller: AbortController): Promise<UpdateState> {
    const dir = this.options.workDir;
    const zip = join(dir, `CooPrompt-${release.version}.zip`);
    let stall: NodeJS.Timeout | undefined;
    const alive = () => {
      clearTimeout(stall);
      stall = setTimeout(() => controller.abort(new Error(tr('The download stalled'))), STALL_MS);
    };
    let shown = 0;
    try {
      this.set({ status: 'downloading', progress: 0, error: null });
      await mkdir(dir, { recursive: true });
      alive();
      await downloadRelease(url, `${zip}.part`, release, controller.signal, (received) => {
        alive();
        const progress = received / release.size;
        if (progress - shown >= 0.01 || received === release.size) {
          shown = progress;
          this.set({ progress });
        }
      });
      clearTimeout(stall);
      await rename(`${zip}.part`, zip);
      this.set({ status: 'verifying', progress: 1 });
      const app = await extract(zip, join(dir, FILES.staged));
      await verifyBundle(app, this.options.bundle, release.version);
      this.staged = { app, version: release.version };
      this.options.log(`update ${release.version} ready in ${app}`);
      return this.set({ status: 'ready', progress: null });
    } catch (error) {
      await rm(join(dir, FILES.staged), { recursive: true, force: true });
      const reason: unknown = controller.signal.aborted ? controller.signal.reason : error;
      if (reason === CANCELLED) return this.set({ status: 'available', progress: null, error: null });
      this.options.log(`update ${release.version} failed: ${message(reason)}`);
      return this.set({ status: 'error', progress: null, error: message(reason) });
    } finally {
      clearTimeout(stall);
      await rm(`${zip}.part`, { force: true });
      await rm(zip, { force: true });
    }
  }

  /** How the last update went, read once, and whatever it left behind cleared. */
  private collectResult(): UpdateResult | null {
    const dir = this.options.workDir;
    const pending = readJson<Pending>(join(dir, FILES.pending));
    let result: UpdateResult | null = null;
    if (pending?.version === this.options.version) {
      result = { version: pending.version, outcome: 'updated' };
      if (pending.bundle !== this.options.bundle) {
        writeFileSync(join(dir, FILES.relocated), JSON.stringify({ from: pending.bundle, to: this.options.bundle, version: pending.version }));
      }
    } else if (pending) {
      const status = readText(join(dir, FILES.status)).split('\n')[0].trim();
      if (!status && Date.now() - pending.at < HELPER_PATIENCE_MS) return null;
      const [outcome, ...detail] = status.split(': ');
      if (outcome === 'rolled-back' || outcome === 'aborted') result = { version: pending.version, outcome, detail: detail.join(': ') || undefined };
    }
    rmSync(join(dir, FILES.pending), { force: true });
    rmSync(join(dir, FILES.staged), { recursive: true, force: true });
    for (const name of existsSync(dir) ? readdirSync(dir) : []) if (/\.zip(\.part)?$/.test(name)) rmSync(join(dir, name), { force: true });
    return result;
  }
}
