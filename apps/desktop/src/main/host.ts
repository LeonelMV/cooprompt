import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { app, powerMonitor, powerSaveBlocker } from 'electron';
import { createCooPromptServer, latestRelease, parseAllowedDomains, type GoogleConfig, type InstallerFile, type CooPromptServer } from '@cooprompt/server';
import type { HostState } from '../shared/types.ts';
import { log } from './log.ts';
import { appBundlePath } from './paths.ts';
import type { Secrets } from './secrets.ts';
import type { Settings } from './settings.ts';
import { QuickTunnel, type TunnelState } from './tunnel.ts';
import { bundleVersion } from './updater.ts';
import { tr } from './i18n.ts';

const run = promisify(execFile);
const OFF: HostState = { running: false, port: null, urls: [], tunnelStatus: 'off', tunnelUrl: null, tunnelNotice: null, accessCode: null, googleEnabled: false };

interface HostAuth {
  google: GoogleConfig | null;
  passwordAuth: boolean;
  accessCode: string | null;
}

/** Runs the collaboration server inside the app so a teammate can connect to this computer. */
export class HostService {
  private server: CooPromptServer | null = null;
  private readonly tunnel: QuickTunnel;
  /** The power save blocker that keeps the computer awake while the tunnel is open. */
  private awake: number | null = null;
  private readonly settings: Settings;
  private readonly secrets: Secrets;
  private readonly dataDir: string;
  private readonly shellEnv: () => Record<string, string>;
  private readonly onState: (state: HostState) => void;
  private readonly notify: (title: string, body: string) => void;
  private ownZip: Promise<InstallerFile | null> | null = null;
  state: HostState = OFF;

  constructor(options: {
    settings: Settings;
    secrets: Secrets;
    dataDir: string;
    shellEnv: () => Record<string, string>;
    onState: (state: HostState) => void;
    notify: (title: string, body: string) => void;
  }) {
    this.settings = options.settings;
    this.secrets = options.secrets;
    this.dataDir = options.dataDir;
    this.shellEnv = options.shellEnv;
    this.onState = options.onState;
    this.notify = options.notify;
    this.tunnel = new QuickTunnel({
      dir: options.dataDir,
      binary: () => this.cloudflared(),
      env: () => this.shellEnv(),
      log: (message) => log('host', message),
      onChange: (tunnel) => this.tunnelChanged(tunnel),
    });
    powerMonitor.on('resume', () => this.tunnel.wake());
  }

  /** Every change also decides whether the computer must stay awake. */
  private set(patch: Partial<HostState>): HostState {
    this.state = { ...this.state, ...patch };
    this.keepAwake();
    this.onState(this.state);
    return this.state;
  }

  /** Teammates reach this computer through the tunnel, so it shouldn't fall asleep on its own (closing the lid still sleeps it). */
  private keepAwake(): void {
    const wanted = this.state.running && this.settings.data.host.keepAwake && ['starting', 'on', 'reconnecting'].includes(this.state.tunnelStatus);
    if (wanted && this.awake === null) {
      this.awake = powerSaveBlocker.start('prevent-app-suspension');
      log('host', 'keeping the computer awake while the tunnel is open');
    } else if (!wanted && this.awake !== null) {
      powerSaveBlocker.stop(this.awake);
      this.awake = null;
      log('host', 'the computer may sleep on its own again');
    }
  }

  /** Teammates outside the network need a new address when the tunnel gets one, until the host copies or dismisses the notice. */
  private tunnelChanged(tunnel: TunnelState): void {
    const url = tunnel.status === 'on' ? tunnel.url : null;
    if (url && !this.settings.data.host.sharedTunnelUrl) {
      this.settings.update((data) => {
        data.host.sharedTunnelUrl = tunnel.replaced ?? url;
      });
    }
    const shared = this.settings.data.host.sharedTunnelUrl;
    const notice = url && url !== shared ? { url, previousUrl: shared } : null;
    if (notice && notice.url !== this.state.tunnelNotice?.url) {
      log('host', `the public address changed from ${shared} to ${url}`);
      this.notify(tr('Your server has a new public address'), tr('Teammates outside your network need it to reconnect. Open CooPrompt to copy the message for them.'));
    }
    this.set({ tunnelStatus: tunnel.status, tunnelUrl: url, error: tunnel.error, tunnelNotice: notice });
  }

  /** The host has the new address to pass on: it becomes the one teammates are assumed to have. */
  dismissTunnelNotice(): HostState {
    const url = this.state.tunnelUrl;
    if (url) {
      this.settings.update((data) => {
        data.host.sharedTunnelUrl = url;
      });
    }
    return this.set({ tunnelNotice: null });
  }

  /** What teammates install and update to: the newest build in the release folder, or this very app. */
  private readonly installer = async (): Promise<InstallerFile | null> => {
    const dir = this.settings.data.host.releaseDir.trim();
    return (dir ? await latestRelease(dir) : null) ?? this.ownBuild();
  };

