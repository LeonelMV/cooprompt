import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCooPromptServer } from '@cooprompt/server';
import type { UpdateStatus } from '../src/shared/types.ts';
import { confirmLaunch, isNewer, relocatedCopy, Updater, verifyBundle, type UpdaterOptions } from '../src/main/updater.ts';
import { fakeOpen, makeApp, versionOf } from './bundles.ts';

const HELPER = fileURLToPath(new URL('../resources/update-helper.sh', import.meta.url));
const SIGNING_IDENTITY = fileURLToPath(new URL('../scripts/signing-identity.mjs', import.meta.url));
const { withSigningKeychain } = createRequire(import.meta.url)('../scripts/sign.cjs') as {
  withSigningKeychain<T>(dir: string, fn: (keychain: { identity: string; env: NodeJS.ProcessEnv }) => Promise<T>): Promise<T>;
};

const until = async (check: () => Promise<boolean> | boolean, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condición no alcanzada a tiempo');
};

const zip = (app: string, file: string) => execFileSync('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', '--noacl', '--keepParent', app, file]);

describe('version comparison', () => {
  it('compares major.minor.patch numerically and never treats anything unparsable as newer', () => {
    expect(isNewer('0.1.1', '0.1.0')).toBe(true);
    expect(isNewer('0.1.10', '0.1.9')).toBe(true);
    expect(isNewer('0.2.0', '0.1.99')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.0.9', '0.1.0')).toBe(false);
    expect(isNewer('0.1.1-beta', '0.1.0')).toBe(false);
    expect(isNewer('', '0.1.0')).toBe(false);
    expect(isNewer(undefined, '0.1.0')).toBe(false);
    expect(isNewer('0.1.1', 'dev')).toBe(false);
  });
});

describe('updater', () => {
  let dir: string;
  const cleanups: (() => Promise<void> | void)[] = [];

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'cooprompt-updater-')));
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    execFileSync('chmod', ['-R', 'u+w', dir]);
    await rm(dir, { recursive: true, force: true });
  });

  describe('bundle verification', () => {
    it('accepts the announced version of the same app and rejects anything else', async () => {
      const running = await makeApp(join(dir, 'running'), '1.0.0');
      expect(await verifyBundle(await makeApp(join(dir, 'next'), '1.0.1'), running, '1.0.1')).toBe('identifier "dev.cooprompt.fake"');
      await expect(verifyBundle(await makeApp(join(dir, 'other-app'), '1.0.1', { id: 'dev.someone.else' }), running, '1.0.1')).rejects.toThrow('The download is a different app');
      await expect(verifyBundle(await makeApp(join(dir, 'other-version'), '1.0.2'), running, '1.0.1')).rejects.toThrow('The download is not version 1.0.1');
      const tampered = await makeApp(join(dir, 'tampered'), '1.0.1');
      await writeFile(join(tampered, 'Contents', 'Resources', 'payload.txt'), 'changed after signing\n');
      await expect(verifyBundle(tampered, running, '1.0.1')).rejects.toThrow('The download is damaged');
    });

    it('only accepts builds signed with the identity that signed the running app', async () => {
      const identities = [join(dir, 'identity-a'), join(dir, 'identity-b')];
      for (const identity of identities) execFileSync(process.execPath, [SIGNING_IDENTITY, identity], { stdio: 'ignore' });
      const signer = (identity: string, env: NodeJS.ProcessEnv) => (app: string) => {
        execFileSync('codesign', ['--force', '--timestamp=none', '--sign', identity, app], { env, stdio: 'ignore' });
      };
      const [running, sameSigner] = await withSigningKeychain(identities[0], async ({ identity, env }) => [
        await makeApp(join(dir, 'running'), '1.0.0', { sign: signer(identity, env) }),
        await makeApp(join(dir, 'same'), '1.0.1', { sign: signer(identity, env) }),
      ]);
      const otherSigner = await withSigningKeychain(identities[1], async ({ identity, env }) => makeApp(join(dir, 'other'), '1.0.1', { sign: signer(identity, env) }));
      const adHoc = await makeApp(join(dir, 'ad-hoc'), '1.0.1');

      expect(await verifyBundle(sameSigner, running, '1.0.1')).toMatch(/^identifier "dev\.cooprompt\.fake" and certificate leaf = H"[0-9a-f]{40}"$/);
      await expect(verifyBundle(otherSigner, running, '1.0.1')).rejects.toThrow('The download is not signed by whoever signed this CooPrompt');
      await expect(verifyBundle(adHoc, running, '1.0.1')).rejects.toThrow('The download is not signed by whoever signed this CooPrompt');
    });
  });

  describe('updates from the team server', () => {
    async function setup(offer: { version: string; build?: string } | null, confirmTimeout = 10) {
      const running = await makeApp(join(dir, 'Applications'), '1.0.0');
      const served = join(dir, 'served.zip');
      if (offer) zip(await makeApp(join(dir, 'build'), offer.build ?? offer.version), served);
      const dataDir = join(dir, 'server');
      const server = await createCooPromptServer({ dataDir, host: '127.0.0.1', port: 0, installer: async () => (offer ? { path: served, version: offer.version } : null), log: () => {} });
      cleanups.push(() => server.close());
      const home = join(dir, 'home');
      await mkdir(home, { recursive: true });
      const { bin, log } = await fakeOpen(dir);
      const workDir = join(dir, 'updates');
      const statuses: UpdateStatus[] = [];
      const make = (overrides: Partial<UpdaterOptions> = {}) =>
        new Updater({
          enabled: true,
          version: '1.0.0',
          bundle: running,
          workDir,
          helper: HELPER,
          home,
          server: () => `http://127.0.0.1:${server.port}`,
          onChange: (state) => statuses.push(state.status),
          log: () => {},
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, COOPROMPT_SWAP_CONFIRM_TIMEOUT: String(confirmTimeout), FAKE_OPEN_LOG: log },
          ...overrides,
        });
      const opened = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean);
      const outcome = async () => (await readFile(join(workDir, 'status'), 'utf8').catch(() => '')).trim();
      /** Installs the downloaded build while a stand-in for this app quits, as CooPrompt does. */
      const install = async (updater: Updater) => {
        const cooprompt = spawn('/bin/sleep', ['30']);
        cleanups.push(() => void cooprompt.kill());
        await updater.install(cooprompt.pid);
        cooprompt.kill();
      };
      return { running, served, home, workDir, statuses, make, opened, outcome, install };
    }

    it('offers, downloads and verifies the build the server announces', async () => {
      const { make, statuses } = await setup({ version: '1.0.1' });
      const updater = make();
      expect((await updater.check(true)).status).toBe('available');
      expect(updater.state.available?.version).toBe('1.0.1');
      expect((await updater.download()).status).toBe('ready');
      expect(statuses).toEqual(expect.arrayContaining(['checking', 'available', 'downloading', 'verifying', 'ready']));
      expect(updater.state.error).toBeNull();
    });

    it('offers nothing when the server has no newer build', async () => {
      for (const offer of [null, { version: '1.0.0' }, { version: '0.9.9' }]) {
        const { make } = await setup(offer);
        const updater = make();
        expect(await updater.check(true)).toMatchObject({ status: 'idle', available: null, error: null });
        await rm(join(dir, 'Applications'), { recursive: true });
        await rm(join(dir, 'server'), { recursive: true });
      }
    });

    it('rejects a zip that changed after the server announced it', async () => {
      const { make, served } = await setup({ version: '1.0.1' });
      const updater = make();
      await updater.check(true);
      const other = await makeApp(join(dir, 'other'), '1.0.1');
      await writeFile(join(other, 'Contents', 'Resources', 'extra.txt'), 'not what was announced\n');
      await rm(served);
      zip(other, served);
      expect(await updater.download()).toMatchObject({ status: 'error', error: 'The download does not match what the server announced' });
      expect(existsSync(join(dir, 'updates', 'staged'))).toBe(false);
    });

    it('installs through the helper, and the new version confirms and reports it', async () => {
      const { make, running, workDir, opened, outcome, install } = await setup({ version: '1.0.1' });
      const updater = make();
      await updater.check(true);
      await updater.download();
      await install(updater);
      expect(updater.state.status).toBe('installing');
      await until(async () => (await opened()).includes(running));
      confirmLaunch(workDir, '1.0.1');
      await until(async () => (await outcome()) === 'updated');
      expect(versionOf(running)).toBe('1.0.1');
      expect(make({ version: '1.0.1' }).state.lastResult).toEqual({ version: '1.0.1', outcome: 'updated' });
      expect(make({ version: '1.0.1' }).state.lastResult).toBeNull();
      expect(relocatedCopy(workDir, running, '1.0.1')).toBeNull();
    });

    it('the previous version reports a rollback when the new one does not start', async () => {
      const { make, running, outcome, install } = await setup({ version: '1.0.1' }, 1);
      const updater = make();
      await updater.check(true);
      await updater.download();
      await install(updater);
      await until(async () => (await outcome()).startsWith('rolled-back'));
      expect(versionOf(running)).toBe('1.0.0');
      expect(make().state.lastResult).toEqual({ version: '1.0.1', outcome: 'rolled-back', detail: 'the new version did not start' });
    });

    it('installs into ~/Applications when the app folder is not writable, and the old copy opens the new one', async () => {
      const { make, running, home, workDir, opened, outcome, install } = await setup({ version: '1.0.1' });
      const updater = make();
      await updater.check(true);
      await updater.download();
      await chmod(join(dir, 'Applications'), 0o555);
      await install(updater);
      const moved = join(home, 'Applications', 'Fake.app');
      await until(async () => (await opened()).includes(moved));
      confirmLaunch(workDir, '1.0.1');
      await until(async () => (await outcome()) === 'updated');
      expect(make({ version: '1.0.1', bundle: moved }).state.lastResult).toEqual({ version: '1.0.1', outcome: 'updated' });
      expect(versionOf(running)).toBe('1.0.0');
      expect(relocatedCopy(workDir, running, '1.0.0')).toBe(moved);
      expect(relocatedCopy(workDir, moved, '1.0.1')).toBeNull();
    });
  });
});
