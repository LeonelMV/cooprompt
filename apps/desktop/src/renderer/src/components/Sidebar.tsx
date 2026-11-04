import { useMemo, useState } from 'react';
import { Building2, Check, Lock, MessageSquarePlus, Search, Settings, Users, X } from 'lucide-react';
import type { ChatKind, ChatSummary } from '@cooprompt/protocol';
import { call } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';
import { useStore } from '../lib/store.ts';
import { AutomationsNavItem } from './automations/AutomationEntry.tsx';
import { TunnelBanner } from './TunnelNotice.tsx';
import { Avatar, IconButton } from './ui.tsx';
import { UpdateBanner } from './UpdateBanner.tsx';

const SECTIONS: { kind: ChatKind; label: string; icon: typeof Lock }[] = [
  { kind: 'multiplayer', label: 'Multiplayer', icon: Users },
  { kind: 'corporate', label: 'Company', icon: Building2 },
  { kind: 'private', label: 'Private', icon: Lock },
];

function ChatRow({ chat, active, onClick }: { chat: ChatSummary; active: boolean; onClick: () => void }) {
  const t = useT();
  const running = chat.activeTurn?.status === 'running';
  const count = chat.activeTurns?.length ?? 0;
  const teamUnread = useStore((state) => Boolean(state.teamUnread[chat.id]));
  return (
    <button onClick={onClick} className={`group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left cursor-default ${active ? 'bg-raised text-ink' : 'text-dim hover:bg-panel hover:text-ink'}`}>
      <span className={`min-w-0 flex-1 truncate text-[13.5px] ${teamUnread ? 'font-semibold text-ink' : ''}`}>{chat.title}</span>
      {teamUnread && <span className="size-2 shrink-0 rounded-full bg-team" title={t('New team-only messages')} />}
      {running && (
        <span className="flex shrink-0 items-center gap-1" title={count > 1 ? t('{count} turns are running', { count }) : t('The agent is working')}>
          {count > 1 && <span className="text-[10.5px] tabular-nums text-accent">{count}</span>}
          <span className="size-2 animate-pulse rounded-full bg-accent" />
        </span>
      )}
      {!chat.isMember && <span className="text-[10.5px] text-faint">{t('view')}</span>}
      {chat.kind !== 'private' && chat.members.length > 1 && (
        <span className="flex -space-x-1.5">
          {chat.members.slice(0, 3).map((member) => (
            <Avatar key={member.user.id} user={member.user} size={16} />
          ))}
        </span>
      )}
    </button>
  );
}

export function Sidebar() {
  const t = useT();
  const { app, chats, invitations, activeChatId, automationsView, openChat, set, toast, loadInvitations } = useStore();
  const [query, setQuery] = useState('');
  const grouped = useMemo(() => {
    const list = Object.values(chats)
      .filter((chat) => !query || chat.title.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return Object.fromEntries(SECTIONS.map((section) => [section.kind, list.filter((chat) => chat.kind === section.kind)])) as Record<ChatKind, ChatSummary[]>;
  }, [chats, query]);
  const connection = app?.connection;

  const respond = async (id: string, accept: boolean) => {
    try {
      if (accept) {
        const { chat } = await call('invitations.accept', id);
        if (chat) {
          set({ chats: { ...useStore.getState().chats, [chat.id]: chat } });
          void openChat(chat.id);
        }
      } else await call('invitations.decline', id);
      await loadInvitations();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-line-soft bg-side">
      <div className="drag flex h-[52px] items-center justify-end gap-1 px-3 pl-20">
        <IconButton title={t('New chat')} onClick={() => set({ newChatOpen: true })}>
          <MessageSquarePlus className="size-[17px]" />
        </IconButton>
      </div>
      <UpdateBanner />
      <TunnelBanner />
      <div className="px-3 pb-2">
        <div className="flex h-8 items-center gap-2 rounded-lg bg-panel px-2.5 text-faint">
          <Search className="size-3.5" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('Search chats')} className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-faint" />
        </div>
      </div>
      <div className="px-2 pb-2">
        <AutomationsNavItem />
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 pb-4">
        {invitations.length > 0 && (
          <div className="mx-1 space-y-2 rounded-xl border border-accent/30 bg-accent/10 p-2.5">
            <p className="text-[11.5px] font-semibold uppercase tracking-wide text-accent">{t('Invitations')}</p>
            {invitations.map((invitation) => (
              <div key={invitation.id} className="flex items-center gap-2">
                <Avatar user={invitation.inviter} size={22} />
                <div className="min-w-0 flex-1 text-[12.5px] leading-tight">
                  <p className="truncate font-medium text-ink">{invitation.chatTitle}</p>
                  <p className="truncate text-dim">{t('from {name}', { name: invitation.inviter.name })}</p>
                </div>
                <IconButton title={t('Accept')} onClick={() => void respond(invitation.id, true)} className="!size-7 text-ok">
                  <Check className="size-4" />
                </IconButton>
                <IconButton title={t('Decline')} onClick={() => void respond(invitation.id, false)} className="!size-7">
                  <X className="size-4" />
                </IconButton>
              </div>
            ))}
          </div>
        )}

        {SECTIONS.map(({ kind, label, icon: Icon }) => {
          const list = grouped[kind];
          if (kind === 'corporate' && !app?.user?.orgDomain && list.length === 0) return null;
          return (
            <div key={kind}>
              <div className="flex items-center gap-1.5 px-2.5 pb-1 text-[11.5px] font-semibold uppercase tracking-wide text-faint">
                <Icon className="size-3.5" />
                {t(label)}
                {kind === 'corporate' && app?.user?.orgDomain && <span className="normal-case tracking-normal">· {app.user.orgDomain}</span>}
              </div>
              {list.length === 0 ? (
                <p className="px-2.5 py-1 text-[12.5px] text-faint">{t('No chats')}</p>
              ) : (
                list.map((chat) => <ChatRow key={chat.id} chat={chat} active={chat.id === activeChatId && !automationsView} onClick={() => void openChat(chat.id)} />)
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2.5 border-t border-line-soft px-3 py-2.5">
        {app?.user && <Avatar user={app.user} size={28} />}
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-[13px] font-medium">{app?.user?.name}</p>
          <p className="flex items-center gap-1.5 truncate text-[11.5px] text-faint">
            <span className={`size-1.5 rounded-full ${connection?.status === 'online' ? 'bg-ok' : connection?.status === 'connecting' ? 'bg-warn' : 'bg-bad'}`} />
            {connection?.status === 'online' ? app?.deviceName : connection?.status === 'connecting' ? (connection.error ?? t('Connecting…')) : (connection?.error ?? t('Offline'))}
          </p>
        </div>
        <IconButton title={t('Settings')} onClick={() => set({ settingsTab: 'account' })}>
          <Settings className="size-[17px]" />
        </IconButton>
      </div>
    </aside>
  );
}