  /**
   * This CooPrompt.app zipped once per version. The version is read from the bundle on disk, which is
   * what gets zipped, and the zip leaves out extended attributes (quarantine included).
   */
  private ownBuild(): Promise<InstallerFile | null> {
    if (!app.isPackaged || process.platform !== 'darwin') return Promise.resolve(null);
    if (!this.ownZip) {
      const bundle = appBundlePath();
      this.ownZip = (async () => {
        const version = await bundleVersion(bundle);
        const dir = join(dirname(this.dataDir), 'installer');
        const target = join(dir, `CooPrompt-${version ?? app.getVersion()}-${process.arch}.zip`);
        if (!existsSync(target)) {
          await mkdir(dir, { recursive: true });
          for (const old of await readdir(dir)) await rm(join(dir, old), { force: true });
          const tmp = `${target}.tmp`;
          await run('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', '--noacl', '--keepParent', bundle, tmp]);
          await rename(tmp, target);
          log('host', `installer ready: ${target}`);
        }
        return { path: target, version };
      })().catch((error) => {
        this.ownZip = null;
        log('host', 'could not prepare the installer', error);
        return null;
      });
    }
    return this.ownZip;
  }

  /** Sign-up is open unless the host turns the access code on in Settings → Team server. */
  private accessCode(): string | null {
    if (!this.settings.data.host.requireAccessCode) return null;
    let code = this.secrets.get('host:access-code');
    if (!code) {
      code = String(randomInt(100000, 999999));
      this.secrets.set('host:access-code', code);
    }
    return code;
  }

  /** Who can sign in, from Settings → Team server. */
  private auth(): HostAuth {
    const config = this.settings.data.host;
    const clientId = config.googleClientId.trim();
    const clientSecret = this.secrets.get('host:google-secret');
    const google = clientId && clientSecret ? { clientId, clientSecret, allowedDomains: parseAllowedDomains(config.allowedDomains) } : null;
    // Without Google sign-in, turning passwords off would leave nobody able to sign in.
    return { google, passwordAuth: !(config.googleOnly && google), accessCode: this.accessCode() };
  }

  private authState(auth: HostAuth): Partial<HostState> {
    return { accessCode: auth.passwordAuth ? auth.accessCode : null, googleEnabled: auth.google !== null };
  }

  /** Applied in place so the public tunnel (and its address) survives the change. */
  applyAuth(): HostState {
    if (!this.server) return this.state;
    const auth = this.auth();
    this.server.setAccessCode(auth.accessCode);
    this.server.setAuth(auth);
    return this.set(this.authState(auth));
  }

  /** Turns a restart of this server would cut short, whoever runs them. */
  runningTurns(): number {
    return this.server?.store.runningTurnCount() ?? 0;
  }

  async start(): Promise<HostState> {
    if (this.server) return this.state;
    const config = this.settings.data.host;
    const auth = this.auth();
    this.server = await createCooPromptServer({
      dataDir: this.dataDir,
      host: '0.0.0.0',
      port: config.port,
      name: config.name,
      google: auth.google,
      passwordAuth: auth.passwordAuth,
      accessCode: auth.accessCode,
      installer: this.installer,
      log: (message) => log('host', message),
    });
    log('host', `server listening on ${this.server.urls.join(', ')}`);
    this.set({ running: true, port: this.server.port, urls: this.server.urls, ...this.authState(auth), error: undefined });
    if (this.settings.data.host.tunnel && process.platform !== 'win32') this.tunnel.open(this.server.port);
    return this.state;
  }

  /** Stops the server and closes its tunnel for good (Settings → Stop). */
  async stop(): Promise<HostState> {
    this.settings.update((data) => {
      data.host.tunnel = false;
    });
    await this.tunnel.close();
    await this.server?.close();
    this.server = null;
    return this.set({ ...OFF });
  }

  /**
   * Quitting CooPrompt stops the server but leaves the tunnel up, so the next launch (or the updated
   * app) takes it over with the same address. `update` tells connected apps why the server goes.
   */
  async shutdown(update?: string | null): Promise<void> {
    if (update !== undefined) this.server?.announceRestart(update);
    this.tunnel.release();
    if (this.awake !== null) powerSaveBlocker.stop(this.awake);
    this.awake = null;
    await this.server?.close().catch(() => {});
    this.server = null;
  }

  /** At launch without the server: a tunnel an earlier session left running has nothing to serve. */
  async dropTunnel(): Promise<void> {
    await this.tunnel.drop();
  }

  private cloudflared(): string | null {
    const candidates = [...(this.shellEnv().PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin'].map((dir) => join(dir, 'cloudflared'));
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  /** Quick tunnels give a public https URL without an account (WebSockets included). Opening it again while it reconnects retries now. */
  async setTunnel(enabled: boolean): Promise<HostState> {
    if (enabled && process.platform === 'win32') throw new Error(tr('Public tunnels are not available on Windows yet.'));
    this.settings.update((data) => {
      data.host.tunnel = enabled;
    });
    if (!enabled) {
      await this.tunnel.close();
      return this.state;
    }
    if (!this.server) return this.start();
    this.tunnel.open(this.server.port);
    return this.state;
  }
}
