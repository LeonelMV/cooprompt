import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { basename, delimiter, join } from 'node:path';
import { app, BrowserWindow, dialog, Notification, shell } from 'electron';
import type {
  AuthResponse,
  AutomationLimits,
  ChatSummary,
  HealthResponse,
  Invitation,
  PublicUser,
  SendMessageResponse,
  ServerMessage,
  ShareTeamMessageResponse,
  TranscriptItem,
  TurnInfo,
} from '@cooprompt/protocol';
import type {
  AppState,
  CatalogEntry,
  ChatLocalState,
  EngineInfo,
  MainEvent,
  ProviderProfile,
  ProviderView,
  SettingsView,
  CooPromptApi,
  CooPromptMethod,
  UpdateState,
  WorkspaceEntry,
} from '../shared/types.ts';
import { AttachmentStore, quarantine } from './attachments.ts';
import { AutomationNotices, automationHandlers } from './automations.ts';
import { assertEditable, buildCatalog, createAgent, createSkill, writeCatalogFile } from './catalog.ts';
import { claudeCommands, claudeFallback, codexCommands, cursorCommands } from './commands.ts';
import { Connectors } from './connectors.ts';
import { claudeLogin, claudeSignIn, probeClaude, type ClaudeProbe } from './engines/claude.ts';
import { codexHome } from './engines/codex.ts';
import { CURSOR_NOT_INSTALLED, cursorLogin, cursorModels, cursorSignIn, findCursorAgent, requireCursorAgent, stopCursorAgents } from './engines/cursor.ts';
import { claudeBaseEnv, claudeEnv, claudeModelEnv, cursorBaseEnv, listModels, needsKey, PROVIDER_PRESETS } from './engines/providers.ts';
import { googleSignIn } from './google.ts';
import { HostService } from './host.ts';
import { log } from './log.ts';
import { ApiClient, ApiError, normalizeServerUrl } from './net/api.ts';
import { Realtime } from './net/realtime.ts';
import { appBundlePath, claudeExecutable, codexExecutable, defaultRoots, PROFILE, UNATTENDED_UPDATES, updatesEnabled, userDataPath } from './paths.ts';
import { createRedactor } from './runner/redact.ts';
import { Runner } from './runner/runner.ts';
import { Secrets } from './secrets.ts';
import { Settings } from './settings.ts';
import { loadShellEnv } from './shell-env.ts';
import { SyncManager } from './sync/manager.ts';
import { sendTeamMessage } from './team.ts';
import { Updater } from './updater.ts';
import { language, setLanguage, tr } from './i18n.ts';
import { ENGINE_NAME, permissionModeFor } from '../shared/engines.ts';
import { isLanguage, translateMessage } from '../shared/i18n.ts';

type Handlers = { [M in CooPromptMethod]: (...args: Parameters<CooPromptApi[M]>) => Promise<ReturnType<CooPromptApi[M]>> | ReturnType<CooPromptApi[M]> };

export class AppCore {
  readonly settings: Settings;
  readonly secrets: Secrets;
  readonly api: ApiClient;
  readonly realtime = new Realtime();
  readonly sync: SyncManager;
  readonly connectors: Connectors;
  readonly attachments: AttachmentStore;
  readonly runner: Runner;
  readonly host: HostService;
  readonly updater: Updater;
  private readonly emit: (event: MainEvent) => void;
  private shellEnv: Record<string, string> = {};
  private readonly engineInfo = new Map<string, EngineInfo>();
  private readonly claudeProbes = new Map<string, { at: number; probe: Promise<ClaudeProbe> }>();
  private devices: AppState['devices'] = [];
  private maxParallelTurns: number | null = null;
  private automationLimits: AutomationLimits | null = null;
  private teamMessages: boolean | null = null;
  private readonly automationNotices: AutomationNotices;
  /** Kept until clicked or closed: macOS drops the click of a notification that was garbage collected. */
  private readonly notifications = new Set<Notification>();
  private readonly version = app.getVersion();
  private readonly handlers: Handlers;
  private readonly secretsLoaded: Promise<void>;
  private notifiedUpdate: string | null = null;
  private idleWait: NodeJS.Timeout | null = null;
  /** Set when quitting to install an update: the version teammates are told the server restarts into. */
  private restartingInto: string | null | undefined;
  /** The Google sign-in waiting for the browser, if any. */
  private googleSignIn: AbortController | null = null;

