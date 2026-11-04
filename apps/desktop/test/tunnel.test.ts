import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QuickTunnel, type HostLookup, type TunnelState, type TunnelTiming } from '../src/main/tunnel.ts';

/**
 * Stand-in for `cloudflared tunnel --metrics <address> --logfile <file> --url <origin>`: its metrics server answers
 * /quicktunnel with a hostname of its own and /ready with 200 or 503. Each start is appended to spawns.jsonl;
 * control.json, read on every request, says whether it is connected: `all`, then by start (`starts`), then by
 * process id (`pids`).
 */
const FAKE_CLOUDFLARED = `
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const dir = process.env.FAKE_CLOUDFLARED_DIR;
const read = (file, fallback) => {
  try {
    return readFileSync(dir + '/' + file, 'utf8');
  } catch {
    return fallback;
  }
};
const index = read('spawns.jsonl', '').split('\\n').filter(Boolean).length;
appendFileSync(dir + '/spawns.jsonl', JSON.stringify({ pid: process.pid, at: Date.now(), args }) + '\\n');
const connected = () => {
  const control = JSON.parse(read('control.json', '{}'));
  return [control.all, control.starts?.[index], control.pids?.[process.pid]].reduce((ready, rule) => rule?.ready ?? ready, true);
};
const [host, port] = option('--metrics').split(':');
createServer((request, response) => {
  const reply = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (request.url === '/quicktunnel') return reply(200, { hostname: 'fake-' + process.pid + '.trycloudflare.com' });
  if (request.url === '/ready') {
    const ready = connected();
    return reply(ready ? 200 : 503, { status: ready ? 200 : 503, readyConnections: ready ? 1 : 0 });
  }
  reply(404, {});
}).listen(Number(port), host);
`;

const TIMING: Partial<TunnelTiming> = { poll: 50, check: 250, recheck: 100, watchful: 400, grace: 1200, adopt: 500, start: 2000, stop: 500, stable: 60_000, backoff: [0, 300, 600] };

let dir: string;
/** Where the tunnel keeps tunnel.json and tunnel.log; the space is there as in "Application Support". */
let data: string;
let events: { at: number; state: TunnelState }[];
let dns: Map<string, HostLookup>;
let dnsDefault: HostLookup;
let lookups: string[];
let tunnels: QuickTunnel[];
let strays: number[];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function command(pid: number): string {
  try {
    return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

async function until<T>(what: string, read: () => T | Promise<T>, timeout = 10_000): Promise<Exclude<T, false | null | undefined | 0 | ''>> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value) return value as Exclude<T, false | null | undefined | 0 | ''>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}; last state: ${JSON.stringify(events.at(-1)?.state)}`);
    await sleep(20);
  }
}

function tunnel(options: { timing?: Partial<TunnelTiming>; binary?: () => string | null } = {}): QuickTunnel {
  const created = new QuickTunnel({
    dir: data,
    binary: options.binary ?? (() => join(dir, 'cloudflared')),
    env: () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_CLOUDFLARED_DIR: dir }),
    log: () => {},
    onChange: (state) => events.push({ at: Date.now(), state: { ...state } }),
    lookup: async (hostname) => {
      lookups.push(hostname);
      return dns.get(hostname) ?? dnsDefault;
    },
    timing: { ...TIMING, ...options.timing },
  });
  tunnels.push(created);
  return created;
}

const spawns = (): { pid: number; at: number; args: string[] }[] =>
  existsSync(join(dir, 'spawns.jsonl'))
    ? readFileSync(join(dir, 'spawns.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const control = (rules: object) => writeFile(join(dir, 'control.json'), JSON.stringify(rules));
const pidOf = (url: string) => Number(/fake-(\d+)\./.exec(url)![1]);
const live = (t: QuickTunnel) => (t.state.status === 'on' ? t.state.url : null);
const record = () => JSON.parse(readFileSync(join(data, 'tunnel.json'), 'utf8')) as { pid: number; metricsPort: number; port: number; url?: string };
const firstAt = (status: TunnelState['status'], after: number) => events.find((event) => event.at >= after && event.state.status === status)?.at;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cooprompt-tunnel-'));
  data = join(dir, 'Application Support', 'host-server');
  await mkdir(data, { recursive: true });
  await writeFile(join(dir, 'fake-cloudflared.mjs'), FAKE_CLOUDFLARED);
  await writeFile(join(dir, 'cloudflared'), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-cloudflared.mjs')}" "$@"\n`);
  await chmod(join(dir, 'cloudflared'), 0o755);
  events = [];
  dns = new Map();
  dnsDefault = 'ok';
  lookups = [];
  tunnels = [];
  strays = [];
});

afterEach(async () => {
  for (const created of tunnels) created.release();
  for (const pid of [...spawns().map((entry) => entry.pid), ...strays]) {
    if (alive(pid) && command(pid).includes(dir)) process.kill(pid, 'SIGKILL');
  }
  await rm(dir, { recursive: true, force: true });
});

