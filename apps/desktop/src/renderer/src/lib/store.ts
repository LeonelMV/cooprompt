import { create } from 'zustand';
import type { AutomationInfo, AutomationRun, ChatSummary, DraftState, Invitation, ServerMessage, TranscriptItem, TurnInfo } from '@cooprompt/protocol';
import type { AppState, ChatLocalState, EngineInfo, MainEvent, ProviderPreset, ProviderView, SyncStatus } from '../../../shared/types.ts';
import { call } from './api.ts';
import { unread } from './automations.ts';

export interface ChatViewState {
  items: Record<string, TranscriptItem>;
  turns: Record<string, TurnInfo>;
  drafts: Record<string, DraftState>;
  online: string[];
  typing: string[];
  local: ChatLocalState | null;
  loaded: boolean;
}

export interface Toast {
  id: number;
  level: 'info' | 'error';
  text: string;
}

export type SettingsTab = 'account' | 'models' | 'connectors' | 'skills' | 'memory' | 'server' | 'sync';
export type PanelTab = 'files' | 'people' | 'agent';

interface Providers {
  profiles: ProviderView[];
  defaultProfileId: string | null;
  presets: ProviderPreset[];
}

interface Store {
  app: AppState | null;
  chats: Record<string, ChatSummary>;
  invitations: Invitation[];
  activeChatId: string | null;
  views: Record<string, ChatViewState>;
  sync: Record<string, SyncStatus>;
  engineInfo: Record<string, EngineInfo>;
  providers: Providers | null;
  toasts: Toast[];
  settingsTab: SettingsTab | null;
  newChatOpen: boolean;
  inviteOpen: boolean;
  panel: PanelTab | null;
  /** Automations the user sees, and the runs of their own (the inbox). */
  automations: Record<string, AutomationInfo>;
  automationRuns: Record<string, AutomationRun>;
  /** The main area shows the automations, of one chat when `chatId` is set, instead of a chat. */
  automationsView: { chatId: string | null } | null;
  /** The automation editor is open: `automation` null creates one, `chatId` suggests where it posts. */
  automationEditor: { automation: AutomationInfo | null; chatId?: string } | null;
  /** A turn to scroll to once its chat shows. */
  focus: { chatId: string; turnId: string } | null;
  /** Chats where someone wrote to the team only since you last opened them. */
  teamUnread: Record<string, true>;
  set(patch: Partial<Store>): void;
  toast(level: Toast['level'], text: string): void;
  loadChats(): Promise<void>;
  loadInvitations(): Promise<void>;
  loadProviders(): Promise<void>;
  loadAutomations(): Promise<void>;
  /** Marks the user's finished runs read: these, or every one posted in `chatId`. */
  readRuns(selection: { ids: string[] } | { chatId: string }): void;
  openChat(chatId: string | null): Promise<void>;
  patchView(chatId: string, mutate: (view: ChatViewState) => void): void;
  handle(event: MainEvent): void;
}

const emptyView = (): ChatViewState => ({ items: {}, turns: {}, drafts: {}, online: [], typing: [], local: null, loaded: false });

let toastId = 1;

export const useStore = create<Store>((set, get) => ({
  app: null,
  chats: {},
  invitations: [],
  activeChatId: null,
  views: {},
  sync: {},
  engineInfo: {},
  providers: null,
  toasts: [],
  settingsTab: null,
  newChatOpen: false,
  inviteOpen: false,
  panel: 'files',
  automations: {},
  automationRuns: {},
  automationsView: null,
  automationEditor: null,
  focus: null,
  teamUnread: {},

  set: (patch) => set(patch),

  toast(level, text) {
    const id = toastId++;
    set((state) => ({ toasts: [...state.toasts, { id, level, text }] }));
    setTimeout(() => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })), level === 'error' ? 7000 : 3500);
  },

  async loadChats() {
    const chats = await call('chats.list');
    set({ chats: Object.fromEntries(chats.map((chat) => [chat.id, chat])) });
  },

  async loadInvitations() {
    set({ invitations: await call('invitations.list') });
  },

  async loadProviders() {
    set({ providers: await call('providers.list') });
  },

  async loadAutomations() {
    const { automations, runs } = await call('automations.list');
    set({ automations: Object.fromEntries(automations.map((entry) => [entry.id, entry])), automationRuns: Object.fromEntries(runs.map((run) => [run.id, run])) });
  },

  readRuns(selection) {
    const ids = Object.values(get().automationRuns)
      .filter((run) => unread(run) && ('ids' in selection ? selection.ids.includes(run.id) : run.chatId === selection.chatId))
      .map((run) => run.id);
    if (ids.length === 0) return;
    set((state) => ({ automationRuns: { ...state.automationRuns, ...Object.fromEntries(ids.map((id) => [id, { ...state.automationRuns[id], read: true }])) } }));
    void call('automations.markRead', ids).catch(() => {});
  },

  patchView(chatId, mutate) {
    set((state) => {
      const view = state.views[chatId] ?? emptyView();
      const next: ChatViewState = { ...view, items: { ...view.items }, turns: { ...view.turns }, drafts: { ...view.drafts } };
      mutate(next);
      return { views: { ...state.views, [chatId]: next } };
    });
  },

  async openChat(chatId) {
    const previous = get().activeChatId;
    set({ automationsView: null });
    if (chatId) get().readRuns({ chatId });
    if (chatId && get().teamUnread[chatId]) {
      set((state) => {
        const teamUnread = { ...state.teamUnread };
        delete teamUnread[chatId];
        return { teamUnread };
      });
    }
    if (previous === chatId) return;
    if (previous) void call('chats.close', previous);
    set({ activeChatId: chatId });
    if (!chatId) return;
    try {
      const { items, turns, local } = await call('chats.open', chatId);
      get().patchView(chatId, (view) => {
        view.items = Object.fromEntries(items.map((item) => [item.id, item]));
        view.turns = Object.fromEntries(turns.map((turn) => [turn.id, turn]));
        view.local = local;
        view.loaded = true;
      });
      if (local.sync) set((state) => ({ sync: { ...state.sync, [chatId]: local.sync! } }));
      if (local.engineInfo) set((state) => ({ engineInfo: { ...state.engineInfo, [chatId]: local.engineInfo! } }));
    } catch (error) {
      get().toast('error', error instanceof Error ? error.message : String(error));
    }
  },

  handle(event) {
    switch (event.type) {
      case 'state':
        set({ app: event.state });
        return;
      case 'sync':
        set((state) => ({ sync: { ...state.sync, [event.status.chatId]: event.status } }));
        return;
      case 'engineInfo':
        set((state) => ({ engineInfo: { ...state.engineInfo, [event.chatId]: event.info } }));
        return;
      case 'toast':
        get().toast(event.level, event.text);
        return;
      case 'navigate':
        if (event.turnId) set({ focus: { chatId: event.chatId, turnId: event.turnId } });
        void get().openChat(event.chatId);
        return;
      case 'server':
        handleServer(event.message, get, set);
    }
  },
}));

