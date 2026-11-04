import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { EngineId, PermissionModeId, PublicUser } from '@cooprompt/protocol';
import { isLanguage, type Language } from '../shared/i18n.ts';
import { currentProfileLabel } from '../shared/profile-label.ts';
import type { ChatPrefs, ConnectorConfig, ProviderProfile } from '../shared/types.ts';

export interface EngineSession {
  engine: EngineId;
  profileId: string;
  /** Empty after /new: the next turn starts a session that only catches up from `lastRev`. */
  sessionId: string;
  /** Revision of the prompt of this device's last turn in the chat. */
  lastRev: number;
  lastTurnId?: string;
  cwd: string;
  /** The last turn was stopped before it finished. */
  interrupted?: boolean;
  /** The session has every transcript change up to this revision, except the turns in `deferred`. */
  seenRev?: number;
  /** Turns that were queued or running when the session last caught up; it gets them whole once they end. */
  deferred?: { turnId: string; rev: number }[];
  /** Turns that ran in this session (or in the one it was forked from), so their items are never handed back to it. */
  turnIds?: string[];
  /** The session knows nothing before this revision (a /new). */
  originRev?: number;
  /** Where the engine can fork the session to continue from the end of its last turn (see `EngineRunResult`). */
  checkpoint?: string;
}

export interface SettingsData {
  language: Language;
  serverUrl: string | null;
  deviceId: string;
  deviceName: string;
  user: PublicUser | null;
  /** Email of the last account signed in on this device; without it (and a server address) the login screen first asks whether to join a server or host one. */
  lastEmail: string | null;
  profiles: ProviderProfile[];
  defaultProfileId: string | null;
  defaultPermissionMode: PermissionModeId;
  connectors: ConnectorConfig[];
  chatPrefs: Record<string, ChatPrefs>;
  sessions: Record<string, EngineSession>;
  /** Tools the user approved with "always" per chat (tool name or Bash prefix). */
  alwaysAllow: Record<string, string[]>;
  syncRoot: string;
  privateRoot: string;
  activeSyncChats: string[];
  redactSecrets: boolean;
  host: {
    port: number;
    name: string;
    googleClientId: string;
    allowedDomains: string;
    /** No email/password accounts: effective only while Google sign-in is configured. */
    googleOnly: boolean;
    autoStart: boolean;
    requireAccessCode: boolean;
    /** Folder whose newest `npm run dist` build the server hands out and announces; empty = this app. */
    releaseDir: string;
    /** The public tunnel was open: it is kept (or reopened) when CooPrompt starts again. */
    tunnel: boolean;
    /** The computer doesn't sleep on its own while the server runs with the tunnel open (closing the lid still sleeps it). */
    keepAwake: boolean;
    /** The tunnel address teammates were last given; a tunnel with another one shows the change notice. */
    sharedTunnelUrl: string;
  };
}

/** The macOS computer name ("MacBook Pro de Ana"); DHCP hostnames are often just an IP. */
function computerName(): string {
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim();
      if (name) return name;
    } catch {
      // fall back to the hostname
    }
  }
  return hostname().replace(/\.local$/, '');
}

export class Settings {
  private readonly file: string;
  data: SettingsData;

  constructor(file: string, defaults: { syncRoot: string; privateRoot: string }) {
    this.file = file;
    const fallback: SettingsData = {
      language: 'en',
      serverUrl: null,
      deviceId: randomBytes(12).toString('base64url'),
      deviceName: computerName(),
      user: null,
      lastEmail: null,
      profiles: [],
      defaultProfileId: null,
      defaultPermissionMode: 'default',
      connectors: [],
      chatPrefs: {},
      sessions: {},
      alwaysAllow: {},
      syncRoot: defaults.syncRoot,
      privateRoot: defaults.privateRoot,
      activeSyncChats: [],
      redactSecrets: true,
      host: { port: 4317, name: 'CooPrompt', googleClientId: '', allowedDomains: '', googleOnly: false, autoStart: false, requireAccessCode: false, releaseDir: '', tunnel: false, keepAwake: true, sharedTunnelUrl: '' },
    };
    let stored: Partial<SettingsData> = {};
    try {
      stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<SettingsData>;
    } catch {
      // first run
    }
    this.data = { ...fallback, ...stored, host: { ...fallback.host, ...(stored.host ?? {}) } };
    this.data.profiles = this.data.profiles.map((profile) => ({ ...profile, label: currentProfileLabel(profile.label) }));
    if (!isLanguage(this.data.language)) this.data.language = 'en';
    this.save();
  }

  update(mutate: (data: SettingsData) => void): SettingsData {
    mutate(this.data);
    this.save();
    return this.data;
  }

  chatPrefs(chatId: string): ChatPrefs {
    return this.data.chatPrefs[chatId] ?? {};
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
