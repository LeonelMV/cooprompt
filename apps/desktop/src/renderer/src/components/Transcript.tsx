import { useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Bot, Brain, CheckCircle2, ChevronRight, Circle, CircleDot, Clock, EyeOff, Layers, ListTodo, Loader2, ShieldAlert, Square, X } from 'lucide-react';
import type {
  ChatSummary,
  PermissionItemData,
  PublicUser,
  QuestionItemData,
  TeamItemData,
  TextItemData,
  TodoItemData,
  ToolItemData,
  TranscriptItem,
  TurnInfo,
  UserItemData,
} from '@cooprompt/protocol';
import { promptText } from '@cooprompt/protocol';
import { EFFORT_LABEL } from '../../../shared/effort.ts';
import { engineName } from '../../../shared/engines.ts';
import { currentProfileLabel } from '../../../shared/profile-label.ts';
import { call } from '../lib/api.ts';
import { deduplicateCodexWarnings, isCodexWarning } from '../lib/codex-warnings.ts';
import { clock, contextShare, engineBadge, tokens, toolLabel, toolSummary } from '../lib/format.ts';
import { useT, type T } from '../lib/i18n.ts';
import { useStore, type ChatViewState } from '../lib/store.ts';
import { groupActivity } from '../lib/tools.ts';
import { AttachmentList } from './Attachments.tsx';
import { AutomationPrompt } from './automations/AutomationEntry.tsx';
import { Markdown } from './Markdown.tsx';
import { ActivityGroup, ToolRow } from './ToolActivity.tsx';
import { Avatar, Badge, Button } from './ui.tsx';

type Block =
  | { kind: 'turn'; turnId: string; anchor: number; prompt: TranscriptItem | null; items: TranscriptItem[] }
  | { kind: 'notice'; anchor: number; item: TranscriptItem }
  /** Someone's message without a turn: team-only, or shared with the AI afterwards. */
  | { kind: 'message'; anchor: number; item: TranscriptItem };

function useUsers(chat: ChatSummary): Map<string, PublicUser> {
  return useMemo(() => new Map(chat.members.map((member) => [member.user.id, member.user])), [chat.members]);
}

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[13px] text-faint">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 cursor-default hover:text-dim">
        <Brain className="size-3.5" /> {live ? t('Thinking…') : t('Reasoning')}
        <ChevronRight className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {(open || live) && <div className={`selectable mt-1 whitespace-pre-wrap border-l-2 border-line pl-3 italic ${live ? 'max-h-32 overflow-hidden' : ''}`}>{live ? text.slice(-600) : text}</div>}
    </div>
  );
}