function handleServer(message: ServerMessage, get: () => Store, set: (fn: (state: Store) => Partial<Store>) => void): void {
  const store = get();
  switch (message.t) {
    case 'chat.upsert':
      set((state) => ({ chats: { ...state.chats, [message.chat.id]: message.chat } }));
      return;
    case 'chat.remove':
      set((state) => {
        const chats = { ...state.chats };
        delete chats[message.chatId];
        // Others' automations of a chat you no longer see go with it; your own stay, paused, to edit or delete.
        const automations = Object.fromEntries(Object.entries(state.automations).filter(([, entry]) => entry.chatId !== message.chatId || entry.owner.id === state.app?.user?.id));
        return { chats, automations, activeChatId: state.activeChatId === message.chatId ? null : state.activeChatId };
      });
      return;
    case 'automation.upsert':
      set((state) => ({ automations: { ...state.automations, [message.automation.id]: message.automation } }));
      return;
    case 'automation.remove':
      set((state) => {
        const automations = { ...state.automations };
        delete automations[message.automationId];
        const automationRuns = Object.fromEntries(Object.entries(state.automationRuns).filter(([, run]) => run.automationId !== message.automationId));
        return { automations, automationRuns };
      });
      return;
    case 'automation.run':
      set((state) => ({ automationRuns: { ...state.automationRuns, [message.run.id]: message.run } }));
      // A result that lands in the chat being looked at is seen right away.
      if (unread(message.run) && store.activeChatId === message.run.chatId && !store.automationsView && document.hasFocus()) store.readRuns({ ids: [message.run.id] });
      return;
    case 'invitation.upsert':
      set((state) => ({
        invitations: message.invitation.status === 'pending' ? [message.invitation, ...state.invitations.filter((inv) => inv.id !== message.invitation.id)] : state.invitations.filter((inv) => inv.id !== message.invitation.id),
      }));
      return;
    case 'items':
      store.patchView(message.chatId, (view) => {
        for (const item of message.items) view.items[item.id] = item;
      });
      return;
    case 'team.message':
      if (message.chatId !== store.activeChatId || store.automationsView) set((state) => ({ teamUnread: { ...state.teamUnread, [message.chatId]: true } }));
      return;
    case 'turn.upsert':
      store.patchView(message.turn.chatId, (view) => {
        view.turns[message.turn.id] = message.turn;
        if (message.turn.status !== 'running') delete view.drafts[message.turn.id];
      });
      return;
    case 'turn.draft':
      store.patchView(message.chatId, (view) => {
        if (message.draft) view.drafts[message.turnId] = message.draft;
        else delete view.drafts[message.turnId];
      });
      return;
    case 'turn.delta':
      store.patchView(message.chatId, (view) => {
        const current = view.drafts[message.turnId];
        view.drafts[message.turnId] = current && current.kind === message.kind ? { kind: current.kind, text: current.text + message.text } : { kind: message.kind, text: message.text };
      });
      return;
    case 'presence':
      store.patchView(message.chatId, (view) => {
        view.online = message.online;
        view.typing = message.typing;
      });
      return;
    case 'error':
      store.toast('error', message.message);
      return;
    default:
      return;
  }
}
