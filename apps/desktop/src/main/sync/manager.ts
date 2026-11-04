import { join } from 'node:path';
import type { ChatSummary } from '@cooprompt/protocol';
import type { SyncStatus } from '../../shared/types.ts';
import { log } from '../log.ts';
import type { ApiClient } from '../net/api.ts';
import type { Settings } from '../settings.ts';
import { WorkspaceSync } from './workspace-sync.ts';

export const folderSlug = (title: string): string =>
  title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 _-]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40) || 'chat';

/** Owns one WorkspaceSync per shared chat this device has opened. */
export class SyncManager {
  private readonly syncs = new Map<string, WorkspaceSync>();
  private readonly starting = new Map<string, Promise<WorkspaceSync>>();
  private readonly api: ApiClient;
  private readonly settings: Settings;
  private readonly stateDir: string;
  private readonly deviceName: () => string;
  private readonly emit: (status: SyncStatus) => void;

  constructor(options: { api: ApiClient; settings: Settings; stateDir: string; deviceName: () => string; emit: (status: SyncStatus) => void }) {
    this.api = options.api;
    this.settings = options.settings;
    this.stateDir = options.stateDir;
    this.deviceName = options.deviceName;
    this.emit = options.emit;
  }

  /** The mirror path is chosen once and kept even if the chat is renamed. */
  folderFor(chat: Pick<ChatSummary, 'id' | 'title'>): string {
    const existing = this.settings.chatPrefs(chat.id).folder;
    if (existing) return existing;
    const folder = join(this.settings.data.syncRoot, `${folderSlug(chat.title)}-${chat.id.slice(0, 6)}`);
    this.settings.update((data) => {
      data.chatPrefs[chat.id] = { ...(data.chatPrefs[chat.id] ?? {}), folder };
    });
    return folder;
  }

  get(chatId: string): WorkspaceSync | undefined {
    return this.syncs.get(chatId);
  }

  status(chatId: string): SyncStatus | null {
    return this.syncs.get(chatId)?.status() ?? null;
  }

  async activate(chat: Pick<ChatSummary, 'id' | 'title' | 'hasWorkspace'>): Promise<WorkspaceSync | null> {
    if (!chat.hasWorkspace) return null;
    const running = this.syncs.get(chat.id);
    if (running) return running;
    const pending = this.starting.get(chat.id);
    if (pending) return pending;
    const sync = new WorkspaceSync({
      api: this.api,
      chatId: chat.id,
      root: this.folderFor(chat),
      statePath: join(this.stateDir, `${chat.id}.json`),
      deviceName: this.deviceName(),
      onStatus: (status) => this.emit(status),
      log: (message) => log(`sync:${chat.id.slice(0, 6)}`, message),
    });
    const startup = sync
      .start()
      .then(() => {
        this.syncs.set(chat.id, sync);
        if (!this.settings.data.activeSyncChats.includes(chat.id)) {
          this.settings.update((data) => {
            data.activeSyncChats.push(chat.id);
          });
        }
        return sync;
      })
      .catch((error) => {
        void sync.stop();
        throw error;
      })
      .finally(() => this.starting.delete(chat.id));
    this.starting.set(chat.id, startup);
    return startup;
  }

  deactivate(chatId: string): void {
    void this.syncs.get(chatId)?.stop();
    this.syncs.delete(chatId);
    this.settings.update((data) => {
      data.activeSyncChats = data.activeSyncChats.filter((id) => id !== chatId);
    });
  }

  onRemoteChange(chatId: string): void {
    this.syncs.get(chatId)?.onRemoteChange();
  }

  onReconnect(): void {
    for (const sync of this.syncs.values()) sync.onRemoteChange();
  }

  stopAll(): void {
    for (const sync of this.syncs.values()) void sync.stop();
    this.syncs.clear();
  }
}
