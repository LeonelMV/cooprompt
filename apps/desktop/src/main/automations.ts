import type { AutomationInfo, AutomationInput, AutomationRun, ChatSummary } from '@cooprompt/protocol';
import { translateMessage } from '../shared/i18n.ts';
import type { AutomationDraft, CooPromptApi } from '../shared/types.ts';
import { language, tr } from './i18n.ts';
import type { ApiClient } from './net/api.ts';
import type { Settings } from './settings.ts';

type AutomationMethod = Extract<keyof CooPromptApi, `automations.${string}`>;
export type AutomationHandlers = { [M in AutomationMethod]: (...args: Parameters<CooPromptApi[M]>) => Promise<ReturnType<CooPromptApi[M]>> };

export interface AutomationDeps {
  api: ApiClient;
  settings: Settings;
  /** Schedules are read in the owner's time zone: this computer's when saving. */
  timeZone(): string;
}

/** The IPC methods behind the automations view; the team server stores, schedules and checks them. */
export function automationHandlers(deps: AutomationDeps): AutomationHandlers {
  const { api } = deps;
  return {
    'automations.list': async () => {
      const [automations, runs] = await Promise.all([api.get<AutomationInfo[]>('/api/automations'), api.get<AutomationRun[]>('/api/automations/runs?limit=200')]);
      return { automations, runs };
    },
    'automations.save': (draft) => save(deps, draft),
    'automations.setEnabled': (id, enabled) => api.request<AutomationInfo>('PATCH', `/api/automations/${id}`, { enabled }),
    'automations.delete': async (id) => {
      await api.request('DELETE', `/api/automations/${id}`);
    },
    'automations.run': (id) => api.post<AutomationRun>(`/api/automations/${id}/run`),
    'automations.history': (id) => api.get<AutomationRun[]>(`/api/automations/runs?automationId=${encodeURIComponent(id)}&limit=100`),
    'automations.markRead': async (ids) => {
      await api.post('/api/automations/runs/read', ids === 'all' ? { all: true } : { ids });
    },
  };
}

/** Resolves the profile on this computer, as sending a message does, and creates the automation's own chat when asked. */
async function save(deps: AutomationDeps, draft: AutomationDraft): Promise<AutomationInfo> {
  const { api, settings } = deps;
  const { profiles, defaultProfileId } = settings.data;
  const profile = profiles.find((entry) => entry.id === draft.profileId) ?? profiles.find((entry) => entry.id === defaultProfileId);
  if (!profile) throw new Error(tr('Set up a model in Settings → Models & keys before talking to the agent'));
  const model = draft.model?.trim() || profile.model || null;
  const fields: Omit<AutomationInput, 'chatId'> = {
    name: draft.name,
    instructions: draft.instructions,
    deviceId: draft.deviceId ?? settings.data.deviceId,
    schedule: draft.schedule,
    timeZone: deps.timeZone(),
    config: { engine: profile.engine, profileId: profile.id, model, permissionMode: draft.permissionMode, ...(draft.effort ? { effort: draft.effort } : {}) },
    providerLabel: model ? `${profile.label} · ${model}` : profile.label,
    fresh: draft.fresh,
    timeLimitMinutes: draft.timeLimitMinutes,
    enabled: draft.enabled,
  };
  if (draft.target.kind === 'chat') {
    const body = { ...fields, chatId: draft.target.chatId };
    return draft.id ? api.request<AutomationInfo>('PATCH', `/api/automations/${draft.id}`, body) : api.post<AutomationInfo>('/api/automations', body);
  }
  const folder = draft.target.folder;
  const chat = await api.post<ChatSummary>('/api/chats', { title: draft.name.trim() || 'Automation', kind: 'private' });
  if (folder) {
    settings.update((data) => {
      data.chatPrefs[chat.id] = { ...(data.chatPrefs[chat.id] ?? {}), folder };
    });
  }
  try {
    const body = { ...fields, chatId: chat.id };
    return await (draft.id ? api.request<AutomationInfo>('PATCH', `/api/automations/${draft.id}`, body) : api.post<AutomationInfo>('/api/automations', body));
  } catch (error) {
    await api.request('DELETE', `/api/chats/${chat.id}`).catch(() => {});
    throw error;
  }
}

/** Tells the owner, on the computer that ran it, when a run of their automation ends. */
export class AutomationNotices {
  private readonly told = new Set<string>();

  constructor(private readonly deps: { deviceId(): string; notify(title: string, body: string, open: () => void): void; open(chatId: string, turnId: string | null): void }) {}

  onRun(run: AutomationRun): void {
    if (run.read || run.deviceId !== this.deps.deviceId() || (run.status !== 'done' && run.status !== 'failed' && run.status !== 'cancelled')) return;
    const key = `${run.id}:${run.status}`;
    if (this.told.has(key)) return;
    this.told.add(key);
    const name = run.automationName;
    const title =
      run.status === 'done' ? tr('Automation “{name}” finished', { name }) : run.status === 'failed' ? tr('Automation “{name}” failed', { name }) : tr('Automation “{name}” stopped', { name });
    const body = run.status === 'done' || !run.error ? tr('Open it to see the result.') : translateMessage(language(), run.error);
    this.deps.notify(title, body, () => this.deps.open(run.chatId, run.turnId));
  }
}
