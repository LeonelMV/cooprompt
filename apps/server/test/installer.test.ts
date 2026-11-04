import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HealthResponse } from '@cooprompt/protocol';
import { createCooPromptServer, latestRelease, type InstallerFile, type InstallerSource, type CooPromptServer } from '../src/server.ts';

describe('one-line installer', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function start(installer: InstallerFile | InstallerSource | null): Promise<{ server: CooPromptServer; base: string }> {
    const dataDir = await mkdtemp(join(tmpdir(), 'cooprompt-installer-'));
    const source = typeof installer === 'function' ? installer : async () => installer;
    const server = await createCooPromptServer({ dataDir, host: '127.0.0.1', port: 0, installer: source, log: () => {} });
    cleanups.push(async () => {
      await server.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    return { server, base: `http://127.0.0.1:${server.port}` };
  }

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  const health = async (base: string) => (await (await fetch(`${base}/api/health`)).json()) as HealthResponse;
  const download = async (base: string) => Buffer.from(await (await fetch(`${base}/download/CooPrompt.zip`)).arrayBuffer());
  const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

  it('serves a valid bash script pointing at the address the teammate used, including tunnels', async () => {
    const { base } = await start(null);
    const direct = await (await fetch(`${base}/install`)).text();
    expect(direct).toContain('Downloading CooPrompt');
    expect(await (await fetch(`${base}/install?lang=es`)).text()).toContain('Descargando CooPrompt');
    expect(direct).toContain(`SERVER='${base}'`);
    const script = join(await tempDir('cooprompt-script-'), 'install.sh');
    await writeFile(script, direct);
    execFileSync('bash', ['-n', script]);

    const tunneled = await (await fetch(`${base}/install`, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'demo.trycloudflare.com' } })).text();
    expect(tunneled).toContain("SERVER='https://demo.trycloudflare.com'");
  });

  it('streams the installer zip and reports when none is available', async () => {
    const missing = await start(null);
    expect((await fetch(`${missing.base}/download/CooPrompt.zip`)).status).toBe(404);

    const zip = join(await tempDir('cooprompt-zip-'), 'CooPrompt.zip');
    await writeFile(zip, 'PK-fake-zip-bytes');
    const available = await start({ path: zip, version: null });
    const response = await fetch(`${available.base}/download/CooPrompt.zip`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(await response.text()).toBe('PK-fake-zip-bytes');
  });

  it('announces the build it serves, with the checksum and size of the exact bytes it downloads', async () => {
    const zip = join(await tempDir('cooprompt-zip-'), 'CooPrompt-1.2.3-arm64-mac.zip');
    await writeFile(zip, Buffer.alloc(300_000, 7));
    const { base } = await start({ path: zip, version: '1.2.3' });
    const announced = await health(base);
    const bytes = await download(base);
    expect(announced.app).toEqual({ version: '1.2.3', sha256: sha256(bytes), size: bytes.length });
    expect(announced).toMatchObject({ ok: true, name: 'CooPrompt', version: '0.1.0', protocol: 1, firstRun: true, auth: { password: true, accessCodeRequired: false, google: { enabled: false, clientId: null } } });
  });

  it('announces nothing without an installer or when its version is unknown', async () => {
    expect(await health((await start(null)).base)).not.toHaveProperty('app');
    const zip = join(await tempDir('cooprompt-zip-'), 'CooPrompt.zip');
    await writeFile(zip, 'PK-unversioned');
    const unversioned = await start({ path: zip, version: null });
    expect(await health(unversioned.base)).not.toHaveProperty('app');
    expect((await download(unversioned.base)).toString()).toBe('PK-unversioned');
  });

  it('describes a rebuilt zip again instead of announcing a stale checksum', async () => {
    const zip = join(await tempDir('cooprompt-zip-'), 'CooPrompt.zip');
    await writeFile(zip, 'first build');
    const { base } = await start({ path: zip, version: '2.0.0' });
    expect((await health(base)).app?.sha256).toBe(sha256(Buffer.from('first build')));
    await writeFile(zip, 'second build, same version');
    await utimes(zip, new Date(), new Date(Date.now() + 5000));
    const announced = await health(base);
    expect(announced.app).toEqual({ version: '2.0.0', sha256: sha256(await download(base)), size: 'second build, same version'.length });
  });

  it('serves the build npm run dist names in latest-mac.json, and only announces named builds', async () => {
    const release = await tempDir('cooprompt-release-');
    await writeFile(join(release, 'CooPrompt-0.1.4-arm64-mac.zip'), 'PK-0.1.4');
    await writeFile(join(release, 'CooPrompt-0.1.5-arm64-mac.zip'), 'PK-0.1.5');
    await writeFile(join(release, 'latest-mac.json'), JSON.stringify({ version: '0.1.5', file: 'CooPrompt-0.1.5-arm64-mac.zip' }));
    const named = await start(() => latestRelease(release));
    expect((await health(named.base)).app?.version).toBe('0.1.5');
    expect((await download(named.base)).toString()).toBe('PK-0.1.5');

    await rm(join(release, 'latest-mac.json'));
    await utimes(join(release, 'CooPrompt-0.1.4-arm64-mac.zip'), new Date(), new Date(Date.now() + 5000));
    expect(await latestRelease(release)).toEqual({ path: join(release, 'CooPrompt-0.1.4-arm64-mac.zip'), version: null });
    expect(await health(named.base)).not.toHaveProperty('app');
  });
});
