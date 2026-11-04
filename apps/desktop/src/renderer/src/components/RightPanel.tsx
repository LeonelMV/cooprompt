import { useCallback, useEffect, useState } from 'react';
import { File, FolderClosed, FolderOpen, RefreshCw, SquareTerminal, X } from 'lucide-react';
import type { ChatSummary, EngineId, Invitation } from '@cooprompt/protocol';
import type { Catalog, WorkspaceEntry } from '../../../shared/types.ts';
import { call } from '../lib/api.ts';
import { bytes, timeAgo } from '../lib/format.ts';
import { useT } from '../lib/i18n.ts';
import { useStore, type PanelTab } from '../lib/store.ts';
import { Avatar, Badge, Button, IconButton, Toggle } from './ui.tsx';

function FilesTab({ chat }: { chat: ChatSummary }) {
  const t = useT();
  const { views, sync, toast, patchView } = useStore();
  const local = views[chat.id]?.local;
  const status = sync[chat.id];
  const [tree, setTree] = useState<{ root: string; entries: WorkspaceEntry[]; truncated: boolean } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    void call('workspace.tree', chat.id).then(setTree).catch(() => setTree(null));
  }, [chat.id]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [refresh, status?.lastSyncAt]);

  const folder = local?.folder ?? tree?.root ?? null;
  const visible = (tree?.entries ?? []).filter((entry) => ![...collapsed].some((dir) => entry.path.startsWith(`${dir}/`)));

  const chooseFolder = async () => {
    const picked = await call('app.pickFolder', folder);
    if (!picked) return;
    const next = await call('chats.setPrefs', chat.id, { folder: picked });
    patchView(chat.id, (view) => {
      view.local = next;
    });
    refresh();
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-xl border border-line-soft bg-panel p-3">
        <p className="text-[11.5px] font-semibold uppercase tracking-wide text-faint">{chat.hasWorkspace ? t('Shared workspace') : t('Working folder')}</p>
        <p className="selectable break-all font-mono text-[11.5px] text-dim">{folder ?? (chat.hasWorkspace ? t('Created when the chat opens') : t('Created with the first request'))}</p>
        {chat.hasWorkspace && status && (
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
            <Badge tone={status.state === 'idle' ? 'ok' : status.state === 'error' || status.state === 'paused' ? 'bad' : 'accent'}>
              {status.state === 'idle' ? t('Synced') : status.state === 'syncing' ? t('Syncing ({count})', { count: status.pending }) : status.state === 'starting' ? t('Preparing') : status.state === 'paused' ? t('Paused') : t('Error')}
            </Badge>
            <span className="text-faint">{t('{count} files', { count: status.files })}</span>
            {status.lastSyncAt && <span className="text-faint">· {timeAgo(status.lastSyncAt, t)}</span>}
          </div>
        )}
        {status?.lastError && <p className="text-[12px] text-bad">{t.message(status.lastError)}</p>}
        {status && status.conflicts.length > 0 && (
          <div className="text-[12px] text-warn">
            {t('Conflicts (a copy of each version was kept):')}
            <ul className="mt-1 list-disc pl-4">
              {status.conflicts.map((conflict) => (
                <li key={conflict} className="break-all font-mono text-[11px]">
                  {conflict}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Button size="sm" disabled={!folder} onClick={() => folder && void call('app.revealPath', folder)}>
            <FolderOpen className="size-3.5" /> {t('Open folder')}
          </Button>
          <Button size="sm" disabled={!folder} onClick={() => folder && void call('app.openTerminal', folder).catch((error) => toast('error', error instanceof Error ? error.message : String(error)))}>
            <SquareTerminal className="size-3.5" /> Terminal
          </Button>
          {chat.hasWorkspace ? (
            <Button
              size="sm"
              onClick={() =>
                void call('workspace.resync', chat.id)
                  .then(() => toast('info', t('Workspace resynced')))
                  .catch((error) => toast('error', error.message))
              }
            >
              <RefreshCw className="size-3.5" /> {t('Resync')}
            </Button>
          ) : (
            <Button size="sm" onClick={() => void chooseFolder()}>
              {t('Choose folder…')}
            </Button>
          )}
        </div>
        {chat.hasWorkspace && <p className="text-[11.5px] leading-relaxed text-faint">{t('Whatever .gitignore ignores (.env, node_modules, builds) is not synced: everyone keeps their own secrets and dependencies.')}</p>}
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-[11.5px] font-semibold uppercase tracking-wide text-faint">{t('Files')}</p>
          <IconButton title={t('Refresh')} onClick={refresh} className="!size-6">
            <RefreshCw className="size-3" />
          </IconButton>
        </div>
        {visible.length === 0 ? (
          <p className="text-[12.5px] text-faint">{t('Empty. Ask the agent to clone a repo or create files.')}</p>
        ) : (
          <div className="font-mono text-[12px]">
            {visible.map((entry) => {
              const depth = entry.path.split('/').length - 1;
              const name = entry.path.split('/').pop();
              const isCollapsed = collapsed.has(entry.path);
              return (
                <div
                  key={entry.path}
                  className="flex items-center gap-1.5 rounded px-1 py-[1px] text-dim hover:bg-raised"
                  style={{ paddingLeft: depth * 12 + 4 }}
                  onClick={() => {
                    if (!entry.dir) return;
                    const next = new Set(collapsed);
                    if (isCollapsed) next.delete(entry.path);
                    else next.add(entry.path);
                    setCollapsed(next);
                  }}
                >
                  {entry.dir ? isCollapsed ? <FolderClosed className="size-3.5 shrink-0 text-accent" /> : <FolderOpen className="size-3.5 shrink-0 text-accent" /> : <File className="size-3.5 shrink-0 text-faint" />}
                  <span className="truncate">{name}</span>
                  {!entry.dir && <span className="ml-auto shrink-0 text-[10.5px] text-faint">{bytes(entry.size)}</span>}
                </div>
              );
            })}
            {tree?.truncated && <p className="mt-1 text-[11px] text-faint">{t('… list trimmed')}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function PeopleTab({ chat }: { chat: ChatSummary }) {
  const t = useT();
  const { views, app, set, toast, patchView } = useStore();
  const online = new Set(views[chat.id]?.online ?? []);
  const local = views[chat.id]?.local;
  const [pending, setPending] = useState<Invitation[]>([]);

  useEffect(() => {
    if (chat.isMember && chat.kind !== 'private') void call('invitations.forChat', chat.id).then(setPending).catch(() => {});
  }, [chat.id, chat.isMember, chat.kind, chat.members.length]);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        {chat.members.map((member) => (
          <div key={member.user.id} className="flex items-center gap-2.5 rounded-lg px-1 py-1">
            <Avatar user={member.user} size={28} online={online.has(member.user.id)} />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[13px] font-medium">
                {member.user.name} {member.user.id === app?.user?.id && <span className="text-faint">{t('(you)')}</span>}
              </p>
              <p className="truncate text-[11.5px] text-faint">{member.user.email}</p>
            </div>
            {member.role === 'owner' && <Badge>{t('owner')}</Badge>}
          </div>
        ))}
      </div>
      {pending.length > 0 && (
        <div>
          <p className="mb-1 text-[11.5px] font-semibold uppercase tracking-wide text-faint">{t('Pending invitations')}</p>
          {pending.map((invitation) => (
            <div key={invitation.id} className="flex items-center justify-between gap-2 py-1 text-[12.5px] text-dim">
              <span className="truncate">{invitation.inviteeEmail}</span>
              <IconButton
                title={t('Revoke')}
                className="!size-6"
                onClick={() => void call('invitations.revoke', invitation.id).then(() => setPending(pending.filter((inv) => inv.id !== invitation.id)))}
              >
                <X className="size-3.5" />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      {chat.kind === 'multiplayer' && chat.isMember && (
        <Button size="sm" className="w-full" onClick={() => set({ inviteOpen: true })}>
          {t('Invite someone')}
        </Button>
      )}
      {chat.kind !== 'private' && chat.isMember && (
        <div className="space-y-2 rounded-xl border border-line-soft bg-panel p-3">
          <Toggle
            checked={Boolean(local?.prefs.allowOthersToApprove)}
            onChange={(value) =>
              void call('chats.setPrefs', chat.id, { allowOthersToApprove: value })
                .then((next) =>
                  patchView(chat.id, (view) => {
                    view.local = next;
                  }),
                )
                .catch((error) => toast('error', error.message))
            }
            label={t('Let others approve my agent’s actions')}
          />
          <p className="text-[11.5px] leading-relaxed text-faint">{t('Off: only you approve what your agent runs on your computer. Any participant can answer the agent’s questions.')}</p>
        </div>
      )}
    </div>
  );
}

const AGENT_NAME: Record<EngineId, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor CLI' };

function AgentTab({ chat }: { chat: ChatSummary }) {
  const t = useT();
  const { engineInfo, set } = useStore();
  const info = engineInfo[chat.id];
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    void call('catalog.get', chat.id).then(setCatalog).catch(() => {});
  }, [chat.id, info?.at]);
  const workspaceSkills = catalog?.skills.filter((skill) => skill.scope === 'workspace') ?? [];
  return (
    <div className="space-y-4 text-[12.5px]">
      {info ? (
        <div className="space-y-3">
          <div className="space-y-0.5">
            <p className="text-[11.5px] font-semibold uppercase tracking-wide text-faint">{t('Last turn on this computer')}</p>
            <p className="text-dim">
              {AGENT_NAME[info.engine] ?? info.engine} {info.version ?? ''} · <span className="font-mono">{info.model ?? t('default model')}</span>
            </p>
          </div>
          {info.mcpServers && info.mcpServers.length > 0 && (
            <div>
              <p className="mb-1 text-[11.5px] font-semibold uppercase tracking-wide text-faint">{t('MCP connectors')}</p>
              <div className="flex flex-wrap gap-1">
                {info.mcpServers.map((server) => (
                  <Badge key={server.name} tone={server.status === 'connected' || server.status === 'configured' ? 'ok' : server.status === 'needs-auth' ? 'warn' : server.status === 'pending' ? 'neutral' : 'bad'}>
                    {server.name} · {server.status}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {info.skills && info.skills.length > 0 && (
            <div>
              <p className="mb-1 text-[11.5px] font-semibold uppercase tracking-wide text-faint">Skills ({info.skills.length})</p>
              <p className="font-mono text-[11.5px] leading-relaxed text-dim">{info.skills.join(' · ')}</p>
            </div>
          )}
          {info.agents && info.agents.length > 0 && (
            <div>
              <p className="mb-1 text-[11.5px] font-semibold uppercase tracking-wide text-faint">{t('Subagents')}</p>
              <p className="font-mono text-[11.5px] leading-relaxed text-dim">{info.agents.join(' · ')}</p>
            </div>
          )}
          {info.slashCommands && info.slashCommands.length > 0 && (
            <div>
              <p className="mb-1 text-[11.5px] font-semibold uppercase tracking-wide text-faint">{t('Commands')}</p>
              <p className="font-mono text-[11.5px] leading-relaxed text-dim">{info.slashCommands.map((command) => `/${command}`).join('  ')}</p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-faint">{t('After the first turn on this computer you will see here which skills, subagents, commands and MCP connectors the engine loaded.')}</p>
      )}
      <div className="space-y-1.5 rounded-xl border border-line-soft bg-panel p-3">
        <p className="text-[11.5px] font-semibold uppercase tracking-wide text-faint">{chat.hasWorkspace ? t('From the workspace (shared)') : t('From the workspace')}</p>
        <p className="text-dim">
          {t('{skills} skills · {agents} agents', { skills: workspaceSkills.length, agents: catalog?.agents.filter((agent) => agent.scope === 'workspace').length ?? 0 })} ·{' '}
          {catalog?.memory.filter((file) => file.scope === 'workspace' && file.exists).map((file) => file.label.split(' ')[0]).join(', ') || t('no AGENTS.md/CLAUDE.md')}
        </p>
        {chat.hasWorkspace && <p className="text-[11.5px] text-faint">{t('Whatever you put in this folder’s .claude/skills, .claude/agents or AGENTS.md is used by everyone’s agents.')}</p>}
        <div className="flex gap-1.5 pt-1">
          <Button size="sm" onClick={() => set({ settingsTab: 'skills' })}>
            {t('Skills & agents')}
          </Button>
          <Button size="sm" onClick={() => set({ settingsTab: 'memory' })}>
            {t('Memory')}
          </Button>
        </div>
      </div>
    </div>
  );
}

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'files', label: 'Files' },
  { id: 'people', label: 'People' },
  { id: 'agent', label: 'Agent' },
];

export function RightPanel() {
  const t = useT();
  const { activeChatId, chats, panel, set } = useStore();
  const chat = activeChatId ? chats[activeChatId] : undefined;
  if (!chat || !panel) return null;
  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l border-line-soft bg-inset">
      <div className="drag flex h-[52px] shrink-0 items-center gap-1 border-b border-line-soft px-3">
        {TABS.map((tab) => (
          <button key={tab.id} onClick={() => set({ panel: tab.id })} className={`rounded-md px-2.5 py-1 text-[12.5px] cursor-default ${panel === tab.id ? 'bg-raised text-ink' : 'text-dim hover:text-ink'}`}>
            {t(tab.label)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {panel === 'files' && <FilesTab chat={chat} />}
        {panel === 'people' && <PeopleTab chat={chat} />}
        {panel === 'agent' && <AgentTab chat={chat} />}
      </div>
    </aside>
  );
}
