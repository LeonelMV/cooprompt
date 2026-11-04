import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, CheckCheck, ChevronDown, ChevronRight, CirclePause, History, Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import type { AutomationInfo, AutomationRun } from '@cooprompt/protocol';
import { call } from '../../lib/api.ts';
import { accessOf, describeSchedule, duration, mine, RUN_STATUS, TRIGGER_LABEL, unread, when } from '../../lib/automations.ts';
import { useT, type T } from '../../lib/i18n.ts';
import { useStore } from '../../lib/store.ts';
import { Avatar, Badge, Button, Empty, IconButton, Toggle } from '../ui.tsx';

type Tab = 'inbox' | 'automations';

function useOpenRun() {
  const { set, openChat, readRuns } = useStore();
  return (run: AutomationRun) => {
    if (!run.turnId) return;
    set({ focus: { chatId: run.chatId, turnId: run.turnId } });
    readRuns({ ids: [run.id] });
    void openChat(run.chatId);
  };
}

function runDetail(run: AutomationRun, t: T): string {
  if (run.status === 'done' && run.startedAt && run.finishedAt) return t('Took {duration}', { duration: duration(run.finishedAt - run.startedAt, t) });
  if (run.error) return t.message(run.error);
  return t(RUN_STATUS[run.status].label);
}

function RunRow({ run, chatTitle }: { run: AutomationRun; chatTitle: string }) {
  const t = useT();
  const open = useOpenRun();
  const status = RUN_STATUS[run.status];
  return (
    <button
      onClick={() => open(run)}
      disabled={!run.turnId}
      className="group flex w-full items-start gap-3 rounded-xl border border-line-soft bg-panel px-3.5 py-2.5 text-left cursor-default hover:border-line disabled:hover:border-line-soft"
    >
      <span className={`mt-[7px] size-2 shrink-0 rounded-full ${unread(run) ? 'bg-accent' : 'bg-transparent'}`} title={unread(run) ? t('Not seen yet') : undefined} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13.5px] font-medium">{run.automationName}</span>
          <Badge tone={status.tone}>{t(status.label)}</Badge>
          {run.trigger !== 'schedule' && <span className="text-[11.5px] text-faint">{t(TRIGGER_LABEL[run.trigger])}</span>}
        </div>
        <p className="truncate text-[12.5px] text-dim">{runDetail(run, t)}</p>
        <p className="truncate text-[11.5px] text-faint">
          {chatTitle} · {when(run.startedAt ?? run.scheduledFor ?? run.createdAt, t)}
        </p>
      </div>
      {run.turnId && <ChevronRight className="mt-1 size-4 shrink-0 text-faint group-hover:text-dim" />}
    </button>
  );
}