  constructor(emit: (event: MainEvent) => void) {
    this.emit = emit;
    this.settings = new Settings(userDataPath('settings.json'), defaultRoots());
    setLanguage(this.settings.data.language);
    this.secrets = new Secrets(userDataPath('secrets.json'));
    this.secretsLoaded = this.secrets.load();
    this.api = new ApiClient(
      () => this.settings.data.serverUrl,
      () => this.secrets.get('session-token'),
    );
    this.sync = new SyncManager({
      api: this.api,
      settings: this.settings,
      stateDir: userDataPath('sync'),
      deviceName: () => this.settings.data.deviceName,
      emit: (status) => this.emit({ type: 'sync', status }),
    });
    this.connectors = new Connectors(this.settings, this.secrets, () => this.shellEnv, this.version, (url) => shell.openExternal(url));
    const redact = createRedactor(() => this.secrets.values());
    this.attachments = new AttachmentStore({
      api: this.api,
      cacheDir: userDataPath('attachments'),
      stagingDir: userDataPath('attachments-staged'),
      log: (message) => log('attachments', message),
    });
    this.runner = new Runner({
      api: this.api,
      realtime: this.realtime,
      settings: this.settings,
      secrets: this.secrets,
      connectors: this.connectors,
      sync: this.sync,
      attachments: this.attachments,
      appVersion: this.version,
      executables: { claude: claudeExecutable, codex: codexExecutable, cursor: requireCursorAgent },
      shellEnv: () => this.shellEnv,
      user: () => this.settings.data.user,
      redact,
      engineInfo: (chatId, info) => {
        this.engineInfo.set(chatId, info);
        this.emit({ type: 'engineInfo', chatId, info });
      },
      notify: (title, body) => this.notify(title, body),
    });
    this.host = new HostService({
      settings: this.settings,
      secrets: this.secrets,
      dataDir: userDataPath('host-server'),
      shellEnv: () => this.shellEnv,
      onState: () => this.emitState(),
      notify: (title, body) => this.notify(title, body),
    });
    this.updater = new Updater({
      enabled: updatesEnabled(),
      version: this.version,
      bundle: appBundlePath(),
      workDir: userDataPath('updates'),
      helper: join(process.resourcesPath, 'update-helper.sh'),
      home: app.getPath('home'),
      server: () => this.settings.data.serverUrl,
      onChange: (state) => this.onUpdate(state),
      log: (message) => log('updates', message),
    });
    this.realtime.on('status', () => this.emitState());
    this.realtime.on('message', (message) => this.onServerMessage(message));
    this.automationNotices = new AutomationNotices({
      deviceId: () => this.settings.data.deviceId,
      notify: (title, body, open) => this.announce(title, body, open),
      open: (chatId, turnId) => this.emit({ type: 'navigate', chatId, turnId }),
    });
    this.realtime.on('ready', ({ user, runningTurns, maxParallelTurns, automations, teamMessages }) => {
      this.maxParallelTurns = maxParallelTurns;
      this.automationLimits = automations;
      this.teamMessages = teamMessages;
      this.settings.update((data) => {
        data.user = user;
      });
      this.runner.reconcile(runningTurns);
      this.sync.onReconnect();
      void this.resumeSyncs();
      // After a reconnect the server may have restarted into a new build.
      if (Date.now() - (this.updater.state.checkedAt ?? 0) > 60_000) void this.updater.check();
      this.emitState();
    });
    this.handlers = this.buildHandlers();
  }

  async init(): Promise<void> {
    await this.secretsLoaded;
    this.shellEnv = await loadShellEnv();
    if (this.settings.data.host.autoStart) await this.host.start().catch((error) => log('host', 'could not start', error));
    else await this.host.dropTunnel();
    this.connect();
    this.updater.start();
  }

  async invoke(method: string, args: unknown[]): Promise<unknown> {
    await this.secretsLoaded;
    const handler = (this.handlers as Record<string, (...input: unknown[]) => unknown>)[method];
    if (!handler) throw new Error(`Unknown method: ${method}`);
    return handler(...args);
  }

  async shutdown(): Promise<void> {
    this.updater.stop();
    this.runner.cancelAll();
    stopCursorAgents();
    this.sync.stopAll();
    this.realtime.disconnect();
    await this.host.shutdown(this.restartingInto);
    await this.secrets.flush();
  }

  /** Turns a restart would cut short: the ones this computer runs and, when it hosts the server, everyone's. */
  private busy(): boolean {
    return this.runner.busy() || this.host.runningTurns() > 0;
  }

  /** Restarts into the downloaded update, once the running turns finish unless `now`. */
  private async installUpdate(now: boolean): Promise<UpdateState> {
    if (!now && this.busy()) {
      if (this.updater.state.status !== 'waiting') log('updates', 'the restart waits for the running turns to finish');
      this.updater.wait();
      this.idleWait ??= setInterval(() => {
        if (this.updater.state.status !== 'waiting') return this.stopIdleWait();
        if (this.busy()) return;
        this.stopIdleWait();
        void this.installUpdate(true).catch((error) => log('updates', 'could not install', error));
      }, 3_000);
      return this.updater.state;
    }
    this.stopIdleWait();
    await this.updater.install();
    this.restartingInto = this.updater.state.available?.version ?? null;
    app.quit();
    return this.updater.state;
  }

  private stopIdleWait(): void {
    if (this.idleWait) clearInterval(this.idleWait);
    this.idleWait = null;
  }