function PermissionCard({ item, turn, chat }: { item: TranscriptItem; turn: TurnInfo | undefined; chat: ChatSummary }) {
  const t = useT();
  const data = item.data as PermissionItemData;
  const me = useStore((state) => state.app?.user?.id);
  const toast = useStore((state) => state.toast);
  const users = useUsers(chat);
  const [busy, setBusy] = useState(false);
  const executor = turn ? users.get(turn.requesterId) : undefined;
  const isExecutor = turn?.requesterId === me;
  const pending = data.status === 'pending' && turn?.status === 'running';
  const canDecide = pending && chat.isMember && (isExecutor || data.othersCanDecide);
  const decide = async (allow: boolean, always = false) => {
    if (!turn) return;
    setBusy(true);
    try {
      await call('decisions.respond', { chatId: chat.id, turnId: turn.id, itemId: item.id, decision: { type: 'permission', allow, always } });
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const decidedBy = data.decidedBy ? (users.get(data.decidedBy)?.name ?? t('someone')) : null;
  return (
    <div className={`rounded-xl border p-3 ${pending ? 'border-warn/50 bg-warn/[0.07]' : 'border-line-soft bg-panel'}`}>
      <div className="flex items-start gap-2.5">
        <ShieldAlert className={`mt-0.5 size-4 shrink-0 ${pending ? 'text-warn' : 'text-faint'}`} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-[13.5px] font-medium">{data.title ?? t('Permission to use {tool}', { tool: toolLabel(data.toolName) })}</p>
          {data.description && <p className="text-[12.5px] text-dim">{data.description}</p>}
          <pre className="selectable max-h-40 overflow-auto rounded-lg bg-side p-2 font-mono text-[11.5px] text-dim">{toolSummary(data.toolName, data.input) || JSON.stringify(data.input, null, 2)}</pre>
          {canDecide ? (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" variant="primary" busy={busy} onClick={() => void decide(true)}>
                {t('Allow')}
              </Button>
              {data.allowAlways && (
                <Button size="sm" busy={busy} onClick={() => void decide(true, true)}>
                  {t('Always allow in this chat')}
                </Button>
              )}
              <Button size="sm" variant="danger" busy={busy} onClick={() => void decide(false)}>
                {t('Deny')}
              </Button>
              {!isExecutor && <span className="self-center text-[11.5px] text-faint">{t('Runs on {name}’s computer', { name: executor?.name })}</span>}
            </div>
          ) : pending ? (
            <p className="text-[12.5px] text-warn">{t('Waiting for {name} to approve (it runs on their computer)', { name: executor?.name ?? t('the person running it') })}</p>
          ) : (
            <p className="text-[12px] text-faint">
              {data.status === 'allowed'
                ? decidedBy
                  ? t('Allowed by {name}', { name: decidedBy })
                  : t('Allowed')
                : data.status === 'denied'
                  ? decidedBy
                    ? t('Denied by {name}', { name: decidedBy })
                    : t('Denied')
                  : turn?.automation
                    ? t('Declined automatically: nobody can approve during an automation run')
                    : t('No answer')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function QuestionCard({ item, turn, chat }: { item: TranscriptItem; turn: TurnInfo | undefined; chat: ChatSummary }) {
  const t = useT();
  const data = item.data as QuestionItemData;
  const toast = useStore((state) => state.toast);
  const users = useUsers(chat);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const pending = data.status === 'pending' && turn?.status === 'running' && chat.isMember;
  const toggle = (question: string, label: string, multi: boolean) =>
    setSelected((current) => {
      const list = current[question] ?? [];
      return { ...current, [question]: multi ? (list.includes(label) ? list.filter((entry) => entry !== label) : [...list, label]) : [label] };
    });
  const submit = async () => {
    if (!turn) return;
    const answers: Record<string, string> = {};
    for (const question of data.questions) {
      const values = [...(selected[question.question] ?? []), ...(other[question.question]?.trim() ? [other[question.question].trim()] : [])];
      answers[question.question] = values.join(', ');
    }
    setBusy(true);
    try {
      await call('decisions.respond', { chatId: chat.id, turnId: turn.id, itemId: item.id, decision: { type: 'question', answers } });
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`space-y-3 rounded-xl border p-3 ${pending ? 'border-accent/50 bg-accent/[0.06]' : 'border-line-soft bg-panel'}`}>
      {data.questions.map((question) => (
        <div key={question.question} className="space-y-2">
          {question.header && <Badge tone="accent">{question.header}</Badge>}
          <p className="text-[13.5px] font-medium">{question.question}</p>
          <div className="flex flex-wrap gap-1.5">
            {question.options.map((option) => {
              const active = (selected[question.question] ?? []).includes(option.label) || data.answers?.[question.question]?.split(', ').includes(option.label);
              return (
                <button
                  key={option.label}
                  disabled={!pending}
                  title={option.description}
                  onClick={() => toggle(question.question, option.label, Boolean(question.multiSelect))}
                  className={`rounded-lg border px-2.5 py-1 text-[12.5px] cursor-default ${active ? 'border-accent bg-accent/20 text-ink' : 'border-line text-dim hover:text-ink'} disabled:opacity-70`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {pending && (
            <input
              value={other[question.question] ?? ''}
              onChange={(event) => setOther({ ...other, [question.question]: event.target.value })}
              placeholder={t('Other answer…')}
              className="h-8 w-full rounded-lg border border-line bg-inset px-2.5 text-[12.5px] outline-none"
            />
          )}
        </div>
      ))}
      {pending ? (
        <Button size="sm" variant="primary" busy={busy} onClick={() => void submit()}>
          {t('Answer')}
        </Button>
      ) : (
        <p className="text-[12px] text-faint">
          {data.status === 'answered'
            ? t('Answered by {name}', { name: data.answeredBy ? (users.get(data.answeredBy)?.name ?? t('someone')) : t('someone') })
            : turn?.automation
              ? t('Not asked: nobody can answer during an automation run')
              : t('No answer')}
        </p>
      )}
    </div>
  );
}

function TeamMessage({ item, chat }: { item: TranscriptItem; chat: ChatSummary }) {
  const t = useT();
  const users = useUsers(chat);
  const me = useStore((state) => state.app?.user?.id);
  const toast = useStore((state) => state.toast);
  const [busy, setBusy] = useState(false);
  const author = item.authorId ? users.get(item.authorId) : undefined;
  const shared = item.kind === 'user';
  const data = item.data as TeamItemData;
  const typed = shared ? promptText(item.data as UserItemData) : data.text;
  const share = async () => {
    if (!confirm(t('Share this message with the AI? Every agent in this chat will get it as context from its next turn on. This can’t be undone.'))) return;
    setBusy(true);
    try {
      await call('chats.shareTeam', { chatId: chat.id, itemId: item.id });
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="group flex gap-3">
      {author ? <Avatar user={author} size={28} /> : <span className="size-7" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-semibold">{author?.name ?? t('Someone')}</span>
          <span className="text-[11.5px] text-faint">{clock(item.createdAt, t)}</span>
          {shared ? (
            <Badge tone="neutral">
              <Bot className="size-3" /> {t('Shared with the AI')}
            </Badge>
          ) : (
            <Badge tone="team">
              <EyeOff className="size-3" /> {t('Team only · the AI doesn’t see it')}
            </Badge>
          )}
          {!shared && item.authorId === me && chat.isMember && (
            <Button
              size="sm"
              variant="ghost"
              busy={busy}
              onClick={() => void share()}
              className="ml-auto h-6 px-1.5 opacity-0 focus:opacity-100 group-hover:opacity-100"
              title={t('Every agent in this chat gets it from its next turn on')}
            >
              <Bot className="size-3" /> {t('Share with the AI')}
            </Button>
          )}
        </div>
        <div className={`mt-1 space-y-2 ${shared ? '' : 'rounded-xl border border-team/25 bg-team/[0.06] px-3 py-2'}`}>
          {typed && <div className="selectable whitespace-pre-wrap text-[14px] leading-relaxed">{typed}</div>}
          <AttachmentList chatId={chat.id} files={data.attachments} />
        </div>
      </div>
    </div>
  );
}

function TodoCard({ item }: { item: TranscriptItem }) {
  const t = useT();
  const data = item.data as TodoItemData;
  return (
    <div className="rounded-xl border border-line-soft bg-panel p-3">
      <p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-faint">
        <ListTodo className="size-3.5" /> {t('Plan')}
      </p>
      <ul className="space-y-1">
        {data.items.map((todo, index) => (
          <li key={index} className={`flex items-start gap-2 text-[13px] ${todo.status === 'completed' ? 'text-faint line-through' : 'text-ink'}`}>
            {todo.status === 'completed' ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ok" /> : todo.status === 'in_progress' ? <CircleDot className="mt-0.5 size-3.5 shrink-0 text-accent" /> : <Circle className="mt-0.5 size-3.5 shrink-0 text-faint" />}
            {todo.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ItemView({ item, nested, turn, chat }: { item: TranscriptItem; nested: TranscriptItem[]; turn?: TurnInfo; chat?: ChatSummary }) {
  const t = useT();
  switch (item.kind) {
    case 'text': {
      const data = item.data as TextItemData;
      const answer = <Markdown text={data.text} className="selectable text-[14px]" />;
      return data.attachments?.length ? (
        <div className="space-y-2.5">
          {answer}
          <AttachmentList chatId={item.chatId} files={data.attachments} />
        </div>
      ) : (
        answer
      );
    }
    case 'thinking':
      return <Thinking text={(item.data as { text: string }).text} />;
    case 'tool':
      return <ToolRow item={item} nested={nested} turnRunning={turn?.status === 'running'} renderItem={(child) => <ItemView key={child.id} item={child} nested={[]} turn={turn} />} />;
    case 'permission':
      return chat ? <PermissionCard item={item} turn={turn} chat={chat} /> : null;
    case 'question':
      return chat ? <QuestionCard item={item} turn={turn} chat={chat} /> : null;
    case 'todo':
      return <TodoCard item={item} />;
    case 'notice':
      return <p className="text-[12.5px] text-warn">{t.message((item.data as { text: string }).text)}</p>;
    case 'error':
      if (isCodexWarning((item.data as { message: string }).message)) {
        return (
          <div className="selectable flex gap-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-[13px] text-[#e1bd99]">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span className="whitespace-pre-wrap">{t.message((item.data as { message: string }).message)}</span>
          </div>
        );
      }
      return (
        <div className="selectable flex gap-2 rounded-xl border border-bad/40 bg-bad/10 p-3 text-[13px] text-[#f5c2be]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span className="whitespace-pre-wrap">{t.message((item.data as { message: string }).message)}</span>
        </div>
      );
    default:
      return null;
  }
}

function TurnStatus({ turn }: { turn: TurnInfo | undefined }) {
  const t = useT();
  if (!turn) return null;
  switch (turn.status) {
    case 'queued':
      return (
        <Badge tone="neutral">
          <Clock className="size-3" /> {t('Queued')}
        </Badge>
      );
    case 'running':
      return (
        <Badge tone="accent">
          <Loader2 className="size-3 animate-spin" /> {t('Working')}
        </Badge>
      );
    case 'failed':
      return <Badge tone="bad">{t('Failed')}</Badge>;
    case 'cancelled':
      return (
        <>
          <Badge tone="warn">
            <X className="size-3" /> {turn.error ? t.message(turn.error) : t('Cancelled')}
          </Badge>
          <TurnContext turn={turn} />
        </>
      );
    case 'done': {
      const usage = turn.usage;
      const parts = [usage?.durationMs ? `${Math.round(usage.durationMs / 1000)} s` : null, usage?.costUsd ? `US$ ${usage.costUsd.toFixed(3)}` : null].filter(Boolean);
      return (
        <>
          {parts.length > 0 && <span className="text-[11.5px] text-faint">{parts.join(' · ')}</span>}
          <TurnContext turn={turn} />
        </>
      );
    }
  }
}

/** Published by the executor, so everyone sees how full that person's agent session is. */
function TurnContext({ turn }: { turn: TurnInfo }) {
  const t = useT();
  const usage = turn.usage;
  const share = contextShare(usage);
  if (share === null || !usage?.contextWindow) return null;
  return (
    <span className="text-[11.5px] text-faint" title={t('{used} of {total} tokens in this session’s context', { used: tokens(usage.contextTokens ?? 0, t), total: tokens(usage.contextWindow, t) })}>
      {t('{percent}% of context', { percent: share })}
    </span>
  );
}

/** Why a queued turn hasn't started, following the server's rules (see `scheduleChat` in the hub). */
function waitingReason(turn: TurnInfo, view: ChatViewState, max: number | null, executorName: string, t: T): string {
  const running = Object.values(view.turns).filter((entry) => entry.status === 'running');
  if (turn.interrupts && view.turns[turn.interrupts]?.status === 'running') return t('Waiting for the interrupted turn to stop. It will run on {name}’s computer.', { name: executorName });
  if (!turn.parallel) {
    return running.length > 1
      ? t('Waiting for the running turns to finish. It will run on {name}’s computer.', { name: executorName })
      : t('Waiting for the current turn to finish. It will run on {name}’s computer.', { name: executorName });
  }
  if (max !== null && running.length >= max) return t('Waiting for one of the {count} running turns to finish. It will run on {name}’s computer.', { count: running.length, name: executorName });
  return t('Waiting for the messages sent before it to start. It will run on {name}’s computer.', { name: executorName });
}

function TurnBlock({ block, view, chat }: { block: Extract<Block, { kind: 'turn' }>; view: ChatViewState; chat: ChatSummary }) {
  const t = useT();
  const users = useUsers(chat);
  const me = useStore((state) => state.app?.user?.id);
  const maxParallel = useStore((state) => state.app?.maxParallelTurns ?? null);
  const toast = useStore((state) => state.toast);
  const turn = view.turns[block.turnId];
  const draft = view.drafts[block.turnId];
  const requester = block.prompt?.authorId ? users.get(block.prompt.authorId) : undefined;
  const executorName = turn ? (users.get(turn.requesterId)?.name ?? t('someone')) : '';
  const children = useMemo(() => {
    const map = new Map<string, TranscriptItem[]>();
    for (const item of block.items) {
      const parent = (item.data as { parentToolId?: string | null }).parentToolId;
      if (parent) map.set(parent, [...(map.get(parent) ?? []), item]);
    }
    return map;
  }, [block.items]);
  const topLevel = deduplicateCodexWarnings(block.items.filter((item) => !(item.data as { parentToolId?: string | null }).parentToolId));
  const activity = useMemo(() => groupActivity(topLevel), [block.items]);
  const engine = turn?.config.engine;
  const running = turn?.status === 'running';
  const effort = turn?.config.effort;
  // The server lets the requester and the chat owner stop a turn.
  const stoppable = Boolean(turn && (turn.status === 'running' || turn.status === 'queued') && (turn.requesterId === me || chat.ownerId === me));
  const renderItem = (item: TranscriptItem) => <ItemView key={item.id} item={item} nested={children.get((item.data as ToolItemData).toolUseId) ?? []} turn={turn} chat={chat} />;

  return (
    <div id={`turn-${block.turnId}`} className="space-y-3">
      {turn?.automation && <AutomationPrompt turn={turn} prompt={block.prompt} owner={users.get(turn.requesterId)} />}
      {block.prompt && !turn?.automation && (
        <div className="flex gap-3">
          {requester ? <Avatar user={requester} size={28} /> : <span className="size-7" />}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-semibold">{requester?.name ?? t('Someone')}</span>
              <span className="text-[11.5px] text-faint">{clock(block.prompt.createdAt, t)}</span>
            </div>
            {promptText(block.prompt.data as UserItemData) && <div className="selectable mt-0.5 whitespace-pre-wrap text-[14px] leading-relaxed">{promptText(block.prompt.data as UserItemData)}</div>}
            {(block.prompt.data as UserItemData).attachments?.length ? (
              <div className="mt-2">
                <AttachmentList chatId={chat.id} files={(block.prompt.data as UserItemData).attachments} />
              </div>
            ) : null}
          </div>
        </div>
      )}
      <div className="flex gap-3">
        <div className={`flex size-7 shrink-0 items-center justify-center rounded-lg text-[12px] font-bold ${engineBadge(engine).className}`}>{engineBadge(engine).text}</div>
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-faint">
            <span className="font-medium text-dim">{currentProfileLabel(turn?.providerLabel ?? engineName(engine))}</span>
            {effort && <span>· {t('Effort: {level}', { level: t(EFFORT_LABEL[effort] ?? effort) })}</span>}
            {turn && (
              <span>
                · {t('on {name}’s computer ({device})', { name: executorName, device: turn.deviceName })}
              </span>
            )}
            {turn?.parallel && !turn.automation && (
              <span title={t('Sent in multitask mode: it runs beside the other turns instead of waiting for them')}>
                <Badge tone="neutral">
                  <Layers className="size-3" /> {t('Multitask')}
                </Badge>
              </span>
            )}
            <TurnStatus turn={turn} />
            {stoppable && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 px-1.5"
                onClick={() => void call('turns.cancel', turn!.id).catch((error) => toast('error', error instanceof Error ? error.message : String(error)))}
                title={t('Stop this turn')}
              >
                <Square className="size-3" /> {t('Stop')}
              </Button>
            )}
          </div>
          {activity.map((entry, index) =>
            entry.kind === 'group' ? (
              <ActivityGroup
                key={entry.id}
                items={entry.items}
                live={running && index === activity.length - 1 && draft?.kind !== 'text'}
                turnRunning={running}
                childrenOf={(toolUseId) => children.get(toolUseId) ?? []}
                renderItem={renderItem}
              />
            ) : (
              renderItem(entry.item)
            ),
          )}
          {draft && draft.kind === 'text' && <Markdown text={draft.text} className="caret selectable text-[14px]" />}
          {draft && draft.kind === 'thinking' && <Thinking text={draft.text} live />}
          {turn?.status === 'running' && !draft && topLevel.length === 0 && <p className="text-[13px] text-faint">{t('Preparing the workspace and the agent…')}</p>}
          {turn?.status === 'queued' && <p className="text-[13px] text-faint">{waitingReason(turn, view, maxParallel, executorName, t)}</p>}
          {turn?.status === 'failed' && turn.error && !topLevel.some((item) => item.kind === 'error') && <ItemView item={{ ...block.items[0], id: 'error', kind: 'error', data: { message: turn.error } } as TranscriptItem} nested={[]} />}
        </div>
      </div>
    </div>
  );
}

export function Transcript({ chat, view }: { chat: ChatSummary; view: ChatViewState }): ReactNode {
  const t = useT();
  const blocks = useMemo(() => {
    const byTurn = new Map<string, Extract<Block, { kind: 'turn' }>>();
    const result: Block[] = [];
    for (const item of Object.values(view.items).sort((a, b) => a.seq - b.seq)) {
      // The line apps that predate automations show; this app labels the turn instead.
      if (item.id === `${item.turnId}.automation`) continue;
      if (!item.turnId) {
        result.push({ kind: item.kind === 'team' || item.kind === 'user' ? 'message' : 'notice', anchor: item.seq, item });
        continue;
      }
      let block = byTurn.get(item.turnId);
      if (!block) {
        block = { kind: 'turn', turnId: item.turnId, anchor: item.seq, prompt: null, items: [] };
        byTurn.set(item.turnId, block);
        result.push(block);
      }
      if (item.kind === 'user') {
        block.prompt = item;
        block.anchor = item.seq;
      } else block.items.push(item);
    }
    return result.sort((a, b) => a.anchor - b.anchor);
  }, [view.items]);

  return (
    <div className="mx-auto w-full max-w-[860px] space-y-7 px-6 py-6">
      {blocks.map((block) =>
        block.kind === 'notice' ? (
          <p key={block.item.id} className="text-center text-[12px] text-faint">
            {t.message((block.item.data as { text: string }).text)} · {clock(block.item.createdAt, t)}
          </p>
        ) : block.kind === 'message' ? (
          <TeamMessage key={block.item.id} item={block.item} chat={chat} />
        ) : (
          <TurnBlock key={block.turnId} block={block} view={view} chat={chat} />
        ),
      )}
    </div>
  );
}
