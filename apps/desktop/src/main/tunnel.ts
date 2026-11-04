import { execFile, spawn } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { HostState } from '../shared/types.ts';
import { tr } from './i18n.ts';

const run = promisify(execFile);

export type TunnelStatus = HostState['tunnelStatus'];

export interface TunnelState {
  status: TunnelStatus;
  /** The public address, while the tunnel works. */
  url: string | null;
  /** Why the tunnel is reconnecting or failed, in the app's language. */
  error?: string;
  /** Address of the tunnel this one replaced, when CooPrompt had to open a new one. */
  replaced?: string;
}

/** What DNS says about the tunnel's hostname: only an authoritative "no such name" is `gone`. */
export type HostLookup = 'ok' | 'gone' | 'unknown';

/** Milliseconds. */
export interface TunnelTiming {
  /** Between polls of a tunnel that is starting or being adopted. */
  poll: number;
  /** Between health checks of a working tunnel. */
  check: number;
  /** Between health checks while it is unhealthy, or for `watchful` after it starts or the computer wakes up. */
  recheck: number;
  watchful: number;
  /** How long a tunnel may stay unhealthy before it is replaced. */
  grace: number;
  /** How long a tunnel an earlier session left running gets to show it is connected. */
  adopt: number;
  /** How long a new tunnel gets to have an address and connect. */
  start: number;
  /** How long cloudflared gets to exit before it is killed. */
  stop: number;
  /** A tunnel working this long resets the backoff. */
  stable: number;
  /** Wait before each new tunnel while they keep failing; the last value repeats. */
  backoff: number[];
}

export const TUNNEL_TIMING: TunnelTiming = {
  poll: 500,
  check: 30_000,
  recheck: 10_000,
  watchful: 60_000,
  grace: 120_000,
  adopt: 20_000,
  start: 120_000,
  stop: 3_000,
  stable: 600_000,
  backoff: [0, 10_000, 30_000, 60_000, 120_000, 300_000],
};

/** The cloudflared this folder's tunnel runs on. It outlives the app, so a restart keeps the public address. */
interface TunnelRecord {
  pid: number;
  /** Its metrics server answers /quicktunnel with the hostname and /ready once it is connected to Cloudflare. */
  metricsPort: number;
  /** Local port it forwards to. */
  port: number;
  url?: string;
}

interface Running {
  pid: number;
  metricsPort: number;
  url: string | null;
  /** Its hostname resolved at least once, so a later "no such name" means Cloudflare dropped it. */
  resolved: boolean;
}