function HistoryList({ automation }: { automation: AutomationInfo }) {
  const t = useT();
  const open = useOpenRun();
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const lastRun = automation.lastRun;
  useEffect(() => {
    let cancelled = false;
    call('automations.history', automation.id)
      .then((list) => !cancelled && setRuns(list))
      .catch(() => !cancelled && setRuns([]));
    return () => {
      cancelled = true;
    };
  }, [automation.id, lastRun?.id, lastRun?.status]);
  if (!runs) return <p className="px-1 py-2 text-[12px] text-faint">{t('Loading…')}</p>;
  if (runs.length === 0) return <p className="px-1 py-2 text-[12px] text-faint">{t('It hasn’t run yet.')}</p>;
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-line-soft">
      <table className="w-full text-left text-[12px]">
        <thead className="bg-inset text-faint">
          <tr>
            <th className="px-2.5 py-1.5 font-medium">{t('Status')}</th>
            <th className="px-2.5 py-1.5 font-medium">{t('Scheduled for')}</th>
            <th className="px-2.5 py-1.5 font-medium">{t('Started')}</th>
            <th className="px-2.5 py-1.5 font-medium">{t('Duration')}</th>
            <th className="px-2.5 py-1.5 font-medium" />
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} className="border-t border-line-soft align-top">
              <td className="px-2.5 py-1.5">
                <Badge tone={RUN_STATUS[run.status].tone}>{t(RUN_STATUS[run.status].label)}</Badge>
                {run.trigger !== 'schedule' && <span className="ml-1.5 text-faint">{t(TRIGGER_LABEL[run.trigger])}</span>}
                {run.error && <p className="mt-0.5 max-w-[280px] text-faint">{t.message(run.error)}</p>}
              </td>
              <td className="px-2.5 py-1.5 text-dim">{run.scheduledFor ? when(run.scheduledFor, t) : '—'}</td>
              <td className="px-2.5 py-1.5 text-dim">{run.startedAt ? when(run.startedAt, t) : '—'}</td>
              <td className="px-2.5 py-1.5 text-dim">{run.startedAt && run.finishedAt ? duration(run.finishedAt - run.startedAt, t) : run.status === 'running' ? t('Running') : '—'}</td>
              <td className="px-2.5 py-1.5 text-right">
                {run.turnId && (
                  <button className="text-accent hover:underline cursor-default" onClick={() => open(run)}>
                    {t('View result')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AutomationCard({ automation, chatTitle, own }: { automation: AutomationInfo; chatTitle: string; own: boolean }) {
  const t = useT();
  const { set, toast, openChat } = useStore();
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState<'run' | 'toggle' | null>(null);
  const access = accessOf(automation.config.permissionMode);
  const running = automation.lastRun?.status === 'running' || automation.lastRun?.status === 'queued';
  const act = async (kind: 'run' | 'toggle', action: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await action();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };
  const remove = () => {
    if (!confirm(t('Delete the automation “{name}”? What it already posted stays in the chat.', { name: automation.name }))) return;
    void call('automations.delete', automation.id).catch((error) => toast('error', error instanceof Error ? error.message : String(error)));
  };
  const status = automation.lastRun ? RUN_STATUS[automation.lastRun.status] : null;

  return (
    <div className="rounded-xl border border-line-soft bg-panel p-3.5">
      <div className="flex items-start gap-3">
        <div className="pt-0.5">{own ? <Toggle checked={automation.enabled} onChange={(enabled) => void act('toggle', () => call('automations.setEnabled', automation.id, enabled))} /> : <Avatar user={automation.owner} size={22} />}</div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[14px] font-medium">{automation.name}</span>
            <Badge tone={access.tone}>{t(access.label)}</Badge>
            {automation.fresh && <Badge tone="neutral">{t('New session each run')}</Badge>}
            {!automation.enabled && (
              <Badge tone="neutral">
                <CirclePause className="size-3" /> {t('Paused')}
              </Badge>
            )}
          </div>
          <p className="text-[12.5px] text-dim">
            {describeSchedule(automation.schedule, automation.timeZone, t)} ·{' '}
            <button className="cursor-default hover:underline" onClick={() => void openChat(automation.chatId)}>
              {chatTitle}
            </button>
          </p>
          <p className="line-clamp-2 whitespace-pre-wrap text-[12.5px] text-faint" title={automation.instructions}>
            {automation.instructions}
          </p>
          <p className="text-[12px] text-faint">
            {own ? t('Runs on {device}', { device: automation.deviceName }) : t('By {name}, on their computer ({device})', { name: automation.owner.name, device: automation.deviceName })}
            {automation.providerLabel ? ` · ${automation.providerLabel}` : ''}
            {` · ${t('limit {duration}', { duration: duration(automation.timeLimitMinutes * 60_000, t) })}`}
          </p>
          <p className="text-[12px] text-faint">
            {automation.pausedReason
              ? t('Paused: {reason}', { reason: t.message(automation.pausedReason) })
              : automation.enabled && automation.nextRunAt
                ? t('Next run: {when}', { when: when(automation.nextRunAt, t) })
                : t('It won’t run on its own while paused.')}
            {status && automation.lastRun && (
              <>
                {' · '}
                {t('Last run: {status}, {when}', { status: t(status.label).toLowerCase(), when: when(automation.lastRun.startedAt ?? automation.lastRun.scheduledFor ?? automation.lastRun.createdAt, t) })}
              </>
            )}
          </p>
        </div>
        {own && (
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" busy={busy === 'run'} disabled={running} onClick={() => void act('run', () => call('automations.run', automation.id))} title={running ? t('It is running now') : t('Run it now, on {device}', { device: automation.deviceName })}>
              <Play className="size-3.5" /> {t('Run now')}
            </Button>
            <IconButton title={t('Edit')} onClick={() => set({ automationEditor: { automation } })}>
              <Pencil className="size-4" />
            </IconButton>
            <IconButton title={t('Delete')} onClick={remove}>
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        )}
      </div>
      <button onClick={() => setShowHistory(!showHistory)} className="mt-2 flex items-center gap-1 text-[12px] text-faint cursor-default hover:text-dim">
        <History className="size-3.5" /> {t('History')}
        <ChevronDown className={`size-3 transition-transform ${showHistory ? '' : '-rotate-90'}`} />
      </button>
      {showHistory && <HistoryList automation={automation} />}
    </div>
  );
}

export function AutomationsView() {
  const t = useT();
  const { app, automations, automationRuns, automationsView, chats, set, readRuns } = useStore();
  const me = app?.user?.id;
  const filter = automationsView?.chatId ?? null;
  const supported = app?.automations != null;
  const runs = useMemo(
    () =>
      Object.values(automationRuns)
        .filter((run) => !filter || run.chatId === filter)
        .sort((a, b) => b.createdAt - a.createdAt),
    [automationRuns, filter],
  );
  const pending = runs.filter(unread);
  const [tab, setTab] = useState<Tab>(() => (!filter && pending.length > 0 ? 'inbox' : 'automations'));
  const [onlyUnread, setOnlyUnread] = useState(true);
  const list = Object.values(automations)
    .filter((automation) => !filter || automation.chatId === filter)
    .sort((a, b) => a.createdAt - b.createdAt);
  const yours = list.filter((automation) => mine(automation, me));
  const others = list.filter((automation) => !mine(automation, me));
  const shownRuns = onlyUnread ? pending : runs.filter((run) => run.status !== 'queued');
  const chatTitle = (chatId: string) => chats[chatId]?.title ?? t('A chat you can’t see');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line-soft px-5">
        <CalendarClock className="size-4 text-accent" />
        <h1 className="text-[14.5px] font-semibold">{t('Automations')}</h1>
        {filter && (
          <span className="no-drag">
            <Badge tone="accent">
              {t('in {title}', { title: chatTitle(filter) })}
              <button className="cursor-default" title={t('Show all')} onClick={() => set({ automationsView: { chatId: null } })}>
                <X className="size-3" />
              </button>
            </Badge>
          </span>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="primary" className="no-drag" disabled={!supported} onClick={() => set({ automationEditor: { automation: null, chatId: filter ?? undefined } })}>
          <Plus className="size-3.5" /> {t('New automation')}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[860px] space-y-5 px-6 py-6">
          {!supported ? (
            <Empty icon={<CalendarClock className="size-8" />} title={t('This team server doesn’t run automations')}>
              {t('Automations need a newer team server: update the CooPrompt that hosts it, or the standalone server.')}
            </Empty>
          ) : (
            <>
              <p className="text-[13px] leading-relaxed text-dim">
                {t('Automations run saved instructions on a schedule, unattended, on your computer with your own models, credentials and connectors. Each run is posted in its chat for everyone there, and lands here for you to review.')}
              </p>
              <div className="flex items-center gap-2">
                <div className="flex gap-0.5 rounded-lg bg-raised p-0.5 text-[12.5px]">
                  {(['inbox', 'automations'] as const).map((value) => (
                    <button key={value} onClick={() => setTab(value)} className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 cursor-default ${tab === value ? 'bg-panel text-ink' : 'text-dim hover:text-ink'}`}>
                      {value === 'inbox' ? t('Inbox') : t('Automations')}
                      {value === 'inbox' && pending.length > 0 && <span className="rounded-full bg-accent px-1.5 text-[10.5px] font-semibold text-on-accent">{pending.length}</span>}
                      {value === 'automations' && <span className="text-faint">{list.length}</span>}
                    </button>
                  ))}
                </div>
                {tab === 'inbox' && (
                  <>
                    <label className="ml-2 flex items-center gap-1.5 text-[12.5px] text-dim">
                      <input type="checkbox" checked={onlyUnread} onChange={(event) => setOnlyUnread(event.target.checked)} />
                      {t('Only not seen')}
                    </label>
                    <div className="flex-1" />
                    {pending.length > 0 && (
                      <Button size="sm" variant="ghost" onClick={() => readRuns({ ids: pending.map((run) => run.id) })}>
                        <CheckCheck className="size-3.5" /> {t('Mark all as seen')}
                      </Button>
                    )}
                  </>
                )}
              </div>
              {tab === 'inbox' ? (
                shownRuns.length === 0 ? (
                  <Empty title={onlyUnread ? t('Nothing new to review') : t('No runs yet')}>{t('Finished runs of your automations show up here until you open them.')}</Empty>
                ) : (
                  <div className="space-y-2">
                    {shownRuns.map((run) => (
                      <RunRow key={run.id} run={run} chatTitle={chatTitle(run.chatId)} />
                    ))}
                  </div>
                )
              ) : list.length === 0 ? (
                <Empty icon={<CalendarClock className="size-8" />} title={t('No automations yet')}>
                  {t('Create one to check CI every morning, summarize yesterday’s commits or keep an eye on a deploy. Try its instructions in a chat first.')}
                </Empty>
              ) : (
                <>
                  {yours.length > 0 && (
                    <section className="space-y-2">
                      <h2 className="text-[11.5px] font-semibold uppercase tracking-wide text-faint">{t('Yours')}</h2>
                      {yours.map((automation) => (
                        <AutomationCard key={automation.id} automation={automation} chatTitle={chatTitle(automation.chatId)} own />
                      ))}
                    </section>
                  )}
                  {others.length > 0 && (
                    <section className="space-y-2">
                      <h2 className="text-[11.5px] font-semibold uppercase tracking-wide text-faint">{t('Others’ in your chats')}</h2>
                      {others.map((automation) => (
                        <AutomationCard key={automation.id} automation={automation} chatTitle={chatTitle(automation.chatId)} own={false} />
                      ))}
                    </section>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
