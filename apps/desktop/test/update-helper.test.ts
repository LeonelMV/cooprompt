import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installTarget } from '../src/main/updater.ts';
import { fakeOpen, makeApp, versionOf } from './bundles.ts';

const HELPER = fileURLToPath(new URL('../resources/update-helper.sh', import.meta.url));

interface Scenario {
  /** What the new version does when opened. */
  behavior: 'confirm' | 'crash' | 'hang';
  appQuits?: boolean;
  readOnlyApps?: boolean;
  /** Stands for macOS refusing to replace the bundle (e.g. App Management) though the folder is writable. */
  lockedApp?: boolean;
  readOnlyHomeApps?: boolean;
}

describe('update helper', () => {
  let dir: string;
  const processes: { kill(): void }[] = [];

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'cooprompt-helper-')));
  });

  afterEach(async () => {
    for (const child of processes.splice(0)) child.kill();
    execFileSync('chflags', ['-R', 'nouchg', dir]);
    execFileSync('chmod', ['-R', 'u+w', dir]);
    await rm(dir, { recursive: true, force: true });
  });

  async function run(scenario: Scenario) {
    const apps = join(dir, 'Applications');
    const home = join(dir, 'home');
    const work = join(dir, 'work');
    await mkdir(join(home, 'Applications'), { recursive: true });
    const current = await makeApp(apps, '1.0.0');
    const staged = await makeApp(join(work, 'staged'), '2.0.0');
    execFileSync('xattr', ['-w', 'com.apple.quarantine', '0083;00000000;CooPrompt;', staged]);
    const { bin, log } = await fakeOpen(dir);
    if (scenario.readOnlyApps) await chmod(apps, 0o555);
    if (scenario.readOnlyHomeApps) await chmod(join(home, 'Applications'), 0o555);
    if (scenario.lockedApp) execFileSync('chflags', ['uchg', current]);
    const target = scenario.lockedApp ? current : installTarget(current, home);
    const confirm = join(work, 'confirm');
    const status = join(work, 'status');

    const cooprompt = spawn('/bin/sleep', ['30']);
    processes.push(cooprompt);
    const helper = spawn('/bin/bash', [HELPER, String(cooprompt.pid), staged, target, current, confirm, status], {
      env: {
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: home,
        COOPROMPT_SWAP_EXIT_TIMEOUT: scenario.appQuits === false ? '1' : '10',
        COOPROMPT_SWAP_CONFIRM_TIMEOUT: '2',
        FAKE_OPEN_LOG: log,
        FAKE_NEW_VERSION: '2.0.0',
        FAKE_NEW_BEHAVIOR: scenario.behavior,
        FAKE_CONFIRM: confirm,
      },
      stdio: 'ignore',
    });
    if (scenario.appQuits !== false) setTimeout(() => cooprompt.kill(), 300);
    const code = await new Promise<number | null>((resolve) => helper.on('close', resolve));
    return {
      code,
      status: (await readFile(status, 'utf8')).trim(),
      opened: (await readFile(log, 'utf8')).split('\n').filter(Boolean),
      leftovers: (await readdir(apps)).filter((name) => name !== 'Fake.app'),
      apps,
      home,
      current,
      staged,
      target,
    };
  }

  it('swaps the app in once it quits and keeps the new version when it confirms', async () => {
    const result = await run({ behavior: 'confirm' });
    expect(result).toMatchObject({ code: 0, status: 'updated', opened: [result.current], leftovers: [] });
    expect(result.target).toBe(result.current);
    expect(versionOf(result.current)).toBe('2.0.0');
    expect(existsSync(result.staged)).toBe(false);
    expect(execFileSync('xattr', ['-r', result.current]).toString()).not.toContain('quarantine');
  });

  it('installs into ~/Applications when the app folder is not writable', async () => {
    const result = await run({ behavior: 'confirm', readOnlyApps: true });
    const moved = join(result.home, 'Applications', 'Fake.app');
    expect(result.target).toBe(moved);
    expect(result).toMatchObject({ code: 0, status: 'updated', opened: [moved], leftovers: [] });
    expect(versionOf(moved)).toBe('2.0.0');
    expect(versionOf(result.current)).toBe('1.0.0');
  });

  it('falls back to ~/Applications when the app cannot be replaced in place', async () => {
    const result = await run({ behavior: 'confirm', lockedApp: true });
    const moved = join(result.home, 'Applications', 'Fake.app');
    expect(result).toMatchObject({ code: 0, status: 'updated', opened: [moved], leftovers: [] });
    expect(versionOf(moved)).toBe('2.0.0');
    expect(versionOf(result.current)).toBe('1.0.0');
  });

  it('gives up and reopens the app when the update cannot be written anywhere', async () => {
    const result = await run({ behavior: 'confirm', lockedApp: true, readOnlyHomeApps: true });
    expect(result).toMatchObject({ code: 1, status: `aborted: could not write to ${result.apps}`, opened: [result.current], leftovers: [] });
    expect(versionOf(result.current)).toBe('1.0.0');
    expect(versionOf(result.staged)).toBe('2.0.0');
  });

  it('puts the previous version back when the new one dies before confirming', async () => {
    const result = await run({ behavior: 'crash' });
    expect(result).toMatchObject({ code: 1, status: 'rolled-back: the new version did not start', opened: [result.current, result.current], leftovers: [] });
    expect(versionOf(result.current)).toBe('1.0.0');
  });

  it('stops a new version that runs without confirming and puts the previous one back', async () => {
    const result = await run({ behavior: 'hang' });
    expect(result).toMatchObject({ code: 1, status: 'rolled-back: the new version did not start', leftovers: [] });
    expect(versionOf(result.current)).toBe('1.0.0');
    expect(execFileSync('ps', ['-axo', 'comm=']).toString()).not.toContain(`${result.current}/`);
  });

  it('touches nothing when the app does not quit', async () => {
    const result = await run({ behavior: 'confirm', appQuits: false });
    expect(result).toMatchObject({ code: 1, status: 'aborted: CooPrompt did not quit', opened: [], leftovers: [] });
    expect(versionOf(result.current)).toBe('1.0.0');
    expect(versionOf(result.staged)).toBe('2.0.0');
  });
});
