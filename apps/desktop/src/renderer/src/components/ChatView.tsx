import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bot, Building2, FolderOpen, LogOut, MoreHorizontal, PanelRight, Pencil, Trash2, UserPlus, Users } from 'lucide-react';
import type { ChatSummary } from '@cooprompt/protocol';
import { call } from '../lib/api.ts';
import { KIND_LABEL } from '../lib/format.ts';
import { useT } from '../lib/i18n.ts';
import { useStore } from '../lib/store.ts';
import { ChatAutomationsButton } from './automations/AutomationEntry.tsx';
import { Composer } from './Composer.tsx';
import { Transcript } from './Transcript.tsx';
import { Avatar, Badge, Button, Empty, IconButton, Logo, Spinner } from './ui.tsx';

function Header({ chat }: { chat: ChatSummary }) {
  const t = useT();
  const { views, app, set, panel, toast, sync } = useStore();
  const view = views[chat.id];
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const [menu, setMenu] = useState(false);
  const online = new Set(view?.online ?? []);
  const typing = (view?.typing ?? []).filter((id) => id !== app?.user?.id).map((id) => chat.members.find((member) => member.user.id === id)?.user.name).filter(Boolean);
  const status = sync[chat.id];

  useEffect(() => setTitle(chat.title), [chat.title]);

  const rename = async () => {
    setEditing(false);
    if (title.trim() && title.trim() !== chat.title) await call('chats.rename', chat.id, title.trim()).catch((error) => toast('error', error.message));
  };

  const syncLabel = !status
    ? ''
    : status.state === 'syncing'
      ? t('Syncing {count}…', { count: status.pending })
      : status.state === 'error'
        ? t('Sync error')
        : status.state === 'paused'
          ? t('Sync paused')
          : status.state === 'starting'
            ? t('Preparing workspace…')
            : t('Workspace synced');

  return (
    <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-line-soft px-5">
      {editing ? (
        <input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(event) => event.key === 'Enter' && void rename()}
          className="no-drag h-8 rounded-md border border-line bg-inset px-2 text-[14.5px] font-semibold outline-none"
        />
      ) : (
        <h1 className="truncate text-[14.5px] font-semibold" onDoubleClick={() => chat.isMember && setEditing(true)}>
          {chat.title}
        </h1>
      )}
      <Badge tone={chat.kind === 'private' ? 'neutral' : 'accent'}>
        {chat.kind === 'corporate' && <Building2 className="size-3" />}
        {chat.kind === 'multiplayer' && <Users className="size-3" />}
        {t(KIND_LABEL[chat.kind])}
      </Badge>
      {status && chat.hasWorkspace && (
        <span className="text-[11.5px] text-faint" title={status.lastError ?? status.root}>
          {syncLabel}
        </span>
      )}
      <div className="flex-1" />
      {typing.length > 0 && <span className="text-[12px] italic text-faint">{t('{names} is typing…', { names: typing.join(', ') })}</span>}
      {chat.kind !== 'private' && (
        <div className="no-drag flex -space-x-1.5">
          {chat.members.slice(0, 6).map((member) => (
            <Avatar key={member.user.id} user={member.user} size={24} online={online.has(member.user.id)} />
          ))}
        </div>
      )}
      {chat.kind === 'multiplayer' && chat.isMember && (
        <Button size="sm" onClick={() => set({ inviteOpen: true })}>
          <UserPlus className="size-3.5" /> {t('Invite')}
        </Button>
      )}
      <ChatAutomationsButton chat={chat} />
      <IconButton title={t('Open working folder')} onClick={() => view?.local?.folder && void call('app.revealPath', view.local.folder)} disabled={!view?.local?.folder}>
        <FolderOpen className="size-4" />
      </IconButton>
      <IconButton title={t('Side panel')} active={panel !== null} onClick={() => set({ panel: panel ? null : 'files' })}>
        <PanelRight className="size-4" />
      </IconButton>
      <div className="no-drag relative">
        <IconButton title={t('More actions')} onClick={() => setMenu(!menu)}>
          <MoreHorizontal className="size-4" />
        </IconButton>
        {menu && (
          <div className="absolute right-0 top-9 z-30 w-52 overflow-hidden rounded-xl border border-line bg-raised py-1 shadow-xl" onMouseLeave={() => setMenu(false)}>
            {chat.isMember && (
              <button className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] hover:bg-raised-hover cursor-default" onClick={() => (setMenu(false), setEditing(true))}>
                <Pencil className="size-3.5" /> {t('Rename')}
              </button>
            )}
            {chat.isMember && chat.kind !== 'private' && chat.ownerId !== app?.user?.id && (
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] hover:bg-raised-hover cursor-default"
                onClick={() => {
                  setMenu(false);
                  void call('chats.leave', chat.id).catch((error) => toast('error', error.message));
                }}
              >
                <LogOut className="size-3.5" /> {t('Leave chat')}
              </button>
            )}
            {chat.ownerId === app?.user?.id && (
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-[#f0a3a3] hover:bg-raised-hover cursor-default"
                onClick={() => {
                  setMenu(false);
                  if (confirm(t('Delete "{title}" for everyone? Local files are not deleted.', { title: chat.title }))) {
                    void call('chats.delete', chat.id).catch((error) => toast('error', error.message));
                  }
                }}
              >
                <Trash2 className="size-3.5" /> {t('Delete chat')}
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

function Welcome() {
  const t = useT();
  const { set, app, providers } = useStore();
  return (
    <div className="flex h-full flex-col">
      <div className="drag h-[52px] shrink-0" />
      <div className="flex flex-1 items-center justify-center">
        <div className="max-w-lg space-y-5 text-center">
          <Logo size={48} className="mx-auto" />
          <h2 className="text-[22px] font-semibold">{app?.user ? t('Hi, {name}', { name: app.user.name.split(' ')[0] }) : t('Hi')}</h2>
          <p className="text-[14px] leading-relaxed text-dim">{t('Create a private chat to work alone, a multiplayer one to invite someone, or a company chat your whole organization can see.')}</p>
          {providers && providers.profiles.length === 0 && (
            <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-[13px] text-[#e1bd99]">
              {t('You have not set up a model yet.')}{' '}
              <button className="underline cursor-default" onClick={() => set({ settingsTab: 'models' })}>
                {t('Add your Claude, Codex or Cursor sign-in, or an API key')}
              </button>
            </div>
          )}
          <div className="flex justify-center gap-2">
            <Button variant="primary" onClick={() => set({ newChatOpen: true })}>
              <Bot className="size-4" /> {t('New chat')}
            </Button>
            <Button onClick={() => set({ settingsTab: 'connectors' })}>{t('MCP connectors')}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChatView() {
  const t = useT();
  const { activeChatId, chats, views } = useStore();
  const chat = activeChatId ? chats[activeChatId] : undefined;
  const view = activeChatId ? views[activeChatId] : undefined;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const focus = useStore((state) => state.focus);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  });

  useEffect(() => {
    stick.current = true;
  }, [activeChatId]);

  // A run opened from the automations or a notification: scroll to its turn once it is shown.
  useEffect(() => {
    if (!focus || focus.chatId !== activeChatId || !view?.loaded) return;
    const target = document.getElementById(`turn-${focus.turnId}`);
    if (!target) return;
    stick.current = false;
    target.scrollIntoView({ block: 'start' });
    useStore.getState().set({ focus: null });
  }, [focus, activeChatId, view?.loaded, view?.items]);

  if (!chat) return <Welcome />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header chat={chat} />
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        {!view?.loaded ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : Object.keys(view.items).length === 0 ? (
          <Empty icon={<Bot className="size-8" />} title={t('Start the conversation')}>
            {chat.kind === 'private'
              ? t('The agent works in this chat’s folder with your tools and credentials.')
              : t('This chat’s folder syncs with every participant: ask the agent to clone a repo and everyone gets it.')}
          </Empty>
        ) : (
          <Transcript chat={chat} view={view} />
        )}
      </div>
      {view?.loaded && <Composer chat={chat} view={view} />}
    </div>
  );
}