describe('the public tunnel', () => {
  it('opens a tunnel and keeps it while it stays connected', async () => {
    const t = tunnel();
    expect(t.open(4317).status).toBe('starting');
    const url = await until('the tunnel', () => live(t));
    expect(url).toMatch(/^https:\/\/fake-\d+\.trycloudflare\.com$/);
    expect(spawns()[0].args).toEqual(['tunnel', '--no-autoupdate', '--metrics', expect.stringMatching(/^127\.0\.0\.1:\d+$/), '--logfile', join(data, 'tunnel.log'), '--url', 'http://127.0.0.1:4317']);
    expect(record()).toMatchObject({ pid: pidOf(url), port: 4317, url });

    await sleep(TIMING.grace! + 3 * TIMING.check!);
    expect(t.state).toMatchObject({ status: 'on', url });
    expect(spawns()).toHaveLength(1);
    expect(lookups).toContain(new URL(url).hostname);
  });

  it('opens a new tunnel when cloudflared dies', async () => {
    const t = tunnel();
    t.open(4317);
    const first = await until('the tunnel', () => live(t));
    process.kill(pidOf(first), 'SIGKILL');

    const second = await until('a new tunnel', () => live(t) !== first && live(t));
    expect(events.some((event) => event.state.status === 'reconnecting' && event.state.error === 'The tunnel closed unexpectedly. Opening a new one…')).toBe(true);
    expect(t.state.replaced).toBe(first);
    expect(record()).toMatchObject({ pid: pidOf(second), url: second });
    expect(spawns()).toHaveLength(2);
  });

  it('keeps its address through a short disconnection after the Mac wakes up', async () => {
    const t = tunnel();
    t.open(4317);
    const url = await until('the tunnel', () => live(t));
    await control({ pids: { [pidOf(url)]: { ready: false } } });
    const woke = Date.now();
    t.wake();
    await sleep(TIMING.grace! / 2);
    await control({});

    await sleep(TIMING.grace! + 2 * TIMING.check!);
    expect(t.state).toMatchObject({ status: 'on', url });
    expect(firstAt('reconnecting', woke)).toBeUndefined();
    expect(spawns()).toHaveLength(1);
  });

  it('replaces a tunnel that stays disconnected after the Mac wakes up, once the grace period is over', async () => {
    const t = tunnel();
    t.open(4317);
    const first = await until('the tunnel', () => live(t));
    await control({ pids: { [pidOf(first)]: { ready: false } } });
    const woke = Date.now();
    t.wake();

    const second = await until('a new tunnel', () => live(t) !== first && live(t));
    expect(firstAt('reconnecting', woke)! - woke).toBeGreaterThanOrEqual(TIMING.grace!);
    expect(events.find((event) => event.state.status === 'reconnecting')?.state.error).toBe('The tunnel stopped working. Opening a new one…');
    expect(t.state.replaced).toBe(first);
    expect(alive(pidOf(first))).toBe(false);
    expect(alive(pidOf(second))).toBe(true);
  });

  it('replaces a disconnected tunnel at once when Cloudflare no longer knows its hostname', async () => {
    const t = tunnel();
    t.open(4317);
    const first = await until('the tunnel', () => live(t));
    const hostname = new URL(first).hostname;
    await until('a lookup of the hostname', () => lookups.includes(hostname));
    dns.set(hostname, 'gone');
    await control({ pids: { [pidOf(first)]: { ready: false } } });
    const woke = Date.now();
    t.wake();

    await until('a new tunnel', () => live(t) !== first && live(t));
    expect(firstAt('reconnecting', woke)! - woke).toBeLessThan(TIMING.grace! / 2);
  });

  it('is not fooled by a resolver that knows no trycloudflare.com names', async () => {
    dnsDefault = 'gone';
    const t = tunnel();
    t.open(4317);
    const url = await until('the tunnel', () => live(t));

    await sleep(TIMING.grace! + 3 * TIMING.check!);
    expect(t.state).toMatchObject({ status: 'on', url });
    expect(spawns()).toHaveLength(1);
  });

  it('keeps trying, waiting longer each time, while new tunnels do not connect', async () => {
    await control({ all: { ready: false } });
    const start = 400;
    const t = tunnel({ timing: { start } });
    t.open(4317);

    await until('three attempts', () => spawns().length >= 3);
    expect(t.state).toMatchObject({ status: 'reconnecting', url: null, error: 'The tunnel could not connect. CooPrompt keeps trying on its own.' });
    const [one, two, three] = spawns();
    const failures = events.filter((event) => event.state.status === 'reconnecting');
    expect(two.at - failures[0].at).toBeGreaterThanOrEqual(TIMING.backoff![1]);
    expect(three.at - failures[1].at).toBeGreaterThanOrEqual(TIMING.backoff![2]);
    await until('failed attempts to be stopped', () => !alive(one.pid) && !alive(two.pid));

    await control({});
    const url = await until('the tunnel', () => live(t));
    expect(spawns().filter((entry) => alive(entry.pid)).map((entry) => entry.pid)).toEqual([pidOf(url)]);
  });

  it('runs one replacement at a time, and waits longer when the new tunnel fails soon too', async () => {
    const t = tunnel();
    t.open(4317);
    const first = await until('the tunnel', () => live(t));
    await control({ pids: { [pidOf(first)]: { ready: false } } });
    t.wake();
    t.wake();
    const burst = setInterval(() => void t.check(), 30);
    let second: string;
    try {
      second = await until('a new tunnel', () => live(t) !== first && live(t));
    } finally {
      clearInterval(burst);
    }
    expect(spawns()).toHaveLength(2);

    await control({ pids: { [pidOf(first)]: { ready: false }, [pidOf(second)]: { ready: false } } });
    const woke = Date.now();
    t.wake();
    const third = await until('a third tunnel', () => live(t) !== second && live(t));
    expect(spawns()).toHaveLength(3);
    expect(spawns()[2].at - firstAt('reconnecting', woke)!).toBeGreaterThanOrEqual(TIMING.backoff![2] - 100);
    expect(third).not.toBe(first);
  });

  it('closes for good', async () => {
    const t = tunnel();
    t.open(4317);
    const url = await until('the tunnel', () => live(t));
    await t.close();

    expect(t.state).toMatchObject({ status: 'off', url: null });
    expect(alive(pidOf(url))).toBe(false);
    expect(existsSync(join(data, 'tunnel.json'))).toBe(false);
    await sleep(3 * TIMING.check!);
    expect(spawns()).toHaveLength(1);
  });

  it('says when cloudflared is missing', async () => {
    const t = tunnel({ binary: () => null });
    t.open(4317);
    await until('the error', () => t.state.status === 'error');
    expect(t.state.error).toBe('cloudflared is missing. Install it with: brew install cloudflared');
    expect(spawns()).toHaveLength(0);
  });

  describe('when CooPrompt starts again', () => {
    it('takes over the tunnel left running while it is connected, keeping its address', async () => {
      const before = tunnel();
      before.open(4317);
      const url = await until('the tunnel', () => live(before));
      before.release();
      expect(alive(pidOf(url))).toBe(true);

      const after = tunnel();
      after.open(4317);
      await until('the tunnel taken over', () => live(after));
      expect(after.state.url).toBe(url);
      expect(spawns()).toHaveLength(1);
    });

    it('replaces the tunnel left running when it does not connect', async () => {
      const before = tunnel();
      before.open(4317);
      const first = await until('the tunnel', () => live(before));
      before.release();
      await control({ pids: { [pidOf(first)]: { ready: false } } });

      const opened = Date.now();
      const after = tunnel();
      after.open(4317);
      const second = await until('a new tunnel', () => live(after));
      expect(second).not.toBe(first);
      expect(after.state.replaced).toBe(first);
      expect(alive(pidOf(first))).toBe(false);
      const replacing = firstAt('reconnecting', opened)! - opened;
      expect(replacing).toBeGreaterThanOrEqual(TIMING.adopt! - 50);
      expect(replacing).toBeLessThan(TIMING.grace!);
    });

    it('starts a new tunnel when the one left running is gone', async () => {
      const before = tunnel();
      before.open(4317);
      const first = await until('the tunnel', () => live(before));
      before.release();
      process.kill(pidOf(first), 'SIGKILL');
      await until('cloudflared to exit', () => !alive(pidOf(first)));

      const after = tunnel();
      after.open(4317);
      const second = await until('a new tunnel', () => live(after));
      expect(second).not.toBe(first);
      expect(spawns()).toHaveLength(2);
    });

    it('never adopts or signals a process it did not start, such as another instance’s tunnel', async () => {
      const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
      const otherDir = join(dir, 'other-instance');
      await mkdir(otherDir);
      const otherMetrics = await freePort();
      const other = spawn(join(dir, 'cloudflared'), ['tunnel', '--no-autoupdate', '--metrics', `127.0.0.1:${otherMetrics}`, '--logfile', join(otherDir, 'tunnel.log'), '--url', 'http://127.0.0.1:4317'], {
        env: { PATH: process.env.PATH ?? '', FAKE_CLOUDFLARED_DIR: otherDir },
        stdio: 'ignore',
      });
      strays.push(sleeper.pid!, other.pid!);
      await until('the other tunnel', async () => (await fetch(`http://127.0.0.1:${otherMetrics}/ready`).catch(() => null))?.ok);

      for (const stranger of [{ pid: sleeper.pid!, metricsPort: otherMetrics }, { pid: other.pid!, metricsPort: otherMetrics }]) {
        await writeFile(join(data, 'tunnel.json'), JSON.stringify({ ...stranger, port: 4317 }));
        const t = tunnel();
        t.open(4317);
        const url = await until('a tunnel of its own', () => live(t));
        expect(url).not.toBe(`https://fake-${other.pid}.trycloudflare.com`);
        await t.close();
      }
      expect(alive(sleeper.pid!)).toBe(true);
      expect(alive(other.pid!)).toBe(true);
      sleeper.kill();
    });
  });
});