  private onUpdate(state: UpdateState): void {
    const version = state.available?.version;
    const notice = version && (state.status === 'available' || state.status === 'ready') ? `${state.status}:${version}` : null;
    if (notice && notice !== this.notifiedUpdate) {
      this.notifiedUpdate = notice;
      if (UNATTENDED_UPDATES) {
        if (state.status === 'available') void this.updater.download();
        else void this.installUpdate(false).catch((error) => log('updates', 'could not install', error));
      } else if (state.status === 'available') {
        this.notify(tr('CooPrompt {version} is available', { version }), tr('Open CooPrompt to update it.'));
      } else {
        this.notify(tr('CooPrompt {version} is ready', { version }), tr('Restart CooPrompt to finish updating.'));
      }
    }
    this.emitState();
  }

  private connect(): void {
    const token = this.secrets.get('session-token');
    const serverUrl = this.settings.data.serverUrl;
    if (!token || !serverUrl || !this.settings.data.user) return;
    this.realtime.connect({ serverUrl, token, deviceId: this.settings.data.deviceId, deviceName: this.settings.data.deviceName, appVersion: this.version });
  }

  state(): AppState {
    return {
      version: this.version,
      language: this.settings.data.language,
      serverUrl: this.settings.data.serverUrl,
      user: this.settings.data.user,
      lastEmail: this.settings.data.lastEmail,
      connection: this.realtime.state,
      deviceId: this.settings.data.deviceId,
      deviceName: this.settings.data.deviceName,
      devices: this.devices,
      host: this.host.state,
      profile: PROFILE,
      update: this.updater.state,
      defaultPermissionMode: this.settings.data.defaultPermissionMode,
      maxParallelTurns: this.maxParallelTurns,
      automations: this.automationLimits,
      teamMessages: this.teamMessages,
    };
  }

  private emitState(): void {
    this.emit({ type: 'state', state: this.state() });
  }

  private notify(title: string, body: string): void {
    if (BrowserWindow.getAllWindows().some((window) => window.isFocused())) return;
    if (Notification.isSupported()) new Notification({ title, body }).show();
  }

  /** A toast while CooPrompt is in front; otherwise a notification that brings CooPrompt forward and runs `open` when clicked. */
  private announce(title: string, body: string, open: () => void): void {
    log('notify', title);
    if (BrowserWindow.getAllWindows().some((window) => window.isFocused())) {
      this.emit({ type: 'toast', level: 'info', text: `${title}. ${body}` });
      return;
    }
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    this.notifications.add(notification);
    notification.on('close', () => this.notifications.delete(notification));
    notification.on('click', () => {
      this.notifications.delete(notification);
      const [window] = BrowserWindow.getAllWindows();
      if (!window) {
        app.emit('activate');
        return;
      }
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      open();
    });
    notification.show();
  }