type Health = 'healthy' | 'unhealthy' | 'gone' | 'dead';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function quickTunnelHostname(metricsPort: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${metricsPort}/quicktunnel`, { signal: AbortSignal.timeout(2000) });
    return ((await response.json()) as { hostname?: string }).hostname || null;
  } catch {
    return null;
  }
}

/** cloudflared's /ready answers 200 while at least one connection to Cloudflare is registered. */
async function connected(metricsPort: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${metricsPort}/ready`, { signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}

/** Asks DNS directly, past the system cache. Timeouts and refused queries say nothing about the tunnel. */
async function lookupHost(hostname: string): Promise<HostLookup> {
  try {
    return (await new Resolver({ timeout: 3000, tries: 2 }).resolve4(hostname)).length > 0 ? 'ok' : 'unknown';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOTFOUND' ? 'gone' : 'unknown';
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A Cloudflare quick tunnel to a local port that keeps itself working: it takes over the tunnel an earlier
 * session left running when that one is still connected, checks it periodically and when the computer wakes up, and
 * replaces it (with backoff, one replacement at a time) when cloudflared dies or stays disconnected. A new tunnel
 * gets a new address. It doesn't import Electron, so tests run it against a fake cloudflared.
 */
export class QuickTunnel {
  state: TunnelState = { status: 'off', url: null };
  private readonly recordFile: string;
  private readonly logFile: string;
  private readonly binary: () => string | null;
  private readonly env: () => Record<string, string>;
  private readonly log: (message: string) => void;
  private readonly lookup: (hostname: string) => Promise<HostLookup>;
  private readonly onChange: (state: TunnelState) => void;
  private readonly timing: TunnelTiming;
  /** Bumped when the tunnel is opened, closed or released, so work started earlier stops. */
  private generation = 0;
  /** Set while the host wants the tunnel. */
  private port: number | null = null;
  private current: Running | null = null;
  /** Adopting or starting a tunnel: at most one at a time. */
  private work: Promise<void> | null = null;
  private checking = false;
  private timer: NodeJS.Timeout | null = null;
  private skipWait: (() => void) | null = null;
  private unhealthySince: number | null = null;
  private healthySince: number | null = null;
  private watchfulUntil = 0;
  /** Tunnels started since the last one that kept working for `stable`. */
  private attempts = 0;

  constructor(options: {
    dir: string;
    binary: () => string | null;
    env: () => Record<string, string>;
    log: (message: string) => void;
    onChange: (state: TunnelState) => void;
    lookup?: (hostname: string) => Promise<HostLookup>;
    timing?: Partial<TunnelTiming>;
  }) {
    this.recordFile = join(options.dir, 'tunnel.json');
    this.logFile = join(options.dir, 'tunnel.log');
    this.binary = options.binary;
    this.env = options.env;
    this.log = options.log;
    this.onChange = options.onChange;
    this.lookup = options.lookup ?? lookupHost;
    this.timing = { ...TUNNEL_TIMING, ...options.timing };
  }

  /** Takes over the recorded tunnel or starts one; progress arrives through `onChange`. Again while it waits to retry: retry now. */
  open(port: number): TunnelState {
    if (this.port === port && (this.work || this.current)) {
      this.attempts = 0;
      this.skipWait?.();
      return this.state;
    }
    this.halt();
    this.port = port;
    this.attempts = 0;
    const generation = this.generation;
    this.set({ status: 'starting', url: null, error: undefined, replaced: undefined });
    void this.run(async () => {
      const adopted = await this.adopt(generation);
      if (adopted === true || generation !== this.generation) return;
      if (adopted) this.set({ status: 'reconnecting', error: tr('The tunnel stopped working. Opening a new one…'), replaced: adopted.replaced });
      await this.launch(generation, adopted ? adopted.replaced : undefined);
    });
    return this.state;
  }

  /** Ends the tunnel for good. */
  async close(): Promise<void> {
    const target = this.current ?? this.record();
    this.halt();
    rmSync(this.recordFile, { force: true });
    if (target) await this.stopProcess(target);
    this.set({ status: 'off', url: null, error: undefined, replaced: undefined });
  }

  /** Stops looking after the tunnel and leaves it running, for the next launch to take over. */
  release(): void {
    this.halt();
  }

  /** At launch without the server: a tunnel an earlier session left running has nothing to serve. */
  async drop(): Promise<void> {
    if (this.record()) await this.close();
  }

  /** The computer woke up: timers stood still while it slept, and Cloudflare drops quick tunnels that stay away too long. */
  wake(): void {
    if (this.port === null) return;
    this.log('the computer woke up: checking the tunnel');
    this.unhealthySince = null;
    this.watchfulUntil = Date.now() + this.timing.watchful;
    void this.check();
  }

  async check(): Promise<void> {
    const running = this.current;
    if (!running || this.work || this.checking) return;
    this.checking = true;
    const generation = this.generation;
    try {
      const health = await this.health(running);
      if (generation !== this.generation || this.current !== running || this.work) return;
      const now = Date.now();
      if (health === 'healthy') {
        if (this.unhealthySince !== null) this.log('the tunnel is connected again');
        this.unhealthySince = null;
        this.healthySince ??= now;
        if (now - this.healthySince >= this.timing.stable) this.attempts = 0;
        this.schedule(now < this.watchfulUntil ? this.timing.recheck : this.timing.check);
        return;
      }
      this.healthySince = null;
      if (health === 'dead') {
        this.log('cloudflared is gone');
        void this.replace('closed');
      } else if (health === 'gone') {
        this.log(`Cloudflare no longer knows ${running.url}`);
        void this.replace('stopped');
      } else {
        if (this.unhealthySince === null) {
          this.unhealthySince = now;
          this.log('the tunnel is not connected');
        }
        if (now - this.unhealthySince >= this.timing.grace) {
          this.log(`the tunnel has not been connected for ${Math.round((now - this.unhealthySince) / 1000)} s`);
          void this.replace('stopped');
        } else this.schedule(this.timing.recheck);
      }
    } catch (error) {
      this.log(`could not check the tunnel: ${error instanceof Error ? error.message : String(error)}`);
      if (generation === this.generation) this.schedule(this.timing.recheck);
    } finally {
      this.checking = false;
    }
  }

  private set(patch: Partial<TunnelState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  private halt(): void {
    this.generation += 1;
    this.port = null;
    this.current = null;
    this.unhealthySince = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.skipWait?.();
  }

  private run(task: () => Promise<void>): Promise<void> {
    const work: Promise<void> = task()
      .catch((error) => this.log(`tunnel failure: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (this.work === work) this.work = null;
      });
    this.work = work;
    return work;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check();
    }, ms);
    this.timer.unref();
  }

  /** Resolves early when the wait is skipped; false when the tunnel was closed or released meanwhile. */
  private pause(ms: number, generation: number): Promise<boolean> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.skipWait === done) this.skipWait = null;
        resolve(generation === this.generation);
      };
      const timer = setTimeout(done, ms);
      this.skipWait = done;
    });
  }

  private record(): TunnelRecord | null {
    try {
      const record = JSON.parse(readFileSync(this.recordFile, 'utf8')) as TunnelRecord;
      return typeof record.pid === 'number' && typeof record.metricsPort === 'number' ? record : null;
    } catch {
      return null;
    }
  }

  private writeRecord(running: Running): void {
    const record: TunnelRecord = { pid: running.pid, metricsPort: running.metricsPort, port: this.port!, ...(running.url ? { url: running.url } : {}) };
    writeFileSync(this.recordFile, JSON.stringify(record));
  }

  /** Only a process started with this folder's log file and that metrics address is ours: a reused process id never matches. */
  private async ours(target: { pid: number; metricsPort: number }): Promise<boolean> {
    if (!alive(target.pid)) return false;
    const { stdout } = await run('ps', ['-ww', '-o', 'command=', '-p', String(target.pid)]).catch(() => ({ stdout: '' }));
    return stdout.includes(` --metrics 127.0.0.1:${target.metricsPort} `) && stdout.includes(` --logfile ${this.logFile} `);
  }

  /** SIGCONT in case it is frozen; cloudflared then waits up to 30 s for open connections, so it is killed sooner. */
  private async stopProcess(target: { pid: number; metricsPort: number }): Promise<void> {
    if (!(await this.ours(target))) return;
    try {
      process.kill(target.pid, 'SIGTERM');
      process.kill(target.pid, 'SIGCONT');
    } catch {
      return;
    }
    const deadline = Date.now() + this.timing.stop;
    while (alive(target.pid) && Date.now() < deadline) await sleep(50);
    if (await this.ours(target)) {
      try {
        process.kill(target.pid, 'SIGKILL');
      } catch {
        // it exited meanwhile
      }
    }
  }

  private async health(running: Running): Promise<Health> {
    if (!(await this.ours(running))) return 'dead';
    const hostname = running.url ? new URL(running.url).hostname : null;
    const [ready, dns] = await Promise.all([connected(running.metricsPort), hostname ? this.lookup(hostname) : Promise.resolve<HostLookup>('unknown')]);
    if (dns === 'ok') running.resolved = true;
    // Some resolvers know no trycloudflare.com names at all: a name never seen resolving proves nothing.
    const vanished = dns === 'gone' && running.resolved;
    if (ready && !vanished) return 'healthy';
    return !ready && vanished ? 'gone' : 'unhealthy';
  }

  /** Polls until the tunnel has an address and is connected; false when it dies, the deadline passes or it was closed. */
  private async connects(running: Running, deadline: number, generation: number): Promise<boolean> {
    while (generation === this.generation && alive(running.pid)) {
      if (!running.url) {
        const hostname = await quickTunnelHostname(running.metricsPort);
        if (hostname) running.url = `https://${hostname}`;
      }
      if (running.url && (await connected(running.metricsPort))) return generation === this.generation;
      if (Date.now() >= deadline) return false;
      await sleep(this.timing.poll);
    }
    return false;
  }

  /**
   * True when the recorded tunnel works and is now this one, false when there is none to take over, and the
   * address of the recorded one (if known) when it was ours but not working, so it was stopped.
   */
  private async adopt(generation: number): Promise<boolean | { replaced: string | undefined }> {
    const record = this.record();
    if (!record) return false;
    const candidate: Running = { pid: record.pid, metricsPort: record.metricsPort, url: record.url ?? null, resolved: false };
    if (!(await this.ours(candidate))) {
      rmSync(this.recordFile, { force: true });
      return false;
    }
    if (record.port !== this.port) {
      await this.stopProcess(candidate);
      rmSync(this.recordFile, { force: true });
      return false;
    }
    const hostname = await quickTunnelHostname(candidate.metricsPort);
    if (hostname) candidate.url = `https://${hostname}`;
    if (hostname && (await this.connects(candidate, Date.now() + this.timing.adopt, generation))) {
      this.current = candidate;
      this.writeRecord(candidate);
      this.log(`kept the public tunnel: ${candidate.url}`);
      this.up(candidate);
      return true;
    }
    if (generation !== this.generation) return false;
    this.log(`the tunnel left running (${candidate.url ?? 'no address'}) is not connected: opening a new one`);
    await this.stopProcess(candidate);
    rmSync(this.recordFile, { force: true });
    return { replaced: candidate.url ?? undefined };
  }

  private async spawnTunnel(binary: string, generation: number): Promise<Running | null> {
    const metricsPort = await freePort();
    if (generation !== this.generation) return null;
    const args = ['tunnel', '--no-autoupdate', '--metrics', `127.0.0.1:${metricsPort}`, '--logfile', this.logFile, '--url', `http://127.0.0.1:${this.port}`];
    const child = spawn(binary, args, { env: this.env(), detached: true, stdio: 'ignore' });
    child.on('error', (error) => this.log(`cloudflared did not start: ${error.message}`));
    child.unref();
    if (!child.pid) return null;
    const running: Running = { pid: child.pid, metricsPort, url: null, resolved: false };
    this.current = running;
    this.writeRecord(running);
    child.on('exit', (code, signal) => this.exited(running, signal ?? `code ${code}`));
    return running;
  }

  /** Starts tunnels until one connects, waiting longer between attempts while they keep failing. */
  private async launch(generation: number, replaced?: string): Promise<void> {
    while (generation === this.generation) {
      const wait = this.timing.backoff[Math.min(this.attempts, this.timing.backoff.length - 1)] ?? 0;
      this.attempts += 1;
      if (wait > 0 && !(await this.pause(wait, generation))) return;
      const binary = this.binary();
      if (!binary) {
        this.set({ status: 'error', url: null, error: tr('cloudflared is missing. Install it with: brew install cloudflared'), replaced });
        return;
      }
      const running = await this.spawnTunnel(binary, generation);
      if (generation !== this.generation) return;
      if (!running) {
        this.set({ status: 'error', url: null, error: tr('Could not start cloudflared'), replaced });
        return;
      }
      if (await this.connects(running, Date.now() + this.timing.start, generation)) {
        this.writeRecord(running);
        this.log(`public tunnel: ${running.url}`);
        this.up(running, replaced);
        return;
      }
      if (generation !== this.generation) return;
      this.current = null;
      rmSync(this.recordFile, { force: true });
      await this.stopProcess(running);
      if (generation !== this.generation) return;
      this.log('the new tunnel did not connect: trying again later');
      this.set({ status: 'reconnecting', url: null, error: tr('The tunnel could not connect. CooPrompt keeps trying on its own.'), replaced });
    }
  }

  private up(running: Running, replaced?: string): void {
    const now = Date.now();
    this.unhealthySince = null;
    this.healthySince = now;
    this.watchfulUntil = now + this.timing.watchful;
    this.set({ status: 'on', url: running.url, error: undefined, replaced });
    this.schedule(this.timing.recheck);
  }

  private exited(running: Running, how: string): void {
    if (this.current !== running) return;
    this.log(`cloudflared exited (${how})`);
    // A tunnel being adopted or started notices on its own.
    if (!this.work) void this.replace('closed');
  }

  private replace(reason: 'closed' | 'stopped'): Promise<void> {
    if (this.work) return this.work;
    const generation = this.generation;
    const old = this.current;
    const replaced = old?.url ?? undefined;
    this.current = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.log(`replacing the tunnel ${replaced ?? ''}`.trim());
    this.set({
      status: 'reconnecting',
      url: null,
      error: reason === 'closed' ? tr('The tunnel closed unexpectedly. Opening a new one…') : tr('The tunnel stopped working. Opening a new one…'),
      replaced,
    });
    return this.run(async () => {
      rmSync(this.recordFile, { force: true });
      if (old) await this.stopProcess(old);
      await this.launch(generation, replaced);
    });
  }
}
