import type { AutomationInfo, AutomationRun, AutomationSchedule, PermissionModeId } from '@cooprompt/protocol';
import type { T } from './i18n.ts';

/** The time zone schedules are written in when saved from this computer. */
export const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The access levels the editor offers, each one permission mode for every engine. */
export const ACCESS: { mode: PermissionModeId; label: string; description: string; tone: 'neutral' | 'warn' | 'bad' }[] = [
  { mode: 'plan', label: 'Read-only', description: 'Reads and reports; it can’t change files. Anything that needs approval is declined.', tone: 'neutral' },
  {
    mode: 'acceptEdits',
    label: 'Edit files',
    description: 'Edits files in its folder. Other actions that need approval are declined, except what you always allowed in that chat. Codex also uses your connectors without asking.',
    tone: 'warn',
  },
  { mode: 'bypassPermissions', label: 'No restrictions', description: 'Runs commands, edits files and uses connectors without asking, as you. Only for instructions you trust.', tone: 'bad' },
];

export const accessOf = (mode: PermissionModeId) => ACCESS.find((entry) => entry.mode === mode) ?? ACCESS[0];

export const TIME_LIMITS = [10, 20, 30, 60, 120, 240];

const WEEKDAYS = [1, 2, 3, 4, 5];

/** Short weekday names in the interface language, Sunday first. */
export function weekdayNames(t: T): string[] {
  const format = new Intl.DateTimeFormat(t.locale, { weekday: 'short', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, day) => format.format(new Date(Date.UTC(2026, 9, 25 + day))));
}

export function describeSchedule(schedule: AutomationSchedule, timeZone: string, t: T): string {
  const zone = timeZone !== LOCAL_TIME_ZONE ? ` (${timeZone})` : '';
  switch (schedule.kind) {
    case 'interval':
      if (schedule.minutes === 60) return t('Every hour');
      return schedule.minutes % 60 === 0 ? t('Every {count} hours', { count: schedule.minutes / 60 }) : t('Every {count} minutes', { count: schedule.minutes });
    case 'daily':
      return `${t('Every day at {time}', { time: schedule.time })}${zone}`;
    case 'weekly': {
      const days = [...schedule.days].sort((a, b) => a - b);
      if (days.length === 7) return `${t('Every day at {time}', { time: schedule.time })}${zone}`;
      if (days.join() === WEEKDAYS.join()) return `${t('Weekdays at {time}', { time: schedule.time })}${zone}`;
      const names = weekdayNames(t);
      return `${t('{days} at {time}', { days: days.map((day) => names[day]).join(', '), time: schedule.time })}${zone}`;
    }
    case 'cron':
      return `${t('Custom: {expression}', { expression: schedule.expression })}${zone}`;
  }
}

/** A date and time in the viewer's time zone, on the 24-hour clock schedules use: "Mon, Oct 26, 09:00". */
export function when(timestamp: number, t: T): string {
  return new Date(timestamp).toLocaleString(t.locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

export function duration(ms: number, t: T): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return t('{n} s', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? t('{m} min {s} s', { m: minutes, s: seconds % 60 }) : t('{n} min', { n: minutes });
  return t('{h} h {m} min', { h: Math.floor(minutes / 60), m: minutes % 60 });
}

export const RUN_STATUS: Record<AutomationRun['status'], { label: string; tone: 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' }> = {
  queued: { label: 'Waiting to start', tone: 'neutral' },
  running: { label: 'Running', tone: 'accent' },
  done: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  cancelled: { label: 'Cut short', tone: 'warn' },
  missed: { label: 'Missed', tone: 'warn' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

export const TRIGGER_LABEL: Record<AutomationRun['trigger'], string> = {
  schedule: 'On schedule',
  manual: 'Run by hand',
  'catch-up': 'Caught up',
};

/** A finished run with a result to look at that its owner hasn't opened. */
export const unread = (run: AutomationRun) => !run.read && run.turnId !== null && (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled');

export const mine = (automation: AutomationInfo, userId: string | undefined) => automation.owner.id === userId;