  private onServerMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'turn.run':
        void this.runner.run(message.turn, message.chat, message.prompt);
        break;
      case 'turn.cancel':
        this.runner.cancel(message.turnId);
        break;
      case 'decision':
        this.runner.respond(message.turnId, message.itemId, message.decision, message.byUserId);
        break;
      case 'fs.change':
        this.sync.onRemoteChange(message.chatId);
        break;
      case 'devices':
        this.devices = message.devices;
        this.emitState();
        break;
      case 'chat.remove':
        if (this.sync.get(message.chatId)) this.sync.deactivate(message.chatId);
        void this.attachments.purgeChat(message.chatId, this.settings.chatPrefs(message.chatId).folder ?? null);
        break;
      case 'invitation.upsert':
        if (message.invitation.status === 'pending') this.notify(tr('New invitation'), tr('{name} invited you to "{title}"', { name: message.invitation.inviter.name, title: message.invitation.chatTitle }));
        break;
      case 'automation.run':
        this.automationNotices.onRun(message.run);
        break;
      case 'team.message':
        this.teamNotice(message);
        break;
      default:
        break;
    }
    this.emit({ type: 'server', message });
  }

  /** Team-only messages are for people, so they notify while CooPrompt is in the background; clicking opens the chat. */
  private teamNotice(message: Extract<ServerMessage, { t: 'team.message' }>): void {
    if (message.item.authorId === this.settings.data.user?.id || BrowserWindow.getAllWindows().some((window) => window.isFocused())) return;
    const { text, attachments } = message.item.data;
    const body = text || (attachments ?? []).map((file) => `📎 ${file.name}`).join('\n');
    this.announce(tr('{name} in "{title}"', { name: message.authorName, title: message.chatTitle }), body.slice(0, 200), () => this.emit({ type: 'navigate', chatId: message.chatId }));
  }

  private async resumeSyncs(): Promise<void> {
    const active = new Set(this.settings.data.activeSyncChats);
    if (active.size === 0) return;
    try {
      const chats = await this.api.get<ChatSummary[]>('/api/chats');
      for (const chat of chats) {
        if (active.has(chat.id) && chat.isMember && chat.hasWorkspace) void this.sync.activate(chat).catch((error) => log('sync', 'could not resume', error));
      }
    } catch (error) {
      log('sync', 'could not resume syncs', error);
    }
  }

  private async completeAuth(serverUrl: string, auth: AuthResponse): Promise<AppState> {
    this.secrets.set('session-token', auth.token);
    this.settings.update((data) => {
      data.serverUrl = serverUrl;
      data.user = auth.user;
      data.lastEmail = auth.user.email;
    });
    this.connect();
    void this.updater.check();
    return this.state();
  }

  /** Runs the bundled Codex CLI; `login` opens the browser for the ChatGPT sign-in on this computer. */
  private codexCommand(args: string[], timeout: number): Promise<{ loggedIn: boolean; message: string }> {
    const codex = codexExecutable();
    const env = { ...this.shellEnv, PATH: [...codex.pathDirs, this.shellEnv.PATH ?? ''].filter(Boolean).join(delimiter) };
    return new Promise((resolve) => {
      execFile(codex.bin, args, { env, timeout }, (error, stdout, stderr) => {
        const message = `${stdout}\n${stderr}`.trim().split('\n').filter(Boolean).pop() ?? (error ? error.message : '');
        resolve({ loggedIn: !error && /logged in/i.test(`${stdout}${stderr}`), message });
      });
    });
  }

  /** The Cursor CLI the Cursor sign-in profile's turns use, with the environment they get. */
  private cursorAccount(): { executable: string | null; env: Record<string, string> } {
    return { executable: findCursorAgent(this.shellEnv), env: cursorBaseEnv(this.shellEnv) };
  }

  private chatFolder(chatId: string): string | null {
    const folder = this.settings.chatPrefs(chatId).folder;
    return folder && existsSync(folder) ? folder : null;
  }

  private localState(chatId: string): ChatLocalState {
    return {
      chatId,
      folder: this.settings.chatPrefs(chatId).folder ?? null,
      prefs: this.settings.chatPrefs(chatId),
      sync: this.sync.status(chatId),
      engineInfo: this.engineInfo.get(chatId) ?? null,
    };
  }

  /** Asking Claude Code costs a process start, so the answer is reused for a few minutes per profile and folder. */
  private claudeProbe(profile: ProviderProfile, cwd: string | null): Promise<ClaudeProbe> {
    const folder = cwd ?? app.getPath('home');
    const cacheKey = `${profile.id}|${folder}`;
    const cached = this.claudeProbes.get(cacheKey);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.probe;
    const probe = probeClaude({
      cwd: folder,
      env: { ...claudeEnv(profile, this.secrets.get(`provider:${profile.id}`), this.shellEnv, this.version), ...claudeModelEnv(profile, profile.model ?? null) },
      executable: claudeExecutable(),
      log: (line) => log('engine:claude', line),
    });
    this.claudeProbes.set(cacheKey, { at: Date.now(), probe });
    probe.catch(() => this.claudeProbes.delete(cacheKey));
    return probe;
  }

  /** The environment the Claude Code sign-in profile's turns get, so the account shown is the one they use. */
  private claudeAccount(): { executable: string; env: Record<string, string> } {
    return { executable: claudeExecutable(), env: claudeBaseEnv(this.shellEnv, this.version) };
  }

  private providerView(profile: ProviderProfile): ProviderView {
    return { ...profile, hasKey: this.secrets.has(`provider:${profile.id}`), needsKey: needsKey(profile) };
  }

  private settingsView(): SettingsView {
    const data = this.settings.data;
    const { tunnel: _tunnel, sharedTunnelUrl: _shared, ...host } = data.host;
    return {
      language: data.language,
      syncRoot: data.syncRoot,
      privateRoot: data.privateRoot,
      defaultPermissionMode: data.defaultPermissionMode,
      redactSecrets: data.redactSecrets,
      host: { ...host, hasGoogleSecret: this.secrets.has('host:google-secret') },
    };
  }

  private editableCwds(): (string | null)[] {
    return [null, ...Object.values(this.settings.data.chatPrefs).map((prefs) => prefs.folder ?? null).filter(Boolean)];
  }

  private assertCatalogPath(path: string): string {
    for (const cwd of this.editableCwds()) {
      try {
        return assertEditable(path, cwd);
      } catch {
        // try the next root
      }
    }
    throw new Error(tr('Only agent configuration .md files can be edited'));
  }

  private buildHandlers(): Handlers {
    return {
      'app.state': () => this.state(),
      'app.openExternal': async (url) => {
        if (!/^https?:\/\//.test(url)) throw new Error(tr('URL not allowed'));
        await shell.openExternal(url);
      },
      'app.revealPath': async (path) => {
        await mkdir(path, { recursive: true }).catch(() => {});
        await shell.openPath(path);
      },
      'app.openTerminal': (path) => new Promise<void>((resolve, reject) => {
        if (process.platform === 'win32') {
          const child = spawn(process.env.ComSpec || 'cmd.exe', [], { cwd: path, detached: true, stdio: 'ignore' });
          child.once('error', reject);
          child.once('spawn', () => {
            child.unref();
            resolve();
          });
        } else {
          execFile('open', ['-a', 'Terminal', path], (error) => error ? reject(error) : resolve());
        }
      }),
      'app.pickFolder': async (defaultPath) => {
        const window = BrowserWindow.getFocusedWindow();
        const options = { defaultPath: defaultPath ?? undefined, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      'auth.health': (serverUrl) => this.api.request<HealthResponse>('GET', '/api/health', undefined, { base: normalizeServerUrl(serverUrl), auth: false }),
      'auth.register': async (input) => {
        const base = normalizeServerUrl(input.serverUrl);
        const auth = await this.api.request<AuthResponse>('POST', '/api/auth/register', { email: input.email, name: input.name, password: input.password, accessCode: input.accessCode }, { base, auth: false });
        return this.completeAuth(base, auth);
      },
      'auth.login': async (input) => {
        const base = normalizeServerUrl(input.serverUrl);
        const auth = await this.api.request<AuthResponse>('POST', '/api/auth/login', { email: input.email, password: input.password }, { base, auth: false });
        return this.completeAuth(base, auth);
      },
      'auth.google': async (input) => {
        const base = normalizeServerUrl(input.serverUrl);
        const health = await this.api.request<HealthResponse>('GET', '/api/health', undefined, { base, auth: false });
        const google = health.auth.google;
        if (!google.enabled || !google.clientId) throw new Error(tr('This server does not have Google sign-in configured'));
        // Starting again (the browser tab was closed, say) replaces the sign-in still waiting.
        this.googleSignIn?.abort();
        const controller = new AbortController();
        this.googleSignIn = controller;
        try {
          const auth = await googleSignIn({
            api: this.api,
            serverUrl: base,
            clientId: google.clientId,
            allowedDomains: google.allowedDomains,
            openBrowser: (url) => shell.openExternal(url),
            signal: controller.signal,
          });
          return this.completeAuth(base, auth);
        } finally {
          if (this.googleSignIn === controller) this.googleSignIn = null;
        }
      },
      'auth.cancelGoogle': () => {
        this.googleSignIn?.abort();
      },
      'auth.logout': async () => {
        await this.api.post('/api/auth/logout').catch(() => {});
        this.runner.cancelAll();
        this.sync.stopAll();
        this.realtime.disconnect();
        this.secrets.set('session-token', null);
        this.settings.update((data) => {
          data.user = null;
        });
        return this.state();
      },
      'auth.changeServer': async (serverUrl) => {
        const base = normalizeServerUrl(serverUrl);
        const user = await this.api.request<PublicUser>('GET', '/api/me', undefined, { base });
        if (user.id !== this.settings.data.user?.id) throw new Error(tr('That address belongs to another server: sign out to use it'));
        this.settings.update((data) => {
          data.serverUrl = base;
          data.user = user;
        });
        this.connect();
        void this.updater.check();
        return this.state();
      },
      'device.rename': (name) => {
        this.settings.update((data) => {
          data.deviceName = name.trim().slice(0, 60) || data.deviceName;
        });
        this.connect();
        return this.state();
      },
      'chats.list': () => this.api.get<ChatSummary[]>('/api/chats'),
      'chats.create': async (input) => {
        const chat = await this.api.post<ChatSummary>('/api/chats', { title: input.title, kind: input.kind });
        if (input.kind === 'private' && input.folder) {
          this.settings.update((data) => {
            data.chatPrefs[chat.id] = { ...(data.chatPrefs[chat.id] ?? {}), folder: input.folder! };
          });
        }
        return chat;
      },
      'chats.rename': (chatId, title) => this.api.request<ChatSummary>('PATCH', `/api/chats/${chatId}`, { title }),
      'chats.delete': async (chatId) => {
        await this.api.request('DELETE', `/api/chats/${chatId}`);
        this.sync.deactivate(chatId);
        await this.attachments.purgeChat(chatId, this.settings.chatPrefs(chatId).folder ?? null);
      },
      'chats.leave': async (chatId) => {
        await this.api.post(`/api/chats/${chatId}/leave`);
        this.sync.deactivate(chatId);
      },
      'chats.join': async (chatId) => {
        const chat = await this.api.post<ChatSummary>(`/api/chats/${chatId}/join`);
        if (chat.hasWorkspace) void this.sync.activate(chat).catch((error) => log('sync', 'could not activate after joining', error));
        return chat;
      },
      'chats.open': async (chatId) => {
        this.realtime.subscribe(chatId);
        const [chat, items, turns] = await Promise.all([
          this.api.get<ChatSummary>(`/api/chats/${chatId}`),
          this.api.get<TranscriptItem[]>(`/api/chats/${chatId}/items?limit=800&include=team`),
          this.api.get<TurnInfo[]>(`/api/chats/${chatId}/turns`),
        ]);
        if (chat.hasWorkspace && chat.isMember) {
          void this.sync.activate(chat).catch((error) => this.emit({ type: 'toast', level: 'error', text: tr('Could not sync the workspace: {error}', { error: error instanceof Error ? error.message : String(error) }) }));
        }
        return { items, turns, local: this.localState(chatId) };
      },
      'chats.close': (chatId) => {
        this.realtime.unsubscribe(chatId);
      },
      'chats.send': async (input) => {
        const profile = this.settings.data.profiles.find((entry) => entry.id === input.profileId) ?? this.settings.data.profiles.find((entry) => entry.id === this.settings.data.defaultProfileId);
        if (!profile) throw new Error(tr('Set up a model in Settings → Models & keys before talking to the agent'));
        const model = input.model?.trim() || profile.model || null;
        const effort = input.effort || undefined;
        this.settings.update((data) => {
          data.chatPrefs[input.chatId] = { ...(data.chatPrefs[input.chatId] ?? {}), profileId: profile.id, model: input.model?.trim() || undefined, effort, permissionMode: input.permissionMode };
        });
        const target = input.interrupt ? (input.interruptTurnId ?? (await this.api.get<ChatSummary>(`/api/chats/${input.chatId}`)).activeTurn?.id ?? null) : null;
        const staged = input.attachments ?? [];
        // Uploaded first: a server that predates attachments fails here, before the message exists.
        const attachments = staged.length > 0 ? await this.attachments.uploadStaged(input.chatId, staged) : [];
        const sent = await this.api
          .post<SendMessageResponse>(`/api/chats/${input.chatId}/messages`, {
            text: input.text,
            deviceId: input.deviceId ?? this.settings.data.deviceId,
            // The chat keeps the mode as chosen; the turn gets the one its engine has.
            config: { engine: profile.engine, profileId: profile.id, model, permissionMode: permissionModeFor(profile.engine, input.permissionMode), ...(effort ? { effort } : {}) },
            providerLabel: model ? `${profile.label} · ${model}` : profile.label,
            ...(input.interrupt ? { interrupt: true, ...(input.interruptTurnId ? { interruptTurnId: input.interruptTurnId } : {}) } : {}),
            ...(input.parallel && this.maxParallelTurns ? { parallel: true } : {}),
            ...(attachments.length > 0 ? { attachments: attachments.map((file) => file.id) } : {}),
          })
          .catch((error: unknown) => {
            // Servers that predate an engine refuse its turns.
            if (error instanceof ApiError && error.status === 400 && error.body.error === 'Invalid engine') {
              throw new Error(tr('This team server can’t run {engine} turns yet: whoever runs it has to update CooPrompt.', { engine: ENGINE_NAME[profile.engine] }));
            }
            throw error;
          });
        if (staged.length > 0) await this.attachments.commit(input.chatId, staged);
        // Servers that predate interrupts queue the message; stopping the running turn gets it going.
        if (target && sent.interrupted === undefined) {
          await this.api.post(`/api/turns/${target}/cancel`).catch((error) => log('chats', 'could not stop the running turn', error instanceof Error ? error.message : String(error)));
        }
        return sent;
      },
      'chats.sendTeam': (input) => sendTeamMessage({ api: this.api, attachments: this.attachments, supported: this.teamMessages }, input),
      'chats.shareTeam': (input) => this.api.post<ShareTeamMessageResponse>(`/api/chats/${input.chatId}/team-messages/${input.itemId}/share`),
      'chats.typing': (chatId) => {
        this.realtime.send({ t: 'typing', chatId });
      },
      'attachments.limits': () => this.attachments.limits(),
      'attachments.stage': (input) => this.attachments.stage(input.name, input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data)),
      'attachments.discard': (id) => this.attachments.discard(id),
      'attachments.open': async (input) => {
        const error = await shell.openPath(await this.attachments.openable(input.chatId, input.attachmentId));
        if (error) throw new Error(error);
      },
      'attachments.reveal': async (input) => {
        shell.showItemInFolder(await this.attachments.file(input.chatId, input.attachmentId));
      },
      'attachments.save': async (input) => {
        const source = await this.attachments.file(input.chatId, input.attachmentId);
        const window = BrowserWindow.getFocusedWindow();
        const options = { defaultPath: join(app.getPath('downloads'), basename(source)) };
        const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return null;
        await copyFile(source, result.filePath);
        quarantine(result.filePath);
        return result.filePath;
      },
      'chats.local': (chatId) => this.localState(chatId),
      'chats.setPrefs': (chatId, prefs) => {
        this.settings.update((data) => {
          data.chatPrefs[chatId] = { ...(data.chatPrefs[chatId] ?? {}), ...prefs };
          if (prefs.folder !== undefined) delete data.sessions[chatId];
        });
        return this.localState(chatId);
      },
      'turns.cancel': async (turnId) => {
        await this.api.post(`/api/turns/${turnId}/cancel`);
      },
      'decisions.respond': (input) => {
        const me = this.settings.data.user;
        if (!me) throw new Error(tr('You are not signed in'));
        if (this.runner.isExecuting(input.turnId)) {
          if (!this.runner.respond(input.turnId, input.itemId, input.decision, me.id)) throw new Error(tr('That request was already resolved'));
          return;
        }
        if (!this.realtime.isOnline()) throw new Error(tr('Not connected to the server'));
        this.realtime.send({ t: 'decision', chatId: input.chatId, turnId: input.turnId, itemId: input.itemId, decision: input.decision });
      },
      'users.search': (query) => this.api.get<PublicUser[]>(`/api/users/search?q=${encodeURIComponent(query)}`),
      'invitations.list': () => this.api.get<Invitation[]>('/api/invitations'),
      'invitations.forChat': (chatId) => this.api.get<Invitation[]>(`/api/chats/${chatId}/invitations`),
      'invitations.create': (input) => this.api.post<Invitation>(`/api/chats/${input.chatId}/invitations`, { userId: input.userId, email: input.email }),
      'invitations.accept': async (id) => {
        const result = await this.api.post<{ chat: ChatSummary | null }>(`/api/invitations/${id}/accept`);
        return { chat: result.chat };
      },
      'invitations.decline': async (id) => {
        await this.api.post(`/api/invitations/${id}/decline`);
      },
      'invitations.revoke': async (id) => {
        await this.api.post(`/api/invitations/${id}/revoke`);
      },
      'providers.list': () => ({
        profiles: this.settings.data.profiles.map((profile) => this.providerView(profile)),
        defaultProfileId: this.settings.data.defaultProfileId,
        presets: PROVIDER_PRESETS,
      }),
      'providers.save': (input) => {
        const profile: ProviderProfile = { ...input.profile, id: input.profile.id || randomUUID(), label: input.profile.label.trim() || 'Model', createdAt: input.profile.createdAt || Date.now() };
        this.settings.update((data) => {
          const index = data.profiles.findIndex((entry) => entry.id === profile.id);
          if (index >= 0) data.profiles[index] = profile;
          else data.profiles.push(profile);
          if (!data.defaultProfileId) data.defaultProfileId = profile.id;
        });
        if (input.apiKey !== undefined) this.secrets.set(`provider:${profile.id}`, input.apiKey ? input.apiKey.trim() : null);
        return this.providerView(profile);
      },
      'providers.delete': (id) => {
        this.settings.update((data) => {
          data.profiles = data.profiles.filter((profile) => profile.id !== id);
          if (data.defaultProfileId === id) data.defaultProfileId = data.profiles[0]?.id ?? null;
        });
        this.secrets.set(`provider:${id}`, null);
      },
      'providers.setDefault': (id) => {
        this.settings.update((data) => {
          data.defaultProfileId = id;
        });
      },
      'providers.models': async (id) => {
        const profile = this.settings.data.profiles.find((entry) => entry.id === id);
        if (!profile) throw new Error(tr('Profile not found'));
        return listModels(profile, this.secrets.get(`provider:${id}`), async () => {
          if (profile.kind !== 'cursor-login') return (await this.claudeProbe(profile, null)).models;
          const { executable, env } = this.cursorAccount();
          if (!executable) throw new Error(CURSOR_NOT_INSTALLED);
          return cursorModels({ executable, cwd: app.getPath('home'), env, appVersion: this.version, log: (line) => log('engine:cursor', line) });
        }).catch((error: unknown) => {
          // Engines report in English.
          throw new Error(translateMessage(language(), error instanceof Error ? error.message : String(error)));
        });
      },
      'providers.codexStatus': () => this.codexCommand(['login', 'status'], 15_000),
      'providers.codexLogin': async () => {
        await this.codexCommand(['login'], 5 * 60_000);
        return this.codexCommand(['login', 'status'], 15_000);
      },
      'providers.claudeStatus': () => claudeSignIn(this.claudeAccount()),
      'providers.claudeLogin': async () => {
        const account = await claudeLogin(this.claudeAccount());
        // Another account can offer other models.
        this.claudeProbes.clear();
        return account;
      },
      'providers.cursorStatus': () => cursorSignIn(this.cursorAccount()),
      'providers.cursorLogin': () => {
        const account = this.cursorAccount();
        if (!account.executable) throw new Error(tr(CURSOR_NOT_INSTALLED));
        return cursorLogin(account);
      },
      'connectors.list': async () => ({ connectors: this.connectors.list(), detected: await this.connectors.detected(null) }),
      'connectors.save': (input) => this.connectors.save(input),
      'connectors.delete': (id) => this.connectors.remove(id),
      'connectors.import': (key) => this.connectors.importFrom(key, null),
      'connectors.importAll': () => this.connectors.importAll(null),
      'connectors.test': (id) => this.connectors.test(id),
      'connectors.oauth': (id) => this.connectors.connectOAuth(id),
      'commands.list': async (input) => {
        const { profiles, defaultProfileId } = this.settings.data;
        const profile = profiles.find((entry) => entry.id === input.profileId) ?? profiles.find((entry) => entry.id === defaultProfileId);
        const cwd = this.chatFolder(input.chatId);
        const catalog = await buildCatalog(cwd);
        if (profile?.engine === 'codex') return codexCommands(codexHome(this.shellEnv), catalog);
        const info = this.engineInfo.get(input.chatId);
        if (profile?.engine === 'cursor') return cursorCommands(app.getPath('home'), cwd, catalog, info?.engine === 'cursor' ? info.slashCommands : []);
        if (!profile) return claudeFallback(catalog, info?.slashCommands);
        try {
          return claudeCommands((await this.claudeProbe(profile, cwd)).commands, info?.terminalSlashCommands);
        } catch (error) {
          log('commands', 'could not ask Claude Code for its commands', error instanceof Error ? error.message : String(error));
          return claudeFallback(catalog, info?.slashCommands);
        }
      },
      'catalog.get': (chatId) => buildCatalog(chatId ? this.chatFolder(chatId) : null),
      'catalog.read': async (path) => readFile(this.assertCatalogPath(path), 'utf8').catch(() => ''),
      'catalog.write': async (input) => {
        await writeCatalogFile(this.assertCatalogPath(input.path), input.content);
      },
      'catalog.createSkill': async (input): Promise<CatalogEntry> => {
        const cwd = input.chatId ? this.chatFolder(input.chatId) : null;
        if (input.scope === 'workspace' && !cwd) throw new Error(tr('This chat has no working folder yet'));
        const root = input.scope === 'workspace' ? join(cwd!, '.claude/skills') : join(app.getPath('home'), '.claude/skills');
        return { ...(await createSkill(root, input)), scope: input.scope };
      },
      'catalog.createAgent': async (input): Promise<CatalogEntry> => {
        const cwd = input.chatId ? this.chatFolder(input.chatId) : null;
        if (input.scope === 'workspace' && !cwd) throw new Error(tr('This chat has no working folder yet'));
        const root = input.scope === 'workspace' ? join(cwd!, '.claude/agents') : join(app.getPath('home'), '.claude/agents');
        return { ...(await createAgent(root, input)), scope: input.scope };
      },
      'workspace.tree': async (chatId) => {
        const root = this.chatFolder(chatId);
        if (!root) return { root: '', entries: [], truncated: false };
        const entries: WorkspaceEntry[] = [];
        const skip = new Set(['node_modules', '.git', '.DS_Store', '.cooprompt']);
        const walk = async (dir: string, rel: string) => {
          if (entries.length >= 4000) return;
          const list = await readdir(dir, { withFileTypes: true }).catch(() => []);
          list.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
          for (const entry of list) {
            if (skip.has(entry.name) || entry.name.startsWith('.cooprompt-tmp-') || entries.length >= 4000) continue;
            const path = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              entries.push({ path, dir: true, size: 0 });
              await walk(join(dir, entry.name), path);
            } else if (entry.isFile()) {
              entries.push({ path, dir: false, size: (await stat(join(dir, entry.name)).catch(() => null))?.size ?? 0 });
            }
          }
        };
        await walk(root, '');
        return { root, entries, truncated: entries.length >= 4000 };
      },
      'workspace.resync': async (chatId) => {
        const sync = this.sync.get(chatId);
        if (!sync) return null;
        await sync.resync();
        return sync.status();
      },
      'settings.get': () => this.settingsView(),
      'settings.update': (patch) => {
        const { host, ...rest } = patch;
        this.settings.update((data) => {
          if (isLanguage(rest.language)) data.language = rest.language;
          if (rest.syncRoot) data.syncRoot = rest.syncRoot;
          if (rest.privateRoot) data.privateRoot = rest.privateRoot;
          if (rest.defaultPermissionMode) data.defaultPermissionMode = rest.defaultPermissionMode;
          if (rest.redactSecrets !== undefined) data.redactSecrets = rest.redactSecrets;
          if (host) {
            const { googleClientSecret: _secret, hasGoogleSecret: _has, ...hostRest } = host;
            data.host = { ...data.host, ...hostRest, releaseDir: (hostRest.releaseDir ?? data.host.releaseDir).trim() };
          }
        });
        if (host?.googleClientSecret !== undefined) this.secrets.set('host:google-secret', host.googleClientSecret.trim() || null);
        if (host) this.host.applyAuth();
        setLanguage(this.settings.data.language);
        this.emitState();
        return this.settingsView();
      },
      // Remembered, so reopening CooPrompt brings back the server this computer's accounts live on.
      'host.start': async () => {
        const state = await this.host.start();
        this.settings.update((data) => {
          data.host.autoStart = true;
        });
        return state;
      },
      'host.stop': async () => {
        const state = await this.host.stop();
        this.settings.update((data) => {
          data.host.autoStart = false;
        });
        return state;
      },
      'host.tunnel': (enabled) => this.host.setTunnel(enabled),
      'host.dismissTunnelNotice': () => this.host.dismissTunnelNotice(),
      'update.check': () => this.updater.check(true),
      'update.download': () => {
        void this.updater.download();
        return this.updater.state;
      },
      'update.install': (input) => this.installUpdate(input?.now ?? false),
      'update.cancel': () => {
        this.stopIdleWait();
        return this.updater.cancel();
      },
      ...automationHandlers({ api: this.api, settings: this.settings, timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone }),
    };
  }
}
