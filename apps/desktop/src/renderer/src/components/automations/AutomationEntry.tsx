import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import type { ChatSummary, PublicUser, TranscriptItem, TurnInfo } from '@cooprompt/protocol';
import { unread } from '../../lib/automations.ts';
import { clock } from '../../lib/format.ts';
import { useT } from '../../lib/i18n.ts';
import { useStore } from '../../lib/store.ts';
import { IconButton } from '../ui.tsx';

/** The sidebar's way into the automations, with how many finished runs wait to be seen. */
export function AutomationsNavItem() {
  const t = useT();
  const { automationsView, automationRuns, automations, set } = useStore();
  const pending = Object.values(automationRuns).filter(unread).length;
  const running = Object.values(automations).filter((automation) => automation.lastRun?.status === 'running').length;
  return (
    <button
      onClick={() => set({ automationsView: { chatId: null } })}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] cursor-default ${automationsView ? 'bg-raised text-ink' : 'text-dim hover:bg-panel hover:text-ink'}`}
    >
      <CalendarClock className="size-4" />
      <span className="flex-1">{t('Automations')}</span>
      {running > 0 && <span className="size-2 animate-pulse rounded-full bg-accent" title={t('An automation is running')} />}
      {pending > 0 && (
        <span className="rounded-full bg-accent px-1.5 text-[10.5px] font-semibold tabular-nums text-on-accent" title={t('{count} runs to review', { count: pending })}>
          {pending}
        </span>
      )}
    </button>
  );
}

/** In a chat's header when automations post in it: who runs what there, for everyone in the chat. */
export function ChatAutomationsButton({ chat }: { chat: ChatSummary }) {
  const t = useT();
  const { automations, set } = useStore();
  const count = Object.values(automations).filter((automation) => automation.chatId === chat.id).length;
  if (count === 0) return null;
  return (
    <IconButton title={t('{count} automations post in this chat', { count })} onClick={() => set({ automationsView: { chatId: chat.id } })} className="!w-auto gap-1 px-1.5">
      <CalendarClock className="size-4" />
      <span className="text-[11.5px] tabular-nums">{count}</span>
    </IconButton>
  );
}

/** Where people's turns show who asked, an automation's shows its name, its owner and its instructions. */
export function AutomationPrompt({ turn, prompt, owner }: { turn: TurnInfo; prompt: TranscriptItem | null; owner: PublicUser | undefined }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const text = (prompt?.data as { text?: string } | undefined)?.text ?? '';
  const long = text.length > 280 || text.split('\n').length > 4;
  return (
    <div className="flex gap-3">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
        <CalendarClock className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[13px] font-semibold">{t('Automation: {name}', { name: turn.automation?.name ?? '' })}</span>
          <span className="text-[11.5px] text-faint">
            {t('by {name}', { name: owner?.name ?? t('someone') })} · {clock(prompt?.createdAt ?? turn.createdAt, t)}
          </span>
        </div>
        <div className={`selectable mt-0.5 whitespace-pre-wrap text-[13.5px] leading-relaxed text-dim ${long && !open ? 'line-clamp-3' : ''}`}>{text}</div>
        {long && (
          <button className="text-[12px] text-faint cursor-default hover:text-dim" onClick={() => setOpen(!open)}>
            {open ? t('Show less') : t('Show all the instructions')}
          </button>
        )}
      </div>
    </div>
  );
}
